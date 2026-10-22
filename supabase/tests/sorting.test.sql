begin;

select
  no_plan ();

-- Clean up any existing test rows in the transaction.
alter table app.sort_batch_lines disable trigger trg_sort_batch_lines_no_update_delete;

delete from app.sort_batch_lines;

alter table app.sort_batch_lines enable trigger trg_sort_batch_lines_no_update_delete;

alter table app.sort_batches disable trigger trg_sort_batches_no_update_delete;

delete from app.sort_batches;

alter table app.sort_batches enable trigger trg_sort_batches_no_update_delete;

alter table app.purchase_lines disable trigger trg_purchase_lines_no_update_delete;

delete from app.purchase_lines;

alter table app.purchase_lines enable trigger trg_purchase_lines_no_update_delete;

alter table app.purchases disable trigger trg_purchases_no_update_delete;

delete from app.purchases;

alter table app.purchases enable trigger trg_purchases_no_update_delete;

alter table app.opening_stock_lines disable trigger trg_opening_stock_lines_no_update_delete;

delete from app.opening_stock_lines;

alter table app.opening_stock_lines enable trigger trg_opening_stock_lines_no_update_delete;

alter table app.opening_stocks disable trigger trg_opening_stocks_no_update_delete;

delete from app.opening_stocks;

alter table app.opening_stocks enable trigger trg_opening_stocks_no_update_delete;

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
  has_table ('app', 'sort_batches', 'app.sort_batches exists');

select
  has_table (
    'app',
    'sort_batch_lines',
    'app.sort_batch_lines exists'
  );

select
  has_view ('app', 'sort_history', 'app.sort_history exists');

select
  has_function (
    'app',
    'record_sort',
    array['jsonb'],
    'app.record_sort(jsonb) exists'
  );

select
  has_index (
    'app',
    'sort_batches',
    'sort_batches_request_id_key',
    'sort request_id is unique'
  );

select
  has_index (
    'app',
    'sort_batches',
    'sort_batches_created_at_idx',
    'sorts are indexed by created_at and id'
  );

select
  has_index (
    'app',
    'sort_batches',
    'sort_batches_occurred_at_idx',
    'sorts are indexed by occurred_at'
  );

select
  has_index (
    'app',
    'sort_batch_lines',
    'sort_batch_lines_size_key',
    'a size appears once per sort'
  );

select
  has_trigger (
    'app',
    'sort_batches',
    'trg_sort_batches_no_update_delete',
    'sorts reject update and delete'
  );

select
  has_trigger (
    'app',
    'sort_batches',
    'trg_sort_batches_no_truncate',
    'sorts reject truncate'
  );

select
  has_trigger (
    'app',
    'sort_batch_lines',
    'trg_sort_batch_lines_no_update_delete',
    'sort lines reject update and delete'
  );

select
  has_trigger (
    'app',
    'sort_batch_lines',
    'trg_sort_batch_lines_no_truncate',
    'sort lines reject truncate'
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
        and p.proname = 'record_sort'
    ),
    'record_sort is security definer with an empty search_path'
  );

-- The catalog is not named in the function body. Replay reads sort_batches
-- after the phone check and before post_sort. post_sort is the only catalog
-- lookup, and it runs before the document insert.
select
  ok (
    (
      select
        position('app.assert_ledger_write_allowed' in def) > 0
        and position('app.assert_ledger_write_allowed' in def) < position('app.assert_no_phone_text' in def)
        and position('app.assert_no_phone_text' in def) < position('app.sort_batches' in def)
        and position('app.sort_batches' in def) < position('app.post_sort' in def)
        and position('app.post_sort' in def) < position('insert into' in lower(def))
        and position('for update' in lower(def)) = 0
        and position('app.stock_items' in def) = 0
      from
        (
          select
            pg_catalog.pg_get_functiondef ('app.record_sort(jsonb)'::regprocedure) as def
        ) s
    ),
    'record_sort locks, checks the note, replays, then posts, and does not read the catalog itself'
  );

