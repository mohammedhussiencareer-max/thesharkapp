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
-- lock, last_occurred_at moves to one microsecond after counted_at for every
-- counted item, including a zero delta that posted no movement. The ledger
-- refuses only occurred_at < last_occurred_at, so a movement at exactly
-- counted_at would otherwise be accepted after the count. The extra
-- microsecond makes any later movement at or before the count back-dated.
-- lock_and_validate_item_balance already inserts a zero balance row when the
-- item has never moved. Replay of a posted count returns before this update.
--
-- Shift rule: counted_at must not fall inside a closed shift, using the
-- half-open interval opened_at <= counted_at < closed_at, and must not be
-- at or after the open time of a shift that is still open (closed_at is
-- null and opened_at <= counted_at). A count exactly at a shift's close is
-- outside that shift. A count exactly at the next shift's open is inside it.
-- Times before an open shift's open are not refused by the open-shift rule.
--
-- Prepare, then sync. The owner counts, then submits. prepared_at is the
-- database clock of that first submit, set inside record_count with
-- clock_timestamp(). A caller-supplied time is never trusted. The chain is
-- physical count, then submit (prepared_at), then a sync run start, then
-- that run's reads. A run that starts after the submit reads Firestore after
-- the physical count, because the owner only submits once the count is done.
--
-- Let C be the latest app.pos_shifts.close_recorded_at among all shifts with
-- opened_at <= counted_at (shifts can overlap, so the latest stamp, not the
-- latest-opened shift). The shift guards already make all of them closed
-- with closed_at <= counted_at. close_recorded_at is the database clock when
-- the mirror stored that close, and a caller cannot set it. The newest
-- app.pos_sync_runs row with status = 'ok', chosen by identity id, must have
-- finished_at not null, started_at > prepared_at, and started_at > C when
-- such a shift exists. Those three times are all the database clock.
-- started_at is not compared with counted_at.
-- Sale times and shift open and close times are POS-clock times. They are
-- compared with counted_at only to place a movement before or after the count.
--
-- The first submit stores app.stock_count_requests and returns
-- {"status":"waiting_for_sync"}. It does not raise, so the row commits. Until
-- a covering run exists, the same normalized payload returns waiting and
-- posts nothing. A covering run re-checks every guard against the fresh
-- mirror, posts, and returns {"status":"posted","count_id":"<uuid>"}. The
-- same payload after posting returns that id and does not post again. A
-- different payload for the same request_id is refused with
-- 'request_id already used for a different count'. A sale or shift still
-- missing is not silently lost. Its deduction is back-dated before the
-- count's watermark, so the ledger refuses it until the later
-- back-dated-recompute task re-derives the count.
--
-- Lock order matches record_sort. app.assert_ledger_write_allowed() is the
-- first statement. It checks the owner (or service_role) and takes advisory
-- lock 7342750000000000001 before the request_id replay and before
-- lock_and_validate_item_balance locks item_balances. Replay compares the
-- normalized payload only and returns before any catalog, shift, sync, or
-- balance read. counted_qty in that payload is numeric(20, 6) text, never a
-- JSON number: a 14-digit, 6-decimal number does not round-trip through
-- JavaScript. The prepare replay compares that normalized payload. The
-- posted replay compares the same quantity text. stock_counts.request_id
-- is unique as the last guard.
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

comment on column app.stock_counts.counted_at is 'The instant the quantities were observed, on the owner clock. Must sit outside every closed shift and before any open shift''s open. Sale and shift times are POS-clock and are compared with this instant only to place movements before or after the count. Coverage does not compare a sync start with this instant. The newest ok POS sync must have finished, must have started after the prepare submit (prepared_at), and must have started after the latest close_recorded_at of every shift opened at or before this instant. A late sale or shift is back-dated before this count''s watermark and the ledger refuses it until a later recompute.';

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

