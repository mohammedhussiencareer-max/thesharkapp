begin;

select
  plan (110);

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
-- Catalog objects and grants
-- ============================================================================
-- 1
select
  has_index (
    'app',
    'stock_items',
    'stock_items_parent_item_id_idx',
    'stock_items.parent_item_id has an index'
  );

-- 2
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_index i
        join pg_catalog.pg_class idx on idx.oid = i.indexrelid
        join pg_catalog.pg_class tbl on tbl.oid = i.indrelid
        join pg_catalog.pg_namespace nsp on nsp.oid = tbl.relnamespace
      where
        nsp.nspname = 'app'
        and tbl.relname = 'stock_items'
        and idx.relname = 'stock_items_parent_item_id_idx'
        and i.indpred is not null
    ),
    'stock_items_parent_item_id_idx is a partial index'
  );

-- 3
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename = 'stock_items'
        and policyname = 'stock_items_insert_owner'
        and cmd = 'INSERT'
        and roles = '{authenticated}'::name[]
    ),
    'stock_items insert policy exists'
  );

-- 4
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename = 'stock_items'
        and policyname = 'stock_items_update_owner'
        and cmd = 'UPDATE'
        and roles = '{authenticated}'::name[]
    ),
    'stock_items update policy exists'
  );

-- 5
select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename = 'stock_items'
        and cmd = 'DELETE'
    ),
    0::bigint,
    'stock_items has no DELETE policy'
  );

-- 6
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename = 'item_unit_conversions'
        and policyname = 'item_unit_conversions_insert_owner'
        and cmd = 'INSERT'
        and roles = '{authenticated}'::name[]
    ),
    'item_unit_conversions insert policy exists'
  );

-- 7
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename = 'item_unit_conversions'
        and policyname = 'item_unit_conversions_update_owner'
        and cmd = 'UPDATE'
        and roles = '{authenticated}'::name[]
    ),
    'item_unit_conversions update policy exists'
  );

-- 8
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_policies
      where
        schemaname = 'app'
        and tablename = 'item_unit_conversions'
        and policyname = 'item_unit_conversions_delete_owner'
        and cmd = 'DELETE'
        and roles = '{authenticated}'::name[]
    ),
    'item_unit_conversions delete policy exists'
  );

-- 9
select
  has_trigger (
    'app',
    'item_unit_conversions',
    'trg_item_unit_conversions_reject_base_unit',
    'conversion base-unit trigger exists'
  );

-- 10
select
  ok (
    not exists (
      select
        1
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'trg_item_unit_conversions_reject_base_unit'
        and pg_catalog.pg_get_functiondef (p.oid) like '%pg_advisory_xact_lock%'
    ),
    'conversion base-unit check does not take the posting advisory lock'
  );

-- 10b: conversion writes take the posting advisory lock per statement, before row locks
select
  is (
    (
      select
        t.tgtype::int
      from
        pg_catalog.pg_trigger t
      where
        t.tgrelid = 'app.item_unit_conversions'::regclass
        and t.tgname = 'trg_item_unit_conversions_lock'
    ),
    30,
    'trg_item_unit_conversions_lock is BEFORE INSERT OR UPDATE OR DELETE FOR EACH STATEMENT'
  );

-- 10c: item deletes take the posting advisory lock per statement, before row locks
select
  is (
    (
      select
        t.tgtype::int
      from
        pg_catalog.pg_trigger t
      where
        t.tgrelid = 'app.stock_items'::regclass
        and t.tgname = 'trg_stock_items_delete_lock'
    ),
    10,
    'trg_stock_items_delete_lock is BEFORE DELETE FOR EACH STATEMENT'
  );

-- 11
select
  has_trigger (
    'app',
    'stock_items',
    'trg_stock_items_reject_converted_base_unit',
    'stock_items converted base-unit trigger exists'
  );

-- 12
select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'stock_items'
        and grantee = 'authenticated'
        and privilege_type in ('INSERT', 'SELECT', 'UPDATE', 'DELETE')
      order by 1$$,
    $$values ('INSERT'::text), ('SELECT'::text)$$,
    'authenticated table privileges on stock_items are INSERT and SELECT'
  );

