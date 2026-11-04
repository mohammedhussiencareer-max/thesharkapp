-- Synthetic data for the backup round trip. Run once on a fresh local stack as
-- the postgres role in a single transaction (psql -1) with -v owner=<uuid>.
-- The owner auth user must exist (create-user.sql). Everything goes through the
-- real RPCs, as in supabase/tests. No customer data, no POS documents.
insert into
  app.owner (user_id)
values
  (:'owner');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', :'owner', 'role', 'authenticated')::text,
    false
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
  ('b4c00000-0000-4000-8000-000000000001', 'seed-shrimp', 'seafood', 'kg', 'daily', 0, null),
  ('b4c00000-0000-4000-8000-000000000002', 'seed-mixed-fish', 'fish_mixed', 'kg', 'daily', 0, null),
  ('b4c00000-0000-4000-8000-000000000003', 'seed-fish-size', 'fish_size', 'kg', 'daily', 0, 'b4c00000-0000-4000-8000-000000000002'),
  ('b4c00000-0000-4000-8000-000000000004', 'seed-lossy', 'seafood', 'kg', 'daily', 0, null),
  ('b4c00000-0000-4000-8000-000000000005', 'seed-priced', 'seafood', 'kg', 'daily', 0, null);

insert into
  app.item_unit_conversions (item_id, unit, factor_to_base)
values
  ('b4c00000-0000-4000-8000-000000000001', 'box', 10);

-- Costing configuration first, on items that have no movements yet.
select
  app.set_item_loss (
    'b4c00000-0000-4000-8000-000000000101',
    'b4c00000-0000-4000-8000-000000000004',
    0.10,
    '2026-01-01 00:00:00+00',
    null,
    md5(''),
    'seed loss'
  );

select
  app.set_item_opening_price (
    'b4c00000-0000-4000-8000-000000000102',
    'b4c00000-0000-4000-8000-000000000005',
    55.5,
    null,
    null
  );

-- Opening stock, a purchase, a sort and two sales, all moving forward in time.
select
  app.record_opening_stock (
    '2026-08-01T08:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id', 'b4c00000-0000-4000-8000-000000000001',
        'quantity', '20',
        'unit', 'kg',
        'unit_cost', '100',
        'expected_base_unit', 'kg',
        'expected_factor', '1'
      ),
      jsonb_build_object(
        'item_id', 'b4c00000-0000-4000-8000-000000000002',
        'quantity', '50',
        'unit', 'kg',
        'unit_cost', '60',
        'expected_base_unit', 'kg',
        'expected_factor', '1'
      )
    ),
    'b4c00000-0000-4000-8000-000000000201'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'request_id', 'b4c00000-0000-4000-8000-000000000202',
      'purchased_at', '2026-08-05T09:00:00Z',
      'supplier', 'seed supplier',
      'invoice_no', 'SEED-1',
      'note', 'seed purchase',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'b4c00000-0000-4000-8000-000000000001',
          'quantity', '3',
          'unit', 'box',
          'amount_paid', '3600.00',
          'expected_base_unit', 'kg',
          'expected_factor', '10'
        ),
        jsonb_build_object(
          'item_id', 'b4c00000-0000-4000-8000-000000000002',
          'quantity', '10',
          'unit', 'kg',
          'amount_paid', '650.00',
          'expected_base_unit', 'kg',
          'expected_factor', '1'
        )
      )
    )
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id', 'b4c00000-0000-4000-8000-000000000203',
      'mixed_item_id', 'b4c00000-0000-4000-8000-000000000002',
      'occurred_at', '2026-08-06T10:00:00Z',
      'qty_taken', '20',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'b4c00000-0000-4000-8000-000000000003',
          'quantity', '20'
        )
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id', 'b4c00000-0000-4000-8000-000000000003',
        'movement_type', 'sale',
        'occurred_at', '2026-08-07T11:00:00Z',
        'quantity', 5,
        'shift_id', 'shift-seed-1'
      ),
      jsonb_build_object(
        'item_id', 'b4c00000-0000-4000-8000-000000000001',
        'movement_type', 'sale',
        'occurred_at', '2026-08-07T11:05:00Z',
        'quantity', 8,
        'shift_id', 'shift-seed-1'
      )
    )
  );

