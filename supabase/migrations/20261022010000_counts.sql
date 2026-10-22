-- Daily (and later weekly) stock counts.
--
-- A count is one observation: the actual quantity of each item at counted_at.
-- id is the ledger batch id returned by app.post_movements when at least one
-- line has a non-zero delta. When every delta is zero, no movement is posted
-- and id is a new uuid. Lines with a zero delta store movement_id null.
--
-- Adjustment posted to the ledger is actual − expected (a positive
-- count_adjustment is a surplus inflow, a negative one is a shortage
-- outflow). expected is item_balances.on_hand_qty read under the row lock
-- from app.lock_and_validate_item_balance. Back-dated movements are refused,
-- so that locked quantity is the on-hand at counted_at. delta_qty and
-- delta_value on the line are copied from the posted count_adjustment.
-- Recompute of an earlier count is a later task; this function keeps the
-- ledger's 'back-dated movement not supported yet' refusal.
--
-- A count is an observation. After the batch post, still under the ledger
-- lock, last_occurred_at becomes counted_at for every counted item, including
-- a zero delta that posted no movement. A later movement before that
-- observation is refused. lock_and_validate_item_balance already inserts a
-- zero balance row when the item has never moved.
--
-- Shift rule: counted_at must not fall inside a closed shift, using the
-- half-open interval opened_at <= counted_at < closed_at, and must not be
-- at or after the open time of a shift that is still open (closed_at is
-- null and opened_at <= counted_at). A count exactly at a shift's close is
-- outside that shift. A count exactly at the next shift's open is inside it.
-- Times before an open shift's open are not refused by the open-shift rule.
--
-- Sync rule: pos_sync_runs.started_at is the database clock (now()).
-- counted_at, shift times, and sale times come from the owner's clock and
-- the POS devices' clocks, so those clocks can disagree. Window mode reads
-- orders before shifts, so a run can record a shift close and still have
-- missed an earlier sale. Coverage is the latest app.pos_sync_runs row with
-- status = 'ok', chosen by identity id (the newest successful attempt), not
-- by the greatest finished_at and not by a failed or running run. That row's
-- finished_at must be non-null, and its started_at must be >= counted_at
-- plus app.count_sync_margin() (10 minutes). A null finished_at, no ok run,
-- or a start earlier than counted_at plus that margin cannot prove the
-- mirror includes sales and shift closes up to the count. The count is
-- refused with 'sync has not covered this count time'.
--
-- Lock order matches record_sort. app.assert_ledger_write_allowed() is the
-- first statement. It checks the owner (or service_role) and takes advisory
-- lock 7342750000000000001 before the request_id replay and before
-- lock_and_validate_item_balance locks item_balances. Replay compares the
-- normalized payload only and returns before any catalog, shift, sync, or
-- balance read. stock_counts.request_id is unique as the last guard.
-- ============================================================================
-- 1. Append-only count documents
-- ============================================================================
create table app.stock_counts (
  -- Ledger batch id when a count_adjustment was posted; otherwise a new uuid.
  id uuid primary key,
  -- One id per draft. A lost reply retries this id; a new draft gets a new one.
  request_id uuid not null unique,
  frequency text not null,
  counted_at timestamptz not null,
  note text null,
  created_at timestamptz not null default now(),
  created_by uuid null default auth.uid (),
  constraint stock_counts_frequency_chk check (frequency in ('daily', 'weekly')),
  constraint stock_counts_counted_at_finite_chk check (pg_catalog.isfinite (counted_at)),
  constraint stock_counts_note_chk check (
    note is null
    or (
      char_length(note) between 1 and 500
      and note = btrim(note)
    )
  )
);

comment on table app.stock_counts is 'Append-only stock counts. id is the app.post_movements batch id when any line has a non-zero delta, and a new uuid when every delta is zero. Writes go through app.record_count. frequency is daily or weekly so a later weekly count can reuse this table.';

comment on column app.stock_counts.request_id is 'Idempotency key generated once per count draft. The same key and the same normalized payload return this count; a different payload is refused.';

comment on column app.stock_counts.counted_at is 'The instant the quantities were observed. Must sit outside every closed shift. The newest ok POS sync must have finished, and its started_at (database clock) must be at least app.count_sync_margin after this instant, because the owner and POS clocks can disagree and window sync reads orders before shifts.';

comment on column app.stock_counts.frequency is 'Which catalog this count belongs to: daily or weekly. The screen in this task records daily only.';

create index stock_counts_created_at_idx on app.stock_counts (created_at, id);

create index stock_counts_counted_at_idx on app.stock_counts (counted_at, created_at, id);

