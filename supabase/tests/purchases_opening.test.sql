begin;

select
  no_plan ();

-- Clean up any existing test rows in the transaction.
alter table app.purchase_lines disable trigger trg_purchase_lines_no_update_delete;

delete from app.purchase_lines;

alter table app.purchase_lines enable trigger trg_purchase_lines_no_update_delete;

alter table app.purchases disable trigger trg_purchases_no_update_delete;

delete from app.purchases;

alter table app.purchases enable trigger trg_purchases_no_update_delete;

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
-- Schema, grants, policies, triggers, lock order
-- ============================================================================
select
  has_table ('app', 'purchases', 'app.purchases exists');

select
  has_table (
    'app',
    'purchase_lines',
    'app.purchase_lines exists'
  );

select
  has_function (
    'app',
    'record_purchase',
    array['jsonb'],
    'app.record_purchase(jsonb) exists'
  );

select
  has_function (
    'app',
    'record_opening_stock',
    array['timestamptz', 'jsonb', 'uuid'],
    'app.record_opening_stock(timestamptz, jsonb, uuid) exists'
  );

select
  has_index (
    'app',
    'purchases',
    'purchases_purchased_at_idx',
    'purchases are indexed by purchased_at'
  );

select
  has_index (
    'app',
    'purchases',
    'purchases_batch_id_key',
    'purchase batch_id is unique'
  );

select
  has_index (
    'app',
    'purchase_lines',
    'purchase_lines_item_id_idx',
    'purchase lines are indexed by item'
  );

select
  has_index (
    'app',
    'purchase_lines',
    'purchase_lines_movement_id_key',
    'each movement is linked from at most one purchase line'
  );

select
  has_trigger (
    'app',
    'purchases',
    'trg_purchases_no_update_delete',
    'purchases reject update and delete'
  );

select
  has_trigger (
    'app',
    'purchases',
    'trg_purchases_no_truncate',
    'purchases reject truncate'
  );

select
  has_trigger (
    'app',
    'purchase_lines',
    'trg_purchase_lines_no_update_delete',
    'purchase lines reject update and delete'
  );

select
  has_trigger (
    'app',
    'purchase_lines',
    'trg_purchase_lines_no_truncate',
    'purchase lines reject truncate'
  );

select
  ok (
    (
      select
        p.prosecdef
        and 'search_path=""' = any (p.proconfig)
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'record_purchase'
    ),
    'record_purchase is security definer with an empty search_path'
  );

select
  ok (
    (
      select
        p.prosecdef
        and 'search_path=""' = any (p.proconfig)
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'record_opening_stock'
    ),
    'record_opening_stock is security definer with an empty search_path'
  );

-- Concurrent safety: pgTAP runs in one session, so it cannot interleave two
-- transactions. Both functions call app.assert_ledger_write_allowed before any
-- catalog read, movement check, or balance row lock (asserted below). That
-- takes advisory lock 7342750000000000001, the same lock every other ledger
-- post takes first. Claude tests the race with two sessions.
select
  ok (
    (
      select
        position('app.assert_ledger_write_allowed' in def) > 0
        and position('app.assert_ledger_write_allowed' in def) < position('app.apply_inflow_movement' in def)
        and position('for update' in lower(def)) = 0
      from
        (
          select
            pg_catalog.pg_get_functiondef ('app.record_purchase(jsonb)'::regprocedure) as def
        ) s
    ),
    'record_purchase takes the posting lock before inflow and does not lock rows itself'
  );

select
  ok (
    (
      select
        position('app.assert_ledger_write_allowed' in def) > 0
        and position('app.assert_ledger_write_allowed' in def) < position('app.stock_movements' in def)
        and position('app.stock_movements' in def) < position('app.post_movements' in def)
      from
        (
          select
            pg_catalog.pg_get_functiondef (
              'app.record_opening_stock(timestamptz,jsonb,uuid)'::regprocedure
            ) as def
        ) s
    ),
    'record_opening_stock takes the posting lock before the movement check and before post_movements'
  );

select
  ok (
    has_function_privilege(
      'authenticated',
      'app.record_purchase(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app.record_purchase(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app.record_purchase(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.record_purchase(jsonb)'::regprocedure,
      'EXECUTE'
    ),
    'record_purchase execute is granted to authenticated and service_role only'
  );

select
  ok (
    has_function_privilege(
      'authenticated',
      'app.record_opening_stock(timestamptz,jsonb,uuid)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app.record_opening_stock(timestamptz,jsonb,uuid)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app.record_opening_stock(timestamptz,jsonb,uuid)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.record_opening_stock(timestamptz,jsonb,uuid)'::regprocedure,
      'EXECUTE'
    ),
    'record_opening_stock execute is granted to authenticated and service_role only'
  );

