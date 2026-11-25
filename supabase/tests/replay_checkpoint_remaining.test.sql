-- Q6, M, P, N, Q(b), Q(c), J, in-window equivalence, the activation marker,
-- and configuration-span accumulation. Synthetic ids only.
begin;

select
  set_config('app.test_clock', '2026-11-15 12:00:00+00', true);

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
    'c5400000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-c54@theshark.test',
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
  ('c5400000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c5400000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
select
  ('c5400000-0000-4000-8000-0000000000' || suffix)::uuid,
  'c54 ' || suffix,
  'seafood',
  'kg',
  'daily'
from
  (
    values
      ('01'),
      ('08'),
      ('02'),
      ('03'),
      ('04'),
      ('30'),
      ('31'),
      ('40')
  ) as item (suffix);

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'c5400000-0000-4000-8000-000000000010',
    'c54 raw 10',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c5400000-0000-4000-8000-000000000012',
    'c54 raw 12',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c5400000-0000-4000-8000-000000000014',
    'c54 raw 14',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c5400000-0000-4000-8000-000000000017',
    'c54 raw 17',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c5400000-0000-4000-8000-000000000020',
    'c54 raw 20',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c5400000-0000-4000-8000-000000000023',
    'c54 raw 23',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c5400000-0000-4000-8000-000000000026',
    'c54 raw 26',
    'fish_mixed',
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
    'c5400000-0000-4000-8000-000000000011',
    'c54 size 11',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000010'
  ),
  (
    'c5400000-0000-4000-8000-000000000013',
    'c54 size 13',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000012'
  ),
  (
    'c5400000-0000-4000-8000-000000000015',
    'c54 size 15',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000014'
  ),
  (
    'c5400000-0000-4000-8000-000000000016',
    'c54 size 16',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000014'
  ),
  (
    'c5400000-0000-4000-8000-000000000018',
    'c54 size 18',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000017'
  ),
  (
    'c5400000-0000-4000-8000-000000000021',
    'c54 size 21',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000020'
  ),
  (
    'c5400000-0000-4000-8000-000000000022',
    'c54 size 22',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000020'
  ),
  (
    'c5400000-0000-4000-8000-000000000024',
    'c54 size 24',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000023'
  ),
  (
    'c5400000-0000-4000-8000-000000000025',
    'c54 size 25',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000023'
  ),
  (
    'c5400000-0000-4000-8000-000000000027',
    'c54 size 27',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000026'
  ),
  (
    'c5400000-0000-4000-8000-000000000028',
    'c54 size 28',
    'fish_size',
    'kg',
    'daily',
    'c5400000-0000-4000-8000-000000000026'
  );

select
  app.set_item_opening_price (
    'c5400000-0000-4000-8000-000000000101',
    'c5400000-0000-4000-8000-000000000001',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'c5400000-0000-4000-8000-000000000108',
    'c5400000-0000-4000-8000-000000000008',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'c5400000-0000-4000-8000-000000000102',
    'c5400000-0000-4000-8000-000000000002',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'c5400000-0000-4000-8000-000000000103',
    'c5400000-0000-4000-8000-000000000003',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'c5400000-0000-4000-8000-000000000104',
    'c5400000-0000-4000-8000-000000000004',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'c5400000-0000-4000-8000-000000000131',
    'c5400000-0000-4000-8000-000000000031',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'c5400000-0000-4000-8000-000000000140',
    'c5400000-0000-4000-8000-000000000040',
    10,
    null,
    null,
    'kg|seafood||'
  );

-- Q6. Two open deficits. The return belongs to the later sale, so that
-- deficit is cancelled and the earlier one stays open.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000001',
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
        'c5400000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-09-02T08:00:00Z',
        'quantity',
        3
      )
    )
  );

select
  app.insert_closed_movement (
    'c5400000-0000-4000-8000-0000000000c6',
    'c5400000-0000-4000-8000-000000000001',
    '2026-11-13T08:00:00Z',
    3,
    30,
    'cogs',
    null,
    null,
    'return',
    (
      select
        sale.id::text
      from
        app.stock_movements sale
      where
        sale.item_id = 'c5400000-0000-4000-8000-000000000001'
        and sale.movement_type = 'sale'
        and sale.occurred_at = '2026-09-02T08:00:00Z'
    ),
    null,
    null,
    null,
    null,
    null,
    null,
    0
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000001']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000c6',
    true
  );

select
  is (
    (
      select
        deficit.qty_uncovered
      from
        app.provisional_deficits deficit
        join app.stock_movements sale on sale.id = deficit.movement_id
      where
        sale.item_id = 'c5400000-0000-4000-8000-000000000001'
        and sale.occurred_at = '2026-09-02T08:00:00Z'
    ),
    0::numeric,
    'Q6 cancels the returned sale''s own deficit before FIFO'
  );

select
  is (
    (
      select
        deficit.qty_uncovered
      from
        app.provisional_deficits deficit
        join app.stock_movements sale on sale.id = deficit.movement_id
      where
        sale.item_id = 'c5400000-0000-4000-8000-000000000001'
        and sale.occurred_at = '2026-09-01T08:00:00Z'
    ),
    5::numeric,
    'Q6 leaves the earlier deficit open when the return has no remainder'
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000001'
    ),
    -5::numeric,
    'Q6 return of the later 3 leaves quantity -5'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000001'
    ),
    -50::numeric,
    'Q6 return of the later 3 leaves value -50'
  );

