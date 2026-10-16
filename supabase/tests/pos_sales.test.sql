begin;

select
  plan (134);

-- Synthetic users only. No POS documents and no customer data.
delete from app.owner;

delete from auth.identities
where
  user_id in (
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70'
  );

delete from auth.users
where
  id in (
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70'
  );

insert into
  auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change
  )
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'authenticated',
    'authenticated',
    'owner@theshark.test',
    '',
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70',
    'authenticated',
    'authenticated',
    'intruder@theshark.test',
    '',
    now(),
    '',
    '',
    '',
    ''
  );

insert into
  app.owner (user_id)
values
  ('b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f');

create temp table pos_test_ledger as
select
  (
    select
      count(*)
    from
      app.stock_movements
  ) as movements,
  (
    select
      count(*)
    from
      app.item_balances
  ) as balances,
  (
    select
      count(*)
    from
      app.provisional_deficits
  ) as deficits;

create temp table pos_test_ids (k text primary key, n bigint);

create temp table pos_test_json (k text primary key, v jsonb);

create temp table pos_test_ts (k text primary key, t timestamptz);

grant all on pos_test_ids,
pos_test_json,
pos_test_ts to authenticated,
service_role;

create function pg_temp.pos_shift (
  p_id text,
  p_opened timestamptz,
  p_closed timestamptz,
  p_active boolean,
  p_updated timestamptz
) returns jsonb language sql as $$
  select
    jsonb_build_object(
      'id',
      p_id,
      'opened_at',
      p_opened,
      'closed_at',
      p_closed,
      'is_active',
      p_active,
      'pos_update_time',
      p_updated,
      'pay_outs',
      'drawer-should-drop'
    );
$$;

create function pg_temp.pos_line (
  p_line_id text,
  p_price numeric,
  p_qty numeric,
  p_weighted numeric default null
) returns jsonb language sql as $$
  select
    jsonb_build_object(
      'line_id',
      p_line_id,
      'item_id',
      'item-test-buri',
      'item_name',
      'بوري',
      'size_name',
      'كبير',
      'quantity',
      p_qty,
      'weighted_qty',
      p_weighted,
      'weighted_unit',
      'kg',
      'unit_price',
      p_price,
      'price_per_kg',
      case
        when p_weighted is null then null
        else 80
      end,
      'line_total',
      999,
      'note',
      'pii-line-note',
      'itemImageUrl',
      'https://example.invalid/item.png',
      'scaleDeviceId',
      'scale-device-test',
      'options',
      jsonb_build_array(
        jsonb_build_object(
          'value',
          'مشوي',
          'price',
          1.005,
          'pricingType',
          'perKg',
          'pricingBaseQuantity',
          1,
          'note',
          'pii-option-extra',
          'phone',
          '01111111111'
        )
      )
    );
$$;

create function pg_temp.pos_order (
  p_id text,
  p_shift text,
  p_status text,
  p_at timestamptz,
  p_update timestamptz,
  p_hash text,
  p_lines jsonb,
  p_subtotal numeric default 10,
  p_discount numeric default 0,
  p_tax numeric default 0,
  p_service numeric default 0,
  p_delivery numeric default 0,
  p_total numeric default 10
) returns jsonb language sql as $$
  select
    jsonb_build_object(
      'id',
      p_id,
      'order_number',
      1001,
      'shift_id',
      p_shift,
      'status',
      p_status,
      'order_type',
      'takeaway',
      'payment_type',
      'cash',
      'ordered_at',
      p_at,
      'subtotal',
      p_subtotal,
      'discount',
      p_discount,
      'tax',
      p_tax,
      'service_tax',
      p_service,
      'delivery_fee',
      p_delivery,
      'total',
      p_total,
      'financial_revision',
      3,
      'last_financial_operation_key',
      'op-test-1',
      'pos_update_time',
      p_update,
      'content_hash',
      p_hash,
      'customerName',
      'pii-customer-name',
      'customerId',
      'cust-test-000',
      'employeeName',
      'pii-employee-name',
      'employeeId',
      'emp-test-000',
      'phone',
      '01000000000',
      'tableNumbers',
      'T-99',
      'lines',
      p_lines
    );
$$;

-- ============================================================================
-- Schema
-- ============================================================================
select
  has_table ('app', 'pos_shifts', 'app.pos_shifts exists');

select
  has_table ('app', 'pos_orders', 'app.pos_orders exists');

select
  has_table (
    'app',
    'pos_order_lines',
    'app.pos_order_lines exists'
  );

select
  has_table (
    'app',
    'pos_sync_runs',
    'app.pos_sync_runs exists'
  );

select
  has_table (
    'app',
    'pos_sync_run_orders',
    'app.pos_sync_run_orders exists'
  );

select
  has_index (
    'app',
    'pos_orders',
    'pos_orders_shift_id_idx',
    'pos_orders is indexed by shift_id'
  );

select
  has_index (
    'app',
    'pos_orders',
    'pos_orders_ordered_at_idx',
    'pos_orders is indexed by ordered_at'
  );

select
  has_function (
    'app',
    'ingest_pos_batch',
    array['bigint', 'jsonb', 'jsonb', 'jsonb'],
    'app.ingest_pos_batch(bigint, jsonb, jsonb, jsonb) exists'
  );

select
  has_function (
    'app',
    'start_pos_sync_run',
    array['text'],
    'app.start_pos_sync_run(text) exists'
  );

