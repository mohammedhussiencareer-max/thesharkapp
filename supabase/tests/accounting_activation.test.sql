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
    $$select r.role, has_function_privilege(r.role, 'app.accounting_scaling_ready()', 'execute')
      from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r (role)
      order by 1$$,
    $$values ('anon', false), ('authenticated', false), ('public', false), ('service_role', false)$$,
    'no API role can call accounting_scaling_ready'
  );

select
  is (
    app.accounting_scaling_ready (),
    false,
    'scaling stays unready until the checkpoint migration replaces the function'
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

savepoint scaling_not_ready;

select
  throws_ok (
    $$select app.activate_inventory(
      'a7900000-0000-4000-8000-000000000018',
      app.opening_manifest_token(),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    )$$,
    '55000',
    'scaling is not ready',
    'a new activation is refused while scaling is not ready'
  );

select
  is (
    (
      select
        count(*)
      from
        app.inventory_activation
    ),
    0::bigint,
    'a readiness refusal writes no activation row'
  );

select
  is (
    (
      select
        count(*)
      from
        app.inventory_opening_observations
    ),
    0::bigint,
    'a readiness refusal writes no observation'
  );

select
  is (
    (
      select
        count(*)
      from
        app.inventory_activation_requests
    ),
    0::bigint,
    'a readiness refusal writes no request'
  );

create or replace function app.accounting_scaling_ready () returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    true;
$$;

select
  app.activate_inventory (
    'a7900000-0000-4000-8000-000000000018',
    app.opening_manifest_token (),
    array['a7900000-0000-4000-8000-000000000003']::uuid[]
  );

create or replace function app.accounting_scaling_ready () returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    false;
$$;

select
  is (
    app.activate_inventory (
      'a7900000-0000-4000-8000-000000000018',
      app.opening_manifest_token (),
      array['a7900000-0000-4000-8000-000000000003']::uuid[]
    ) ->> 'activated',
    'true',
    'a stored activation is returned while scaling is not ready'
  );

rollback to savepoint scaling_not_ready;

create or replace function app.accounting_scaling_ready () returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    true;
$$;

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

-- An order posted after the stock start, then corrected to before it. The
-- count keeps waiting while the posted effect is still after the start, and
-- stops only after the worker reverses that effect.
select
  app.set_item_loss (
    md5('loss|p79-fish')::uuid,
    'a7900000-0000-4000-8000-000000000001',
    0,
    '2026-01-01 00:00:00+00',
    null,
    (
      select
        app.schedule_token (
          'loss',
          'a7900000-0000-4000-8000-000000000001',
          null
        )
    ),
    'fixture'
  );

select
  app.set_pos_option_policy (
    md5('opt|p79-fish')::uuid,
    'p79-fish',
    '["none"]'::jsonb,
    '2026-01-01 00:00:00+00',
    null,
    'none_expected',
    (
      select
        app.pos_base_schedule ('p79-fish', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_base_packaging (
    md5('bpk|p79-fish')::uuid,
    'p79-fish',
    '["none"]'::jsonb,
    '2026-01-01 00:00:00+00',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_base_schedule ('p79-fish', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_pos_base_mapping (
    md5('map|p79-fish')::uuid,
    'p79-fish',
    '["none"]'::jsonb,
    '2026-01-01 00:00:00+00',
    null,
    jsonb_build_object(
      'stock_item_id',
      'a7900000-0000-4000-8000-000000000001',
      'quantity_per_basis',
      '1',
      'unit',
      'kg'
    ),
    (
      select
        app.pos_base_schedule ('p79-fish', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_order_type_packaging (
    md5('ot|hall-p79')::uuid,
    'hall',
    '2026-01-01 00:00:00+00',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_order_type_schedule ('hall') ->> 'token'
    ),
    'fixture'
  );

update app.accounting_rederive_spans
set
  completed_at = pg_catalog.clock_timestamp ()
where
  completed_at is null;

insert into
  app.pos_shifts (id, opened_at, is_active, pos_update_time)
values
  (
    'p79-shift',
    '2026-05-01 08:00:00+00',
    false,
    '2026-05-01 08:00:00+00'
  );

insert into
  app.pos_orders (
    id,
    shift_id,
    status,
    order_type,
    ordered_at,
    subtotal,
    discount,
    tax,
    service_tax,
    delivery_fee,
    total,
    pos_update_time,
    content_hash,
    missing_from_pos
  )
values
  (
    'p79-cross',
    'p79-shift',
    'complete',
    'hall',
    '2026-05-02 10:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-05-02 10:00:00+00',
    rpad(md5('p79-cross'), 64, 'a'),
    false
  );

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    options,
    line_total
  )
values
  (
    'p79-cross',
    'l1',
    'p79-fish',
    'x',
    1,
    '[]'::jsonb,
    0
  );

select
  app.append_pos_cost_input ('p79-cross', null, 'sync');

select
  is (
    (
      app.run_accounting_work (
        gen_random_uuid(),
        1,
        app.accounting_next_work () -> 'head' ->> 'order_id',
        (
          app.accounting_next_work () -> 'head' ->> 'work_generation'
        )::integer
      ) ->> 'applied'
    )::integer,
    1,
    'the order posts after the stock start'
  );

insert into
  app.stock_counts (id, request_id, frequency, counted_at)
values
  (
    'a7900000-0000-4000-8000-000000000030',
    'a7900000-0000-4000-8000-000000000031',
    'daily',
    '2026-05-10 08:00:00+00'
  );

select
  is (
    app.stock_count_derivation_detail ('a7900000-0000-4000-8000-000000000030') ->> 'waiting_for_processing',
    'false',
    'a processed order after the start does not keep the count waiting'
  );

update app.pos_orders
set
  version = version + 1,
  ordered_at = '2026-02-01 10:00:00+00',
  pos_update_time = pos_update_time + interval '1 minute',
  content_hash = rpad(md5('p79-cross-2'), 64, 'b')
where
  id = 'p79-cross';

select
  app.capture_pos_order_snapshot ('p79-cross', null, 'sync');

select
  app.append_pos_cost_input ('p79-cross', null, 'sync');

select
  is (
    app.stock_count_derivation_detail ('a7900000-0000-4000-8000-000000000030') ->> 'waiting_for_processing',
    'true',
    'the count still waits while the posted effect is after the stock start'
  );

select
  ok (
    (
      select
        application.occurred_at
      from
        app.order_cost_state head
        join app.order_cost_applications application on application.id = head.owner_application_id
      where
        head.order_id = 'p79-cross'
    ) >= '2026-03-01 08:00:00+00',
    'the owner application has not yet moved before the stock start'
  );

select
  is (
    (
      app.run_accounting_work (
        gen_random_uuid(),
        1,
        app.accounting_next_work () -> 'head' ->> 'order_id',
        (
          app.accounting_next_work () -> 'head' ->> 'work_generation'
        )::integer
      ) ->> 'none'
    )::integer,
    1,
    'the worker reverses the sale once the order is before the stock start'
  );

select
  is (
    app.stock_count_derivation_detail ('a7900000-0000-4000-8000-000000000030') ->> 'waiting_for_processing',
    'false',
    'the count stops waiting after the old effect is reversed'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'a7900000-0000-4000-8000-000000000001'
        and movement.movement_type = 'sale'
        and movement.reverses_movement_id is null
        and not exists (
          select
            1
          from
            app.stock_movements reversal
          where
            reversal.reverses_movement_id = movement.id
        )
    ),
    0::bigint,
    'no live sale remains for the order that moved before the stock start'
  );

select
  finish ();

rollback;
