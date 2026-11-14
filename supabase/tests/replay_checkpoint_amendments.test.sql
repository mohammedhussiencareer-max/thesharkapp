-- Amendment cases the first two checkpoint files do not cover.
-- Synthetic ids only. Q6 is not a special case and is not asserted here.
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
    'c5300000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-c53@theshark.test',
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
  ('c5300000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c5300000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'c5300000-0000-4000-8000-000000000001',
    'c53 average',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5300000-0000-4000-8000-000000000002',
    'c53 cover',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5300000-0000-4000-8000-000000000003',
    'c53 closed outflow',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5300000-0000-4000-8000-000000000004',
    'c53 wake',
    'seafood',
    'kg',
    'daily'
  );

-- An empty frozen set does not write the loaded marker.
savepoint empty_marker;

delete from app.activation_history_input;

delete from app.activation_history_loaded;

select
  app.maybe_mark_activation_loaded ();

select
  is (
    (
      select
        count(*)
      from
        app.activation_history_loaded
    ),
    0::bigint,
    'an empty activation bound does not set the loaded marker'
  );

rollback to savepoint empty_marker;

-- H. Seed sale, then a closed purchase of 5 kg at 100. Average becomes 20.
select
  app.set_item_opening_price (
    'c5300000-0000-4000-8000-000000000101',
    'c5300000-0000-4000-8000-000000000001',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5300000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-01T08:00:00Z',
        'quantity',
        5
      )
    )
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-09-01T08:00:00Z',
      'request_id',
      'c5300000-0000-4000-8000-000000000201',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5300000-0000-4000-8000-000000000001',
          'quantity',
          '5',
          'unit',
          'kg',
          'amount_paid',
          '100.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000001'
    ),
    0::numeric,
    'the closed purchase covers the seed sale down to quantity 0'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000001'
    ),
    0::numeric,
    'the closed purchase covers the seed sale down to value 0'
  );

select
  is (
    (
      select
        balance.avg_cost
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000001'
    ),
    20::numeric,
    'a full cover by a closed purchase sets the average to the inflow unit cost'
  );

select
  is (
    (
      select
        checkpoint.cost_known
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'c5300000-0000-4000-8000-000000000001'
        and not exists (
          select
            1
          from
            app.replay_checkpoint_invalidations invalidation
          where
            invalidation.checkpoint_id = checkpoint.id
        )
      order by
        checkpoint.cut_occurred_at desc,
        checkpoint.id desc
      limit
        1
    ),
    true,
    'the closed purchase checkpoint records cost_known'
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5300000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        '2030-01-01T08:00:00Z',
        'quantity',
        1
      )
    )
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000001'
    ),
    -1::numeric,
    'the sale after the closed purchase takes one kilogram'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000001'
    ),
    -20::numeric,
    'that sale is valued at 20 per kg'
  );

-- Q(a) and Q(f). Old deficit 5/50, later in-window deficit 2/20, purchase 5/100.
insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time
  )
values
  (
    'c53-cover',
    '2026-11-10 00:00:00+00',
    '2026-11-10 23:00:00+00',
    false,
    '2026-11-10 12:00:00+00'
  );

select
  app.set_item_opening_price (
    'c5300000-0000-4000-8000-000000000102',
    'c5300000-0000-4000-8000-000000000002',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5300000-0000-4000-8000-000000000002',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-09-01T08:00:00Z',
        'quantity',
        5
      )
    )
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5300000-0000-4000-8000-000000000002',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-01T08:00:00Z',
        'quantity',
        2
      )
    )
  );

insert into
  app.replay_checkpoints (
    item_id,
    cut_occurred_at,
    max_movement_id,
    on_hand_qty,
    on_hand_value,
    avg_cost,
    cost_known,
    has_uncovered_deficit,
    anchor_count,
    digest
  )