select
  has_function (
    'app',
    'finish_pos_sync_run',
    array['bigint', 'text', 'jsonb', 'text'],
    'app.finish_pos_sync_run exists'
  );

select
  has_function (
    'app',
    'assert_pos_write_allowed',
    '{}'::text[],
    'app.assert_pos_write_allowed() exists'
  );

select
  ok (
    (
      select
        p.prosecdef
        and p.proconfig @> array['search_path=""']::text[]
      from
        pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'ingest_pos_batch'
    ),
    'ingest_pos_batch is security definer with an empty search_path'
  );

select
  ok (
    (
      select
        p.prosecdef
        and p.proconfig @> array['search_path=""']::text[]
      from
        pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'assert_pos_write_allowed'
    ),
    'assert_pos_write_allowed is security definer with an empty search_path'
  );

select
  ok (
    position(
      '7342750000000000001' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) = 0
    and position(
      '7342750000000000001' in pg_get_functiondef('app.assert_pos_write_allowed()'::regprocedure)
    ) = 0
    and position(
      'assert_ledger_write_allowed' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) = 0,
    'POS ingest does not take the ledger posting lock'
  );

select
  ok (
    position(
      'for update' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) > 0,
    'ingest_pos_batch locks the existing order row'
  );

select
  ok (
    position(
      'stock_movements' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) = 0
    and position(
      'post_movements' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) = 0,
    'ingest_pos_batch does not reference the stock ledger'
  );

-- ============================================================================
-- Check constraints (direct writes as the migration owner)
-- ============================================================================
select
  throws_ok (
    $$insert into app.pos_orders (
        id, shift_id, status, ordered_at,
        subtotal, discount, tax, service_tax, delivery_fee, total,
        pos_update_time, content_hash
      ) values (
        'order-test-bad-status', 'shift-test-x', 'nope', now(),
        1, 0, 0, 0, 0, 1, now(), repeat('ab', 32)
      )$$,
    '23514'::char(5),
    null::text,
    'status must be complete, canceled, or active'
  );

select
  throws_ok (
    $$insert into app.pos_orders (
        id, shift_id, status, ordered_at,
        subtotal, discount, tax, service_tax, delivery_fee, total,
        pos_update_time, content_hash
      ) values (
        'order-test-nan', 'shift-test-x', 'complete', now(),
        1, 0, 0, 0, 0, 'NaN', now(), repeat('ab', 32)
      )$$,
    '23514'::char(5),
    null::text,
    'money rejects NaN'
  );

select
  throws_ok (
    $$insert into app.pos_orders (
        id, shift_id, status, ordered_at,
        subtotal, discount, tax, service_tax, delivery_fee, total,
        pos_update_time, content_hash
      ) values (
        'order-test-bad-hash', 'shift-test-x', 'complete', now(),
        1, 0, 0, 0, 0, 1, now(), 'not-a-hash'
      )$$,
    '23514'::char(5),
    null::text,
    'content_hash must be 64 lowercase hex characters'
  );

select
  throws_ok (
    $$insert into app.pos_sync_runs (mode, status) values ('nope', 'running')$$,
    '23514'::char(5),
    null::text,
    'sync mode must be recent, window35, or full'
  );

select
  throws_ok (
    $$insert into app.pos_sync_runs (mode, status) values ('recent', 'nope')$$,
    '23514'::char(5),
    null::text,
    'sync status must be running, ok, or failed'
  );

insert into
  app.pos_orders (
    id,
    shift_id,
    status,
    ordered_at,
    subtotal,
    discount,
    tax,
    service_tax,
    delivery_fee,
    total,
    pos_update_time,
    content_hash
  )
values
  (
    'order-test-constraint',
    'shift-test-x',
    'complete',
    now(),
    1,
    0,
    0,
    0,
    0,
    1,
    now(),
    repeat('ab', 32)
  );

select
  throws_ok (
    $$insert into app.pos_order_lines (
        order_id, line_id, item_id, quantity, line_total
      ) values (
        'order-test-constraint', 'line-test-bad', 'item-test-buri', -1, 1
      )$$,
    '23514'::char(5),
    null::text,
    'line quantity must be >= 0'
  );

select
  throws_ok (
    $$insert into app.pos_order_lines (
        order_id, line_id, item_id, quantity, options, line_total
      ) values (
        'order-test-constraint', 'line-test-bad-opt', 'item-test-buri', 1,
        '{"note":"pii-line-note"}'::jsonb, 1
      )$$,
    '23514'::char(5),
    null::text,
    'line options must be a jsonb array'
  );

delete from app.pos_orders
where
  id = 'order-test-constraint';

-- ============================================================================
-- Privileges before any sales rows exist
-- ============================================================================
select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  throws_ok (
    $$select app.ingest_pos_batch(1, '[]'::jsonb, '[]'::jsonb, null)$$,
    '42501'::char(5),
    'insufficient_privilege',
    'authenticated non-owner cannot ingest'
  );

select
  throws_ok (
    $$select app.start_pos_sync_run('recent')$$,
    '42501'::char(5),
    'insufficient_privilege',
    'authenticated non-owner cannot start a sync run'
  );

select
  throws_ok (
    $$select app.pos_money(1)$$,
    '42501'::char(5),
    null::text,
    'authenticated cannot call pos_money directly'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    'select * from app.pos_orders',
    '42501'::char(5),
    null::text,
    'anon cannot select pos_orders'
  );