select
  ok (
    has_function_privilege(
      'authenticated',
      'app.record_sort(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app.record_sort(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app.record_sort(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.record_sort(jsonb)'::regprocedure,
      'EXECUTE'
    ),
    'record_sort execute is granted to authenticated and service_role only'
  );

select
  ok (
    not has_function_privilege(
      'anon',
      'app.prevent_sort_mutation()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app.prevent_sort_mutation()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app.prevent_sort_mutation()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.prevent_sort_mutation()'::regprocedure,
      'EXECUTE'
    ),
    'the append-only trigger function is not executable via the API'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'sort_batches'
        and grantee = 'authenticated'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select sorts'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'sort_batch_lines'
        and grantee = 'authenticated'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select sort lines'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'sort_batches'
        and grantee = 'service_role'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'service_role can only select sorts'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'sort_history'
        and grantee = 'authenticated'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select sort history'
  );

select
  is_empty (
    $$select privilege_type
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name in ('sort_batches', 'sort_batch_lines', 'sort_history')
        and grantee in ('anon', 'PUBLIC')$$,
    'anon and public have no privileges on sort tables or the history view'
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
        and tablename = 'sort_batches'
        and policyname = 'sort_batches_select_owner'
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
        and tablename = 'sort_batch_lines'
        and policyname = 'sort_batch_lines_select_owner'
        and cmd = 'SELECT'
        and roles = '{authenticated}'::name[]
    ),
    'owner select policies exist on both sort tables'
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
        and tablename in ('sort_batches', 'sort_batch_lines')
        and cmd <> 'SELECT'
    ),
    0::bigint,
    'sort tables have no insert, update, or delete policies'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_class c
        join pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname = 'app'
        and c.relname in ('sort_batches', 'sort_batch_lines')
        and c.relrowsecurity
    ),
    2::bigint,
    'RLS is enabled on both sort tables'
  );

select
  ok (
    exists (
      select
        1
      from
        pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral unnest(coalesce(c.reloptions, array[]::text[])) as opt
      where
        n.nspname = 'app'
        and c.relname = 'sort_history'
        and (
          opt = 'security_invoker=true'
          or opt = 'security_invoker=on'
        )
    ),
    'sort_history is security invoker'
  );

-- ============================================================================
-- Synthetic catalog. Not restaurant data.
-- ============================================================================
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'c1800000-0000-4000-8000-000000000001',
    'بوري مخلوط اختبار',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c1800000-0000-4000-8000-000000000004',
    'دنيس مخلوط اختبار',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'c1800000-0000-4000-8000-000000000006',
    'زيت فرز اختبار',
    'ingredient',
    'kg',
    'weekly'
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
    'c1800000-0000-4000-8000-000000000002',
    'بوري كبير اختبار',
    'fish_size',
    'kg',
    'daily',
    'c1800000-0000-4000-8000-000000000001'
  ),
  (
    'c1800000-0000-4000-8000-000000000003',
    'بوري وسط اختبار',
    'fish_size',
    'kg',
    'daily',
    'c1800000-0000-4000-8000-000000000001'
  ),
  (
    'c1800000-0000-4000-8000-000000000005',
    'دنيس وسط اختبار',
    'fish_size',
    'kg',
    'daily',
    'c1800000-0000-4000-8000-000000000004'
  );

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
  app.record_opening_stock (
    '2026-10-22T08:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c1800000-0000-4000-8000-000000000001',
        'quantity',
        '100',
        'unit',
        'kg',
        'unit_cost',
        '50',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      ),
      jsonb_build_object(
        'item_id',
        'c1800000-0000-4000-8000-000000000002',
        'quantity',
        '10',
        'unit',
        'kg',
        'unit_cost',
        '40',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'e1800000-0000-4000-8000-000000000001'
  );