select
  ok (
    not has_function_privilege(
      'anon',
      'app.prevent_purchase_mutation()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app.prevent_purchase_mutation()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.prevent_purchase_mutation()'::regprocedure,
      'EXECUTE'
    ),
    'the append-only trigger function is not executable via the API'
  );

select
  results_eq (
    $$select privilege_type::text collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'purchases'
        and grantee = 'authenticated'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select purchases'
  );

select
  results_eq (
    $$select privilege_type::text collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'purchase_lines'
        and grantee = 'authenticated'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select purchase lines'
  );

select
  results_eq (
    $$select privilege_type::text collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'purchases'
        and grantee = 'service_role'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'service_role can only select purchases'
  );

select
  is_empty (
    $$select privilege_type
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name in ('purchases', 'purchase_lines')
        and grantee in ('anon', 'PUBLIC')$$,
    'anon and public have no privileges on purchase tables'
  );

select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename = 'purchases'
        and policyname = 'purchases_select_owner'
        and cmd = 'SELECT'
        and roles = '{authenticated}'::name[]
    )
    and exists (
      select
        1
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename = 'purchase_lines'
        and policyname = 'purchase_lines_select_owner'
        and cmd = 'SELECT'
        and roles = '{authenticated}'::name[]
    ),
    'owner select policies exist on both purchase tables'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename in ('purchases', 'purchase_lines')
        and cmd <> 'SELECT'
    ),
    0::bigint,
    'purchase tables have no insert, update, or delete policies'
  );

-- ============================================================================
-- Synthetic catalog. Not restaurant data.
-- ============================================================================
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    '20000000-0000-4000-8000-000000000001',
    'زيت اختبار',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'جمبري اختبار',
    'seafood',
    'kg',
    'daily'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'قطع اختبار',
    'packaging',
    'piece',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    'عينة مجانية',
    'packaging',
    'piece',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    'صنف جديد',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    'زيت كرتونة',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-000000000007',
    'بوري اختبار',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    '20000000-0000-4000-8000-000000000008',
    'خام اختبار',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-000000000009',
    'صنف خدمة',
    'packaging',
    'piece',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-00000000000a',
    'صنف إعادة فتح',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-00000000000b',
    'صنف كيس',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-00000000000c',
    'صنف وحدة شراء',
    'packaging',
    'piece',
    'weekly'
  ),
  (
    '20000000-0000-4000-8000-00000000000d',
    'صنف وحدة فتح',
    'packaging',
    'piece',
    'weekly'
  );

insert into
  app.item_unit_conversions (item_id, unit, factor_to_base)
values
  (
    '20000000-0000-4000-8000-000000000001',
    'لتر',
    0.92
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    'كرتونة',
    12
  ),
  ('20000000-0000-4000-8000-00000000000b', 'كيس', 4);

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
-- Opening stock
-- ============================================================================
select
  app.record_opening_stock (
    '2026-10-21T08:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '20000000-0000-4000-8000-000000000007',
        'quantity',
        '10',
        'unit',
        'kg',
        'unit_cost',
        '100',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      ),
      jsonb_build_object(
        'item_id',
        '20000000-0000-4000-8000-000000000006',
        'quantity',
        '2',
        'unit',
        'كرتونة',
        'unit_cost',
        '30',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '12'
      ),
      jsonb_build_object(
        'item_id',
        '20000000-0000-4000-8000-000000000008',
        'quantity',
        '0',
        'unit',
        'kg',
        'unit_cost',
        '5'
      )
    ),
    'a1000000-0000-4000-8000-000000000001'
  );

select
  is (
    (
      select
        count(distinct batch_id)
      from
        app.stock_movements
      where
        item_id in (
          '20000000-0000-4000-8000-000000000006',
          '20000000-0000-4000-8000-000000000007'
        )
    ),
    1::bigint,
    'opening of two items posts one batch'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type = 'opening'
        and source_type = 'opening'
    ),
    2::bigint,
    'both opening rows are opening movements and the zero line is skipped'
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '20000000-0000-4000-8000-000000000007'$$,
    $$values (10::numeric(20, 6), 1000::numeric(14, 2), 100::numeric(20, 6))$$,
    'opening in the base unit updates quantity, value, and average'
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '20000000-0000-4000-8000-000000000006'$$,
    $$values (24::numeric(20, 6), 60::numeric(14, 2), 2.5::numeric(20, 6))$$,
    'opening in a converted unit posts base quantity and the piaster value'
  );

select
  is_empty (
    $$select item_id
      from app.stock_movements
      where item_id = '20000000-0000-4000-8000-000000000008'$$,
    'quantity 0 opening line does not post'
  );

select
  throws_ok (
    $$select app.record_opening_stock(
      '2026-10-21T08:30:00Z',
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000008',
          'quantity', 1, 'unit', 'kg', 'unit_cost', 1
        ),
        jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000008',
          'quantity', 2, 'unit', 'kg', 'unit_cost', 1
        )
      ),
      'a1000000-0000-4000-8000-000000000002'
    )$$,
    '22023',
    'duplicate opening item: خام اختبار',
    'duplicate opening item is rejected and names the item'
  );

