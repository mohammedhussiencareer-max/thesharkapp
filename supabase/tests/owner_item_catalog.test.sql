begin;

select
  plan (111);

-- Clean up any existing test rows in the transaction.
delete from app.provisional_deficits;

alter table app.stock_movements disable trigger trg_stock_movements_no_update_delete;

alter table app.stock_movements disable trigger trg_stock_movements_no_truncate;

delete from app.stock_movements;

alter table app.stock_movements enable trigger trg_stock_movements_no_update_delete;

alter table app.stock_movements enable trigger trg_stock_movements_no_truncate;

delete from app.item_balances;

alter table app.item_unit_conversions disable trigger trg_item_unit_conversions_frozen;

delete from app.item_unit_conversions;

alter table app.item_unit_conversions enable trigger trg_item_unit_conversions_frozen;

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
    $$values ('SELECT'::text)$$,
    'authenticated table privileges on stock_items are SELECT only'
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
          'parent_item_id',
          'active'
        )
    ),
    6::bigint,
    'authenticated can update the six editable stock_items columns'
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
    $$values ('SELECT'::text)$$,
    'authenticated can only select conversions'
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
-- Owner writes. Direct insert is revoked, so the fixed ids are seeded as the
-- table owner. The owner role then uses create_stock_item and dated writers.
-- ============================================================================
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
    '31000000-0000-4000-8000-000000000001',
    'بوري مخلوط',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    '31000000-0000-4000-8000-000000000002',
    'بوري كبير',
    'fish_size',
    'kg',
    'daily',
    '31000000-0000-4000-8000-000000000001'
  ),
  (
    '31000000-0000-4000-8000-000000000003',
    'جمبري',
    'seafood',
    'kg',
    'daily',
    null
  ),
  (
    '31000000-0000-4000-8000-000000000004',
    'زيت',
    'ingredient',
    'kg',
    'weekly',
    null
  ),
  (
    '31000000-0000-4000-8000-000000000005',
    'صنف للجرد',
    'ingredient',
    'kg',
    'weekly',
    null
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

-- 16
select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency)
      values ('صنف مباشر', 'ingredient', 'kg', 'weekly')$$,
    '42501'::char(5),
    'permission denied for table stock_items',
    'owner cannot insert stock_items directly'
  );

-- 17
select
  lives_ok (
    $$update app.stock_items
      set name = 'بوري مخلوط معدل',
          count_frequency = 'weekly',
          active = false
      where id = '31000000-0000-4000-8000-000000000001'$$,
    'owner can update editable stock_items columns without loss_pct'
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
      0::numeric,
      null::uuid,
      false
    )$$,
    'owner update leaves the frozen loss_pct at its default'
  );

-- 19
select
  lives_ok (
    $$select app.create_stock_item(
      '31000000-0000-4000-8000-000000000019',
      'بوري وسط اختبار',
      'fish_size',
      'kg',
      'daily',
      '31000000-0000-4000-8000-000000000001',
      null,
      true
    )$$,
    'owner can create a fish_size through create_stock_item'
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
    $$select app.create_stock_item(
      '31000000-0000-4000-8000-000000000021',
      'جمبري اختبار',
      'seafood',
      'kg',
      'daily',
      null,
      0,
      true
    )$$,
    'owner can create seafood through create_stock_item'
  );

-- 22
select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'piece', 2)$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'owner cannot insert a legacy conversion'
  );

-- 23
select
  throws_ok (
    $$update app.item_unit_conversions
      set factor_to_base = 4
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'owner cannot update a legacy conversion factor'
  );

-- 24
select
  is_empty (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    'owner conversion update stored nothing on the frozen table'
  );

-- 25
select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'كرتونة', 10)$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'owner cannot insert a second legacy conversion'
  );

-- 26
select
  throws_ok (
    $$delete from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'كرتونة'$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'owner cannot delete a legacy conversion'
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
  throws_ok (
    $$select app.add_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      25,
      'kg'
    )$$,
    '0A000'::char(5),
    'use app.set_item_conversion',
    'add_unit_conversion tells the owner to use the dated writer'
  );

-- 76
select
  is_empty (
    $$select unit, factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'$$,
    'add_unit_conversion stored nothing'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'add_unit_conversion refuses before it can compare the base unit'
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
    0::bigint,
    'refused add_unit_conversion inserted nothing'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'add_unit_conversion refuses a missing item before any lookup'
  );

-- 92
select
  throws_ok (
    $$select app.update_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      25,
      30,
      'kg'
    )$$,
    '0A000'::char(5),
    'use app.set_item_conversion',
    'update_unit_conversion tells the owner to use the dated writer'
  );

-- 93
select
  is_empty (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    'update_unit_conversion stored nothing'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'update_unit_conversion refuses before it can compare the base unit'
  );

-- 95
select
  is_empty (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    'refused update left no legacy conversion'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'update_unit_conversion refuses before it can compare the factor'
  );

-- 97
select
  is_empty (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    'refused stale factor left no legacy conversion'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'delete_unit_conversion refuses before it can compare the base unit'
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
    0::bigint,
    'refused delete left no legacy conversion'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'delete_unit_conversion refuses before it can compare the factor'
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
    0::bigint,
    'refused stale factor left no legacy conversion'
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
    'permission denied for table stock_items',
    'non-owner insert into stock_items is denied'
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
    'permission denied for table item_unit_conversions',
    'non-owner insert into item_unit_conversions is denied'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'non-owner add_unit_conversion is refused before RLS'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'non-owner update_unit_conversion is refused'
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
    '0A000'::char(5),
    'use app.set_item_conversion',
    'non-owner delete_unit_conversion is refused'
  );

-- 33
select
  throws_ok (
    $$update app.item_unit_conversions
      set factor_to_base = 99
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'non-owner update of a conversion is denied'
  );