-- Expenses: two entries, one voided, then the month marked complete.
select
  app.add_expense_entry (
    p_category_id => (
      select id from app.expense_categories where kind = 'fixed_monthly' order by name limit 1
    ),
    p_amount => 1000.00,
    p_period_month => date '2026-09-01',
    p_is_estimate => false,
    p_note => 'seed-rent',
    p_request_id => 'b4c00000-0000-4000-8000-000000000301'
  );

select
  app.add_expense_entry (
    p_category_id => (
      select id from app.expense_categories where kind = 'fixed_monthly' order by name limit 1
    ),
    p_amount => 250.00,
    p_period_month => date '2026-09-01',
    p_is_estimate => false,
    p_note => 'seed-extra',
    p_request_id => 'b4c00000-0000-4000-8000-000000000302'
  );

select
  app.void_expense_entry (
    (select id from app.expense_entries where note = 'seed-extra'),
    'seed void',
    'b4c00000-0000-4000-8000-000000000303'
  );

select app.set_month_expense_complete (date '2026-09-01', true);

-- POS ingest: one shift and two orders with accounting fields only.
select app.start_pos_sync_run ('recent') as run_id \gset

select
  app.ingest_pos_batch (
    :run_id,
    jsonb_build_array(
      jsonb_build_object(
        'id', 'shift-seed-1',
        'opened_at', '2026-08-07T09:00:00Z',
        'closed_at', null,
        'is_active', true,
        'pos_update_time', '2026-08-07T18:00:00Z',
        'transactions', '[]'::jsonb
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'id', 'order-seed-1',
        'order_number', 1001,
        'shift_id', 'shift-seed-1',
        'status', 'complete',
        'order_type', 'takeaway',
        'payment_type', 'cash',
        'ordered_at', '2026-08-07T12:00:00Z',
        'subtotal', 200,
        'discount', 0,
        'tax', 0,
        'service_tax', 0,
        'delivery_fee', 0,
        'total', 200,
        'financial_revision', 1,
        'last_financial_operation_key', 'op-seed-1',
        'pos_update_time', '2026-08-07T12:00:00Z',
        'content_hash', repeat('ab', 32),
        'lines', jsonb_build_array(
          jsonb_build_object(
            'line_id', 'line-seed-1',
            'item_id', 'item-seed-1',
            'item_name', 'Seed item',
            'size_name', 'Large',
            'quantity', 2,
            'weighted_qty', null,
            'weighted_unit', 'kg',
            'unit_price', 100,
            'price_per_kg', null,
            'line_total', 200,
            'options', '[]'::jsonb
          )
        )
      ),
      jsonb_build_object(
        'id', 'order-seed-2',
        'order_number', 1002,
        'shift_id', 'shift-seed-1',
        'status', 'complete',
        'order_type', 'takeaway',
        'payment_type', 'cash',
        'ordered_at', '2026-08-07T12:30:00Z',
        'subtotal', 90,
        'discount', 0,
        'tax', 0,
        'service_tax', 0,
        'delivery_fee', 0,
        'total', 90,
        'financial_revision', 1,
        'last_financial_operation_key', 'op-seed-2',
        'pos_update_time', '2026-08-07T12:30:00Z',
        'content_hash', repeat('cd', 32),
        'lines', jsonb_build_array(
          jsonb_build_object(
            'line_id', 'line-seed-2',
            'item_id', 'item-seed-1',
            'item_name', 'Seed item',
            'size_name', 'Large',
            'quantity', 1,
            'weighted_qty', null,
            'weighted_unit', 'kg',
            'unit_price', 90,
            'price_per_kg', null,
            'line_total', 90,
            'options', '[]'::jsonb
          )
        )
      )
    ),
    null
  );

select app.finish_pos_sync_run (:run_id, 'ok', '{}'::jsonb, null);