-- ============================================================================
-- Validation. None of these calls post a sort.
-- ============================================================================
select
  throws_ok (
    $$select app.record_sort('[]'::jsonb)$$,
    '22023',
    'p_sort must be a jsonb object',
    'a sort payload must be an object'
  );

select
  throws_ok (
    $$select app.record_sort('{}'::jsonb)$$,
    '22023',
    'request_id is required',
    'a missing request_id is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'not-a-uuid',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1'
      ))
    ))$$,
    '22023',
    'request_id is required',
    'a request_id that is not a uuid is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000010',
      'mixed_item_id', 'not-a-uuid',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1'
      ))
    ))$$,
    '22023',
    'mixed_item_id must be a uuid',
    'a mixed item id that is not a uuid is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000011',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', 'infinity',
      'qty_taken', '1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1'
      ))
    ))$$,
    '22023',
    'occurred_at must be a finite timestamp',
    'an infinite timestamp is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000012',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1.1234567',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1'
      ))
    ))$$,
    '22023',
    'qty_taken must have at most 6 decimal places',
    'a taken quantity with more than 6 decimal places is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000013',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1.1234567'
      ))
    ))$$,
    '22023',
    'quantity must have at most 6 decimal places',
    'a size quantity with more than 6 decimal places is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000014',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'lines', '[]'::jsonb
    ))$$,
    '22023',
    'lines must be a jsonb array of 1 to 20 size lines',
    'a sort with no size lines is refused'
  );

select
  throws_ok (
    $sql$
    select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000015',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'lines', (
        select jsonb_agg(jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000002',
          'quantity', '0.01'
        ))
        from pg_catalog.generate_series(1, 21)
      )
    ))
    $sql$,
    '22023',
    'lines must be a jsonb array of 1 to 20 size lines',
    'more than 20 size lines is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000016',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '2',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000002',
          'quantity', '1'
        ),
        jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000002',
          'quantity', '1'
        )
      )
    ))$$,
    '22023',
    'duplicate size item',
    'the same size twice in one sort is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000017',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '0'
      ))
    ))$$,
    '22023',
    'quantity must be a finite number > 0',
    'a zero size quantity is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000018',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'note', '01001234567',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1'
      ))
    ))$$,
    '22023',
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'phone digits in the note are refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000019',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '101',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1'
      ))
    ))$$,
    '22023',
    'not enough stock to sort',
    'taking more than the mixed item has is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-00000000001a',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '100',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000002',
          'quantity', '60'
        ),
        jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000003',
          'quantity', '50'
        )
      )
    ))$$,
    '22023',
    'sum of sizes exceeds quantity taken',
    'sizes that add up to more than the taken quantity are refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-00000000001b',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000005',
        'quantity', '1'
      ))
    ))$$,
    '22023',
    'size item is not a child of the mixed item',
    'a size from another mixed item is refused'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-00000000001c',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000006',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1'
      ))
    ))$$,
    '22023',
    'mixed item must be a fish_mixed item in kg',
    'an ingredient cannot be sorted as mixed fish'
  );

select
  is (
    (
      select
        count(*)
      from
        app.sort_batches
    ),
    0::bigint,
    'refused sorts save no header'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type in ('sort_out', 'sort_in', 'sort_loss')
    ),
    0::bigint,
    'refused sorts post no movement'
  );

-- ============================================================================
-- 100 kg @ 50 into 60 + 38. The ledger posts sort_out of the 98 kg that
-- reach sizes and sort_loss of the remaining 2 kg. Together they remove 100.
-- ============================================================================
select
  lives_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000001',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '100.000000',
      'note', '  فاقد اختبار  ',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000002',
          'quantity', '60.000000'
        ),
        jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000003',
          'quantity', '38'
        )
      )
    ))$$,
    'a sort of 100 kg into 60 and 38 is saved'
  );

