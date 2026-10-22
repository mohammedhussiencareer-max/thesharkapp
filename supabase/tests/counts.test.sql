begin;

select
  no_plan ();

-- Clean up any existing test rows in the transaction. Count lines reference
-- movements, so they go before the ledger cleanup. POS rows are removed so
-- shift and sync coverage in this transaction do not depend on other tests.
alter table app.stock_count_lines disable trigger trg_stock_count_lines_no_update_delete;

delete from app.stock_count_lines;

alter table app.stock_count_lines enable trigger trg_stock_count_lines_no_update_delete;

alter table app.stock_counts disable trigger trg_stock_counts_no_update_delete;

delete from app.stock_counts;

alter table app.stock_counts enable trigger trg_stock_counts_no_update_delete;

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

delete from app.pos_sync_run_orders;

delete from app.pos_shift_transactions;

delete from app.pos_order_lines;

delete from app.pos_orders;

delete from app.pos_shifts;

delete from app.pos_sync_runs;

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
  has_table ('app', 'stock_counts', 'app.stock_counts exists');

select
  has_table (
    'app',
    'stock_count_lines',
    'app.stock_count_lines exists'
  );

select
  has_view (
    'app',
    'stock_count_history',
    'app.stock_count_history exists'
  );

select
  has_function (
    'app',
    'record_count',
    array['jsonb'],
    'app.record_count(jsonb) exists'
  );

select
  has_index (
    'app',
    'stock_counts',
    'stock_counts_request_id_key',
    'count request_id is unique'
  );

select
  has_index (
    'app',
    'stock_counts',
    'stock_counts_created_at_idx',
    'counts are indexed by created_at and id'
  );

select
  has_index (
    'app',
    'stock_counts',
    'stock_counts_counted_at_idx',
    'counts are indexed by counted_at'
  );

select
  has_index (
    'app',
    'stock_count_lines',
    'stock_count_lines_item_key',
    'an item appears once per count'
  );

select
  has_index (
    'app',
    'stock_count_lines',
    'stock_count_lines_item_id_idx',
    'count lines are indexed by item'
  );

select
  has_trigger (
    'app',
    'stock_counts',
    'trg_stock_counts_no_update_delete',
    'counts reject update and delete'
  );

select
  has_trigger (
    'app',
    'stock_counts',
    'trg_stock_counts_no_truncate',
    'counts reject truncate'
  );

select
  has_trigger (
    'app',
    'stock_count_lines',
    'trg_stock_count_lines_no_update_delete',
    'count lines reject update and delete'
  );

select
  has_trigger (
    'app',
    'stock_count_lines',
    'trg_stock_count_lines_no_truncate',
    'count lines reject truncate'
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
        and p.proname = 'record_count'
    ),
    'record_count is security definer with an empty search_path'
  );

-- First match of each name. Replay reads stock_counts before lines, shifts,
-- sync, and items. The lock helper runs before post_movements, and the
-- document insert is last. The body does read stock_items.
select
  ok (
    (
      select
        position('app.assert_ledger_write_allowed' in def) > 0
        and position('app.assert_ledger_write_allowed' in def) < position('app.assert_no_phone_text' in def)
        and position('app.assert_no_phone_text' in def) < position('app.stock_counts' in def)
        and position('app.stock_counts' in def) < position('app.pos_shifts' in def)
        and position('app.pos_shifts' in def) < position('app.pos_sync_runs' in def)
        and position('app.pos_sync_runs' in def) < position('app.stock_items' in def)
        and position('app.stock_items' in def) < position('app.lock_and_validate_item_balance' in def)
        and position('app.lock_and_validate_item_balance' in def) < position('app.post_movements' in def)
        and position('app.post_movements' in def) < position('insert into' in lower(def))
      from
        (
          select
            pg_catalog.pg_get_functiondef ('app.record_count(jsonb)'::regprocedure) as def
        ) s
    ),
    'record_count locks, checks the note, replays, then guards shifts, sync, and items before posting'
  );

select
  ok (
    has_function_privilege(
      'authenticated',
      'app.record_count(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'app.record_count(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'app.record_count(jsonb)'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.record_count(jsonb)'::regprocedure,
      'EXECUTE'
    ),
    'record_count execute is granted to authenticated and service_role only'
  );

select
  ok (
    not has_function_privilege(
      'anon',
      'app.prevent_count_mutation()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app.prevent_count_mutation()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app.prevent_count_mutation()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.prevent_count_mutation()'::regprocedure,
      'EXECUTE'
    ),
    'the append-only trigger function is not executable via the API'
  );

select
  has_column (
    'app',
    'pos_shifts',
    'close_recorded_at',
    'pos_shifts records when a close was stored'
  );

select
  has_trigger (
    'app',
    'pos_shifts',
    'trg_pos_shifts_close_recorded',
    'storing a shift close stamps close_recorded_at'
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
        and p.proname = 'stamp_shift_close_recorded'
    ),
    'stamp_shift_close_recorded is security definer with an empty search_path'
  );

select
  ok (
    not has_function_privilege(
      'anon',
      'app.stamp_shift_close_recorded()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app.stamp_shift_close_recorded()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app.stamp_shift_close_recorded()'::regprocedure,
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.stamp_shift_close_recorded()'::regprocedure,
      'EXECUTE'
    ),
    'stamp_shift_close_recorded is not an API function'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'stock_counts'
        and grantee = 'authenticated'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select counts'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'stock_count_lines'
        and grantee = 'authenticated'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select count lines'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'stock_counts'
        and grantee = 'service_role'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'service_role can only select counts'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'stock_count_lines'
        and grantee = 'service_role'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'service_role can only select count lines'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'stock_count_history'
        and grantee = 'authenticated'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select count history'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'stock_count_history'
        and grantee = 'service_role'
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'service_role can only select count history'
  );