-- Q6 remainder. Return 8 of the later 3. The leftover 5 covers the earlier deficit.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000008',
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
        'c5400000-0000-4000-8000-000000000008',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-09-02T08:00:00Z',
        'quantity',
        3
      )
    )
  );

select
  app.insert_closed_movement (
    'c5400000-0000-4000-8000-0000000000c7',
    'c5400000-0000-4000-8000-000000000008',
    '2026-11-13T09:00:00Z',
    8,
    80,
    'cogs',
    null,
    null,
    'return',
    (
      select
        sale.id::text
      from
        app.stock_movements sale
      where
        sale.item_id = 'c5400000-0000-4000-8000-000000000008'
        and sale.occurred_at = '2026-09-02T08:00:00Z'
    ),
    null,
    null,
    null,
    null,
    null,
    null,
    0
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000008']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000c7',
    true
  );

select
  is (
    (
      select
        coalesce(sum(deficit.qty_uncovered), 0)
      from
        app.provisional_deficits deficit
      where
        deficit.item_id = 'c5400000-0000-4000-8000-000000000008'
        and deficit.qty_uncovered > 0
    ),
    0::numeric,
    'Q6 remainder covers the earlier deficit after its own sale is cancelled'
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000008'
    ),
    0::numeric,
    'Q6 remainder return finishes at quantity 0'
  );

-- Q(b). Backdated in-window purchase 10/200 covers old 5/50, then a sale of 4
-- before t_change consumes 80. End 1/20, and the ledger matches the balance.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000002',
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
        'c5400000-0000-4000-8000-000000000002',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-12T08:00:00Z',
        'quantity',
        4
      )
    )
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T08:00:00Z',
      'request_id',
      'c5400000-0000-4000-8000-000000000201',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000002',
          'quantity',
          '10',
          'unit',
          'kg',
          'amount_paid',
          '200.00',
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
        balance.item_id = 'c5400000-0000-4000-8000-000000000002'
    ),
    1::numeric,
    'Q(b) ends at quantity 1'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000002'
    ),
    20::numeric,
    'Q(b) ends at value 20 after the sale consumes 80'
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000002'
    ),
    (
      select
        coalesce(sum(movement.quantity), 0)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000002'
    ),
    'Q(b) ledger quantity equals the balance'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000002'
    ),
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000002'
    ),
    'Q(b) ledger value equals the balance'
  );

-- Q(c). P1 covered the deficit. P0, inserted later with an earlier instant,
-- covers it instead: +50 at P1 and -50 at P0.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000003',
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
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000003',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-10T08:00:00Z',
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T08:00:00Z',
      'request_id',
      'c5400000-0000-4000-8000-000000000203',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000003',
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
        coalesce(sum(cover.total_cost), 0)
      from
        app.stock_movements cover
      where
        cover.cover_inflow_movement_id = (
          select
            purchase.id
          from
            app.stock_movements purchase
          where
            purchase.item_id = 'c5400000-0000-4000-8000-000000000003'
            and purchase.movement_type = 'purchase'
            and purchase.occurred_at = '2026-11-10T08:00:00Z'
        )
    ),
    0::numeric,
    'Q(c) the later purchase net cover is cancelled'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements cover
      where
        cover.cover_inflow_movement_id = (
          select
            purchase.id
          from
            app.stock_movements purchase
          where
            purchase.item_id = 'c5400000-0000-4000-8000-000000000003'
            and purchase.movement_type = 'purchase'
            and purchase.occurred_at = '2026-11-10T08:00:00Z'
        )
        and cover.total_cost = 50
    ),
    'Q(c) posts +50 at P1'
  );

select
  is (
    (
      select
        coalesce(sum(cover.total_cost), 0)
      from
        app.stock_movements cover
      where
        cover.cover_inflow_movement_id = (
          select
            purchase.id
          from
            app.stock_movements purchase
          where
            purchase.item_id = 'c5400000-0000-4000-8000-000000000003'
            and purchase.movement_type = 'purchase'
            and purchase.occurred_at = '2026-11-01T08:00:00Z'
        )
    ),
    -50::numeric,
    'Q(c) posts -50 at P0'
  );

-- N. Dropping the old deficit would finish at -2/-40. The walk keeps it and
-- finishes at -2/-20, twice from the same checkpoint.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000004',
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
        'c5400000-0000-4000-8000-000000000004',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-01T08:00:00Z',
        'quantity',
        2
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000004',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-10T08:00:00Z',
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000004']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000c4',
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
        balance.item_id = 'c5400000-0000-4000-8000-000000000004'
    ),
    -2::numeric,
    'N finishes at quantity -2'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000004'
    ),
    -20::numeric,
    'N finishes at value -20 and not the dropped-deficit -40'
  );

select
  is (
    (
      select
        deficit.qty_uncovered
      from
        app.provisional_deficits deficit
        join app.stock_movements sale on sale.id = deficit.movement_id
      where
        sale.item_id = 'c5400000-0000-4000-8000-000000000004'
        and sale.occurred_at = '2026-11-01T08:00:00Z'
    ),
    2::numeric,
    'N keeps the in-window deficit at 2'
  );