-- The first submit. payload is the normalized count, never the raw caller
-- jsonb. prepared_at is filled only by record_count from the database clock.
create table app.stock_count_requests (
  request_id uuid primary key,
  payload jsonb not null,
  prepared_at timestamptz not null,
  created_by uuid null,
  constraint stock_count_requests_prepared_at_chk check (pg_catalog.isfinite (prepared_at)),
  constraint stock_count_requests_payload_chk check (pg_catalog.jsonb_typeof (payload) = 'object')
);

comment on table app.stock_count_requests is 'Append-only prepare step for a stock count. The first record_count call stores the normalized payload and the database clock, then commits by returning waiting_for_sync. A later call with the same payload posts only after a sync run starts after prepared_at. Writes go through app.record_count.';

comment on column app.stock_count_requests.payload is 'Normalized count: request_id, frequency, counted_at, note, and lines in submit order. counted_qty is numeric(20, 6) text, never a JSON number, so a resend keeps every digit. Built inside record_count. A caller prepared_at is not stored.';

comment on column app.stock_count_requests.prepared_at is 'Database clock of the first submit, set with clock_timestamp() inside record_count. The owner submits only after the physical count, so this instant is after the count. A sync run that starts after it reads Firestore after the count. A caller value is never trusted.';

comment on column app.stock_count_requests.created_by is 'auth.uid() of the submitter. Null for service_role with no sub.';

create trigger trg_stock_count_requests_no_update_delete
before update or delete on app.stock_count_requests for each row
execute function app.prevent_count_mutation ();

create trigger trg_stock_count_requests_no_truncate
before truncate on app.stock_count_requests for each statement
execute function app.prevent_count_mutation ();

-- ============================================================================
-- 2. Database-clock stamp of a stored shift close
-- ============================================================================
-- close_recorded_at is the database clock when the mirror stored closed_at.
-- It is not the POS close time. Backfill closed rows before the trigger:
-- once the trigger exists, an update that does not change closed_at keeps
-- the old stamp and would leave a backfill unset.
alter table app.pos_shifts
add column close_recorded_at timestamptz null;

comment on column app.pos_shifts.close_recorded_at is 'Database clock when this row stored a non-null closed_at. Set by app.stamp_shift_close_recorded. A caller-supplied value is ignored. Null while the shift is open, and cleared when the shift is reopened. A later ok sync covers a count of this shift only when that run started after this stamp.';

update app.pos_shifts
set
  close_recorded_at = pg_catalog.clock_timestamp ()
where
  closed_at is not null;

create function app.stamp_shift_close_recorded () returns trigger language plpgsql security definer
set
  search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.closed_at is not null then
      new.close_recorded_at := pg_catalog.clock_timestamp();
    else
      new.close_recorded_at := null;
    end if;
  elsif new.closed_at is distinct from old.closed_at then
    if new.closed_at is not null then
      new.close_recorded_at := pg_catalog.clock_timestamp();
    else
      new.close_recorded_at := null;
    end if;
  else
    new.close_recorded_at := old.close_recorded_at;
  end if;

  return new;
end;
$$;

comment on function app.stamp_shift_close_recorded () is 'Stamps pos_shifts.close_recorded_at from the database clock when a shift close is stored. On insert, a non-null closed_at records clock_timestamp() and a null closed_at stores null. On update, a changed closed_at records clock_timestamp(), or null when the shift reopens. An unchanged closed_at keeps the previous stamp. Caller-supplied values are ignored.';

revoke all on function app.stamp_shift_close_recorded ()
from
  public,
  anon,
  authenticated,
  service_role;

create trigger trg_pos_shifts_close_recorded
before insert or update on app.pos_shifts for each row
execute function app.stamp_shift_close_recorded ();

alter table app.pos_shifts
add constraint pos_shifts_close_recorded_chk check (
  (closed_at is null) = (close_recorded_at is null)
  and (
    close_recorded_at is null
    or pg_catalog.isfinite (close_recorded_at)
  )
);

