begin;

select
  plan (221);

-- Users and the single owner. Same fixture ids as the other pgTAP files.
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
-- Schema, grants, and the rounding helpers
-- ============================================================================
select
  has_table (
    'app',
    'expense_categories',
    'app.expense_categories exists'
  );

select
  has_table (
    'app',
    'expense_entries',
    'app.expense_entries exists'
  );

select
  has_table (
    'app',
    'month_expense_status',
    'app.month_expense_status exists'
  );

select
  has_view (
    'app',
    'expense_lines',
    'app.expense_lines exists'
  );

select
  has_function (
    'app',
    'assert_expense_write_allowed',
    '{}'::text[],
    'app.assert_expense_write_allowed() exists'
  );

select
  has_function (
    'app',
    'add_expense_category',
    array['text', 'text'],
    'app.add_expense_category exists'
  );

select
  has_function (
    'app',
    'rename_expense_category',
    array['uuid', 'text'],
    'app.rename_expense_category exists'
  );

select
  has_function (
    'app',
    'set_expense_category_active',
    array['uuid', 'boolean'],
    'app.set_expense_category_active exists'
  );

select
  has_function (
    'app',
    'add_expense_entry',
    array[
      'uuid',
      'numeric',
      'date',
      'date',
      'date',
      'boolean',
      'text',
      'numeric',
      'numeric',
      'text',
      'uuid'
    ],
    'app.add_expense_entry exists'
  );

select
  has_function (
    'app',
    'void_expense_entry',
    array['uuid', 'text', 'uuid'],
    'app.void_expense_entry exists'
  );

select
  has_function (
    'app',
    'set_month_expense_complete',
    array['date', 'boolean'],
    'app.set_month_expense_complete exists'
  );

select
  has_function (
    'app',
    'expense_day_share',
    array['numeric', 'integer', 'integer'],
    'app.expense_day_share exists'
  );

select
  has_function (
    'app',
    'expense_effective',
    '{}'::text[],
    'app.expense_effective() exists'
  );

select
  has_function (
    'app',
    'expense_daily',
    array['date', 'date'],
    'app.expense_daily exists'
  );

select
  has_function (
    'app',
    'expense_month_check',
    array['date'],
    'app.expense_month_check exists'
  );

select
  ok (
    (
      select
        p.prosecdef
        and p.proconfig @> array['search_path=""']::text[]
      from
        pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'add_expense_entry'
    ),
    'add_expense_entry is security definer with an empty search_path'
  );

select
  ok (
    (
      select
        p.prosecdef
        and p.proconfig @> array['search_path=""']::text[]
      from
        pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'assert_expense_write_allowed'
    ),
    'assert_expense_write_allowed is security definer with an empty search_path'
  );

select
  ok (
    (
      select
        not p.prosecdef
        and p.proconfig @> array['search_path=""']::text[]
      from
        pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'expense_daily'
    ),
    'expense_daily is security invoker with an empty search_path'
  );

select
  ok (
    (
      select
        not p.prosecdef
        and p.proconfig @> array['search_path=""']::text[]
      from
        pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = 'expense_month_check'
    ),
    'expense_month_check is security invoker with an empty search_path'
  );

select
  ok (
    position(
      'pg_advisory' in pg_get_functiondef(
        'app.assert_expense_write_allowed()'::regprocedure
      )
    ) = 0,
    'expense writes do not take an advisory lock'
  );

select
  ok (
    position(
      'pos_shift' in pg_get_functiondef('app.expense_daily(date,date)'::regprocedure)
    ) = 0,
    'allocation does not read POS shifts'
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
        and c.relname = 'expense_lines'
        and (
          opt = 'security_invoker=true'
          or opt = 'security_invoker=on'
        )
    ),
    'expense_lines is security invoker'
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
        and c.relname in (
          'expense_categories',
          'expense_entries',
          'month_expense_status'
        )
        and c.relrowsecurity
    ),
    3::bigint,
    'RLS is enabled on the three expense tables'
  );

select
  results_eq (
    $$select name from app.expense_categories order by name$$,
    $$select name
      from (
        values
          ('أجر يومي'::text),
          ('أجر طيارين'::text),
          ('إهلاك'::text),
          ('إيجار'::text),
          ('فوائد'::text),
          ('غاز'::text),
          ('مرتبات ثابتة'::text),
          ('نقل'::text)
      ) as seed (name)
      order by name$$,
    'migration seeds eight category labels and no amounts'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'expense_entries'
        and grantee = 'authenticated'
        and privilege_type in ('INSERT', 'SELECT', 'UPDATE', 'DELETE')
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select expense entries'
  );

select
  is (
    (
      select
        count(*)
      from
        information_schema.table_privileges
      where
        table_schema = 'app'
        and table_name = 'expense_entries'
        and grantee = 'anon'
    ),
    0::bigint,
    'anon has no privileges on expense entries'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'expense_categories'
        and grantee = 'authenticated'
        and privilege_type in ('INSERT', 'SELECT', 'UPDATE', 'DELETE')
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select expense categories'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'month_expense_status'
        and grantee = 'authenticated'
        and privilege_type in ('INSERT', 'SELECT', 'UPDATE', 'DELETE')
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select month expense status'
  );