select
  throws_ok (
    'select * from app.pos_shifts',
    '42501'::char(5),
    null::text,
    'anon cannot select pos_shifts'
  );

select
  throws_ok (
    'select * from app.pos_order_lines',
    '42501'::char(5),
    null::text,
    'anon cannot select pos_order_lines'
  );

select
  throws_ok (
    'select * from app.pos_sync_runs',
    '42501'::char(5),
    null::text,
    'anon cannot select pos_sync_runs'
  );

select
  throws_ok (
    $$insert into app.pos_orders (
        id, shift_id, status, ordered_at,
        subtotal, discount, tax, service_tax, delivery_fee, total,
        pos_update_time, content_hash
      ) values (
        'order-test-anon', 'shift-test-x', 'complete', now(),
        1, 0, 0, 0, 0, 1, now(), repeat('ab', 32)
      )$$,
    '42501'::char(5),
    null::text,
    'anon cannot insert pos_orders'
  );

select
  throws_ok (
    $$select app.ingest_pos_batch(1, '[]'::jsonb, '[]'::jsonb, null)$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot execute ingest_pos_batch'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  throws_ok (
    $$insert into app.pos_orders (
        id, shift_id, status, ordered_at,
        subtotal, discount, tax, service_tax, delivery_fee, total,
        pos_update_time, content_hash
      ) values (
        'order-test-owner-direct', 'shift-test-x', 'complete', now(),
        1, 0, 0, 0, 0, 1, now(), repeat('ab', 32)
      )$$,
    '42501'::char(5),
    null::text,
    'owner cannot insert pos_orders directly'
  );

select
  throws_ok (
    $$update app.pos_orders set status = 'canceled'$$,
    '42501'::char(5),
    null::text,
    'owner cannot update pos_orders directly'
  );

select
  throws_ok (
    'delete from app.pos_orders',
    '42501'::char(5),
    null::text,
    'owner cannot delete pos_orders directly'
  );

select
  throws_ok (
    $$insert into app.pos_shifts (id, opened_at, is_active, pos_update_time)
      values ('shift-test-direct', now(), true, now())$$,
    '42501'::char(5),
    null::text,
    'owner cannot insert pos_shifts directly'
  );

select
  throws_ok (
    $$select app.replace_pos_order_lines('order-test-a', '[]'::jsonb)$$,
    '42501'::char(5),
    null::text,
    'owner cannot call replace_pos_order_lines directly'
  );

select
  throws_ok (
    $$select * from app.pos_sync_run_orders$$,
    '42501'::char(5),
    null::text,
    'owner cannot read internal seen-order ids'
  );

-- ============================================================================
-- Insert, unchanged, replace, stale
-- ============================================================================
insert into
  pos_test_ids (k, n)
values
  ('run-a', app.start_pos_sync_run ('recent'));

insert into
  pos_test_json (k, v)