create table app.stock_count_lines (
  count_id uuid not null references app.stock_counts (id) on delete restrict,
  line_no integer not null,
  item_id uuid not null references app.stock_items (id) on delete restrict,
  counted_qty numeric(20, 6) not null,
  expected_qty numeric(20, 6) not null,
  delta_qty numeric(20, 6) not null,
  delta_value numeric(14, 2) not null,
  movement_id bigint null references app.stock_movements (id) on delete restrict,
  primary key (count_id, line_no),
  constraint stock_count_lines_item_key unique (count_id, item_id),
  constraint stock_count_lines_line_no_chk check (line_no > 0),
  constraint stock_count_lines_qty_chk check (
    counted_qty <> 'NaN'::numeric
    and counted_qty >= 0
    and expected_qty <> 'NaN'::numeric
    and delta_qty <> 'NaN'::numeric
    and delta_qty = counted_qty - expected_qty
    and delta_value <> 'NaN'::numeric
    and delta_value <> 'Infinity'::numeric
    and delta_value <> '-Infinity'::numeric
  ),
  constraint stock_count_lines_movement_chk check (
    (
      delta_qty = 0
      and movement_id is null
      and delta_value = 0
    )
    or (
      delta_qty <> 0
      and movement_id is not null
    )
  )
);

comment on table app.stock_count_lines is 'Append-only lines of a stock count, in payload order. delta_qty is actual minus expected. movement_id is null when the delta is zero.';

comment on column app.stock_count_lines.counted_qty is 'Quantity the owner observed, in the item base unit, scale 6.';

comment on column app.stock_count_lines.expected_qty is 'Ledger on-hand at counted_at, read under the balance lock before posting.';

comment on column app.stock_count_lines.delta_qty is 'Signed count_adjustment quantity: counted_qty - expected_qty. Positive is a surplus.';

comment on column app.stock_count_lines.delta_value is 'total_cost of that count_adjustment, to the piaster. Positive adds stock value. Zero when no movement was posted.';

comment on column app.stock_count_lines.movement_id is 'The count_adjustment row. Null when delta_qty is zero. Cost-adjustment rows posted in the same batch are not referenced here.';

create index stock_count_lines_item_id_idx on app.stock_count_lines (item_id);

create function app.prevent_count_mutation () returns trigger language plpgsql
set
  search_path = '' as $$
begin
  raise exception '%.% is append-only; % is not allowed', tg_table_schema, tg_table_name, tg_op
    using errcode = '55000';
end;
$$;

comment on function app.prevent_count_mutation () is 'Rejects update, delete, and truncate on stock count documents.';

revoke all on function app.prevent_count_mutation ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_stock_counts_no_update_delete
before update or delete on app.stock_counts for each row
execute function app.prevent_count_mutation ();

create trigger trg_stock_counts_no_truncate
before truncate on app.stock_counts for each statement
execute function app.prevent_count_mutation ();

create trigger trg_stock_count_lines_no_update_delete
before update or delete on app.stock_count_lines for each row
execute function app.prevent_count_mutation ();

create trigger trg_stock_count_lines_no_truncate
before truncate on app.stock_count_lines for each statement
execute function app.prevent_count_mutation ();

-- ============================================================================
-- 2. record_count
-- ============================================================================
-- One named margin. started_at uses the database clock. counted_at, shift
-- times, and sale times use the owner and POS clocks. Window mode reads
-- orders before shifts, so a run can store a later shift close and still
-- miss an earlier sale. Coverage needs started_at >= counted_at + this.
create function app.count_sync_margin () returns interval language sql immutable parallel safe
set
  search_path = '' as $$
  select
    interval '10 minutes';
$$;

comment on function app.count_sync_margin () is 'Ten minutes of skew for stock-count sync coverage. pos_sync_runs.started_at is the database clock. counted_at, shift times, and sale times are the owner and POS clocks. Window sync reads orders before shifts, so the newest ok run must have started at least this long after counted_at.';

revoke all on function app.count_sync_margin ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.record_count (p_count jsonb) returns uuid language plpgsql security definer
set
  search_path = '' as $$