select
  is (
    (
      select
        id
      from
        app.sort_batches
      where
        request_id = 'd1800000-0000-4000-8000-000000000001'
    ),
    (
      select
        batch_id
      from
        app.stock_movements
      where
        item_id = 'c1800000-0000-4000-8000-000000000001'
        and movement_type = 'sort_out'
    ),
    'the sort document id is the ledger batch id'
  );

select
  results_eq (
    $$select mixed_item_id, occurred_at, qty_taken, note, created_by
      from app.sort_batches
      where request_id = 'd1800000-0000-4000-8000-000000000001'$$,
    $$values (
      'c1800000-0000-4000-8000-000000000001'::uuid,
      '2026-10-22T09:00:00Z'::timestamptz,
      100::numeric(20, 6),
      'فاقد اختبار'::text,
      'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f'::uuid
    )$$,
    'the header stores the normalized taken quantity, the trimmed note, and the owner'
  );

select
  results_eq (
    $$select line_no, size_item_id, quantity
      from app.sort_batch_lines
      where batch_id = (
        select id from app.sort_batches
        where request_id = 'd1800000-0000-4000-8000-000000000001'
      )
      order by line_no$$,
    $$values
      (1, 'c1800000-0000-4000-8000-000000000002'::uuid, 60::numeric(20, 6)),
      (2, 'c1800000-0000-4000-8000-000000000003'::uuid, 38::numeric(20, 6))$$,
    'size lines are stored in payload order'
  );

select
  results_eq (
    $$select movement_type, quantity, unit_cost, total_cost
      from app.stock_movements
      where item_id = 'c1800000-0000-4000-8000-000000000001'
        and movement_type in ('sort_out', 'sort_loss')
      order by id$$,
    $$values
      ('sort_out'::app.movement_type, -98::numeric(20, 6), 50::numeric(20, 6), -4900::numeric(14, 2)),
      ('sort_loss'::app.movement_type, -2::numeric(20, 6), 50::numeric(20, 6), -100::numeric(14, 2))$$,
    'sorting posts sort_out of the 98 kg that reach sizes and sort_loss of 2 kg'
  );

select
  is (
    (
      select
        - sum(quantity)
      from
        app.stock_movements
      where
        item_id = 'c1800000-0000-4000-8000-000000000001'
        and movement_type in ('sort_out', 'sort_loss')
    ),
    100::numeric(20, 6),
    'sort_out plus sort_loss removes the 100 kg that were taken'
  );

select
  results_eq (
    $$select item_id, movement_type, quantity, unit_cost, total_cost
      from app.stock_movements
      where movement_type = 'sort_in'
      order by id$$,
    $$values
      (
        'c1800000-0000-4000-8000-000000000002'::uuid,
        'sort_in'::app.movement_type,
        60::numeric(20, 6),
        50::numeric(20, 6),
        3000::numeric(14, 2)
      ),
      (
        'c1800000-0000-4000-8000-000000000003'::uuid,
        'sort_in'::app.movement_type,
        38::numeric(20, 6),
        50::numeric(20, 6),
        1900::numeric(14, 2)
      )$$,
    'each size receives its kilograms at the mixed average of 50'
  );

select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id in (
        'c1800000-0000-4000-8000-000000000001',
        'c1800000-0000-4000-8000-000000000002',
        'c1800000-0000-4000-8000-000000000003'
      )
      order by item_id$$,
    $$values
      (
        'c1800000-0000-4000-8000-000000000001'::uuid,
        0::numeric(20, 6),
        0::numeric(14, 2),
        50::numeric(20, 6)
      ),
      (
        'c1800000-0000-4000-8000-000000000002'::uuid,
        70::numeric(20, 6),
        3400::numeric(14, 2),
        48.571429::numeric(20, 6)
      ),
      (
        'c1800000-0000-4000-8000-000000000003'::uuid,
        38::numeric(20, 6),
        1900::numeric(14, 2),
        50::numeric(20, 6)
      )$$,
    'the mixed item is emptied and a size that already had stock gets the weighted average'
  );