select
  'a1',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-a'
    ),
    jsonb_build_array(
      pg_temp.pos_shift (
        'shift-test-a',
        '2026-10-15T09:00:00Z',
        null,
        true,
        '2026-10-15T18:00:00Z'
      )
    ),
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-a',
        'shift-test-a',
        'complete',
        '2026-10-15T12:00:00Z',
        '2026-10-15T12:00:00Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-1', 10, 2))
      ),
      pg_temp.pos_order (
        'order-test-canceled',
        'shift-test-a',
        'canceled',
        '2026-10-15T12:05:00Z',
        '2026-10-15T12:05:00Z',
        repeat('cd', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-c', 5, 1))
      ),
      pg_temp.pos_order (
        'order-test-active',
        'shift-test-a',
        'active',
        '2026-10-15T12:06:00Z',
        '2026-10-15T12:06:00Z',
        repeat('ef', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-v', 5, 1))
      ),
      pg_temp.pos_order (
        'order-test-noshift',
        'shift-test-absent',
        'complete',
        '2026-10-15T12:07:00Z',
        '2026-10-15T12:07:00Z',
        repeat('12', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-n', 5, 1))
      ),
      pg_temp.pos_order (
        'order-test-empty',
        'shift-test-a',
        'canceled',
        '2026-10-15T12:08:00Z',
        '2026-10-15T12:08:00Z',
        repeat('34', 32),
        '[]'::jsonb
      ),
      pg_temp.pos_order (
        'order-test-cascade',
        'shift-test-a',
        'complete',
        '2026-10-15T12:09:00Z',
        '2026-10-15T12:09:00Z',
        repeat('56', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-cascade', 4, 1))
      ),
      pg_temp.pos_order (
        'order-test-round',
        'shift-test-a',
        'complete',
        '2026-10-15T12:10:00Z',
        '2026-10-15T12:10:00Z',
        repeat('78', 32),
        jsonb_build_array(
          pg_temp.pos_line ('line-test-fixed', 0.335, 3),
          pg_temp.pos_line ('line-test-qty', 2, 1.23456789),
          pg_temp.pos_line ('line-test-weight', 10.005, 1, 1.25)
        ),
        10.005,
        0.335,
        1.004,
        2.005,
        1.005,
        16.005
      )
    ),
    null
  );

select
  is (
    (
      select
        (v ->> 'inserted')::int
      from
        pos_test_json
      where
        k = 'a1'
    ),
    7,
    'first batch inserts every order'
  );

select
  is (
    (
      select
        (v ->> 'missing')::int
      from
        pos_test_json
      where
        k = 'a1'
    ),
    0,
    'a null scope does not mark orders missing'
  );

select
  is (
    (
      select
        (v ->> 'shifts_upserted')::int
      from
        pos_test_json
      where
        k = 'a1'
    ),
    1,
    'first batch upserts the shift'
  );

select
  is (
    (
      select
        count(*)::int
      from
        app.pos_shifts
      where
        id = 'shift-test-absent'
    ),
    0,
    'an order can be stored before its shift row'
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    1,
    'a new order starts at version 1'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    false,
    'a new order is not missing'
  );

select
  is (
    (
      select
        order_number
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    1001,
    'order number is stored'
  );

select
  is (
    (
      select
        financial_revision
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    3,
    'financial revision is stored'
  );

select
  is (
    (
      select
        status
      from
        app.pos_orders
      where
        id = 'order-test-canceled'
    ),
    'canceled',
    'canceled status is stored'
  );

select
  is (
    (
      select
        status
      from
        app.pos_orders
      where
        id = 'order-test-active'
    ),
    'active',
    'active status is stored'
  );

select
  is (
    (
      select
        line_total
      from
        app.pos_order_lines
      where
        order_id = 'order-test-a'
        and line_id = 'line-test-1'
    ),
    20.00::numeric,
    'fixed line total is round(price × quantity, 2), ignoring a client total'
  );

select
  is (
    (
      select
        weighted_qty
      from
        app.pos_order_lines
      where
        order_id = 'order-test-a'
        and line_id = 'line-test-1'
    ),
    null::numeric,
    'fixed lines store a null weighted quantity'
  );

select
  is (
    (
      select
        weighted_unit
      from
        app.pos_order_lines
      where
        order_id = 'order-test-a'
        and line_id = 'line-test-1'
    ),
    null::text,
    'fixed lines drop weighted unit'
  );

select
  is (
    (
      select
        item_name
      from
        app.pos_order_lines
      where
        order_id = 'order-test-a'
        and line_id = 'line-test-1'
    ),
    'بوري',
    'menu item name is kept'
  );

select
  ok (
    position(
      'pii-customer-name' in (
        select
          to_jsonb(o)::text
        from
          app.pos_orders o
        where
          o.id = 'order-test-a'
      )
    ) = 0
    and position(
      '01000000000' in (
        select
          to_jsonb(o)::text
        from
          app.pos_orders o
        where
          o.id = 'order-test-a'
      )
    ) = 0
    and position(
      'pii-employee-name' in (
        select
          to_jsonb(o)::text
        from
          app.pos_orders o
        where
          o.id = 'order-test-a'
      )
    ) = 0
    and position(
      'T-99' in (
        select
          to_jsonb(o)::text
        from
          app.pos_orders o
        where
          o.id = 'order-test-a'
      )
    ) = 0,
    'order header drops customer, employee, phone, and table fields'
  );

select
  ok (
    position(
      'pii-line-note' in (
        select
          to_jsonb(l)::text
        from
          app.pos_order_lines l
        where
          l.order_id = 'order-test-a'
      )
    ) = 0
    and position(
      'pii-option-extra' in (
        select
          l.options::text
        from
          app.pos_order_lines l
        where
          l.order_id = 'order-test-a'
      )
    ) = 0
    and position(
      '01111111111' in (
        select
          l.options::text
        from
          app.pos_order_lines l
        where
          l.order_id = 'order-test-a'
      )
    ) = 0
    and position(
      'scale-device-test' in (
        select
          to_jsonb(l)::text
        from
          app.pos_order_lines l
        where
          l.order_id = 'order-test-a'
      )
    ) = 0
    and position(
      'example.invalid' in (
        select
          to_jsonb(l)::text
        from
          app.pos_order_lines l
        where
          l.order_id = 'order-test-a'
      )
    ) = 0,
    'order lines drop notes, images, device ids, and extra option keys'
  );

select
  is (
    (
      select
        options -> 0 ->> 'value'
      from
        app.pos_order_lines
      where
        order_id = 'order-test-a'
        and line_id = 'line-test-1'
    ),
    'مشوي',
    'option value is kept'
  );

select
  is (
    (
      select
        (options -> 0 ->> 'price')::numeric
      from
        app.pos_order_lines
      where
        order_id = 'order-test-a'
        and line_id = 'line-test-1'
    ),
    1.01::numeric,
    'option price rounds half away from zero to the piaster'
  );

select
  ok (
    position(
      'drawer-should-drop' in (
        select
          to_jsonb(s)::text
        from
          app.pos_shifts s
        where
          s.id = 'shift-test-a'
      )
    ) = 0,
    'shift rows drop drawer and payout fields'
  );

select
  is_empty (
    $$select line_id from app.pos_order_lines where order_id = 'order-test-empty'$$,
    'an order with no lines stores no lines'
  );

select
  is (
    (
      select
        subtotal
      from
        app.pos_orders
      where
        id = 'order-test-round'
    ),
    10.01::numeric,
    'subtotal rounds to the piaster'
  );

select
  is (
    (
      select
        discount
      from
        app.pos_orders
      where
        id = 'order-test-round'
    ),
    0.34::numeric,
    'discount rounds half away from zero'
  );

select
  is (
    (
      select
        tax
      from
        app.pos_orders
      where
        id = 'order-test-round'
    ),
    1.00::numeric,
    'tax below half a piaster rounds down'
  );

select
  is (
    (
      select
        service_tax
      from
        app.pos_orders
      where
        id = 'order-test-round'
    ),
    2.01::numeric,
    'service tax rounds to the piaster'
  );

select
  is (
    (
      select
        delivery_fee
      from
        app.pos_orders
      where
        id = 'order-test-round'
    ),
    1.01::numeric,
    'delivery fee rounds to the piaster'
  );

select
  is (
    (
      select
        total
      from
        app.pos_orders
      where
        id = 'order-test-round'
    ),
    16.01::numeric,
    'total rounds to the piaster'
  );

select
  is (
    (
      select
        unit_price
      from
        app.pos_order_lines
      where
        order_id = 'order-test-round'
        and line_id = 'line-test-fixed'
    ),
    0.34::numeric,
    'fixed unit price is rounded to the piaster'
  );

select
  is (
    (
      select
        line_total
      from
        app.pos_order_lines
      where
        order_id = 'order-test-round'
        and line_id = 'line-test-fixed'
    ),
    1.01::numeric,
    'fixed line total rounds the raw price times quantity'
  );

select
  is (
    (
      select
        quantity
      from
        app.pos_order_lines
      where
        order_id = 'order-test-round'
        and line_id = 'line-test-qty'
    ),
    1.234568::numeric,
    'quantities round to six decimal places'
  );

select
  is (
    (
      select
        line_total
      from
        app.pos_order_lines
      where
        order_id = 'order-test-round'
        and line_id = 'line-test-qty'
    ),
    2.47::numeric,
    'fixed line total uses the raw quantity before six-place storage'
  );

select
  is (
    (
      select
        line_total
      from
        app.pos_order_lines
      where
        order_id = 'order-test-round'
        and line_id = 'line-test-weight'
    ),
    10.01::numeric,
    'weighted line total is the POS price rounded to the piaster'
  );

select
  is (
    (
      select
        weighted_qty
      from
        app.pos_order_lines
      where
        order_id = 'order-test-round'
        and line_id = 'line-test-weight'
    ),
    1.25::numeric,
    'weighted quantity is stored'
  );

insert into
  pos_test_ts (k, t)
select
  'a-first',
  first_synced_at
from
  app.pos_orders
where
  id = 'order-test-a';

insert into
  pos_test_ts (k, t)
select
  'a-last',
  last_synced_at
from
  app.pos_orders
where
  id = 'order-test-a';

insert into
  pos_test_json (k, v)
select
  'a2',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-a'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-a',
        'shift-test-a',
        'complete',
        '2026-10-15T14:00:00+02',
        '2026-10-15T14:00:00+02',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-ignored', 99, 9))
      )
    ),
    null
  );

select
  is (
    (
      select
        (v ->> 'unchanged')::int
      from
        pos_test_json
      where
        k = 'a2'
    ),
    1,
    'equal update time and equal hash is unchanged'
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    1,
    'unchanged ingest keeps the version'
  );

select
  results_eq (
    $$select line_id from app.pos_order_lines
      where order_id = 'order-test-a' order by line_id$$,
    array['line-test-1']::text[],
    'unchanged ingest keeps the stored lines'
  );

select
  is (
    (
      select
        last_synced_at
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    (
      select
        t
      from
        pos_test_ts
      where
        k = 'a-last'
    ),
    'unchanged ingest does not touch last_synced_at'
  );

insert into
  pos_test_json (k, v)
select
  'a3',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-a'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-a',
        'shift-test-a',
        'complete',
        '2026-10-15T12:00:00Z',
        '2026-10-15T12:00:01Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-2', 11, 1))
      )
    ),
    null
  );