select
  is (
    (
      select
        deficit.value_uncovered
      from
        app.provisional_deficits deficit
        join app.stock_movements sale on sale.id = deficit.movement_id
      where
        sale.item_id = 'c5400000-0000-4000-8000-000000000004'
        and sale.occurred_at = '2026-11-01T08:00:00Z'
    ),
    20::numeric,
    'N keeps the in-window deficit value at 20'
  );

create temp table n_snap as
select
  count(*) as movements
from
  app.stock_movements movement
where
  movement.item_id = 'c5400000-0000-4000-8000-000000000004';

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000004']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000c5',
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
        movement.item_id = 'c5400000-0000-4000-8000-000000000004'
    ),
    (
      select
        snap.movements
      from
        n_snap snap
    ),
    'N replayed a second time from the same checkpoint adds no row'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000004'
    ),
    -20::numeric,
    'N second replay still finishes at -20'
  );

-- M. Raw purchased at 100, fully sorted. A +50 correction.
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T08:00:00Z',
      'request_id',
      'c5400000-0000-4000-8000-000000000210',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000010',
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
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5400000-0000-4000-8000-000000000211',
      'mixed_item_id',
      'c5400000-0000-4000-8000-000000000010',
      'occurred_at',
      '2026-11-02T08:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000011',
          'quantity',
          '10'
        )
      )
    )
  );

create temp table m_onhand as
select
  app.post_closed_document_correction (
    null,
    'c5400000-0000-4000-8000-000000000010',
    (
      select
        purchase.id
      from
        app.stock_movements purchase
      where
        purchase.item_id = 'c5400000-0000-4000-8000-000000000010'
        and purchase.movement_type = 'purchase'
    ),
    50,
    0,
    10,
    'purchase',
    null,
    'purchase',
    null,
    null,
    null
  ) as cause;

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_onhand cause on cause.cause = movement.closed_cause_id
    ),
    50::numeric,
    'M on-hand output: component sum is +50'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_onhand cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000011'
    ),
    50::numeric,
    'M on-hand output: output held is +50'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_onhand cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000010'
    ),
    0::numeric,
    'M on-hand output: raw held is 0'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
        join m_onhand cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000011'
        and movement.closed_bucket = 'sort_transfer'
    ),
    1::bigint,
    'M on-hand output: one receiving row'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
        join m_onhand cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000011'
        and movement.closed_bucket = 'inventory'
    ),
    0::bigint,
    'M on-hand output: no inventory-bucket row'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_onhand cause on cause.cause = movement.closed_cause_id
      where
        movement.closed_bucket = 'sort_transfer'
    ),
    0::numeric,
    'M on-hand output: sort_transfer sums to 0'
  );

-- M sold output. The +50 lands in COGS. Component sum is 0.
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T09:00:00Z',
      'request_id',
      'c5400000-0000-4000-8000-000000000212',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000012',
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
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5400000-0000-4000-8000-000000000213',
      'mixed_item_id',
      'c5400000-0000-4000-8000-000000000012',
      'occurred_at',
      '2026-11-02T09:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000013',
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
        'c5400000-0000-4000-8000-000000000013',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T09:00:00Z',
        'quantity',
        10
      )
    )
  );

create temp table m_sold as
select
  app.post_closed_document_correction (
    null,
    'c5400000-0000-4000-8000-000000000012',
    (
      select
        purchase.id
      from
        app.stock_movements purchase
      where
        purchase.item_id = 'c5400000-0000-4000-8000-000000000012'
        and purchase.movement_type = 'purchase'
    ),
    50,
    0,
    10,
    'purchase',
    null,
    'purchase',
    null,
    null,
    null
  ) as cause;

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_sold cause on cause.cause = movement.closed_cause_id
    ),
    0::numeric,
    'M sold output: component sum is 0'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_sold cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000013'
        and movement.closed_bucket = 'cogs'
    ),
    -50::numeric,
    'M sold output: COGS recognition is -50'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
        join m_sold cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000013'
        and movement.closed_bucket = 'inventory'
    ),
    0::bigint,
    'M sold output: no inventory-bucket row'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_sold cause on cause.cause = movement.closed_cause_id
      where
        movement.closed_bucket = 'sort_transfer'
    ),
    0::numeric,
    'M sold output: sort_transfer sums to 0'
  );

-- M re-sorted leaf.
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T10:00:00Z',
      'request_id',
      'c5400000-0000-4000-8000-000000000214',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000014',
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
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5400000-0000-4000-8000-000000000215',
      'mixed_item_id',
      'c5400000-0000-4000-8000-000000000014',
      'occurred_at',
      '2026-11-02T10:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000015',
          'quantity',
          '10'
        )
      )
    )
  );

-- A fish_size cannot be sorted again through record_sort. The second sort is
-- the same ledger shape post_sort writes, so the closed cause can follow it.
insert into
  app.sort_batches (
    id,
    request_id,
    mixed_item_id,
    occurred_at,
    qty_taken
  )