select
  is_empty (
    $$select privilege_type
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name in (
          'stock_counts',
          'stock_count_lines',
          'stock_count_history'
        )
        and grantee in ('anon', 'PUBLIC')$$,
    'anon and public have no privileges on count tables or the history view'
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
        and tablename = 'stock_counts'
        and policyname = 'stock_counts_select_owner'
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
        and tablename = 'stock_count_lines'
        and policyname = 'stock_count_lines_select_owner'
        and cmd = 'SELECT'
        and roles = '{authenticated}'::name[]
    ),
    'owner select policies exist on both count tables'
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
        and tablename in ('stock_counts', 'stock_count_lines')
        and cmd <> 'SELECT'
    ),
    0::bigint,
    'count tables have no insert, update, or delete policies'
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
        and c.relname in ('stock_counts', 'stock_count_lines')
        and c.relrowsecurity
    ),
    2::bigint,
    'RLS is enabled on both count tables'
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
        and c.relname = 'stock_count_history'
        and (
          opt = 'security_invoker=true'
          or opt = 'security_invoker=on'
        )
    ),
    'stock_count_history is security invoker'
  );

-- ============================================================================
-- Synthetic catalog and POS mirror. Not restaurant data.
-- Closed shift is [08:30, 09:30). Open shift starts at 15:00 and stays open.
-- close_recorded_at is the database clock when the closed row is inserted.
-- The ok sync run starts one second after that stamp and finishes one minute
-- after it. Coverage is started_at > close_recorded_at, not a gap between
-- counted_at and started_at. Identity ids increase with insert order.
-- ============================================================================
insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    active
  )
values
  (
    'c1900000-0000-4000-8000-000000000001',
    'بلطي جرد اختبار',
    'seafood',
    'kg',
    'daily',
    true
  ),
  (
    'c1900000-0000-4000-8000-000000000002',
    'جمبري جرد اختبار',
    'seafood',
    'kg',
    'daily',
    true
  ),
  (
    'c1900000-0000-4000-8000-000000000003',
    'كابوريا جرد اختبار',
    'seafood',
    'kg',
    'daily',
    true
  ),
  (
    'c1900000-0000-4000-8000-000000000004',
    'توابل جرد اختبار',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'c1900000-0000-4000-8000-000000000005',
    'موقوف جرد اختبار',
    'seafood',
    'kg',
    'daily',
    false
  ),
  (
    'c1900000-0000-4000-8000-000000000006',
    'بدون رصيد جرد اختبار',
    'seafood',
    'kg',
    'daily',
    true
  ),
  (
    'c1900000-0000-4000-8000-000000000007',
    'موقوف أسبوعي جرد اختبار',
    'ingredient',
    'kg',
    'weekly',
    false
  ),
  (
    'c1900000-0000-4000-8000-000000000008',
    'مطابقة جرد اختبار',
    'seafood',
    'kg',
    'daily',
    true
  ),
  (
    'c1900000-0000-4000-8000-000000000009',
    'لم يتحرك جرد اختبار',
    'seafood',
    'kg',
    'daily',
    true
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
    'shift-count-closed',
    '2026-10-22T08:30:00Z',
    '2026-10-22T09:30:00Z',
    false,
    '2026-10-22T09:30:00Z'
  ),
  (
    'shift-count-open',
    '2026-10-22T15:00:00Z',
    null,
    true,
    '2026-10-22T15:00:00Z'
  );

select
  ok (
    (
      select
        close_recorded_at is not null
        and close_recorded_at <= pg_catalog.clock_timestamp ()
        and close_recorded_at > pg_catalog.clock_timestamp () - interval '1 minute'
      from
        app.pos_shifts
      where
        id = 'shift-count-closed'
    ),
    'inserting a closed shift stamps close_recorded_at from the database clock'
  );

select
  is (
    (
      select
        close_recorded_at
      from
        app.pos_shifts
      where
        id = 'shift-count-open'
    ),
    null::timestamptz,
    'inserting an open shift leaves close_recorded_at null'
  );

-- Caller-supplied stamps must be ignored. These rows open before the seeded
-- shifts, so they are deleted before any count: an open one would refuse
-- every later count, and a closed one would become the prior shift at 08:00.
insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time,
    close_recorded_at
  )
values
  (
    'shift-count-trigger',
    '2026-10-21T08:00:00Z',
    '2026-10-21T09:00:00Z',
    false,
    '2026-10-21T09:00:00Z',
    '2000-01-01T00:00:00Z'
  );

select
  ok (
    (
      select
        close_recorded_at is not null
        and close_recorded_at <> '2000-01-01T00:00:00Z'::timestamptz
        and close_recorded_at <= pg_catalog.clock_timestamp ()
        and close_recorded_at > pg_catalog.clock_timestamp () - interval '1 minute'
      from
        app.pos_shifts
      where
        id = 'shift-count-trigger'
    ),
    'inserting a closed shift ignores a caller close_recorded_at'
  );

insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time,
    close_recorded_at
  )
values
  (
    'shift-count-trigger-open',
    '2026-10-21T10:00:00Z',
    null,
    true,
    '2026-10-21T10:00:00Z',
    '2000-01-01T00:00:00Z'
  );

select
  is (
    (
      select
        close_recorded_at
      from
        app.pos_shifts
      where
        id = 'shift-count-trigger-open'
    ),
    null::timestamptz,
    'inserting an open shift clears a caller close_recorded_at'
  );

update app.pos_shifts
set
  closed_at = '2026-10-21T11:00:00Z',
  close_recorded_at = '1999-01-01T00:00:00Z',
  is_active = false
where
  id = 'shift-count-trigger-open';

select
  ok (
    (
      select
        close_recorded_at is not null
        and close_recorded_at <> '1999-01-01T00:00:00Z'::timestamptz
        and close_recorded_at <= pg_catalog.clock_timestamp ()
        and close_recorded_at > pg_catalog.clock_timestamp () - interval '1 minute'
      from
        app.pos_shifts
      where
        id = 'shift-count-trigger-open'
    ),
    'closing an open shift stamps close_recorded_at and ignores a caller value'
  );

create temporary table count_trigger_prior on
commit
drop as
select
  close_recorded_at as stamp
from
  app.pos_shifts
where
  id = 'shift-count-trigger';

insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time,
    close_recorded_at
  )
values
  (
    'shift-count-trigger',
    '2026-10-21T08:00:00Z',
    '2026-10-21T09:00:00Z',
    false,
    '2026-10-21T09:00:00Z',
    '1999-01-01T00:00:00Z'
  )