select
  is (
    (
      select
        (v ->> 'updated')::int
      from
        pos_test_json
      where
        k = 'a3'
    ),
    1,
    'a newer update time replaces the order'
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    2,
    'a newer document increments version'
  );

select
  results_eq (
    $$select line_id from app.pos_order_lines
      where order_id = 'order-test-a' order by line_id$$,
    array['line-test-2']::text[],
    'a newer document replaces every line'
  );

select
  is (
    (
      select
        first_synced_at
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    (
      select
        t
      from
        pos_test_ts
      where
        k = 'a-first'
    ),
    'replacing an order keeps first_synced_at'
  );

insert into
  pos_test_json (k, v)
select
  'a4',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-a'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-a',
        'shift-test-a',
        'canceled',
        '2026-10-15T11:00:00Z',
        '2026-10-15T11:59:59Z',
        repeat('ef', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-stale', 1, 1))
      )
    ),
    null
  );

select
  is (
    (
      select
        (v ->> 'stale')::int
      from
        pos_test_json
      where
        k = 'a4'
    ),
    1,
    'an older update time is stale'
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    2,
    'a stale payload does not change version'
  );

select
  is (
    (
      select
        status
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    'complete',
    'a stale payload does not change status'
  );

select
  results_eq (
    $$select line_id from app.pos_order_lines
      where order_id = 'order-test-a' order by line_id$$,
    array['line-test-2']::text[],
    'a stale payload does not replace lines'
  );

insert into
  pos_test_json (k, v)
select
  'a5',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-a'
    ),
    jsonb_build_array(
      pg_temp.pos_shift (
        'shift-test-a',
        '2026-10-15T08:00:00Z',
        '2026-10-15T19:00:00Z',
        false,
        '2026-10-15T17:00:00Z'
      )
    ),
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-a',
        'shift-test-a',
        'complete',
        '2026-10-15T12:00:00Z',
        '2026-10-15T12:00:01Z',
        repeat('cd', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-3', 12, 1))
      )
    ),
    null
  );