select
  results_eq (
    $$select pg_catalog.btrim(privilege_type::text) collate "default"
      from information_schema.table_privileges
      where table_schema = 'app'
        and table_name = 'expense_lines'
        and grantee = 'authenticated'
        and privilege_type in ('INSERT', 'SELECT', 'UPDATE', 'DELETE')
      order by 1$$,
    $$values ('SELECT'::text)$$,
    'authenticated can only select expense lines'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.add_expense_entry(uuid,numeric,date,date,date,boolean,text,numeric,numeric,text,uuid)',
      'execute'
    ),
    true,
    'authenticated can execute add_expense_entry'
  );

select
  is (
    has_function_privilege(
      'anon',
      'app.add_expense_entry(uuid,numeric,date,date,date,boolean,text,numeric,numeric,text,uuid)',
      'execute'
    ),
    false,
    'anon cannot execute add_expense_entry'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.assert_expense_write_allowed()',
      'execute'
    ),
    false,
    'authenticated cannot execute the internal assert'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.expense_daily(date,date)',
      'execute'
    ),
    true,
    'authenticated can execute expense_daily'
  );

select
  has_trigger (
    'app',
    'expense_entries',
    'trg_expense_entries_no_update_delete',
    'expense entries reject update and delete'
  );

select
  has_trigger (
    'app',
    'expense_entries',
    'trg_expense_entries_validate',
    'expense entries are validated on insert'
  );

select
  has_trigger (
    'app',
    'expense_categories',
    'trg_expense_categories_freeze',
    'category kind is frozen'
  );

select
  has_function (
    'app',
    'text_has_long_digit_run',
    array['text'],
    'app.text_has_long_digit_run exists'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.text_has_long_digit_run(text)',
      'execute'
    ),
    false,
    'authenticated cannot execute the phone-digit helper'
  );

-- ============================================================================
-- Owner
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

select
  is (
    (
      select
        count(*)
      from
        app.expense_categories
    ),
    8::bigint,
    'owner can select the seeded categories'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      0,
      '2026-04-01',
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000001'
    )$$,
    '22023'::char(5),
    'amount must be greater than zero',
    'a fixed amount of zero is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      -5,
      '2026-04-01',
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000002'
    )$$,
    '22023'::char(5),
    'amount must be greater than zero',
    'a negative amount is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      1.005,
      '2026-04-01',
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000003'
    )$$,
    '22023'::char(5),
    'amount must have at most 2 decimal places',
    'a third decimal place is rejected before the column rounds it'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      10,
      null,
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000004'
    )$$,
    '22023'::char(5),
    'period month is required',
    'fixed monthly requires a period month'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'فوائد'),
      10,
      null,
      '2026-04-01',
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000005'
    )$$,
    '22023'::char(5),
    'period month is required',
    'interest requires a period month'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إهلاك'),
      10,
      '2026-04-15',
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000006'
    )$$,
    '22023'::char(5),
    'period month must be the first day of the month',
    'depreciation period must be the first of the month'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      10,
      '2026-04-01',
      '2026-04-02',
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000007'
    )$$,
    '22023'::char(5),
    'expense date must be empty for a monthly expense',
    'a monthly expense cannot also have an expense date'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      10,
      '1800-01-01',
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000008'
    )$$,
    '22023'::char(5),
    'date is out of range',
    'a period outside 1990-2100 is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      10,
      null,
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000009'
    )$$,
    '22023'::char(5),
    'expense date is required',
    'a daily expense requires a date'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      10,
      '2026-04-01',
      '2026-04-02',
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000010'
    )$$,
    '22023'::char(5),
    'period month must be empty for a daily expense',
    'a daily expense cannot also have a period month'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      1,
      null,
      '2026-04-15',
      null,
      false,
      null,
      null,
      30,
      null,
      'a17e0000-0000-4000-8000-000000000011'
    )$$,
    '22023'::char(5),
    'hours are required for driver pay',
    'driver pay requires hours'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      1,
      null,
      '2026-04-15',
      null,
      false,
      null,
      5,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000012'
    )$$,
    '22023'::char(5),
    'hourly rate is required for driver pay',
    'driver pay requires an hourly rate'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      1,
      null,
      '2026-04-15',
      null,
      false,
      null,
      0,
      30,
      null,
      'a17e0000-0000-4000-8000-000000000013'
    )$$,
    '22023'::char(5),
    'hours must be greater than zero',
    'zero hours are rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      1,
      null,
      '2026-04-15',
      null,
      false,
      null,
      1.005,
      30,
      null,
      'a17e0000-0000-4000-8000-000000000014'
    )$$,
    '22023'::char(5),
    'hours must have at most 2 decimal places',
    'driver hours keep at most two decimal places'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      null,
      null,
      '2026-04-15',
      null,
      false,
      null,
      1,
      30,
      '01001234567',
      'a17e0000-0000-4000-8000-000000000015'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a driver label with eight or more digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      10,
      null,
      '2026-04-01',
      null,
      false,
      repeat('م', 501),
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000016'
    )$$,
    '22023'::char(5),
    'note is too long',
    'a note over 500 characters is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      null,
      null,
      '2026-04-15',
      null,
      false,
      null,
      1,
      30,
      repeat('ا', 41),
      'a17e0000-0000-4000-8000-000000000017'
    )$$,
    '22023'::char(5),
    'driver label is too long',
    'a driver label over 40 characters is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      '00000000-0000-4000-8000-000000000099',
      10,
      null,
      '2026-04-01',
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000018'
    )$$,
    '22023'::char(5),
    'unknown expense category',
    'an unknown category is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      10,
      null,
      '2026-04-01',
      null,
      null,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000019'
    )$$,
    '22023'::char(5),
    'is_estimate is required',
    'is_estimate is required'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      '00000000-0000-4000-8000-000000000099',
      'سبب',
      'a17e0000-0000-4000-8000-000000000041'
    )$$,
    '22023'::char(5),
    'unknown expense entry',
    'voiding a missing entry is rejected'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_categories limit 1),
      '   ',
      'a17e0000-0000-4000-8000-000000000042'
    )$$,
    '22023'::char(5),
    'void reason is required',
    'a blank void reason is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_category('   ', 'daily')$$,
    '22023'::char(5),
    'expense category name is required',
    'a blank category name is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_category('تصنيف', 'loan')$$,
    '22023'::char(5),
    'expense category kind is not allowed',
    'an unknown category kind is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_category('إيجار', 'fixed_monthly')$$,
    '23505'::char(5),
    null::text,
    'category names are unique'
  );