select
  throws_ok (
    $$select app.record_opening_stock(
      '2026-10-21T08:30:00Z',
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000007',
          'quantity', 1, 'unit', 'kg', 'unit_cost', 1
        )
      ),
      'a1000000-0000-4000-8000-000000000003'
    )$$,
    '22023',
    'item already has movements: بوري اختبار',
    'opening is refused for an item that already has a movement'
  );

select
  throws_ok (
    $$select app.record_opening_stock(
      '2026-10-21T08:30:00Z',
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000008',
          'quantity', 1, 'unit', 'kg', 'unit_cost', -1
        )
      ),
      'a1000000-0000-4000-8000-000000000004'
    )$$,
    '22023',
    'opening unit_cost must be >= 0',
    'negative opening cost is rejected'
  );

select
  throws_ok (
    $$select app.record_opening_stock(
      '2026-10-21T08:30:00Z',
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000008',
          'quantity', -1, 'unit', 'kg', 'unit_cost', 1
        )
      ),
      'a1000000-0000-4000-8000-000000000005'
    )$$,
    '22023',
    'quantity must be a finite number >= 0',
    'negative opening quantity is rejected'
  );

select
  throws_ok (
    $$select app.record_opening_stock(
      '2026-10-21T08:30:00Z',
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000008',
          'quantity', 0, 'unit', 'kg'
        )
      ),
      'a1000000-0000-4000-8000-000000000006'
    )$$,
    '22023',
    'at least one opening line is required',
    'an opening of only zero lines is rejected'
  );

select
  is_empty (
    $$select item_id
      from app.stock_movements
      where item_id = '20000000-0000-4000-8000-000000000008'$$,
    'refused opening calls leave the untouched item without movements'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type = 'opening'
    ),
    2::bigint,
    'refused opening calls add no movements'
  );

-- ============================================================================
-- Purchases
-- ============================================================================
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-10-21T10:00:00Z',
      'request_id',
      'b1000000-0000-4000-8000-000000000001',
      'supplier',
      '  مورد اختبار  ',
      'invoice_no',
      ' T-1 ',
      'note',
      ' ملاحظة ',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-000000000002',
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
        ),
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-000000000002',
          'quantity',
          '10',
          'unit',
          'kg',
          'amount_paid',
          '2000',
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
        purchased_at
      from
        app.purchases
      where
        supplier = 'مورد اختبار'
    ),
    '2026-10-21T10:00:00Z'::timestamptz,
    'purchased_at stores the given instant and trims the supplier'
  );

select
  is (
    (
      select
        created_by
      from
        app.purchases
      where
        supplier = 'مورد اختبار'
    ),
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f'::uuid,
    'purchase created_by is the owner'
  );

select
  results_eq (
    $$select invoice_no, note, total_paid
      from app.purchases
      where supplier = 'مورد اختبار'$$,
    $$values ('T-1'::text, 'ملاحظة'::text, 3000::numeric(14, 2))$$,
    'header stores trimmed invoice and note and the sum of the lines'
  );

select
  results_eq (
    $$select pl.line_no, pl.quantity, pl.unit, pl.base_quantity, pl.amount_paid,
            sm.quantity, sm.unit_cost, sm.total_cost
      from app.purchase_lines pl
      join app.stock_movements sm on sm.id = pl.movement_id
      where pl.item_id = '20000000-0000-4000-8000-000000000002'
      order by pl.line_no$$,
    $$values
      (1, 10::numeric(20, 6), 'kg'::text, 10::numeric(20, 6), 1000::numeric(14, 2), 10::numeric(20, 6), 100::numeric(20, 6), 1000::numeric(14, 2)),
      (2, 10::numeric(20, 6), 'kg'::text, 10::numeric(20, 6), 2000::numeric(14, 2), 10::numeric(20, 6), 200::numeric(20, 6), 2000::numeric(14, 2))$$,
    'base-unit lines keep amount_paid as the movement total_cost'
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '20000000-0000-4000-8000-000000000002'$$,
    $$values (20::numeric(20, 6), 3000::numeric(14, 2), 150::numeric(20, 6))$$,
    'two purchase lines update the moving average'
  );

select
  is (
    (
      select
        count(distinct sm.batch_id)
      from
        app.stock_movements sm
      where
        sm.item_id = '20000000-0000-4000-8000-000000000002'
    ),
    1::bigint,
    'one purchase posts one ledger batch'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-10-21T11:00:00Z',
      'request_id',
      'b1000000-0000-4000-8000-000000000002',
      'supplier',
      '   ',
      'invoice_no',
      '',
      'note',
      ' ',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-000000000001',
          'quantity',
          '2',
          'unit',
          'لتر',
          'amount_paid',
          '50.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '0.92'
        )
      )
    )
  );

