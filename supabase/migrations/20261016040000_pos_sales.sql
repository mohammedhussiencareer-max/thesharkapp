-- POS sales mirror. Read-only copy of accounting fields from Firestore.
-- No stock movements and no writes to ledger tables.
--
-- app.assert_ledger_write_allowed() is the right privilege rule (owner or
-- service_role) but it also takes the posting advisory lock. Sales ingest must
-- not take that lock: it does not post stock, and sharing the lock would block
-- sync behind inventory posts and the reverse. app.assert_pos_write_allowed()
-- repeats only the privilege check.
--
-- Orders are ingested in chunks. app.pos_sync_run_orders remembers every order
-- id presented to this run so the last chunk can mark missing rows inside the
-- completed read scope without treating earlier chunks as deleted in the POS.
-- The runner sends p_scope only on that last chunk, after every page was read.
-- scope_applied rejects a second scope for the same run.
-- One run is running at a time. A run older than 30 minutes is failed as
-- abandoned before the next start. A scope marks an order missing only when
-- that order's last_synced_at is earlier than the run's started_at, so a
-- later run's order is never marked missing by an older read.
create table app.pos_shifts (
  id text primary key check (length(btrim(id)) > 0),
  opened_at timestamptz not null check (isfinite(opened_at)),
  closed_at timestamptz null check (
    closed_at is null
    or isfinite(closed_at)
  ),
  is_active boolean not null,
  pos_update_time timestamptz not null check (isfinite(pos_update_time)),
  synced_at timestamptz not null default now() check (isfinite(synced_at))
);

comment on table app.pos_shifts is 'POS custody shifts copied for accounting. Drawer and cash fields are not stored.';

create table app.pos_orders (
  id text primary key check (length(btrim(id)) > 0),
  order_number int null,
  shift_id text not null check (length(btrim(shift_id)) > 0),
  status text not null check (status in ('complete', 'canceled', 'active')),
  order_type text null,
  payment_type text null,
  ordered_at timestamptz not null check (isfinite(ordered_at)),
  subtotal numeric(14, 2) not null,
  discount numeric(14, 2) not null,
  tax numeric(14, 2) not null,
  service_tax numeric(14, 2) not null,
  delivery_fee numeric(14, 2) not null,
  total numeric(14, 2) not null,
  financial_revision int null,
  last_financial_operation_key text null,
  pos_update_time timestamptz not null check (isfinite(pos_update_time)),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  version int not null default 1 check (version >= 1),
  missing_from_pos boolean not null default false,
  first_synced_at timestamptz not null default now() check (isfinite(first_synced_at)),
  last_synced_at timestamptz not null default now() check (isfinite(last_synced_at)),
  constraint pos_orders_money_finite_chk check (
    subtotal not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and discount not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and tax not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and service_tax not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and delivery_fee not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and total not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  )
);

comment on table app.pos_orders is 'POS orders copied for accounting. No customer, employee, phone, or address fields. missing_from_pos means the order disappeared from a completed POS read and is treated as a cancellation.';

comment on column app.pos_orders.missing_from_pos is 'True when a completed read of this order''s scope did not include the order. The row is kept; stock is not posted here.';

create index pos_orders_shift_id_idx on app.pos_orders (shift_id);

create index pos_orders_ordered_at_idx on app.pos_orders (ordered_at);

create table app.pos_order_lines (
  order_id text not null references app.pos_orders (id) on delete cascade,
  line_id text not null check (length(btrim(line_id)) > 0),
  item_id text not null check (length(btrim(item_id)) > 0),
  item_name text null,
  size_name text null,
  quantity numeric(20, 6) not null,
  weighted_qty numeric(20, 6) null,
  weighted_unit text null,
  unit_price numeric(14, 2) null,
  price_per_kg numeric(14, 2) null,
  options jsonb not null default '[]'::jsonb,
  line_total numeric(14, 2) not null,
  primary key (order_id, line_id),
  constraint pos_order_lines_qty_chk check (
    quantity not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
    and quantity >= 0
    and (
      weighted_qty is null
      or (
        weighted_qty not in (
          'NaN'::numeric,
          'Infinity'::numeric,
          '-Infinity'::numeric
        )
        and weighted_qty > 0
      )
    )
  ),
  constraint pos_order_lines_money_finite_chk check (
    (
      unit_price is null
      or unit_price not in (
        'NaN'::numeric,
        'Infinity'::numeric,
        '-Infinity'::numeric
      )
    )
    and (
      price_per_kg is null
      or price_per_kg not in (
        'NaN'::numeric,
        'Infinity'::numeric,
        '-Infinity'::numeric
      )
    )
    and line_total not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  ),
  constraint pos_order_lines_options_chk check (jsonb_typeof(options) = 'array')
);