select
  throws_ok (
    $$select app.set_month_expense_complete('2026-04-15', true)$$,
    '22023'::char(5),
    'month must be the first day of the month',
    'month status requires the first of the month'
  );

select
  throws_ok (
    $$select * from app.expense_daily('2026-04-02', '2026-04-01')$$,
    '22023'::char(5),
    'date range is invalid',
    'a reversed date range is rejected'
  );

select
  throws_ok (
    $$select * from app.expense_daily('2026-01-01', '2027-02-01')$$,
    '22023'::char(5),
    'date range is too long',
    'a range over 366 days is rejected'
  );

-- 1000.00 does not divide evenly. 2026-02 has 28 days, 2026-04 has 30, 2026-01 has 31.
select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      1000.00,
      '2026-01-01',
      null,
      null,
      false,
      'rent-jan',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000020'
    )$$,
    'owner posts January rent'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      1000.00,
      '2026-02-01',
      null,
      null,
      false,
      'rent-feb',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000021'
    )$$,
    'owner posts February rent'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      1000.00,
      '2026-04-01',
      null,
      null,
      false,
      'rent-apr',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000022'
    )$$,
    'owner posts April rent'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-04-01', '2026-04-01')
    ),
    33.34::numeric,
    'April day 1 gets 33.34'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-04-10', '2026-04-10')
    ),
    33.34::numeric,
    'April day 10 still gets 33.34'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-04-11', '2026-04-11')
    ),
    33.33::numeric,
    'April day 11 gets 33.33'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-04-30', '2026-04-30')
    ),
    33.33::numeric,
    'a one-day query keeps that day share and does not re-split 1000'
  );

select
  is (
    (
      select
        sum(fixed_share)
      from
        app.expense_daily ('2026-04-01', '2026-04-30')
    ),
    1000.00::numeric,
    'April fixed shares sum to 1000.00'
  );

select
  is (
    (
      select
        count(*)
      from
        app.expense_daily ('2026-04-01', '2026-04-30')
    ),
    30::bigint,
    'April allocates 30 days'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-02-01', '2026-02-01')
    ),
    35.72::numeric,
    'February day 1 gets 35.72'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-02-12', '2026-02-12')
    ),
    35.72::numeric,
    'February day 12 still gets 35.72'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-02-13', '2026-02-13')
    ),
    35.71::numeric,
    'February day 13 gets 35.71'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-02-28', '2026-02-28')
    ),
    35.71::numeric,
    'February day 28 gets 35.71'
  );

select
  is (
    (
      select
        sum(fixed_share)
      from
        app.expense_daily ('2026-02-01', '2026-02-28')
    ),
    1000.00::numeric,
    'February fixed shares sum to 1000.00'
  );

select
  is (
    (
      select
        count(*)
      from
        app.expense_daily ('2026-02-01', '2026-02-28')
    ),
    28::bigint,
    'February 2026 allocates 28 days'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-01-01', '2026-01-01')
    ),
    32.26::numeric,
    'January day 1 gets 32.26'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-01-25', '2026-01-25')
    ),
    32.26::numeric,
    'January day 25 still gets 32.26'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-01-26', '2026-01-26')
    ),
    32.25::numeric,
    'January day 26 gets 32.25'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-01-31', '2026-01-31')
    ),
    32.25::numeric,
    'January day 31 gets 32.25'
  );

select
  is (
    (
      select
        sum(fixed_share)
      from
        app.expense_daily ('2026-01-01', '2026-01-31')
    ),
    1000.00::numeric,
    'January fixed shares sum to 1000.00'
  );

select
  is (
    (
      select
        count(*)
      from
        app.expense_daily ('2026-01-01', '2026-01-31')
    ),
    31::bigint,
    'January allocates 31 days'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_shifts
      where
        (opened_at at time zone 'Africa/Cairo')::date = date '2026-04-02'
    ),
    0::bigint,
    '2026-04-02 has no POS shift'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-04-02', '2026-04-02')
    ),
    33.34::numeric,
    'a day with no shift still gets its fixed share'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'فوائد'),
      100.00,
      '2026-04-01',
      null,
      null,
      false,
      'interest-apr',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000023'
    )$$,
    'owner posts April interest'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إهلاك'),
      10.00,
      '2026-04-01',
      null,
      null,
      false,
      'depr-apr',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000024'
    )$$,
    'owner posts April depreciation'
  );

