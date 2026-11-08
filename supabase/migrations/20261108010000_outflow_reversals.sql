-- Outflow reversals (phase 5, PR 1).
--
-- Sale and waste reversals are exact inverses of one target movement: same
-- item, instant, and shift column; opposite quantity; value equal to the
-- negative of the target's effective cents (stored total plus cost
-- adjustments present at reversal). Replay drops the neutralized pair, so a
-- reversal is not a valued inflow and cannot cover another deficit.
--
-- event_position / piece_position are nullable because stock_movements is
-- append-only and existing rows cannot be backfilled. Replay orders by
-- occurred_at, ordinary-before-count, coalesce(event_position, id),
-- coalesce(piece_position, 0), id. Null therefore keeps today's id order.
--
-- engine_valued marks rows posted by app.post_engine_outflows. Only those
-- rows use the provisional seed rule. Public post_movements and the other
-- existing writers leave the column null and keep today's silent zero.
-- Replay still reads the flag per row, so a later rebuild agrees with the
-- engine post. app.replay_component is the only replay seam the new posters
-- call; PR 2 replaces that function with anchor-aware replay.
-- ============================================================================
-- 0. Lock order. Same as the costing cutover: the ledger advisory lock is the
-- first statement, before any DDL, then the tables this migration changes are
-- locked in one fixed order. An owner base_unit update holds a stock_items
-- row lock and then waits for this advisory lock. Taking the table lock with
-- NOWAIT fails with 55P03 instead of waiting into that deadlock.
-- ============================================================================
select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

do $lock_tables$
begin
  lock table app.stock_items,
  app.stock_movements,
  app.units,
  ledger_scratch.recompute_bal,
  ledger_scratch.recompute_def,
  ledger_scratch.recompute_row in share row exclusive mode nowait;
end;
$lock_tables$;

-- ============================================================================
-- 1. Movement link, stable position, engine valuation flag
-- ============================================================================
alter table app.stock_movements
add column reverses_movement_id bigint null,
add column event_position bigint null,
add column piece_position integer null,
add column engine_valued boolean null;

alter table app.stock_movements
add constraint stock_movements_reverses_movement_id_fkey foreign key (reverses_movement_id) references app.stock_movements (id) on delete restrict,
add constraint stock_movements_reversal_link_chk check (
  (
    movement_type in ('sale_reversal', 'waste_reversal')
  ) = (reverses_movement_id is not null)
),
add constraint stock_movements_reversal_not_self_chk check (
  reverses_movement_id is null
  or reverses_movement_id <> id
);

create unique index stock_movements_one_reversal_idx on app.stock_movements (reverses_movement_id)
where
  reverses_movement_id is not null;

comment on column app.stock_movements.reverses_movement_id is 'Target movement of a sale_reversal or waste_reversal. Null on every other kind. At most one reversal per target.';

comment on column app.stock_movements.event_position is 'Stable logical position among events at the same instant. Null replays as the row id, which keeps existing id order.';

comment on column app.stock_movements.piece_position is 'Position of a split piece inside one logical event. Null replays as 0.';

comment on column app.stock_movements.engine_valued is 'True when an engine outflow should use the provisional-seed cost basis. Null and false keep the legacy silent zero.';

create function app.trg_stock_movements_reversal_shape () returns trigger language plpgsql security definer
set
  search_path = '' as $$
declare
  v_type app.movement_type;
  v_item uuid;
  v_at timestamptz;
  v_shift text;
  v_qty numeric(20, 6);
  v_total numeric(14, 2);
  v_reverses bigint;
  v_adj numeric(14, 2);