comment on table app.pos_order_lines is 'Accounting fields for one POS order line. Weighted line_total is the POS price rounded to the piaster. Fixed line_total is round(price × quantity, 2).';

create table app.pos_sync_runs (
  id bigint generated always as identity primary key,
  mode text not null check (mode in ('recent', 'window35', 'full')),
  started_at timestamptz not null default now() check (isfinite(started_at)),
  finished_at timestamptz null check (
    finished_at is null
    or isfinite(finished_at)
  ),
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  counts jsonb null,
  error text null,
  scope_applied boolean not null default false
);

comment on table app.pos_sync_runs is 'One local POS sync attempt. error is a short message and must not contain document contents.';

comment on column app.pos_sync_runs.scope_applied is 'True after this run has applied missing-order marking for a completed read. A second scope is rejected.';

-- Every running row stores the same status, so this index admits only one.
create unique index pos_sync_runs_one_running_idx on app.pos_sync_runs (status)
where
  status = 'running';

comment on index app.pos_sync_runs_one_running_idx is 'At most one POS sync run may have status running.';

create table app.pos_sync_run_orders (
  run_id bigint not null references app.pos_sync_runs (id) on delete cascade,
  order_id text not null,
  primary key (run_id, order_id)
);

comment on table app.pos_sync_run_orders is 'Order ids presented to a running sync. Internal. Removed when the run finishes. Not a copy of POS documents.';

create function app.pos_money (p_value numeric) returns numeric(14, 2) language plpgsql immutable
set
  search_path = '' as $$
begin
  if p_value is null
  or p_value in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'money must be a finite number'
      using errcode = '22023';
  end if;

  return pg_catalog.round(p_value, 2);
end;
$$;

revoke all on function app.pos_money (numeric)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.pos_qty (p_value numeric) returns numeric(20, 6) language plpgsql immutable
set
  search_path = '' as $$
begin
  if p_value is null
  or p_value in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  or p_value < 0 then
    raise exception 'quantity must be a finite number >= 0'
      using errcode = '22023';
  end if;

  return pg_catalog.round(p_value, 6);
end;
$$;

revoke all on function app.pos_qty (numeric)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.assert_pos_write_allowed () returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_is_owner boolean;
  v_db_role text;
  v_jwt_role text;
begin
  -- Privilege rule matches app.assert_ledger_write_allowed. The ledger helper
  -- also takes the posting advisory lock; this one deliberately does not.
  v_is_owner := coalesce(app.is_owner (), false);
  v_db_role := coalesce(nullif(pg_catalog.current_setting('role', true), ''), '');
  v_jwt_role := coalesce(
    (
      select
        nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    ),
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    ''
  );

  if not coalesce(
    v_is_owner is true
    or v_db_role = 'service_role'
    or v_jwt_role = 'service_role',
    false
  ) then
    raise exception 'insufficient_privilege'
      using errcode = '42501';
  end if;
end;
$$;

comment on function app.assert_pos_write_allowed () is 'Allows the owner or service_role to write POS sales rows. Does not take the ledger posting lock.';

revoke all on function app.assert_pos_write_allowed ()
from
  public,
  anon,
  authenticated,
  service_role;

create function app.replace_pos_order_lines (p_order_id text, p_lines jsonb) returns void language plpgsql security definer
set
  search_path = '' as $$
declare
  v_line jsonb;
  v_raw_price numeric;
  v_raw_qty numeric;
  v_raw_weighted numeric;
  v_weighted numeric(20, 6);
  v_quantity numeric(20, 6);
  v_unit_price numeric(14, 2);
  v_price_per_kg numeric(14, 2);
  v_line_total numeric(14, 2);
  v_options jsonb;
  v_line_id text;
  v_item_id text;
