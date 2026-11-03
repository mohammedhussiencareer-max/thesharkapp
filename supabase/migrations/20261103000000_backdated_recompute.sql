-- Back-dated movements recompute cost instead of refusing.
--
-- A batch is forward when every new row is at or after that item's
-- last_occurred_at and the new rows of one item are in non-decreasing order.
-- Forward batches keep the incremental helpers. Anything else is simulated,
-- inserted at its event cost, then rebuilt from the first movement.
--
-- The safety cap of 100000 economic rows in one replay component is a known
-- limit for a very large component. Crossing it, or producing a value outside
-- numeric(14,2) / numeric(20,6), or a negative average, raises 22023
-- 'recompute result is out of range' and rolls the transaction back.
--
-- app.lock_and_validate_item_balance still raises
-- 'back-dated movement not supported yet' when occurred_at is before
-- last_occurred_at. record_count (unchanged in this migration) depends on
-- that guard. Back-dated posting does not call it: the advisory lock is
-- taken first, then on this path only app.pos_shifts is locked in share
-- mode, then item_balances is locked in item_id order.
-- ============================================================================
-- 1. Attribution, revisions, and the revised-day flag
-- ============================================================================
create table app.movement_attributions (
  movement_id bigint primary key references app.stock_movements (id) on delete restrict,
  shift_id text null,
  attributed_at timestamptz not null default clock_timestamp()
);

comment on table app.movement_attributions is 'Append-only shift attribution for a movement that was stored without shift_id. The first resolution sticks; later shift-boundary changes do not move it.';

create table app.period_revisions (
  id bigint generated always as identity primary key,
  source_movement_id bigint not null unique references app.stock_movements (id) on delete restrict,
  shift_id text null,
  bucket text not null check (
    bucket in ('cogs', 'waste', 'count', 'sort_transfer')
  ),
  amount numeric(14, 2) not null,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  cause_batch_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint period_revisions_amount_finite_chk check (
    amount <> 'NaN'::numeric
    and amount <> 'Infinity'::numeric
    and amount <> '-Infinity'::numeric
  )
);

comment on table app.period_revisions is 'Append-only profit and sort-transfer deltas. amount uses the ledger sign of the source movement total_cost. Purchases and openings are not revised.';

create table app.shift_report_flags (
  shift_id text primary key,
  revised_at timestamptz not null,
  profit_delta numeric(14, 2) not null,
  sort_transfer_delta numeric(14, 2) not null,
  constraint shift_report_flags_finite_chk check (
    profit_delta <> 'NaN'::numeric
    and profit_delta <> 'Infinity'::numeric
    and profit_delta <> '-Infinity'::numeric
    and sort_transfer_delta <> 'NaN'::numeric
    and sort_transfer_delta <> 'Infinity'::numeric
    and sort_transfer_delta <> '-Infinity'::numeric
  )
);

comment on table app.shift_report_flags is 'Revised-day badge. profit_delta sums cogs, waste, and count revisions. sort_transfer_delta sums sort transfers and is not profit. Written only by ledger functions.';

create function app.prevent_append_only_mutation () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception '% is append-only; % is not allowed', tg_table_schema || '.' || tg_table_name, tg_op
    using errcode = '55000';
end;
$$;

revoke all on function app.prevent_append_only_mutation ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_movement_attributions_no_update_delete
before update or delete on app.movement_attributions for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_movement_attributions_no_truncate
before truncate on app.movement_attributions for each statement
execute function app.prevent_append_only_mutation ();

create trigger trg_period_revisions_no_update_delete
before update or delete on app.period_revisions for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_period_revisions_no_truncate
before truncate on app.period_revisions for each statement
execute function app.prevent_append_only_mutation ();

create function app.prevent_shift_flag_direct_write () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  if coalesce(pg_catalog.current_setting('app.shift_flag_write', true), '') is distinct from 'on' then
    raise exception 'app.shift_report_flags is writable only by ledger functions'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function app.prevent_shift_flag_direct_write ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_shift_report_flags_write
before insert or update or delete on app.shift_report_flags for each row
execute function app.prevent_shift_flag_direct_write ();

create trigger trg_shift_report_flags_truncate
before truncate on app.shift_report_flags for each statement
execute function app.prevent_shift_flag_direct_write ();

alter table app.movement_attributions enable row level security;

alter table app.period_revisions enable row level security;

alter table app.shift_report_flags enable row level security;

create policy movement_attributions_select_owner on app.movement_attributions for
select
  to authenticated using (app.is_owner ());

create policy period_revisions_select_owner on app.period_revisions for
select
  to authenticated using (app.is_owner ());

create policy shift_report_flags_select_owner on app.shift_report_flags for
select
  to authenticated using (app.is_owner ());

revoke all on table app.movement_attributions
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.period_revisions
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.shift_report_flags
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.movement_attributions,
  app.period_revisions,
  app.shift_report_flags to authenticated,
  service_role;

-- ============================================================================
-- 2. Shift resolution and revisions
-- ============================================================================
create function app.profit_bucket (p_type app.movement_type) returns text language sql immutable security definer
set
  search_path = '' as $$
  select
    case p_type
      when 'sale'::app.movement_type then 'cogs'
      when 'waste'::app.movement_type then 'waste'
      when 'sort_loss'::app.movement_type then 'waste'
      when 'count_adjustment'::app.movement_type then 'count'
      when 'sort_out'::app.movement_type then 'sort_transfer'
      when 'sort_in'::app.movement_type then 'sort_transfer'
      else null
    end;
$$;

revoke all on function app.profit_bucket (app.movement_type)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.resolve_shift_id (p_at timestamptz) returns text language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_id text;
begin
  select
    s.id
  into v_id
  from
    app.pos_shifts s
  where
    s.opened_at <= p_at
    and (
      s.closed_at is null
      or p_at < s.closed_at
    )
  order by
    s.opened_at desc,
    s.id desc
  limit
    1;

  if found then
    return v_id;
  end if;

  select
    s.id
  into v_id
  from
    app.pos_shifts s
  where
    s.closed_at is not null
    and s.closed_at <= p_at
  order by
    s.closed_at desc,
    s.opened_at desc,
    s.id desc
  limit
    1;

  return v_id;
end;
$$;

revoke all on function app.resolve_shift_id (timestamptz)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.shift_for_target (p_movement_id bigint) returns text language plpgsql security definer
set
  search_path = '' as $$
declare
  v_shift text;
  v_at timestamptz;
  v_stored text;
begin
  select
    sm.shift_id,
    sm.occurred_at
  into
    v_shift,
    v_at
  from
    app.stock_movements sm
  where
    sm.id = p_movement_id;

  if v_shift is not null then
    return v_shift;
  end if;

  select
    ma.shift_id
  into v_stored
  from
    app.movement_attributions ma
  where
    ma.movement_id = p_movement_id;

  if found then
    return v_stored;
  end if;

  v_stored := app.resolve_shift_id (v_at);

  insert into
    app.movement_attributions (movement_id, shift_id)
  values
    (p_movement_id, v_stored);

  return v_stored;
end;
$$;