select
  is (
    (
      select
        interest
      from
        app.expense_daily ('2026-04-01', '2026-04-01')
    ),
    3.34::numeric,
    'interest is spread into its own column'
  );

select
  is (
    (
      select
        interest
      from
        app.expense_daily ('2026-04-11', '2026-04-11')
    ),
    3.33::numeric,
    'later interest days get the base piaster'
  );

select
  is (
    (
      select
        sum(interest)
      from
        app.expense_daily ('2026-04-01', '2026-04-30')
    ),
    100.00::numeric,
    'April interest shares sum to 100.00'
  );

select
  is (
    (
      select
        depreciation
      from
        app.expense_daily ('2026-04-01', '2026-04-01')
    ),
    0.34::numeric,
    'depreciation is spread into its own column'
  );

select
  is (
    (
      select
        sum(depreciation)
      from
        app.expense_daily ('2026-04-01', '2026-04-30')
    ),
    10.00::numeric,
    'April depreciation shares sum to 10.00'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-04-01', '2026-04-01')
    ),
    33.34::numeric,
    'interest and depreciation do not change the fixed share'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      1.00,
      null,
      '2026-04-15',
      '2026-04-20',
      false,
      'driver-165',
      5.50,
      30.00,
      '  طيار اختبار  ',
      'a17e0000-0000-4000-8000-000000000025'
    )$$,
    'owner posts driver hours and a wrong client amount'
  );

select
  is (
    (
      select
        amount
      from
        app.expense_entries
      where
        note = 'driver-165'
    ),
    165.00::numeric,
    'driver amount is hours times rate, not the client amount'
  );

select
  is (
    (
      select
        driver_label
      from
        app.expense_entries
      where
        note = 'driver-165'
    ),
    'طيار اختبار',
    'a short driver label is stored trimmed'
  );

select
  results_eq (
    $$select expense_date, paid_on
      from app.expense_entries
      where note = 'driver-165'$$,
    $$select date '2026-04-15', date '2026-04-20'$$,
    'payment date is stored apart from the expense date'
  );

select
  is (
    (
      select
        driver_total
      from
        app.expense_daily ('2026-04-15', '2026-04-15')
    ),
    165.00::numeric,
    'driver pay counts on its own day'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      9.99,
      null,
      '2026-04-16',
      null,
      false,
      'driver-round',
      1.15,
      0.10,
      null,
      'a17e0000-0000-4000-8000-000000000026'
    )$$,
    'owner posts a driver amount that rounds half away from zero'
  );

select
  is (
    (
      select
        amount
      from
        app.expense_entries
      where
        note = 'driver-round'
    ),
    0.12::numeric,
    '1.15 hours times 0.10 rounds to 0.12'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      7.50,
      null,
      '2026-04-15',
      null,
      false,
      'daily-750',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000027'
    )$$,
    'owner posts a daily gas expense'
  );

select
  is (
    (
      select
        daily_total
      from
        app.expense_daily ('2026-04-15', '2026-04-15')
    ),
    7.50::numeric,
    'daily expenses count on their own day'
  );

select
  is (
    (
      select
        daily_total
      from
        app.expense_daily ('2026-04-14', '2026-04-14')
    ),
    0.00::numeric,
    'a day with no daily expense stays at zero'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      40.00,
      null,
      '2026-04-03',
      null,
      true,
      'gas-est',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000028'
    )$$,
    'owner posts a gas estimate'
  );

select
  is (
    (
      select
        daily_total
      from
        app.expense_daily ('2026-04-03', '2026-04-03')
    ),
    40.00::numeric,
    'an estimate counts while no invoice exists'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      55.00,
      null,
      '2026-04-03',
      null,
      false,
      'gas-act',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000029'
    )$$,
    'owner posts the gas invoice'
  );

select
  is (
    (
      select
        daily_total
      from
        app.expense_daily ('2026-04-03', '2026-04-03')
    ),
    55.00::numeric,
    'the invoice replaces the estimate for the same category and date'
  );

select
  is (
    (
      select
        void_id is null
        and is_estimate
      from
        app.expense_lines
      where
        note = 'gas-est'
    ),
    true,
    'the estimate is superseded, not voided'
  );

select
  results_eq (
    $$select days_total, entries_total, balanced
      from app.expense_month_check('2026-04-01')$$,
    $$select 1337.62::numeric, 1337.62::numeric, true$$,
    'April day totals equal the effective entries'
  );

select
  lives_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'gas-act'),
      'فاتورة غلط',
      'a17e0000-0000-4000-8000-000000000043'
    )$$,
    'owner voids the gas invoice'
  );

select
  is (
    (
      select
        daily_total
      from
        app.expense_daily ('2026-04-03', '2026-04-03')
    ),
    40.00::numeric,
    'voiding the invoice makes the estimate count again'
  );