begin
  perform app.assert_pos_write_allowed ();

  if p_order_id is null or length(pg_catalog.btrim(p_order_id)) = 0 then
    raise exception 'order id is required'
      using errcode = '22023';
  end if;

  if p_lines is null or pg_catalog.jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines must be a jsonb array'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_lines) as e (value)
    group by
      e.value ->> 'line_id'
    having
      pg_catalog.count(*) > 1
  ) then
    raise exception 'duplicate line id'
      using errcode = '22023';
  end if;

  delete from app.pos_order_lines
  where
    order_id = p_order_id;

  for v_line in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_lines) as e (value)
  loop
    if pg_catalog.jsonb_typeof(v_line) <> 'object' then
      raise exception 'each line must be a jsonb object'
        using errcode = '22023';
    end if;

    v_line_id := v_line ->> 'line_id';
    v_item_id := v_line ->> 'item_id';

    if v_line_id is null or length(pg_catalog.btrim(v_line_id)) = 0 then
      raise exception 'line_id is required'
        using errcode = '22023';
    end if;

    if v_item_id is null or length(pg_catalog.btrim(v_item_id)) = 0 then
      raise exception 'item_id is required'
        using errcode = '22023';
    end if;

    if v_line -> 'unit_price' is null
    or v_line -> 'unit_price' = 'null'::jsonb
    or v_line -> 'quantity' is null
    or v_line -> 'quantity' = 'null'::jsonb then
      raise exception 'unit_price and quantity are required'
        using errcode = '22023';
    end if;

    v_raw_price := (v_line ->> 'unit_price')::numeric;
    v_raw_qty := (v_line ->> 'quantity')::numeric;
    v_unit_price := app.pos_money (v_raw_price);
    v_quantity := app.pos_qty (v_raw_qty);

    if v_line -> 'weighted_qty' is null
    or v_line -> 'weighted_qty' = 'null'::jsonb then
      v_raw_weighted := null;
      v_weighted := null;
      -- Fixed lines: round(raw price × raw quantity, 2), not the rounded unit price.
      v_line_total := app.pos_money (v_raw_price * v_raw_qty);
    else
      v_raw_weighted := (v_line ->> 'weighted_qty')::numeric;
      v_weighted := app.pos_qty (v_raw_weighted);

      if v_weighted <= 0 then
        raise exception 'weighted quantity must be > 0'
          using errcode = '22023';
      end if;

      -- Weighted lines: the POS price is already the line total.
      v_line_total := v_unit_price;
    end if;

    if v_line -> 'price_per_kg' is null
    or v_line -> 'price_per_kg' = 'null'::jsonb then
      v_price_per_kg := null;
    else
      v_price_per_kg := app.pos_money ((v_line ->> 'price_per_kg')::numeric);
    end if;

    if v_line -> 'options' is null or v_line -> 'options' = 'null'::jsonb then
      v_options := '[]'::jsonb;
    elsif pg_catalog.jsonb_typeof(v_line -> 'options') <> 'array' then
      raise exception 'options must be a jsonb array'
        using errcode = '22023';
    else
      select
        coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'value',
              opt.value,
              'price',
              opt.price,
              'pricingType',
              opt.pricing_type,
              'pricingBaseQuantity',
              opt.base_qty
            )
            order by
              opt.ord
          ),
          '[]'::jsonb
        )
      into v_options
      from
        (
          select
            e.ord,
            nullif(pg_catalog.btrim(e.value ->> 'value'), '') as value,
            case
              when e.value -> 'price' is null
              or e.value -> 'price' = 'null'::jsonb then null
              else app.pos_money ((e.value ->> 'price')::numeric)
            end as price,
            nullif(pg_catalog.btrim(e.value ->> 'pricingType'), '') as pricing_type,
            case
              when e.value -> 'pricingBaseQuantity' is null
              or e.value -> 'pricingBaseQuantity' = 'null'::jsonb then null
              else app.pos_qty ((e.value ->> 'pricingBaseQuantity')::numeric)
            end as base_qty
          from
            pg_catalog.jsonb_array_elements(v_line -> 'options') with ordinality as e (value, ord)
        ) as opt;
    end if;

    insert into
      app.pos_order_lines (
        order_id,
        line_id,
        item_id,
        item_name,
        size_name,
        quantity,
        weighted_qty,
        weighted_unit,
        unit_price,
        price_per_kg,
        options,
        line_total
      )
    values
      (
        p_order_id,
        v_line_id,
        v_item_id,
        nullif(pg_catalog.btrim(v_line ->> 'item_name'), ''),
        nullif(pg_catalog.btrim(v_line ->> 'size_name'), ''),
        v_quantity,
        v_weighted,
        case
          when v_weighted is null then null
          else nullif(pg_catalog.btrim(v_line ->> 'weighted_unit'), '')
        end,
        v_unit_price,
        v_price_per_kg,
        v_options,
        v_line_total
      );
  end loop;