revoke all on function app.shift_for_target (bigint)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.note_period_revision (
  p_source_id bigint,
  p_shift_id text,
  p_bucket text,
  p_amount numeric,
  p_item_id uuid,
  p_cause uuid
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_profit numeric(14, 2);
  v_sort numeric(14, 2);
begin
  if p_bucket is null then
    return;
  end if;

  insert into
    app.period_revisions (
      source_movement_id,
      shift_id,
      bucket,
      amount,
      item_id,
      cause_batch_id
    )
  values
    (
      p_source_id,
      p_shift_id,
      p_bucket,
      p_amount,
      p_item_id,
      p_cause
    );

  if p_shift_id is null then
    return;
  end if;

  v_profit := case
    when p_bucket in ('cogs', 'waste', 'count') then p_amount
    else 0::numeric(14, 2)
  end;

  v_sort := case
    when p_bucket = 'sort_transfer' then p_amount
    else 0::numeric(14, 2)
  end;

  begin
    perform pg_catalog.set_config('app.shift_flag_write', 'on', true);

    insert into
      app.shift_report_flags (
        shift_id,
        revised_at,
        profit_delta,
        sort_transfer_delta
      )
    values
      (
        p_shift_id,
        pg_catalog.clock_timestamp(),
        v_profit,
        v_sort
      )
    on conflict (shift_id) do update
    set
      revised_at = pg_catalog.clock_timestamp(),
      profit_delta = app.shift_report_flags.profit_delta + excluded.profit_delta,
      sort_transfer_delta = app.shift_report_flags.sort_transfer_delta + excluded.sort_transfer_delta;

    perform pg_catalog.set_config('app.shift_flag_write', 'off', true);
  exception
    when others then
      perform pg_catalog.set_config('app.shift_flag_write', 'off', true);

      raise;
  end;
end;
$$;

revoke all on function app.note_period_revision (bigint, text, text, numeric, uuid, uuid)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 3. Routing checks
-- ============================================================================
create function app.batch_is_forward (p_item_ids uuid[], p_occurred_at timestamptz[]) returns boolean language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_n integer;
  v_last timestamptz;
  v_prev timestamptz;
  v_item uuid;
begin
  v_n := coalesce(pg_catalog.array_length(p_item_ids, 1), 0);

  if v_n = 0
  or v_n is distinct from coalesce(pg_catalog.array_length(p_occurred_at, 1), 0) then
    return false;
  end if;

  for v_i in 1..v_n loop
    select
      ib.last_occurred_at
    into v_last
    from
      app.item_balances ib
    where
      ib.item_id = p_item_ids[v_i];

    if v_last is not null and p_occurred_at[v_i] < v_last then
      return false;
    end if;
  end loop;

  for v_item in
    select distinct
      t.item_id
    from
      pg_catalog.unnest(p_item_ids) as t (item_id)
  loop
    v_prev := null;

    for v_i in 1..v_n loop
      if p_item_ids[v_i] = v_item then
        if v_prev is not null and p_occurred_at[v_i] < v_prev then
          return false;
        end if;

        v_prev := p_occurred_at[v_i];
      end if;
    end loop;
  end loop;

  return true;
end;
$$;

revoke all on function app.batch_is_forward (uuid[], timestamptz[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.assert_not_before_opening (
  p_item_ids uuid[],
  p_occurred_at timestamptz[],
  p_types text[]
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_n integer;
  v_item uuid;
  v_open timestamptz;
  v_new_open timestamptz;
  v_name text;
begin
  v_n := coalesce(pg_catalog.array_length(p_item_ids, 1), 0);

  for v_item in
    select distinct
      t.item_id
    from
      pg_catalog.unnest(p_item_ids) as t (item_id)
  loop
    select
      min(sm.occurred_at)
    into v_open
    from
      app.stock_movements sm
    where
      sm.item_id = v_item
      and sm.movement_type = 'opening';

    v_new_open := null;

    for v_i in 1..v_n loop
      if p_item_ids[v_i] = v_item and p_types[v_i] = 'opening' then
        if v_new_open is null or p_occurred_at[v_i] < v_new_open then
          v_new_open := p_occurred_at[v_i];
        end if;
      end if;
    end loop;

    if v_open is null then
      v_open := v_new_open;
    elsif v_new_open is not null and v_new_open < v_open then
      v_open := v_new_open;
    end if;

    if v_open is null then
      continue;
    end if;

    for v_i in 1..v_n loop
      if p_item_ids[v_i] = v_item and p_occurred_at[v_i] < v_open then
        select
          si.name
        into v_name
        from
          app.stock_items si
        where
          si.id = v_item;

        raise exception 'movement is before opening stock'
          using errcode = 'P0001',
          detail = v_name;
      end if;
    end loop;
  end loop;
end;
$$;

revoke all on function app.assert_not_before_opening (uuid[], timestamptz[], text[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.recompute_item_set (p_item_ids uuid[]) returns uuid[] language plpgsql stable security definer
set
  search_path = '' as $$
declare
  v_set uuid[];
  v_next uuid[];
  v_guard integer := 0;
begin
  select
    coalesce(
      pg_catalog.array_agg(
        distinct t.item_id
        order by
          t.item_id
      ),
      '{}'::uuid[]
    )
  into v_set
  from
    pg_catalog.unnest(p_item_ids) as t (item_id)
  where
    t.item_id is not null;

  loop
    v_guard := v_guard + 1;

    if v_guard > 1000 then
      raise exception 'recompute result is out of range'
        using errcode = '22023';
    end if;

    select
      coalesce(
        pg_catalog.array_agg(
          distinct found.item_id
          order by
            found.item_id
        ),
        '{}'::uuid[]
      )
    into v_next
    from
      (
        select
          si.parent_item_id as item_id
        from
          pg_catalog.unnest(v_set) as seed (item_id)
          join app.stock_items si on si.id = seed.item_id
        where
          si.parent_item_id is not null
        union
        select
          child.id
        from
          pg_catalog.unnest(v_set) as seed (item_id)
          join app.stock_items si on si.id = seed.item_id
          join app.stock_items child on child.parent_item_id = coalesce(
            si.parent_item_id,
            case
              when si.kind = 'fish_mixed' then si.id
              else null
            end
          )
        union
        select
          other.item_id
        from
          pg_catalog.unnest(v_set) as seed (item_id)
          join app.stock_movements mine on mine.item_id = seed.item_id
          and mine.movement_type in ('sort_out', 'sort_in', 'sort_loss')
          join app.stock_movements other on other.batch_id = mine.batch_id
          and other.movement_type in ('sort_out', 'sort_in', 'sort_loss')
      ) as found
    where
      found.item_id is not null;

    exit when v_next <@ v_set;

    select
      coalesce(
        pg_catalog.array_agg(
          distinct grown.item_id
          order by
            grown.item_id
        ),
        '{}'::uuid[]
      )
    into v_set
    from
      (
        select
          t.item_id
        from
          pg_catalog.unnest(v_set) as t (item_id)
        union
        select
          t.item_id
        from
          pg_catalog.unnest(v_next) as t (item_id)
      ) as grown;
  end loop;

  return v_set;
end;
$$;

revoke all on function app.recompute_item_set (uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.assert_count_barrier (
  p_item_ids uuid[],
  p_occurred_at timestamptz[],
  p_set uuid[]
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_n integer;
  v_last timestamptz;
  v_name text;
begin
  v_n := coalesce(pg_catalog.array_length(p_item_ids, 1), 0);

  for v_i in 1..v_n loop
    select
      ib.last_occurred_at
    into v_last
    from
      app.item_balances ib
    where
      ib.item_id = p_item_ids[v_i];

    if v_last is not null
    and p_occurred_at[v_i] < v_last
    and exists (
      select
        1
      from
        app.stock_count_lines scl
        join app.stock_counts sc on sc.id = scl.count_id
      where
        scl.item_id = any (p_set)
        and p_occurred_at[v_i] <= sc.counted_at
    ) then
      select
        si.name
      into v_name
      from
        app.stock_items si
      where
        si.id = p_item_ids[v_i];

      raise exception 'back-dated movement not supported yet'
        using errcode = 'P0001',
        detail = v_name;
    end if;
  end loop;
end;
$$;

revoke all on function app.assert_count_barrier (uuid[], timestamptz[], uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.prepare_balance_locks (p_item_ids uuid[]) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_item uuid;
begin
  foreach v_item in array p_item_ids loop
    insert into
      app.item_balances (item_id)
    values
      (v_item)
    on conflict (item_id) do nothing;
  end loop;

  foreach v_item in array p_item_ids loop
    perform
      1
    from
      app.item_balances ib
    where
      ib.item_id = v_item
    for update;
  end loop;
end;
$$;

revoke all on function app.prepare_balance_locks (uuid[])
from
  public,
  anon,
  authenticated,
  service_role;

create function app.assert_recompute_range (
  p_value numeric,
  p_scale integer,
  p_allow_negative boolean
) returns numeric language plpgsql immutable security definer
set
  search_path = '' as $$
declare
  v_max numeric;
begin
  if p_value is null
  or p_value = 'NaN'::numeric
  or p_value = 'Infinity'::numeric
  or p_value = '-Infinity'::numeric then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
  end if;

  if not p_allow_negative and p_value < 0 then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
  end if;

  if p_scale = 2 then
    v_max := 999999999999.99;
  else
    v_max := 99999999999999.999999;
  end if;

  if p_value > v_max or p_value < -v_max then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
  end if;

  return p_value;
end;
$$;

revoke all on function app.assert_recompute_range (numeric, integer, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

-- ============================================================================
-- 4. In-memory replay. Scratch tables are truncated on every call.
-- They live outside app so PostgREST and generated types do not expose them.
-- Every caller holds the ledger advisory lock before truncating. Truncate is
-- transactional, so a rolled-back replay leaves no scratch rows behind.
-- ============================================================================
create schema ledger_scratch;

revoke all on schema ledger_scratch
from
  public,
  anon,
  authenticated,
  service_role;

create table ledger_scratch.recompute_row (
  movement_id bigint primary key,
  is_pending boolean not null,
  batch_id uuid not null,
  item_id uuid not null,
  movement_type app.movement_type not null,
  occurred_at timestamptz not null,
  quantity numeric(20, 6) not null,
  unit_cost numeric(20, 6) not null,
  total_cost numeric(14, 2) not null,
  is_input_total boolean not null,
  shift_id text null,
  source_type text null,
  source_id text null,
  note text null,
  ord_class integer not null,
  line_key integer not null,
  consumed boolean not null
);

create table ledger_scratch.recompute_bal (
  item_id uuid primary key,
  on_hand_qty numeric(20, 6) not null,
  on_hand_value numeric(14, 2) not null,
  avg_cost numeric(20, 6) not null,
  has_uncovered_deficit boolean not null
);

create table ledger_scratch.recompute_def (
  movement_id bigint primary key,
  item_id uuid not null,
  qty_uncovered numeric(20, 6) not null,
  provisional_unit_cost numeric(20, 6) not null,
  value_uncovered numeric(14, 2) not null,
  occurred_at timestamptz not null
);

create table ledger_scratch.recompute_effect (
  movement_id bigint primary key,
  item_id uuid not null,
  movement_type app.movement_type not null,
  base_total numeric(14, 2) not null,
  unit_cost numeric(20, 6) not null,
  cover_total numeric(14, 2) not null
);

create table ledger_scratch.recompute_piece (
  line_key integer not null,
  piece_no integer not null,
  item_id uuid not null,
  movement_type app.movement_type not null,
  occurred_at timestamptz not null,
  quantity numeric(20, 6) not null,
  unit_cost numeric(20, 6) not null,
  total_cost numeric(14, 2) not null,
  is_provisional boolean not null,
  shift_id text null,
  source_type text null,
  source_id text null,
  note text null,
  primary key (line_key, piece_no)
);

create table ledger_scratch.recompute_override (
  movement_id bigint primary key,
  unit_cost numeric(20, 6) not null,
  total_cost numeric(14, 2) not null
);

create table ledger_scratch.recompute_seq (next_id bigint not null);

revoke all on table ledger_scratch.recompute_row,
ledger_scratch.recompute_bal,
ledger_scratch.recompute_def,
ledger_scratch.recompute_effect,
ledger_scratch.recompute_piece,
ledger_scratch.recompute_override,
ledger_scratch.recompute_seq
from
  public,
  anon,
  authenticated,
  service_role;

alter table ledger_scratch.recompute_row enable row level security;

alter table ledger_scratch.recompute_bal enable row level security;

alter table ledger_scratch.recompute_def enable row level security;

alter table ledger_scratch.recompute_effect enable row level security;

alter table ledger_scratch.recompute_piece enable row level security;

alter table ledger_scratch.recompute_override enable row level security;

alter table ledger_scratch.recompute_seq enable row level security;

create function app.replay_prepare_tables () returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  truncate ledger_scratch.recompute_row,
  ledger_scratch.recompute_bal,
  ledger_scratch.recompute_def,
  ledger_scratch.recompute_effect,
  ledger_scratch.recompute_piece,
  ledger_scratch.recompute_override,
  ledger_scratch.recompute_seq;
end;
$$;

revoke all on function app.replay_prepare_tables ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_touch_deficit_flag (p_item_id uuid) returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  update ledger_scratch.recompute_bal
  set
    has_uncovered_deficit = exists (
      select
        1
      from
        ledger_scratch.recompute_def d
      where
        d.item_id = p_item_id
        and d.qty_uncovered > 0
    )
  where
    item_id = p_item_id;
end;
$$;

revoke all on function app.replay_touch_deficit_flag (uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_outflow (
  p_movement_id bigint,
  p_item_id uuid,
  p_type app.movement_type,
  p_occurred_at timestamptz,
  p_out_qty numeric,
  p_forced_total numeric,
  p_is_pending boolean,
  p_line_key integer,
  p_shift_id text,
  p_source_type text,
  p_source_id text,
  p_note text
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_qty numeric(20, 6);
  v_value numeric(14, 2);
  v_avg numeric(20, 6);
  v_unit numeric(20, 6);
  v_normal_qty numeric(20, 6);
  v_prov_qty numeric(20, 6);
  v_normal_cost numeric(14, 2);
  v_prov_cost numeric(14, 2);
  v_base numeric(14, 2);
  v_piece integer := 0;
  v_syn bigint;
begin
  select
    b.on_hand_qty,
    b.on_hand_value,
    b.avg_cost
  into
    v_qty,
    v_value,
    v_avg
  from
    ledger_scratch.recompute_bal b
  where
    b.item_id = p_item_id;

  v_unit := app.assert_recompute_range (v_avg, 6, false);

  if p_forced_total is not null then
    v_normal_qty := p_out_qty;
    v_prov_qty := 0;
    v_normal_cost := app.assert_recompute_range (p_forced_total, 2, true);
    v_prov_cost := 0;
  else
    v_normal_qty := least(p_out_qty, greatest(v_qty, 0::numeric));
    v_prov_qty := p_out_qty - v_normal_qty;

    if v_normal_qty > 0 then
      if v_normal_qty = v_qty then
        v_normal_cost := -v_value;
      else
        v_normal_cost := -pg_catalog.round(v_value * v_normal_qty / v_qty, 2);
      end if;
    else
      v_normal_cost := 0;
    end if;

    if v_prov_qty > 0 then
      v_prov_cost := -pg_catalog.round(v_prov_qty * v_unit, 2);
    else
      v_prov_cost := 0;
    end if;

    v_normal_cost := app.assert_recompute_range (v_normal_cost, 2, true);
    v_prov_cost := app.assert_recompute_range (v_prov_cost, 2, true);
  end if;

  v_base := app.assert_recompute_range (v_normal_cost + v_prov_cost, 2, true);

  if p_is_pending then
    if v_normal_qty > 0 then
      v_piece := v_piece + 1;

      insert into
        ledger_scratch.recompute_piece (
          line_key,
          piece_no,
          item_id,
          movement_type,
          occurred_at,
          quantity,
          unit_cost,
          total_cost,
          is_provisional,
          shift_id,
          source_type,
          source_id,
          note
        )
      values
        (
          p_line_key,
          v_piece,
          p_item_id,
          p_type,
          p_occurred_at,
          -v_normal_qty,
          v_unit,
          v_normal_cost,
          false,
          p_shift_id,
          p_source_type,
          p_source_id,
          p_note
        );
    end if;

    if v_prov_qty > 0 then
      v_piece := v_piece + 1;

      insert into
        ledger_scratch.recompute_piece (
          line_key,
          piece_no,
          item_id,
          movement_type,
          occurred_at,
          quantity,
          unit_cost,
          total_cost,
          is_provisional,
          shift_id,
          source_type,
          source_id,
          note
        )
      values
        (
          p_line_key,
          v_piece,
          p_item_id,
          p_type,
          p_occurred_at,
          -v_prov_qty,
          v_unit,
          v_prov_cost,
          true,
          p_shift_id,
          p_source_type,
          p_source_id,
          p_note
        );

      update ledger_scratch.recompute_seq
      set
        next_id = next_id + 1
      returning
        next_id into v_syn;

      insert into
        ledger_scratch.recompute_def (
          movement_id,
          item_id,
          qty_uncovered,
          provisional_unit_cost,
          value_uncovered,
          occurred_at
        )
      values
        (
          v_syn,
          p_item_id,
          v_prov_qty,
          v_unit,
          abs(v_prov_cost),
          p_occurred_at
        );
    end if;
  else
    insert into
      ledger_scratch.recompute_effect (
        movement_id,
        item_id,
        movement_type,
        base_total,
        unit_cost,
        cover_total
      )
    values
      (
        p_movement_id,
        p_item_id,
        p_type,
        v_base,
        v_unit,
        0
      );

    if v_prov_qty > 0 then
      insert into
        ledger_scratch.recompute_def (
          movement_id,
          item_id,
          qty_uncovered,
          provisional_unit_cost,
          value_uncovered,
          occurred_at
        )
      values
        (
          p_movement_id,
          p_item_id,
          v_prov_qty,
          v_unit,
          abs(v_prov_cost),
          p_occurred_at
        );
    end if;
  end if;

  update ledger_scratch.recompute_bal
  set
    on_hand_qty = on_hand_qty - p_out_qty,
    on_hand_value = app.assert_recompute_range (on_hand_value + v_base, 2, true)
  where
    item_id = p_item_id;

  perform app.replay_touch_deficit_flag (p_item_id);
end;
$$;

revoke all on function app.replay_outflow (
  bigint,
  uuid,
  app.movement_type,
  timestamptz,
  numeric,
  numeric,
  boolean,
  integer,
  text,
  text,
  text,
  text
)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replay_inflow (
  p_movement_id bigint,
  p_item_id uuid,
  p_type app.movement_type,
  p_occurred_at timestamptz,
  p_in_qty numeric,
  p_unit_cost numeric,
  p_total_cost numeric,
  p_is_pending boolean,
  p_line_key integer,
  p_shift_id text,
  p_source_type text,
  p_source_id text,
  p_note text
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_pre_qty numeric(20, 6);
  v_pre_value numeric(14, 2);
  v_pre_avg numeric(20, 6);
  v_unit numeric(20, 6);
  v_total numeric(14, 2);
  v_delta numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_remaining_value numeric(14, 2);
  v_covered_qty numeric(20, 6);
  v_covered_inflow numeric(14, 2);
  v_covered_prov numeric(14, 2);
  v_adj numeric(14, 2);
  v_prior_pos numeric(20, 6);
  v_value_after numeric(14, 2);
  v_new_avg numeric(20, 6);
  r_def record;
begin
  select
    b.on_hand_qty,
    b.on_hand_value,
    b.avg_cost
  into
    v_pre_qty,
    v_pre_value,
    v_pre_avg
  from
    ledger_scratch.recompute_bal b
  where
    b.item_id = p_item_id;

  if p_type = 'count_adjustment' then
    v_unit := app.assert_recompute_range (v_pre_avg, 6, false);
    v_total := app.assert_recompute_range (pg_catalog.round(p_in_qty * v_unit, 2), 2, false);
  else
    v_unit := app.assert_recompute_range (p_unit_cost, 6, false);
    v_total := app.assert_recompute_range (p_total_cost, 2, false);
  end if;

  v_delta := v_total;
  v_remaining_qty := p_in_qty;
  v_remaining_value := v_total;

  for r_def in
    select
      d.movement_id,
      d.qty_uncovered,
      d.value_uncovered,
      d.provisional_unit_cost
    from
      ledger_scratch.recompute_def d
    where
      d.item_id = p_item_id
      and d.qty_uncovered > 0
    order by
      d.occurred_at asc,
      d.movement_id asc
  loop
    exit when v_remaining_qty <= 0;

    v_covered_qty := least(v_remaining_qty, r_def.qty_uncovered);

    if v_covered_qty = v_remaining_qty then
      v_covered_inflow := v_remaining_value;
    else
      v_covered_inflow := pg_catalog.round(
        v_remaining_value * v_covered_qty / v_remaining_qty,
        2
      );
    end if;

    if v_covered_qty = r_def.qty_uncovered then
      v_covered_prov := r_def.value_uncovered;
    else
      v_covered_prov := pg_catalog.round(
        r_def.value_uncovered * v_covered_qty / r_def.qty_uncovered,
        2
      );
    end if;

    v_covered_inflow := app.assert_recompute_range (v_covered_inflow, 2, true);
    v_covered_prov := app.assert_recompute_range (v_covered_prov, 2, true);
    v_adj := app.assert_recompute_range (-(v_covered_inflow - v_covered_prov), 2, true);

    update ledger_scratch.recompute_def
    set
      qty_uncovered = qty_uncovered - v_covered_qty,
      value_uncovered = value_uncovered - v_covered_prov
    where
      movement_id = r_def.movement_id;

    update ledger_scratch.recompute_effect
    set
      cover_total = app.assert_recompute_range (cover_total + v_adj, 2, true)
    where
      movement_id = r_def.movement_id;

    v_remaining_qty := v_remaining_qty - v_covered_qty;
    v_remaining_value := v_remaining_value - v_covered_inflow;
    v_delta := app.assert_recompute_range (v_delta + v_adj, 2, true);
  end loop;

  v_prior_pos := greatest(v_pre_qty, 0::numeric);
  v_value_after := case
    when v_pre_qty > 0 then greatest(v_pre_value, 0::numeric)
    else 0::numeric
  end;

  if v_prior_pos + v_remaining_qty > 0 then
    v_new_avg := pg_catalog.round(
      (v_value_after + v_remaining_value) / (v_prior_pos + v_remaining_qty),
      6
    );
  elsif p_type in ('purchase', 'sort_in')
  or (
    p_type = 'opening'
    and v_unit > 0
  ) then
    v_new_avg := v_unit;
  else
    v_new_avg := v_pre_avg;
  end if;

  v_new_avg := app.assert_recompute_range (v_new_avg, 6, false);

  if p_is_pending then
    insert into
      ledger_scratch.recompute_piece (
        line_key,
        piece_no,
        item_id,
        movement_type,
        occurred_at,
        quantity,
        unit_cost,
        total_cost,
        is_provisional,
        shift_id,
        source_type,
        source_id,
        note
      )
    values
      (
        p_line_key,
        1,
        p_item_id,
        p_type,
        p_occurred_at,
        p_in_qty,
        v_unit,
        v_total,
        false,
        p_shift_id,
        p_source_type,
        p_source_id,
        p_note
      );
  else
    insert into
      ledger_scratch.recompute_effect (
        movement_id,
        item_id,
        movement_type,
        base_total,
        unit_cost,
        cover_total
      )
    values
      (
        p_movement_id,
        p_item_id,
        p_type,
        v_total,
        v_unit,
        0
      );
  end if;

  update ledger_scratch.recompute_bal
  set
    on_hand_qty = on_hand_qty + p_in_qty,
    on_hand_value = app.assert_recompute_range (v_pre_value + v_delta, 2, true),
    avg_cost = v_new_avg
  where
    item_id = p_item_id;

  perform app.replay_touch_deficit_flag (p_item_id);
end;
$$;

revoke all on function app.replay_inflow (
  bigint,
  uuid,
  app.movement_type,
  timestamptz,
  numeric,
  numeric,
  numeric,
  boolean,
  integer,
  text,
  text,
  text,
  text
)
from
  public,
  anon,
  authenticated,
  service_role;

-- Replay the connected set from the first movement. p_write false fills
-- ledger_scratch.recompute_piece with event costs and does not touch the ledger.
-- p_write true reconciles stored rows, replaces balances and deficits, and
-- inserts one cost_adjustment per economic row whose effective total changed.
create function app.replay_execute (
  p_item_ids uuid[],
  p_pending jsonb,
  p_cause uuid,
  p_write boolean
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  r record;
  s record;
  sz record;
  v_base bigint;
  v_done uuid[] := '{}'::uuid[];
  v_raw uuid;
  v_out_n bigint;
  v_loss_n bigint;
  v_size_n bigint;
  v_size_i bigint;
  v_qty_taken numeric(20, 6);
  v_on_qty numeric(20, 6);
  v_on_value numeric(14, 2);
  v_avg numeric(20, 6);
  v_has_def boolean;
  v_value_taken numeric(14, 2);
  v_loss_qty numeric(20, 6);
  v_loss_value numeric(14, 2);
  v_remaining_value numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_size_value numeric(14, 2);
  v_size_unit numeric(20, 6);
  v_forced numeric(14, 2);
  v_unit numeric(20, 6);
  v_old numeric(14, 2);
  v_required numeric(14, 2);
  v_existing numeric(14, 2);
  v_diff numeric(14, 2);
  v_unit_diff numeric(20, 6);
  v_shift text;
  v_new_id bigint;
  e record;
begin
  if p_pending is null then
    p_pending := '[]'::jsonb;
  end if;

  perform app.replay_prepare_tables ();

  insert into
    ledger_scratch.recompute_bal (
      item_id,
      on_hand_qty,
      on_hand_value,
      avg_cost,
      has_uncovered_deficit
    )
  select distinct
    t.item_id,
    0,
    0,
    0,
    false
  from
    pg_catalog.unnest(p_item_ids) as t (item_id)
  where
    t.item_id is not null;

  insert into
    ledger_scratch.recompute_row (
      movement_id,
      is_pending,
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      is_input_total,
      shift_id,
      source_type,
      source_id,
      note,
      ord_class,
      line_key,
      consumed
    )
  select
    sm.id,
    false,
    sm.batch_id,
    sm.item_id,
    sm.movement_type,
    sm.occurred_at,
    sm.quantity,
    sm.unit_cost,
    sm.total_cost,
    sm.movement_type in ('purchase', 'opening'),
    sm.shift_id,
    sm.source_type,
    sm.source_id,
    sm.note,
    case
      when sm.movement_type = 'count_adjustment'
      and exists (
        select
          1
        from
          app.stock_count_lines scl
        where
          scl.movement_id = sm.id
      ) then 1
      else 0
    end,
    0,
    false
  from
    app.stock_movements sm
  where
    sm.item_id = any (p_item_ids)
    and sm.movement_type <> 'cost_adjustment';

  select
    coalesce(max(sm.id), 0)
  into v_base
  from
    app.stock_movements sm;

  insert into
    ledger_scratch.recompute_row (
      movement_id,
      is_pending,
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      is_input_total,
      shift_id,
      source_type,
      source_id,
      note,
      ord_class,
      line_key,
      consumed
    )
  select
    v_base + (elem.value ->> 'line_key')::integer,
    true,
    (elem.value ->> 'batch_id')::uuid,
    (elem.value ->> 'item_id')::uuid,
    (elem.value ->> 'movement_type')::app.movement_type,
    (elem.value ->> 'occurred_at')::timestamptz,
    (elem.value ->> 'quantity')::numeric,
    coalesce((elem.value ->> 'unit_cost')::numeric, 0),
    coalesce((elem.value ->> 'total_cost')::numeric, 0),
    coalesce((elem.value ->> 'is_input_total')::boolean, false),
    elem.value ->> 'shift_id',
    elem.value ->> 'source_type',
    elem.value ->> 'source_id',
    elem.value ->> 'note',
    0,
    (elem.value ->> 'line_key')::integer,
    false
  from
    pg_catalog.jsonb_array_elements(p_pending) as elem (value);

  insert into
    ledger_scratch.recompute_seq (next_id)
  select
    coalesce(max(q.movement_id), 0)
  from
    ledger_scratch.recompute_row q;

  if (
    select
      count(*)
    from
      ledger_scratch.recompute_row
  ) > 100000 then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
  end if;

  for r in
    select
      q.*
    from
      ledger_scratch.recompute_row q
    order by
      q.occurred_at asc,
      q.ord_class asc,
      q.movement_id asc
  loop
    if r.movement_type in ('sort_out', 'sort_in', 'sort_loss')
    and r.batch_id = any (v_done) then
      continue;
    end if;

    if r.movement_type in ('sort_out', 'sort_in', 'sort_loss') then
      select
        count(*) filter (
          where
            q.movement_type = 'sort_out'
        ),
        count(*) filter (
          where
            q.movement_type = 'sort_loss'
        ),
        count(*) filter (
          where
            q.movement_type = 'sort_in'
        )
      into
        v_out_n,
        v_loss_n,
        v_size_n
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type in ('sort_out', 'sort_in', 'sort_loss');

      if v_out_n <> 1 or v_loss_n > 1 then
        raise exception 'recompute result is out of range'
          using errcode = '22023';
      end if;

      select
        q.item_id
      into v_raw
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type = 'sort_out';

      select
        coalesce(sum(-q.quantity), 0)
      into v_qty_taken
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type in ('sort_out', 'sort_loss')
        and q.item_id = v_raw;

      select
        b.on_hand_qty,
        b.on_hand_value,
        b.avg_cost,
        b.has_uncovered_deficit
      into
        v_on_qty,
        v_on_value,
        v_avg,
        v_has_def
      from
        ledger_scratch.recompute_bal b
      where
        b.item_id = v_raw;

      if v_has_def
      or v_on_qty <= 0
      or v_qty_taken > v_on_qty then
        raise exception 'not enough stock to sort: on_hand_qty %, requested %',
          v_on_qty,
          v_qty_taken
          using errcode = '22023';
      end if;

      if v_qty_taken = v_on_qty then
        v_value_taken := v_on_value;
      else
        v_value_taken := pg_catalog.round(v_on_value * v_qty_taken / v_on_qty, 2);
      end if;

      v_value_taken := app.assert_recompute_range (v_value_taken, 2, true);
      v_avg := app.assert_recompute_range (v_avg, 6, false);

      select
        coalesce(sum(-q.quantity), 0)
      into v_loss_qty
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type = 'sort_loss';

      v_remaining_value := v_value_taken;
      v_remaining_qty := v_qty_taken;

      if v_loss_qty > 0 then
        v_loss_value := pg_catalog.round(
          v_remaining_value * v_loss_qty / v_remaining_qty,
          2
        );

        if v_loss_value < 0 then
          v_loss_value := 0;
        elsif v_loss_value > v_remaining_value then
          v_loss_value := v_remaining_value;
        end if;

        v_remaining_value := v_remaining_value - v_loss_value;
        v_remaining_qty := v_remaining_qty - v_loss_qty;
      else
        v_loss_value := 0;
      end if;

      insert into
        ledger_scratch.recompute_override (movement_id, unit_cost, total_cost)
      select
        q.movement_id,
        v_avg,
        -v_remaining_value
      from
        ledger_scratch.recompute_row q
      where
        q.batch_id = r.batch_id
        and q.movement_type = 'sort_out';

      if v_loss_qty > 0 then
        insert into
          ledger_scratch.recompute_override (movement_id, unit_cost, total_cost)
        select
          q.movement_id,
          v_avg,
          -v_loss_value
        from
          ledger_scratch.recompute_row q
        where
          q.batch_id = r.batch_id
          and q.movement_type = 'sort_loss';
      end if;

      v_size_i := 0;

      for sz in
        select
          q.*
        from
          ledger_scratch.recompute_row q
        where
          q.batch_id = r.batch_id
          and q.movement_type = 'sort_in'
        order by
          q.movement_id asc
      loop
        v_size_i := v_size_i + 1;

        if v_size_i = v_size_n then
          v_size_value := v_remaining_value;
        else
          v_size_value := pg_catalog.round(
            v_remaining_value * sz.quantity / v_remaining_qty,
            2
          );

          if v_size_value < 0 then
            v_size_value := 0;
          elsif v_size_value > v_remaining_value then
            v_size_value := v_remaining_value;
          end if;
        end if;

        v_remaining_value := v_remaining_value - v_size_value;
        v_remaining_qty := v_remaining_qty - sz.quantity;
        v_size_unit := app.assert_recompute_range (
          pg_catalog.round(v_size_value / sz.quantity, 6),
          6,
          false
        );
        v_size_value := app.assert_recompute_range (v_size_value, 2, false);

        insert into
          ledger_scratch.recompute_override (movement_id, unit_cost, total_cost)
        values
          (sz.movement_id, v_size_unit, v_size_value);
      end loop;

      for s in
        select
          q.*
        from
          ledger_scratch.recompute_row q
        where
          q.batch_id = r.batch_id
          and q.movement_type in ('sort_out', 'sort_in', 'sort_loss')
        order by
          q.movement_id asc
      loop
        select
          o.unit_cost,
          o.total_cost
        into
          v_unit,
          v_forced
        from
          ledger_scratch.recompute_override o
        where
          o.movement_id = s.movement_id;

        if s.movement_type = 'sort_in' then
          perform app.replay_inflow (
            s.movement_id,
            s.item_id,
            s.movement_type,
            s.occurred_at,
            s.quantity,
            v_unit,
            v_forced,
            s.is_pending,
            s.line_key,
            s.shift_id,
            s.source_type,
            s.source_id,
            s.note
          );
        else
          perform app.replay_outflow (
            s.movement_id,
            s.item_id,
            s.movement_type,
            s.occurred_at,
            -s.quantity,
            v_forced,
            s.is_pending,
            s.line_key,
            s.shift_id,
            s.source_type,
            s.source_id,
            s.note
          );
        end if;
      end loop;

      v_done := v_done || r.batch_id;
    elsif r.quantity < 0 then
      perform app.replay_outflow (
        r.movement_id,
        r.item_id,
        r.movement_type,
        r.occurred_at,
        -r.quantity,
        null,
        r.is_pending,
        r.line_key,
        r.shift_id,
        r.source_type,
        r.source_id,
        r.note
      );
    elsif r.quantity > 0 then
      perform app.replay_inflow (
        r.movement_id,
        r.item_id,
        r.movement_type,
        r.occurred_at,
        r.quantity,
        r.unit_cost,
        r.total_cost,
        r.is_pending,
        r.line_key,
        r.shift_id,
        r.source_type,
        r.source_id,
        r.note
      );
    else
      raise exception 'recompute result is out of range'
        using errcode = '22023';
    end if;
  end loop;

  if not p_write then
    return;
  end if;

  for e in
    select
      fx.movement_id,
      fx.item_id,
      fx.movement_type,
      fx.base_total,
      fx.unit_cost as replay_unit,
      fx.cover_total,
      sm.total_cost as stored_total,
      sm.unit_cost as stored_unit,
      sm.occurred_at
    from
      ledger_scratch.recompute_effect fx
      join app.stock_movements sm on sm.id = fx.movement_id
  loop
    select
      coalesce(sum(ca.total_cost), 0)
    into v_old
    from
      app.stock_movements ca
    where
      ca.adjusts_movement_id = e.movement_id
      and ca.movement_type = 'cost_adjustment';

    v_required := e.base_total + e.cover_total;
    v_existing := e.stored_total + v_old;
    v_diff := v_required - v_existing;

    if v_diff <> 0 then
      v_diff := app.assert_recompute_range (v_diff, 2, true);
      v_unit_diff := app.assert_recompute_range (e.replay_unit - e.stored_unit, 6, true);
      v_shift := app.shift_for_target (e.movement_id);

      insert into
        app.stock_movements (
          batch_id,
          item_id,
          movement_type,
          occurred_at,
          quantity,
          unit_cost,
          total_cost,
          is_provisional,
          adjusts_movement_id,
          shift_id,
          source_type,
          source_id
        )
      values
        (
          p_cause,
          e.item_id,
          'cost_adjustment',
          e.occurred_at,
          0,
          v_unit_diff,
          v_diff,
          false,
          e.movement_id,
          v_shift,
          'recompute',
          p_cause::text
        )
      returning
        id into v_new_id;

      perform app.note_period_revision (
        v_new_id,
        v_shift,
        app.profit_bucket (e.movement_type),
        v_diff,
        e.item_id,
        p_cause
      );
    end if;
  end loop;

  delete from app.provisional_deficits pd
  where
    pd.item_id = any (p_item_ids);

  insert into
    app.provisional_deficits (
      movement_id,
      item_id,
      qty_uncovered,
      provisional_unit_cost,
      value_uncovered
    )
  select
    d.movement_id,
    d.item_id,
    d.qty_uncovered,
    d.provisional_unit_cost,
    d.value_uncovered
  from
    ledger_scratch.recompute_def d
  where
    d.item_id = any (p_item_ids);

  update app.item_balances ib
  set
    on_hand_qty = b.on_hand_qty,
    on_hand_value = b.on_hand_value,
    avg_cost = b.avg_cost,
    has_uncovered_deficit = exists (
      select
        1
      from
        app.provisional_deficits pd
      where
        pd.item_id = ib.item_id
        and pd.qty_uncovered > 0
    ),
    last_occurred_at = greatest(
      ib.last_occurred_at,
      (
        select
          max(sm.occurred_at)
        from
          app.stock_movements sm
        where
          sm.item_id = ib.item_id
          and sm.movement_type <> 'cost_adjustment'
      ),
      (
        select
          max(sc.counted_at + interval '1 microsecond')
        from
          app.stock_count_lines scl
          join app.stock_counts sc on sc.id = scl.count_id
        where
          scl.item_id = ib.item_id
      )
    )
  from
    ledger_scratch.recompute_bal b
  where
    ib.item_id = b.item_id
    and ib.item_id = any (p_item_ids);

  if exists (
    select
      1
    from
      app.item_balances ib
    where
      ib.item_id = any (p_item_ids)
      and (
        ib.on_hand_qty is distinct from (
          select
            coalesce(sum(sm.quantity), 0)
          from
            app.stock_movements sm
          where
            sm.item_id = ib.item_id
        )
        or ib.on_hand_value is distinct from (
          select
            coalesce(sum(sm.total_cost), 0)
          from
            app.stock_movements sm
          where
            sm.item_id = ib.item_id
        )
      )
  ) then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
  end if;
exception
  when numeric_value_out_of_range then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
end;
$$;

revoke all on function app.replay_execute (uuid[], jsonb, uuid, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_backdated_batch (p_batch_id uuid, p_pending jsonb) returns bigint[] language plpgsql security definer
set
  search_path = '' as $$
declare
  e record;
  r record;
  v_seed uuid[] := '{}'::uuid[];
  v_times timestamptz[] := '{}'::timestamptz[];
  v_types text[] := '{}'::text[];
  v_set uuid[];
  v_ids bigint[] := '{}'::bigint[];
  v_id bigint;
  v_shift text;
  v_bucket text;
  v_at timestamptz;
begin
  perform app.assert_ledger_write_allowed ();

  lock table app.pos_shifts in share mode;

  if p_pending is null
  or pg_catalog.jsonb_typeof(p_pending) <> 'array' then
    raise exception 'recompute result is out of range'
      using errcode = '22023';
  end if;

  for e in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_pending) as elem (value)
  loop
    v_at := (e.value ->> 'occurred_at')::timestamptz;

    if v_at is null or not pg_catalog.isfinite(v_at) then
      raise exception 'occurred_at must be a finite timestamp'
        using errcode = '22023';
    end if;

    v_seed := v_seed || (e.value ->> 'item_id')::uuid;
    v_times := v_times || v_at;
    v_types := v_types || (e.value ->> 'movement_type');
  end loop;

  v_set := app.recompute_item_set (v_seed);

  perform app.prepare_balance_locks (v_set);

  perform app.assert_not_before_opening (v_seed, v_times, v_types);

  perform app.assert_count_barrier (v_seed, v_times, v_set);

  perform app.replay_execute (v_set, p_pending, p_batch_id, false);

  for r in
    select
      p.*
    from
      ledger_scratch.recompute_piece p
    order by
      p.line_key asc,
      p.piece_no asc
  loop
    insert into
      app.stock_movements (
        batch_id,
        item_id,
        movement_type,
        occurred_at,
        quantity,
        unit_cost,
        total_cost,
        is_provisional,
        shift_id,
        source_type,
        source_id,
        note
      )
    values
      (
        p_batch_id,
        r.item_id,
        r.movement_type,
        r.occurred_at,
        r.quantity,
        r.unit_cost,
        r.total_cost,
        r.is_provisional,
        r.shift_id,
        r.source_type,
        r.source_id,
        r.note
      )
    returning
      id into v_id;

    if r.movement_type = 'purchase' then
      v_ids := v_ids || v_id;
    end if;

    v_bucket := app.profit_bucket (r.movement_type);

    if v_bucket is not null then
      v_shift := app.shift_for_target (v_id);

      perform app.note_period_revision (
        v_id,
        v_shift,
        v_bucket,
        r.total_cost,
        r.item_id,
        p_batch_id
      );
    end if;
  end loop;

  perform app.rebuild_derived_balances (v_seed, p_batch_id);

  return v_ids;
end;
$$;

revoke all on function app.post_backdated_batch (uuid, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.rebuild_derived_balances (p_item_ids uuid[], p_cause_batch uuid) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_set uuid[];
begin
  perform app.assert_ledger_write_allowed ();

  lock table app.pos_shifts in share mode;

  v_set := app.recompute_item_set (p_item_ids);

  perform app.prepare_balance_locks (v_set);

  perform app.replay_execute (v_set, '[]'::jsonb, p_cause_batch, true);
end;
$$;

comment on function app.rebuild_derived_balances (uuid[], uuid) is 'Replays one connected component from its first movement and writes cost adjustments for the difference. A second call inserts nothing. The 100000-row cap is a known limit for a very large component.';

revoke all on function app.rebuild_derived_balances (uuid[], uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.apply_inflow_movement (
  p_batch_id uuid,
  p_item_id uuid,
  p_movement_type app.movement_type,
  p_occurred_at timestamptz,
  p_in_qty numeric(20, 6),
  p_in_unit_cost numeric(20, 6),
  p_shift_id text,
  p_source_type text,
  p_source_id text,
  p_note text,
  p_in_total_cost numeric(14, 2) default null
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_bal app.item_balances;
  v_inflow_unit_cost numeric(20, 6);
  v_inflow_total_cost numeric(14, 2);
  v_delta_value numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_remaining_inflow_value numeric(14, 2);
  v_covered_qty numeric(20, 6);
  v_covered_inflow_value numeric(14, 2);
  v_covered_prov_value numeric(14, 2);
  v_adj_unit_cost numeric(20, 6);
  v_adj_total_cost numeric(14, 2);
  v_prior_pos_qty numeric(20, 6);
  v_on_hand_value_after_cover numeric(14, 2);
  v_new_avg_cost numeric(20, 6);
  v_has_deficit boolean;
  r_def record;
  v_adj_id bigint;
  v_target_shift text;
begin
  if p_in_qty is null
  or p_in_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or p_in_qty <= 0 then
    raise exception 'inflow quantity must be a finite number > 0'
      using errcode = '22023';
  end if;

  v_bal := app.lock_and_validate_item_balance (p_item_id, p_occurred_at);

  if p_movement_type = 'count_adjustment' then
    v_inflow_unit_cost := v_bal.avg_cost;
  else
    v_inflow_unit_cost := p_in_unit_cost;
  end if;

  if v_inflow_unit_cost is null
  or v_inflow_unit_cost in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or v_inflow_unit_cost < 0 then
    raise exception 'inflow unit_cost must be a finite number >= 0'
      using errcode = '22023';
  end if;

  if p_in_total_cost is not null then
    if p_in_total_cost in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or p_in_total_cost < 0 then
      raise exception 'inflow total_cost must be a finite number >= 0'
        using errcode = '22023';
    end if;
    v_inflow_total_cost := p_in_total_cost;
  else
    v_inflow_total_cost := pg_catalog.round(p_in_qty * v_inflow_unit_cost, 2);
  end if;

  insert into
    app.stock_movements (
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      is_provisional,
      shift_id,
      source_type,
      source_id,
      note
    )
  values
    (
      p_batch_id,
      p_item_id,
      p_movement_type,
      p_occurred_at,
      p_in_qty,
      v_inflow_unit_cost,
      v_inflow_total_cost,
      false,
      p_shift_id,
      p_source_type,
      p_source_id,
      p_note
    );

  v_delta_value := v_inflow_total_cost;
  v_remaining_qty := p_in_qty;
  v_remaining_inflow_value := v_inflow_total_cost;

  -- Cover uncovered deficits oldest-first.
  for r_def in
    select
      pd.movement_id,
      pd.qty_uncovered,
      pd.value_uncovered,
      pd.provisional_unit_cost,
      sm.movement_type as prov_type
    from
      app.provisional_deficits pd
      join app.stock_movements sm on sm.id = pd.movement_id
    where
      pd.item_id = p_item_id
      and pd.qty_uncovered > 0
    order by
      sm.occurred_at asc,
      sm.id asc
    for update of pd
  loop
    exit when v_remaining_qty <= 0;

    v_covered_qty := least(v_remaining_qty, r_def.qty_uncovered);

    if v_covered_qty = v_remaining_qty then
      v_covered_inflow_value := v_remaining_inflow_value;
    else
      v_covered_inflow_value := pg_catalog.round(
        v_remaining_inflow_value * v_covered_qty / v_remaining_qty,
        2
      );
    end if;

    -- Conserve the original provisional value. A cover of the whole remainder
    -- takes value_uncovered exactly; a partial cover takes its quantity share,
    -- rounded to the piaster. provisional_unit_cost stays for unit_cost only.
    if v_covered_qty = r_def.qty_uncovered then
      v_covered_prov_value := r_def.value_uncovered;
    else
      v_covered_prov_value := pg_catalog.round(
        r_def.value_uncovered * v_covered_qty / r_def.qty_uncovered,
        2
      );
    end if;

    v_adj_unit_cost := v_inflow_unit_cost - r_def.provisional_unit_cost;
    v_adj_total_cost := -(v_covered_inflow_value - v_covered_prov_value);
    v_target_shift := app.shift_for_target (r_def.movement_id);

    insert into
      app.stock_movements (
        batch_id,
        item_id,
        movement_type,
        occurred_at,
        quantity,
        unit_cost,
        total_cost,
        is_provisional,
        adjusts_movement_id,
        shift_id,
        source_type,
        source_id,
        note
      )
    values
      (
        p_batch_id,
        p_item_id,
        'cost_adjustment',
        p_occurred_at,
        0,
        v_adj_unit_cost,
        v_adj_total_cost,
        false,
        r_def.movement_id,
        v_target_shift,
        p_source_type,
        p_source_id,
        p_note
      )
    returning
      id into v_adj_id;

    perform app.note_period_revision (
      v_adj_id,
      v_target_shift,
      app.profit_bucket (r_def.prov_type),
      v_adj_total_cost,
      p_item_id,
      p_batch_id
    );

    update app.provisional_deficits
    set
      qty_uncovered = qty_uncovered - v_covered_qty,
      value_uncovered = value_uncovered - v_covered_prov_value
    where
      movement_id = r_def.movement_id;

    v_remaining_qty := v_remaining_qty - v_covered_qty;
    v_remaining_inflow_value := v_remaining_inflow_value - v_covered_inflow_value;
    v_delta_value := v_delta_value + v_adj_total_cost;
  end loop;

  v_prior_pos_qty := greatest(v_bal.on_hand_qty, 0::numeric(20, 6));
  v_on_hand_value_after_cover := case
    when v_bal.on_hand_qty > 0 then greatest(v_bal.on_hand_value, 0::numeric(14, 2))
    else 0::numeric(14, 2)
  end;

  if v_prior_pos_qty + v_remaining_qty > 0 then
    v_new_avg_cost := pg_catalog.round(
      (v_on_hand_value_after_cover + v_remaining_inflow_value) / (v_prior_pos_qty + v_remaining_qty),
      6
    );
  elsif p_movement_type in ('purchase', 'sort_in')
  or (
    p_movement_type = 'opening'
    and v_inflow_unit_cost > 0
  ) then
    v_new_avg_cost := v_inflow_unit_cost;
  else
    v_new_avg_cost := v_bal.avg_cost;
  end if;

  select
    exists (
      select
        1
      from
        app.provisional_deficits pd
      where
        pd.item_id = p_item_id
        and pd.qty_uncovered > 0
    )
  into v_has_deficit;

  -- Put any piaster rounding remainder on on_hand_value so ledger sum == on_hand_value at all times.
  update app.item_balances
  set
    on_hand_qty = v_bal.on_hand_qty + p_in_qty,
    on_hand_value = v_bal.on_hand_value + v_delta_value,
    avg_cost = v_new_avg_cost,
    last_occurred_at = p_occurred_at,
    has_uncovered_deficit = v_has_deficit
  where
    item_id = p_item_id;
end;
$$;

create or replace function app.record_purchase (p_purchase jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_purchase_id uuid;
  v_batch_id uuid;
  v_purchased_at timestamptz;
  v_at_text text;
  v_supplier text;
  v_invoice_no text;
  v_note text;
  v_elem jsonb;
  v_item_text text;
  v_item_id uuid;
  v_name text;
  v_base_unit text;
  v_qty_text text;
  v_qty numeric;
  v_unit text;
  v_factor numeric;
  v_base_qty numeric;
  v_amount_text text;
  v_amount numeric;
  v_unit_cost numeric;
  v_total numeric := 0;
  v_n integer := 0;
  v_prev bigint;
  v_movement_id bigint;
  v_item_ids uuid[] := '{}'::uuid[];
  v_names text[] := '{}'::text[];
  v_qtys numeric[] := '{}'::numeric[];
  v_units text[] := '{}'::text[];
  v_base_qtys numeric[] := '{}'::numeric[];
  v_amounts numeric[] := '{}'::numeric[];
  v_unit_costs numeric[] := '{}'::numeric[];
  v_movement_ids bigint[] := '{}'::bigint[];
  v_factors numeric[] := '{}'::numeric[];
  v_base_units text[] := '{}'::text[];
  v_expected_bases text[] := '{}'::text[];
  v_expected_factors numeric[] := '{}'::numeric[];
  v_expected_base text;
  v_expected_factor_text text;
  v_expected_factor numeric;
  v_request_text text;
  v_request_id uuid;
  v_existing_id uuid;
  v_existing_at timestamptz;
  v_existing_supplier text;
  v_existing_invoice text;
  v_existing_note text;
  v_detail text;
  v_pending jsonb;
  v_times timestamptz[];
  v_type_fill text[];
begin
  perform app.assert_ledger_write_allowed ();

  if p_purchase is null or pg_catalog.jsonb_typeof(p_purchase) <> 'object' then
    raise exception 'p_purchase must be a jsonb object'
      using errcode = '22023';
  end if;

  if p_purchase ? 'supplier'
  and pg_catalog.jsonb_typeof(p_purchase -> 'supplier') not in ('string', 'null') then
    raise exception 'supplier must be text'
      using errcode = '22023';
  end if;

  if p_purchase ? 'invoice_no'
  and pg_catalog.jsonb_typeof(p_purchase -> 'invoice_no') not in ('string', 'null') then
    raise exception 'invoice_no must be text'
      using errcode = '22023';
  end if;

  if p_purchase ? 'note'
  and pg_catalog.jsonb_typeof(p_purchase -> 'note') not in ('string', 'null') then
    raise exception 'note must be text'
      using errcode = '22023';
  end if;

  v_at_text := nullif(pg_catalog.btrim(p_purchase ->> 'purchased_at'), '');

  if v_at_text is null then
    raise exception 'purchased_at is required'
      using errcode = '22023';
  end if;

  begin
    v_purchased_at := v_at_text::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception 'purchased_at must be a finite timestamp'
        using errcode = '22023';
  end;

  if v_purchased_at is null or not pg_catalog.isfinite(v_purchased_at) then
    raise exception 'purchased_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  v_supplier := nullif(pg_catalog.btrim(p_purchase ->> 'supplier'), '');

  if v_supplier is not null and pg_catalog.char_length(v_supplier) > 120 then
    raise exception 'supplier must be at most 120 characters'
      using errcode = '22023';
  end if;

  v_invoice_no := nullif(pg_catalog.btrim(p_purchase ->> 'invoice_no'), '');

  if v_invoice_no is not null and pg_catalog.char_length(v_invoice_no) > 60 then
    raise exception 'invoice_no must be at most 60 characters'
      using errcode = '22023';
  end if;

  v_note := nullif(pg_catalog.btrim(p_purchase ->> 'note'), '');

  if v_note is not null and pg_catalog.char_length(v_note) > 500 then
    raise exception 'note must be at most 500 characters'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_purchase -> 'lines') is distinct from 'array'
  or pg_catalog.jsonb_array_length(p_purchase -> 'lines') < 1
  or pg_catalog.jsonb_array_length(p_purchase -> 'lines') > 100 then
    raise exception 'lines must be a jsonb array of 1 to 100 purchase lines'
      using errcode = '22023';
  end if;

  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_purchase -> 'lines') as e (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each purchase line must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item_text := nullif(pg_catalog.btrim(v_elem ->> 'item_id'), '');
    v_qty_text := nullif(pg_catalog.btrim(v_elem ->> 'quantity'), '');
    v_unit := nullif(pg_catalog.btrim(v_elem ->> 'unit'), '');
    v_amount_text := nullif(pg_catalog.btrim(v_elem ->> 'amount_paid'), '');

    if v_item_text is null
    or v_qty_text is null
    or v_unit is null
    or v_amount_text is null then
      raise exception 'item_id, quantity, unit, and amount_paid are required'
        using errcode = '22023';
    end if;

    if v_item_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'item_id must be a uuid'
        using errcode = '22023';
    end if;

    v_item_id := v_item_text::uuid;

    if v_qty_text !~ '^\d+(\.\d+)?$' then
      raise exception 'quantity must be a finite number > 0'
        using errcode = '22023';
    end if;

    v_qty := v_qty_text::numeric;

    if v_qty <> pg_catalog.round(v_qty, 6) then
      raise exception 'quantity must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    if v_qty <= 0 or v_qty >= 100000000000000 then
      raise exception 'quantity must be a finite number > 0'
        using errcode = '22023';
    end if;

    if v_amount_text !~ '^\d+(\.\d+)?$' then
      raise exception 'amount_paid must be a finite number >= 0'
        using errcode = '22023';
    end if;

    v_amount := v_amount_text::numeric;

    if v_amount <> pg_catalog.round(v_amount, 2) then
      raise exception 'amount_paid must be in piasters'
        using errcode = '22023';
    end if;

    if v_amount < 0 or v_amount >= 1000000000000 then
      raise exception 'amount_paid must be a finite number >= 0'
        using errcode = '22023';
    end if;

    -- Expected fields are syntax-checked here and compared with the catalog
    -- only after a replay miss. A missing value stays null so a saved draft
    -- can return before that check. array_append keeps a null element.
    v_expected_base := nullif(
      pg_catalog.btrim(v_elem ->> 'expected_base_unit'),
      ''
    );
    v_expected_factor_text := nullif(
      pg_catalog.btrim(v_elem ->> 'expected_factor'),
      ''
    );
    if v_expected_factor_text is null then
      v_expected_factor := null;
    elsif v_expected_factor_text !~ '^\d+(\.\d+)?$' then
      raise exception 'expected_factor is required'
        using errcode = '22023';
    else
      v_expected_factor := v_expected_factor_text::numeric;
    end if;

    v_item_ids := v_item_ids || v_item_id;
    v_qtys := v_qtys || v_qty;
    v_units := v_units || v_unit;
    v_amounts := v_amounts || v_amount;
    v_expected_bases := pg_catalog.array_append(v_expected_bases, v_expected_base);
    v_expected_factors := pg_catalog.array_append(
      v_expected_factors,
      v_expected_factor
    );
    v_n := v_n + 1;
  end loop;

  -- Replay uses the normalized payload only: trimmed text, timestamptz, uuid,
  -- and numerics already rejected when they would not fit the columns
  -- (quantity scale 6, amount_paid in piasters). No stock_items or conversion
  -- read has happened, so a deleted unit still returns the saved purchase.
  -- The advisory lock serializes this lookup with every other ledger write.
  -- purchases.request_id is unique as the final guard: a second insert that
  -- still raced fails and rolls its inflows back with this transaction.
  v_request_text := nullif(pg_catalog.btrim(p_purchase ->> 'request_id'), '');
  if v_request_text is not null then
    if v_request_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'request_id is required'
        using errcode = '22023';
    end if;
    v_request_id := v_request_text::uuid;
    select
      p.id,
      p.purchased_at,
      p.supplier,
      p.invoice_no,
      p.note
    into
      v_existing_id,
      v_existing_at,
      v_existing_supplier,
      v_existing_invoice,
      v_existing_note
    from
      app.purchases p
    where
      p.request_id = v_request_id;
    if found then
      if v_existing_at is distinct from v_purchased_at
      or v_existing_supplier is distinct from v_supplier
      or v_existing_invoice is distinct from v_invoice_no
      or v_existing_note is distinct from v_note
      or (
        select
          count(*)
        from
          app.purchase_lines pl
        where
          pl.purchase_id = v_existing_id
      ) is distinct from v_n
      or exists (
        select
          1
        from
          app.purchase_lines pl
          join rows from (pg_catalog.unnest(v_item_ids), pg_catalog.unnest(v_qtys), pg_catalog.unnest(v_units), pg_catalog.unnest(v_amounts)) with ordinality as u (item_id, quantity, unit, amount_paid, line_no) on u.line_no = pl.line_no
        where
          pl.purchase_id = v_existing_id
          and (
            pl.item_id is distinct from u.item_id
            or pl.quantity is distinct from u.quantity
            or pl.unit is distinct from u.unit
            or pl.amount_paid is distinct from u.amount_paid
          )
      ) then
        raise exception 'request_id already used for a different purchase'
          using errcode = '22023';
      end if;
      return v_existing_id;
    end if;
  end if;

  if v_request_id is null then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  -- First post for this request. Catalog reads stay under the posting lock.
  for v_i in 1..v_n loop
    v_item_id := v_item_ids[v_i];
    v_qty := v_qtys[v_i];
    v_unit := v_units[v_i];
    v_amount := v_amounts[v_i];

    select
      si.name,
      si.base_unit
    into
      v_name,
      v_base_unit
    from
      app.stock_items si
    where
      si.id = v_item_id;

    if not found then
      raise exception 'unknown stock_item id: %', v_item_id
        using errcode = '22023';
    end if;

    -- A reviewed base unit that no longer matches is refused before the unit
    -- name is resolved, so a stale unit name is not reported as unknown.
    if v_expected_bases[v_i] is not null
    and v_expected_bases[v_i] is distinct from v_base_unit then
      raise exception 'conversion changed'
        using errcode = '40001';
    end if;

    if v_unit = v_base_unit then
      v_factor := 1;
    else
      select
        iuc.factor_to_base
      into v_factor
      from
        app.item_unit_conversions iuc
      where
        iuc.item_id = v_item_id
        and iuc.unit = v_unit;

      if not found then
        raise exception 'unknown unit "%" for item %', v_unit, v_name
          using errcode = '22023';
      end if;
    end if;

    v_base_qty := pg_catalog.round(v_qty * v_factor, 6);

    if v_base_qty <= 0 or v_base_qty >= 100000000000000 then
      raise exception 'purchase base quantity must be > 0'
        using errcode = '22023';
    end if;

    if v_amount = 0 then
      v_unit_cost := 0;
    else
      v_unit_cost := pg_catalog.round(v_amount / v_base_qty, 6);
    end if;

    if v_amount > 0 and v_unit_cost <= 0 then
      raise exception 'converted purchase unit_cost must be > 0'
        using errcode = '22023';
    end if;

    if v_unit_cost >= 100000000000000 then
      raise exception 'purchase unit_cost is out of range'
        using errcode = '22023';
    end if;

    v_total := v_total + v_amount;

    if v_total >= 1000000000000 then
      raise exception 'purchase total_paid is out of range'
        using errcode = '22023';
    end if;

    v_names := v_names || v_name;
    v_base_qtys := v_base_qtys || v_base_qty;
    v_unit_costs := v_unit_costs || v_unit_cost;
    v_factors := v_factors || v_factor;
    v_base_units := v_base_units || v_base_unit;
  end loop;

  for v_i in 1..v_n loop
    if v_expected_bases[v_i] is null or v_expected_factors[v_i] is null then
      raise exception 'expected_base_unit is required'
        using errcode = '22023';
    end if;

    if v_expected_bases[v_i] is distinct from v_base_units[v_i]
    or v_expected_factors[v_i] is distinct from v_factors[v_i] then
      raise exception 'conversion changed'
        using errcode = '40001';
    end if;
  end loop;

  v_purchase_id := pg_catalog.gen_random_uuid();
  v_batch_id := pg_catalog.gen_random_uuid();
  v_times := pg_catalog.array_fill(v_purchased_at, array[v_n]);
  v_type_fill := pg_catalog.array_fill('purchase'::text, array[v_n]);

  perform app.assert_not_before_opening (v_item_ids, v_times, v_type_fill);

  if not app.batch_is_forward (v_item_ids, v_times) then
    v_pending := '[]'::jsonb;

    for v_i in 1..v_n loop
      v_pending := v_pending || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_key',
          v_i,
          'batch_id',
          v_batch_id,
          'item_id',
          v_item_ids[v_i],
          'movement_type',
          'purchase',
          'occurred_at',
          v_purchased_at,
          'quantity',
          v_base_qtys[v_i],
          'unit_cost',
          v_unit_costs[v_i],
          'total_cost',
          v_amounts[v_i],
          'is_input_total',
          true,
          'shift_id',
          null,
          'source_type',
          'purchase',
          'source_id',
          v_purchase_id::text,
          'note',
          null
        )
      );
    end loop;

    begin
      v_movement_ids := app.post_backdated_batch (v_batch_id, v_pending);
    exception
      when sqlstate 'P0001' then
        get stacked diagnostics v_detail = pg_exception_detail;

        if sqlerrm in (
          'back-dated movement not supported yet',
          'movement is before opening stock'
        ) then
          raise exception using
            message = sqlerrm,
            errcode = 'P0001',
            detail = coalesce(nullif(v_detail, ''), v_names[1]);
        end if;

        raise;
    end;

    if coalesce(pg_catalog.cardinality(v_movement_ids), 0) <> v_n then
      raise exception 'purchase movement was not posted'
        using errcode = 'P0001';
    end if;
  else
  for v_i in 1..v_n loop
    v_name := v_names[v_i];
    v_prev := coalesce(
      (
        select
          max(sm.id)
        from
          app.stock_movements sm
        where
          sm.batch_id = v_batch_id
          and sm.item_id = v_item_ids[v_i]
          and sm.movement_type = 'purchase'
      ),
      0
    );

    begin
      perform app.apply_inflow_movement (
        v_batch_id,
        v_item_ids[v_i],
        'purchase'::app.movement_type,
        v_purchased_at,
        v_base_qtys[v_i],
        v_unit_costs[v_i],
        null,
        'purchase',
        v_purchase_id::text,
        null,
        v_amounts[v_i]
      );
    exception
      when sqlstate 'P0001' then
        get stacked diagnostics v_detail = pg_exception_detail;

        if sqlerrm in (
          'back-dated movement not supported yet',
          'movement is before opening stock'
        ) then
          raise exception using
            message = sqlerrm,
            errcode = 'P0001',
            detail = coalesce(nullif(v_detail, ''), v_name);
        end if;

        raise;
    end;

    select
      sm.id
    into v_movement_id
    from
      app.stock_movements sm
    where
      sm.batch_id = v_batch_id
      and sm.item_id = v_item_ids[v_i]
      and sm.movement_type = 'purchase'
      and sm.id > v_prev
    order by
      sm.id
    limit
      1;

    if v_movement_id is null then
      raise exception 'purchase movement was not posted'
        using errcode = 'P0001';
    end if;

    v_movement_ids := v_movement_ids || v_movement_id;
  end loop;

  end if;

  insert into
    app.purchases (
      id,
      request_id,
      purchased_at,
      supplier,
      invoice_no,
      note,
      total_paid,
      batch_id,
      created_by
    )
  values
    (
      v_purchase_id,
      v_request_id,
      v_purchased_at,
      v_supplier,
      v_invoice_no,
      v_note,
      v_total,
      v_batch_id,
      auth.uid ()
    );

  for v_i in 1..v_n loop
    insert into
      app.purchase_lines (
        purchase_id,
        line_no,
        item_id,
        quantity,
        unit,
        base_quantity,
        amount_paid,
        movement_id
      )
    values
      (
        v_purchase_id,
        v_i,
        v_item_ids[v_i],
        v_qtys[v_i],
        v_units[v_i],
        v_base_qtys[v_i],
        v_amounts[v_i],
        v_movement_ids[v_i]
      );
  end loop;

  return v_purchase_id;
end;
$$;

comment on function app.record_purchase (jsonb) is 'Posts one purchase and its lines in the caller transaction. Takes advisory lock 7342750000000000001 via app.assert_ledger_write_allowed before reading units or locking balances. Each line''s stock_movements.total_cost is amount_paid exactly (passed as apply_inflow_movement.p_in_total_cost); unit_cost is round(amount_paid / base_quantity, 6).';

-- ============================================================================
-- 5. Forward cover order, then the posting routes
-- ============================================================================
create or replace function app.post_movements (p_movements jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_batch_id uuid;
  v_elem jsonb;
  v_item_id uuid;
  v_type_text text;
  v_movement_type app.movement_type;
  v_occurred_at timestamptz;
  v_raw_qty numeric;
  v_unit text;
  v_raw_unit_cost numeric;
  v_shift_id text;
  v_source_type text;
  v_source_id text;
  v_note text;
  v_base_unit text;
  v_factor numeric(18, 9);
  v_qty numeric(20, 6);
  v_total_cost numeric(14, 2);
  v_unit_cost numeric(20, 6);
  v_item_ids uuid[] := '{}'::uuid[];
  v_types text[] := '{}'::text[];
  v_times timestamptz[] := '{}'::timestamptz[];
  v_qtys numeric[] := '{}'::numeric[];
  v_unit_costs numeric[] := '{}'::numeric[];
  v_totals numeric[] := '{}'::numeric[];
  v_shifts text[] := '{}'::text[];
  v_source_types text[] := '{}'::text[];
  v_source_ids text[] := '{}'::text[];
  v_notes text[] := '{}'::text[];
  v_n integer := 0;
  v_pending jsonb;
  v_signed numeric;
begin
  perform app.assert_ledger_write_allowed ();

  if p_movements is null
  or pg_catalog.jsonb_typeof(p_movements) <> 'array'
  or pg_catalog.jsonb_array_length(p_movements) = 0 then
    raise exception 'p_movements must be a non-empty jsonb array'
      using errcode = '22023';
  end if;

  v_batch_id := pg_catalog.gen_random_uuid();

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_movements) as elem (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each movement element must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item_id := (v_elem ->> 'item_id')::uuid;
    v_type_text := v_elem ->> 'movement_type';
    v_occurred_at := (v_elem ->> 'occurred_at')::timestamptz;
    v_raw_qty := (v_elem ->> 'quantity')::numeric;
    v_unit := nullif(pg_catalog.btrim(v_elem ->> 'unit'), '');
    v_raw_unit_cost := (v_elem ->> 'unit_cost')::numeric;
    v_shift_id := v_elem ->> 'shift_id';
    v_source_type := v_elem ->> 'source_type';
    v_source_id := v_elem ->> 'source_id';
    v_note := v_elem ->> 'note';
    v_unit_cost := null;
    v_total_cost := null;

    if v_item_id is null or v_type_text is null or v_occurred_at is null or v_raw_qty is null then
      raise exception 'item_id, movement_type, occurred_at, and quantity are required'
        using errcode = '22023';
    end if;

    if v_raw_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'movement quantity must be a finite number'
        using errcode = '22023';
    end if;

    if v_raw_unit_cost is not null
    and v_raw_unit_cost in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'movement unit_cost must be a finite number'
        using errcode = '22023';
    end if;

    if v_type_text not in (
      'opening',
      'purchase',
      'sale',
      'waste',
      'count_adjustment'
    ) then
      raise exception 'disallowed movement_type in post_movements: %', v_type_text
        using errcode = '22023';
    end if;

    v_movement_type := v_type_text::app.movement_type;

    select
      si.base_unit
    into v_base_unit
    from
      app.stock_items si
    where
      si.id = v_item_id;

    if not found then
      raise exception 'unknown stock_item id: %', v_item_id
        using errcode = '22023';
    end if;

    if v_unit is null or v_unit = v_base_unit then
      v_factor := 1;
    else
      select
        iuc.factor_to_base
      into v_factor
      from
        app.item_unit_conversions iuc
      where
        iuc.item_id = v_item_id
        and iuc.unit = v_unit;

      if not found then
        raise exception 'unknown unit "%" for item %', v_unit, v_item_id
          using errcode = '22023';
      end if;
    end if;

    v_qty := pg_catalog.round(v_raw_qty * v_factor, 6);

    if v_qty = 0 then
      raise exception 'movement quantity must not be zero'
        using errcode = '22023';
    end if;

    if v_movement_type = 'purchase' then
      if v_qty <= 0 then
        raise exception 'purchase quantity must be > 0'
          using errcode = '22023';
      end if;

      if v_raw_unit_cost is null or v_raw_unit_cost <= 0 then
        raise exception 'purchase unit_cost must be > 0'
          using errcode = '22023';
      end if;

      v_total_cost := pg_catalog.round(v_raw_qty * v_raw_unit_cost, 2);

      if v_total_cost <= 0 then
        raise exception 'purchase total_cost must be > 0'
          using errcode = '22023';
      end if;

      v_unit_cost := pg_catalog.round(v_total_cost / v_qty, 6);

      if v_unit_cost <= 0 then
        raise exception 'converted purchase unit_cost must be > 0'
          using errcode = '22023';
      end if;
    elsif v_movement_type = 'opening' then
      if v_qty <= 0 then
        raise exception 'opening quantity must be > 0'
          using errcode = '22023';
      end if;

      if v_raw_unit_cost is null or v_raw_unit_cost < 0 then
        raise exception 'opening unit_cost must be >= 0'
          using errcode = '22023';
      end if;

      v_total_cost := pg_catalog.round(v_raw_qty * v_raw_unit_cost, 2);
      v_unit_cost := pg_catalog.round(v_total_cost / v_qty, 6);
    elsif v_movement_type in ('sale', 'waste') then
      if v_qty <= 0 then
        raise exception '% quantity must be > 0', v_movement_type
          using errcode = '22023';
      end if;
    end if;

    v_n := v_n + 1;
    v_item_ids := v_item_ids || v_item_id;
    v_types := v_types || v_type_text;
    v_times := v_times || v_occurred_at;
    v_qtys := v_qtys || v_qty;
    v_unit_costs := pg_catalog.array_append(v_unit_costs, v_unit_cost);
    v_totals := pg_catalog.array_append(v_totals, v_total_cost);
    v_shifts := pg_catalog.array_append(v_shifts, v_shift_id);
    v_source_types := pg_catalog.array_append(v_source_types, v_source_type);
    v_source_ids := pg_catalog.array_append(v_source_ids, v_source_id);
    v_notes := pg_catalog.array_append(v_notes, v_note);
  end loop;

  perform app.assert_not_before_opening (v_item_ids, v_times, v_types);

  if app.batch_is_forward (v_item_ids, v_times) then
    for v_i in 1..v_n loop
      if v_types[v_i] = 'purchase' then
        perform app.apply_inflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          'purchase',
          v_times[v_i],
          v_qtys[v_i],
          v_unit_costs[v_i],
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i],
          v_totals[v_i]
        );
      elsif v_types[v_i] = 'opening' then
        perform app.apply_inflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          'opening',
          v_times[v_i],
          v_qtys[v_i],
          v_unit_costs[v_i],
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i],
          v_totals[v_i]
        );
      elsif v_types[v_i] in ('sale', 'waste') then
        perform app.apply_outflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          v_types[v_i]::app.movement_type,
          v_times[v_i],
          v_qtys[v_i],
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i]
        );
      elsif v_qtys[v_i] > 0 then
        perform app.apply_inflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          'count_adjustment',
          v_times[v_i],
          v_qtys[v_i],
          null,
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i]
        );
      else
        perform app.apply_outflow_movement (
          v_batch_id,
          v_item_ids[v_i],
          'count_adjustment',
          v_times[v_i],
          -v_qtys[v_i],
          v_shifts[v_i],
          v_source_types[v_i],
          v_source_ids[v_i],
          v_notes[v_i]
        );
      end if;
    end loop;
  else
    for v_i in 1..v_n loop
      if not pg_catalog.isfinite(v_times[v_i]) then
        raise exception 'occurred_at must be a finite timestamp'
          using errcode = '22023';
      end if;
    end loop;

    v_pending := '[]'::jsonb;

    for v_i in 1..v_n loop
      if v_types[v_i] in ('sale', 'waste') then
        v_signed := -v_qtys[v_i];
      else
        v_signed := v_qtys[v_i];
      end if;

      v_pending := v_pending || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_key',
          v_i,
          'batch_id',
          v_batch_id,
          'item_id',
          v_item_ids[v_i],
          'movement_type',
          v_types[v_i],
          'occurred_at',
          v_times[v_i],
          'quantity',
          v_signed,
          'unit_cost',
          coalesce(v_unit_costs[v_i], 0),
          'total_cost',
          coalesce(v_totals[v_i], 0),
          'is_input_total',
          v_types[v_i] in ('purchase', 'opening'),
          'shift_id',
          v_shifts[v_i],
          'source_type',
          v_source_types[v_i],
          'source_id',
          v_source_ids[v_i],
          'note',
          v_notes[v_i]
        )
      );
    end loop;

    perform app.post_backdated_batch (v_batch_id, v_pending);
  end if;

  return v_batch_id;
end;
$$;

comment on function app.post_movements (jsonb) is 'Single server-side entry point to post opening, purchase, sale, waste, and count_adjustment movements.';

revoke all on function app.post_movements (jsonb)
from
  public,
  anon;

grant
execute on function app.post_movements (jsonb) to authenticated,
service_role;

create or replace function app.post_sort (
  p_mixed_item uuid,
  p_occurred_at timestamptz,
  p_qty_taken numeric,
  p_sizes jsonb,
  p_shift_id text default null
) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_batch_id uuid;
  v_mixed_kind text;
  v_mixed_unit text;
  v_mixed_bal app.item_balances;
  v_qty_taken numeric(20, 6);
  v_sum_sizes numeric(20, 6) := 0;
  v_loss_qty numeric(20, 6);
  v_value_taken numeric(14, 2);
  v_loss_value numeric(14, 2);
  v_sort_out_value numeric(14, 2);
  v_remaining_value numeric(14, 2);
  v_remaining_qty numeric(20, 6);
  v_size_value numeric(14, 2);
  v_size_unit_cost numeric(20, 6);
  v_num_sizes int;
  v_elem jsonb;
  v_ord bigint;
  v_size_id uuid;
  v_raw_size_qty numeric;
  v_size_qty numeric(20, 6);
  v_size_kind text;
  v_size_parent uuid;
  v_size_unit text;
  v_check_items uuid[] := '{}'::uuid[];
  v_check_times timestamptz[] := '{}'::timestamptz[];
  v_check_types text[] := '{}'::text[];
  v_pending jsonb := '[]'::jsonb;
  v_key integer := 0;
begin
  perform app.assert_ledger_write_allowed ();

  if p_mixed_item is null or p_occurred_at is null or p_qty_taken is null then
    raise exception 'p_mixed_item, p_occurred_at, and p_qty_taken are required'
      using errcode = '22023';
  end if;

  if p_qty_taken in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'p_qty_taken must be a finite number'
      using errcode = '22023';
  end if;

  v_qty_taken := pg_catalog.round(p_qty_taken, 6);

  if v_qty_taken <= 0 then
    raise exception 'p_qty_taken must be > 0'
      using errcode = '22023';
  end if;

  select
    si.kind,
    si.base_unit
  into
    v_mixed_kind,
    v_mixed_unit
  from
    app.stock_items si
  where
    si.id = p_mixed_item;

  if not found or v_mixed_kind <> 'fish_mixed' or v_mixed_unit <> 'kg' then
    raise exception 'p_mixed_item must be a fish_mixed item in kg'
      using errcode = '22023';
  end if;

  if p_sizes is null
  or pg_catalog.jsonb_typeof(p_sizes) <> 'array'
  or pg_catalog.jsonb_array_length(p_sizes) = 0 then
    raise exception 'p_sizes must be a non-empty jsonb array'
      using errcode = '22023';
  end if;

  v_num_sizes := pg_catalog.jsonb_array_length(p_sizes);
  v_check_items := array[p_mixed_item];
  v_check_times := array[p_occurred_at];
  v_check_types := array['sort_out'::text];

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_sizes) as elem (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each size element must be a jsonb object'
        using errcode = '22023';
    end if;

    v_size_id := (v_elem ->> 'item_id')::uuid;
    v_raw_size_qty := (v_elem ->> 'quantity')::numeric;

    if v_size_id is null or v_raw_size_qty is null then
      raise exception 'each size entry requires item_id and quantity > 0'
        using errcode = '22023';
    end if;

    if v_raw_size_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'size quantity must be a finite number'
        using errcode = '22023';
    end if;

    v_size_qty := pg_catalog.round(v_raw_size_qty, 6);

    if v_size_qty <= 0 then
      raise exception 'each size entry requires item_id and quantity > 0'
        using errcode = '22023';
    end if;

    select
      si.kind,
      si.parent_item_id,
      si.base_unit
    into
      v_size_kind,
      v_size_parent,
      v_size_unit
    from
      app.stock_items si
    where
      si.id = v_size_id;

    if not found
    or v_size_kind <> 'fish_size'
    or v_size_parent is distinct from p_mixed_item
    or v_size_unit <> 'kg' then
      raise exception 'size item % is not a valid fish_size child of mixed item %',
        v_size_id,
        p_mixed_item
        using errcode = '22023';
    end if;

    v_sum_sizes := v_sum_sizes + v_size_qty;
    v_check_items := v_check_items || v_size_id;
    v_check_times := v_check_times || p_occurred_at;
    -- text[] || unknown prefers the array||array cast and rejects a bare literal.
    v_check_types := pg_catalog.array_append(v_check_types, 'sort_in');
  end loop;

  if v_sum_sizes > v_qty_taken then
    raise exception 'sum of sorted sizes (%) exceeds p_qty_taken (%)',
      v_sum_sizes,
      v_qty_taken
      using errcode = '22023';
  end if;

  v_loss_qty := v_qty_taken - v_sum_sizes;

  perform app.assert_not_before_opening (v_check_items, v_check_times, v_check_types);

  v_batch_id := pg_catalog.gen_random_uuid();

  if app.batch_is_forward (v_check_items, v_check_times) then
    v_mixed_bal := app.lock_and_validate_item_balance (p_mixed_item, p_occurred_at);

    if v_mixed_bal.has_uncovered_deficit
    or v_mixed_bal.on_hand_qty <= 0
    or v_qty_taken > v_mixed_bal.on_hand_qty then
      raise exception 'not enough stock to sort: on_hand_qty %, requested %',
        v_mixed_bal.on_hand_qty,
        v_qty_taken
        using errcode = '22023';
    end if;

    if v_qty_taken = v_mixed_bal.on_hand_qty then
      v_value_taken := v_mixed_bal.on_hand_value;
    else
      v_value_taken := pg_catalog.round(
        v_mixed_bal.on_hand_value * v_qty_taken / v_mixed_bal.on_hand_qty,
        2
      );
    end if;

    v_remaining_value := v_value_taken;
    v_remaining_qty := v_qty_taken;

    if v_loss_qty > 0 then
      v_loss_value := pg_catalog.round(
        v_remaining_value * v_loss_qty / v_remaining_qty,
        2
      );

      if v_loss_value < 0 then
        v_loss_value := 0;
      elsif v_loss_value > v_remaining_value then
        v_loss_value := v_remaining_value;
      end if;

      v_remaining_value := v_remaining_value - v_loss_value;
      v_remaining_qty := v_remaining_qty - v_loss_qty;
    else
      v_loss_value := 0;
    end if;

    v_sort_out_value := v_remaining_value;

    perform app.apply_outflow_movement (
      v_batch_id,
      p_mixed_item,
      'sort_out',
      p_occurred_at,
      v_sum_sizes,
      p_shift_id,
      'sort',
      v_batch_id::text,
      null,
      -v_sort_out_value
    );

    if v_loss_qty > 0 then
      perform app.apply_outflow_movement (
        v_batch_id,
        p_mixed_item,
        'sort_loss',
        p_occurred_at,
        v_loss_qty,
        p_shift_id,
        'sort',
        v_batch_id::text,
        null,
        -v_loss_value
      );
    end if;

    for v_elem, v_ord in
      select
        elem.value,
        elem.ord
      from
        pg_catalog.jsonb_array_elements(p_sizes) with ordinality as elem (value, ord)
    loop
      v_size_id := (v_elem ->> 'item_id')::uuid;
      v_size_qty := pg_catalog.round((v_elem ->> 'quantity')::numeric, 6);

      if v_ord = v_num_sizes then
        v_size_value := v_remaining_value;
      else
        v_size_value := pg_catalog.round(
          v_remaining_value * v_size_qty / v_remaining_qty,
          2
        );

        if v_size_value < 0 then
          v_size_value := 0;
        elsif v_size_value > v_remaining_value then
          v_size_value := v_remaining_value;
        end if;
      end if;

      v_remaining_value := v_remaining_value - v_size_value;
      v_remaining_qty := v_remaining_qty - v_size_qty;
      v_size_unit_cost := pg_catalog.round(v_size_value / v_size_qty, 6);

      perform app.apply_inflow_movement (
        v_batch_id,
        v_size_id,
        'sort_in',
        p_occurred_at,
        v_size_qty,
        v_size_unit_cost,
        p_shift_id,
        'sort',
        v_batch_id::text,
        null,
        v_size_value
      );
    end loop;
  else
    if not pg_catalog.isfinite(p_occurred_at) then
      raise exception 'occurred_at must be a finite timestamp'
        using errcode = '22023';
    end if;

    v_key := v_key + 1;
    v_pending := v_pending || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'line_key',
        v_key,
        'batch_id',
        v_batch_id,
        'item_id',
        p_mixed_item,
        'movement_type',
        'sort_out',
        'occurred_at',
        p_occurred_at,
        'quantity',
        -v_sum_sizes,
        'unit_cost',
        0,
        'total_cost',
        0,
        'is_input_total',
        false,
        'shift_id',
        p_shift_id,
        'source_type',
        'sort',
        'source_id',
        v_batch_id::text,
        'note',
        null
      )
    );

    if v_loss_qty > 0 then
      v_key := v_key + 1;
      v_pending := v_pending || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_key',
          v_key,
          'batch_id',
          v_batch_id,
          'item_id',
          p_mixed_item,
          'movement_type',
          'sort_loss',
          'occurred_at',
          p_occurred_at,
          'quantity',
          -v_loss_qty,
          'unit_cost',
          0,
          'total_cost',
          0,
          'is_input_total',
          false,
          'shift_id',
          p_shift_id,
          'source_type',
          'sort',
          'source_id',
          v_batch_id::text,
          'note',
          null
        )
      );
    end if;

    for v_elem in
      select
        elem.value
      from
        pg_catalog.jsonb_array_elements(p_sizes) as elem (value)
    loop
      v_key := v_key + 1;
      v_size_id := (v_elem ->> 'item_id')::uuid;
      v_size_qty := pg_catalog.round((v_elem ->> 'quantity')::numeric, 6);
      v_pending := v_pending || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_key',
          v_key,
          'batch_id',
          v_batch_id,
          'item_id',
          v_size_id,
          'movement_type',
          'sort_in',
          'occurred_at',
          p_occurred_at,
          'quantity',
          v_size_qty,
          'unit_cost',
          0,
          'total_cost',
          0,
          'is_input_total',
          false,
          'shift_id',
          p_shift_id,
          'source_type',
          'sort',
          'source_id',
          v_batch_id::text,
          'note',
          null
        )
      );
    end loop;

    perform app.post_backdated_batch (v_batch_id, v_pending);
  end if;

  return v_batch_id;