select
  is (
    (
      select
        (v ->> 'updated')::int
      from
        pos_test_json
      where
        k = 'a5'
    ),
    1,
    'equal update time and a different hash replaces the order'
  );

select
  is (
    (
      select
        (v ->> 'shifts_skipped')::int
      from
        pos_test_json
      where
        k = 'a5'
    ),
    1,
    'an older shift update is skipped'
  );

select
  is (
    (
      select
        closed_at
      from
        app.pos_shifts
      where
        id = 'shift-test-a'
    ),
    null::timestamptz,
    'a skipped shift update does not clear closed_at'
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-test-a'
    ),
    3,
    'same-time content change increments version'
  );

select
  results_eq (
    $$select line_id from app.pos_order_lines
      where order_id = 'order-test-a' order by line_id$$,
    array['line-test-3']::text[],
    'same-time content change replaces lines'
  );

insert into
  pos_test_json (k, v)
select
  'a6',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-a'
    ),
    jsonb_build_array(
      pg_temp.pos_shift (
        'shift-test-a',
        '2026-10-15T09:00:00Z',
        '2026-10-15T22:00:00Z',
        false,
        '2026-10-15T22:00:00Z'
      )
    ),
    '[]'::jsonb,
    null
  );

select
  is (
    (
      select
        (v ->> 'shifts_upserted')::int
      from
        pos_test_json
      where
        k = 'a6'
    ),
    1,
    'a newer shift update is stored'
  );

select
  is (
    (
      select
        closed_at
      from
        app.pos_shifts
      where
        id = 'shift-test-a'
    ),
    '2026-10-15T22:00:00Z'::timestamptz,
    'a newer shift update stores closed_at'
  );

select
  is (
    (
      select
        is_active
      from
        app.pos_shifts
      where
        id = 'shift-test-a'
    ),
    false,
    'a newer shift update stores is_active'
  );

-- ============================================================================
-- Missing orders, per scope. Seen ids accumulate across chunks of one run.
-- ============================================================================
insert into
  pos_test_ids (k, n)
values
  ('run-shift', app.start_pos_sync_run ('recent'));

insert into
  pos_test_json (k, v)
select
  'seed-1',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-shift'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-in-keep',
        'shift-test-in',
        'complete',
        '2026-10-14T12:00:00Z',
        '2026-10-14T12:00:00Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-in', 3, 1))
      ),
      pg_temp.pos_order (
        'order-test-in-gone',
        'shift-test-in',
        'complete',
        '2026-10-14T12:01:00Z',
        '2026-10-14T12:01:00Z',
        repeat('cd', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-gone', 3, 1))
      ),
      pg_temp.pos_order (
        'order-test-out',
        'shift-test-out',
        'complete',
        '2026-10-14T12:02:00Z',
        '2026-10-14T12:02:00Z',
        repeat('ef', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-out', 3, 1))
      )
    ),
    null
  );

insert into
  pos_test_ids (k, n)
values
  ('run-shift-2', app.start_pos_sync_run ('recent'));

insert into
  pos_test_json (k, v)
select
  'shift-scope',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-shift-2'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-in-keep',
        'shift-test-in',
        'complete',
        '2026-10-14T12:00:00Z',
        '2026-10-14T12:00:00Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-in', 3, 1))
      )
    ),
    jsonb_build_object('shift_ids', jsonb_build_array('shift-test-in'))
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-in-gone'
    ),
    true,
    'a shift scope marks an unseen order in that shift missing'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-in-keep'
    ),
    false,
    'a shift scope does not mark an order that was in the batch'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-out'
    ),
    false,
    'a shift scope does not mark an order from another shift'
  );

select
  results_eq (
    $$select line_id from app.pos_order_lines
      where order_id = 'order-test-in-gone'$$,
    array['line-test-gone']::text[],
    'marking an order missing keeps the row and its lines'
  );

insert into
  pos_test_ids (k, n)
values
  ('run-window', app.start_pos_sync_run ('window35'));

insert into
  pos_test_json (k, v)
select
  'seed-2',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-window'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-win-keep',
        'shift-test-win',
        'complete',
        '2026-09-01T00:00:00Z',
        '2026-09-01T00:00:00Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-wk', 3, 1))
      ),
      pg_temp.pos_order (
        'order-test-win-gone',
        'shift-test-win',
        'complete',
        '2026-09-02T00:00:00Z',
        '2026-09-02T00:00:00Z',
        repeat('cd', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-wg', 3, 1))
      ),
      pg_temp.pos_order (
        'order-test-win-old',
        'shift-test-win',
        'complete',
        '2026-08-31T23:59:59Z',
        '2026-08-31T23:59:59Z',
        repeat('ef', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-wo', 3, 1))
      )
    ),
    null
  );

insert into
  pos_test_ids (k, n)
values
  (
    'run-window-2',
    app.start_pos_sync_run ('window35')
  );

insert into
  pos_test_json (k, v)