values
  (
    'c5400000-0000-4000-8000-000000000216',
    'c5400000-0000-4000-8000-000000000316',
    'c5400000-0000-4000-8000-000000000015',
    '2026-11-03T10:00:00Z',
    10
  );

insert into
  app.sort_batch_lines (batch_id, line_no, size_item_id, quantity)
values
  (
    'c5400000-0000-4000-8000-000000000216',
    1,
    'c5400000-0000-4000-8000-000000000016',
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
    total_cost,
    source_type,
    source_id
  )
values
  (
    'c5400000-0000-4000-8000-000000000216',
    'c5400000-0000-4000-8000-000000000015',
    'sort_out',
    '2026-11-03T10:00:00Z',
    -10,
    10,
    -100,
    'sort',
    'c5400000-0000-4000-8000-000000000216'
  ),
  (
    'c5400000-0000-4000-8000-000000000216',
    'c5400000-0000-4000-8000-000000000016',
    'sort_in',
    '2026-11-03T10:00:00Z',
    10,
    10,
    100,
    'sort',
    'c5400000-0000-4000-8000-000000000216'
  );

update app.item_balances
set
  on_hand_qty = 0,
  on_hand_value = 0,
  avg_cost = 0,
  last_occurred_at = '2026-11-03T10:00:00Z'
where
  item_id = 'c5400000-0000-4000-8000-000000000015';

insert into
  app.item_balances (
    item_id,
    on_hand_qty,
    on_hand_value,
    avg_cost,
    last_occurred_at
  )
values
  (
    'c5400000-0000-4000-8000-000000000016',
    10,
    100,
    10,
    '2026-11-03T10:00:00Z'
  );

create temp table m_leaf as
select
  app.post_closed_document_correction (
    null,
    'c5400000-0000-4000-8000-000000000014',
    (
      select
        purchase.id
      from
        app.stock_movements purchase
      where
        purchase.item_id = 'c5400000-0000-4000-8000-000000000014'
        and purchase.movement_type = 'purchase'
    ),
    50,
    0,
    10,
    'purchase',
    null,
    'purchase',
    null,
    null,
    null
  ) as cause;

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_leaf cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000016'
    ),
    50::numeric,
    'M re-sorted leaf: leaf held is +50'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_leaf cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id in (
          'c5400000-0000-4000-8000-000000000014',
          'c5400000-0000-4000-8000-000000000015'
        )
    ),
    0::numeric,
    'M re-sorted leaf: both parents held are 0'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_leaf cause on cause.cause = movement.closed_cause_id
    ),
    50::numeric,
    'M re-sorted leaf: component sum is +50'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
        join m_leaf cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id <> 'c5400000-0000-4000-8000-000000000014'
        and movement.closed_bucket = 'inventory'
    ),
    0::bigint,
    'M re-sorted leaf: no output has an inventory-bucket row'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_leaf cause on cause.cause = movement.closed_cause_id
      where
        movement.closed_bucket = 'sort_transfer'
    ),
    0::numeric,
    'M re-sorted leaf: sort_transfer sums to 0'
  );

-- M cap. Output on hand is worth 10. A -200 correction would hold -20 there.
-- The cap holds -10 and routes the overflow to that output's consumption.
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T11:00:00Z',
      'request_id',
      'c5400000-0000-4000-8000-000000000217',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000017',
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
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5400000-0000-4000-8000-000000000218',
      'mixed_item_id',
      'c5400000-0000-4000-8000-000000000017',
      'occurred_at',
      '2026-11-02T11:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000018',
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
        'c5400000-0000-4000-8000-000000000018',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T11:00:00Z',
        'quantity',
        9
      )
    )
  );

create temp table m_cap as
select
  app.post_closed_document_correction (
    null,
    'c5400000-0000-4000-8000-000000000017',
    (
      select
        purchase.id
      from
        app.stock_movements purchase
      where
        purchase.item_id = 'c5400000-0000-4000-8000-000000000017'
        and purchase.movement_type = 'purchase'
    ),
    -200,
    0,
    10,
    'purchase',
    null,
    'purchase',
    null,
    null,
    null
  ) as cause;

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_cap cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000018'
    ),
    -10::numeric,
    'M cap: the output net equals the capped held value -10'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_cap cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000018'
        and movement.closed_bucket = 'cogs'
    ),
    190::numeric,
    'M cap: the overflow is that output''s own COGS recognition'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
        join m_cap cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000018'
        and movement.closed_bucket = 'inventory'
    ),
    0::bigint,
    'M cap: the output has no inventory-bucket row'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join m_cap cause on cause.cause = movement.closed_cause_id
      where
        movement.closed_bucket = 'sort_transfer'
    ),
    0::numeric,
    'M cap: sort_transfer sums to 0'
  );

-- P. Opening at unit cost 0, sorted into two outputs stored at 0.
select
  app.record_opening_stock (
    '2026-11-01T12:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000020',
        'quantity',
        '10',
        'unit',
        'kg',
        'unit_cost',
        '0',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'c5400000-0000-4000-8000-000000000220'
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5400000-0000-4000-8000-000000000221',
      'mixed_item_id',
      'c5400000-0000-4000-8000-000000000020',
      'occurred_at',
      '2026-11-02T12:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000021',
          'quantity',
          '5'
        ),
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000022',
          'quantity',
          '5'
        )
      )
    )
  );