end;
$$;

comment on function app.post_sort (uuid, timestamptz, numeric, jsonb, text) is 'Posts a mixed-fish sorting batch (sort_out, optional sort_loss, and sort_in per size).';

revoke all on function app.post_sort (uuid, timestamptz, numeric, jsonb, text)
from
  public,
  anon;

grant
execute on function app.post_sort (uuid, timestamptz, numeric, jsonb, text) to authenticated,
service_role;

-- cost_per_kg is the effective average of this sort: effective sort_out
-- value divided by sort_out quantity, rounded to 6. loss_value stays a
-- positive magnitude of the effective sort_loss total.
create or replace view app.sort_history
with
  (security_invoker = true) as
select
  batch.id,
  batch.mixed_item_id,
  item.name as mixed_item_name,
  coalesce(moved.occurred_at, batch.occurred_at) as occurred_at,
  batch.created_at,
  batch.note,
  coalesce(moved.qty_taken, 0::numeric(20, 6)) as qty_taken,
  coalesce(moved.sizes_qty, 0::numeric(20, 6)) as sizes_qty,
  coalesce(moved.loss_qty, 0::numeric(20, 6)) as loss_qty,
  coalesce(moved.loss_value, 0::numeric(14, 2)) as loss_value,
  moved.cost_per_kg