-- 13
select
  is (
    (
      select
        count(*)
      from
        information_schema.column_privileges
      where
        table_schema = 'app'
        and table_name = 'stock_items'
        and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
        and column_name in (
          'name',
          'kind',
          'base_unit',
          'count_frequency',
          'loss_pct',
          'parent_item_id',
          'active'
        )
    ),
    7::bigint,
    'authenticated can update the seven editable stock_items columns'
  );

-- 14
select
  is (
    (
      select
        count(*)
      from
        information_schema.column_privileges
      where
        table_schema = 'app'
        and table_name = 'stock_items'
        and grantee = 'authenticated'
        and privilege_type = 'UPDATE'
        and column_name in ('id', 'created_at')
    ),
    0::bigint,
    'authenticated cannot update stock_items.id or created_at'
  );

-- 15
select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'item_unit_conversions'
        and grantee = 'authenticated'
        and privilege_type in ('INSERT', 'SELECT', 'UPDATE', 'DELETE')
      order by 1$$,
    $$values ('DELETE'::text), ('INSERT'::text), ('SELECT'::text), ('UPDATE'::text)$$,
    'authenticated can select, insert, update, and delete conversions'
  );

-- 70
select
  is (
    (
      select
        p.prosecdef
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'add_unit_conversion'
    ),
    false,
    'add_unit_conversion is security invoker'
  );

-- 71
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'add_unit_conversion'
        and 'search_path=""' = any (p.proconfig)
    ),
    'add_unit_conversion has an empty search_path'
  );

-- 72
select
  ok (
    has_function_privilege(
      'authenticated',
      'app.add_unit_conversion(uuid,text,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'authenticated can execute add_unit_conversion'
  );

-- 73
select
  ok (
    not has_function_privilege(
      'anon',
      'app.add_unit_conversion(uuid,text,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'anon has no execute on add_unit_conversion'
  );

-- 74
select
  ok (
    not has_function_privilege(
      'public',
      'app.add_unit_conversion(uuid,text,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'public has no execute on add_unit_conversion'
  );

-- 82
select
  is (
    (
      select
        p.prosecdef
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'update_unit_conversion'
    ),
    false,
    'update_unit_conversion is security invoker'
  );

-- 83
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'update_unit_conversion'
        and 'search_path=""' = any (p.proconfig)
    ),
    'update_unit_conversion has an empty search_path'
  );

-- 84
select
  is (
    (
      select
        p.prosecdef
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'delete_unit_conversion'
    ),
    false,
    'delete_unit_conversion is security invoker'
  );

-- 85
select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'delete_unit_conversion'
        and 'search_path=""' = any (p.proconfig)
    ),
    'delete_unit_conversion has an empty search_path'
  );

