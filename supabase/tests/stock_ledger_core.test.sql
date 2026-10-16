begin;

select
  plan (85);

-- Clean up any existing test rows in the transaction.
delete from app.provisional_deficits;

alter table app.stock_movements disable trigger trg_stock_movements_no_update_delete;

alter table app.stock_movements disable trigger trg_stock_movements_no_truncate;

delete from app.stock_movements;

alter table app.stock_movements enable trigger trg_stock_movements_no_update_delete;

alter table app.stock_movements enable trigger trg_stock_movements_no_truncate;

delete from app.item_balances;

delete from app.item_unit_conversions;

delete from app.stock_items;

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

-- ============================================================================
-- 1..8: Schema objects exist
-- ============================================================================
-- 1
select
  has_table (
    'app',
    'stock_items',
    'app.stock_items table exists'
  );

-- 2
select
  has_table (
    'app',
    'item_unit_conversions',
    'app.item_unit_conversions table exists'
  );

-- 3
select
  has_table (
    'app',
    'stock_movements',
    'app.stock_movements table exists'
  );

-- 4
select
  has_table (
    'app',
    'item_balances',
    'app.item_balances table exists'
  );

-- 5
select
  has_table (
    'app',
    'provisional_deficits',
    'app.provisional_deficits table exists'
  );

-- 6
select
  has_type (
    'app',
    'movement_type',
    'app.movement_type enum exists'
  );

-- 7
select
  has_function (
    'app',
    'post_movements',
    array['jsonb'],
    'app.post_movements(jsonb) exists'
  );

-- 8
select
  has_function (
    'app',
    'post_sort',
    array['uuid', 'timestamptz', 'numeric', 'jsonb', 'text'],
    'app.post_sort exists'
  );

-- ============================================================================
-- Seed test catalog items & conversions
-- ============================================================================
insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    loss_pct,
    parent_item_id
  )
values
  -- WAC test item
  (
    '10000000-0000-4000-8000-000000000001',
    'جمبري وسط',
    'seafood',
    'kg',
    'daily',
    0.10,
    null
  ),
  -- Negative stock design example item
  (
    '10000000-0000-4000-8000-000000000002',
    'كاليماري بلدي',
    'seafood',
    'kg',
    'daily',
    0.05,
    null
  ),
  -- Partial cover item
  (
    '10000000-0000-4000-8000-000000000003',
    'كابوريا',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  -- Never-costed oversold item
  (
    '10000000-0000-4000-8000-000000000004',
    'سبيط',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  -- Mixed fish parent item (Bouri)
  (
    '10000000-0000-4000-8000-000000000005',
    'بوري مخلوط',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  -- Other mixed fish parent item (Denis) for wrong-parent guard
  (
    '10000000-0000-4000-8000-000000000009',
    'دنيس مخلوط',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  -- Unit conversion item
  (
    '10000000-0000-4000-8000-000000000011',
    'كمون مطحون',
    'ingredient',
    'kg',
    'weekly',
    0,
    null
  ),
  -- Piaster rounding item
  (
    '10000000-0000-4000-8000-000000000012',
    'زيت قليه',
    'ingredient',
    'liter',
    'weekly',
    0,
    null
  ),
  -- Sort stock guard mixed item
  (
    '10000000-0000-4000-8000-000000000013',
    'لوت مخلوط',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  -- Outflow drift item (100 x 0.01 kg)
  (
    '10000000-0000-4000-8000-000000000016',
    'فلفل أسود',
    'ingredient',
    'kg',
    'weekly',
    0,
    null
  ),
  -- Sort value conservation mixed item
  (
    '10000000-0000-4000-8000-000000000017',
    'مرجان مخلوط',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  -- Carton unit conversion item (144 pieces/carton)
  (
    '10000000-0000-4000-8000-000000000020',
    'أكواب ورقية',
    'packaging',
    'piece',
    'weekly',
    0,
    null
  ),
  -- Two provisional deficits FIFO item
  (
    '10000000-0000-4000-8000-000000000021',
    'وقار بلدي',
    'seafood',
    'kg',
    'daily',
    0,
    null
  );

insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    loss_pct,
    parent_item_id
  )
values
  (
    '10000000-0000-4000-8000-000000000006',
    'بوري كبير',
    'fish_size',
    'kg',
    'daily',
    0,
    '10000000-0000-4000-8000-000000000005'
  ),
  (
    '10000000-0000-4000-8000-000000000007',
    'بوري وسط',
    'fish_size',
    'kg',
    'daily',
    0,
    '10000000-0000-4000-8000-000000000005'
  ),
  (
    '10000000-0000-4000-8000-000000000008',
    'بوري صغير',
    'fish_size',
    'kg',
    'daily',
    0,
    '10000000-0000-4000-8000-000000000005'
  ),
  (
    '10000000-0000-4000-8000-000000000010',
    'دنيس كبير',
    'fish_size',
    'kg',
    'daily',
    0,
    '10000000-0000-4000-8000-000000000009'
  ),
  (
    '10000000-0000-4000-8000-000000000014',
    'لوت كبير',
    'fish_size',
    'kg',
    'daily',
    0,
    '10000000-0000-4000-8000-000000000013'
  ),
  (
    '10000000-0000-4000-8000-000000000015',
    'لوت وسط',
    'fish_size',
    'kg',
    'daily',
    0,
    '10000000-0000-4000-8000-000000000013'
  ),
  (
    '10000000-0000-4000-8000-000000000018',
    'مرجان كبير',
    'fish_size',
    'kg',
    'daily',
    0,
    '10000000-0000-4000-8000-000000000017'
  ),
  (
    '10000000-0000-4000-8000-000000000019',
    'مرجان وسط',
    'fish_size',
    'kg',
    'daily',
    0,
    '10000000-0000-4000-8000-000000000017'
  );

insert into
  app.item_unit_conversions (item_id, unit, factor_to_base)
values
  (
    '10000000-0000-4000-8000-000000000011',
    'g',
    0.001
  ),
  (
    '10000000-0000-4000-8000-000000000020',
    'carton',
    144
  );

-- ============================================================================
-- 9..13: stock_items parent_item_id constraints
-- ============================================================================
-- 9
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency, parent_item_id)
      values ('حجم بدون أب', 'fish_size', 'kg', 'daily', null)$$,
    '23514'::char(5),
    null::text,
    'fish_size without parent_item_id is rejected'
  );

-- 10
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency, parent_item_id)
      values ('حجم بأب غير مخلوط', 'fish_size', 'kg', 'daily', '10000000-0000-4000-8000-000000000001')$$,
    '23514'::char(5),
    null::text,
    'fish_size pointing to non-fish_mixed parent is rejected'
  );

-- 11
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency, parent_item_id)
      values ('صنف عادي بأب', 'seafood', 'kg', 'daily', '10000000-0000-4000-8000-000000000005')$$,
    '23514'::char(5),
    null::text,
    'non-fish_size item with parent_item_id is rejected'
  );

