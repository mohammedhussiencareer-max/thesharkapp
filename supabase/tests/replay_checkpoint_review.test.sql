-- Codex review fixes. Synthetic ids only.
begin;

set
  statement_timeout = 0;

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
    'c5500000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-c55@theshark.test',
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
  ('c5500000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c5500000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'c5500000-0000-4000-8000-000000000001',
    'c55 fish',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5500000-0000-4000-8000-000000000002',
    'c55 no cost',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5500000-0000-4000-8000-000000000003',
    'c55 cover',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5500000-0000-4000-8000-000000000004',
    'c55 cap',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c5500000-0000-4000-8000-000000000006',
    'c55 sort mixed',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c5500000-0000-4000-8000-000000000008',
    'c55 limit',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5500000-0000-4000-8000-000000000009',
    'c55 batch',
    'seafood',
    'kg',
    'daily'
  );

insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    parent_item_id
  )
values
  (
    'c5500000-0000-4000-8000-000000000005',
    'c55 cap size',
    'fish_size',
    'kg',
    'daily',
    'c5500000-0000-4000-8000-000000000004'
  ),
  (
    'c5500000-0000-4000-8000-000000000007',
    'c55 sort size',
    'fish_size',
    'kg',
    'daily',
    'c5500000-0000-4000-8000-000000000006'
  );

select
  app.set_item_opening_price (
    'c5500000-0000-4000-8000-000000000101',
    'c5500000-0000-4000-8000-000000000001',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'c5500000-0000-4000-8000-000000000103',
    'c5500000-0000-4000-8000-000000000003',
    10,
    null,
    null,
    'kg|seafood||'
  );

-- Finding 2. Balance 0, seed 10, a closed sale of 5 stored at -50.
insert into
  app.item_balances (item_id, on_hand_qty, on_hand_value, avg_cost)
values
  ('c5500000-0000-4000-8000-000000000001', 0, 0, 0);

select
  app.insert_closed_movement (
    'c5500000-0000-4000-8000-0000000000c2',
    'c5500000-0000-4000-8000-000000000001',
    '2026-09-01 08:00:00+00',
    -5,
    -50,
    'cogs',
    'sale',
    null,
    'order',
    'c55-fixed',
    null,
    null,
    null,
    null,
    null,
    0,
    0
  );

select
  app.replay_execute (
    array['c5500000-0000-4000-8000-000000000001']::uuid[],
    '[]'::jsonb,
    'c5500000-0000-4000-8000-0000000000c2',
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
        movement.item_id = 'c5500000-0000-4000-8000-000000000001'
        and movement.movement_type = 'cost_adjustment'
    ),
    0::bigint,
    'a closed outflow keeps its stored value and opens the deficit'
  );

select
  is (
    (
      select
        deficit.qty_uncovered::text || '/' || deficit.value_uncovered::text
      from
        app.provisional_deficits deficit
      where
        deficit.item_id = 'c5500000-0000-4000-8000-000000000001'
    ),
    '5.000000/50.00',
    'the closed outflow deficit keeps the stored value'
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'c5500000-0000-4000-8000-000000000001'
    ),
    '-5.000000/-50.00',
    'the closed outflow balance matches the stored row'
  );

-- Finding 4. In-window sale 10, purchase 5 at 20, sale 1, then a second purchase.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5500000-0000-4000-8000-000000000003',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-01T08:00:00Z',
        'quantity',
        10
      )
    )
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-02T08:00:00Z',
      'request_id',
      'c5500000-0000-4000-8000-000000000201',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000003',
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
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5500000-0000-4000-8000-000000000003',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        1
      )
    )
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-04T08:00:00Z',
      'request_id',
      'c5500000-0000-4000-8000-000000000202',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000003',
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
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5500000-0000-4000-8000-000000000003'
    ),
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5500000-0000-4000-8000-000000000003'
    ),
    'a second partial cover keeps the ledger equal to the balance'
  );