on conflict (id) do update
set
  opened_at = excluded.opened_at,
  closed_at = excluded.closed_at,
  is_active = excluded.is_active,
  pos_update_time = excluded.pos_update_time,
  close_recorded_at = excluded.close_recorded_at;

select
  ok (
    (
      select
        shift.close_recorded_at = prior.stamp
        and shift.close_recorded_at is distinct from '1999-01-01T00:00:00Z'::timestamptz
      from
        app.pos_shifts shift
        cross join count_trigger_prior prior
      where
        shift.id = 'shift-count-trigger'
    ),
    'an upsert that does not change closed_at keeps close_recorded_at'
  );

select
  pg_catalog.pg_sleep (0.05);

update app.pos_shifts
set
  closed_at = closed_at + interval '1 hour',
  close_recorded_at = '1999-01-01T00:00:00Z'
where
  id = 'shift-count-trigger';

select
  ok (
    (
      select
        shift.close_recorded_at > prior.stamp
        and shift.close_recorded_at is distinct from '1999-01-01T00:00:00Z'::timestamptz
      from
        app.pos_shifts shift
        cross join count_trigger_prior prior
      where
        shift.id = 'shift-count-trigger'
    ),
    'changing closed_at records a new close_recorded_at and ignores a caller value'
  );

update app.pos_shifts
set
  closed_at = null,
  close_recorded_at = '1999-01-01T00:00:00Z',
  is_active = true
where
  id = 'shift-count-trigger';

select
  is (
    (
      select
        close_recorded_at
      from
        app.pos_shifts
      where
        id = 'shift-count-trigger'
    ),
    null::timestamptz,
    'reopening a shift clears close_recorded_at'
  );

delete from app.pos_shifts
where
  id in ('shift-count-trigger', 'shift-count-trigger-open');

insert into
  app.pos_sync_runs (mode, status, started_at, finished_at, error)
  -- After every close stamp and after every count time used here, whatever
  -- the wall clock is when the test runs.
select
  'recent',
  'ok',
  greatest(
    pg_catalog.max (shift.close_recorded_at) + interval '1 second',
    '2026-10-23T00:00:00Z'::timestamptz
  ),
  greatest(
    pg_catalog.max (shift.close_recorded_at) + interval '1 second',
    '2026-10-23T00:00:00Z'::timestamptz
  ) + interval '1 minute',
  null
from
  app.pos_shifts shift;

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
-- Validation. None of these calls post a count.
-- ============================================================================
select
  throws_ok (
    $$select app.record_count('[]'::jsonb)$$,
    '22023',
    'p_count must be a jsonb object',
    'a count payload must be an object'
  );

select
  throws_ok (
    $$select app.record_count('null'::jsonb)$$,
    '22023',
    'p_count must be a jsonb object',
    'a null count payload is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object('note', 1))$$,
    '22023',
    'note must be text',
    'a non-text note is refused'
  );

select
  throws_ok (
    $$select app.record_count('{}'::jsonb)$$,
    '22023',
    'request_id is required',
    'a missing request_id is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'not-a-uuid',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'request_id is required',
    'a request_id that is not a uuid is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000040',
      'frequency', 'monthly',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'frequency must be daily or weekly',
    'a frequency outside daily and weekly is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000041',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'frequency must be daily or weekly',
    'a missing frequency is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000042',
      'frequency', 'daily',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'counted_at is required',
    'a missing counted_at is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000043',
      'frequency', 'daily',
      'counted_at', 'infinity',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'counted_at must be a finite timestamp',
    'an infinite counted_at is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000044',
      'frequency', 'daily',
      'counted_at', 'not-a-time',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'counted_at must be a finite timestamp',
    'an unparseable counted_at is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000045',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'note', repeat('ن', 501),
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'note must be at most 500 characters',
    'a note longer than 500 characters is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000019',
      'frequency', 'daily',
      'counted_at', '2026-10-22T09:00:00Z',
      'note', '01001234567',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'phone digits in the note are refused before the shift check'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000046',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', '[]'::jsonb
    ))$$,
    '22023',
    'lines must be a jsonb array of 1 to 200 lines',
    'an empty line list is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000047',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z'
    ))$$,
    '22023',
    'lines must be a jsonb array of 1 to 200 lines',
    'a missing line list is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000048',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'item_id', pg_catalog.gen_random_uuid(),
            'counted_qty', '1'
          )
        )
        from pg_catalog.generate_series(1, 201)
      )
    ))$$,
    '22023',
    'lines must be a jsonb array of 1 to 200 lines',
    'more than 200 lines is refused before each line is read'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000049',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', '[1]'::jsonb
    ))$$,
    '22023',
    'each count line must be a jsonb object',
    'a line that is not an object is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-00000000004a',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001'
      ))
    ))$$,
    '22023',
    'item_id and counted_qty are required',
    'a line without a quantity is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-00000000004b',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'not-a-uuid',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'item_id must be a uuid',
    'an item id that is not a uuid is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-00000000004c',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000001',
          'counted_qty', '1'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000001',
          'counted_qty', '2'
        )
      )
    ))$$,
    '22023',
    'duplicate item',
    'the same item twice in one count is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-00000000004d',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '-1'
      ))
    ))$$,
    '22023',
    'counted_qty must be a finite number >= 0',
    'a negative counted quantity is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-00000000004e',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '1.1234567'
      ))
    ))$$,
    '22023',
    'counted_qty must have at most 6 decimal places',
    'a counted quantity with more than 6 decimal places is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-00000000004f',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '100000000000000'
      ))
    ))$$,
    '22023',
    'counted_qty is out of range',
    'a counted quantity that does not fit numeric(20,6) is refused'
  );

