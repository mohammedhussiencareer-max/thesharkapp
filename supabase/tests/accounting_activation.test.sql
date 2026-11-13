-- Owner activation, the public poster guard, and the timeout recorder's grants.
-- Synthetic ids only. The benchmark and the two-session races are not here.
begin;

select
  no_plan ();

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
    'a7900000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-79@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a7900000-0000-4000-8000-0000000000a2',
    'authenticated',
    'authenticated',
    'intruder-79@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  );

insert into
  app.owner (user_id)
values
  ('a7900000-0000-4000-8000-0000000000a1');

create function pg_temp.as_user (p_sub text) returns void language sql as $$
  select
    set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', p_sub, 'role', 'authenticated')::text,
      true
    );
$$;

select
  pg_temp.as_user ('a7900000-0000-4000-8000-0000000000a1');

select
  results_eq (
    $$select r.role, has_function_privilege(r.role, 'app.post_movements_internal(jsonb)', 'execute')
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      order by 1$$,
    $$values ('anon', false), ('authenticated', false), ('service_role', false)$$,
    'the private poster is not granted to API roles'
  );

select
  results_eq (
    $$select r.role, has_function_privilege(r.role, 'app.post_movements(jsonb)', 'execute')
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      order by 1$$,
    $$values ('anon', false), ('authenticated', true), ('service_role', true)$$,
    'the public poster keeps its grants'
  );

select
  results_eq (
    $$select r.role, has_function_privilege(r.role, 'app.activate_inventory(uuid,text,uuid[])', 'execute')
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      order by 1$$,
    $$values ('anon', false), ('authenticated', true), ('service_role', false)$$,
    'only an authenticated session can call activate_inventory'
  );

select
  results_eq (
    $$select r.role, has_function_privilege(r.role, 'app.record_accounting_recompute_timeout(uuid,text,integer)', 'execute')
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      order by 1$$,
    $$values ('anon', false), ('authenticated', true), ('service_role', true)$$,
    'the timeout recorder is owner or service'
  );

select
  has_trigger (
    'app',
    'stock_items',
    'trg_stock_items_insert_lock',
    'a catalog insert takes the ledger lock'
  );

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000010',
      app.opening_manifest_token(),
      '{}'::uuid[]
    )$$,
    '22023',
    'empty roster',
    'an empty catalog is refused'
  );

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'a7900000-0000-4000-8000-000000000001',
    'سمك تفعيل',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'a7900000-0000-4000-8000-000000000002',
    'علبة تفعيل',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'a7900000-0000-4000-8000-000000000003',
    'صفر تفعيل',
    'seafood',
    'kg',
    'daily'
  );

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000011',
      app.opening_manifest_token(),
      array[
        'a7900000-0000-4000-8000-000000000001',
        'a7900000-0000-4000-8000-000000000002',
        'a7900000-0000-4000-8000-000000000003'
      ]::uuid[]
    )$$,
    '22023',
    'a positive opening is required',
    'an all-zero catalog is refused'
  );

insert into
  app.opening_stocks (id, request_id, occurred_at)
values
  (
    'a7900000-0000-4000-8000-000000000020',
    'a7900000-0000-4000-8000-000000000021',
    '2026-03-01 08:00:00+00'
  );

insert into
  app.opening_stock_lines (
    opening_id,
    line_no,
    item_id,
    quantity,
    unit,
    unit_cost
  )
values
  (
    'a7900000-0000-4000-8000-000000000020',
    1,
    'a7900000-0000-4000-8000-000000000002',
    2,
    'box',
    10
  );

insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost
  )
values
  (
    'a7900000-0000-4000-8000-000000000020',
    'a7900000-0000-4000-8000-000000000002',
    'opening',
    '2026-03-01 08:00:00+00',
    20,
    1,
    20
  );

select
  app.record_opening_stock (
    '2026-04-01 08:00:00+00',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'a7900000-0000-4000-8000-000000000001',
        'quantity',
        '4',
        'unit',
        'kg',
        'unit_cost',
        '10',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'a7900000-0000-4000-8000-000000000022'
  );

select
  is (
    app.opening_activation_review (null, 100) ->> 'can_activate',
    'false',
    'a missing opening keeps activation impossible'
  );

select
  is (
    app.opening_activation_review (null, 1) ->> 'opening_manifest_hash',
    app.opening_activation_review (
      (
        app.opening_activation_review (null, 1) ->> 'next_item_id'
      )::uuid,
      1
    ) ->> 'opening_manifest_hash',
    'every review page carries the same manifest token'
  );

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000012',
      repeat('b', 32),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    )$$,
    '40001',
    'opening manifest changed',
    'a stale token is refused'
  );

select
  pg_temp.as_user ('a7900000-0000-4000-8000-0000000000a2');

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000013',
      app.opening_manifest_token(),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    )$$,
    '42501',
    'insufficient_privilege',
    'a signed-in user who is not the owner is refused'
  );

select
  pg_temp.as_user ('a7900000-0000-4000-8000-0000000000a1');

savepoint repeated_line;

insert into
  app.opening_stock_lines (
    opening_id,
    line_no,
    item_id,
    quantity,
    unit,
    unit_cost
  )
values
  (
    'a7900000-0000-4000-8000-000000000020',
    2,
    'a7900000-0000-4000-8000-000000000002',
    1,
    'box',
    10
  );

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000014',
      app.opening_manifest_token(),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    )$$,
    '22023',
    'repeated opening',
    'two opening lines for one item are refused'
  );