begin
  if (
    new.movement_type in ('sale_reversal', 'waste_reversal')
  ) is distinct from (new.reverses_movement_id is not null) then
    raise exception 'reversal link does not match the movement kind'
      using errcode = '22023';
  end if;

  if new.reverses_movement_id is null then
    return new;
  end if;

  select
    sm.movement_type,
    sm.item_id,
    sm.occurred_at,
    sm.shift_id,
    sm.quantity,
    sm.total_cost,
    sm.reverses_movement_id
  into
    v_type,
    v_item,
    v_at,
    v_shift,
    v_qty,
    v_total,
    v_reverses
  from
    app.stock_movements sm
  where
    sm.id = new.reverses_movement_id
  for share;

  if not found then
    raise exception 'unknown reversal target'
      using errcode = '22023';
  end if;

  if v_reverses is not null
  or v_type in ('sale_reversal', 'waste_reversal') then
    raise exception 'a reversal cannot target a reversal'
      using errcode = '22023';
  end if;

  if v_type = 'cost_adjustment' then
    raise exception 'a reversal cannot target a cost adjustment'
      using errcode = '22023';
  end if;

  if (
    new.movement_type = 'sale_reversal'
    and v_type is distinct from 'sale'::app.movement_type
  )
  or (
    new.movement_type = 'waste_reversal'
    and v_type is distinct from 'waste'::app.movement_type
  ) then
    raise exception 'reversal target kind is not allowed'
      using errcode = '22023';
  end if;

  if new.item_id is distinct from v_item then
    raise exception 'reversal item must match the target'
      using errcode = '22023';
  end if;

  if new.occurred_at is distinct from v_at then
    raise exception 'reversal occurred_at must match the target'
      using errcode = '22023';
  end if;

  if new.shift_id is distinct from v_shift then
    raise exception 'reversal shift must match the target'
      using errcode = '22023';
  end if;

  if new.quantity is distinct from -v_qty then
    raise exception 'reversal quantity must be the opposite of the target'
      using errcode = '22023';
  end if;

  select
    coalesce(sum(ca.total_cost), 0)
  into v_adj
  from
    app.stock_movements ca
  where
    ca.adjusts_movement_id = new.reverses_movement_id
    and ca.movement_type = 'cost_adjustment';

  if new.total_cost is distinct from -(v_total + v_adj) then
    raise exception 'reversal value must be the exact inverse of the target effective value'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

revoke all on function app.trg_stock_movements_reversal_shape ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_movements_reversal_shape
before insert on app.stock_movements for each row
execute function app.trg_stock_movements_reversal_shape ();

-- ============================================================================
-- 2. First-use provisional seed. Immutable. Replay reads the saved price,
-- never the current opening-price row.
-- ============================================================================
create table app.item_provisional_seeds (
  item_id uuid primary key references app.stock_items (id) on delete restrict,
  opening_price_id uuid not null,
  unit_cost numeric(20, 6) not null,
  base_unit text not null references app.units (code) on delete restrict,
  created_at timestamptz not null default pg_catalog.clock_timestamp (),
  constraint item_provisional_seeds_unit_cost_chk check (
    unit_cost <> 'NaN'::numeric
    and unit_cost <> 'Infinity'::numeric
    and unit_cost <> '-Infinity'::numeric
    and unit_cost >= 0
  )
);

comment on table app.item_provisional_seeds is 'Immutable first-use approved fallback price for an item with no valued ledger average. Replay uses unit_cost and opening_price_id stored here, not today''s opening-price row.';

comment on column app.item_provisional_seeds.opening_price_id is 'The item_opening_prices.id captured at first use. Stored as a plain uuid so TRUNCATE of opening prices still reaches that table''s append-only trigger.';

create trigger trg_item_provisional_seeds_no_update_delete
before update or delete on app.item_provisional_seeds for each row
execute function app.prevent_append_only_mutation ();

create trigger trg_item_provisional_seeds_no_truncate
before truncate on app.item_provisional_seeds for each statement
execute function app.prevent_append_only_mutation ();

alter table app.item_provisional_seeds enable row level security;

create policy item_provisional_seeds_select_owner on app.item_provisional_seeds for
select
  to authenticated using (
    (
      select
        app.is_owner ()
    )
  );

revoke all on table app.item_provisional_seeds
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.item_provisional_seeds to authenticated,
  service_role;

-- ============================================================================
-- 3. Internal helpers
-- ============================================================================
create function app.assert_ledger_lock_held () returns void language plpgsql volatile security definer
set
  search_path = '' as $$