end;
$$;

comment on function app.replace_pos_order_lines (text, jsonb) is 'Replaces every line of one POS order. Drops any key other than the accounting whitelist on each option.';

revoke all on function app.replace_pos_order_lines (text, jsonb)
from
  public,
  anon,
  authenticated,
  service_role;

create function app.start_pos_sync_run (p_mode text) returns bigint language plpgsql security definer
set
  search_path = '' as $$
declare
  v_id bigint;
begin
  perform app.assert_pos_write_allowed ();

  -- Not the ledger posting lock. Holds starters in one line so the abandon
  -- and the single running row cannot race. The partial unique index is the
  -- backstop if a row is inserted outside this function.
  perform pg_catalog.pg_advisory_xact_lock(8742130000000000002);

  with
    abandoned as (
      update app.pos_sync_runs
      set
        status = 'failed',
        finished_at = pg_catalog.now(),
        error = 'abandoned'
      where
        status = 'running'
        and started_at < pg_catalog.now() - interval '30 minutes'
      returning
        id
    )
  delete from app.pos_sync_run_orders
  where
    run_id in (
      select
        id
      from
        abandoned
    );

  if exists (
    select
      1
    from
      app.pos_sync_runs
    where
      status = 'running'
  ) then
    raise exception 'another POS sync is running'
      using errcode = '55P03';
  end if;

  begin
    insert into
      app.pos_sync_runs (mode, status)
    values
      (p_mode, 'running')
    returning
      id into v_id;
  exception
    when unique_violation then
      raise exception 'another POS sync is running'
        using errcode = '55P03';
  end;

  return v_id;
end;
$$;

comment on function app.start_pos_sync_run (text) is 'Opens a POS sync run. Refuses while another run is running. A run older than 30 minutes is marked failed with error abandoned first. mode is recent, window35, or full.';

revoke all on function app.start_pos_sync_run (text)
from
  public,
  anon;

grant
execute on function app.start_pos_sync_run (text) to authenticated,
service_role;

create function app.finish_pos_sync_run (
  p_run_id bigint,
  p_status text,
  p_counts jsonb,
  p_error text
) returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  perform app.assert_pos_write_allowed ();

  if p_status is null or p_status not in ('ok', 'failed') then
    raise exception 'finish status must be ok or failed'
      using errcode = '22023';
  end if;

  if p_counts is not null and pg_catalog.jsonb_typeof(p_counts) <> 'object' then
    raise exception 'counts must be a jsonb object'
      using errcode = '22023';
  end if;

  update app.pos_sync_runs
  set
    status = p_status,
    finished_at = pg_catalog.now(),
    counts = p_counts,
    error = nullif(pg_catalog.left(coalesce(p_error, ''), 500), '')
  where
    id = p_run_id
    and status = 'running';

  if not found then
    raise exception 'pos_sync_run is not running'
      using errcode = '22023';
  end if;

  delete from app.pos_sync_run_orders
  where
    run_id = p_run_id;
end;
$$;

comment on function app.finish_pos_sync_run (bigint, text, jsonb, text) is 'Closes a POS sync run and drops the temporary seen-order ids. error is truncated to 500 characters.';

revoke all on function app.finish_pos_sync_run (bigint, text, jsonb, text)
from
  public,
  anon;

grant
execute on function app.finish_pos_sync_run (bigint, text, jsonb, text) to authenticated,
service_role;