select
  'seed-3',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-window-2'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-win-keep',
        'shift-test-win',
        'complete',
        '2026-09-01T00:00:00Z',
        '2026-09-01T00:00:00Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-wk', 3, 1))
      )
    ),
    jsonb_build_object('from', '2026-09-01T00:00:00Z')
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-win-gone'
    ),
    true,
    'a window scope marks a later unseen order missing'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-win-keep'
    ),
    false,
    'an order at the window start is inside the scope and kept when read'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-win-old'
    ),
    false,
    'a window scope does not mark an order before from'
  );

insert into
  pos_test_ids (k, n)
values
  ('run-chunk', app.start_pos_sync_run ('recent'));

insert into
  pos_test_json (k, v)
select
  'seed-4',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-chunk'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-chunk-1',
        'shift-test-chunk',
        'complete',
        '2026-10-10T12:00:00Z',
        '2026-10-10T12:00:00Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-ch1', 3, 1))
      ),
      pg_temp.pos_order (
        'order-test-chunk-2',
        'shift-test-chunk',
        'complete',
        '2026-10-10T12:01:00Z',
        '2026-10-10T12:01:00Z',
        repeat('cd', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-ch2', 3, 1))
      ),
      pg_temp.pos_order (
        'order-test-chunk-gone',
        'shift-test-chunk',
        'complete',
        '2026-10-10T12:02:00Z',
        '2026-10-10T12:02:00Z',
        repeat('ef', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-chg', 3, 1))
      )
    ),
    null
  );

insert into
  pos_test_ids (k, n)
values
  ('run-chunk-2', app.start_pos_sync_run ('recent'));

insert into
  pos_test_json (k, v)
select
  'seed-5',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-chunk-2'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-chunk-1',
        'shift-test-chunk',
        'complete',
        '2026-10-10T12:00:00Z',
        '2026-10-10T12:00:00Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-ch1', 3, 1))
      )
    ),
    null
  );

insert into
  pos_test_json (k, v)
select
  'seed-6',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-chunk-2'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-chunk-2',
        'shift-test-chunk',
        'complete',
        '2026-10-10T12:01:00Z',
        '2026-10-10T12:01:00Z',
        repeat('cd', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-ch2', 3, 1))
      )
    ),
    null
  );

insert into
  pos_test_json (k, v)
select
  'chunk-scope',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-chunk-2'
    ),
    '[]'::jsonb,
    '[]'::jsonb,
    jsonb_build_object(
      'shift_ids',
      jsonb_build_array('shift-test-chunk')
    )
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-chunk-1'
    ),
    false,
    'an order ingested in an earlier chunk is not marked missing'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-chunk-2'
    ),
    false,
    'an order ingested in a middle chunk is not marked missing'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-chunk-gone'
    ),
    true,
    'an order absent from every chunk of the run is marked missing'
  );

select
  is (
    (
      select
        (v ->> 'missing')::int
      from
        pos_test_json
      where
        k = 'chunk-scope'
    ),
    1,
    'missing count is the number of rows newly marked'
  );

insert into
  pos_test_ids (k, n)
values
  ('run-reappear', app.start_pos_sync_run ('recent'));

insert into
  pos_test_json (k, v)
select
  'seed-7',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-reappear'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-chunk-gone',
        'shift-test-chunk',
        'complete',
        '2026-10-10T12:02:00Z',
        '2026-10-10T12:02:00Z',
        repeat('ef', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-chg', 3, 1))
      )
    ),
    null
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-chunk-gone'
    ),
    false,
    'seeing an unchanged order again clears missing_from_pos'
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-test-chunk-gone'
    ),
    1,
    'clearing missing_from_pos does not increment version'
  );

select
  throws_ok (
    $$select app.ingest_pos_batch(
        (select n from pos_test_ids where k = 'run-a'),
        '[]'::jsonb,
        '[]'::jsonb,
        '{"all":true}'::jsonb
      )$$,
    '22023'::char(5),
    null::text,
    'a recent run rejects an all scope'
  );

select
  is (
    (
      select
        scope_applied
      from
        app.pos_sync_runs
      where
        id = (
          select
            n
          from
            pos_test_ids
          where
            k = 'run-a'
        )
    ),
    false,
    'a rejected scope is not recorded'
  );

select
  throws_ok (
    $$select app.ingest_pos_batch(
        (select n from pos_test_ids where k = 'run-chunk-2'),
        '[]'::jsonb,
        '[]'::jsonb,
        jsonb_build_object('shift_ids', jsonb_build_array('shift-test-chunk'))
      )$$,
    '22023'::char(5),
    null::text,
    'a run rejects a second scope'
  );

insert into
  pos_test_ids (k, n)
values
  ('run-full', app.start_pos_sync_run ('full'));

insert into
  pos_test_json (k, v)
select
  'seed-8',
  app.ingest_pos_batch (
    (
      select
        n
      from
        pos_test_ids
      where
        k = 'run-full'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.pos_order (
        'order-test-all-keep',
        'shift-test-all',
        'complete',
        '2026-10-01T00:00:00Z',
        '2026-10-01T00:00:00Z',
        repeat('ab', 32),
        jsonb_build_array(pg_temp.pos_line ('line-test-all', 3, 1))
      )
    ),
    '{"all":true}'::jsonb
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-all-keep'
    ),
    false,
    'a full scope keeps an order that was in the batch'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-test-win-old'
    ),
    true,
    'a full scope marks an order outside the batch missing'
  );