-- ============================================================================
-- Shift, sync, and catalog guards. Still no count row.
-- Inside a closed shift is checked before an open shift. An open shift is
-- checked before sync. Sync is checked before the catalog.
-- ============================================================================
select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000010',
      'frequency', 'daily',
      'counted_at', '2026-10-22T09:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '7'
      ))
    ))$$,
    '22023',
    'count time is inside a shift',
    'a count inside a closed shift is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000011',
      'frequency', 'daily',
      'counted_at', '2026-10-22T08:30:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '7'
      ))
    ))$$,
    '22023',
    'count time is inside a shift',
    'a count exactly at a closed shift open is inside that shift'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000012',
      'frequency', 'daily',
      'counted_at', '2026-10-22T15:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'a shift is still open',
    'an open shift is refused before sync coverage and before an unknown item'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000013',
      'frequency', 'daily',
      'counted_at', '2026-10-22T16:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '7'
      ))
    ))$$,
    '22023',
    'a shift is still open',
    'a count after an open shift has opened is refused'
  );

-- Coverage compares the database clocks. Move started_at as the table owner,
-- then count again as the owner. Restore the covering run before later counts.
reset role;

update app.pos_sync_runs
set
  started_at = (
    select
      pg_catalog.max (close_recorded_at)
    from
      app.pos_shifts
  )
where
  status = 'ok';

set
  local role authenticated;

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000014',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'sync has not covered this count time',
    'a run that started exactly at the latest close stamp does not cover'
  );

reset role;

update app.pos_sync_runs
set
  started_at = (
    select
      pg_catalog.max (close_recorded_at) - interval '1 second'
    from
      app.pos_shifts
  )
where
  status = 'ok';

set
  local role authenticated;

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000052',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'sync has not covered this count time',
    'a run that started before the latest close stamp does not cover'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000053',
      'frequency', 'daily',
      'counted_at', '2026-10-22T14:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'sync has not covered this count time',
    'a count time far from the sync start is still refused when the run began before the close was recorded'
  );

reset role;

update app.pos_sync_runs
set
  -- After every close stamp and after every count time used here, whatever
  -- the wall clock is when the test runs.
  started_at = (
    select
      greatest(
        pg_catalog.max (close_recorded_at) + interval '1 second',
        '2026-10-23T00:00:00Z'::timestamptz
      )
    from
      app.pos_shifts
  ),
  finished_at = (
    select
      greatest(
        pg_catalog.max (close_recorded_at) + interval '1 second',
        '2026-10-23T00:00:00Z'::timestamptz
      ) + interval '1 minute'
    from
      app.pos_shifts
  )
where
  status = 'ok';

set
  local role authenticated;

-- Shifts can overlap. The latest close stamp of every shift opened before
-- the count counts, not the stamp of the latest-opened shift. This shift
-- opened earlier than shift-count-closed and closed later, so its stamp is
-- later; a run between the two stamps does not cover.
reset role;

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
    'shift-count-overlap',
    '2026-10-22T08:00:00Z',
    '2026-10-22T09:45:00Z',
    false,
    '2026-10-22T09:45:00Z'
  );

update app.pos_sync_runs
set
  started_at = (
    select
      close_recorded_at - interval '1 microsecond'
    from
      app.pos_shifts
    where
      id = 'shift-count-overlap'
  ),
  finished_at = (
    select
      close_recorded_at + interval '1 minute'
    from
      app.pos_shifts
    where
      id = 'shift-count-overlap'
  )
where
  status = 'ok';

select
  ok (
    (
      select
        run.started_at > closed.close_recorded_at
      from
        app.pos_sync_runs run
        cross join app.pos_shifts closed
      where
        run.status = 'ok'
        and closed.id = 'shift-count-closed'
    ),
    'the overlap run starts after the latest-opened shift''s close stamp'
  );

set
  local role authenticated;

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000901',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'sync has not covered this count time',
    'a run before the latest close stamp of overlapping shifts does not cover'
  );

-- Freshness: a run must start at or after counted_at, so a shift opened on
-- the POS before the count but unknown to the mirror is in its read. Remove
-- the open shift for this case so the shift guard does not refuse first.
reset role;

delete from app.pos_shifts
where
  id in ('shift-count-overlap', 'shift-count-open');

update app.pos_sync_runs
set
  -- After every close stamp and after every count time used here, whatever
  -- the wall clock is when the test runs.
  started_at = (
    select
      greatest(
        pg_catalog.max (close_recorded_at) + interval '1 second',
        '2026-10-23T00:00:00Z'::timestamptz
      )
    from
      app.pos_shifts
  ),
  finished_at = (
    select
      greatest(
        pg_catalog.max (close_recorded_at) + interval '1 second',
        '2026-10-23T00:00:00Z'::timestamptz
      ) + interval '1 minute'
    from
      app.pos_shifts
  )
where
  status = 'ok';

select
  set_config(
    'test.count_after_run',
    (
      select
        (run.started_at + interval '1 second')::text
      from
        app.pos_sync_runs run
      where
        run.status = 'ok'
    ),
    true
  );

set
  local role authenticated;

select
  throws_ok (
    format(
      $f$select app.record_count(jsonb_build_object(
        'request_id', 'd1900000-0000-4000-8000-000000000902',
        'frequency', 'daily',
        'counted_at', %L,
        'lines', jsonb_build_array(jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000099',
          'counted_qty', '1'
        ))
      ))$f$,
      current_setting('test.count_after_run')
    ),
    '22023',
    'sync has not covered this count time',
    'a run that started before counted_at does not cover, even after every close stamp'
  );

reset role;

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
    'shift-count-open',
    '2026-10-22T15:00:00Z',
    null,
    true,
    '2026-10-22T15:00:00Z'
  );

set
  local role authenticated;

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000054',
      'frequency', 'daily',
      'counted_at', '2026-10-22T14:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'unknown stock item',
    'skew between the count time and the sync start does not block once the run began after the close was recorded'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000055',
      'frequency', 'daily',
      'counted_at', '2026-10-22T08:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'unknown stock item',
    'with no shift opened at or before the count, a finished ok run is enough'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000015',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000004',
        'counted_qty', '4'
      ))
    ))$$,
    '22023',
    'item count frequency does not match',
    'a weekly item is refused on a daily count'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000016',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000005',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'item is inactive',
    'an inactive item is refused'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000017',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000007',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'item is inactive',
    'an inactive weekly item on a daily count is reported inactive'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000018',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'unknown stock item',
    'an unknown item is refused when the time is otherwise allowed'
  );

select
  is_empty (
    $$select id from app.stock_counts$$,
    'a refused count does not store a row'
  );