select
  ok (
    exists (
      select
        1
      from
        app.replay_checkpoint_invalidations invalidation
        join app.replay_checkpoints
      checkpoint on checkpoint.id = invalidation.checkpoint_id
      where
        checkpoint.item_id = 'c5500000-0000-4000-8000-000000000003'
        and invalidation.reason = 'cover'
    ),
    'an in-window cover invalidates checkpoints from the deficit'
  );

-- Finding 9. One old purchase and one future purchase in the same batch.
select
  app.post_backdated_batch (
    'c5500000-0000-4000-8000-0000000000b9',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5500000-0000-4000-8000-000000000009',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-09-01T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        10,
        'total_cost',
        10,
        'line_key',
        1
      ),
      jsonb_build_object(
        'item_id',
        'c5500000-0000-4000-8000-000000000009',
        'movement_type',
        'purchase',
        'occurred_at',
        '2030-01-01T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        10,
        'total_cost',
        10,
        'line_key',
        2,
        'batch_id',
        'c5500000-0000-4000-8000-0000000000b9'
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
        movement.item_id = 'c5500000-0000-4000-8000-000000000009'
        and movement.movement_type = 'closed_period'
        and movement.occurred_at > '2026-11-01T00:00:00Z'
    ),
    1::bigint,
    'a mixed batch posts the old line as a closed cause'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5500000-0000-4000-8000-000000000009'
        and movement.movement_type = 'purchase'
        and movement.occurred_at = '2030-01-01T08:00:00Z'
    ),
    1::bigint,
    'a mixed batch keeps the in-window line on its own day'
  );

-- Finding 10. Overflow follows consumption, not the sort.
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T08:00:00Z',
      'request_id',
      'c5500000-0000-4000-8000-000000000210',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000004',
          'quantity',
          '10',
          'unit',
          'kg',
          'amount_paid',
          '1000.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5500000-0000-4000-8000-000000000004',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-02T08:00:00Z',
        'quantity',
        5
      )
    )
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5500000-0000-4000-8000-000000000211',
      'mixed_item_id',
      'c5500000-0000-4000-8000-000000000004',
      'occurred_at',
      '2026-11-02T09:00:00Z',
      'qty_taken',
      '5',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000005',
          'quantity',
          '5'
        )
      )
    )
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-03T08:00:00Z',
      'request_id',
      'c5500000-0000-4000-8000-000000000212',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000004',
          'quantity',
          '10',
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
        allocation ->> 'sort_transfer'
      from
        app.closed_allocation (
          'c5500000-0000-4000-8000-000000000004',
          (
            select
              purchase.id
            from
              app.stock_movements purchase
            where
              purchase.item_id = 'c5500000-0000-4000-8000-000000000004'
              and purchase.movement_type = 'purchase'
              and purchase.total_cost = 1000
          ),
          -999,
          0,
          10,
          '2026-11-01T08:00:00Z',
          pg_catalog.clock_timestamp ()
        ) allocation
    ),
    '-249.75',
    'cap overflow stays out of the sort transfer'
  );

-- Finding 11. Output 5/5, receipt +50, recognition -25, end 5/30.
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T08:00:00Z',
      'request_id',
      'c5500000-0000-4000-8000-000000000221',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000006',
          'quantity',
          '10',
          'unit',
          'kg',
          'amount_paid',
          '10.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5500000-0000-4000-8000-000000000222',
      'mixed_item_id',
      'c5500000-0000-4000-8000-000000000006',
      'occurred_at',
      '2026-11-02T08:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000007',
          'quantity',
          '10'
        )
      )
    )
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5500000-0000-4000-8000-000000000007',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        5
      )
    )
  );

select
  lives_ok (
    $$select app.post_closed_document_correction(
      null,
      'c5500000-0000-4000-8000-000000000006',
      (select purchase.id from app.stock_movements purchase
        where purchase.item_id = 'c5500000-0000-4000-8000-000000000006'
          and purchase.movement_type = 'purchase'),
      50,
      0,
      10,
      'purchase',
      'c55-sort-doc',
      'purchase',
      null,
      null,
      null
    )$$,
    'a sort correction applies the receipt before its recognition'
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'c5500000-0000-4000-8000-000000000007'
    ),
    '5.000000/30.00',
    'the sort output ends at 5/30'
  );