create temp table p_equal as
select
  app.post_closed_document_correction (
    null,
    'c5400000-0000-4000-8000-000000000020',
    (
      select
        opening.id
      from
        app.stock_movements opening
      where
        opening.item_id = 'c5400000-0000-4000-8000-000000000020'
        and opening.movement_type = 'opening'
    ),
    50,
    0,
    10,
    'opening',
    null,
    'opening',
    null,
    null,
    null
  ) as cause;

select
  is (
    (
      select
        movement.total_cost
      from
        app.stock_movements movement
        join p_equal cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000021'
        and movement.closed_bucket = 'sort_transfer'
    ),
    25::numeric,
    'P equal quantities split 25.00'
  );

select
  is (
    (
      select
        movement.total_cost
      from
        app.stock_movements movement
        join p_equal cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000022'
        and movement.closed_bucket = 'sort_transfer'
    ),
    25::numeric,
    'P equal quantities split the other 25.00'
  );

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join p_equal cause on cause.cause = movement.closed_cause_id
      where
        movement.closed_bucket = 'sort_transfer'
    ),
    0::numeric,
    'P equal split: sort_transfer sums to 0'
  );

select
  app.record_opening_stock (
    '2026-11-01T13:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000023',
        'quantity',
        '3',
        'unit',
        'kg',
        'unit_cost',
        '0',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'c5400000-0000-4000-8000-000000000223'
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5400000-0000-4000-8000-000000000224',
      'mixed_item_id',
      'c5400000-0000-4000-8000-000000000023',
      'occurred_at',
      '2026-11-02T13:00:00Z',
      'qty_taken',
      '3',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000024',
          'quantity',
          '1'
        ),
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000025',
          'quantity',
          '2'
        )
      )
    )
  );

create temp table p_qty as
select
  app.post_closed_document_correction (
    null,
    'c5400000-0000-4000-8000-000000000023',
    (
      select
        opening.id
      from
        app.stock_movements opening
      where
        opening.item_id = 'c5400000-0000-4000-8000-000000000023'
        and opening.movement_type = 'opening'
    ),
    50,
    0,
    3,
    'opening',
    null,
    'opening',
    null,
    null,
    null
  ) as cause;

select
  is (
    (
      select
        movement.total_cost
      from
        app.stock_movements movement
        join p_qty cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000024'
        and movement.closed_bucket = 'sort_transfer'
    ),
    16.67,
    'P quantities 1 and 2 split 16.67 to the first'
  );

select
  is (
    (
      select
        movement.total_cost
      from
        app.stock_movements movement
        join p_qty cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000025'
        and movement.closed_bucket = 'sort_transfer'
    ),
    33.33,
    'P quantities 1 and 2 split 33.33 to the last'
  );

-- A batch whose transferred value is not 0 still splits by value.
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-11-01T14:00:00Z',
      'request_id',
      'c5400000-0000-4000-8000-000000000226',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000026',
          'quantity',
          '4',
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
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'c5400000-0000-4000-8000-000000000227',
      'mixed_item_id',
      'c5400000-0000-4000-8000-000000000026',
      'occurred_at',
      '2026-11-02T14:00:00Z',
      'qty_taken',
      '4',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000027',
          'quantity',
          '1'
        ),
        jsonb_build_object(
          'item_id',
          'c5400000-0000-4000-8000-000000000028',
          'quantity',
          '3'
        )
      )
    )
  );

create temp table p_value as
select
  app.post_closed_document_correction (
    null,
    'c5400000-0000-4000-8000-000000000026',
    (
      select
        purchase.id
      from
        app.stock_movements purchase
      where
        purchase.item_id = 'c5400000-0000-4000-8000-000000000026'
        and purchase.movement_type = 'purchase'
    ),
    50,
    0,
    4,
    'purchase',
    null,
    'purchase',
    null,
    null,
    null
  ) as cause;

select
  is (
    (
      select
        movement.total_cost
      from
        app.stock_movements movement
        join p_value cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000027'
        and movement.closed_bucket = 'sort_transfer'
    ),
    12.50,
    'P non-zero transferred value splits 12.50 by value'
  );

select
  is (
    (
      select
        movement.total_cost
      from
        app.stock_movements movement
        join p_value cause on cause.cause = movement.closed_cause_id
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000028'
        and movement.closed_bucket = 'sort_transfer'
    ),
    37.50,
    'P non-zero transferred value splits 37.50 by value'
  );