select
  'c5300000-0000-4000-8000-000000000002',
  '2026-11-12T08:00:00Z',
  movement.id,
  -7,
  -70,
  0,
  false,
  true,
  0,
  'c53-after'
from
  app.stock_movements movement
where
  movement.item_id = 'c5300000-0000-4000-8000-000000000002'
  and movement.occurred_at = '2026-11-01T08:00:00Z'
  and movement.movement_type = 'sale';

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5300000-0000-4000-8000-000000000002',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-10T12:00:00Z',
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
  );

select
  app.replay_execute (
    array['c5300000-0000-4000-8000-000000000002']::uuid[],
    '[]'::jsonb,
    'c5300000-0000-4000-8000-0000000000c2'::uuid,
    true
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000002'
    ),
    -2::numeric,
    'the mixed cover leaves quantity -2'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000002'
    ),
    -20::numeric,
    'the mixed cover leaves value -20'
  );

select
  is (
    (
      select
        deficit.qty_uncovered
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000002'
        and movement.occurred_at = '2026-11-01T08:00:00Z'
    ),
    2::numeric,
    'the in-window deficit stays open at 2 kg'
  );

select
  is (
    (
      select
        deficit.value_uncovered
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000002'
        and movement.occurred_at = '2026-11-01T08:00:00Z'
    ),
    20::numeric,
    'the in-window deficit stays open at 20'
  );

select
  is (
    (
      select
        count(*)
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000002'
        and movement.occurred_at = '2026-09-01T08:00:00Z'
        and deficit.qty_uncovered > 0
    ),
    0::bigint,
    'the old deficit is covered'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000002'
        and movement.cover_inflow_movement_id is not null
    ),
    1::bigint,
    'one cover-pair row is posted at the purchase'
  );

select
  is (
    (
      select
        movement.total_cost
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000002'
        and movement.cover_inflow_movement_id is not null
    ),
    -50::numeric,
    'the cover-pair row carries the -50 adjustment'
  );

select
  is (
    (
      select
        movement.occurred_at
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000002'
        and movement.cover_inflow_movement_id is not null
    ),
    '2026-11-10T12:00:00Z'::timestamptz,
    'the cover-pair row is dated on the purchase'
  );

select
  is (
    (
      select
        attribution.shift_id
      from
        app.movement_attributions attribution
        join app.stock_movements movement on movement.id = attribution.movement_id
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000002'
        and movement.cover_inflow_movement_id is not null
    ),
    'c53-cover',
    'the cover-pair row takes the shift that contains the purchase'
  );

select
  is (
    (
      select
        count(*)
      from
        app.replay_checkpoint_invalidations invalidation
        join app.replay_checkpoints
      checkpoint on checkpoint.id = invalidation.checkpoint_id
      where
        checkpoint.item_id = 'c5300000-0000-4000-8000-000000000002'
        and checkpoint.digest = 'c53-after'
    ),
    1::bigint,
    'a checkpoint after the covering inflow is invalidated'
  );

select
  is (
    (
      select
        count(*)
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'c5300000-0000-4000-8000-000000000002'
        and checkpoint.cut_occurred_at = '2026-11-01T08:00:00Z'
        and not exists (
          select
            1
          from
            app.replay_checkpoint_invalidations invalidation
          where
            invalidation.checkpoint_id = checkpoint.id
        )
    ),
    1::bigint,
    'a checkpoint between the old deficit and the inflow stays valid'
  );

create temp table q_cover_snap as
select
  (
    select
      balance.on_hand_qty
    from
      app.item_balances balance
    where
      balance.item_id = 'c5300000-0000-4000-8000-000000000002'
  ) as qty,
  (
    select
      balance.on_hand_value
    from
      app.item_balances balance
    where
      balance.item_id = 'c5300000-0000-4000-8000-000000000002'
  ) as value,
  (
    select
      count(*)
    from
      app.stock_movements movement
    where
      movement.item_id = 'c5300000-0000-4000-8000-000000000002'
  ) as movements;