-- ============================================================================
-- 3. record_count
-- ============================================================================
create function app.record_count (p_count jsonb) returns jsonb language plpgsql security definer
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
  v_counted_text text[] := '{}'::text[];
  v_n integer := 0;
  v_existing_id uuid;
  v_existing_frequency text;
  v_existing_at timestamptz;
  v_existing_note text;
  v_lines jsonb;
  v_payload jsonb;
  v_stored_payload jsonb;
  v_prepared timestamptz;
  v_sync_started timestamptz;
  v_sync_finished timestamptz;
  v_close_recorded timestamptz;
  v_has_prior_shift boolean := false;
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
    -- Exact decimal text. A JSON number would lose digits in JavaScript.
    v_counted_text := v_counted_text || v_qty::text;
    v_n := v_n + 1;
  end loop;

  select
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'item_id',
        u.item_id,
        'counted_qty',
        u.counted_text
      )
      order by
        u.line_no
    )
  into v_lines
  from
    rows from (pg_catalog.unnest(v_item_ids), pg_catalog.unnest(v_counted_text)) with ordinality as u (item_id, counted_text, line_no);

  -- Built once from the normalized fields. counted_qty is numeric(20, 6)
  -- text, so the prepare replay and the posted replay compare one form.
  -- Key order stays stable, and a caller clock is not part of it.
  v_payload := pg_catalog.jsonb_build_object(
    'request_id',
    v_request_id,
    'frequency',
    v_frequency,
    'counted_at',
    v_counted_at,
    'note',
    v_note,
    'lines',
    v_lines
  );

  -- Replay compares the normalized payload only. No catalog, shift, sync,
  -- or balance read has happened yet. A posted replay returns before the
  -- watermark update.
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
        rows from (pg_catalog.unnest(v_item_ids), pg_catalog.unnest(v_counted_text)) with ordinality as u (item_id, counted_text, line_no)
        join app.stock_count_lines line on line.count_id = v_existing_id
        and line.line_no = u.line_no
      where
        line.item_id is distinct from u.item_id
        or line.counted_qty::text is distinct from u.counted_text
    ) then
      raise exception 'request_id already used for a different count'
        using errcode = '22023';
    end if;

    return pg_catalog.jsonb_build_object(
      'status',
      'posted',
      'count_id',
      v_existing_id
    );
  end if;

  select
    request.payload,
    request.prepared_at
  into
    v_stored_payload,
    v_prepared
  from
    app.stock_count_requests request
  where
    request.request_id = v_request_id;

  if not found then
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

    insert into app.stock_count_requests (
      request_id,
      payload,
      prepared_at,
      created_by
    )
    values
      (
        v_request_id,
        v_payload,
        pg_catalog.clock_timestamp(),
        auth.uid()
      );

    return pg_catalog.jsonb_build_object('status', 'waiting_for_sync');
  end if;

  if v_stored_payload is distinct from v_payload then
    raise exception 'request_id already used for a different count'
      using errcode = '22023';
  end if;

  -- Overlapping shifts are possible, so take the latest close stamp of every
  -- shift opened at or before the count, not the stamp of the latest-opened
  -- one. The run must start after that stamp and after this submit. Both
  -- comparisons use the database clock. counted_at is not one of them.
  select
    pg_catalog.max(shift.close_recorded_at),
    pg_catalog.count(*) > 0
  into
    v_close_recorded,
    v_has_prior_shift
  from
    app.pos_shifts shift
  where
    shift.opened_at <= v_counted_at;

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

  if v_sync_finished is null
  or v_sync_started is null
  or v_sync_started <= v_prepared
  or (
    v_has_prior_shift
    and (
      v_close_recorded is null
      or v_sync_started <= v_close_recorded
    )
  ) then
    return pg_catalog.jsonb_build_object('status', 'waiting_for_sync');
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

  -- A count is an observation at counted_at. The ledger refuses only
  -- occurred_at < last_occurred_at, so a movement at exactly counted_at
  -- would still pass. One microsecond past the count makes any later
  -- movement at or before counted_at back-dated. Replay returns before
  -- this update. A zero delta is included. lock_and_validate_item_balance
  -- already inserted a zero balance row when the item had never moved.
  update app.item_balances as balance
  set
    last_occurred_at = greatest (
      coalesce(balance.last_occurred_at, v_counted_at),
      v_counted_at + interval '1 microsecond'
    )
  where
    balance.item_id = any (v_item_ids);

  return pg_catalog.jsonb_build_object(
    'status',
    'posted',
    'count_id',
    v_count_id
  );