declare
  v_request_text text;
  v_request_id uuid;
  v_frequency text;
  v_at_text text;
  v_counted_at timestamptz;
  v_note text;
  v_elem jsonb;
  v_item_text text;
  v_item_id uuid;
  v_qty_text text;
  v_raw numeric;
  v_whole text;
  v_qty numeric(20, 6);
  v_seen uuid[] := '{}'::uuid[];
  v_item_ids uuid[] := '{}'::uuid[];
  v_counted numeric(20, 6) [] := '{}'::numeric(20, 6) [];
  v_n integer := 0;
  v_existing_id uuid;
  v_existing_frequency text;
  v_existing_at timestamptz;
  v_existing_note text;
  v_sync_started timestamptz;
  v_sync_finished timestamptz;
  v_active boolean;
  v_item_frequency text;
  v_bal app.item_balances;
  v_expected numeric(20, 6) [] := '{}'::numeric(20, 6) [];
  v_deltas numeric(20, 6) [] := '{}'::numeric(20, 6) [];
  v_movements jsonb := '[]'::jsonb;
  v_count_id uuid;
  v_movement_id bigint;
  v_delta_qty numeric(20, 6);
  v_delta_value numeric(14, 2);
begin
  perform app.assert_ledger_write_allowed ();

  if p_count is null or pg_catalog.jsonb_typeof(p_count) <> 'object' then
    raise exception 'p_count must be a jsonb object'
      using errcode = '22023';
  end if;

  if p_count ? 'note'
  and pg_catalog.jsonb_typeof(p_count -> 'note') not in ('string', 'null') then
    raise exception 'note must be text'
      using errcode = '22023';
  end if;

  v_request_text := nullif(pg_catalog.btrim(p_count ->> 'request_id'), '');

  if v_request_text is null
  or v_request_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'request_id is required'
      using errcode = '22023';
  end if;

  v_request_id := v_request_text::uuid;

  if pg_catalog.jsonb_typeof(p_count -> 'frequency') is distinct from 'string' then
    raise exception 'frequency must be daily or weekly'
      using errcode = '22023';
  end if;

  v_frequency := pg_catalog.btrim(p_count ->> 'frequency');

  if v_frequency not in ('daily', 'weekly') then
    raise exception 'frequency must be daily or weekly'
      using errcode = '22023';
  end if;

  v_at_text := nullif(pg_catalog.btrim(p_count ->> 'counted_at'), '');

  if v_at_text is null then
    raise exception 'counted_at is required'
      using errcode = '22023';
  end if;

  begin
    v_counted_at := v_at_text::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception 'counted_at must be a finite timestamp'
        using errcode = '22023';
  end;

  if v_counted_at is null or not pg_catalog.isfinite(v_counted_at) then
    raise exception 'counted_at must be a finite timestamp'
      using errcode = '22023';
  end if;

  v_note := nullif(pg_catalog.btrim(p_count ->> 'note'), '');

  if v_note is not null and pg_catalog.char_length(v_note) > 500 then
    raise exception 'note must be at most 500 characters'
      using errcode = '22023';
  end if;

  perform app.assert_no_phone_text (v_note);

  if pg_catalog.jsonb_typeof(p_count -> 'lines') is distinct from 'array'
  or pg_catalog.jsonb_array_length(p_count -> 'lines') < 1
  or pg_catalog.jsonb_array_length(p_count -> 'lines') > 200 then
    raise exception 'lines must be a jsonb array of 1 to 200 lines'
      using errcode = '22023';
  end if;

  for v_elem in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_count -> 'lines') as e (value)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'object' then
      raise exception 'each count line must be a jsonb object'
        using errcode = '22023';
    end if;

    v_item_text := nullif(pg_catalog.btrim(v_elem ->> 'item_id'), '');
    v_qty_text := nullif(pg_catalog.btrim(v_elem ->> 'counted_qty'), '');

    if v_item_text is null or v_qty_text is null then
      raise exception 'item_id and counted_qty are required'
        using errcode = '22023';
    end if;

    if v_item_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'item_id must be a uuid'
        using errcode = '22023';
    end if;

    v_item_id := v_item_text::uuid;

    if v_item_id = any (v_seen) then
      raise exception 'duplicate item'
        using errcode = '22023';
    end if;

    if v_qty_text !~ '^\d+(\.\d+)?$' then
      raise exception 'counted_qty must be a finite number >= 0'
        using errcode = '22023';
    end if;

    if v_qty_text ~ '\.\d{7,}' then
      raise exception 'counted_qty must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    v_whole := pg_catalog.ltrim(pg_catalog.split_part(v_qty_text, '.', 1), '0');

    if v_whole = '' then
      v_whole := '0';
    end if;

    if pg_catalog.char_length(v_whole) > 14 then
      raise exception 'counted_qty is out of range'
        using errcode = '22023';
    end if;

    begin
      v_raw := v_qty_text::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'counted_qty must be a finite number >= 0'
          using errcode = '22023';
    end;

    if v_raw <> pg_catalog.round(v_raw, 6) then
      raise exception 'counted_qty must have at most 6 decimal places'
        using errcode = '22023';
    end if;

    if v_raw >= 100000000000000 then
      raise exception 'counted_qty is out of range'
        using errcode = '22023';
    end if;

    v_qty := v_raw;
    v_seen := v_seen || v_item_id;
    v_item_ids := v_item_ids || v_item_id;
    v_counted := v_counted || v_qty;
    v_n := v_n + 1;
  end loop;

  -- Replay compares the normalized payload only. No catalog, shift, sync,
  -- or balance read has happened yet.
  select
    counted.id,
    counted.frequency,
    counted.counted_at,
    counted.note
  into
    v_existing_id,
    v_existing_frequency,
    v_existing_at,
    v_existing_note
  from
    app.stock_counts counted
  where
    counted.request_id = v_request_id;

  if found then
    if v_existing_frequency is distinct from v_frequency
    or v_existing_at is distinct from v_counted_at
    or v_existing_note is distinct from v_note
    or (
      select
        count(*)
      from
        app.stock_count_lines line
      where
        line.count_id = v_existing_id
    ) is distinct from v_n::bigint
    or exists (
      select
        1
      from
        rows from (pg_catalog.unnest(v_item_ids), pg_catalog.unnest(v_counted)) with ordinality as u (item_id, counted_qty, line_no)
        join app.stock_count_lines line on line.count_id = v_existing_id
        and line.line_no = u.line_no
      where
        line.item_id is distinct from u.item_id
        or line.counted_qty is distinct from u.counted_qty
    ) then
      raise exception 'request_id already used for a different count'
        using errcode = '22023';
    end if;

    return v_existing_id;
  end if;

  if exists (
    select
      1
    from
      app.pos_shifts shift
    where
      shift.closed_at is not null
      and shift.opened_at <= v_counted_at
      and v_counted_at < shift.closed_at
  ) then
    raise exception 'count time is inside a shift'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      app.pos_shifts shift
    where
      shift.closed_at is null
      and shift.opened_at <= v_counted_at
  ) then
    raise exception 'a shift is still open'
      using errcode = '22023';
  end if;

  select
    run.started_at,
    run.finished_at
  into
    v_sync_started,
    v_sync_finished
  from
    app.pos_sync_runs run
  where
    run.status = 'ok'
  order by
    run.id desc
  limit
    1;

  -- Different clocks: started_at is the database clock, counted_at is not.
  -- Window mode reads orders before shifts, so the run must start at least
  -- app.count_sync_margin after the count. The error text stays stable.
  if v_sync_finished is null
  or v_sync_started < v_counted_at + app.count_sync_margin () then
    raise exception 'sync has not covered this count time'
      using errcode = '22023';
  end if;

  for v_i in 1..v_n loop
    select
      item.active,
      item.count_frequency
    into
      v_active,
      v_item_frequency
    from
      app.stock_items item
    where
      item.id = v_item_ids[v_i];

    if not found then
      raise exception 'unknown stock item'
        using errcode = '22023';
    end if;

    if v_active is not true then
      raise exception 'item is inactive'
        using errcode = '22023';
    end if;

    if v_item_frequency is distinct from v_frequency then
      raise exception 'item count frequency does not match'
        using errcode = '22023';
    end if;
  end loop;

  for v_i in 1..v_n loop
    v_bal := app.lock_and_validate_item_balance (v_item_ids[v_i], v_counted_at);
    v_expected := v_expected || v_bal.on_hand_qty;
    v_deltas := v_deltas || (v_counted[v_i] - v_bal.on_hand_qty);
  end loop;

  for v_i in 1..v_n loop
    if v_deltas[v_i] <> 0 then
      v_movements := v_movements || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'item_id',
          v_item_ids[v_i],
          'movement_type',
          'count_adjustment',
          'occurred_at',
          v_counted_at,
          'quantity',
          v_deltas[v_i]::text
        )
      );
    end if;
  end loop;

  if pg_catalog.jsonb_array_length(v_movements) > 0 then
    v_count_id := app.post_movements (v_movements);
  else
    v_count_id := pg_catalog.gen_random_uuid ();
  end if;

  insert into
    app.stock_counts (
      id,
      request_id,
      frequency,
      counted_at,
      note,
      created_by
    )
  values
    (
      v_count_id,
      v_request_id,
      v_frequency,
      v_counted_at,
      v_note,
      auth.uid ()
    );

  for v_i in 1..v_n loop
    if v_deltas[v_i] = 0 then
      insert into
        app.stock_count_lines (
          count_id,
          line_no,
          item_id,
          counted_qty,
          expected_qty,
          delta_qty,
          delta_value,
          movement_id
        )
      values
        (
          v_count_id,
          v_i,
          v_item_ids[v_i],
          v_counted[v_i],
          v_expected[v_i],
          0,
          0,
          null
        );
    else
      begin
        select
          movement.id,
          movement.quantity,
          movement.total_cost
        into strict
          v_movement_id,
          v_delta_qty,
          v_delta_value
        from
          app.stock_movements movement
        where
          movement.batch_id = v_count_id
          and movement.item_id = v_item_ids[v_i]
          and movement.movement_type = 'count_adjustment';
      exception
        when no_data_found or too_many_rows then
          raise exception 'count adjustment was not posted'
            using errcode = 'P0001';
      end;

      if v_delta_qty is distinct from v_deltas[v_i] then
        raise exception 'count delta does not match the posted movement'
          using errcode = 'P0001';
      end if;

      insert into
        app.stock_count_lines (
          count_id,
          line_no,
          item_id,
          counted_qty,
          expected_qty,
          delta_qty,
          delta_value,
          movement_id
        )
      values
        (
          v_count_id,
          v_i,
          v_item_ids[v_i],
          v_counted[v_i],
          v_expected[v_i],
          v_delta_qty,
          v_delta_value,
          v_movement_id
        );
    end if;
  end loop;

  -- A count is an observation at counted_at. Advance the balance watermark
  -- for every counted item, including a zero delta that posted no movement,
  -- so a later back-dated movement before this observation is refused.
  -- lock_and_validate_item_balance already inserted a zero balance row when
  -- the item had never moved.
  update app.item_balances as balance
  set
    last_occurred_at = greatest (
      coalesce(balance.last_occurred_at, v_counted_at),
      v_counted_at
    )
  where
    balance.item_id = any (v_item_ids);

  return v_count_id;