-- 86
select
  ok (
    has_function_privilege(
      'authenticated',
      'app.update_unit_conversion(uuid,text,numeric,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'authenticated can execute update_unit_conversion'
  );

-- 87
select
  ok (
    has_function_privilege(
      'authenticated',
      'app.delete_unit_conversion(uuid,text,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'authenticated can execute delete_unit_conversion'
  );

-- 88
select
  ok (
    not has_function_privilege(
      'anon',
      'app.update_unit_conversion(uuid,text,numeric,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'anon has no execute on update_unit_conversion'
  );

-- 89
select
  ok (
    not has_function_privilege(
      'anon',
      'app.delete_unit_conversion(uuid,text,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'anon has no execute on delete_unit_conversion'
  );

-- 90
select
  ok (
    not has_function_privilege(
      'public',
      'app.update_unit_conversion(uuid,text,numeric,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'public has no execute on update_unit_conversion'
  );

-- 91
select
  ok (
    not has_function_privilege(
      'public',
      'app.delete_unit_conversion(uuid,text,numeric,text)'::regprocedure,
      'EXECUTE'
    ),
    'public has no execute on delete_unit_conversion'
  );

-- ============================================================================
-- Owner writes
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

-- 16
select
  lives_ok (
    $$insert into app.stock_items (id, name, kind, base_unit, count_frequency)
      values (
        '31000000-0000-4000-8000-000000000001',
        'بوري مخلوط',
        'fish_mixed',
        'kg',
        'daily'
      )$$,
    'owner can insert a fish_mixed item'
  );

-- 17
select
  lives_ok (
    $$update app.stock_items
      set name = 'بوري مخلوط معدل',
          loss_pct = 0.125,
          count_frequency = 'weekly',
          active = false
      where id = '31000000-0000-4000-8000-000000000001'$$,
    'owner can update editable stock_items columns'
  );

-- 18
select
  results_eq (
    $$select name, kind, base_unit, count_frequency, loss_pct::numeric, parent_item_id, active
      from app.stock_items
      where id = '31000000-0000-4000-8000-000000000001'$$,
    $$values (
      'بوري مخلوط معدل'::text,
      'fish_mixed'::text,
      'kg'::text,
      'weekly'::text,
      0.125::numeric,
      null::uuid,
      false
    )$$,
    'owner update stores the loss fraction and the other editable columns'
  );

-- 19
select
  lives_ok (
    $$insert into app.stock_items (id, name, kind, base_unit, count_frequency, parent_item_id)
      values (
        '31000000-0000-4000-8000-000000000002',
        'بوري كبير',
        'fish_size',
        'kg',
        'daily',
        '31000000-0000-4000-8000-000000000001'
      )$$,
    'owner can insert a fish_size under a fish_mixed parent'
  );

-- 20
select
  results_eq (
    $$select kind, base_unit, parent_item_id
      from app.stock_items
      where id = '31000000-0000-4000-8000-000000000002'$$,
    $$values (
      'fish_size'::text,
      'kg'::text,
      '31000000-0000-4000-8000-000000000001'::uuid
    )$$,
    'owner fish_size row keeps its fish_mixed parent'
  );

-- 21
select
  lives_ok (
    $$insert into app.stock_items (id, name, kind, base_unit, count_frequency)
      values
        ('31000000-0000-4000-8000-000000000003', 'جمبري', 'seafood', 'kg', 'daily'),
        ('31000000-0000-4000-8000-000000000004', 'زيت', 'ingredient', 'kg', 'weekly'),
        ('31000000-0000-4000-8000-000000000005', 'صنف للجرد', 'ingredient', 'kg', 'weekly')$$,
    'owner can insert seafood and ingredient items'
  );

-- 22
select
  lives_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'piece', 2)$$,
    'owner can insert a conversion'
  );

-- 23
select
  lives_ok (
    $$update app.item_unit_conversions
      set factor_to_base = 4
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    'owner can update a conversion factor'
  );

-- 24
select
  results_eq (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    $$values (4::numeric)$$,
    'owner conversion update stored the new factor'
  );

-- 25
select
  lives_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'كرتونة', 10)$$,
    'owner can insert a second conversion'
  );

-- 26
select
  lives_ok (
    $$delete from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'كرتونة'$$,
    'owner can delete a conversion'
  );

-- 27
select
  is_empty (
    $$select 1
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'كرتونة'$$,
    'owner delete removed the conversion row'
  );

-- 75
select
  lives_ok (
    $$select app.add_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      25,
      'kg'
    )$$,
    'owner can add a conversion through add_unit_conversion'
  );

-- 76
select
  results_eq (
    $$select unit, factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'$$,
    $$values ('bag'::text, 25::numeric)$$,
    'add_unit_conversion stored bag = 25 against kg'
  );

-- 77
select
  throws_ok (
    $$select app.add_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'sack',
      10,
      'liter'
    )$$,
    '40001'::char(5),
    'base unit changed',
    'add_unit_conversion rejects a stale base unit'
  );

-- 78
select
  is (
    (
      select
        count(*)
      from
        app.item_unit_conversions
      where
        item_id = '31000000-0000-4000-8000-000000000003'
    ),
    1::bigint,
    'stale base unit inserted nothing'
  );

-- 79
select
  throws_ok (
    $$select app.add_unit_conversion(
      '31000000-0000-4000-8000-000000000099',
      'bag',
      1,
      'kg'
    )$$,
    '40001'::char(5),
    'base unit changed',
    'add_unit_conversion rejects a missing item'
  );

-- 92
select
  lives_ok (
    $$select app.update_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      25,
      30,
      'kg'
    )$$,
    'owner can update a conversion through update_unit_conversion'
  );

-- 93
select
  results_eq (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    $$values (30::numeric)$$,
    'update_unit_conversion stored bag = 30'
  );