select
  results_eq (
    $$select mixed_item_name, occurred_at, qty_taken, sizes_qty, loss_qty, loss_value, cost_per_kg, note
      from app.sort_history
      where mixed_item_id = 'c1800000-0000-4000-8000-000000000001'$$,
    $$values (
      'بوري مخلوط اختبار'::text,
      '2026-10-22T09:00:00Z'::timestamptz,
      100::numeric(20, 6),
      98::numeric(20, 6),
      2::numeric(20, 6),
      100.00::numeric(14, 2),
      50::numeric(20, 6),
      'فاقد اختبار'::text
    )$$,
    'history reads the taken quantity, the sizes, the loss, and the cost from the batch movements'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type in ('sort_out', 'sort_in', 'sort_loss')
    ),
    4::bigint,
    'the successful sort posted four movements'
  );

select
  is (
    app.record_sort (
      jsonb_build_object(
        'request_id',
        'd1800000-0000-4000-8000-000000000001',
        'mixed_item_id',
        'c1800000-0000-4000-8000-000000000001',
        'occurred_at',
        '2026-10-22T09:00:00Z',
        'qty_taken',
        '100',
        'note',
        'فاقد اختبار',
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            'c1800000-0000-4000-8000-000000000002',
            'quantity',
            '60'
          ),
          jsonb_build_object(
            'item_id',
            'c1800000-0000-4000-8000-000000000003',
            'quantity',
            '38.000000'
          )
        )
      )
    ),
    (
      select
        id
      from
        app.sort_batches
      where
        request_id = 'd1800000-0000-4000-8000-000000000001'
    ),
    'the same request id and the same normalized payload returns the saved id'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type in ('sort_out', 'sort_in', 'sort_loss')
    ),
    4::bigint,
    'a replay posts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.sort_batches
    ),
    1::bigint,
    'a replay does not insert a second header'
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000001',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '100',
      'note', 'فاقد اختبار',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000002',
          'quantity', '60'
        ),
        jsonb_build_object(
          'item_id', 'c1800000-0000-4000-8000-000000000003',
          'quantity', '37'
        )
      )
    ))$$,
    '22023',
    'request_id already used for a different sort',
    'the same request id with a different payload is refused'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2026-10-22T11:00:00Z',
      'request_id',
      'd1800000-0000-4000-8000-000000000030',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'c1800000-0000-4000-8000-000000000001',
          'quantity',
          '5',
          'unit',
          'kg',
          'amount_paid',
          '250',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  throws_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000031',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000001',
      'occurred_at', '2026-10-22T10:00:00Z',
      'qty_taken', '1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000002',
        'quantity', '1'
      ))
    ))$$,
    'P0001',
    'back-dated movement not supported yet',
    'a sort earlier than the last movement is refused'
  );

select
  throws_ok (
    $$insert into app.sort_batches (
      id, request_id, mixed_item_id, occurred_at, qty_taken
    ) values (
      gen_random_uuid(),
      gen_random_uuid(),
      'c1800000-0000-4000-8000-000000000001',
      '2026-10-22T12:00:00Z',
      1
    )$$,
    '42501',
    null::text,
    'the owner cannot insert a sort directly'
  );

-- ============================================================================
-- RLS
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
    $$select app.record_sort('{}'::jsonb)$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot record a sort'
  );

select
  is_empty (
    $$select id from app.sort_batches$$,
    'a non-owner cannot read sorts'
  );

select
  is_empty (
    $$select batch_id from app.sort_batch_lines$$,
    'a non-owner cannot read sort lines'
  );

select
  is_empty (
    $$select id from app.sort_history$$,
    'a non-owner cannot read sort history'
  );

select
  throws_ok (
    $$insert into app.sort_batches (
      id, request_id, mixed_item_id, occurred_at, qty_taken
    ) values (
      gen_random_uuid(),
      gen_random_uuid(),
      'c1800000-0000-4000-8000-000000000001',
      '2026-10-22T12:00:00Z',
      1
    )$$,
    '42501',
    null::text,
    'a non-owner cannot insert a sort'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    $$select app.record_sort('{}'::jsonb)$$,
    '42501',
    null::text,
    'anon cannot execute record_sort'
  );