-- 12
select
  throws_ok (
    $$update app.stock_items
      set kind = 'seafood'
      where id = '10000000-0000-4000-8000-000000000005'$$,
    '23514'::char(5),
    null::text,
    'changing kind of fish_mixed item that has fish_size children is rejected'
  );

-- 13
select
  throws_ok (
    $$update app.stock_items
      set kind = 'fish_size',
          parent_item_id = '10000000-0000-4000-8000-000000000009'
      where id = '10000000-0000-4000-8000-000000000005'$$,
    '23514'::char(5),
    null::text,
    'changing kind of fish_mixed item with children to fish_size with a new parent is rejected'
  );

-- ============================================================================
-- Impersonate the owner for ledger scenarios (tests 13..44)
-- ============================================================================
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

-- ============================================================================
-- 13..16: WAC (10 kg @ 100 then 10 kg @ 200 -> avg 150, value 3000; sell 5 kg -> -750, value 2250)
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000001',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000001',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T09:00:00Z',
        'quantity',
        10,
        'unit_cost',
        200
      )
    )
  );

-- 13
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost, has_uncovered_deficit
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000001'$$,
    $$values (20.000000::numeric(20,6), 3000.00::numeric(14,2), 150.000000::numeric(20,6), false)$$,
    'WAC: 10 kg @100 then 10 kg @200 yields qty 20, value 3000, avg 150'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T10:00:00Z',
        'quantity',
        5,
        'shift_id',
        'shift-wac-1'
      )
    )
  );

-- 14
select
  results_eq (
    $$select quantity, unit_cost, total_cost, is_provisional
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000001'
        and movement_type = 'sale'$$,
    $$values (-5.000000::numeric(20,6), 150.000000::numeric(20,6), -750.00::numeric(14,2), false)$$,
    'WAC: selling 5 kg records total_cost -750 at unit_cost 150'
  );

-- 15
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000001'$$,
    $$values (15.000000::numeric(20,6), 2250.00::numeric(14,2), 150.000000::numeric(20,6))$$,
    'WAC: balance after 5 kg sale is qty 15, value 2250, avg 150'
  );

-- 16
select
  results_eq (
    $$select sum(total_cost)::numeric(14,2)
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000001'$$,
    $$select on_hand_value
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000001'$$,
    'WAC: ledger sum matches on_hand_value'
  );

-- ============================================================================
-- 17..23: Design example, negative stock
-- on-hand 0 with avg 100 -> sell 2 kg -> provisional -200 & deficit row
-- -> buy 5 kg @200 -> cost_adjustment -200 linked to sale (with shift_id),
-- on-hand 3 kg value 600, deficit qty 0, has_uncovered_deficit false, ledger sum == on_hand_value
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000002',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000002',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T08:30:00Z',
        'quantity',
        1
      )
    )
  );

-- 17
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost, has_uncovered_deficit
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000002'$$,
    $$values (0.000000::numeric(20,6), 0.00::numeric(14,2), 100.000000::numeric(20,6), false)$$,
    'Negative stock setup: on-hand 0 with avg_cost 100 preserved'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000002',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T09:00:00Z',
        'quantity',
        2,
        'shift_id',
        'shift-oversold-1'
      )
    )
  );

-- 18
select
  results_eq (
    $$select quantity, unit_cost, total_cost, is_provisional, shift_id
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000002'
        and occurred_at = '2026-10-16T09:00:00Z'$$,
    $$values (-2.000000::numeric(20,6), 100.000000::numeric(20,6), -200.00::numeric(14,2), true, 'shift-oversold-1'::text)$$,
    'Negative stock: selling 2 kg at 0 on-hand creates provisional movement of -200'
  );

-- 19
select
  results_eq (
    $$select pd.qty_uncovered, pd.provisional_unit_cost, ib.has_uncovered_deficit
      from app.provisional_deficits pd
      join app.item_balances ib on ib.item_id = pd.item_id
      where pd.item_id = '10000000-0000-4000-8000-000000000002'$$,
    $$values (2.000000::numeric(20,6), 100.000000::numeric(20,6), true)$$,
    'Negative stock: deficit row has qty_uncovered 2 at provisional cost 100 and flag is true'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000002',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T10:00:00Z',
        'quantity',
        5,
        'unit_cost',
        200,
        'shift_id',
        'shift-purchase-later'
      )
    )
  );