-- 94
select
  throws_ok (
    $$select app.update_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      30,
      40,
      'liter'
    )$$,
    '40001'::char(5),
    'base unit changed',
    'update_unit_conversion rejects a stale base unit'
  );

-- 95
select
  results_eq (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    $$values (30::numeric)$$,
    'stale base unit left the updated conversion unchanged'
  );

-- 96
select
  throws_ok (
    $$select app.update_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      99,
      40,
      'kg'
    )$$,
    '40001'::char(5),
    'conversion changed',
    'update_unit_conversion rejects a stale factor'
  );

-- 97
select
  results_eq (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    $$values (30::numeric)$$,
    'stale factor left the updated conversion unchanged'
  );

-- 98
select
  throws_ok (
    $$select app.delete_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      30,
      'liter'
    )$$,
    '40001'::char(5),
    'base unit changed',
    'delete_unit_conversion rejects a stale base unit'
  );

-- 99
select
  is (
    (
      select
        count(*)
      from
        app.item_unit_conversions
      where
        item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'
    ),
    1::bigint,
    'stale base unit kept the conversion row'
  );

-- 100
select
  throws_ok (
    $$select app.delete_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      99,
      'kg'
    )$$,
    '40001'::char(5),
    'conversion changed',
    'delete_unit_conversion rejects a stale factor'
  );

-- 101
select
  is (
    (
      select
        count(*)
      from
        app.item_unit_conversions
      where
        item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'
    ),
    1::bigint,
    'stale factor kept the conversion row'
  );

-- ============================================================================
-- Signed-in non-owner: RLS hides rows; item DELETE is a missing grant.
-- ============================================================================
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

-- 28
select
  is_empty (
    $$select id from app.stock_items$$,
    'non-owner select of stock_items returns zero rows'
  );

-- 29
select
  is_empty (
    $$select item_id from app.item_unit_conversions$$,
    'non-owner select of item_unit_conversions returns zero rows'
  );

-- 30
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency)
      values ('صنف دخيل', 'ingredient', 'kg', 'weekly')$$,
    '42501'::char(5),
    'new row violates row-level security policy for table "stock_items"',
    'non-owner insert into stock_items is rejected by RLS'
  );

-- 31
select
  lives_ok (
    $$update app.stock_items
      set name = 'اسم مخترق'
      where id = '31000000-0000-4000-8000-000000000001'$$,
    'non-owner update of stock_items is not a permission error'
  );

-- 32
select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'علبة', 6)$$,
    '42501'::char(5),
    'new row violates row-level security policy for table "item_unit_conversions"',
    'non-owner insert into item_unit_conversions is rejected by RLS'
  );

-- 80
select
  throws_ok (
    $$select app.add_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'علبة',
      6,
      'kg'
    )$$,
    '42501'::char(5),
    'new row violates row-level security policy for table "item_unit_conversions"',
    'non-owner add_unit_conversion is rejected by RLS'
  );

-- 102
select
  throws_ok (
    $$select app.update_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      30,
      99,
      'kg'
    )$$,
    '40001'::char(5),
    'conversion changed',
    'non-owner update_unit_conversion changes nothing'
  );

-- 103
select
  throws_ok (
    $$select app.delete_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      30,
      'kg'
    )$$,
    '40001'::char(5),
    'conversion changed',
    'non-owner delete_unit_conversion changes nothing'
  );

-- 33
select
  lives_ok (
    $$update app.item_unit_conversions
      set factor_to_base = 99
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    'non-owner update of a conversion is not a permission error'
  );

-- 34
select
  lives_ok (
    $$delete from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    'non-owner delete of a conversion is not a permission error'
  );

-- 35
select
  throws_ok (
    $$delete from app.stock_items
      where id = '31000000-0000-4000-8000-000000000001'$$,
    '42501'::char(5),
    'permission denied for table stock_items',
    'non-owner cannot delete a stock item'
  );

reset role;

-- 36
select
  is (
    (
      select
        name
      from
        app.stock_items
      where
        id = '31000000-0000-4000-8000-000000000001'
    ),
    'بوري مخلوط معدل'::text,
    'non-owner update of stock_items affected zero rows'
  );

-- 37
select
  results_eq (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    $$values (4::numeric)$$,
    'non-owner update of a conversion affected zero rows'
  );