select
  results_eq (
    $$select pl.quantity, pl.unit, pl.base_quantity, pl.amount_paid, sm.quantity, sm.total_cost, sm.unit_cost
      from app.purchase_lines pl
      join app.stock_movements sm on sm.id = pl.movement_id
      where pl.item_id = '20000000-0000-4000-8000-000000000001'$$,
    $$values (
      2::numeric(20, 6),
      'لتر'::text,
      round(2 * 0.92, 6)::numeric(20, 6),
      50::numeric(14, 2),
      round(2 * 0.92, 6)::numeric(20, 6),
      50::numeric(14, 2),
      round(50::numeric / round(2 * 0.92, 6), 6)::numeric(20, 6)
    )$$,
    'converted purchase stores entered quantity, base quantity, and amount_paid as total_cost'
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '20000000-0000-4000-8000-000000000001'$$,
    $$values (
      round(2 * 0.92, 6)::numeric(20, 6),
      50::numeric(14, 2),
      round(50::numeric / round(2 * 0.92, 6), 6)::numeric(20, 6)
    )$$,
    'converted purchase updates base quantity, value, and moving average'
  );

select
  ok (
    (
      select
        p.supplier is null
        and p.invoice_no is null
        and p.note is null
      from
        app.purchases p
        join app.purchase_lines pl on pl.purchase_id = p.id
      where
        pl.item_id = '20000000-0000-4000-8000-000000000001'
    ),
    'blank supplier, invoice, and note are stored as null'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-10-21T12:00:00Z',
      'request_id',
      'b1000000-0000-4000-8000-000000000003',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-000000000003',
          'quantity',
          '10005',
          'unit',
          'piece',
          'amount_paid',
          '10.00',
          'expected_base_unit',
          'piece',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  ok (
    (
      select
        sm.total_cost = pl.amount_paid
        and sm.total_cost = ib.on_hand_value
        and sm.unit_cost = round(pl.amount_paid / pl.base_quantity, 6)
        and round(sm.quantity * sm.unit_cost, 2) <> sm.total_cost
      from
        app.purchase_lines pl
        join app.stock_movements sm on sm.id = pl.movement_id
        join app.item_balances ib on ib.item_id = pl.item_id
      where
        pl.item_id = '20000000-0000-4000-8000-000000000003'
    ),
    'total_cost stays equal to amount_paid when qty times rounded unit cost is another piaster'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-10-21T13:00:00Z',
      'request_id',
      'b1000000-0000-4000-8000-000000000004',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-000000000004',
          'quantity',
          '1',
          'unit',
          'piece',
          'amount_paid',
          '0',
          'expected_base_unit',
          'piece',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  results_eq (
    $$select sm.total_cost, sm.unit_cost, ib.on_hand_qty, ib.on_hand_value, ib.avg_cost
      from app.purchase_lines pl
      join app.stock_movements sm on sm.id = pl.movement_id
      join app.item_balances ib on ib.item_id = pl.item_id
      where pl.item_id = '20000000-0000-4000-8000-000000000004'$$,
    $$values (0::numeric(14, 2), 0::numeric(20, 6), 1::numeric(20, 6), 0::numeric(14, 2), 0::numeric(20, 6))$$,
    'a zero amount_paid posts a zero total_cost and a zero average'
  );

select
  is (
    (
      select
        count(*)
      from
        app.purchases
    ),
    4::bigint,
    'four purchases exist before the failing calls'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
    ),
    7::bigint,
    'seven movements exist before the failing calls'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T14:00:00Z',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000001',
          'quantity', '1', 'unit', 'kg', 'amount_paid', '10'
        ),
        jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000001',
          'quantity', '1', 'unit', 'دلو', 'amount_paid', '10'
        )
      )
    ))$$,
    '22023',
    'unknown unit "دلو" for item زيت اختبار',
    'a bad purchase line names the item'
  );