-- 20
select
  results_eq (
    $$select ca.quantity, ca.total_cost, ca.adjusts_movement_id, ca.shift_id
      from app.stock_movements ca
      where ca.item_id = '10000000-0000-4000-8000-000000000002'
        and ca.movement_type = 'cost_adjustment'$$,
    $$select 0.000000::numeric(20,6), -200.00::numeric(14,2), sm.id, 'shift-oversold-1'::text
      from app.stock_movements sm
      where sm.item_id = '10000000-0000-4000-8000-000000000002'
        and sm.is_provisional = true$$,
    'Negative stock: buying 5 kg @200 posts cost_adjustment of -200 linked to the provisional sale and its shift_id'
  );

-- 21
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost, has_uncovered_deficit
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000002'$$,
    $$values (3.000000::numeric(20,6), 600.00::numeric(14,2), 200.000000::numeric(20,6), false)$$,
    'Negative stock: after 5 kg @200 cover, on-hand is 3 kg, value 600, avg 200, has_uncovered_deficit false'
  );

-- 22
select
  results_eq (
    $$select qty_uncovered
      from app.provisional_deficits
      where item_id = '10000000-0000-4000-8000-000000000002'$$,
    $$values (0.000000::numeric(20,6))$$,
    'Negative stock: provisional deficit qty_uncovered reduced to 0'
  );

-- 23
select
  results_eq (
    $$select sum(total_cost)::numeric(14,2)
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000002'$$,
    $$select on_hand_value
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000002'$$,
    'Negative stock: ledger sum equals on_hand_value (600.00)'
  );

-- ============================================================================
-- 24..26: Partial cover (deficit 3 kg, buy 1 kg -> deficit 2 kg left, flag still true)
-- Also tests splitting an outflow that crosses positive on-hand into normal + provisional rows.
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000003',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000003',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T09:00:00Z',
        'quantity',
        4,
        'shift_id',
        'shift-part-1'
      )
    )
  );

-- 24
select
  results_eq (
    $$select quantity, is_provisional
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000003'
        and movement_type = 'sale'
      order by id asc$$,
    $$values
      (-1.000000::numeric(20,6), false),
      (-3.000000::numeric(20,6), true)$$,
    'Partial cover setup: selling 4 kg with 1 kg on hand splits into -1 normal and -3 provisional'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000003',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T10:00:00Z',
        'quantity',
        1,
        'unit_cost',
        160
      )
    )
  );

-- 25
select
  results_eq (
    $$select pd.qty_uncovered, ib.on_hand_qty, ib.has_uncovered_deficit
      from app.provisional_deficits pd
      join app.item_balances ib on ib.item_id = pd.item_id
      where pd.item_id = '10000000-0000-4000-8000-000000000003'$$,
    $$values (2.000000::numeric(20,6), -2.000000::numeric(20,6), true)$$,
    'Partial cover: deficit 3 kg, buy 1 kg leaves 2 kg uncovered and has_uncovered_deficit true'
  );

-- 26
select
  results_eq (
    $$select sum(total_cost)::numeric(14,2)
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000003'$$,
    $$select on_hand_value
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000003'$$,
    'Partial cover: ledger sum matches on_hand_value'
  );

-- ============================================================================
-- 27..29: Never-costed item oversold -> provisional at 0, later purchase charges full cost
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000004',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        3,
        'shift_id',
        'shift-never-costed'
      )
    )
  );

-- 27
select
  results_eq (
    $$select sm.unit_cost, sm.total_cost, sm.is_provisional, pd.qty_uncovered, pd.provisional_unit_cost
      from app.stock_movements sm
      join app.provisional_deficits pd on pd.movement_id = sm.id
      where sm.item_id = '10000000-0000-4000-8000-000000000004'$$,
    $$values (0.000000::numeric(20,6), 0.00::numeric(14,2), true, 3.000000::numeric(20,6), 0.000000::numeric(20,6))$$,
    'Never-costed item: oversold 3 kg is recorded provisionally at unit_cost 0'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000004',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T09:00:00Z',
        'quantity',
        5,
        'unit_cost',
        120
      )
    )
  );

-- 28
select
  results_eq (
    $$select total_cost, shift_id
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000004'
        and movement_type = 'cost_adjustment'$$,
    $$values (-360.00::numeric(14,2), 'shift-never-costed'::text)$$,
    'Never-costed item: later purchase @120 charges full -360.00 via cost_adjustment'
  );

-- 29
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost, has_uncovered_deficit
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000004'$$,
    $$values (2.000000::numeric(20,6), 240.00::numeric(14,2), 120.000000::numeric(20,6), false)$$,
    'Never-costed item: after 5 kg @120 purchase, balance is 2 kg, value 240, avg 120, deficit cleared'
  );

-- ============================================================================
-- 30..33: Sorting example: mixed 100 kg @50 = 5000; sort 100 into 30/45/23
-- -> sort_loss 2 kg = -100, each size in at 50/kg, mixed on-hand 0, value conserved
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000005',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T07:00:00Z',
        'quantity',
        100,
        'unit_cost',
        50
      )
    )
  );

select
  app.post_sort (
    '10000000-0000-4000-8000-000000000005',
    '2026-10-16T08:00:00Z',
    100,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000006',
        'quantity',
        30
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000007',
        'quantity',
        45
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000008',
        'quantity',
        23
      )
    ),
    'shift-sort-1'
  );

-- 30
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000005'$$,
    $$values (0.000000::numeric(20,6), 0.00::numeric(14,2), 50.000000::numeric(20,6))$$,
    'Sorting: mixed item on-hand is 0 kg and value 0.00 after sorting 100 kg'
  );