-- ============================================================================
-- Reads after rows exist
-- ============================================================================
select
  ok (
    (
      select
        count(*)
      from
        app.pos_orders
    ) > 0,
    'owner can select pos_orders'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.pos_shifts
    ) > 0,
    'owner can select pos_shifts'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.pos_order_lines
    ) > 0,
    'owner can select pos_order_lines'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.pos_sync_runs
    ) > 0,
    'owner can select pos_sync_runs'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  is_empty (
    'select id from app.pos_orders',
    'non-owner sees no orders'
  );

select
  is_empty (
    'select id from app.pos_shifts',
    'non-owner sees no shifts'
  );

select
  is_empty (
    'select order_id from app.pos_order_lines',
    'non-owner sees no order lines'
  );

select
  is_empty (
    'select id from app.pos_sync_runs',
    'non-owner sees no sync runs'
  );

select
  throws_ok (
    $$insert into app.pos_shifts (id, opened_at, is_active, pos_update_time)
      values ('shift-test-intruder', now(), true, now())$$,
    '42501'::char(5),
    null::text,
    'non-owner cannot insert pos_shifts'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    'update app.pos_orders set status = ''canceled''',
    '42501'::char(5),
    null::text,
    'anon cannot update pos_orders'
  );

select
  throws_ok (
    'delete from app.pos_order_lines',
    '42501'::char(5),
    null::text,
    'anon cannot delete pos_order_lines'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );

set
  local role service_role;

select
  throws_ok (
    $$insert into app.pos_orders (
        id, shift_id, status, ordered_at,
        subtotal, discount, tax, service_tax, delivery_fee, total,
        pos_update_time, content_hash
      ) values (
        'order-test-service-direct', 'shift-test-x', 'complete', now(),
        1, 0, 0, 0, 0, 1, now(), repeat('ab', 32)
      )$$,
    '42501'::char(5),
    null::text,
    'service_role cannot insert pos_orders directly'
  );

select
  throws_ok (
    'update app.pos_orders set status = ''canceled''',
    '42501'::char(5),
    null::text,
    'service_role cannot update pos_orders'
  );

select
  throws_ok (
    'delete from app.pos_orders',
    '42501'::char(5),
    null::text,
    'service_role cannot delete pos_orders'
  );

insert into
  pos_test_ids (k, n)
values
  ('run-service', app.start_pos_sync_run ('full'));

select
  is (
    (
      select
        (
          app.ingest_pos_batch (
            (
              select
                n
              from
                pos_test_ids
              where
                k = 'run-service'
            ),
            '[]'::jsonb,
            jsonb_build_array(
              pg_temp.pos_order (
                'order-test-service',
                'shift-test-service',
                'complete',
                '2026-10-11T12:00:00Z',
                '2026-10-11T12:00:00Z',
                repeat('ab', 32),
                jsonb_build_array(pg_temp.pos_line ('line-test-svc', 6, 1))
              )
            ),
            null
          ) ->> 'inserted'
        )::int
    ),
    1,
    'service_role can ingest'
  );

select
  lives_ok (
    $$select id from app.pos_orders where id = 'order-test-service'$$,
    'service_role can select pos_orders'
  );

select
  lives_ok (
    $$select app.finish_pos_sync_run(
      (select n from pos_test_ids where k = 'run-service'),
      'failed',
      jsonb_build_object('read', 0),
      repeat('e', 600)
    )$$,
    'finish records the failed run without returning a row'
  );

select
  is (
    (
      select
        status
      from
        app.pos_sync_runs
      where
        id = (
          select
            n
          from
            pos_test_ids
          where
            k = 'run-service'
        )
    ),
    'failed',
    'finish records a failed run'
  );

select
  is (
    (
      select
        length(error)
      from
        app.pos_sync_runs
      where
        id = (
          select
            n
          from
            pos_test_ids
          where
            k = 'run-service'
        )
    ),
    500,
    'finish truncates error text'
  );

reset role;

select
  is (
    (
      select
        count(*)::int
      from
        app.pos_sync_run_orders
      where
        run_id = (
          select
            n
          from
            pos_test_ids
          where
            k = 'run-service'
        )
    ),
    0,
    'finish drops seen-order ids'
  );

set
  local role service_role;

select
  throws_ok (
    $$select app.finish_pos_sync_run(
        (select n from pos_test_ids where k = 'run-service'),
        'ok',
        '{}'::jsonb,
        null
      )$$,
    '22023'::char(5),
    null::text,
    'a finished run cannot be finished again'
  );

select
  throws_ok (
    $$select app.ingest_pos_batch(
        (select n from pos_test_ids where k = 'run-service'),
        '[]'::jsonb,
        '[]'::jsonb,
        null
      )$$,
    '22023'::char(5),
    null::text,
    'a finished run rejects another batch'
  );

reset role;

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
    ),
    (
      select
        movements
      from
        pos_test_ledger
    ),
    'ingest does not write stock movements'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_balances
    ),
    (
      select
        balances
      from
        pos_test_ledger
    ),
    'ingest does not write item balances'
  );

select
  is (
    (
      select
        count(*)
      from
        app.provisional_deficits
    ),
    (
      select
        deficits
      from
        pos_test_ledger
    ),
    'ingest does not write provisional deficits'
  );

delete from app.pos_orders
where
  id = 'order-test-cascade';

select
  is_empty (
    $$select line_id from app.pos_order_lines where order_id = 'order-test-cascade'$$,
    'deleting an order cascades to its lines'
  );

select
  *
from
  finish ();

rollback;
