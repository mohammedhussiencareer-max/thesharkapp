-- Shift drawer totals (reconciliation only) and POS shift transactions.
-- Refunds are type 3 rows. They are not on the order document.
-- Drawer cash and credit never enter profit.
--
-- Transaction replacement is "whenever the shift is presented", not only when
-- the shift row is written. The subcollection can change while the shift
-- document's updateTime stays still. That is safe with one run at a time:
-- start_pos_sync_run holds the sync advisory lock and the partial unique
-- index admits only one running row; ingest_pos_batch locks that run row;
-- the runner reads every page of the subcollection before it sends the shift;
-- and planIngestCalls puts shifts on the first chunk only, so a later chunk
-- cannot wipe the set. Delete and insert run in shift-id order inside this
-- function's transaction.
alter table app.pos_shifts
add column drawer_cash_net numeric(14, 2) null,
add column drawer_credit numeric(14, 2) null;

alter table app.pos_shifts
add constraint pos_shifts_drawer_finite_chk check (
  (
    drawer_cash_net is null
    or drawer_cash_net not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  )
  and (
    drawer_credit is null
    or drawer_credit not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  )
);

comment on table app.pos_shifts is 'POS custody shifts copied for accounting. drawer_cash_net and drawer_credit are reconciliation only and never enter profit.';

comment on column app.pos_shifts.drawer_cash_net is 'POS cash_payments_net. Reconciliation only. Null when the POS field is absent. Never enters profit.';

comment on column app.pos_shifts.drawer_credit is 'POS credit_payments. Reconciliation only. Null when the POS field is absent. Never enters profit.';

create table app.pos_shift_transactions (
  shift_id text not null references app.pos_shifts (id) on delete cascade,
  tx_id text not null check (length(btrim(tx_id)) > 0),
  order_id text null check (
    order_id is null
    or length(btrim(order_id)) > 0
  ),
  tx_type integer not null,
  amount numeric(14, 2) not null,
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  primary key (shift_id, tx_id),
  constraint pos_shift_transactions_amount_finite_chk check (
    amount not in (
      'NaN'::numeric,
      'Infinity'::numeric,
      '-Infinity'::numeric
    )
  )
);

comment on table app.pos_shift_transactions is 'Accounting rows from a shift transactions subcollection: type, amount, order id, and time. Description is never stored. Type 3 is a refund. Drawer totals are not profit.';

create index pos_shift_transactions_order_id_idx on app.pos_shift_transactions (order_id);

alter table app.pos_shift_transactions enable row level security;

create policy pos_shift_transactions_select_owner on app.pos_shift_transactions for
select
  to authenticated using (app.is_owner ());

revoke all on table app.pos_shift_transactions
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.pos_shift_transactions to authenticated,
  service_role;

-- security_invoker so RLS on the base tables applies to the querying role.
create view app.pos_shift_summaries
with
  (security_invoker = true) as
select
  s.id as shift_id,
  s.opened_at,
  s.closed_at,
  s.is_active,
  o.orders_complete,
  o.gross_sales,
  t.refunds,
  (o.gross_sales - t.refunds)::numeric(14, 2) as net_sales,
  o.orders_canceled,
  o.orders_open,
  o.orders_missing,
  case
    when s.drawer_cash_net is null
    or s.drawer_credit is null then null
    else (s.drawer_cash_net + s.drawer_credit)::numeric(14, 2)
  end as drawer_total,
  case
    when s.drawer_cash_net is null
    or s.drawer_credit is null then null
    else (
      (s.drawer_cash_net + s.drawer_credit) - (o.gross_sales - t.refunds)
    )::numeric(14, 2)
  end as drawer_difference,
  t.unknown_tx
from
  app.pos_shifts s
  cross join lateral (
    select
      count(*) filter (
        where
          status = 'complete'
          and not missing_from_pos
      )::integer as orders_complete,
      coalesce(
        sum(total) filter (
          where
            status = 'complete'
            and not missing_from_pos
        ),
        0
      )::numeric(14, 2) as gross_sales,
      count(*) filter (
        where
          status = 'canceled'
          and not missing_from_pos
      )::integer as orders_canceled,
      count(*) filter (
        where
          status = 'active'
          and not missing_from_pos
      )::integer as orders_open,
      count(*) filter (
        where
          missing_from_pos
      )::integer as orders_missing
    from
      app.pos_orders
    where
      shift_id = s.id
  ) o
  cross join lateral (
    select
      coalesce(
        sum(amount) filter (
          where
            tx_type = 3
        ),
        0
      )::numeric(14, 2) as refunds,
      count(*) filter (
        where
          tx_type not in (0, 2, 3)
      )::integer as unknown_tx
    from
      app.pos_shift_transactions
    where
      shift_id = s.id
  ) t;