end;
$$;

comment on function app.record_count (jsonb) is 'Prepares, then posts, one stock count. Takes advisory lock 7342750000000000001 first, validates the payload, and replays request_id against stock_counts before any catalog, shift, sync, or balance read. The same normalized payload returns {"status":"posted","count_id":...} and does not post again. counted_qty is stored as numeric(20, 6) text, not a JSON number, and both the prepare replay and the posted replay compare that same text. A different payload raises 22023 request_id already used for a different count. The first submit stores stock_count_requests with prepared_at = clock_timestamp() and returns {"status":"waiting_for_sync"} without raising, after the shift and item guards. The owner submits only after the physical count, so prepared_at is after the count. A later call with the same payload waits until the newest ok pos_sync_runs row, by id, has finished_at not null, started_at > prepared_at, and started_at > the latest close_recorded_at among shifts with opened_at <= counted_at. Those times are all the database clock. started_at is not compared with counted_at. Sale and shift times are POS-clock and are compared with counted_at only to place movements before or after the count. When that run exists, every guard runs again on the fresh mirror, then non-zero deltas post as one count_adjustment batch (actual minus locked on-hand). After the post, last_occurred_at moves to counted_at plus one microsecond so a later movement at or before the count is back-dated. A sale still missing is refused by that watermark until a later recompute.';

revoke all on function app.record_count (jsonb)
from
  public,
  anon;

grant
execute on function app.record_count (jsonb) to authenticated,
service_role;

-- ============================================================================
-- 4. History. Shortage and surplus values are magnitudes from the stored
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

-- Requests that have not posted yet. The owner can resume them after a
-- reload. security_invoker so RLS on the two tables applies.
create view app.stock_count_pending
with
  (security_invoker = true) as
select
  request.request_id,
  request.prepared_at,
  request.payload,
  request.payload ->> 'counted_at' as counted_at,
  request.payload ->> 'frequency' as frequency,
  request.payload ->> 'note' as note,
  pg_catalog.jsonb_array_length (request.payload -> 'lines')::integer as item_count,
  request.created_by
from
  app.stock_count_requests request
where
  not exists (
    select
      1
    from
      app.stock_counts counted
    where
      counted.request_id = request.request_id
  );

comment on view app.stock_count_pending is 'One row per prepared count that has no stock_counts row yet. security_invoker so owner RLS on stock_count_requests and stock_counts applies. payload is the normalized body to send again. counted_qty in that payload is exact decimal text.';

revoke all on table app.stock_count_pending
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.stock_count_pending to authenticated,
  service_role;

-- ============================================================================
-- 5. Row-level security and grants
-- ============================================================================
alter table app.stock_counts enable row level security;

alter table app.stock_count_lines enable row level security;

alter table app.stock_count_requests enable row level security;

create policy stock_counts_select_owner on app.stock_counts for
select
  to authenticated using (app.is_owner ());

create policy stock_count_lines_select_owner on app.stock_count_lines for
select
  to authenticated using (app.is_owner ());

create policy stock_count_requests_select_owner on app.stock_count_requests for
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

revoke all on table app.stock_count_requests
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.stock_counts,
  app.stock_count_lines,
  app.stock_count_requests to authenticated,
  service_role;