select
  lives_ok (
    $$select app.record_opening_stock(
      '2026-10-22T08:00:00Z',
      jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000001',
          'quantity', '10',
          'unit', 'kg',
          'unit_cost', '80',
          'expected_base_unit', 'kg',
          'expected_factor', '1'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000002',
          'quantity', '4',
          'unit', 'kg',
          'unit_cost', '25',
          'expected_base_unit', 'kg',
          'expected_factor', '1'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000003',
          'quantity', '2',
          'unit', 'kg',
          'unit_cost', '10',
          'expected_base_unit', 'kg',
          'expected_factor', '1'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000004',
          'quantity', '5',
          'unit', 'kg',
          'unit_cost', '20',
          'expected_base_unit', 'kg',
          'expected_factor', '1'
        )
      ),
      'e1900000-0000-4000-8000-000000000001'
    )$$,
    'opening stock is posted before the count'
  );

select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id in (
        'c1900000-0000-4000-8000-000000000001',
        'c1900000-0000-4000-8000-000000000002',
        'c1900000-0000-4000-8000-000000000003',
        'c1900000-0000-4000-8000-000000000004'
      )
      order by item_id$$,
    $$values
      (
        'c1900000-0000-4000-8000-000000000001'::uuid,
        10::numeric(20, 6),
        800.00::numeric(14, 2),
        80::numeric(20, 6)
      ),
      (
        'c1900000-0000-4000-8000-000000000002'::uuid,
        4::numeric(20, 6),
        100.00::numeric(14, 2),
        25::numeric(20, 6)
      ),
      (
        'c1900000-0000-4000-8000-000000000003'::uuid,
        2::numeric(20, 6),
        20.00::numeric(14, 2),
        10::numeric(20, 6)
      ),
      (
        'c1900000-0000-4000-8000-000000000004'::uuid,
        5::numeric(20, 6),
        100.00::numeric(14, 2),
        20::numeric(20, 6)
      )$$,
    'opening stock sets on-hand, value, and average cost'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-00000000001a',
      'frequency', 'daily',
      'counted_at', '2026-10-22T07:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '7'
      ))
    ))$$,
    'P0001',
    'back-dated movement not supported yet',
    'a count earlier than the last movement is refused'
  );

select
  is_empty (
    $$select id from app.stock_movements where movement_type = 'count_adjustment'$$,
    'refused counts post no count adjustment'
  );

-- The inside-shift request id was not stored, so it can succeed at the
-- shift's close. That instant is outside the half-open shift.
select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000010',
      'frequency', 'daily',
      'counted_at', '2026-10-22T09:30:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000003',
        'counted_qty', '2'
      ))
    ))$$,
    'a count exactly at a shift close is allowed when every delta is zero'
  );

select
  is_empty (
    $$select movement.batch_id
      from app.stock_movements movement
      join app.stock_counts counted on counted.id = movement.batch_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000010'$$,
    'an all-zero count id is not a ledger batch id'
  );

select
  results_eq (
    $$select line.counted_qty, line.expected_qty, line.delta_qty,
            line.delta_value, line.movement_id is null
      from app.stock_count_lines line
      join app.stock_counts counted on counted.id = line.count_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000010'$$,
    $$values (
      2::numeric(20, 6),
      2::numeric(20, 6),
      0::numeric(20, 6),
      0.00::numeric(14, 2),
      true
    )$$,
    'a zero line stores the locked on-hand and no movement'
  );

select
  is (
    (
      select
        created_by
      from
        app.stock_counts
      where
        request_id = 'd1900000-0000-4000-8000-000000000010'
    ),
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f'::uuid,
    'the owner is stored as created_by'
  );

-- ============================================================================
-- Shortage, surplus, and a zero line in one batch.
-- ============================================================================
select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000030',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'note', '  جرد الصباح  ',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000001',
          'counted_qty', '7'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000002',
          'counted_qty', '6'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000003',
          'counted_qty', '2'
        )
      )
    ))$$,
    'a daily count with shortage, surplus, and a zero line is saved'
  );

select
  is (
    (
      select
        note
      from
        app.stock_counts
      where
        request_id = 'd1900000-0000-4000-8000-000000000030'
    ),
    'جرد الصباح',
    'the count note is trimmed'
  );

select
  is (
    (
      select
        counted_at
      from
        app.stock_counts
      where
        request_id = 'd1900000-0000-4000-8000-000000000030'
    ),
    '2026-10-22T10:00:00Z'::timestamptz,
    'counted_at is the observation time'
  );

select
  results_eq (
    $$select line.line_no, line.item_id, line.counted_qty, line.expected_qty,
            line.delta_qty, line.delta_value, line.movement_id is null
      from app.stock_count_lines line
      join app.stock_counts counted on counted.id = line.count_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000030'
      order by line.line_no$$,
    $$values
      (
        1,
        'c1900000-0000-4000-8000-000000000001'::uuid,
        7::numeric(20, 6),
        10::numeric(20, 6),
        -3::numeric(20, 6),
        -240.00::numeric(14, 2),
        false
      ),
      (
        2,
        'c1900000-0000-4000-8000-000000000002'::uuid,
        6::numeric(20, 6),
        4::numeric(20, 6),
        2::numeric(20, 6),
        50.00::numeric(14, 2),
        false
      ),
      (
        3,
        'c1900000-0000-4000-8000-000000000003'::uuid,
        2::numeric(20, 6),
        2::numeric(20, 6),
        0::numeric(20, 6),
        0.00::numeric(14, 2),
        true
      )$$,
    'lines store expected on-hand and the signed delta copied from the posting'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.batch_id = (
          select
            id
          from
            app.stock_counts
          where
            request_id = 'd1900000-0000-4000-8000-000000000030'
        )
        and movement.movement_type = 'count_adjustment'
    ),
    2::bigint,
    'the non-zero count id is the one ledger batch'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.batch_id = (
          select
            id
          from
            app.stock_counts
          where
            request_id = 'd1900000-0000-4000-8000-000000000030'
        )
        and movement.movement_type <> 'count_adjustment'
    ),
    0::bigint,
    'the count batch has no cost adjustment'
  );