select
  lives_ok (
    $test$
    do $body$
    declare
      v_detail text;
      v_message text;
      v_state text;
      v_purchases bigint;
      v_fresh bigint;
    begin
      select count(*) into v_purchases from app.purchases;
      begin
        perform app.record_purchase(
          jsonb_build_object(
            'purchased_at', '2026-10-21T09:00:00Z',
            'request_id', 'b1000000-0000-4000-8000-000000000005',
            'lines', jsonb_build_array(
              jsonb_build_object(
                'item_id', '20000000-0000-4000-8000-000000000005',
                'quantity', '1', 'unit', 'kg', 'amount_paid', '10',
                'expected_base_unit', 'kg', 'expected_factor', '1'
              ),
              jsonb_build_object(
                'item_id', '20000000-0000-4000-8000-000000000002',
                'quantity', '1', 'unit', 'kg', 'amount_paid', '10',
                'expected_base_unit', 'kg', 'expected_factor', '1'
              )
            )
          )
        );
        raise exception 'expected back-dated failure';
      exception
        when others then
          get stacked diagnostics
            v_message = message_text,
            v_state = returned_sqlstate,
            v_detail = pg_exception_detail;
          if v_state is distinct from 'P0001'
          or v_message is distinct from 'back-dated movement not supported yet'
          or v_detail is distinct from 'جمبري اختبار' then
            raise exception 'bad diagnostics state=% message=% detail=%',
              v_state, v_message, v_detail;
          end if;
      end;
      select count(*) into v_fresh
      from app.stock_movements
      where item_id = '20000000-0000-4000-8000-000000000005';
      if (select count(*) from app.purchases) <> v_purchases or v_fresh <> 0 then
        raise exception 'back-dated purchase saved rows';
      end if;
    end
    $body$;
    $test$,
    'back-dated line raises the ledger error, names the item, and saves nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.purchases
    ),
    4::bigint,
    'failed purchase calls save no header'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
    ),
    7::bigint,
    'failed purchase calls save no movement'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-10-21T15:00:00Z',
      'request_id',
      'b1000000-0000-4000-8000-000000000006',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-000000000007',
          'quantity',
          '1',
          'unit',
          'kg',
          'amount_paid',
          '80',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '20000000-0000-4000-8000-000000000007'$$,
    $$values (
      11::numeric(20, 6),
      1080::numeric(14, 2),
      round(1080::numeric / 11, 6)::numeric(20, 6)
    )$$,
    'mixed fish is purchased on its fish_mixed item like any other item'
  );

select
  app.record_opening_stock (
    '2026-10-21T16:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '20000000-0000-4000-8000-000000000008',
        'quantity',
        '4',
        'unit',
        'kg',
        'unit_cost',
        '12.5',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'a1000000-0000-4000-8000-000000000007'
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = '20000000-0000-4000-8000-000000000008'$$,
    $$values (4::numeric(20, 6), 50::numeric(14, 2), 12.5::numeric(20, 6))$$,
    'an item whose zero line was skipped can still be opened'
  );

select
  ok (
    not exists (
      select
        1
      from
        app.purchase_lines pl
        join app.stock_movements sm on sm.id = pl.movement_id
        join app.purchases p on p.id = pl.purchase_id
      where
        sm.total_cost is distinct from pl.amount_paid
        or sm.source_type is distinct from 'purchase'
        or sm.source_id is distinct from p.id::text
        or sm.batch_id is distinct from p.batch_id
        or sm.movement_type is distinct from 'purchase'
    ),
    'every purchase line matches its movement total, source, and batch'
  );

select
  ok (
    not exists (
      select
        1
      from
        app.item_balances ib
      where
        ib.on_hand_value is distinct from (
          select
            coalesce(sum(sm.total_cost), 0)
          from
            app.stock_movements sm
          where
            sm.item_id = ib.item_id
        )
    ),
    'on_hand_value equals the sum of movement totals'
  );

-- ============================================================================
-- Validation messages
-- ============================================================================
select
  throws_ok (
    $$select app.record_purchase('[]'::jsonb)$$,
    '22023',
    'p_purchase must be a jsonb object',
    'purchase payload must be an object'
  );

select
  throws_ok (
    $$select app.record_purchase('{"lines":[]}'::jsonb)$$,
    '22023',
    'purchased_at is required',
    'purchased_at is required'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', 'infinity',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', 1, 'unit', 'kg', 'amount_paid', 1
      ))
    ))$$,
    '22023',
    'purchased_at must be a finite timestamp',
    'infinite purchased_at is rejected'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'supplier', repeat('ا', 121),
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', 1, 'unit', 'kg', 'amount_paid', 1
      ))
    ))$$,
    '22023',
    'supplier must be at most 120 characters',
    'supplier length is rejected'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'invoice_no', repeat('a', 61),
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', 1, 'unit', 'kg', 'amount_paid', 1
      ))
    ))$$,
    '22023',
    'invoice_no must be at most 60 characters',
    'invoice length is rejected'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'note', repeat('ا', 501),
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', 1, 'unit', 'kg', 'amount_paid', 1
      ))
    ))$$,
    '22023',
    'note must be at most 500 characters',
    'note length is rejected'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'lines', '[]'::jsonb
    ))$$,
    '22023',
    'lines must be a jsonb array of 1 to 100 purchase lines',
    'a purchase needs at least one line'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'lines', (
        select jsonb_agg(jsonb_build_object(
          'item_id', '20000000-0000-4000-8000-000000000002',
          'quantity', 1, 'unit', 'kg', 'amount_paid', 1
        ))
        from generate_series(1, 101)
      )
    ))$$,
    '22023',
    'lines must be a jsonb array of 1 to 100 purchase lines',
    'a purchase rejects 101 lines'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', 0, 'unit', 'kg', 'amount_paid', 1
      ))
    ))$$,
    '22023',
    'quantity must be a finite number > 0',
    'purchase quantity must be greater than zero'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', 'NaN', 'unit', 'kg', 'amount_paid', 1
      ))
    ))$$,
    '22023',
    'quantity must be a finite number > 0',
    'purchase quantity rejects NaN'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', 1, 'unit', 'kg', 'amount_paid', -1
      ))
    ))$$,
    '22023',
    'amount_paid must be a finite number >= 0',
    'negative amount_paid is rejected'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', '1.1234567', 'unit', 'kg', 'amount_paid', '1.005'
      ))
    ))$$,
    '22023',
    'quantity must have at most 6 decimal places',
    'purchase quantity scale is rejected before the amount scale'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000002',
        'quantity', 1, 'unit', 'kg', 'amount_paid', '1.005'
      ))
    ))$$,
    '22023',
    'amount_paid must be in piasters',
    'amount_paid finer than a piaster is rejected'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T18:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-0000000000ff',
        'quantity', 1, 'unit', 'kg', 'amount_paid', 1
      ))
    ))$$,
    '22023',
    'unknown stock_item id: 20000000-0000-4000-8000-0000000000ff',
    'unknown purchase item is rejected'
  );