end;
$$;

comment on function app.record_count (jsonb) is 'Posts one stock count. Takes advisory lock 7342750000000000001 first, replays request_id before any catalog, shift, sync, or balance read, then refuses a time inside a closed shift (opened_at <= counted_at < closed_at), a time at or after an open shift''s open, or a time the newest ok pos_sync_runs row does not cover. That row, by id, must have a non-null finished_at and started_at >= counted_at plus app.count_sync_margin (10 minutes). started_at is the database clock, while counted_at, shift times, and sale times are the owner and POS clocks, and window sync reads orders before shifts. After the batch post, last_occurred_at moves to counted_at for every counted item, including a zero delta, because a count is an observation and a later back-dated movement before it is refused. Non-zero deltas are one count_adjustment batch: quantity is actual minus the locked on-hand. The same request_id and normalized payload returns the saved id and does not post again.';

revoke all on function app.record_count (jsonb)
from
  public,
  anon;

grant
execute on function app.record_count (jsonb) to authenticated,
service_role;

-- ============================================================================
-- 3. History. Shortage and surplus values are magnitudes from the stored
-- line deltas (themselves the posted movement totals). A surplus is any
-- positive delta, including one whose value is zero.
-- ============================================================================
create view app.stock_count_history
with
  (security_invoker = true) as