-- Finding 13. A valid checkpoint already holds the old anchors.
-- One line per count: a count cannot repeat an item.
insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost,
    is_provisional
  )
values
  (
    'c5500000-0000-4000-8000-000000000083',
    'c5500000-0000-4000-8000-000000000008',
    'purchase',
    '2026-11-01 08:00:00+00',
    10,
    10,
    100,
    false
  );

insert into
  app.stock_counts (id, request_id, frequency, counted_at)
select
  (
    'c5510000-0000-4000-8000-' || pg_catalog.lpad (g.n::text, 12, '0')
  )::uuid,
  (
    'c5520000-0000-4000-8000-' || pg_catalog.lpad (g.n::text, 12, '0')
  )::uuid,
  'daily',
  '2026-11-01 07:00:00+00'
from
  pg_catalog.generate_series (1, 100001) as g (n);

insert into
  app.stock_count_lines (
    count_id,
    line_no,
    item_id,
    expected_base_unit,
    counted_qty,
    expected_qty,
    delta_qty,
    delta_value
  )
select
  (
    'c5510000-0000-4000-8000-' || pg_catalog.lpad (g.n::text, 12, '0')
  )::uuid,
  1,
  'c5500000-0000-4000-8000-000000000008',
  'kg',
  10,
  10,
  0,
  0
from
  pg_catalog.generate_series (1, 100001) as g (n);

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
  'c5500000-0000-4000-8000-000000000008',
  '2026-11-01 08:00:00+00',
  purchase.id,
  10,
  100,
  10,
  true,
  false,
  100001,
  'review'
from
  app.stock_movements purchase
where
  purchase.item_id = 'c5500000-0000-4000-8000-000000000008'
  and purchase.movement_type = 'purchase';

insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost,
    is_provisional
  )
values
  (
    'c5500000-0000-4000-8000-000000000084',
    'c5500000-0000-4000-8000-000000000008',
    'sale',
    '2026-11-02 08:00:00+00',
    -1,
    10,
    -10,
    false
  );

insert into
  app.item_balances (item_id, on_hand_qty, on_hand_value, avg_cost)
values
  ('c5500000-0000-4000-8000-000000000008', 9, 90, 10);

select
  lives_ok (
    $$select app.replay_execute(
      array['c5500000-0000-4000-8000-000000000008']::uuid[],
      '[]'::jsonb,
      'c5500000-0000-4000-8000-0000000000c3',
      true
    )$$,
    'anchors already inside a checkpoint do not trip the recompute limit'
  );

-- Finding 15.
select
  ok (
    pg_catalog.strpos (
      pg_catalog.pg_get_functiondef ('app.ingest_pos_batch'::regproc),
      'pg_sleep'
    ) = 0,
    'ingest_pos_batch does not sleep'
  );

-- Finding 5, empty bound.
savepoint empty_bound;

insert into
  app.activation_history_bound (bound_at, stock_started_at)
values
  (
    '2026-11-01 00:00:00+00',
    '2026-08-01 00:00:00+00'
  );

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
    1::bigint,
    'an empty activation bound sets the loaded marker'
  );

rollback to savepoint empty_bound;

-- Orders, waste, and the frozen-input exemption.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'c5500000-0000-4000-8000-000000000011',
    'c55 order fish',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5500000-0000-4000-8000-000000000012',
    'c55 waste fish',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'c5500000-0000-4000-8000-000000000111',
    'c5500000-0000-4000-8000-000000000011',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'c5500000-0000-4000-8000-000000000112',
    'c5500000-0000-4000-8000-000000000012',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_loss (
    'c5500000-0000-4000-8000-000000000121',
    'c5500000-0000-4000-8000-000000000011',
    0,
    '2026-08-01 00:00:00+00',
    null,
    (
      select
        app.schedule_token (
          'loss',
          'c5500000-0000-4000-8000-000000000011',
          null
        )
    ),
    'fixture'
  );

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
    'c55-shift',
    '2026-08-01 00:00:00+00',
    null,
    true,
    '2026-08-01 00:00:00+00'
  );