select
  throws_ok (
    $$select app.record_opening_stock(null, '[]'::jsonb, 'a1000000-0000-4000-8000-000000000008')$$,
    '22023',
    'occurred_at is required',
    'opening requires a time'
  );

select
  throws_ok (
    $$select app.record_opening_stock('infinity', '[]'::jsonb, 'a1000000-0000-4000-8000-000000000009')$$,
    '22023',
    'occurred_at must be a finite timestamp',
    'opening rejects an infinite time'
  );

select
  is (
    (
      select
        count(*)
      from
        app.purchases
    ),
    5::bigint,
    'validation failures save no purchase'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
    ),
    9::bigint,
    'validation failures save no movement'
  );

-- ============================================================================
-- Owner read, no direct writes
-- ============================================================================
select
  is (
    (
      select
        count(*)
      from
        app.purchases
      where
        supplier = 'مورد اختبار'
    ),
    1::bigint,
    'owner can read purchases'
  );

select
  is (
    (
      select
        count(*)
      from
        app.purchase_lines
    ),
    6::bigint,
    'owner can read purchase lines'
  );

-- ============================================================================
-- Idempotency and the reviewed conversion
-- ============================================================================
select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-10-21T19:00:00Z',
      'request_id',
      'b1000000-0000-4000-8000-000000000007',
      'supplier',
      'مورد إعادة',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-000000000005',
          'quantity',
          '3',
          'unit',
          'kg',
          'amount_paid',
          '15.00',
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
    app.record_purchase (
      jsonb_build_object(
        'purchased_at',
        '2026-10-21T19:00:00Z',
        'request_id',
        'b1000000-0000-4000-8000-000000000007',
        'supplier',
        'مورد إعادة',
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            '20000000-0000-4000-8000-000000000005',
            'quantity',
            '3',
            'unit',
            'kg',
            'amount_paid',
            '15.00',
            'expected_base_unit',
            'kg',
            'expected_factor',
            '1'
          )
        )
      )
    ),
    (
      select
        id
      from
        app.purchases
      where
        request_id = 'b1000000-0000-4000-8000-000000000007'
    ),
    'same purchase request id and payload returns the existing id'
  );

select
  is (
    (
      select
        count(*)
      from
        app.purchases
      where
        request_id = 'b1000000-0000-4000-8000-000000000007'
    ),
    1::bigint,
    'same purchase request id adds no second header'
  );

select
  is (
    (
      select
        count(*)
      from
        app.purchase_lines pl
        join app.purchases p on p.id = pl.purchase_id
      where
        p.request_id = 'b1000000-0000-4000-8000-000000000007'
    ),
    1::bigint,
    'same purchase request id adds no second line'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        item_id = '20000000-0000-4000-8000-000000000005'
    ),
    1::bigint,
    'same purchase request id adds no movement'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T19:00:00Z',
      'request_id', 'b1000000-0000-4000-8000-000000000007',
      'supplier', 'مورد تاني',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000005',
        'quantity', '3', 'unit', 'kg', 'amount_paid', '15.00',
        'expected_base_unit', 'kg', 'expected_factor', '1'
      ))
    ))$$,
    '22023',
    'request_id already used for a different purchase',
    'same purchase request id with a different payload is refused'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        item_id = '20000000-0000-4000-8000-000000000005'
    ),
    1::bigint,
    'refused purchase replay adds no movement'
  );