from
  app.sort_batches batch
  join app.stock_items item on item.id = batch.mixed_item_id
  join lateral (
    select
      min(sm.occurred_at) filter (
        where
          sm.movement_type = 'sort_out'
      ) as occurred_at,
      (
        - sum(sm.quantity) filter (
          where
            sm.movement_type in ('sort_out', 'sort_loss')
            and sm.item_id = batch.mixed_item_id
        )
      )::numeric(20, 6) as qty_taken,
      coalesce(
        sum(sm.quantity) filter (
          where
            sm.movement_type = 'sort_in'
        ),
        0
      )::numeric(20, 6) as sizes_qty,
      coalesce(
        - sum(sm.quantity) filter (
          where
            sm.movement_type = 'sort_loss'
        ),
        0
      )::numeric(20, 6) as loss_qty,
      coalesce(
        - sum(sm.total_cost + coalesce(adj.adj_total, 0)) filter (
          where
            sm.movement_type = 'sort_loss'
        ),
        0
      )::numeric(14, 2) as loss_value,
      (
        round(
          sum(sm.total_cost + coalesce(adj.adj_total, 0)) filter (
            where
              sm.movement_type = 'sort_out'
              and sm.item_id = batch.mixed_item_id
          ) / nullif(
            sum(sm.quantity) filter (
              where
                sm.movement_type = 'sort_out'
                and sm.item_id = batch.mixed_item_id
            ),
            0
          ),
          6
        )
      )::numeric(20, 6) as cost_per_kg
    from
      app.stock_movements sm
      left join lateral (
        select
          sum(ca.total_cost) as adj_total
        from
          app.stock_movements ca
        where
          ca.adjusts_movement_id = sm.id
          and ca.movement_type = 'cost_adjustment'
      ) adj on true
    where
      sm.batch_id = batch.id
      and sm.movement_type in ('sort_out', 'sort_in', 'sort_loss')
  ) as moved on true;

comment on view app.sort_history is 'One row per sort. security_invoker so RLS on sort_batches, stock_items, and stock_movements applies. loss_value and cost_per_kg use the effective total. cost_per_kg is the effective average of this sort.';

comment on column app.sort_history.cost_per_kg is 'Effective average of this sort: effective sort_out value divided by sort_out quantity, rounded to 6.';

revoke all on table app.sort_history
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.sort_history to authenticated,
  service_role;