-- 31
select
  results_eq (
    $$select movement_type, quantity, unit_cost, total_cost
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000005'
        and movement_type in ('sort_out', 'sort_loss')
      order by id asc$$,
    $$values
      ('sort_out'::app.movement_type, -98.000000::numeric(20,6), 50.000000::numeric(20,6), -4900.00::numeric(14,2)),
      ('sort_loss'::app.movement_type, -2.000000::numeric(20,6), 50.000000::numeric(20,6), -100.00::numeric(14,2))$$,
    'Sorting: posts sort_out of -98 kg (-4900) and sort_loss of -2 kg (-100)'
  );

-- 32
select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id in (
        '10000000-0000-4000-8000-000000000006',
        '10000000-0000-4000-8000-000000000007',
        '10000000-0000-4000-8000-000000000008'
      )
      order by item_id asc$$,
    $$values
      ('10000000-0000-4000-8000-000000000006'::uuid, 30.000000::numeric(20,6), 1500.00::numeric(14,2), 50.000000::numeric(20,6)),
      ('10000000-0000-4000-8000-000000000007'::uuid, 45.000000::numeric(20,6), 2250.00::numeric(14,2), 50.000000::numeric(20,6)),
      ('10000000-0000-4000-8000-000000000008'::uuid, 23.000000::numeric(20,6), 1150.00::numeric(14,2), 50.000000::numeric(20,6))$$,
    'Sorting: each fish_size receives its quantity at 50/kg'
  );

-- 33
select
  is (
    (
      select
        (
          (
            select
              sum(on_hand_value)
            from
              app.item_balances
            where
              item_id in (
                '10000000-0000-4000-8000-000000000006',
                '10000000-0000-4000-8000-000000000007',
                '10000000-0000-4000-8000-000000000008'
              )
          ) - (
            select
              total_cost
            from
              app.stock_movements
            where
              item_id = '10000000-0000-4000-8000-000000000005'
              and movement_type = 'sort_loss'
          )
        )::numeric(14, 2)
    ),
    5000.00::numeric(14, 2),
    'Sorting: value conserved (1500 + 2250 + 1150 + 100 = 5000)'
  );

-- 34: Sorting covers an existing deficit on a fish_size item
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000010',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T07:00:00Z',
        'quantity',
        2,
        'shift_id',
        'shift-denis-oversell'
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000009',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T07:30:00Z',
        'quantity',
        10,
        'unit_cost',
        80
      )
    )
  );

select
  app.post_sort (
    '10000000-0000-4000-8000-000000000009',
    '2026-10-16T08:00:00Z',
    5,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000010',
        'quantity',
        5
      )
    ),
    'shift-denis-sort'
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, ib.avg_cost, ib.has_uncovered_deficit, pd.qty_uncovered
      from app.item_balances ib
      join app.provisional_deficits pd on pd.item_id = ib.item_id
      where ib.item_id = '10000000-0000-4000-8000-000000000010'$$,
    $$values (3.000000::numeric(20,6), 240.00::numeric(14,2), 80.000000::numeric(20,6), false, 0.000000::numeric(20,6))$$,
    'Sorting: sort_in covers provisional deficit on fish_size item and updates balance'
  );

-- ============================================================================
-- 35: Unit conversion: purchase 2500 g of a kg item at 0.2/g -> 2.5 kg at 200/kg
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000011',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        2500,
        'unit',
        'g',
        'unit_cost',
        0.2
      )
    )
  );

-- 35
select
  results_eq (
    $$select sm.quantity, sm.unit_cost, sm.total_cost, ib.on_hand_qty, ib.avg_cost, ib.on_hand_value
      from app.stock_movements sm
      join app.item_balances ib on ib.item_id = sm.item_id
      where sm.item_id = '10000000-0000-4000-8000-000000000011'$$,
    $$values (2.500000::numeric(20,6), 200.000000::numeric(20,6), 500.00::numeric(14,2), 2.500000::numeric(20,6), 200.000000::numeric(20,6), 500.00::numeric(14,2))$$,
    'Unit conversion: 2500 g at 0.2/g converts to 2.5 kg at 200/kg (total 500.00)'
  );

-- ============================================================================
-- Rounding & Book-value WAC (Item 4): piaster remainders tie ledger sum to on_hand_value
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000012',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000012',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:10:00Z',
        'quantity',
        2,
        'unit_cost',
        100.50
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000012',
        'movement_type',
        'waste',
        'occurred_at',
        '2026-10-16T08:20:00Z',
        'quantity',
        1.6
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000012',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T08:30:00Z',
        'quantity',
        0.4
      )
    )
  );

-- 37
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000012'$$,
    $$values (1.000000::numeric(20,6), 100.34::numeric(14,2), 100.333333::numeric(20,6))$$,
    'Rounding: piaster remainder stays on on_hand_value (100.34 = 301.00 - 160.53 - 40.13)'
  );

-- 38
select
  is (
    (
      select
        count(*)::int
      from
        app.item_balances ib
      where
        ib.on_hand_value <> (
          select
            coalesce(sum(sm.total_cost), 0)
          from
            app.stock_movements sm
          where
            sm.item_id = ib.item_id
        )
    ),
    0,
    'Rounding conservation: every item_balances.on_hand_value equals sum(stock_movements.total_cost)'
  );

-- Item 4: Buy 1 L @ 100 when on_hand_qty = 1 and on_hand_value = 100.34 -> avg_cost = 100.17
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000012',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:40:00Z',
        'quantity',
        1,
        'unit_cost',
        100
      )
    )
  );