-- J. Two events at one instant. The published cut is after both of them.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000030',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-01T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        10
      )
    )
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000030']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000d1',
    true
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000030',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-02T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000030',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-02T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        10
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
        movement.item_id = 'c5400000-0000-4000-8000-000000000030'
        and movement.occurred_at = '2026-11-02T08:00:00Z'
        and (
          movement.occurred_at > (
            select
              checkpoint.cut_occurred_at
            from
              app.replay_checkpoints
            checkpoint
            where
              checkpoint.item_id = 'c5400000-0000-4000-8000-000000000030'
            order by
              checkpoint.cut_occurred_at desc
            limit
              1
          )
          or movement.id > (
            select
              checkpoint.max_movement_id
            from
              app.replay_checkpoints
            checkpoint
            where
              checkpoint.item_id = 'c5400000-0000-4000-8000-000000000030'
            order by
              checkpoint.cut_occurred_at desc
            limit
              1
          )
        )
    ),
    2::bigint,
    'J a cut before both same-instant events returns both'
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000030']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000d2',
    true
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
        checkpoint.item_id = 'c5400000-0000-4000-8000-000000000030'
        and checkpoint.cut_occurred_at = '2026-11-02T08:00:00Z'
        and checkpoint.max_movement_id = (
          select
            min(movement.id)
          from
            app.stock_movements movement
          where
            movement.item_id = 'c5400000-0000-4000-8000-000000000030'
            and movement.occurred_at = '2026-11-02T08:00:00Z'
        )
    ),
    0::bigint,
    'J a cut between two same-instant events is not published'
  );

select
  is (
    (
      select
        checkpoint.max_movement_id
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'c5400000-0000-4000-8000-000000000030'
        and checkpoint.cut_occurred_at = '2026-11-02T08:00:00Z'
      order by
        checkpoint.id desc
      limit
        1
    ),
    (
      select
        max(movement.id)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000030'
        and movement.occurred_at = '2026-11-02T08:00:00Z'
    ),
    'J a cut after both uses the later id'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000030'
        and movement.occurred_at = '2026-11-02T08:00:00Z'
        and (
          movement.occurred_at > '2026-11-02T08:00:00Z'
          or movement.id > (
            select
              max(checkpoint.max_movement_id)
            from
              app.replay_checkpoints
            checkpoint
            where
              checkpoint.item_id = 'c5400000-0000-4000-8000-000000000030'
              and checkpoint.cut_occurred_at = '2026-11-02T08:00:00Z'
          )
        )
    ),
    0::bigint,
    'J a cut after both leaves both out of the suffix'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000030',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-02T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        10
      )
    )
  );

select
  ok (
    (
      select
        movement.id
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000030'
        and movement.occurred_at = '2026-11-02T08:00:00Z'
      order by
        movement.id desc
      limit
        1
    ) > (
      select
        max(checkpoint.max_movement_id)
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'c5400000-0000-4000-8000-000000000030'
        and checkpoint.cut_occurred_at = '2026-11-02T08:00:00Z'
    ),
    'J a later row at that instant has a new id above max_movement_id'
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000030']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000d3',
    true
  );

create temp table j_snap as
select
  balance.on_hand_qty,
  balance.on_hand_value,
  (
    select
      coalesce(
        string_agg(
          movement.id::text,
          ','
          order by
            movement.id
        ),
        ''
      )
    from
      app.stock_movements movement
    where
      movement.item_id = 'c5400000-0000-4000-8000-000000000030'
  ) as movement_ids
from
  app.item_balances balance
where
  balance.item_id = 'c5400000-0000-4000-8000-000000000030';

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'full-walk'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'c5400000-0000-4000-8000-000000000030'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000030']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000d4',
    true
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || ':' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000030'
    ),
    (
      select
        snap.on_hand_qty::text || ':' || snap.on_hand_value::text
      from
        j_snap snap
    ),
    'J suffix walk and full walk agree on balances'
  );

select
  is (
    (
      select
        coalesce(
          string_agg(
            movement.id::text,
            ','
            order by
              movement.id
          ),
          ''
        )
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000030'
    ),
    (
      select
        snap.movement_ids
      from
        j_snap snap
    ),
    'J suffix walk and full walk agree on row identity'
  );

-- In-window equivalence. A sale between two purchases, resumed, matches a full walk.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000031',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-01T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        10
      )
    )
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000031',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-02T08:00:00Z',
        'quantity',
        2
      )
    )
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000031']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000e1',
    true
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5400000-0000-4000-8000-000000000031',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        4,
        'unit_cost',
        10
      )
    )
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000031']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000e2',
    true
  );

create temp table equiv_snap as
select
  balance.on_hand_qty,
  balance.on_hand_value,
  (
    select
      coalesce(
        string_agg(
          deficit.movement_id::text || ':' || deficit.qty_uncovered::text || ':' || deficit.value_uncovered::text,
          ','
          order by
            deficit.movement_id
        ),
        ''
      )
    from
      app.provisional_deficits deficit
    where
      deficit.item_id = 'c5400000-0000-4000-8000-000000000031'
  ) as deficits,
  (
    select
      coalesce(
        string_agg(
          movement.id::text,
          ','
          order by
            movement.id
        ),
        ''
      )
    from
      app.stock_movements movement
    where
      movement.item_id = 'c5400000-0000-4000-8000-000000000031'
  ) as movement_ids
from
  app.item_balances balance
where
  balance.item_id = 'c5400000-0000-4000-8000-000000000031';

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'full-walk'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'c5400000-0000-4000-8000-000000000031'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array['c5400000-0000-4000-8000-000000000031']::uuid[],
    '[]'::jsonb,
    'c5400000-0000-4000-8000-0000000000e3',
    true
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || ':' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'c5400000-0000-4000-8000-000000000031'
    ),
    (
      select
        snap.on_hand_qty::text || ':' || snap.on_hand_value::text
      from
        equiv_snap snap
    ),
    'in-window replay from a checkpoint matches a full replay on balances'
  );