select
  app.replay_execute (
    array['c5300000-0000-4000-8000-000000000002']::uuid[],
    '[]'::jsonb,
    'c5300000-0000-4000-8000-0000000000c3'::uuid,
    true
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000002'
    ),
    (
      select
        snap.qty
      from
        q_cover_snap snap
    ),
    'a second replay of the mixed cover keeps the quantity'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000002'
    ),
    (
      select
        snap.value
      from
        q_cover_snap snap
    ),
    'a second replay of the mixed cover keeps the value'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000002'
    ),
    (
      select
        snap.movements
      from
        q_cover_snap snap
    ),
    'a second replay of the mixed cover adds no row'
  );

-- I rule 2. A closed outflow's deficit is covered in the window.
select
  app.set_item_opening_price (
    'c5300000-0000-4000-8000-000000000103',
    'c5300000-0000-4000-8000-000000000003',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_closed_legs (
    null,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5300000-0000-4000-8000-000000000003',
        'quantity',
        -5,
        'total_cost',
        -50,
        'bucket',
        'cogs',
        'economic_kind',
        'sale'
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5300000-0000-4000-8000-000000000003',
        'movement_type',
        'purchase',
        'occurred_at',
        '2030-02-01T08:00:00Z',
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
  );

select
  app.replay_execute (
    array['c5300000-0000-4000-8000-000000000003']::uuid[],
    '[]'::jsonb,
    'c5300000-0000-4000-8000-0000000000c4'::uuid,
    true
  );

select
  is (
    (
      select
        coalesce(sum(adjustment.total_cost), 0)
      from
        app.stock_movements adjustment
        join app.stock_movements closed on closed.id = adjustment.adjusts_movement_id
      where
        closed.item_id = 'c5300000-0000-4000-8000-000000000003'
        and closed.movement_type = 'closed_period'
        and adjustment.movement_type = 'cost_adjustment'
    ),
    -50::numeric,
    'the in-window cover posts one net cost adjustment of -50 on the closed outflow'
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5300000-0000-4000-8000-000000000003'
    ),
    0::numeric,
    'the closed outflow is fully covered'
  );

create temp table q_outflow_snap as
select
  (
    select
      count(*)
    from
      app.stock_movements movement
    where
      movement.item_id = 'c5300000-0000-4000-8000-000000000003'
  ) as movements;

select
  app.replay_execute (
    array['c5300000-0000-4000-8000-000000000003']::uuid[],
    '[]'::jsonb,
    'c5300000-0000-4000-8000-0000000000c5'::uuid,
    true
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000003'
    ),
    (
      select
        snap.movements
      from
        q_outflow_snap snap
    ),
    'a second replay of the in-window cover adds nothing'
  );

-- E. A closed purchase wakes an order parked on missing_cost_basis.
insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'c5300000-0000-4000-8000-0000000000c0',
    'legacy',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into
  app.item_loss_versions (
    effective_from,
    created_change_id,
    item_id,
    loss_pct
  )
select
  '2000-01-01 00:00:00+00',
  change.id,
  'c5300000-0000-4000-8000-000000000004',
  0
from
  app.costing_changes change
where
  change.request_id = 'c5300000-0000-4000-8000-0000000000c0';

insert into
  app.pos_shifts (id, opened_at, is_active, pos_update_time)
values
  (
    'c53-shift',
    '2030-06-01T08:00:00Z',
    false,
    '2030-06-01T08:00:00Z'
  );

select
  app.set_pos_option_policy (
    'c5300000-0000-4000-8000-000000000301'::uuid,
    'c53-pos',
    '["none"]'::jsonb,
    '2030-01-01T00:00:00Z',
    null,
    'none_expected',
    (
      select
        app.pos_base_schedule ('c53-pos', '["none"]'::jsonb) ->> 'token'
    ),
    null
  );