-- 38
select
  is (
    (
      select
        count(*)
      from
        app.item_unit_conversions
      where
        item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'
    ),
    1::bigint,
    'non-owner delete of a conversion affected zero rows'
  );

-- 104
select
  results_eq (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    $$values (30::numeric)$$,
    'non-owner update and delete left bag = 30'
  );

-- ============================================================================
-- anon has no schema usage, so every statement is permission denied.
-- ============================================================================
set
  local role anon;

-- 39
select
  throws_ok (
    $$select id from app.stock_items$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot select stock_items'
  );

-- 40
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency)
      values ('صنف مجهول', 'ingredient', 'kg', 'weekly')$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot insert stock_items'
  );

-- 41
select
  throws_ok (
    $$update app.stock_items set name = 'صنف مجهول'$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot update stock_items'
  );

-- 42
select
  throws_ok (
    $$delete from app.stock_items$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot delete stock_items'
  );

-- 43
select
  throws_ok (
    $$select item_id from app.item_unit_conversions$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot select item_unit_conversions'
  );

-- 44
select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'علبة', 6)$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot insert item_unit_conversions'
  );

-- 45
select
  throws_ok (
    $$update app.item_unit_conversions set factor_to_base = 1$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot update item_unit_conversions'
  );

-- 46
select
  throws_ok (
    $$delete from app.item_unit_conversions$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot delete item_unit_conversions'
  );

-- 81
select
  throws_ok (
    $$select app.add_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      1,
      'kg'
    )$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot execute add_unit_conversion'
  );

-- 105
select
  throws_ok (
    $$select app.update_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      30,
      1,
      'kg'
    )$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot execute update_unit_conversion'
  );

-- 106
select
  throws_ok (
    $$select app.delete_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      30,
      'kg'
    )$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot execute delete_unit_conversion'
  );

-- ============================================================================
-- Owner cannot delete an item or change id / created_at.
-- ============================================================================
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

-- 107
select
  lives_ok (
    $$select app.delete_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      30,
      'kg'
    )$$,
    'owner can delete a conversion through delete_unit_conversion'
  );

-- 108
select
  is_empty (
    $$select 1
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    'delete_unit_conversion removed the conversion row'
  );

-- 47
select
  throws_ok (
    $$delete from app.stock_items
      where id = '31000000-0000-4000-8000-000000000004'$$,
    '42501'::char(5),
    'permission denied for table stock_items',
    'owner cannot delete a stock item'
  );

-- 48
select
  throws_ok (
    $$update app.stock_items
      set id = '31000000-0000-4000-8000-000000000099'
      where id = '31000000-0000-4000-8000-000000000004'$$,
    '42501'::char(5),
    'permission denied for table stock_items',
    'owner cannot update stock_items.id'
  );

-- 49
select
  throws_ok (
    $$update app.stock_items
      set created_at = now()
      where id = '31000000-0000-4000-8000-000000000004'$$,
    '42501'::char(5),
    'permission denied for table stock_items',
    'owner cannot update stock_items.created_at'
  );

-- ============================================================================
-- Conversion unit and base_unit stay distinct. Existing integrity triggers
-- still apply to the owner.
-- ============================================================================
-- 50
select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'kg', 1)$$,
    '23514'::char(5),
    'cannot store a conversion for the item base unit',
    'conversion to the item base unit is rejected'
  );

-- 51
select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', ' kg ', 1)$$,
    '23514'::char(5),
    'cannot store a conversion for the item base unit',
    'conversion unit that trims to the base unit is rejected'
  );

-- 52
select
  throws_ok (
    $$update app.item_unit_conversions
      set unit = 'kg'
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    '23514'::char(5),
    'cannot store a conversion for the item base unit',
    'updating a conversion onto the base unit is rejected'
  );

-- 53
select
  throws_ok (
    $$update app.stock_items
      set base_unit = 'piece'
      where id = '31000000-0000-4000-8000-000000000004'$$,
    '23514'::char(5),
    'cannot change base_unit while the item has unit conversions',
    'base_unit change while a conversion exists is rejected'
  );

-- 54
select
  is (
    (
      select
        base_unit
      from
        app.stock_items
      where
        id = '31000000-0000-4000-8000-000000000004'
    ),
    'kg'::text,
    'rejected base_unit change left the ingredient on kg'
  );