select
  app.record_opening_stock (
    '2026-10-21T19:30:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '20000000-0000-4000-8000-00000000000a',
        'quantity',
        '6',
        'unit',
        'kg',
        'unit_cost',
        '2',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'a1000000-0000-4000-8000-000000000010'
  );

select
  is (
    app.record_opening_stock (
      '2026-10-21T19:30:00Z',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-00000000000a',
          'quantity',
          '6',
          'unit',
          'kg',
          'unit_cost',
          '2',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      ),
      'a1000000-0000-4000-8000-000000000010'
    ),
    (
      select
        id
      from
        app.opening_stocks
      where
        request_id = 'a1000000-0000-4000-8000-000000000010'
    ),
    'same opening request id and payload returns the existing batch'
  );

select
  is (
    (
      select
        count(*)
      from
        app.opening_stocks
      where
        request_id = 'a1000000-0000-4000-8000-000000000010'
    ),
    1::bigint,
    'same opening request id adds no second header'
  );

select
  is (
    (
      select
        count(*)
      from
        app.opening_stock_lines ol
        join app.opening_stocks o on o.id = ol.opening_id
      where
        o.request_id = 'a1000000-0000-4000-8000-000000000010'
    ),
    1::bigint,
    'same opening request id adds no second line'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        item_id = '20000000-0000-4000-8000-00000000000a'
    ),
    1::bigint,
    'same opening request id adds no movement'
  );

select
  throws_ok (
    $$select app.record_opening_stock(
      '2026-10-21T19:30:00Z',
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-00000000000a',
        'quantity', '7', 'unit', 'kg', 'unit_cost', '2',
        'expected_base_unit', 'kg', 'expected_factor', '1'
      )),
      'a1000000-0000-4000-8000-000000000010'
    )$$,
    '22023',
    'request_id already used for a different opening',
    'same opening request id with a different payload is refused'
  );

select
  app.update_unit_conversion (
    '20000000-0000-4000-8000-000000000006',
    'كرتونة',
    12,
    24,
    'kg'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T20:00:00Z',
      'request_id', 'b1000000-0000-4000-8000-000000000008',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000006',
        'quantity', '2', 'unit', 'كرتونة', 'amount_paid', '40',
        'expected_base_unit', 'kg', 'expected_factor', '12'
      ))
    ))$$,
    '40001',
    'conversion changed',
    'stale purchase factor is refused after the conversion changes'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-10-21T20:10:00Z',
      'request_id',
      'b1000000-0000-4000-8000-000000000009',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '20000000-0000-4000-8000-000000000006',
          'quantity',
          '2',
          'unit',
          'كرتونة',
          'amount_paid',
          '48.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '24'
        )
      )
    )
  );

select
  is (
    (
      select
        pl.base_quantity
      from
        app.purchase_lines pl
        join app.purchases p on p.id = pl.purchase_id
      where
        p.request_id = 'b1000000-0000-4000-8000-000000000009'
    ),
    48::numeric,
    'a purchase with the current expected factor posts that base quantity'
  );

select
  app.update_unit_conversion (
    '20000000-0000-4000-8000-00000000000b',
    'كيس',
    4,
    8,
    'kg'
  );

select
  throws_ok (
    $$select app.record_opening_stock(
      '2026-10-21T20:20:00Z',
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-00000000000b',
        'quantity', '1', 'unit', 'كيس', 'unit_cost', '8',
        'expected_base_unit', 'kg', 'expected_factor', '4'
      )),
      'a1000000-0000-4000-8000-000000000011'
    )$$,
    '40001',
    'conversion changed',
    'stale opening factor is refused after the conversion changes'
  );

select
  app.record_opening_stock (
    '2026-10-21T20:30:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '20000000-0000-4000-8000-00000000000b',
        'quantity',
        '1',
        'unit',
        'كيس',
        'unit_cost',
        '8',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '8'
      )
    ),
    'a1000000-0000-4000-8000-000000000012'
  );

select
  is (
    (
      select
        on_hand_qty
      from
        app.item_balances
      where
        item_id = '20000000-0000-4000-8000-00000000000b'
    ),
    8::numeric,
    'an opening with the current expected factor posts that base quantity'
  );

update app.stock_items
set
  base_unit = 'kg'
where
  id = '20000000-0000-4000-8000-00000000000c';

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2026-10-21T20:40:00Z',
      'request_id', 'b1000000-0000-4000-8000-00000000000a',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-00000000000c',
        'quantity', '1', 'unit', 'piece', 'amount_paid', '5',
        'expected_base_unit', 'piece', 'expected_factor', '1'
      ))
    ))$$,
    '40001',
    'conversion changed',
    'stale purchase base unit is refused'
  );

update app.stock_items
set
  base_unit = 'kg'
where
  id = '20000000-0000-4000-8000-00000000000d';