select
  counted.id,
  counted.counted_at,
  counted.frequency,
  counted.created_at,
  counted.note,
  count(line.item_id)::integer as item_count,
  coalesce(
    sum(- line.delta_value) filter (
      where
        line.delta_qty < 0
    ),
    0::numeric
  )::numeric(14, 2) as shortage_value,
  coalesce(
    sum(line.delta_value) filter (
      where
        line.delta_qty > 0
    ),
    0::numeric
  )::numeric(14, 2) as surplus_value,
  coalesce(bool_or(line.delta_qty > 0), false) as has_surplus
from
  app.stock_counts counted
  join app.stock_count_lines line on line.count_id = counted.id
group by
  counted.id;

comment on view app.stock_count_history is 'One row per count. security_invoker so RLS on stock_counts and stock_count_lines applies. shortage_value and surplus_value are positive piaster sums. has_surplus is true when any line''s actual quantity was above expected.';

revoke all on table app.stock_count_history
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.stock_count_history to authenticated,
  service_role;

-- ============================================================================
-- 4. Row-level security and grants
-- ============================================================================
alter table app.stock_counts enable row level security;

alter table app.stock_count_lines enable row level security;

create policy stock_counts_select_owner on app.stock_counts for
select
  to authenticated using (app.is_owner ());

create policy stock_count_lines_select_owner on app.stock_count_lines for
select
  to authenticated using (app.is_owner ());

revoke all on table app.stock_counts
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.stock_count_lines
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.stock_counts,
  app.stock_count_lines to authenticated,
  service_role;