-- 55
select
  lives_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000005', 'bag', 25)$$,
    'owner can add a bag conversion before changing base_unit'
  );

-- 56
select
  throws_ok (
    $$update app.stock_items
      set base_unit = 'liter'
      where id = '31000000-0000-4000-8000-000000000005'$$,
    '23514'::char(5),
    'cannot change base_unit while the item has unit conversions',
    'kg item cannot change to liter while bag = 25 exists'
  );

-- 57
select
  is (
    (
      select
        base_unit
      from
        app.stock_items
      where
        id = '31000000-0000-4000-8000-000000000005'
    ),
    'kg'::text,
    'rejected base_unit change left the uncounted item on kg'
  );

-- 58
select
  lives_ok (
    $$delete from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000005'
        and unit = 'bag'$$,
    'owner can delete the bag conversion'
  );

-- 59
select
  lives_ok (
    $$update app.stock_items
      set base_unit = 'liter'
      where id = '31000000-0000-4000-8000-000000000005'$$,
    'owner can change base_unit before any movement or conversion'
  );

-- 60
select
  is (
    (
      select
        base_unit
      from
        app.stock_items
      where
        id = '31000000-0000-4000-8000-000000000005'
    ),
    'liter'::text,
    'base_unit change without movements or conversions was stored'
  );

-- 61
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency)
      values ('حجم يتيم', 'fish_size', 'kg', 'daily')$$,
    '23514'::char(5),
    'fish_size item requires parent_item_id',
    'owner insert of fish_size without a parent is rejected'
  );

-- 62
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency, parent_item_id)
      values (
        'حجم غلط',
        'fish_size',
        'kg',
        'daily',
        '31000000-0000-4000-8000-000000000003'
      )$$,
    '23514'::char(5),
    'parent_item_id for fish_size must reference a fish_mixed item',
    'owner insert of fish_size under a non-fish_mixed parent is rejected'
  );

-- 63
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency, parent_item_id)
      values (
        'مكون بأب',
        'ingredient',
        'kg',
        'weekly',
        '31000000-0000-4000-8000-000000000001'
      )$$,
    '23514'::char(5),
    'parent_item_id must be null for non-fish_size items',
    'owner insert of a non-fish_size item with a parent is rejected'
  );

-- 64
select
  throws_ok (
    $$update app.stock_items
      set kind = 'seafood'
      where id = '31000000-0000-4000-8000-000000000001'$$,
    '23514'::char(5),
    'cannot change kind of fish_mixed item that has fish_size children',
    'owner cannot change kind of a fish_mixed item that has sizes'
  );

-- 65
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency)
      values ('بوري مخلوط معدل', 'ingredient', 'kg', 'weekly')$$,
    '23505'::char(5),
    'duplicate key value violates unique constraint "stock_items_name_key"',
    'owner duplicate item name is a unique violation'
  );

-- 66
select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'piece', 8)$$,
    '23505'::char(5),
    'duplicate key value violates unique constraint "item_unit_conversions_pkey"',
    'owner duplicate conversion unit is a unique violation'
  );

-- ============================================================================
-- service_role posts one movement, then the owner cannot change base_unit.
-- ============================================================================
reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

set
  local role service_role;

-- 67
select
  lives_ok (
    $$select app.post_movements(
      jsonb_build_array(
        jsonb_build_object(
          'item_id', '31000000-0000-4000-8000-000000000005',
          'movement_type', 'opening',
          'occurred_at', '2026-10-16T08:00:00Z',
          'quantity', 1,
          'unit_cost', 10
        )
      )
    )$$,
    'service_role can post a movement before the base_unit freeze check'
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

-- 68
select
  throws_ok (
    $$update app.stock_items
      set base_unit = 'piece'
      where id = '31000000-0000-4000-8000-000000000005'$$,
    '23514'::char(5),
    'cannot change base_unit of an item that has movements',
    'owner cannot change base_unit after a movement'
  );

-- 69
select
  is (
    (
      select
        base_unit
      from
        app.stock_items
      where
        id = '31000000-0000-4000-8000-000000000005'
    ),
    'liter'::text,
    'frozen base_unit stayed liter'
  );

select
  *
from
  finish ();

rollback;