select
  results_eq (
    $$select movement.item_id, movement.quantity, movement.unit_cost,
            movement.total_cost, movement.shift_id, movement.note
      from app.stock_movements movement
      where movement.batch_id = (
        select id
        from app.stock_counts
        where request_id = 'd1900000-0000-4000-8000-000000000030'
      )
      order by movement.item_id$$,
    $$values
      (
        'c1900000-0000-4000-8000-000000000001'::uuid,
        -3::numeric(20, 6),
        80::numeric(20, 6),
        -240.00::numeric(14, 2),
        null::text,
        null::text
      ),
      (
        'c1900000-0000-4000-8000-000000000002'::uuid,
        2::numeric(20, 6),
        25::numeric(20, 6),
        50.00::numeric(14, 2),
        null::text,
        null::text
      )$$,
    'shortage and surplus post as signed count adjustments with no shift or note'
  );

select
  ok (
    (
      select
        line.movement_id
      from
        app.stock_count_lines line
        join app.stock_counts counted on counted.id = line.count_id
      where
        counted.request_id = 'd1900000-0000-4000-8000-000000000030'
        and line.line_no = 1
    ) = (
      select
        movement.id
      from
        app.stock_movements movement
      where
        movement.batch_id = (
          select
            id
          from
            app.stock_counts
          where
            request_id = 'd1900000-0000-4000-8000-000000000030'
        )
        and movement.item_id = 'c1900000-0000-4000-8000-000000000001'
        and movement.movement_type = 'count_adjustment'
    ),
    'the shortage line points at its count adjustment'
  );

select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id in (
        'c1900000-0000-4000-8000-000000000001',
        'c1900000-0000-4000-8000-000000000002',
        'c1900000-0000-4000-8000-000000000003'
      )
      order by item_id$$,
    $$values
      (
        'c1900000-0000-4000-8000-000000000001'::uuid,
        7::numeric(20, 6),
        560.00::numeric(14, 2),
        80::numeric(20, 6)
      ),
      (
        'c1900000-0000-4000-8000-000000000002'::uuid,
        6::numeric(20, 6),
        150.00::numeric(14, 2),
        25::numeric(20, 6)
      ),
      (
        'c1900000-0000-4000-8000-000000000003'::uuid,
        2::numeric(20, 6),
        20.00::numeric(14, 2),
        10::numeric(20, 6)
      )$$,
    'balances follow the shortage, the surplus, and the unchanged line'
  );

select
  results_eq (
    $$select frequency, note, item_count, shortage_value, surplus_value, has_surplus
      from app.stock_count_history
      where id = (
        select id
        from app.stock_counts
        where request_id = 'd1900000-0000-4000-8000-000000000030'
      )$$,
    $$values (
      'daily'::text,
      'جرد الصباح'::text,
      3,
      240.00::numeric(14, 2),
      50.00::numeric(14, 2),
      true
    )$$,
    'history sums shortage and surplus and flags the surplus'
  );

select
  is (
    app.record_count (
      jsonb_build_object(
        'request_id',
        'd1900000-0000-4000-8000-000000000030',
        'frequency',
        'daily',
        'counted_at',
        '2026-10-22T10:00:00Z',
        'note',
        '  جرد الصباح  ',
        'ignored',
        true,
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            'c1900000-0000-4000-8000-000000000001',
            'counted_qty',
            '7.000000'
          ),
          jsonb_build_object(
            'item_id',
            'c1900000-0000-4000-8000-000000000002',
            'counted_qty',
            '6.000000'
          ),
          jsonb_build_object(
            'item_id',
            'c1900000-0000-4000-8000-000000000003',
            'counted_qty',
            '2.000000'
          )
        )
      )
    ),
    (
      select
        id
      from
        app.stock_counts
      where
        request_id = 'd1900000-0000-4000-8000-000000000030'
    ),
    'the same normalized payload replays the saved id'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_counts
      where
        request_id = 'd1900000-0000-4000-8000-000000000030'
    ),
    1::bigint,
    'replay does not insert another count'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type = 'count_adjustment'
    ),
    2::bigint,
    'replay posts nothing'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000030',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'note', 'جرد الصباح',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000002',
          'counted_qty', '6'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000001',
          'counted_qty', '7'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000003',
          'counted_qty', '2'
        )
      )
    ))$$,
    '22023',
    'request_id already used for a different count',
    'the same request_id with reordered lines is refused'
  );

update app.stock_items
set
  active = false
where
  id = 'c1900000-0000-4000-8000-000000000001';

select
  is (
    app.record_count (
      jsonb_build_object(
        'request_id',
        'd1900000-0000-4000-8000-000000000030',
        'frequency',
        'daily',
        'counted_at',
        '2026-10-22T10:00:00Z',
        'note',
        'جرد الصباح',
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            'c1900000-0000-4000-8000-000000000001',
            'counted_qty',
            '7'
          ),
          jsonb_build_object(
            'item_id',
            'c1900000-0000-4000-8000-000000000002',
            'counted_qty',
            '6'
          ),
          jsonb_build_object(
            'item_id',
            'c1900000-0000-4000-8000-000000000003',
            'counted_qty',
            '2'
          )
        )
      )
    ),
    (
      select
        id
      from
        app.stock_counts
      where
        request_id = 'd1900000-0000-4000-8000-000000000030'
    ),
    'replay returns the saved id without reading the catalog'
  );

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000030',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'note', 'جرد الصباح',
      'lines', jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000001',
          'counted_qty', '8'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000002',
          'counted_qty', '6'
        ),
        jsonb_build_object(
          'item_id', 'c1900000-0000-4000-8000-000000000003',
          'counted_qty', '2'
        )
      )
    ))$$,
    '22023',
    'request_id already used for a different count',
    'a different payload is refused before the inactive-item check'
  );

update app.stock_items
set
  active = true
where
  id = 'c1900000-0000-4000-8000-000000000001';

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type = 'count_adjustment'
    ),
    2::bigint,
    'a refused replay posts nothing'
  );

select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000032',
      'frequency', 'weekly',
      'counted_at', '2026-10-22T10:30:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000004',
        'counted_qty', '4'
      ))
    ))$$,
    'a weekly count of a weekly item is saved'
  );