select
  app.set_pos_option_policy (
    'c5500000-0000-4000-8000-000000000131',
    'c55-pos',
    '["none"]'::jsonb,
    '2026-08-01 00:00:00+00',
    null,
    'none_expected',
    (
      select
        app.pos_base_schedule ('c55-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_base_packaging (
    'c5500000-0000-4000-8000-000000000132',
    'c55-pos',
    '["none"]'::jsonb,
    '2026-08-01 00:00:00+00',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_base_schedule ('c55-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_pos_base_mapping (
    'c5500000-0000-4000-8000-000000000133',
    'c55-pos',
    '["none"]'::jsonb,
    '2026-08-01 00:00:00+00',
    null,
    jsonb_build_object(
      'stock_item_id',
      'c5500000-0000-4000-8000-000000000011',
      'quantity_per_basis',
      '1',
      'unit',
      'kg'
    ),
    (
      select
        app.pos_base_schedule ('c55-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_pos_option_policy (
    'c5500000-0000-4000-8000-000000000134',
    'c55-pos-2',
    '["none"]'::jsonb,
    '2026-08-01 00:00:00+00',
    null,
    'none_expected',
    (
      select
        app.pos_base_schedule ('c55-pos-2', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_base_packaging (
    'c5500000-0000-4000-8000-000000000135',
    'c55-pos-2',
    '["none"]'::jsonb,
    '2026-08-01 00:00:00+00',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_base_schedule ('c55-pos-2', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_pos_base_mapping (
    'c5500000-0000-4000-8000-000000000136',
    'c55-pos-2',
    '["none"]'::jsonb,
    '2026-08-01 00:00:00+00',
    null,
    jsonb_build_object(
      'stock_item_id',
      'c5500000-0000-4000-8000-000000000002',
      'quantity_per_basis',
      '1',
      'unit',
      'kg'
    ),
    (
      select
        app.pos_base_schedule ('c55-pos-2', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_order_type_packaging (
    'c5500000-0000-4000-8000-000000000137',
    'hall',
    '2026-08-01 00:00:00+00',
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
    'c55-frozen',
    'c55-shift',
    'complete',
    'hall',
    '2026-09-01 08:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-09-01 08:00:00+00',
    rpad(md5('c55-frozen'), 64, 'a'),
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
    'c55-frozen',
    'l1-c55-frozen',
    'c55-pos',
    'x',
    10,
    '[]'::jsonb,
    0
  );

select
  app.append_pos_cost_input ('c55-frozen', null, 'sync');

insert into
  app.inventory_activation (
    stock_started_at,
    approved_by,
    request_id,
    opening_manifest_hash
  )
values
  (
    '2026-08-01 00:00:00+00',
    'c5500000-0000-4000-8000-0000000000a1',
    'c5500000-0000-4000-8000-0000000000e1',
    repeat('b', 32)
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
    'c55-new',
    'c55-shift',
    'complete',
    'hall',
    '2026-09-02 08:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-09-02 08:00:00+00',
    rpad(md5('c55-new'), 64, 'a'),
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
    'c55-new',
    'l1-c55-new',
    'c55-pos',
    'x',
    4,
    '[]'::jsonb,
    0
  );

select
  app.append_pos_cost_input ('c55-new', null, 'sync');

select
  is (
    (
      select
        app.process_order_accounting ('c55-new', pg_catalog.gen_random_uuid (), 1) ->> 'outcome'
    ),
    'applied',
    'a newly discovered old order posts while a frozen input is still unposted'
  );

select
  is (
    (
      select
        movement.movement_type::text
      from
        app.stock_movements movement
      where
        movement.source_id = 'c55-new'
      order by
        movement.id
      limit
        1
    ),
    'closed_period',
    'a new old order is a closed cause while a frozen input is still unposted'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.source_id = 'c55-new'
        and movement.movement_type = 'sale'
    ),
    0::bigint,
    'a new old order is not posted on its old day'
  );

update app.accounting_rederive_spans
set
  completed_at = pg_catalog.clock_timestamp ()
where
  completed_at is null;

select
  app.run_accounting_work (
    pg_catalog.gen_random_uuid (),
    1,
    'c55-frozen',
    (
      select
        pending.eff_generation
      from
        app.accounting_order_pending ('c55-frozen') pending
    )
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_movement_links link
        join app.stock_movements movement on movement.id = link.movement_id
      where
        link.order_id = 'c55-frozen'
        and movement.movement_type = 'sale'
        and movement.occurred_at = '2026-09-01 08:00:00+00'
        and movement.quantity = -10
    ),
    1::bigint,
    'an unposted frozen input is posted on its own day'
  );

update app.pos_orders
set
  version = version + 1,
  pos_update_time = pos_update_time + interval '1 minute',
  content_hash = rpad(md5('c55-frozen-2'), 64, 'b')
where
  id = 'c55-frozen';

update app.pos_order_lines
set
  quantity = 12
where
  order_id = 'c55-frozen';

select
  app.capture_pos_order_snapshot ('c55-frozen', null, 'sync');

select
  app.append_pos_cost_input ('c55-frozen', null, 'sync');

select
  is (
    app.order_processing_input_id ('c55-frozen'),
    (
      select
        input.id
      from
        app.pos_cost_inputs input
      where
        input.order_id = 'c55-frozen'
      order by
        input.input_revision desc
      limit
        1
    ),
    'a posted frozen input does not toggle back to the frozen cost input'
  );

select
  is (
    app.order_processing_input_id ('c55-frozen'),
    app.order_processing_input_id ('c55-frozen'),
    'a second read of a posted frozen input stays on the latest input'
  );

select
  app.run_accounting_work (
    pg_catalog.gen_random_uuid (),
    1,
    'c55-frozen',
    (
      select
        pending.eff_generation
      from
        app.accounting_order_pending ('c55-frozen') pending
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
        movement.item_id = 'c5500000-0000-4000-8000-000000000011'
        and movement.movement_type = 'sale_reversal'
    ),
    0::bigint,
    'a closed order edit does not reverse the original'
  );

select
  is (
    (
      select
        movement.quantity
      from
        app.stock_movements movement
      where
        movement.source_id = 'c55-frozen'
        and movement.movement_type = 'closed_period'
    ),
    -2::numeric,
    'a closed order edit posts the quantity difference'
  );

-- Finding 1. Recognized 10, the order now requires 12.
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
    'c55-span',
    'c55-shift',
    'complete',
    'hall',
    '2026-09-03 08:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-09-03 08:00:00+00',
    rpad(md5('c55-span'), 64, 'a'),
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
    'c55-span',
    'l1-c55-span',
    'c55-pos',
    'x',
    12,
    '[]'::jsonb,
    0
  );

select
  app.append_pos_cost_input ('c55-span', null, 'sync');

insert into
  app.recognized_contribution (
    source_kind,
    source_id,
    item_id,
    bucket,
    quantity,
    amount
  )
values
  (
    'order',
    'c55-span',
    'c5500000-0000-4000-8000-000000000011',
    'cogs',
    10,
    100
  );

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'c5500000-0000-4000-8000-000000000141',
    'owner',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into
  app.accounting_rederive_spans (
    family,
    version_id,
    cause,
    change_id,
    effective_from
  )
select
  'pos_map',
  'c5500000-0000-4000-8000-000000000142',
  'insert',
  change.id,
  '2026-08-01 00:00:00+00'
from
  app.costing_changes change
where
  change.request_id = 'c5500000-0000-4000-8000-000000000141';

insert into
  app.closed_span_orders (span_id, order_id, ordered_at)
select
  span.id,
  'c55-span',
  '2026-09-03 08:00:00+00'
from
  app.accounting_rederive_spans span
  join app.costing_changes change on change.id = span.change_id
where
  change.request_id = 'c5500000-0000-4000-8000-000000000141';

select
  app.post_accumulated_closed_span (
    (
      select
        span.id
      from
        app.accounting_rederive_spans span
        join app.costing_changes change on change.id = span.change_id
      where
        change.request_id = 'c5500000-0000-4000-8000-000000000141'
    )
  );

select
  is (
    (
      select
        movement.quantity
      from
        app.stock_movements movement
      where
        movement.source_id = 'c55-span'
        and movement.movement_type = 'closed_period'
    ),
    -2::numeric,
    'a closed span posts the quantity difference, not the full requirement'
  );

-- Finding 7. The second line has no cost basis.
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
    'c55-miss',
    'c55-shift',
    'complete',
    'hall',
    '2026-09-04 08:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-09-04 08:00:00+00',
    rpad(md5('c55-miss'), 64, 'a'),
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
    'c55-miss',
    'l1-c55-miss',
    'c55-pos',
    'x',
    3,
    '[]'::jsonb,
    0
  ),
  (
    'c55-miss',
    'l2-c55-miss',
    'c55-pos-2',
    'x',
    3,
    '[]'::jsonb,
    0
  );

select
  app.append_pos_cost_input ('c55-miss', null, 'sync');

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'c5500000-0000-4000-8000-000000000143',
    'owner',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into
  app.accounting_rederive_spans (
    family,
    version_id,
    cause,
    change_id,
    effective_from
  )
select
  'pos_map',
  'c5500000-0000-4000-8000-000000000144',
  'insert',
  change.id,
  '2026-08-01 00:00:00+00'
from
  app.costing_changes change
where
  change.request_id = 'c5500000-0000-4000-8000-000000000143';

insert into
  app.closed_span_orders (span_id, order_id, ordered_at)
select
  span.id,
  'c55-miss',
  '2026-09-04 08:00:00+00'
from
  app.accounting_rederive_spans span
  join app.costing_changes change on change.id = span.change_id
where
  change.request_id = 'c5500000-0000-4000-8000-000000000143';

select
  app.post_accumulated_closed_span (
    (
      select
        span.id
      from
        app.accounting_rederive_spans span
        join app.costing_changes change on change.id = span.change_id
      where
        change.request_id = 'c5500000-0000-4000-8000-000000000143'
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
        movement.source_id = 'c55-miss'
    ),
    0::bigint,
    'a span with one missing cost basis writes no movement'
  );

select
  is (
    (
      select
        accumulated.cause_id is null
      from
        app.closed_span_orders accumulated
      where
        accumulated.order_id = 'c55-miss'
    ),
    true,
    'a span with one missing cost basis does not publish the cause'
  );

-- Finding 8. A closed waste correction and a cancellation.
select
  app.record_waste (
    'c5500000-0000-4000-8000-000000000151',
    jsonb_build_object(
      'occurred_at',
      '2026-09-01T08:00:00Z',
      'reason_code',
      'staff_meal',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000012',
          'quantity',
          '5',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.record_waste (
    'c5500000-0000-4000-8000-000000000152',
    jsonb_build_object(
      'occurred_at',
      '2026-09-01T08:00:00Z',
      'reason_code',
      'staff_meal',
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'c5500000-0000-4000-8000-000000000151'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000012',
          'quantity',
          '7',
          'unit',
          'kg'
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
        movement.item_id = 'c5500000-0000-4000-8000-000000000012'
        and movement.movement_type = 'waste_reversal'
    ),
    0::bigint,
    'a closed waste correction does not reverse the original day'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5500000-0000-4000-8000-000000000012'
        and movement.movement_type = 'closed_period'
        and movement.quantity = -2
    ),
    'a closed waste correction posts the quantity difference'
  );

select
  app.record_waste (
    'c5500000-0000-4000-8000-000000000153',
    jsonb_build_object(
      'occurred_at',
      '2026-09-02T08:00:00Z',
      'reason_code',
      'staff_meal',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5500000-0000-4000-8000-000000000012',
          'quantity',
          '4',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.record_waste (
    'c5500000-0000-4000-8000-000000000154',
    jsonb_build_object(
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'c5500000-0000-4000-8000-000000000153'
      ),
      'lines',
      '[]'::jsonb
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
        movement.item_id = 'c5500000-0000-4000-8000-000000000012'
        and movement.movement_type = 'waste_reversal'
    ),
    0::bigint,
    'a closed waste cancellation does not reverse the original day'
  );

select
  finish ();

rollback;