create function app.ingest_pos_batch (
  p_run_id bigint,
  p_shifts jsonb,
  p_orders jsonb,
  p_scope jsonb
) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_status text;
  v_mode text;
  v_scope_applied boolean;
  v_started_at timestamptz;
  v_scope_key text;
  v_key_count int;
  v_from timestamptz;
  v_shift jsonb;
  v_order jsonb;
  v_lines jsonb;
  v_shift_wrote int;
  v_existing app.pos_orders;
  v_conflict boolean;
  v_missing_id text;
  v_order_id text;
  v_shift_id text;
  v_status_order text;
  v_ordered_at timestamptz;
  v_update_time timestamptz;
  v_hash text;
  v_attempts int;
  v_inserted int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  v_stale int := 0;
  v_missing int := 0;
  v_shifts_upserted int := 0;
  v_shifts_skipped int := 0;
begin
  perform app.assert_pos_write_allowed ();

  if p_run_id is null then
    raise exception 'p_run_id is required'
      using errcode = '22023';
  end if;

  if p_shifts is null or pg_catalog.jsonb_typeof(p_shifts) <> 'array' then
    raise exception 'p_shifts must be a jsonb array'
      using errcode = '22023';
  end if;

  if p_orders is null or pg_catalog.jsonb_typeof(p_orders) <> 'array' then
    raise exception 'p_orders must be a jsonb array'
      using errcode = '22023';
  end if;

  select
    r.status,
    r.mode,
    r.scope_applied,
    r.started_at
  into
    v_status,
    v_mode,
    v_scope_applied,
    v_started_at
  from
    app.pos_sync_runs r
  where
    r.id = p_run_id
  for update;

  if not found then
    raise exception 'unknown pos_sync_run id'
      using errcode = '22023';
  end if;

  if v_status <> 'running' then
    raise exception 'pos_sync_run is not running'
      using errcode = '22023';
  end if;

  v_scope_key := null;
  v_from := null;

  if p_scope is not null then
    if pg_catalog.jsonb_typeof(p_scope) <> 'object' then
      raise exception 'p_scope must be a jsonb object or null'
        using errcode = '22023';
    end if;

    if v_scope_applied then
      raise exception 'scope already applied for this run'
        using errcode = '22023';
    end if;

    select
      pg_catalog.count(*)
    into v_key_count
    from
      pg_catalog.jsonb_object_keys(p_scope) as k;

    if v_key_count <> 1 then
      raise exception 'p_scope must contain exactly one of shift_ids, from, or all'
        using errcode = '22023';
    end if;

    select
      k.key
    into v_scope_key
    from
      pg_catalog.jsonb_object_keys(p_scope) as k (key);

    if v_scope_key = 'shift_ids' then
      if pg_catalog.jsonb_typeof(p_scope -> 'shift_ids') <> 'array' then
        raise exception 'shift_ids must be a jsonb array'
          using errcode = '22023';
      end if;

      if exists (
        select
          1
        from
          pg_catalog.jsonb_array_elements(p_scope -> 'shift_ids') as e (value)
        where
          pg_catalog.jsonb_typeof(e.value) <> 'string'
          or coalesce(length(pg_catalog.btrim(e.value #>> '{}')), 0) = 0
      ) then
        raise exception 'shift_ids must be non-empty strings'
          using errcode = '22023';
      end if;
    elsif v_scope_key = 'from' then
      v_from := (p_scope ->> 'from')::timestamptz;

      if v_from is null or not pg_catalog.isfinite(v_from) then
        raise exception 'scope from must be a finite timestamp'
          using errcode = '22023';
      end if;
    elsif v_scope_key = 'all' then
      if p_scope -> 'all' is distinct from 'true'::jsonb then
        raise exception 'scope all must be true'
          using errcode = '22023';
      end if;
    else
      raise exception 'p_scope must contain exactly one of shift_ids, from, or all'
        using errcode = '22023';
    end if;

    if (
      v_mode = 'recent'
      and v_scope_key is distinct from 'shift_ids'
    )
    or (
      v_mode = 'window35'
      and v_scope_key is distinct from 'from'
    )
    or (
      v_mode = 'full'
      and v_scope_key is distinct from 'all'
    ) then
      raise exception 'p_scope does not match the sync run mode'
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_shifts) as e (value)
    where
      coalesce(e.value ->> 'id', '') = ''
  ) then
    raise exception 'shift id is required'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_shifts) as e (value)
    group by
      e.value ->> 'id'
    having
      pg_catalog.count(*) > 1
  ) then
    raise exception 'duplicate shift id in batch'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_orders) as e (value)
    where
      coalesce(e.value ->> 'id', '') = ''
  ) then
    raise exception 'order id is required'
      using errcode = '22023';
  end if;

  if exists (
    select
      1
    from
      pg_catalog.jsonb_array_elements(p_orders) as e (value)
    group by
      e.value ->> 'id'
    having
      pg_catalog.count(*) > 1
  ) then
    raise exception 'duplicate order id in batch'
      using errcode = '22023';
  end if;

  for v_shift in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_shifts) as e (value)
    order by
      e.value ->> 'id'
  loop
    if pg_catalog.jsonb_typeof(v_shift) <> 'object' then
      raise exception 'each shift must be a jsonb object'
        using errcode = '22023';
    end if;

    if pg_catalog.jsonb_typeof(v_shift -> 'is_active') is distinct from 'boolean' then
      raise exception 'is_active must be a boolean'
        using errcode = '22023';
    end if;

    if (v_shift ->> 'opened_at')::timestamptz is null
    or not pg_catalog.isfinite((v_shift ->> 'opened_at')::timestamptz) then
      raise exception 'opened_at must be a finite timestamp'
        using errcode = '22023';
    end if;

    if v_shift -> 'closed_at' is not null
    and v_shift -> 'closed_at' <> 'null'::jsonb
    and (
      (v_shift ->> 'closed_at')::timestamptz is null
      or not pg_catalog.isfinite((v_shift ->> 'closed_at')::timestamptz)
    ) then
      raise exception 'closed_at must be a finite timestamp or null'
        using errcode = '22023';
    end if;

    if (v_shift ->> 'pos_update_time')::timestamptz is null
    or not pg_catalog.isfinite((v_shift ->> 'pos_update_time')::timestamptz) then
      raise exception 'pos_update_time must be a finite timestamp'
        using errcode = '22023';
    end if;

    with
      upserted as (
        insert into
          app.pos_shifts (
            id,
            opened_at,
            closed_at,
            is_active,
            pos_update_time,
            synced_at
          )
        values
          (
            v_shift ->> 'id',
            (v_shift ->> 'opened_at')::timestamptz,
            case
              when v_shift -> 'closed_at' is null
              or v_shift -> 'closed_at' = 'null'::jsonb then null
              else (v_shift ->> 'closed_at')::timestamptz
            end,
            (v_shift ->> 'is_active')::boolean,
            (v_shift ->> 'pos_update_time')::timestamptz,
            pg_catalog.now()
          )
        on conflict (id) do update
        set
          opened_at = excluded.opened_at,
          closed_at = excluded.closed_at,
          is_active = excluded.is_active,
          pos_update_time = excluded.pos_update_time,
          synced_at = pg_catalog.now()
        where
          app.pos_shifts.pos_update_time <= excluded.pos_update_time
        returning
          id
      )
    select
      pg_catalog.count(*)::int
    into v_shift_wrote
    from
      upserted;

    if v_shift_wrote = 0 then
      v_shifts_skipped := v_shifts_skipped + 1;
    else
      v_shifts_upserted := v_shifts_upserted + 1;
    end if;
  end loop;

  for v_order in
    select
      e.value
    from
      pg_catalog.jsonb_array_elements(p_orders) as e (value)
    order by
      e.value ->> 'id'
  loop
    if pg_catalog.jsonb_typeof(v_order) <> 'object' then
      raise exception 'each order must be a jsonb object'
        using errcode = '22023';
    end if;

    v_order_id := v_order ->> 'id';
    v_shift_id := v_order ->> 'shift_id';
    v_status_order := v_order ->> 'status';
    v_hash := v_order ->> 'content_hash';
    v_ordered_at := (v_order ->> 'ordered_at')::timestamptz;
    v_update_time := (v_order ->> 'pos_update_time')::timestamptz;

    if v_shift_id is null or length(pg_catalog.btrim(v_shift_id)) = 0 then
      raise exception 'shift_id is required'
        using errcode = '22023';
    end if;

    if v_ordered_at is null or not pg_catalog.isfinite(v_ordered_at) then
      raise exception 'ordered_at must be a finite timestamp'
        using errcode = '22023';
    end if;

    if v_update_time is null or not pg_catalog.isfinite(v_update_time) then
      raise exception 'pos_update_time must be a finite timestamp'
        using errcode = '22023';
    end if;

    if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'content_hash must be a sha256 hex digest'
        using errcode = '22023';
    end if;

    v_lines := v_order -> 'lines';

    if v_lines is null or v_lines = 'null'::jsonb then
      v_lines := '[]'::jsonb;
    end if;

    insert into
      app.pos_sync_run_orders (run_id, order_id)
    values
      (p_run_id, v_order_id)
    on conflict (run_id, order_id) do nothing;

    v_attempts := 0;

    loop
      v_attempts := v_attempts + 1;

      if v_attempts > 3 then
        raise exception 'could not lock POS order'
          using errcode = '40001';
      end if;

      select
        o.*
      into v_existing
      from
        app.pos_orders o
      where
        o.id = v_order_id
      for update;

      if not found then
        v_conflict := false;

        begin
          insert into
            app.pos_orders (
              id,
              order_number,
              shift_id,
              status,
              order_type,
              payment_type,
              ordered_at,
              subtotal,
              discount,
              tax,
              service_tax,
              delivery_fee,
              total,
              financial_revision,
              last_financial_operation_key,
              pos_update_time,
              content_hash,
              version,
              missing_from_pos,
              first_synced_at,
              last_synced_at
            )
          values
            (
              v_order_id,
              case
                when v_order -> 'order_number' is null
                or v_order -> 'order_number' = 'null'::jsonb then null
                else (v_order ->> 'order_number')::int
              end,
              v_shift_id,
              v_status_order,
              nullif(pg_catalog.btrim(v_order ->> 'order_type'), ''),
              nullif(pg_catalog.btrim(v_order ->> 'payment_type'), ''),
              v_ordered_at,
              app.pos_money ((v_order ->> 'subtotal')::numeric),
              app.pos_money ((v_order ->> 'discount')::numeric),
              app.pos_money ((v_order ->> 'tax')::numeric),
              app.pos_money ((v_order ->> 'service_tax')::numeric),
              app.pos_money ((v_order ->> 'delivery_fee')::numeric),
              app.pos_money ((v_order ->> 'total')::numeric),
              case
                when v_order -> 'financial_revision' is null
                or v_order -> 'financial_revision' = 'null'::jsonb then null
                else (v_order ->> 'financial_revision')::int
              end,
              nullif(
                pg_catalog.btrim(v_order ->> 'last_financial_operation_key'),
                ''
              ),
              v_update_time,
              v_hash,
              1,
              false,
              pg_catalog.now(),
              pg_catalog.now()
            );
        exception
          when unique_violation then
            v_conflict := true;
        end;

        if v_conflict then
          continue;
        end if;

        perform app.replace_pos_order_lines (v_order_id, v_lines);

        v_inserted := v_inserted + 1;
        exit;
      elsif v_update_time < v_existing.pos_update_time then
        -- The payload is older than the stored document. Presence in this read
        -- still means the order is not missing.
        if v_existing.missing_from_pos then
          update app.pos_orders
          set
            missing_from_pos = false
          where
            id = v_order_id;
        end if;

        v_stale := v_stale + 1;
        exit;
      elsif v_update_time = v_existing.pos_update_time
      and v_hash = v_existing.content_hash then
        if v_existing.missing_from_pos then
          update app.pos_orders
          set
            missing_from_pos = false,
            last_synced_at = pg_catalog.now()
          where
            id = v_order_id;

          v_updated := v_updated + 1;
        else
          v_unchanged := v_unchanged + 1;
        end if;

        exit;
      else
        update app.pos_orders
        set
          order_number = case
            when v_order -> 'order_number' is null
            or v_order -> 'order_number' = 'null'::jsonb then null
            else (v_order ->> 'order_number')::int
          end,
          shift_id = v_shift_id,
          status = v_status_order,
          order_type = nullif(pg_catalog.btrim(v_order ->> 'order_type'), ''),
          payment_type = nullif(pg_catalog.btrim(v_order ->> 'payment_type'), ''),
          ordered_at = v_ordered_at,
          subtotal = app.pos_money ((v_order ->> 'subtotal')::numeric),
          discount = app.pos_money ((v_order ->> 'discount')::numeric),
          tax = app.pos_money ((v_order ->> 'tax')::numeric),
          service_tax = app.pos_money ((v_order ->> 'service_tax')::numeric),
          delivery_fee = app.pos_money ((v_order ->> 'delivery_fee')::numeric),
          total = app.pos_money ((v_order ->> 'total')::numeric),
          financial_revision = case
            when v_order -> 'financial_revision' is null
            or v_order -> 'financial_revision' = 'null'::jsonb then null
            else (v_order ->> 'financial_revision')::int
          end,
          last_financial_operation_key = nullif(
            pg_catalog.btrim(v_order ->> 'last_financial_operation_key'),
            ''
          ),
          pos_update_time = v_update_time,
          content_hash = v_hash,
          version = app.pos_orders.version + 1,
          missing_from_pos = false,
          last_synced_at = pg_catalog.now()
        where
          id = v_order_id;

        perform app.replace_pos_order_lines (v_order_id, v_lines);

        v_updated := v_updated + 1;
        exit;
      end if;
    end loop;
  end loop;

  if v_scope_key is not null then
    -- Update in id order, matching the per-order lock order above.
    for v_missing_id in
      select
        o.id
      from
        app.pos_orders o
      where
        o.missing_from_pos = false
        and o.last_synced_at < v_started_at
        and not exists (
          select
            1
          from
            app.pos_sync_run_orders s
          where
            s.run_id = p_run_id
            and s.order_id = o.id
        )
        and (
          v_scope_key = 'all'
          or (
            v_scope_key = 'from'
            and o.ordered_at >= v_from
          )
          or (
            v_scope_key = 'shift_ids'
            and o.shift_id in (
              select
                pg_catalog.jsonb_array_elements_text(p_scope -> 'shift_ids')
            )
          )
        )
      order by
        o.id
    loop
      update app.pos_orders
      set
        missing_from_pos = true
      where
        id = v_missing_id
        and missing_from_pos = false;

      if found then
        v_missing := v_missing + 1;
      end if;
    end loop;

    update app.pos_sync_runs
    set
      scope_applied = true
    where
      id = p_run_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'inserted',
    v_inserted,
    'updated',
    v_updated,
    'unchanged',
    v_unchanged,
    'stale',
    v_stale,
    'missing',
    v_missing,
    'shifts_upserted',
    v_shifts_upserted,
    'shifts_skipped',
    v_shifts_skipped
  );