select
  is (
    (
      select
        coalesce(
          string_agg(
            deficit.movement_id::text || ':' || deficit.qty_uncovered::text || ':' || deficit.value_uncovered::text,
            ','
            order by
              deficit.movement_id
          ),
          ''
        )
      from
        app.provisional_deficits deficit
      where
        deficit.item_id = 'c5400000-0000-4000-8000-000000000031'
    ),
    (
      select
        snap.deficits
      from
        equiv_snap snap
    ),
    'in-window replay from a checkpoint matches a full replay on deficits'
  );

select
  is (
    (
      select
        coalesce(
          string_agg(
            movement.id::text,
            ','
            order by
              movement.id
          ),
          ''
        )
      from
        app.stock_movements movement
      where
        movement.item_id = 'c5400000-0000-4000-8000-000000000031'
    ),
    (
      select
        snap.movement_ids
      from
        equiv_snap snap
    ),
    'in-window replay from a checkpoint matches a full replay on the movement set'
  );

-- Activation marker. A frozen input with no posting receipt stays unset.
-- blocked and disposition_pending completions are not receipts.
insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'c5400000-0000-4000-8000-0000000000c0',
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
  'c5400000-0000-4000-8000-000000000040',
  0
from
  app.costing_changes change
where
  change.request_id = 'c5400000-0000-4000-8000-0000000000c0';

insert into
  app.pos_shifts (id, opened_at, is_active, pos_update_time)
values
  (
    'c54-shift',
    '2026-09-01T08:00:00Z',
    false,
    '2026-09-01T08:00:00Z'
  );