-- 39
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000012'$$,
    $$values (2.000000::numeric(20,6), 200.34::numeric(14,2), 100.170000::numeric(20,6))$$,
    'Book-value WAC: 1 L with book value 100.34 + 1 L @ 100 gives avg_cost 100.170000 and value 200.34'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000012',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T08:50:00Z',
        'quantity',
        2
      )
    )
  );

-- 40
select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000012'$$,
    $$values (0.000000::numeric(20,6), 0.00::numeric(14,2), 100.170000::numeric(20,6))$$,
    'Book-value WAC: selling all 2 L after 100.17 avg leaves on_hand_qty 0 and on_hand_value 0.00'
  );

-- ============================================================================
-- Item 1: Sorting a raw item that has no stock / insufficient stock
-- ============================================================================
-- 41: Never-costed mixed item -> sort raises 'not enough stock to sort...'
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000013',
      '2026-10-16T08:00:00Z',
      1,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000014',
          'quantity', 1
        )
      )
    )$$,
    '22023'::char(5),
    'not enough stock to sort: on_hand_qty 0.000000, requested 1.000000',
    'Sort stock guard: sorting a never-costed mixed item raises not enough stock to sort'
  );

-- Buy 3 kg @ 100 on mixed item 0013
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000013',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T09:00:00Z',
        'quantity',
        3,
        'unit_cost',
        100
      )
    )
  );

-- 42: Mixed with 3 kg -> sorting 5 kg raises 'not enough stock to sort...'
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000013',
      '2026-10-16T09:05:00Z',
      5,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000014',
          'quantity', 5
        )
      )
    )$$,
    '22023'::char(5),
    'not enough stock to sort: on_hand_qty 3.000000, requested 5.000000',
    'Sort stock guard: sorting 5 kg when mixed item has 3 kg raises not enough stock to sort'
  );

-- Sorting exactly the 3 kg on-hand works
select
  app.post_sort (
    '10000000-0000-4000-8000-000000000013',
    '2026-10-16T09:10:00Z',
    3,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000014',
        'quantity',
        2.8
      )
    )
  );

-- 43
select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value
      from app.item_balances
      where item_id in (
        '10000000-0000-4000-8000-000000000013',
        '10000000-0000-4000-8000-000000000014'
      )
      order by item_id$$,
    $$values
      ('10000000-0000-4000-8000-000000000013'::uuid, 0.000000::numeric(20,6), 0.00::numeric(14,2)),
      ('10000000-0000-4000-8000-000000000014'::uuid, 2.800000::numeric(20,6), 280.00::numeric(14,2))$$,
    'Sort stock guard: sorting exactly the 3 kg on-hand succeeds and leaves 0 on mixed item'
  );

-- Oversell mixed item 0013 by 2 kg so it has an uncovered deficit
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000013',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T09:20:00Z',
        'quantity',
        2
      )
    )
  );

-- 44: Mixed item with uncovered deficit -> sort raises 'not enough stock to sort...'
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000013',
      '2026-10-16T09:30:00Z',
      1,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000014',
          'quantity', 1
        )
      )
    )$$,
    '22023'::char(5),
    'not enough stock to sort: on_hand_qty -2.000000, requested 1.000000',
    'Sort stock guard: sorting a mixed item with uncovered deficit raises not enough stock to sort'
  );

-- ============================================================================
-- Item 2: Rounding drift on outflows (1 kg @ 100.50 then 100 outflows of 0.01 kg)
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000016',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        100.50
      )
    ) || (
      select
        jsonb_agg(
          jsonb_build_object(
            'item_id',
            '10000000-0000-4000-8000-000000000016',
            'movement_type',
            'sale',
            'occurred_at',
            (
              '2026-10-16T08:00:00Z'::timestamptz + make_interval(mins => g.i)
            )::text,
            'quantity',
            0.01
          )
          order by
            g.i
        )
      from
        generate_series(1, 100) as g (i)
    )
  );

-- 45
select
  results_eq (
    $$select count(*)::int, -sum(total_cost)::numeric(14,2)
      from app.stock_movements
      where item_id = '10000000-0000-4000-8000-000000000016'
        and movement_type = 'sale'$$,
    $$values (100, 100.50::numeric(14,2))$$,
    'Outflow rounding drift: 100 sales of 0.01 kg from 1 kg @ 100.50 have total outflow cost 100.50'
  );

-- 46
select
  results_eq (
    $$select on_hand_qty, on_hand_value
      from app.item_balances
      where item_id = '10000000-0000-4000-8000-000000000016'$$,
    $$values (0.000000::numeric(20,6), 0.00::numeric(14,2))$$,
    'Outflow rounding drift: final on_hand_qty is 0 and final on_hand_value is 0.00'
  );

-- ============================================================================
-- Item 3: Sorting must conserve value exactly (0.2 kg @ 50.55 sorted into 0.1 + 0.1)
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000017',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        0.2,
        'unit_cost',
        50.55
      )
    )
  );

select
  app.post_sort (
    '10000000-0000-4000-8000-000000000017',
    '2026-10-16T08:30:00Z',
    0.2,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000018',
        'quantity',
        0.1
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000019',
        'quantity',
        0.1
      )
    )
  );

-- 47
select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value
      from app.item_balances
      where item_id in (
        '10000000-0000-4000-8000-000000000017',
        '10000000-0000-4000-8000-000000000018',
        '10000000-0000-4000-8000-000000000019'
      )
      order by item_id$$,
    $$values
      ('10000000-0000-4000-8000-000000000017'::uuid, 0.000000::numeric(20,6), 0.00::numeric(14,2)),
      ('10000000-0000-4000-8000-000000000018'::uuid, 0.100000::numeric(20,6), 5.06::numeric(14,2)),
      ('10000000-0000-4000-8000-000000000019'::uuid, 0.100000::numeric(20,6), 5.05::numeric(14,2))$$,
    'Sort value conservation: 0.2 kg @ 50.55 (value 10.11) splits into 5.06 + 5.05 with 0.00 remaining on mixed'
  );