-- 34
select
  throws_ok (
    $$delete from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'non-owner delete of a conversion is denied'
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
  is_empty (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    'non-owner update left no legacy conversion'
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
    0::bigint,
    'non-owner delete left no legacy conversion'
  );

-- 104
select
  is_empty (
    $$select factor_to_base::numeric
      from app.item_unit_conversions
      where item_id = '31000000-0000-4000-8000-000000000003'
        and unit = 'bag'$$,
    'non-owner update and delete left no legacy bag conversion'
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
  throws_ok (
    $$select app.delete_unit_conversion(
      '31000000-0000-4000-8000-000000000003',
      'bag',
      30,
      'kg'
    )$$,
    '0A000'::char(5),
    'use app.set_item_conversion',
    'delete_unit_conversion tells the owner to use the dated writer'
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
    $$select app.set_item_conversion(
      '31000000-0000-4000-8000-000000000050',
      '31000000-0000-4000-8000-000000000004',
      'kg',
      1,
      null,
      null,
      md5(''),
      null
    )$$,
    '22023'::char(5),
    'conversion unit must differ from the item base_unit',
    'conversion to the item base unit is rejected'
  );

-- 51
select
  throws_ok (
    $$select app.set_item_conversion(
      '31000000-0000-4000-8000-000000000051',
      '31000000-0000-4000-8000-000000000004',
      ' kg ',
      1,
      null,
      null,
      md5(''),
      null
    )$$,
    '22023'::char(5),
    'conversion unit must differ from the item base_unit',
    'conversion unit that trims to the base unit is rejected'
  );

-- 52
select
  throws_ok (
    $$update app.item_unit_conversions
      set unit = 'kg'
      where item_id = '31000000-0000-4000-8000-000000000004'
        and unit = 'piece'$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'updating a legacy conversion onto the base unit is denied'
  );

-- 53
select
  throws_ok (
    $fn$do $body$
      begin
        perform app.set_item_conversion(
          '31000000-0000-4000-8000-000000000053',
          '31000000-0000-4000-8000-000000000004',
          'piece',
          2,
          null,
          null,
          md5(''),
          null
        );
        update app.stock_items
        set base_unit = 'piece'
        where id = '31000000-0000-4000-8000-000000000004';
      end
      $body$;$fn$,
    '23514'::char(5),
    'cannot change base_unit of an item that is configured or has movements',
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
    $fn$do $body$
      begin
        perform app.add_custom_unit(
          '31000000-0000-4000-8000-000000000055',
          'bag',
          'كيس'
        );
        perform app.set_item_conversion(
          '31000000-0000-4000-8000-000000000056',
          '31000000-0000-4000-8000-000000000005',
          'bag',
          25,
          null,
          null,
          md5(''),
          null
        );
      end
      $body$;$fn$,
    'owner can add a bag conversion before changing base_unit'
  );

-- 56
select
  throws_ok (
    $$update app.stock_items
      set base_unit = 'liter'
      where id = '31000000-0000-4000-8000-000000000005'$$,
    '23514'::char(5),
    'cannot change base_unit of an item that is configured or has movements',
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
    $$select app.set_item_conversion(
      '31000000-0000-4000-8000-000000000058',
      '31000000-0000-4000-8000-000000000005',
      'bag',
      null,
      null,
      null,
      (
        select conv ->> 'token'
        from jsonb_array_elements(
          app.item_costing_schedule('31000000-0000-4000-8000-000000000005') -> 'conversions'
        ) conv
        where conv ->> 'unit_code' = 'bag'
      ),
      null
    )$$,
    'owner can remove the bag conversion'
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
    $$select app.create_stock_item(
      '31000000-0000-4000-8000-000000000061',
      'حجم يتيم',
      'fish_size',
      'kg',
      'daily',
      null,
      null,
      true
    )$$,
    '23514'::char(5),
    'fish_size item requires parent_item_id',
    'owner insert of fish_size without a parent is rejected'
  );

-- 62
select
  throws_ok (
    $$select app.create_stock_item(
      '31000000-0000-4000-8000-000000000062',
      'حجم غلط',
      'fish_size',
      'kg',
      'daily',
      '31000000-0000-4000-8000-000000000003',
      null,
      true
    )$$,
    '23514'::char(5),
    'parent_item_id for fish_size must reference a fish_mixed item',
    'owner insert of fish_size under a non-fish_mixed parent is rejected'
  );

-- 63
select
  throws_ok (
    $$select app.create_stock_item(
      '31000000-0000-4000-8000-000000000063',
      'مكون بأب',
      'ingredient',
      'kg',
      'weekly',
      '31000000-0000-4000-8000-000000000001',
      null,
      true
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
    $$select app.create_stock_item(
      '31000000-0000-4000-8000-000000000065',
      'بوري مخلوط معدل',
      'ingredient',
      'kg',
      'weekly',
      null,
      null,
      true
    )$$,
    '23505'::char(5),
    'duplicate key value violates unique constraint "stock_items_name_key"',
    'owner duplicate item name is a unique violation'
  );

-- 66
select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('31000000-0000-4000-8000-000000000004', 'piece', 8)$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'owner duplicate legacy conversion is denied before the unique check'
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

-- 111: the base-unit row trigger takes no item row lock (the posting advisory
-- lock already serializes it); a row lock there deadlocks with multi-row item
-- updates such as toggling active.
select
  ok (
    pg_catalog.pg_get_functiondef (
      'app.trg_item_unit_conversions_reject_base_unit()'::regprocedure
    ) !~* 'for\s+(share|update|no\s+key\s+update|key\s+share)',
    'conversion base-unit trigger takes no item row lock'
  );

select
  *
from
  finish ();

rollback;