comment on view app.pos_shift_summaries is 'One row per shift. net_sales is completed, not-missing order totals minus type-3 refunds in this shift. Drawer columns are reconciliation only and never enter profit. A refunded order stays complete here; its cost follows the cancel decision later.';

revoke all on table app.pos_shift_summaries
from
  public,
  anon,
  authenticated,
  service_role;

grant
select
  on table app.pos_shift_summaries to authenticated,
  service_role;

create or replace function app.ingest_pos_batch (
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
  v_tx jsonb;
  v_clean jsonb;
  v_seen text[];
  v_drawer_cash numeric(14, 2);
  v_drawer_credit numeric(14, 2);
  v_tx_id text;
  v_tx_order text;
  v_tx_type integer;
  v_tx_amount numeric(14, 2);
  v_tx_at timestamptz;
  v_transactions integer := 0;
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

    v_drawer_cash := null;
    v_drawer_credit := null;

    if v_shift -> 'drawer_cash_net' is null
    or v_shift -> 'drawer_cash_net' = 'null'::jsonb then
      v_drawer_cash := null;
    elsif pg_catalog.jsonb_typeof(v_shift -> 'drawer_cash_net') not in ('number', 'string') then
      raise exception 'drawer_cash_net must be a finite number or null'
        using errcode = '22023';
    else
      begin
        v_drawer_cash := app.pos_money ((v_shift ->> 'drawer_cash_net')::numeric);
      exception
        when invalid_text_representation
        or numeric_value_out_of_range
        or invalid_parameter_value then
          raise exception 'drawer_cash_net must be a finite number or null'
            using errcode = '22023';
      end;
    end if;

    if v_shift -> 'drawer_credit' is null
    or v_shift -> 'drawer_credit' = 'null'::jsonb then
      v_drawer_credit := null;
    elsif pg_catalog.jsonb_typeof(v_shift -> 'drawer_credit') not in ('number', 'string') then
      raise exception 'drawer_credit must be a finite number or null'
        using errcode = '22023';
    else
      begin
        v_drawer_credit := app.pos_money ((v_shift ->> 'drawer_credit')::numeric);
      exception
        when invalid_text_representation
        or numeric_value_out_of_range
        or invalid_parameter_value then
          raise exception 'drawer_credit must be a finite number or null'
            using errcode = '22023';
      end;
    end if;

    if v_shift -> 'transactions' is null
    or pg_catalog.jsonb_typeof(v_shift -> 'transactions') is distinct from 'array' then
      raise exception 'transactions must be a jsonb array'
        using errcode = '22023';
    end if;

    v_clean := '[]'::jsonb;
    v_seen := '{}'::text[];

    for v_tx in
      select
        e.value
      from
        pg_catalog.jsonb_array_elements(v_shift -> 'transactions') as e (value)
    loop
      if pg_catalog.jsonb_typeof(v_tx) is distinct from 'object' then
        raise exception 'each transaction must be a jsonb object'
          using errcode = '22023';
      end if;

      v_tx_id := pg_catalog.btrim(v_tx ->> 'tx_id');

      if v_tx_id is null or length(v_tx_id) = 0 then
        raise exception 'tx_id is required'
          using errcode = '22023';
      end if;

      if v_tx_id = any (v_seen) then
        raise exception 'duplicate tx_id'
          using errcode = '22023';
      end if;

      v_seen := v_seen || v_tx_id;

      if v_tx -> 'order_id' is null
      or v_tx -> 'order_id' = 'null'::jsonb then
        v_tx_order := null;
      elsif pg_catalog.jsonb_typeof(v_tx -> 'order_id') is distinct from 'string' then
        raise exception 'order_id must be a string or null'
          using errcode = '22023';
      else
        v_tx_order := nullif(pg_catalog.btrim(v_tx ->> 'order_id'), '');
      end if;

      if pg_catalog.jsonb_typeof(v_tx -> 'tx_type') is distinct from 'number'
      or coalesce(v_tx ->> 'tx_type', '') !~ '^-?[0-9]+$' then
        raise exception 'tx_type must be an integer'
          using errcode = '22023';
      end if;

      begin
        v_tx_type := (v_tx ->> 'tx_type')::integer;
      exception
        when numeric_value_out_of_range then
          raise exception 'tx_type must be an integer'
            using errcode = '22023';
      end;

      if v_tx -> 'amount' is null
      or pg_catalog.jsonb_typeof(v_tx -> 'amount') not in ('number', 'string') then
        raise exception 'amount must be a finite number'
          using errcode = '22023';
      end if;

      begin
        v_tx_amount := app.pos_money ((v_tx ->> 'amount')::numeric);
      exception
        when invalid_text_representation
        or numeric_value_out_of_range
        or invalid_parameter_value then
          raise exception 'amount must be a finite number'
            using errcode = '22023';
      end;

      if pg_catalog.jsonb_typeof(v_tx -> 'occurred_at') is distinct from 'string' then
        raise exception 'occurred_at must be a finite timestamp'
          using errcode = '22023';
      end if;

      begin
        v_tx_at := (v_tx ->> 'occurred_at')::timestamptz;
      exception
        when invalid_datetime_format
        or datetime_field_overflow
        or invalid_text_representation then
          raise exception 'occurred_at must be a finite timestamp'
            using errcode = '22023';
      end;

      if v_tx_at is null or not pg_catalog.isfinite(v_tx_at) then
        raise exception 'occurred_at must be a finite timestamp'
          using errcode = '22023';
      end if;

      v_clean := v_clean || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'tx_id',
          v_tx_id,
          'order_id',
          v_tx_order,
          'tx_type',
          v_tx_type,
          'amount',
          v_tx_amount,
          'occurred_at',
          v_tx_at
        )
      );
    end loop;


    with
      upserted as (
        insert into
          app.pos_shifts (
            id,
            opened_at,
            closed_at,
            is_active,
            pos_update_time,
            drawer_cash_net,
            drawer_credit,
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
            v_drawer_cash,
            v_drawer_credit,
            pg_catalog.now()
          )
        on conflict (id) do update
        set
          opened_at = excluded.opened_at,
          closed_at = excluded.closed_at,
          is_active = excluded.is_active,
          pos_update_time = excluded.pos_update_time,
          drawer_cash_net = excluded.drawer_cash_net,
          drawer_credit = excluded.drawer_credit,
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

    -- Whenever presented, not only when the shift row is written. The
    -- subcollection can change while updateTime does not. One run is running
    -- at a time, this function locks that run, and the presented array is the
    -- complete subcollection read. Shifts are sent on the first chunk only.
    delete from app.pos_shift_transactions
    where
      shift_id = v_shift ->> 'id';

    insert into
      app.pos_shift_transactions (
        shift_id,
        tx_id,
        order_id,
        tx_type,
        amount,
        occurred_at
      )
    select
      v_shift ->> 'id',
      e.value ->> 'tx_id',
      e.value ->> 'order_id',
      (e.value ->> 'tx_type')::integer,
      (e.value ->> 'amount')::numeric(14, 2),
      (e.value ->> 'occurred_at')::timestamptz
    from
      pg_catalog.jsonb_array_elements(v_clean) as e (value)
    order by
      e.value ->> 'tx_id';

    v_transactions := v_transactions + coalesce(pg_catalog.jsonb_array_length(v_clean), 0);
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
    v_shifts_skipped,
    'transactions',
    v_transactions
  );
end;
$$;

comment on function app.ingest_pos_batch (bigint, jsonb, jsonb, jsonb) is 'Upserts POS shifts and orders for one chunk of a run. Replaces an order only when the incoming document is newer, or the same update time with a different content hash. Replaces every presented shift''s transactions even when the shift row is skipped as older, because the subcollection can change without a new updateTime and only one sync run is running. Marks orders missing only when p_scope is set, the order id was not presented to this run, and last_synced_at is earlier than the run started_at. Does not post stock and does not take the ledger posting lock.';