begin
  -- One-key advisory lock: classid is the high 32 bits, objid the low 32, objsubid 1.
  if not exists (
    select
      1
    from
      pg_catalog.pg_locks held
    where
      held.locktype = 'advisory'
      and held.pid = pg_catalog.pg_backend_pid ()
      and held.granted
      and held.objsubid = 1
      and held.classid = (
        (7342750000000000001::bigint >> 32) & 4294967295::bigint
      )::oid
      and held.objid = (7342750000000000001::bigint & 4294967295::bigint)::oid
  ) then
    raise exception 'ledger lock is required'
      using errcode = '55000';
  end if;
end;
$$;

revoke all on function app.assert_ledger_lock_held ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.raise_recompute_failure (p_reason text) returns void language plpgsql volatile security definer
set
  search_path = '' as $$
begin
  if p_reason is distinct from 'recompute_limit' then
    p_reason := 'critical';
  end if;

  raise exception 'recompute result is out of range'
    using errcode = '22023',
    detail = p_reason;
end;
$$;

comment on function app.raise_recompute_failure (text) is 'Raises the historical recompute message. detail recompute_limit is the 100000-row cap. detail critical is a ledger invariant failure or a replay value outside the stored numeric range.';

revoke all on function app.raise_recompute_failure (text)
from
  public,
  anon,
  authenticated,
  service_role;

-- Range checks keep the historical message and carry detail critical.
create or replace function app.assert_recompute_range (
  p_value numeric,
  p_scale integer,
  p_allow_negative boolean
) returns numeric language plpgsql volatile security definer
set
  search_path = '' as $$
declare
  v_max numeric;
begin
  if p_value is null
  or p_value = 'NaN'::numeric
  or p_value = 'Infinity'::numeric
  or p_value = '-Infinity'::numeric
  or (
    not p_allow_negative
    and p_value < 0
  ) then
    perform app.raise_recompute_failure ('critical');
  end if;

  if p_scale = 2 then
    v_max := 999999999999.99;
  else
    v_max := 99999999999999.999999;
  end if;

  if p_value > v_max or p_value < -v_max then
    perform app.raise_recompute_failure ('critical');
  end if;

  return p_value;
end;
$$;

comment on function app.assert_recompute_range (numeric, integer, boolean) is 'Rejects null, non-finite, disallowed negative, and out-of-scale replay values. The refusal is recompute result is out of range with detail critical.';