select
  results_eq (
    $$select line.expected_qty, line.delta_qty, line.delta_value, counted.frequency
      from app.stock_count_lines line
      join app.stock_counts counted on counted.id = line.count_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000032'$$,
    $$values (
      5::numeric(20, 6),
      -1::numeric(20, 6),
      -20.00::numeric(14, 2),
      'weekly'::text
    )$$,
    'the weekly count stores its own frequency and the book shortage'
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = 'c1900000-0000-4000-8000-000000000004'$$,
    $$values (
      4::numeric(20, 6),
      80.00::numeric(14, 2),
      20::numeric(20, 6)
    )$$,
    'the weekly shortage reduces on-hand and keeps the average cost'
  );

select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000033',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:15:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000006',
        'counted_qty', '1'
      ))
    ))$$,
    'a surplus on an item with no opening is saved at zero value'
  );

select
  results_eq (
    $$select line.expected_qty, line.delta_qty, line.delta_value,
            line.movement_id is not null
      from app.stock_count_lines line
      join app.stock_counts counted on counted.id = line.count_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000033'$$,
    $$values (
      0::numeric(20, 6),
      1::numeric(20, 6),
      0.00::numeric(14, 2),
      true
    )$$,
    'a zero-value surplus still points at its movement'
  );

select
  results_eq (
    $$select shortage_value, surplus_value, has_surplus
      from app.stock_count_history
      where id = (
        select id
        from app.stock_counts
        where request_id = 'd1900000-0000-4000-8000-000000000033'
      )$$,
    $$values (
      0.00::numeric(14, 2),
      0.00::numeric(14, 2),
      true
    )$$,
    'history flags a surplus whose value is zero'
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = 'c1900000-0000-4000-8000-000000000006'$$,
    $$values (
      1::numeric(20, 6),
      0.00::numeric(14, 2),
      0::numeric(20, 6)
    )$$,
    'a zero-cost surplus leaves average cost at zero'
  );

select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000031',
      'frequency', 'daily',
      'counted_at', '2026-10-22T11:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000001',
        'counted_qty', '7'
      ))
    ))$$,
    'a later count of the new on-hand is a zero delta'
  );

select
  results_eq (
    $$select line.expected_qty, line.counted_qty, line.delta_qty, line.movement_id is null
      from app.stock_count_lines line
      join app.stock_counts counted on counted.id = line.count_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000031'$$,
    $$values (
      7::numeric(20, 6),
      7::numeric(20, 6),
      0::numeric(20, 6),
      true
    )$$,
    'the later zero count stores the on-hand after the first count'
  );

select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000035',
      'frequency', 'daily',
      'counted_at', '2026-10-22T12:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000002',
        'counted_qty', '6'
      ))
    ))$$,
    'a count after the closed shift is covered when the newest ok run started after that close was recorded'
  );

-- A matching count posts no movement, so the watermark has to move on its own.
-- Opening 10 at 08:00, count 10 at 10:00, then a loss at 09:00 must be refused.
select
  lives_ok (
    $$select app.record_opening_stock(
      '2026-10-22T08:00:00Z',
      jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000008',
        'quantity', '10',
        'unit', 'kg',
        'unit_cost', '40',
        'expected_base_unit', 'kg',
        'expected_factor', '1'
      )),
      'e1900000-0000-4000-8000-000000000002'
    )$$,
    'opening stock for the matching-count item'
  );

select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000050',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000008',
        'counted_qty', '10'
      ))
    ))$$,
    'a count that matches on-hand posts no movement'
  );

select
  results_eq (
    $$select line.delta_qty, line.movement_id is null
      from app.stock_count_lines line
      join app.stock_counts counted on counted.id = line.count_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000050'$$,
    $$values (0::numeric(20, 6), true)$$,
    'the matching count stores a zero delta and no movement'
  );

select
  is (
    (
      select
        last_occurred_at
      from
        app.item_balances
      where
        item_id = 'c1900000-0000-4000-8000-000000000008'
    ),
    '2026-10-22T10:00:00Z'::timestamptz,
    'a zero-delta count moves the watermark to the count time'
  );

select
  throws_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'c1900000-0000-4000-8000-000000000008',
      'movement_type', 'waste',
      'occurred_at', '2026-10-22T09:00:00Z',
      'quantity', '1'
    )))$$,
    'P0001',
    'back-dated movement not supported yet',
    'a loss before a later matching count is refused'
  );

select
  results_eq (
    $$select on_hand_qty, last_occurred_at
      from app.item_balances
      where item_id = 'c1900000-0000-4000-8000-000000000008'$$,
    $$values (10::numeric(20, 6), '2026-10-22T10:00:00Z'::timestamptz)$$,
    'the refused loss leaves the counted quantity and the watermark'
  );

-- An item with no movements still gets a balance row from the lock. Counting
-- it at zero must stamp counted_at so an earlier movement is refused.
select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000051',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:20:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000009',
        'counted_qty', '0'
      ))
    ))$$,
    'a never-moved item can be counted at zero'
  );

select
  is (
    (
      select
        last_occurred_at
      from
        app.item_balances
      where
        item_id = 'c1900000-0000-4000-8000-000000000009'
    ),
    '2026-10-22T10:20:00Z'::timestamptz,
    'counting a never-moved item at zero sets the watermark'
  );

select
  throws_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'c1900000-0000-4000-8000-000000000009',
      'movement_type', 'waste',
      'occurred_at', '2026-10-22T09:00:00Z',
      'quantity', '1'
    )))$$,
    'P0001',
    'back-dated movement not supported yet',
    'a movement before a zero count of a never-moved item is refused'
  );

select
  is_empty (
    $$select id
      from app.stock_movements
      where item_id = 'c1900000-0000-4000-8000-000000000009'$$,
    'the zero count and the refused movement post nothing'
  );

-- A newer ok run with no finish cannot prove coverage, even though it started
-- after the shift close was recorded. Delete it afterwards as the table owner
-- so later counts still see the finished ok run.
reset role;

insert into
  app.pos_sync_runs (mode, status, started_at, finished_at)
select
  'recent',
  'ok',
  shift.close_recorded_at + interval '2 seconds',
  null