select
  app.set_base_packaging (
    'c5300000-0000-4000-8000-000000000302'::uuid,
    'c53-pos',
    '["none"]'::jsonb,
    '2030-01-01T00:00:00Z',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_base_schedule ('c53-pos', '["none"]'::jsonb) ->> 'token'
    ),
    null
  );

select
  app.set_pos_base_mapping (
    'c5300000-0000-4000-8000-000000000303'::uuid,
    'c53-pos',
    '["none"]'::jsonb,
    '2030-01-01T00:00:00Z',
    null,
    jsonb_build_object(
      'stock_item_id',
      'c5300000-0000-4000-8000-000000000004',
      'quantity_per_basis',
      '1',
      'unit',
      'kg'
    ),
    (
      select
        app.pos_base_schedule ('c53-pos', '["none"]'::jsonb) ->> 'token'
    ),
    null
  );

select
  app.set_order_type_packaging (
    'c5300000-0000-4000-8000-000000000304'::uuid,
    'hall',
    '2030-01-01T00:00:00Z',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_order_type_schedule ('hall') ->> 'token'
    ),
    null
  );

insert into
  app.inventory_activation (
    stock_started_at,
    approved_by,
    request_id,
    opening_manifest_hash
  )
select
  '2020-01-01T00:00:00Z',
  'c5300000-0000-4000-8000-0000000000a1',
  'c5300000-0000-4000-8000-0000000000e1',
  repeat('a', 32)
where
  not exists (
    select
      1
    from
      app.inventory_activation
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
    'c53-nocost',
    'c53-shift',
    'complete',
    'hall',
    '2030-06-14T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-14T10:00:00Z',
    rpad(md5('c53-nocost'), 64, 'a'),
    false
  );

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    weighted_qty,
    weighted_unit,
    options,
    line_total
  )
values
  (
    'c53-nocost',
    'l1-c53-nocost',
    'c53-pos',
    'x',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  );

select
  app.append_pos_cost_input ('c53-nocost', null, 'sync');

select
  is (
    (
      app.run_accounting_work (
        gen_random_uuid(),
        1,
        'c53-nocost',
        (
          select
            queue.eff_generation
          from
            app.accounting_work_queue queue
          where
            queue.order_id = 'c53-nocost'
        )
      ) ->> 'blocked'
    )::integer,
    1,
    'an order with no cost basis is blocked'
  );

insert into
  app.item_balances (item_id, last_occurred_at)
values
  (
    'c5300000-0000-4000-8000-000000000004',
    '2030-01-01T00:00:00Z'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-09-01T08:00:00Z',
      'request_id',
      'c5300000-0000-4000-8000-000000000202',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5300000-0000-4000-8000-000000000004',
          'quantity',
          '5',
          'unit',
          'kg',
          'amount_paid',
          '100.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000004'
        and movement.movement_type = 'closed_period'
        and movement.closed_economic_kind = 'purchase'
    ),
    1::bigint,
    'the old purchase is posted as a closed_period receipt'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events event
      where
        event.order_id = 'c53-nocost'
        and event.cause = 'cost_basis'
        and event.source_key like 'closed:%'
        and event.processed_at is null
    ),
    1::bigint,
    'the closed purchase returns the blocked order to the queue'
  );

select
  is (
    (
      app.run_accounting_work (
        gen_random_uuid(),
        1,
        'c53-nocost',
        (
          select
            queue.eff_generation
          from
            app.accounting_work_queue queue
          where
            queue.order_id = 'c53-nocost'
        )
      ) ->> 'applied'
    )::integer,
    1,
    'the woken order is posted without a new POS change'
  );

select
  is (
    (
      select
        movement.total_cost
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5300000-0000-4000-8000-000000000004'
        and movement.movement_type = 'sale'
    ),
    -20::numeric,
    'the woken sale is valued at the closed purchase unit cost'
  );

select
  finish ();

rollback;