select
  is (
    (
      select
        void_reason
      from
        app.expense_lines
      where
        note = 'gas-act'
    ),
    'فاتورة غلط',
    'the list view shows the void reason'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'gas-act'),
      'تاني',
      'a17e0000-0000-4000-8000-000000000044'
    )$$,
    '22023'::char(5),
    'expense entry is already voided',
    'an entry cannot be voided twice'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (
        select
          void_row.id
        from
          app.expense_entries void_row
        where
          void_row.voids_id = (
            select
              id
            from
              app.expense_entries
            where
              note = 'gas-act'
          )
      ),
      'لا',
      'a17e0000-0000-4000-8000-000000000045'
    )$$,
    '22023'::char(5),
    'cannot void a void',
    'a void marker cannot itself be voided'
  );

select
  lives_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'gas-est'),
      'التقدير خلص',
      'a17e0000-0000-4000-8000-000000000046'
    )$$,
    'owner voids the gas estimate'
  );

select
  is (
    (
      select
        daily_total
      from
        app.expense_daily ('2026-04-03', '2026-04-03')
    ),
    0.00::numeric,
    'voiding the estimate removes it from the day'
  );

select
  is (
    (
      select
        balanced
      from
        app.expense_month_check ('2026-04-01')
    ),
    true,
    'April still balances after voids'
  );

select
  lives_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'rent-feb'),
      'إيجار اتسجل غلط',
      'a17e0000-0000-4000-8000-000000000047'
    )$$,
    'owner voids February rent'
  );

select
  is (
    (
      select
        sum(fixed_share)
      from
        app.expense_daily ('2026-02-01', '2026-02-28')
    ),
    0.00::numeric,
    'voiding February rent removes it from every day'
  );

select
  is (
    (
      select
        balanced
      from
        app.expense_month_check ('2026-02-01')
    ),
    true,
    'February balances after the void'
  );

-- Two actuals of the same category both count. Each is split, then added.
select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      1000.00,
      '2026-08-01',
      null,
      null,
      false,
      'rent-aug-a',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000030'
    )$$,
    'owner posts the first August rent'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      1000.00,
      '2026-08-01',
      null,
      null,
      false,
      'rent-aug-b',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000031'
    )$$,
    'owner posts the second August rent'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2026-08-01', '2026-08-01')
    ),
    64.52::numeric,
    'two rents are split separately and then added'
  );

select
  is (
    (
      select
        sum(fixed_share)
      from
        app.expense_daily ('2026-08-01', '2026-08-31')
    ),
    2000.00::numeric,
    'August fixed shares sum to both rents'
  );

-- An actual replaces estimates of the same category and period only.
select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      200.00,
      '2026-05-01',
      null,
      null,
      true,
      'may-rent-est',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000032'
    )$$,
    'owner posts a May rent estimate'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'فوائد'),
      50.00,
      '2026-05-01',
      null,
      null,
      false,
      'may-interest',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000033'
    )$$,
    'owner posts May interest'
  );

select
  is (
    (
      select
        sum(total)
      from
        app.expense_daily ('2026-05-01', '2026-05-31')
    ),
    250.00::numeric,
    'a different category does not supersede the rent estimate'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      180.00,
      '2026-05-01',
      null,
      null,
      false,
      'may-rent-act',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000034'
    )$$,
    'owner posts the May rent invoice'
  );

select
  is (
    (
      select
        sum(total)
      from
        app.expense_daily ('2026-05-01', '2026-05-31')
    ),
    230.00::numeric,
    'the May invoice replaces only the rent estimate'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      1,
      null,
      '2026-06-01',
      null,
      true,
      'jun-drv-est',
      2,
      10,
      'طيار تقدير',
      'a17e0000-0000-4000-8000-000000000035'
    )$$,
    'owner posts a June driver estimate'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      1,
      null,
      '2026-06-01',
      null,
      false,
      'jun-drv-act',
      3,
      10,
      'طيار فاتورة',
      'a17e0000-0000-4000-8000-000000000036'
    )$$,
    'owner posts a June driver invoice'
  );

select
  is (
    (
      select
        driver_total
      from
        app.expense_daily ('2026-06-01', '2026-06-01')
    ),
    30.00::numeric,
    'one driver invoice supersedes the estimate for that category and date'
  );

select
  lives_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'jun-drv-act'),
      'الساعات غلط',
      'a17e0000-0000-4000-8000-000000000048'
    )$$,
    'owner voids the June driver invoice'
  );

select
  is (
    (
      select
        driver_total
      from
        app.expense_daily ('2026-06-01', '2026-06-01')
    ),
    20.00::numeric,
    'voiding the driver invoice restores the estimate'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1.25,
      null,
      '2026-03-01',
      '2026-03-05',
      false,
      '   ',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000037'
    )$$,
    'owner posts transport with a blank note'
  );

select
  results_eq (
    $$select note is null, paid_on, amount
      from app.expense_entries
      where expense_date = '2026-03-01'$$,
    $$select true, date '2026-03-05', 1.25::numeric$$,
    'a blank note is stored as null and the payment date is kept'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      2,
      null,
      '2026-03-02',
      null,
      false,
      'فاتورة 12345678',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000038'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with eight digits is rejected'
  );

select
  lives_ok (
    $$select app.add_expense_category('تصنيف اختبار', 'daily')$$,
    'owner adds a category'
  );