from
  app.pos_shifts shift
where
  shift.id = 'shift-count-closed';

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000036',
      'frequency', 'daily',
      'counted_at', '2026-10-22T11:40:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000003',
        'counted_qty', '2'
      ))
    ))$$,
    '22023',
    'sync has not covered this count time',
    'an ok run that started after the close was recorded still fails when it has not finished'
  );

delete from app.pos_sync_runs
where
  status = 'ok'
  and finished_at is null;

set
  local role authenticated;

select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000034',
      'frequency', 'daily',
      'counted_at', '2026-10-22T11:30:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000003',
        'counted_qty', '0'
      ))
    ))$$,
    'counting an item down to zero posts the whole book value'
  );

select
  results_eq (
    $$select line.delta_qty, line.delta_value
      from app.stock_count_lines line
      join app.stock_counts counted on counted.id = line.count_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000034'$$,
    $$values (
      -2::numeric(20, 6),
      -20.00::numeric(14, 2)
    )$$,
    'full depletion stores the whole on-hand value'
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = 'c1900000-0000-4000-8000-000000000003'$$,
    $$values (
      0::numeric(20, 6),
      0.00::numeric(14, 2),
      10::numeric(20, 6)
    )$$,
    'full depletion zeroes quantity and value and keeps the average cost'
  );

select
  throws_ok (
    $$insert into app.stock_counts (
      id, request_id, frequency, counted_at
    ) values (
      gen_random_uuid(),
      gen_random_uuid(),
      'daily',
      '2026-10-22T10:00:00Z'
    )$$,
    '42501',
    null::text,
    'the owner cannot insert a count directly'
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
    $$select app.record_count('{}'::jsonb)$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot record a count'
  );

select
  is_empty (
    $$select id from app.stock_counts$$,
    'a non-owner cannot read counts'
  );

select
  is_empty (
    $$select count_id from app.stock_count_lines$$,
    'a non-owner cannot read count lines'
  );

select
  is_empty (
    $$select id from app.stock_count_history$$,
    'a non-owner cannot read count history'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    $$select app.record_count('{}'::jsonb)$$,
    '42501',
    null::text,
    'anon cannot execute record_count'
  );

select
  throws_ok (
    $$select id from app.stock_counts$$,
    '42501',
    null::text,
    'anon cannot read counts'
  );

select
  throws_ok (
    $$select count_id from app.stock_count_lines$$,
    '42501',
    null::text,
    'anon cannot read count lines'
  );

select
  throws_ok (
    $$select id from app.stock_count_history$$,
    '42501',
    null::text,
    'anon cannot read count history'
  );

reset role;

-- ============================================================================
-- Append-only even for the table owner, then service_role
-- ============================================================================
select
  throws_ok (
    $$update app.stock_counts set note = 'x'$$,
    '55000',
    'app.stock_counts is append-only; UPDATE is not allowed',
    'append-only trigger blocks count updates'
  );

select
  throws_ok (
    $$delete from app.stock_counts$$,
    '55000',
    'app.stock_counts is append-only; DELETE is not allowed',
    'append-only trigger blocks count deletes'
  );

select
  throws_ok (
    $$truncate app.stock_counts cascade$$,
    '55000',
    'app.stock_counts is append-only; TRUNCATE is not allowed',
    'append-only trigger blocks count truncate'
  );

select
  throws_ok (
    $$update app.stock_count_lines set counted_qty = 1$$,
    '55000',
    'app.stock_count_lines is append-only; UPDATE is not allowed',
    'append-only trigger blocks count line updates'
  );

select
  throws_ok (
    $$delete from app.stock_count_lines$$,
    '55000',
    'app.stock_count_lines is append-only; DELETE is not allowed',
    'append-only trigger blocks count line deletes'
  );

select
  throws_ok (
    $$truncate app.stock_count_lines$$,
    '55000',
    'app.stock_count_lines is append-only; TRUNCATE is not allowed',
    'append-only trigger blocks count line truncate'
  );

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );

set
  local role service_role;

-- Item 002's zero count at 12:00 already moved last_occurred_at to 12:00.
-- An equal counted_at is not back-dated. The ok run started after the shift
-- close was recorded, so this count is covered.
select
  lives_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000037',
      'frequency', 'daily',
      'counted_at', '2026-10-22T12:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000002',
        'counted_qty', '6'
      ))
    ))$$,
    'service_role can record a zero count'
  );

select
  ok (
    (
      select
        created_by is null
      from
        app.stock_counts
      where
        request_id = 'd1900000-0000-4000-8000-000000000037'
    ),
    'service_role with no sub stores a null created_by'
  );

select
  is_empty (
    $$select movement.batch_id
      from app.stock_movements movement
      join app.stock_counts counted on counted.id = movement.batch_id
      where counted.request_id = 'd1900000-0000-4000-8000-000000000037'$$,
    'the service_role zero count posts no movement'
  );

reset role;

-- The newest ok run now starts before the close was recorded. A later failed
-- run starts after that stamp. Coverage follows the newest ok row, so the
-- count is refused. The failed row stays so the next test still has no ok run.
update app.pos_sync_runs
set
  started_at = (
    select
      pg_catalog.max (close_recorded_at) - interval '1 second'
    from
      app.pos_shifts
  )
where
  status = 'ok';

insert into
  app.pos_sync_runs (mode, status, started_at, finished_at, error)
select
  'recent',
  'failed',
  shift.close_recorded_at + interval '1 minute',
  shift.close_recorded_at + interval '2 minutes',
  'synthetic failed run'
from
  app.pos_shifts shift
where
  shift.id = 'shift-count-closed';

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000056',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'sync has not covered this count time',
    'a later failed run does not cover a count when the newest ok run started before the close was recorded'
  );

delete from app.pos_sync_runs
where
  status = 'ok';

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'd1900000-0000-4000-8000-000000000039',
      'frequency', 'daily',
      'counted_at', '2026-10-22T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'c1900000-0000-4000-8000-000000000099',
        'counted_qty', '1'
      ))
    ))$$,
    '22023',
    'sync has not covered this count time',
    'a count is refused when no ok sync run exists'
  );

select
  *
from
  finish ();

rollback;