end;
$$;

comment on function app.ingest_pos_batch (bigint, jsonb, jsonb, jsonb) is 'Upserts POS shifts and orders for one chunk of a run. Replaces an order only when the incoming document is newer, or the same update time with a different content hash. Marks orders missing only when p_scope is set, the order id was not presented to this run, and last_synced_at is earlier than the run started_at. Does not post stock and does not take the ledger posting lock.';

revoke all on function app.ingest_pos_batch (bigint, jsonb, jsonb, jsonb)
from
  public,
  anon;

grant
execute on function app.ingest_pos_batch (bigint, jsonb, jsonb, jsonb) to authenticated,
service_role;

alter table app.pos_shifts enable row level security;

alter table app.pos_orders enable row level security;

alter table app.pos_order_lines enable row level security;

alter table app.pos_sync_runs enable row level security;

alter table app.pos_sync_run_orders enable row level security;

create policy pos_shifts_select_owner on app.pos_shifts for
select
  to authenticated using (app.is_owner ());

create policy pos_orders_select_owner on app.pos_orders for
select
  to authenticated using (app.is_owner ());

create policy pos_order_lines_select_owner on app.pos_order_lines for
select
  to authenticated using (app.is_owner ());

create policy pos_sync_runs_select_owner on app.pos_sync_runs for
select
  to authenticated using (app.is_owner ());

revoke all on table app.pos_shifts
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_orders
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_order_lines
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_sync_runs
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on table app.pos_sync_run_orders
from
  public,
  anon,
  authenticated,
  service_role;

revoke all on sequence app.pos_sync_runs_id_seq
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.pos_shifts,
  app.pos_orders,
  app.pos_order_lines,
  app.pos_sync_runs to authenticated,
  service_role;