select
  lives_ok (
    $$select app.rename_expense_category(
      (select id from app.expense_categories where name = 'تصنيف اختبار'),
      'تصنيف معدل'
    )$$,
    'owner renames a category'
  );

select
  is (
    (
      select
        count(*)
      from
        app.expense_categories
      where
        name = 'تصنيف معدل'
        and kind = 'daily'
    ),
    1::bigint,
    'rename keeps the category kind'
  );

select
  lives_ok (
    $$select app.set_expense_category_active(
      (select id from app.expense_categories where name = 'إيجار'),
      false
    )$$,
    'owner deactivates rent'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      10,
      '2026-09-01',
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000039'
    )$$,
    '22023'::char(5),
    'expense category is inactive',
    'an inactive category rejects new entries'
  );

select
  is (
    (
      select
        sum(fixed_share)
      from
        app.expense_daily ('2026-04-01', '2026-04-30')
    ),
    1000.00::numeric,
    'deactivating a category does not drop entries already posted'
  );

select
  lives_ok (
    $$select app.set_expense_category_active(
      (select id from app.expense_categories where name = 'إيجار'),
      true
    )$$,
    'owner reactivates rent'
  );

select
  is (
    (
      select
        count(*)
      from
        app.month_expense_status
      where
        month = '2026-04-01'
    ),
    0::bigint,
    'a month starts unmarked'
  );

select
  lives_ok (
    $$select app.set_month_expense_complete('2026-04-01', true)$$,
    'owner marks April complete'
  );

select
  results_eq (
    $$select complete, confirmed_by, confirmed_at is not null
      from app.month_expense_status
      where month = '2026-04-01'$$,
    $$select true, 'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f'::uuid, true$$,
    'marking the month stores who confirmed it'
  );

select
  lives_ok (
    $$select app.set_month_expense_complete('2026-04-01', false)$$,
    'owner unmarks April'
  );

select
  results_eq (
    $$select complete, confirmed_at is null, confirmed_by is null
      from app.month_expense_status
      where month = '2026-04-01'$$,
    $$select false, true, true$$,
    'unmarking clears the confirmation'
  );

select
  throws_ok (
    $$insert into app.expense_entries (category_id, amount, is_estimate)
      values (
        (select id from app.expense_categories where name = 'غاز'),
        1,
        false
      )$$,
    '42501'::char(5),
    null::text,
    'owner cannot insert expenses directly'
  );

select
  throws_ok (
    $$update app.expense_entries set note = 'tampered'$$,
    '42501'::char(5),
    null::text,
    'owner cannot update expenses'
  );

select
  throws_ok (
    $$delete from app.expense_entries$$,
    '42501'::char(5),
    null::text,
    'owner cannot delete expenses'
  );

select
  throws_ok (
    $$update app.expense_categories set kind = 'daily' where name = 'إيجار'$$,
    '42501'::char(5),
    null::text,
    'owner cannot update categories directly'
  );

reset role;

select
  throws_ok (
    $$update app.expense_entries set note = 'tampered'$$,
    '55000'::char(5),
    'app.expense_entries is append-only; UPDATE is not allowed',
    'the append-only trigger blocks update'
  );

select
  throws_ok (
    $$delete from app.expense_entries$$,
    '55000'::char(5),
    'app.expense_entries is append-only; DELETE is not allowed',
    'the append-only trigger blocks delete'
  );

select
  throws_ok (
    $$delete from app.expense_categories$$,
    '55000'::char(5),
    'expense categories are not deleted',
    'categories are deactivated, not deleted'
  );

select
  throws_ok (
    $$update app.expense_categories set kind = 'daily' where name = 'إيجار'$$,
    '55000'::char(5),
    'expense category kind is fixed',
    'category kind cannot change'
  );

-- ============================================================================
-- Lost replies and phone-like free text
-- ============================================================================
select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      1000.00,
      '2026-09-01',
      null,
      null,
      false,
      'replay-rent',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009001'
    )$$,
    'owner posts a rent that can be retried'
  );

select
  is (
    (
      select
        app.add_expense_entry (
          (
            select
              id
            from
              app.expense_categories
            where
              name = 'إيجار'
          ),
          1000.00,
          '2026-09-01',
          null,
          null,
          false,
          'replay-rent',
          null,
          null,
          null,
          'a17e0000-0000-4000-8000-000000009001'
        )
    ),
    (
      select
        id
      from
        app.expense_entries
      where
        note = 'replay-rent'
    ),
    'the same request returns the saved expense'
  );

select
  is (
    (
      select
        count(*)
      from
        app.expense_entries
      where
        note = 'replay-rent'
    ),
    1::bigint,
    'a replay does not insert a second expense'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      1001.00,
      '2026-09-01',
      null,
      null,
      false,
      'replay-rent',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009001'
    )$$,
    '22023'::char(5),
    'request_id already used for a different expense',
    'a request id cannot post a different expense'
  );

select
  is (
    (
      select
        app.add_expense_entry (
          (
            select
              id
            from
              app.expense_categories
            where
              name = 'أجر طيارين'
          ),
          9.99,
          null,
          '2026-04-15',
          '2026-04-20',
          false,
          'driver-165',
          5.50,
          30.00,
          '  طيار اختبار  ',
          'a17e0000-0000-4000-8000-000000000025'
        )
    ),
    (
      select
        id
      from
        app.expense_entries
      where
        note = 'driver-165'
    ),
    'a driver replay ignores the discarded client amount'
  );