select
  app.set_pos_option_policy (
    'c5400000-0000-4000-8000-000000000301'::uuid,
    'c54-pos',
    '["none"]'::jsonb,
    '2020-01-01T00:00:00Z',
    null,
    'none_expected',
    (
      select
        app.pos_base_schedule ('c54-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'span test'
  );

select
  app.set_base_packaging (
    'c5400000-0000-4000-8000-000000000302'::uuid,
    'c54-pos',
    '["none"]'::jsonb,
    '2020-01-01T00:00:00Z',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_base_schedule ('c54-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'span test'
  );

select
  app.set_pos_base_mapping (
    'c5400000-0000-4000-8000-000000000303'::uuid,
    'c54-pos',
    '["none"]'::jsonb,
    '2020-01-01T00:00:00Z',
    null,
    jsonb_build_object(
      'stock_item_id',
      'c5400000-0000-4000-8000-000000000040',
      'quantity_per_basis',
      '1',
      'unit',
      'kg'
    ),
    (
      select
        app.pos_base_schedule ('c54-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'span test'
  );

select
  app.set_order_type_packaging (
    'c5400000-0000-4000-8000-000000000304'::uuid,
    'hall',
    '2020-01-01T00:00:00Z',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_order_type_schedule ('hall') ->> 'token'
    ),
    'span test'
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
    'c54-block',
    'c54-shift',
    'complete',
    'hall',
    '2030-06-01T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-01T10:00:00Z',
    rpad(md5('c54-block'), 64, 'a'),
    false
  ),
  (
    'c54-disp',
    'c54-shift',
    'complete',
    'hall',
    '2030-06-02T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-02T10:00:00Z',
    rpad(md5('c54-disp'), 64, 'a'),
    false
  ),
  (
    'c54-old-a',
    'c54-shift',
    'complete',
    'hall',
    '2026-09-01T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-09-01T10:00:00Z',
    rpad(md5('c54-old-a'), 64, 'a'),
    false
  ),
  (
    'c54-old-b',
    'c54-shift',
    'complete',
    'hall',
    '2026-09-02T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-09-02T10:00:00Z',
    rpad(md5('c54-old-b'), 64, 'a'),
    false
  ),
  (
    'c54-new',
    'c54-shift',
    'complete',
    'hall',
    '2026-11-01T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-11-01T10:00:00Z',
    rpad(md5('c54-new'), 64, 'a'),
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
select
  order_id,
  'l1-' || order_id,
  'c54-pos',
  'x',
  1,
  null,
  null,
  '[]'::jsonb,
  0
from
  (
    values
      ('c54-block'),
      ('c54-disp'),
      ('c54-old-a'),
      ('c54-old-b'),
      ('c54-new')
  ) as orders (order_id);

select
  app.append_pos_cost_input ('c54-block', null, 'sync');

select
  app.append_pos_cost_input ('c54-disp', null, 'sync');

select
  app.append_pos_cost_input ('c54-old-a', null, 'sync');

select
  app.append_pos_cost_input ('c54-old-b', null, 'sync');

select
  app.append_pos_cost_input ('c54-new', null, 'sync');

insert into
  app.activation_history_input (order_id, bound_at, cost_input_id, ordered_at)
select
  input.order_id,
  '2026-11-14T12:00:00Z',
  input.id,
  case input.order_id
    when 'c54-block' then '2030-06-01T10:00:00Z'::timestamptz
    else '2030-06-02T10:00:00Z'::timestamptz
  end
from
  app.pos_cost_inputs input
where
  input.order_id in ('c54-block', 'c54-disp');

insert into
  app.accounting_work_completions (
    attempt_id,
    order_id,
    work_generation,
    outcome,
    application_id
  )
values
  (
    'c5400000-0000-4000-8000-0000000000b1',
    'c54-block',
    1,
    'blocked',
    null
  ),
  (
    'c5400000-0000-4000-8000-0000000000b2',
    'c54-disp',
    1,
    'disposition_pending',
    null
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
    0::bigint,
    'a frozen input with no posting receipt leaves the marker unset'
  );

select
  is (
    (
      select
        count(*)
      from
        app.activation_history_loaded
    ),
    0::bigint,
    'blocked and disposition_pending inputs do not count as posting receipts'
  );

-- Configuration span. Two orders before the window share one closed cause.
-- The in-window order is its own queue event. The activation trigger writes
-- the frozen inputs itself, so the rows used for the marker check are removed
-- first.
delete from app.activation_history_input
where
  order_id in ('c54-block', 'c54-disp');

insert into
  app.inventory_activation (
    stock_started_at,
    approved_by,
    request_id,
    opening_manifest_hash
  )
select
  '2020-01-01T00:00:00Z',
  'c5400000-0000-4000-8000-0000000000a1',
  'c5400000-0000-4000-8000-0000000000e1',
  repeat('b', 32)
where
  not exists (
    select
      1
    from
      app.inventory_activation
  );

update app.accounting_rederive_spans
set
  completed_at = pg_catalog.clock_timestamp ()
where
  completed_at is null;

insert into
  app.accounting_rederive_spans (
    family,
    version_id,
    cause,
    change_id,
    effective_from,
    effective_to
  )
select
  'pos_map',
  'c5400000-0000-4000-8000-000000000331',
  'insert',
  change.id,
  '2026-08-01T00:00:00Z',
  '2026-11-05T00:00:00Z'
from
  app.costing_changes change
where
  change.request_id = 'c5400000-0000-4000-8000-0000000000c0';

select
  app.run_accounting_work (
    'c5400000-0000-4000-8000-0000000000f1',
    1,
    null,
    null
  );

select
  is (
    (
      select
        count(*)
      from
        app.closed_period_sources source
      where
        source.source_id in ('c54-old-a', 'c54-old-b')
    ),
    0::bigint,
    'a span does not close an unposted frozen activation input'
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_movement_links link
        join app.stock_movements movement on movement.id = link.movement_id
        join app.pos_orders orders on orders.id = link.order_id
      where
        link.order_id in ('c54-old-a', 'c54-old-b')
        and movement.movement_type = 'sale'
        and movement.occurred_at = orders.ordered_at
    ),
    2::bigint,
    'a span posts an unposted frozen input at its original instant'
  );

select
  is (
    (
      select
        count(*)
      from
        app.closed_period_sources source
      where
        source.source_id = 'c54-new'
    ),
    0::bigint,
    'the in-window order is not part of the closed cause'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events event
      where
        event.order_id = 'c54-new'
        and event.cause = 'config_span'
    ),
    1::bigint,
    'the in-window order is expanded on its own'
  );

-- Orders created after activation are not frozen. A span over two of them
-- that are already outside the window still shares one closed cause.
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
    'c54-aged-a',
    'c54-shift',
    'complete',
    'hall',
    '2026-09-03T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-09-03T10:00:00Z',
    rpad(md5('c54-aged-a'), 64, 'a'),
    false
  ),
  (
    'c54-aged-b',
    'c54-shift',
    'complete',
    'hall',
    '2026-09-04T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2026-09-04T10:00:00Z',
    rpad(md5('c54-aged-b'), 64, 'a'),
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
    'c54-aged-a',
    'l1',
    'c54-pos',
    'x',
    1,
    '[]'::jsonb,
    0
  ),
  (
    'c54-aged-b',
    'l1',
    'c54-pos',
    'x',
    1,
    '[]'::jsonb,
    0
  );

select
  app.append_pos_cost_input ('c54-aged-a', null, 'sync');

select
  app.append_pos_cost_input ('c54-aged-b', null, 'sync');

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'c5400000-0000-4000-8000-0000000000c1',
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
    effective_from,
    effective_to
  )
select
  'pos_map',
  'c5400000-0000-4000-8000-000000000332',
  'insert',
  change.id,
  '2026-09-03T00:00:00Z',
  '2026-09-05T00:00:00Z'
from
  app.costing_changes change
where
  change.request_id = 'c5400000-0000-4000-8000-0000000000c1';

select
  app.run_accounting_work (
    'c5400000-0000-4000-8000-0000000000f2',
    1,
    null,
    null
  );

select
  is (
    (
      select
        count(distinct movement.closed_cause_id)
      from
        app.stock_movements movement
        join app.closed_period_sources source on source.movement_id = movement.id
      where
        source.source_id in ('c54-aged-a', 'c54-aged-b')
    ),
    1::bigint,
    'orders before the window accumulate into one closed cause'
  );

select
  is (
    (
      select
        count(distinct source.source_id)
      from
        app.closed_period_sources source
      where
        source.source_id in ('c54-aged-a', 'c54-aged-b')
    ),
    2::bigint,
    'both pre-window orders are in that one cause'
  );

select
  finish ();

rollback;