rollback to savepoint repeated_line;

savepoint bad_unit;

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'a7900000-0000-4000-8000-000000000004',
    'وحدة تفعيل',
    'seafood',
    'kg',
    'daily'
  );

insert into
  app.opening_stocks (id, request_id, occurred_at)
values
  (
    'a7900000-0000-4000-8000-000000000040',
    'a7900000-0000-4000-8000-000000000041',
    '2026-03-02 08:00:00+00'
  );

insert into
  app.opening_stock_lines (
    opening_id,
    line_no,
    item_id,
    quantity,
    unit,
    unit_cost
  )
values
  (
    'a7900000-0000-4000-8000-000000000040',
    1,
    'a7900000-0000-4000-8000-000000000004',
    2,
    'kg',
    10
  );

insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost
  )
values
  (
    'a7900000-0000-4000-8000-000000000040',
    'a7900000-0000-4000-8000-000000000004',
    'opening',
    '2026-03-02 08:00:00+00',
    20,
    1,
    20
  );

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000015',
      app.opening_manifest_token(),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    )$$,
    '22023',
    'item base unit changed',
    'a base-unit line whose movement quantity differs is refused'
  );

rollback to savepoint bad_unit;

savepoint legacy_row;

insert into
  app.inventory_activation (
    stock_started_at,
    approved_by,
    request_id,
    opening_manifest_hash
  )
values
  (
    '2026-03-01 08:00:00+00',
    'a7900000-0000-4000-8000-0000000000a1',
    'a7900000-0000-4000-8000-000000000016',
    repeat('d', 32)
  );

select
  is (
    (
      select
        item #>> '{observation,quantity}'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'roster'
        ) item
      where
        item ->> 'item_id' = 'a7900000-0000-4000-8000-000000000002'
    ),
    '2',
    'a direct activation with no observations keeps the opening line'
  );

rollback to savepoint legacy_row;

savepoint unreceipted_sale;

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'a7900000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-04-02 08:00:00+00',
        'quantity',
        1
      )
    )
  );

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000017',
      app.opening_manifest_token(),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    )$$,
    '22023',
    'unreceipted outflows',
    'a sale with no receipt blocks activation'
  );

rollback to savepoint unreceipted_sale;

select
  app.activate_inventory (
    'a7900000-0000-4000-8000-000000000018',
    app.opening_manifest_token (),
    array['a7900000-0000-4000-8000-000000000003']::uuid[]
  );

select
  is (
    (
      select
        stock_started_at
      from
        app.inventory_activation
    ),
    '2026-03-01 08:00:00+00'::timestamptz,
    'the global start is the earliest positive opening'
  );

select
  is (
    (
      select
        quantity
      from
        app.inventory_opening_observations
      where
        item_id = 'a7900000-0000-4000-8000-000000000002'
    ),
    20::numeric,
    'a converted opening stores the movement base quantity'
  );

select
  is (
    (
      select
        item #>> '{observation,explicit_zero}'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'roster'
        ) item
      where
        item ->> 'item_id' = 'a7900000-0000-4000-8000-000000000003'
    ),
    'true',
    'a stored zero is an observation'
  );

select
  is (
    (
      select
        item ->> 'missing'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'roster'
        ) item
      where
        item ->> 'item_id' = 'a7900000-0000-4000-8000-000000000003'
    ),
    'false',
    'a stored zero is not a missing opening'
  );

select
  is (
    app.activate_inventory (
      'a7900000-0000-4000-8000-000000000018',
      app.opening_manifest_digest (false),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    ) ->> 'activated',
    'true',
    'the same request returns the stored result'
  );

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000018',
      repeat('c', 32),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    )$$,
    '22023',
    'request id was used for a different activation',
    'the same request id cannot change its payload'
  );

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000019',
      app.opening_manifest_token(),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    )$$,
    '22023',
    'inventory is already activated',
    'a second activation is refused'
  );

select
  throws_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'a7900000-0000-4000-8000-000000000001',
      'movement_type', 'sale',
      'occurred_at', '2026-05-01 08:00:00+00',
      'quantity', 1
    )))$$,
    '22023',
    'disallowed movement_type in post_movements: sale',
    'a public sale is refused after activation'
  );

select
  throws_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'a7900000-0000-4000-8000-000000000001',
      'movement_type', 'count_adjustment',
      'occurred_at', '2026-05-01 08:00:00+00',
      'quantity', -1
    )))$$,
    '22023',
    'disallowed movement_type in post_movements: count_adjustment',
    'a public count adjustment is refused after activation'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'a7900000-0000-4000-8000-000000000001',
      'movement_type', 'purchase',
      'occurred_at', '2026-05-01 08:00:00+00',
      'quantity', 1,
      'unit_cost', 10
    )))$$,
    'a purchase stays on the public poster after activation'
  );

select
  lives_ok (
    $$select app.post_movements_internal(jsonb_build_array(jsonb_build_object(
      'item_id', 'a7900000-0000-4000-8000-000000000001',
      'movement_type', 'count_adjustment',
      'occurred_at', '2026-05-02 08:00:00+00',
      'quantity', -1
    )))$$,
    'the private poster can still post a count adjustment'
  );

select
  finish ();

rollback;