-- 48
select
  results_eq (
    $$select
        -sum(total_cost) filter (where movement_type in ('sort_out', 'sort_loss'))::numeric(14,2),
        sum(total_cost) filter (where movement_type = 'sort_in')::numeric(14,2)
      from app.stock_movements
      where item_id in (
        '10000000-0000-4000-8000-000000000017',
        '10000000-0000-4000-8000-000000000018',
        '10000000-0000-4000-8000-000000000019'
      )$$,
    $$values (10.11::numeric(14,2), 10.11::numeric(14,2))$$,
    'Sort value conservation: total sort_in value (10.11) equals total sort_out + sort_loss value (10.11)'
  );

-- ============================================================================
-- Item 5: Unit conversion must not change purchase totals (100 cartons x 144 @ 100/carton)
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000020',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        100,
        'unit',
        'carton',
        'unit_cost',
        100
      )
    )
  );

-- 49
select
  results_eq (
    $$select sm.quantity, sm.unit_cost, sm.total_cost, ib.on_hand_qty, ib.avg_cost, ib.on_hand_value
      from app.stock_movements sm
      join app.item_balances ib on ib.item_id = sm.item_id
      where sm.item_id = '10000000-0000-4000-8000-000000000020'$$,
    $$values (
      14400.000000::numeric(20,6),
      0.694444::numeric(20,6),
      10000.00::numeric(14,2),
      14400.000000::numeric(20,6),
      0.694444::numeric(20,6),
      10000.00::numeric(14,2)
    )$$,
    'Unit conversion total: 100 cartons x 144 pieces at 100/carton has exact total_cost 10000.00'
  );

-- ============================================================================
-- Item 10: Two separate provisional deficits covered oldest-first + positive count_adjustment
-- ============================================================================
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000021',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        2,
        'unit_cost',
        100,
        'shift_id',
        'shift-A'
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000021',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T09:00:00Z',
        'quantity',
        5,
        'shift_id',
        'shift-A'
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000021',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T10:00:00Z',
        'quantity',
        4,
        'shift_id',
        'shift-B'
      ),
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000021',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T11:00:00Z',
        'quantity',
        5,
        'unit_cost',
        120,
        'shift_id',
        'shift-C'
      )
    )
  );

-- 50
select
  results_eq (
    $$select
        ca.total_cost,
        ca.shift_id,
        ca.adjusts_movement_id = s.id as points_to_expected_sale
      from app.stock_movements ca
      join app.stock_movements s on s.id = ca.adjusts_movement_id
      where ca.item_id = '10000000-0000-4000-8000-000000000021'
        and ca.movement_type = 'cost_adjustment'
      order by ca.id$$,
    $$values
      (-60.00::numeric(14,2), 'shift-A'::text, true),
      (-40.00::numeric(14,2), 'shift-B'::text, true)$$,
    'Two provisional deficits: covered oldest-first with cost_adjustments -60.00 (shift-A) and -40.00 (shift-B)'
  );

-- 51
select
  results_eq (
    $$select
        array(
          select pd.qty_uncovered
          from app.provisional_deficits pd
          where pd.item_id = '10000000-0000-4000-8000-000000000021'
          order by pd.movement_id
        ),
        ib.on_hand_qty,
        ib.on_hand_value,
        ib.has_uncovered_deficit
      from app.item_balances ib
      where ib.item_id = '10000000-0000-4000-8000-000000000021'$$,
    $$values (
      array[0.000000::numeric(20,6), 2.000000::numeric(20,6)],
      -2.000000::numeric(20,6),
      -200.00::numeric(14,2),
      true
    )$$,
    'Two provisional deficits: first deficit fully covered (0 remaining), second has 2 kg remaining'
  );

-- Positive count_adjustment on item 0001 at avg 150. Capture the balance first so the
-- expectation does not depend on how earlier scenarios left the item.
create temp table pre_count_adjustment on
commit
drop as
select
  on_hand_qty,
  on_hand_value
from
  app.item_balances
where
  item_id = '10000000-0000-4000-8000-000000000001';

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '10000000-0000-4000-8000-000000000001',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-10-16T10:30:00Z',
        'quantity',
        2,
        'note',
        'جرد فعلي زيادة 2 كجم'
      )
    )
  );

-- 52
select
  results_eq (
    $$select sm.quantity, sm.unit_cost, sm.total_cost, ib.on_hand_qty, ib.avg_cost, ib.on_hand_value
      from app.stock_movements sm
      join app.item_balances ib on ib.item_id = sm.item_id
      where sm.item_id = '10000000-0000-4000-8000-000000000001'
        and sm.movement_type = 'count_adjustment'
        and sm.quantity > 0$$,
    $$select
      2.000000::numeric(20,6),
      150.000000::numeric(20,6),
      300.00::numeric(14,2),
      (on_hand_qty + 2)::numeric(20,6),
      150.000000::numeric(20,6),
      (on_hand_value + 300.00)::numeric(14,2)
    from pre_count_adjustment$$,
    'Positive count_adjustment: +2 kg enters at current avg_cost 150 (+300.00) and adds 2 kg and 300.00 to the balance'
  );