revoke all on function app.assert_recompute_range (numeric, integer, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.ensure_provisional_seed (p_item_id uuid) returns numeric(20, 6) language plpgsql security definer
set
  search_path = '' as $$
declare
  v_cost numeric(20, 6);
  v_price_id uuid;
  v_base text;
  v_item_base text;
  v_price numeric(20, 6);
begin
  select
    seed.unit_cost
  into v_cost
  from
    app.item_provisional_seeds seed
  where
    seed.item_id = p_item_id;

  if found then
    return v_cost;
  end if;

  select
    price.id,
    price.unit_cost,
    price.base_unit,
    item.base_unit
  into
    v_price_id,
    v_price,
    v_base,
    v_item_base
  from
    app.item_opening_prices price
    join app.stock_items item on item.id = price.item_id
  where
    price.item_id = p_item_id
    and price.superseded_change_id is null;

  if not found then
    raise exception 'missing_cost_basis'
      using errcode = 'P0001',
      detail = 'missing_cost_basis';
  end if;

  if v_base is distinct from v_item_base then
    raise exception 'opening price base_unit must match the item base_unit'
      using errcode = '23514';
  end if;

  insert into
    app.item_provisional_seeds (item_id, opening_price_id, unit_cost, base_unit)
  values
    (p_item_id, v_price_id, v_price, v_base)
  on conflict (item_id) do nothing;

  select
    seed.unit_cost
  into v_cost
  from
    app.item_provisional_seeds seed
  where
    seed.item_id = p_item_id;

  if not found then
    raise exception 'missing_cost_basis'
      using errcode = 'P0001',
      detail = 'missing_cost_basis';
  end if;

  return v_cost;
end;
$$;

comment on function app.ensure_provisional_seed (uuid) is 'Returns the saved provisional seed, capturing the current approved opening price on first use. Later calls ignore today''s opening-price row.';

revoke all on function app.ensure_provisional_seed (uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create or replace function app.profit_bucket (p_type app.movement_type) returns text language sql immutable security definer
set
  search_path = '' as $$
  select
    case p_type
      when 'sale'::app.movement_type then 'cogs'
      when 'sale_reversal'::app.movement_type then 'cogs'
      when 'waste'::app.movement_type then 'waste'
      when 'waste_reversal'::app.movement_type then 'waste'
      when 'sort_loss'::app.movement_type then 'waste'
      when 'count_adjustment'::app.movement_type then 'count'
      when 'count_compensation'::app.movement_type then 'count'
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

-- ============================================================================
-- 4. Replay. Pairs are omitted. Engine rows use the seed rule. Ordering is
-- occurred_at, ordinary before count, logical position, piece, id.
-- ============================================================================
alter table ledger_scratch.recompute_bal
add column cost_known boolean not null default false;

alter table ledger_scratch.recompute_row
add column event_position bigint not null default 0,
add column piece_position integer not null default 0,
add column engine_valued boolean not null default false;

alter table ledger_scratch.recompute_def
add column ord_class integer not null default 0,
add column event_position bigint not null default 0,
add column piece_position integer not null default 0;

-- Forward covers use the same logical order as replay.
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

  -- Cover uncovered deficits in logical order: occurred_at, ordinary before count, event position, piece, id.
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
      end asc,
      coalesce(sm.event_position, sm.id) asc,
      coalesce(sm.piece_position, 0) asc,
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

comment on function app.apply_inflow_movement (
  uuid,
  uuid,
  app.movement_type,
  timestamptz,
  numeric,
  numeric,
  text,
  text,
  text,
  text,
  numeric
) is 'Posts one inflow and covers provisional deficits in logical event order. Same body as the backdated recompute definition except that cover order.';

create or replace function app.replay_outflow (
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
  v_known boolean;
  v_engine boolean;
  v_prov_unit numeric(20, 6);
  v_unit numeric(20, 6);
  v_normal_qty numeric(20, 6);
  v_prov_qty numeric(20, 6);
  v_normal_cost numeric(14, 2);
  v_prov_cost numeric(14, 2);
  v_base numeric(14, 2);
  v_piece integer := 0;
  v_syn bigint;
  v_ord integer;
  v_event bigint;
  v_row_piece integer;
begin
  select
    b.on_hand_qty,
    b.on_hand_value,
    b.avg_cost,
    b.cost_known
  into
    v_qty,
    v_value,
    v_avg,
    v_known
  from
    ledger_scratch.recompute_bal b
  where
    b.item_id = p_item_id;

  select
    coalesce(q.engine_valued, false),
    coalesce(q.ord_class, 0),
    q.event_position,
    coalesce(q.piece_position, 0)
  into
    v_engine,
    v_ord,
    v_event,
    v_row_piece
  from
    ledger_scratch.recompute_row q
  where
    q.movement_id = p_movement_id;

  v_known := coalesce(v_known, false);
  v_engine := coalesce(v_engine, false);
  v_ord := coalesce(v_ord, 0);
  v_event := coalesce(v_event, p_movement_id);
  v_row_piece := coalesce(v_row_piece, 0);
  v_unit := app.assert_recompute_range (v_avg, 6, false);
  v_prov_unit := v_unit;

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

    if v_prov_qty > 0
    and v_engine
    and not v_known then
      v_prov_unit := app.ensure_provisional_seed (p_item_id);
    end if;

    if v_prov_qty > 0 then
      v_prov_cost := -pg_catalog.round(v_prov_qty * v_prov_unit, 2);
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
          v_prov_unit,
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
          occurred_at,
          ord_class,
          event_position,
          piece_position
        )
      values
        (
          v_syn,
          p_item_id,
          v_prov_qty,
          v_prov_unit,
          abs(v_prov_cost),
          p_occurred_at,
          v_ord,
          v_event,
          v_piece
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
          occurred_at,
          ord_class,
          event_position,
          piece_position
        )
      values
        (
          p_movement_id,
          p_item_id,
          v_prov_qty,
          v_prov_unit,
          abs(v_prov_cost),
          p_occurred_at,
          v_ord,
          v_event,
          v_row_piece
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

create or replace function app.replay_inflow (
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
  v_known boolean;
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
    b.avg_cost,
    b.cost_known
  into
    v_pre_qty,
    v_pre_value,
    v_pre_avg,
    v_known
  from
    ledger_scratch.recompute_bal b
  where
    b.item_id = p_item_id;

  v_known := coalesce(v_known, false);

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
      d.ord_class asc,
      d.event_position asc,
      d.piece_position asc,
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

  if p_type in ('purchase', 'sort_in', 'opening') then
    v_known := true;
  end if;

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
    avg_cost = v_new_avg,
    cost_known = v_known
  where
    item_id = p_item_id;

  perform app.replay_touch_deficit_flag (p_item_id);
end;
$$;

create or replace function app.replay_execute (
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
      consumed,
      event_position,
      piece_position,
      engine_valued
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
    false,
    coalesce(sm.event_position, sm.id),
    coalesce(sm.piece_position, 0),
    coalesce(sm.engine_valued, false)
  from
    app.stock_movements sm
  where
    sm.item_id = any (p_item_ids)
    and sm.movement_type <> 'cost_adjustment'
    and sm.reverses_movement_id is null
    and sm.movement_type not in ('sale_reversal', 'waste_reversal')
    and not exists (
      select
        1
      from
        app.stock_movements rev
      where
        rev.reverses_movement_id = sm.id
    );

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
      consumed,
      event_position,
      piece_position,
      engine_valued
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
    false,
    coalesce(
      (elem.value ->> 'event_position')::bigint,
      v_base + (elem.value ->> 'line_key')::integer
    ),
    coalesce((elem.value ->> 'piece_position')::integer, 0),
    coalesce((elem.value ->> 'engine_valued')::boolean, false)
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
    perform app.raise_recompute_failure ('recompute_limit');
  end if;

  for r in
    select
      q.*
    from
      ledger_scratch.recompute_row q
    order by
      q.occurred_at asc,
      q.ord_class asc,
      q.event_position asc,
      q.piece_position asc,
      q.movement_id asc
  loop
    if r.movement_type in ('sale_reversal', 'waste_reversal') then
      continue;
    end if;

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
        perform app.raise_recompute_failure ('critical');
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
          q.event_position asc,
          q.piece_position asc,
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
          q.event_position asc,
          q.piece_position asc,
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
      perform app.raise_recompute_failure ('critical');
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
      app.stock_movements target
      join app.stock_movements rev on rev.reverses_movement_id = target.id
    where
      target.item_id = any (p_item_ids)
      and (
        target.quantity + rev.quantity <> 0
        or target.total_cost + rev.total_cost + coalesce(
          (
            select
              sum(ca.total_cost)
            from
              app.stock_movements ca
            where
              ca.movement_type = 'cost_adjustment'
              and ca.adjusts_movement_id in (target.id, rev.id)
          ),
          0
        ) <> 0
      )
  ) then
    perform app.raise_recompute_failure ('critical');
  end if;

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
    perform app.raise_recompute_failure ('critical');
  end if;
exception
  when numeric_value_out_of_range then
    perform app.raise_recompute_failure ('critical');
end;
$$;

-- ============================================================================
-- 5. Replay seam and the two private posters. Both require the caller to
-- already hold advisory lock 7342750000000000001. Neither takes it.
-- ============================================================================
create function app.replay_component (
  p_item_ids uuid[],
  p_pending jsonb,
  p_cause uuid,
  p_write boolean
) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_set uuid[];
begin
  perform app.assert_ledger_lock_held ();

  if p_cause is null then
    raise exception 'cause batch is required'
      using errcode = '22023';
  end if;

  -- SEAM: anchor-unaware replay. PR 2 replaces this function with anchor-aware
  -- replay. retire_movements and post_engine_outflows call only this function
  -- to replay. There is no frontier shortcut.
  lock table app.pos_shifts in share mode;

  v_set := app.recompute_item_set (p_item_ids);

  perform app.prepare_balance_locks (v_set);

  perform app.replay_execute (v_set, coalesce(p_pending, '[]'::jsonb), p_cause, p_write);
end;
$$;

comment on function app.replay_component (uuid[], jsonb, uuid, boolean) is 'Anchor-unaware replay seam. Caller holds the ledger lock. PR 2 replaces this body with anchor-aware replay.';

revoke all on function app.replay_component (uuid[], jsonb, uuid, boolean)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.retire_movements (p_movement_ids bigint[], p_cause uuid) returns bigint[] language plpgsql security definer
set
  search_path = '' as $$
declare
  v_id bigint;
  v_new bigint;
  v_ids bigint[] := '{}'::bigint[];
  v_items uuid[];
  v_item uuid;
  v_type app.movement_type;
  v_rev_type app.movement_type;
  v_qty numeric(20, 6);
  v_total numeric(14, 2);
  v_unit numeric(20, 6);
  v_adj numeric(14, 2);
  v_adj_unit numeric(20, 6);
  v_at timestamptz;
  v_shift text;
  v_prov boolean;
  v_event bigint;
  v_piece integer;
  v_rev_total numeric(14, 2);
  v_rev_unit numeric(20, 6);
  v_resolved text;
begin
  perform app.assert_ledger_lock_held ();

  if p_cause is null then
    raise exception 'cause batch is required'
      using errcode = '22023';
  end if;

  if p_movement_ids is null
  or coalesce(pg_catalog.array_length(p_movement_ids, 1), 0) = 0
  or exists (
    select
      1
    from
      pg_catalog.unnest (p_movement_ids) as listed (id)
    where
      listed.id is null
  ) then
    raise exception 'movement ids are required'
      using errcode = '22023';
  end if;

  if (
    select
      count(*)
    from
      pg_catalog.unnest (p_movement_ids) as listed (id)
  ) is distinct from (
    select
      count(distinct listed.id)
    from
      pg_catalog.unnest (p_movement_ids) as listed (id)
  ) then
    raise exception 'duplicate movement id'
      using errcode = '22023';
  end if;

  lock table app.pos_shifts in share mode;

  if (
    select
      count(*)
    from
      app.stock_movements sm
    where
      sm.id = any (p_movement_ids)
  ) is distinct from coalesce(pg_catalog.array_length(p_movement_ids, 1), 0) then
    raise exception 'unknown movement'
      using errcode = '22023';
  end if;

  select
    coalesce(
      pg_catalog.array_agg(
        distinct sm.item_id
        order by
          sm.item_id
      ),
      '{}'::uuid[]
    )
  into v_items
  from
    app.stock_movements sm
  where
    sm.id = any (p_movement_ids);

  perform app.prepare_balance_locks (app.recompute_item_set (v_items));

  for v_id in
    select
      sm.id
    from
      app.stock_movements sm
    where
      sm.id = any (p_movement_ids)
    order by
      sm.id
  loop
    select
      sm.item_id,
      sm.movement_type,
      sm.quantity,
      sm.total_cost,
      sm.unit_cost,
      sm.occurred_at,
      sm.shift_id,
      sm.is_provisional,
      sm.event_position,
      sm.piece_position
    into
      v_item,
      v_type,
      v_qty,
      v_total,
      v_unit,
      v_at,
      v_shift,
      v_prov,
      v_event,
      v_piece
    from
      app.stock_movements sm
    where
      sm.id = v_id
    for share;

    if v_type = 'sale' then
      v_rev_type := 'sale_reversal';
    elsif v_type = 'waste' then
      v_rev_type := 'waste_reversal';
    else
      raise exception 'only a sale or waste movement can be reversed'
        using errcode = '22023';
    end if;

    if exists (
      select
        1
      from
        app.stock_movements rev
      where
        rev.reverses_movement_id = v_id
    ) then
      raise exception 'movement is already reversed'
        using errcode = '22023';
    end if;

    select
      coalesce(sum(ca.total_cost), 0),
      coalesce(sum(ca.unit_cost), 0)
    into
      v_adj,
      v_adj_unit
    from
      app.stock_movements ca
    where
      ca.adjusts_movement_id = v_id
      and ca.movement_type = 'cost_adjustment';

    v_rev_total := app.assert_recompute_range (-(v_total + v_adj), 2, true);
    v_rev_unit := app.assert_recompute_range (v_unit + v_adj_unit, 6, true);

    -- Pin the target's shift attribution before copying it, so a later
    -- boundary change cannot give the reversal a different shift.
    if v_shift is null
    and not exists (
      select
        1
      from
        app.movement_attributions ma
      where
        ma.movement_id = v_id
    ) then
      perform app.shift_for_target (v_id);
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
        reverses_movement_id,
        event_position,
        piece_position,
        engine_valued
      )
    values
      (
        p_cause,
        v_item,
        v_rev_type,
        v_at,
        -v_qty,
        v_rev_unit,
        v_rev_total,
        v_prov,
        v_shift,
        'reversal',
        v_id::text,
        v_id,
        v_event,
        v_piece,
        false
      )
    returning
      id into v_new;

    insert into
      app.movement_attributions (movement_id, shift_id)
    select
      v_new,
      ma.shift_id
    from
      app.movement_attributions ma
    where
      ma.movement_id = v_id
      and not exists (
        select
          1
        from
          app.movement_attributions existing
        where
          existing.movement_id = v_new
      );

    v_resolved := app.shift_for_target (v_new);

    -- One revision for the reversal itself. Replay does not see the pair, so
    -- the generic adjustment loop does not note it again.
    perform app.note_period_revision (
      v_new,
      v_resolved,
      app.profit_bucket (v_rev_type),
      v_rev_total,
      v_item,
      p_cause
    );

    v_ids := v_ids || v_new;
  end loop;

  perform app.replay_component (v_items, '[]'::jsonb, p_cause, true);

  return v_ids;
end;
$$;

comment on function app.retire_movements (bigint[], uuid) is 'Appends one exact inverse per target, then replays the affected components through app.replay_component. Caller holds the ledger lock. Private.';

revoke all on function app.retire_movements (bigint[], uuid)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.post_engine_outflows (p_lines jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_batch uuid;
  v_elem jsonb;
  v_item uuid;
  v_type text;
  v_at timestamptz;
  v_qty numeric;
  v_shift text;
  v_source text;
  v_note text;
  v_event bigint;
  v_n integer := 0;
  v_items uuid[] := '{}'::uuid[];
  v_times timestamptz[] := '{}'::timestamptz[];
  v_types text[] := '{}'::text[];
  v_pending jsonb := '[]'::jsonb;
  v_line jsonb;
  v_posted record;
begin
  perform app.assert_ledger_lock_held ();

  lock table app.pos_shifts in share mode;

  if p_lines is null
  or pg_catalog.jsonb_typeof(p_lines) <> 'array'
  or pg_catalog.jsonb_array_length(p_lines) = 0 then
    raise exception 'p_lines must be a non-empty jsonb array'
      using errcode = '22023';
  end if;

  v_batch := pg_catalog.gen_random_uuid ();

  for v_elem in
    select
      elem.value
    from
      pg_catalog.jsonb_array_elements(p_lines) as elem (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each outflow line must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item := (v_elem ->> 'item_id')::uuid;
    v_type := v_elem ->> 'movement_type';
    v_at := (v_elem ->> 'occurred_at')::timestamptz;
    v_qty := (v_elem ->> 'quantity')::numeric;
    v_shift := v_elem ->> 'shift_id';
    v_source := v_elem ->> 'source_id';
    v_note := v_elem ->> 'note';

    if v_item is null
    or v_type is null
    or v_at is null
    or v_qty is null then
      raise exception 'item_id, movement_type, occurred_at, and quantity are required'
        using errcode = '22023';
    end if;

    if not pg_catalog.isfinite(v_at) then
      raise exception 'occurred_at must be a finite timestamp'
        using errcode = '22023';
    end if;

    if v_qty in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    or v_qty <= 0 then
      raise exception 'outflow quantity must be a finite number > 0'
        using errcode = '22023';
    end if;

    if v_type not in ('sale', 'waste') then
      raise exception 'engine outflow movement_type must be sale or waste'
        using errcode = '22023';
    end if;

    if not exists (
      select
        1
      from
        app.stock_items si
      where
        si.id = v_item
    ) then
      raise exception 'unknown stock_item id: %',
      v_item
        using errcode = '22023';
    end if;

    v_event := null;

    if v_elem ? 'event_position'
    and v_elem ->> 'event_position' is not null then
      v_event := (v_elem ->> 'event_position')::bigint;
    end if;

    v_n := v_n + 1;
    v_items := v_items || v_item;
    v_times := v_times || v_at;
    v_types := v_types || v_type;
    v_line := pg_catalog.jsonb_build_object(
      'line_key',
      v_n,
      'batch_id',
      v_batch,
      'item_id',
      v_item,
      'movement_type',
      v_type,
      'occurred_at',
      v_at,
      'quantity',
      -v_qty,
      'unit_cost',
      0,
      'total_cost',
      0,
      'is_input_total',
      false,
      'shift_id',
      v_shift,
      'source_type',
      'engine',
      'source_id',
      v_source,
      'note',
      v_note,
      'engine_valued',
      true,
      'piece_position',
      0
    );

    if v_event is not null then
      v_line := v_line || pg_catalog.jsonb_build_object('event_position', v_event);
    end if;

    v_pending := v_pending || pg_catalog.jsonb_build_array(v_line);
  end loop;

  -- Same helper and error text as post_backdated_batch, before either replay.
  -- A later opening must not cover a line dated before it.
  perform app.assert_not_before_opening (v_items, v_times, v_types);

  perform app.replay_component (v_items, v_pending, v_batch, false);

  for v_posted in
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
        note,
        engine_valued,
        event_position,
        piece_position
      )
    select
      v_batch,
      piece.item_id,
      piece.movement_type,
      piece.occurred_at,
      piece.quantity,
      piece.unit_cost,
      piece.total_cost,
      piece.is_provisional,
      piece.shift_id,
      piece.source_type,
      piece.source_id,
      piece.note,
      true,
      pending_row.event_position,
      piece.piece_no
    from
      ledger_scratch.recompute_piece piece
      join ledger_scratch.recompute_row pending_row on pending_row.line_key = piece.line_key
      and pending_row.is_pending
    order by
      piece.line_key,
      piece.piece_no
    returning
      id,
      item_id,
      movement_type,
      total_cost
  loop
    -- One revision for the posted piece. The confirming replay notes only a
    -- later valuation adjustment, whose source id is the adjustment row.
    perform app.note_period_revision (
      v_posted.id,
      app.shift_for_target (v_posted.id),
      app.profit_bucket (v_posted.movement_type),
      v_posted.total_cost,
      v_posted.item_id,
      v_batch
    );
  end loop;

  perform app.replay_component (v_items, '[]'::jsonb, v_batch, true);

  return v_batch;
end;
$$;

comment on function app.post_engine_outflows (jsonb) is 'Posts sale or waste lines with the engine provisional cost basis, valued by replay so a following replay inserts no adjustment. Notes each inserted piece once. Caller holds the ledger lock. Private. Public post_movements does not call this.';

revoke all on function app.post_engine_outflows (jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

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
  v_resolved_unit text;
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

    if v_type_text in (
      'sale_reversal',
      'waste_reversal',
      'count_compensation'
    ) then
      raise exception 'disallowed movement_type in post_movements: %',
      v_type_text
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
      v_resolved_unit := app.resolve_unit_code(v_unit);

      if v_resolved_unit is null then
        raise exception 'unknown unit "%" for item %', v_unit, v_item_id
          using errcode = '22023';
      end if;

      v_factor := app.item_factor_at(v_item_id, v_resolved_unit, v_occurred_at);
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

  for v_i in 1..v_n loop
    if not pg_catalog.isfinite(v_times[v_i]) then
      raise exception 'occurred_at must be a finite timestamp'
        using errcode = '22023';
    end if;
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

comment on function app.post_movements (jsonb) is 'Single server-side entry point to post opening, purchase, sale, waste, and count_adjustment movements. Unit text is a unit code or an alias, resolved at occurred_at. Always rejects sale_reversal, waste_reversal, and count_compensation.';