select
  is (
    (
      select
        count(*)
      from
        app.expense_entries
      where
        note = 'driver-165'
    ),
    1::bigint,
    'a driver replay does not insert a second row'
  );

select
  lives_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'replay-rent'),
      'تكرار',
      'a17e0000-0000-4000-8000-000000009002'
    )$$,
    'owner voids the replayed rent'
  );

select
  is (
    (
      select
        app.void_expense_entry (
          (
            select
              id
            from
              app.expense_entries
            where
              note = 'replay-rent'
          ),
          'تكرار',
          'a17e0000-0000-4000-8000-000000009002'
        )
    ),
    (
      select
        id
      from
        app.expense_entries
      where
        voids_id = (
          select
            id
          from
            app.expense_entries
          where
            note = 'replay-rent'
        )
    ),
    'the same void request returns the existing void'
  );

select
  is (
    (
      select
        count(*)
      from
        app.expense_entries
      where
        voids_id = (
          select
            id
          from
            app.expense_entries
          where
            note = 'replay-rent'
        )
    ),
    1::bigint,
    'a void replay does not insert a second void'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'replay-rent'),
      'سبب تاني',
      'a17e0000-0000-4000-8000-000000009002'
    )$$,
    '22023'::char(5),
    'request_id already used for a different expense',
    'a void request id cannot change the reason'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      10.00,
      '2026-09-01',
      null,
      null,
      false,
      'replay-other',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009003'
    )$$,
    'owner posts a second September rent'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'replay-other'),
      'تكرار',
      'a17e0000-0000-4000-8000-000000009002'
    )$$,
    '22023'::char(5),
    'request_id already used for a different expense',
    'a void request id cannot void a different entry'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '010 0000 0000',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009011'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with spaced digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '٠١٠٠٠٠٠٠٠٠٠',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009012'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with Arabic-Indic digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '۰۱۰۰۰۰۰۰۰۰۰',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009013'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with Extended Arabic-Indic digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '010-0000-0000',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009014'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with dashed digits is rejected'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'replay-other'),
      '010.0000.0000',
      'a17e0000-0000-4000-8000-000000009015'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a void reason with dotted digits is rejected'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'replay-other'),
      '٠١٠ ٠٠٠٠ ٠٠٠٠',
      'a17e0000-0000-4000-8000-000000009016'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a void reason with spaced Arabic-Indic digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_category('تليفون ٠١٠٠٠٠٠٠٠٠٠', 'daily')$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a category name with Arabic-Indic digits is rejected'
  );

select
  throws_ok (
    $$select app.rename_expense_category(
      (select id from app.expense_categories where name = 'نقل'),
      'نقل ۰۱۰۰۰۰۰۰۰۰۰'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a renamed category with Extended Arabic-Indic digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      null,
      null,
      '2026-11-02',
      null,
      false,
      null,
      1,
      30,
      '۰۱۰۰۰۰۰۰۰۰۰',
      'a17e0000-0000-4000-8000-000000009017'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a driver label with Extended Arabic-Indic digits is rejected'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-03',
      null,
      false,
      'فاتورة 1234567',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009018'
    )$$,
    'a note with seven digits is stored'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-04',
      null,
      false,
      'رقم 1234x5678',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009019'
    )$$,
    'letters keep digit runs separate'
  );

-- Fullwidth (U+FF10) and zero-width (U+200B) on every free-text field.
-- Other Nd scripts and the separator set are checked on notes.
select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '0100000' || chr(65296) || '000',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009020'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with a fullwidth digit is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '0100' || chr(8203) || '0000000',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009021'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with a zero-width space between digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      repeat(chr(2406), 8),
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009022'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with Devanagari digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      repeat(chr(2534), 8),
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009023'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with Bengali digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      repeat(chr(120782), 8),
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009024'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with mathematical bold digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '0123' || chr(2406) || chr(2407) || chr(2534) || chr(2535),
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009025'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a note with mixed decimal digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '0' || chr(9) || '1' || chr(160) || '2' || chr(8203) || '3' || chr(8239) || '4' || chr(8201) || '5' || chr(8288) || '6' || chr(65279) || '7' || chr(1564) || '8',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009026'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'whitespace and format characters do not split a digit run'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-01',
      null,
      false,
      '0' || chr(8208) || '1' || chr(65112) || '2' || chr(65123) || '3' || chr(1643) || '4' || chr(65294) || '5' || chr(12290) || '6' || chr(183) || '7',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009027'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'unicode dashes and dots do not split a digit run'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'replay-other'),
      repeat(chr(65296), 8),
      'a17e0000-0000-4000-8000-000000009028'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a void reason with fullwidth digits is rejected'
  );