-- 53: Conservation invariant across all items after all new scenarios
select
  is (
    (
      select
        count(*)::int
      from
        app.item_balances ib
      where
        ib.on_hand_value <> (
          select
            coalesce(sum(sm.total_cost), 0)
          from
            app.stock_movements sm
          where
            sm.item_id = ib.item_id
        )
    ),
    0,
    'Ledger invariant after new scenarios: every item_balances.on_hand_value equals sum(stock_movements.total_cost)'
  );

-- ============================================================================
-- 54..67: Guards (including non-finite numbers)
-- ============================================================================
-- 54: Back-dated movement against existing item_balances.last_occurred_at
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'sale',
          'occurred_at', '2026-10-16T09:59:59Z',
          'quantity', 1
        )
      )
    )$$,
    'P0001'::char(5),
    'back-dated movement not supported yet',
    'Guard: back-dated movement raises P0001 with required message'
  );

-- 55: Back-dated movement within the same batch array
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'sale',
          'occurred_at', '2026-10-16T11:00:00Z',
          'quantity', 1
        ),
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'sale',
          'occurred_at', '2026-10-16T10:30:00Z',
          'quantity', 1
        )
      )
    )$$,
    'P0001'::char(5),
    'back-dated movement not supported yet',
    'Guard: out-of-order timestamps for the same item inside a single batch raise P0001'
  );

-- 56: Sort with a size of the wrong parent
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000005',
      '2026-10-16T12:00:00Z',
      10,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000010',
          'quantity', 10
        )
      )
    )$$,
    '22023'::char(5),
    null::text,
    'Guard: post_sort with a fish_size of the wrong parent raises'
  );

-- 57: Sort with sizes summing above qty taken
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000005',
      '2026-10-16T12:00:00Z',
      10,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000006',
          'quantity', 7
        ),
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000007',
          'quantity', 4
        )
      )
    )$$,
    '22023'::char(5),
    null::text,
    'Guard: post_sort with sizes summing above p_qty_taken raises'
  );

-- 58: Unknown unit
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000011',
          'movement_type', 'purchase',
          'occurred_at', '2026-10-16T12:00:00Z',
          'quantity', 10,
          'unit', 'box',
          'unit_cost', 50
        )
      )
    )$$,
    '22023'::char(5),
    null::text,
    'Guard: post_movements with unknown unit raises'
  );

-- 59: Disallowed input movement_type (cost_adjustment)
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'cost_adjustment',
          'occurred_at', '2026-10-16T12:00:00Z',
          'quantity', 1,
          'unit_cost', 10
        )
      )
    )$$,
    '22023'::char(5),
    null::text,
    'Guard: post_movements with disallowed movement_type cost_adjustment raises'
  );

-- 60: Item 6 - post_movements rejects quantity = NaN
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'sale',
          'occurred_at', '2026-10-16T12:00:00Z',
          'quantity', 'NaN'
        )
      )
    )$$,
    '22023'::char(5),
    'movement quantity must be a finite number',
    'Guard: post_movements rejects quantity = NaN'
  );

-- 61: Item 6 - post_movements rejects quantity = Infinity
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'sale',
          'occurred_at', '2026-10-16T12:00:00Z',
          'quantity', 'Infinity'
        )
      )
    )$$,
    '22023'::char(5),
    'movement quantity must be a finite number',
    'Guard: post_movements rejects quantity = Infinity'
  );

-- 62: Item 6 - post_movements rejects quantity = -Infinity
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'sale',
          'occurred_at', '2026-10-16T12:00:00Z',
          'quantity', '-Infinity'
        )
      )
    )$$,
    '22023'::char(5),
    'movement quantity must be a finite number',
    'Guard: post_movements rejects quantity = -Infinity'
  );

-- 63: Item 6 - post_movements rejects unit_cost = NaN
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'purchase',
          'occurred_at', '2026-10-16T12:00:00Z',
          'quantity', 1,
          'unit_cost', 'NaN'
        )
      )
    )$$,
    '22023'::char(5),
    'movement unit_cost must be a finite number',
    'Guard: post_movements rejects unit_cost = NaN'
  );

-- 64: Item 6 - post_movements rejects unit_cost = Infinity
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'purchase',
          'occurred_at', '2026-10-16T12:00:00Z',
          'quantity', 1,
          'unit_cost', 'Infinity'
        )
      )
    )$$,
    '22023'::char(5),
    'movement unit_cost must be a finite number',
    'Guard: post_movements rejects unit_cost = Infinity'
  );

-- 65: Item 6 - post_sort rejects p_qty_taken = NaN
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000005',
      '2026-10-16T12:00:00Z',
      'NaN'::numeric,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000006',
          'quantity', 1
        )
      )
    )$$,
    '22023'::char(5),
    'p_qty_taken must be a finite number',
    'Guard: post_sort rejects p_qty_taken = NaN'
  );

-- 66: Item 6 - post_sort rejects p_qty_taken = Infinity
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000005',
      '2026-10-16T12:00:00Z',
      'Infinity'::numeric,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000006',
          'quantity', 1
        )
      )
    )$$,
    '22023'::char(5),
    'p_qty_taken must be a finite number',
    'Guard: post_sort rejects p_qty_taken = Infinity'
  );

-- 67: Item 6 - post_sort rejects size quantity = NaN
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000005',
      '2026-10-16T12:00:00Z',
      10,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000006',
          'quantity', 'NaN'
        )
      )
    )$$,
    '22023'::char(5),
    'size quantity must be a finite number',
    'Guard: post_sort rejects size quantity = NaN'
  );

-- ============================================================================
-- 68..73: Append-only protection & table finite CHECK constraints
-- ============================================================================
-- 68: Owner (authenticated) cannot UPDATE app.stock_movements
select
  throws_ok (
    $$update app.stock_movements set note = 'tampered'$$,
    '42501'::char(5),
    null::text,
    'Append-only: authenticated owner cannot UPDATE app.stock_movements'
  );