select
  throws_ok (
    $$select app.record_opening_stock(
      '2026-10-21T20:50:00Z',
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-00000000000d',
        'quantity', '1', 'unit', 'piece', 'unit_cost', '5',
        'expected_base_unit', 'piece', 'expected_factor', '1'
      )),
      'a1000000-0000-4000-8000-000000000013'
    )$$,
    '40001',
    'conversion changed',
    'stale opening base unit is refused'
  );

select
  throws_ok (
    $$insert into app.purchases (purchased_at, total_paid, batch_id)
      values ('2026-10-21T18:00:00Z', 1, gen_random_uuid())$$,
    '42501',
    null::text,
    'owner cannot insert a purchase directly'
  );

select
  throws_ok (
    $$insert into app.opening_stocks (id, request_id, occurred_at)
      values (gen_random_uuid(), gen_random_uuid(), now())$$,
    '42501',
    null::text,
    'owner cannot insert an opening batch directly'
  );

select
  throws_ok (
    $$update app.purchases set note = 'x'$$,
    '42501',
    null::text,
    'owner cannot update a purchase directly'
  );

select
  throws_ok (
    $$delete from app.purchase_lines$$,
    '42501',
    null::text,
    'owner cannot delete purchase lines directly'
  );

-- ============================================================================
-- Non-owner and anon
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
    $$select app.record_purchase('{}'::jsonb)$$,
    '42501',
    'insufficient_privilege',
    'non-owner cannot record a purchase'
  );

select
  throws_ok (
    $$select app.record_opening_stock(now(), '[]'::jsonb, 'a1000000-0000-4000-8000-00000000000a')$$,
    '42501',
    'insufficient_privilege',
    'non-owner cannot record opening stock'
  );

select
  is_empty (
    $$select id from app.purchases$$,
    'non-owner cannot read purchases'
  );

select
  is_empty (
    $$select purchase_id from app.purchase_lines$$,
    'non-owner cannot read purchase lines'
  );

select
  is_empty (
    $$select id from app.opening_stocks$$,
    'non-owner cannot read opening batches'
  );

select
  is_empty (
    $$select opening_id from app.opening_stock_lines$$,
    'non-owner cannot read opening lines'
  );

select
  throws_ok (
    $$insert into app.purchases (purchased_at, total_paid, batch_id)
      values ('2026-10-21T18:00:00Z', 1, gen_random_uuid())$$,
    '42501',
    null::text,
    'non-owner cannot insert a purchase'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    $$select app.record_purchase('{}'::jsonb)$$,
    '42501',
    null::text,
    'anon cannot execute record_purchase'
  );

select
  throws_ok (
    $$select app.record_opening_stock(now(), '[]'::jsonb, 'a1000000-0000-4000-8000-00000000000b')$$,
    '42501',
    null::text,
    'anon cannot execute record_opening_stock'
  );

select
  throws_ok (
    $$select id from app.purchases$$,
    '42501',
    null::text,
    'anon cannot read purchases'
  );

select
  throws_ok (
    $$select purchase_id from app.purchase_lines$$,
    '42501',
    null::text,
    'anon cannot read purchase lines'
  );

reset role;

-- ============================================================================
-- Append-only even for the table owner, then service_role execute
-- ============================================================================
select
  throws_ok (
    $$update app.purchases set note = 'x'$$,
    '55000',
    'app.purchases is append-only; UPDATE is not allowed',
    'append-only trigger blocks purchase updates'
  );

select
  throws_ok (
    $$delete from app.purchases$$,
    '55000',
    'app.purchases is append-only; DELETE is not allowed',
    'append-only trigger blocks purchase deletes'
  );

select
  throws_ok (
    $$update app.purchase_lines set unit = 'x'$$,
    '55000',
    'app.purchase_lines is append-only; UPDATE is not allowed',
    'append-only trigger blocks purchase line updates'
  );

select
  throws_ok (
    $$delete from app.purchase_lines$$,
    '55000',
    'app.purchase_lines is append-only; DELETE is not allowed',
    'append-only trigger blocks purchase line deletes'
  );

select
  throws_ok (
    $$truncate app.purchase_lines$$,
    '55000',
    'app.purchase_lines is append-only; TRUNCATE is not allowed',
    'append-only trigger blocks purchase line truncate'
  );

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
    $$select app.record_opening_stock(
      '2026-10-21T17:00:00Z',
      jsonb_build_array(jsonb_build_object(
        'item_id', '20000000-0000-4000-8000-000000000009',
        'quantity', '1', 'unit', 'piece', 'unit_cost', '5',
        'expected_base_unit', 'piece', 'expected_factor', '1'
      )),
      'a1000000-0000-4000-8000-00000000000c'
    )$$,
    'service_role can record opening stock'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        item_id = '20000000-0000-4000-8000-000000000009'
        and movement_type = 'opening'
    ),
    1::bigint,
    'service_role opening was stored'
  );

reset role;

select
  *
from
  finish ();

rollback;