select
  throws_ok (
    $$select app.void_expense_entry(
      (select id from app.expense_entries where note = 'replay-other'),
      '0100' || chr(8203) || '0000',
      'a17e0000-0000-4000-8000-000000009029'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a void reason with a zero-width space is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_category(
      '0100000' || chr(65296) || '000',
      'daily'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a category name with a fullwidth digit is rejected'
  );

select
  throws_ok (
    $$select app.rename_expense_category(
      (select id from app.expense_categories where name = 'نقل'),
      '0100' || chr(8203) || '0000000'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a renamed category with a zero-width space is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      null,
      null,
      '2026-11-02',
      null,
      false,
      null,
      1,
      30,
      repeat(chr(65296), 8),
      'a17e0000-0000-4000-8000-000000009030'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a driver label with fullwidth digits is rejected'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'أجر طيارين'),
      null,
      null,
      '2026-11-02',
      null,
      false,
      null,
      1,
      30,
      '0100' || chr(8203) || '0000',
      'a17e0000-0000-4000-8000-000000009031'
    )$$,
    '22023'::char(5),
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'a driver label with a zero-width space is rejected'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-05',
      null,
      false,
      repeat(chr(65296), 7),
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009032'
    )$$,
    'seven fullwidth digits are stored'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'نقل'),
      1,
      null,
      '2026-11-06',
      null,
      false,
      '1234x' || chr(8203) || '5678',
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009033'
    )$$,
    'a letter still splits a digit run when a zero-width space is nearby'
  );

-- Two accepted daily actuals sum past numeric(14,2). A monthly entry at the
-- cap, spread over 31 days, still balances. 99999999999999 piasters / 31 is
-- 32258064516.13 on days 1-27 and 32258064516.12 after that.
select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      999999999999.99,
      null,
      '2026-12-15',
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009034'
    )$$,
    'a daily actual at the amount cap is stored'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      0.01,
      null,
      '2026-12-15',
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009035'
    )$$,
    'a second daily actual on that day is stored'
  );

select
  is (
    (
      select
        daily_total
      from
        app.expense_daily ('2026-12-15', '2026-12-15')
    ),
    1000000000000.00::numeric,
    'two capped daily actuals sum past numeric(14,2)'
  );

select
  results_eq (
    $$select days_total, entries_total, balanced
      from app.expense_month_check('2026-12-01')$$,
    $$select 1000000000000.00::numeric, 1000000000000.00::numeric, true$$,
    'December month check returns the exact sum'
  );

select
  lives_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'إيجار'),
      999999999999.99,
      '2027-01-01',
      null,
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000009036'
    )$$,
    'a monthly entry at the amount cap is stored'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2027-01-01', '2027-01-01')
    ),
    32258064516.13::numeric,
    'day 1 of a near-cap month gets the extra piaster'
  );

select
  is (
    (
      select
        fixed_share
      from
        app.expense_daily ('2027-01-31', '2027-01-31')
    ),
    32258064516.12::numeric,
    'day 31 of a near-cap month gets the base share'
  );

select
  is (
    (
      select
        sum(fixed_share)
      from
        app.expense_daily ('2027-01-01', '2027-01-31')
    ),
    999999999999.99::numeric,
    'a near-cap monthly entry sums exactly over 31 days'
  );

select
  results_eq (
    $$select days_total, entries_total, balanced
      from app.expense_month_check('2027-01-01')$$,
    $$select 999999999999.99::numeric, 999999999999.99::numeric, true$$,
    'a near-cap month check balances'
  );

-- ============================================================================
-- Non-owner, anon, service_role
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
  is (
    app.is_owner (),
    false,
    'intruder is not the owner'
  );

select
  is_empty (
    'select id from app.expense_categories',
    'non-owner sees no categories'
  );

select
  is_empty (
    'select id from app.expense_entries',
    'non-owner sees no expenses'
  );

select
  is_empty (
    'select month from app.month_expense_status',
    'non-owner sees no month status'
  );

select
  throws_ok (
    $$select app.add_expense_entry(
      (select id from app.expense_categories where name = 'غاز'),
      10,
      null,
      '2026-04-01',
      null,
      false,
      null,
      null,
      null,
      null,
      'a17e0000-0000-4000-8000-000000000040'
    )$$,
    '42501'::char(5),
    'insufficient_privilege',
    'non-owner cannot post an expense'
  );

select
  throws_ok (
    $$select app.set_month_expense_complete('2026-04-01', true)$$,
    '42501'::char(5),
    'insufficient_privilege',
    'non-owner cannot mark a month'
  );

select
  is (
    (
      select
        coalesce(sum(total), 0)
      from
        app.expense_daily ('2026-04-01', '2026-04-30')
    ),
    0::numeric,
    'non-owner allocation is empty because RLS hides the entries'
  );

reset role;

select
  set_config('request.jwt.claims', '{"role":"anon"}', true);

set
  local role anon;

select
  throws_ok (
    'select * from app.expense_entries',
    '42501'::char(5),
    null::text,
    'anon cannot select expenses'
  );

select
  throws_ok (
    'select * from app.expense_categories',
    '42501'::char(5),
    null::text,
    'anon cannot select categories'
  );

select
  throws_ok (
    $$select app.expense_daily('2026-04-01', '2026-04-30')$$,
    '42501'::char(5),
    null::text,
    'anon cannot execute expense_daily'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );

set
  local role service_role;

select
  throws_ok (
    $$insert into app.expense_entries (amount, is_estimate)
      values (1, false)$$,
    '42501'::char(5),
    null::text,
    'service_role cannot insert expenses directly'
  );

select
  lives_ok (
    $$select app.add_expense_category('تصنيف خدمة', 'daily')$$,
    'service_role can add a category through the function'
  );

select
  *
from
  finish ();

rollback;