-- 69: Owner (authenticated) cannot DELETE from app.stock_movements
select
  throws_ok (
    $$delete from app.stock_movements$$,
    '42501'::char(5),
    null::text,
    'Append-only: authenticated owner cannot DELETE from app.stock_movements'
  );

reset role;

-- 70: Even table owner (postgres) cannot UPDATE app.stock_movements due to trigger
select
  throws_ok (
    $$update app.stock_movements set note = 'tampered'$$,
    '55000'::char(5),
    null::text,
    'Append-only: trigger blocks UPDATE on app.stock_movements even for table owner'
  );

-- 71: Even table owner (postgres) cannot DELETE from app.stock_movements due to trigger
select
  throws_ok (
    $$delete from app.stock_movements$$,
    '55000'::char(5),
    null::text,
    'Append-only: trigger blocks DELETE on app.stock_movements even for table owner'
  );

-- 72: Item 6 - item_balances table CHECK constraint rejects NaN
select
  throws_ok (
    $$insert into app.item_balances (item_id, on_hand_qty)
      values ('10000000-0000-4000-8000-000000000015', 'NaN'::numeric)$$,
    '23514'::char(5),
    null::text,
    'Check constraint: app.item_balances rejects NaN in numeric columns'
  );

-- 73: Item 6 - stock_movements table CHECK constraint rejects NaN
select
  throws_ok (
    $$insert into app.stock_movements (
        batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost
      ) values (
        gen_random_uuid(),
        '10000000-0000-4000-8000-000000000015',
        'purchase',
        '2026-10-16T16:00:00Z',
        'NaN'::numeric,
        10,
        10
      )$$,
    '23514'::char(5),
    null::text,
    'Check constraint: app.stock_movements rejects NaN in numeric columns'
  );

-- ============================================================================
-- 74..85: Authorization & RLS
-- ============================================================================
set
  local role anon;

-- 74
select
  throws_ok (
    $$select app.post_movements('[]'::jsonb)$$,
    '42501'::char(5),
    null::text,
    'Auth: anon cannot execute app.post_movements'
  );

-- 75
select
  throws_ok (
    $$select app.post_sort('10000000-0000-4000-8000-000000000005', now(), 1, '[]'::jsonb, null)$$,
    '42501'::char(5),
    null::text,
    'Auth: anon cannot execute app.post_sort'
  );

-- 76
select
  throws_ok (
    $$select * from app.stock_movements$$,
    '42501'::char(5),
    null::text,
    'Auth: anon cannot select from app.stock_movements'
  );

reset role;

-- Item 9: Session with no role claim and no owner gets insufficient_privilege
select
  set_config('request.jwt.claims', '', true);

set
  local role authenticated;

-- 77
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'sale',
          'occurred_at', '2026-10-16T15:00:00Z',
          'quantity', 1
        )
      )
    )$$,
    '42501'::char(5),
    'insufficient_privilege',
    'Auth: session with no role claim and no owner gets insufficient_privilege on app.post_movements'
  );

-- 78
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000005',
      '2026-10-16T15:00:00Z',
      1,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000006',
          'quantity', 1
        )
      )
    )$$,
    '42501'::char(5),
    'insufficient_privilege',
    'Auth: session with no role claim and no owner gets insufficient_privilege on app.post_sort'
  );

reset role;

-- Impersonate non-owner authenticated user (intruder)
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

-- 79
select
  throws_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'sale',
          'occurred_at', '2026-10-16T15:00:00Z',
          'quantity', 1
        )
      )
    )$$,
    '42501'::char(5),
    'insufficient_privilege',
    'Auth: non-owner authenticated user gets insufficient_privilege on app.post_movements'
  );

-- 80
select
  throws_ok (
    $$select app.post_sort(
      '10000000-0000-4000-8000-000000000005',
      '2026-10-16T15:00:00Z',
      1,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000006',
          'quantity', 1
        )
      )
    )$$,
    '42501'::char(5),
    'insufficient_privilege',
    'Auth: non-owner authenticated user gets insufficient_privilege on app.post_sort'
  );

-- 81
select
  is_empty (
    $$select id from app.stock_items$$,
    'RLS: non-owner authenticated user sees zero rows in app.stock_items'
  );

-- 82
select
  is_empty (
    $$select id from app.stock_movements$$,
    'RLS: non-owner authenticated user sees zero rows in app.stock_movements'
  );

-- 83
select
  is_empty (
    $$select item_id from app.item_balances$$,
    'RLS: non-owner authenticated user sees zero rows in app.item_balances'
  );

reset role;

-- Impersonate owner authenticated user to verify direct INSERT into stock_movements is denied
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

-- 84
select
  throws_ok (
    $$insert into app.stock_movements (
      batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost
    ) values (
      gen_random_uuid(),
      '10000000-0000-4000-8000-000000000001',
      'purchase',
      '2026-10-16T16:00:00Z',
      1,
      100,
      100
    )$$,
    '42501'::char(5),
    null::text,
    'Auth: direct INSERT into app.stock_movements by authenticated owner is denied'
  );

reset role;

-- 85: service_role can post movements
select
  set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

set
  local role service_role;

select
  lives_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '10000000-0000-4000-8000-000000000001',
          'movement_type', 'count_adjustment',
          'occurred_at', '2026-10-16T16:00:00Z',
          'quantity', -1,
          'note', 'service_role count adjustment'
        )
      )
    )$$,
    'Auth: service_role can execute app.post_movements'
  );

reset role;

select
  *
from
  finish ();

rollback;