select
  throws_ok (
    $$select id from app.sort_batches$$,
    '42501',
    null::text,
    'anon cannot read sorts'
  );

select
  throws_ok (
    $$select batch_id from app.sort_batch_lines$$,
    '42501',
    null::text,
    'anon cannot read sort lines'
  );

select
  throws_ok (
    $$select id from app.sort_history$$,
    '42501',
    null::text,
    'anon cannot read sort history'
  );

reset role;

-- ============================================================================
-- Append-only even for the table owner, then service_role
-- ============================================================================
select
  throws_ok (
    $$update app.sort_batches set note = 'x'$$,
    '55000',
    'app.sort_batches is append-only; UPDATE is not allowed',
    'append-only trigger blocks sort updates'
  );

select
  throws_ok (
    $$delete from app.sort_batches$$,
    '55000',
    'app.sort_batches is append-only; DELETE is not allowed',
    'append-only trigger blocks sort deletes'
  );

select
  throws_ok (
    $$update app.sort_batch_lines set quantity = 1$$,
    '55000',
    'app.sort_batch_lines is append-only; UPDATE is not allowed',
    'append-only trigger blocks sort line updates'
  );

select
  throws_ok (
    $$delete from app.sort_batch_lines$$,
    '55000',
    'app.sort_batch_lines is append-only; DELETE is not allowed',
    'append-only trigger blocks sort line deletes'
  );

select
  throws_ok (
    $$truncate app.sort_batch_lines$$,
    '55000',
    'app.sort_batch_lines is append-only; TRUNCATE is not allowed',
    'append-only trigger blocks sort line truncate'
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
      '2026-10-22T08:00:00Z',
      jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000004',
        'quantity', '10', 'unit', 'kg', 'unit_cost', '20',
        'expected_base_unit', 'kg', 'expected_factor', '1'
      )),
      'e1800000-0000-4000-8000-000000000002'
    )$$,
    'service_role can record opening stock for another mixed item'
  );

select
  lives_ok (
    $$select app.record_sort(jsonb_build_object(
      'request_id', 'd1800000-0000-4000-8000-000000000040',
      'mixed_item_id', 'c1800000-0000-4000-8000-000000000004',
      'occurred_at', '2026-10-22T09:00:00Z',
      'qty_taken', '10',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1800000-0000-4000-8000-000000000005',
        'quantity', '10'
      ))
    ))$$,
    'service_role can record a sort with no loss'
  );

reset role;

select
  is_empty (
    $$select id
      from app.stock_movements
      where item_id = 'c1800000-0000-4000-8000-000000000004'
        and movement_type = 'sort_loss'$$,
    'a sort whose sizes equal the taken quantity posts no sort_loss'
  );

select
  results_eq (
    $$select movement_type, quantity, unit_cost, total_cost
      from app.stock_movements
      where item_id = 'c1800000-0000-4000-8000-000000000004'
        and movement_type = 'sort_out'$$,
    $$values (
      'sort_out'::app.movement_type,
      -10::numeric(20, 6),
      20::numeric(20, 6),
      -200::numeric(14, 2)
    )$$,
    'a complete sort posts sort_out of the whole taken quantity'
  );

select
  results_eq (
    $$select qty_taken, sizes_qty, loss_qty, loss_value, cost_per_kg
      from app.sort_history
      where mixed_item_id = 'c1800000-0000-4000-8000-000000000004'$$,
    $$values (
      10::numeric(20, 6),
      10::numeric(20, 6),
      0::numeric(20, 6),
      0.00::numeric(14, 2),
      20::numeric(20, 6)
    )$$,
    'history reports zero loss when the sizes use every taken kilogram'
  );

select
  *
from
  finish ();

rollback;
