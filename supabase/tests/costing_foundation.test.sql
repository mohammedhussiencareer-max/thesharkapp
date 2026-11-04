begin;

select
  no_plan ();

create temp table cf_ledger as
select
  (
    select
      count(*)
    from
      app.stock_movements
  ) as movements,
  (
    select
      count(*)
    from
      app.item_balances
  ) as balances;

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
    '2026-01-01 00:00:00+00',
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
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  );

insert into
  app.owner (user_id)
values
  ('b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f');

-- 1. Units
select
  is (
    (
      select
        count(*)
      from
        app.units
      where
        (code, dimension, metric_scale) in (
          ('kg', 'mass', 1),
          ('g', 'mass', 0.001),
          ('liter', 'volume', 1),
          ('ml', 'volume', 0.001)
        )
        or (code, dimension) = ('piece', 'count')
        and metric_scale is null
    ),
    5::bigint,
    'units seed is kg, g, liter, ml, and piece'
  );

update app.units
set
  label_ar = 'كيلوجرام'
where
  code = 'kg';

select
  is (
    (
      select
        label_ar
      from
        app.units
      where
        code = 'kg'
    ),
    'كيلوجرام',
    'unit label_ar may change'
  );

select
  throws_ok (
    $$update app.units set dimension = 'count' where code = 'kg'$$,
    '55000',
    null::text,
    'unit dimension cannot change'
  );

select
  throws_ok (
    $$update app.units set metric_scale = 2 where code = 'kg'$$,
    '55000',
    null::text,
    'unit metric_scale cannot change'
  );

select
  throws_ok (
    $$update app.units set code = 'kilo' where code = 'kg'$$,
    '55000',
    null::text,
    'unit code cannot change'
  );

select
  throws_ok (
    $$delete from app.units where code = 'g'$$,
    '55000',
    null::text,
    'units cannot be deleted'
  );

select
  throws_ok (
    'truncate table app.units cascade',
    '55000',
    'app.units is immutable; TRUNCATE is not allowed',
    'units cannot be truncated'
  );

select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency)
      values ('صنف جرام مرفوض', 'ingredient', 'g', 'weekly')$$,
    '23514',
    null::text,
    'stock_items.base_unit check still allows only kg, piece, and liter'
  );

select
  lives_ok (
    $fk$do $body$
      begin
        alter table app.stock_items drop constraint stock_items_base_unit_check;
        begin
          insert into app.stock_items (name, kind, base_unit, count_frequency)
          values ('صنف وحدة مفقودة', 'ingredient', 'no-such-unit', 'weekly');
          raise exception 'missing unit should have failed';
        exception
          when sqlstate '23503' then
            null;
        end;
        insert into app.stock_items (name, kind, base_unit, count_frequency)
        values ('صنف جرام', 'ingredient', 'g', 'weekly');
        if not found then
          null;
        end if;
        if not exists (
          select 1 from app.stock_items where name = 'صنف جرام' and base_unit = 'g'
        ) then
          raise exception 'g should satisfy the foreign key';
        end if;
        raise exception 'rollback fk fixture';
      exception
        when sqlstate 'P0001' then
          if sqlerrm is distinct from 'rollback fk fixture' then
            raise;
          end if;
      end
    $body$;$fk$,
    'stock_items.base_unit foreign key rejects an unknown unit and accepts g'
  );

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'e4010000-0000-4000-8000-000000000001',
    'صنف فاقد',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000002',
    'صنف تحويل',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000003',
    'صنف افتتاح',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000004',
    'صنف تجميد',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000005',
    'صنف حر',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000006',
    'خام تجميد',
    'fish_mixed',
    'kg',
    'daily'
  ),
  (
    'e4010000-0000-4000-8000-000000000008',
    'صنف تاريخ',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000009',
    'صنف تغطية كاملة',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000010',
    'صنف مدى',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000011',
    'صنف فجوة',
    'ingredient',
    'kg',
    'weekly'
  ),
  (
    'e4010000-0000-4000-8000-000000000012',
    'صنف توقيت',
    'ingredient',
    'kg',
    'weekly'
  );

insert into
  app.units (code, label_ar, dimension, metric_scale)
values
  ('carton', 'كرتونة', 'custom', null);

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

-- 2. Loss schedule
select
  is (
    app.item_costing_schedule ('e4010000-0000-4000-8000-000000000001') -> 'loss' ->> 'token',
    md5('kg|ingredient||'),
    'empty loss schedule token includes the item identity'
  );

select
  lives_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000101',
      'e4010000-0000-4000-8000-000000000001',
      0.10,
      '2026-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'تأسيس فاقد'
    )$$,
    'publish loss 0.10 from 2026-01-01'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000001',
      '2026-06-01 00:00:00+00'
    )::text,
    '0.10000',
    'loss at 2026-06-01 is 0.10'
  );

select
  ok (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000001',
      '2025-12-31 00:00:00+00'
    ) is null,
    'loss before the schedule is null'
  );

-- 5. Token, exercised on the loss schedule before it changes again.
select
  is (
    app.set_item_loss (
      'e4010000-0000-4000-8000-000000000101',
      'e4010000-0000-4000-8000-000000000001',
      0.10,
      '2026-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'تأسيس فاقد'
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000101'
    ),
    'same loss request returns the stored result'
  );

select
  is (
    (
      select
        count(*)
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000101'
    ),
    1::bigint,
    'same loss request inserts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000001'
    ),
    1::bigint,
    'loss replay does not add a version'
  );

select
  throws_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000101',
      'e4010000-0000-4000-8000-000000000001',
      0.30,
      '2026-01-01 00:00:00+00',
      null,
      'stale-token',
      'تأسيس فاقد'
    )$$,
    '22023',
    'request_id already used for a different change',
    'same request_id with different args is rejected before the token check'
  );

select
  throws_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000103',
      'e4010000-0000-4000-8000-000000000001',
      0.30,
      '2026-07-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'سبب'
    )$$,
    '40001',
    'configuration changed',
    'stale loss token is rejected'
  );

select
  lives_ok (
    format(
      $$select app.set_item_loss(
        'e4010000-0000-4000-8000-000000000102',
        'e4010000-0000-4000-8000-000000000001',
        0.20,
        '2026-03-01 00:00:00+00',
        '2026-04-01 00:00:00+00',
        %L,
        'تعديل مارس'
      )$$,
      app.item_costing_schedule ('e4010000-0000-4000-8000-000000000001') -> 'loss' ->> 'token'
    ),
    'replace [2026-03-01, 2026-04-01) with loss 0.20'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000001'
        and superseded_change_id is null
    ),
    3::bigint,
    'replacement leaves three current loss versions'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000001'
        and superseded_change_id is not null
        and effective_from = '2026-01-01 00:00:00+00'
        and effective_to is null
        and loss_pct = 0.10
    ),
    1::bigint,
    'the original open loss row is superseded'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000001'
        and superseded_change_id is null
        and effective_from = '2026-01-01 00:00:00+00'
        and effective_to = '2026-03-01 00:00:00+00'
        and loss_pct = 0.10
    ),
    'left fragment is [2026-01-01, 2026-03-01) at 0.10'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000001'
        and superseded_change_id is null
        and effective_from = '2026-03-01 00:00:00+00'
        and effective_to = '2026-04-01 00:00:00+00'
        and loss_pct = 0.20
    ),
    'middle version is [2026-03-01, 2026-04-01) at 0.20'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000001'
        and superseded_change_id is null
        and effective_from = '2026-04-01 00:00:00+00'
        and effective_to is null
        and loss_pct = 0.10
    ),
    'right fragment is [2026-04-01, open) at 0.10'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000001',
      '2026-02-28 12:00:00+00'
    )::text,
    '0.10000',
    'loss at 2026-02-28 is 0.10'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000001',
      '2026-03-01 00:00:00+00'
    )::text,
    '0.20000',
    'loss at 2026-03-01 starts the half-open 0.20 interval'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000001',
      '2026-03-15 00:00:00+00'
    )::text,
    '0.20000',
    'loss at 2026-03-15 is 0.20'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000001',
      '2026-04-01 00:00:00+00'
    )::text,
    '0.10000',
    'loss at 2026-04-01 is outside the half-open 0.20 interval'
  );

select
  is (
    app.item_costing_schedule ('e4010000-0000-4000-8000-000000000001') -> 'loss' ->> 'token',
    (
      select
        result ->> 'token'
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000102'
    ),
    'published loss token matches the schedule read'
  );

reset role;

-- 3. Exclusion and immutability, as the table owner.
insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'e4010000-0000-4000-8000-0000000001f1',
    'owner',
    '{"fn":"direct"}'::jsonb,
    '{}'::jsonb
  );

select
  throws_ok (
    $$insert into app.item_loss_versions (effective_from, created_change_id, item_id, loss_pct)
      values (
        '2026-03-15 00:00:00+00',
        (select id from app.costing_changes where request_id = 'e4010000-0000-4000-8000-0000000001f1'),
        'e4010000-0000-4000-8000-000000000001',
        0.30
      )$$,
    '23P01',
    null::text,
    'exclusion constraint blocks an overlapping current loss version'
  );

select
  throws_ok (
    $$update app.item_loss_versions
      set loss_pct = 0.40
      where item_id = 'e4010000-0000-4000-8000-000000000001'
        and superseded_change_id is null
        and loss_pct = 0.20$$,
    '55000',
    null::text,
    'loss payload cannot be updated'
  );

select
  throws_ok (
    $$update app.item_loss_versions
      set effective_to = '2026-05-01 00:00:00+00'
      where item_id = 'e4010000-0000-4000-8000-000000000001'
        and superseded_change_id is null
        and effective_from = '2026-04-01 00:00:00+00'$$,
    '55000',
    null::text,
    'loss interval cannot be updated'
  );

select
  throws_ok (
    $$update app.item_loss_versions
      set superseded_change_id = (
        select id from app.costing_changes
        where request_id = 'e4010000-0000-4000-8000-0000000001f1'
      )
      where item_id = 'e4010000-0000-4000-8000-000000000001'
        and superseded_change_id is not null$$,
    '55000',
    null::text,
    'a loss version cannot be superseded twice'
  );

select
  throws_ok (
    $$delete from app.item_loss_versions
      where item_id = 'e4010000-0000-4000-8000-000000000001'$$,
    '55000',
    null::text,
    'loss versions cannot be deleted'
  );

select
  throws_ok (
    'truncate table app.item_loss_versions',
    '55000',
    null::text,
    'loss versions cannot be truncated'
  );

set
  local role authenticated;

-- 4. Conversions
select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000002',
      'kg',
      '2026-06-01 00:00:00+00'
    ) = 1,
    'base unit factor is 1'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000002',
      'g',
      '2026-06-01 00:00:00+00'
    ) = 0.001,
    'g to kg is the implicit metric factor'
  );

select
  throws_ok (
    $$select app.item_factor_at(
      'e4010000-0000-4000-8000-000000000002',
      'ml',
      '2026-06-01 00:00:00+00'
    )$$,
    '22023',
    'unknown unit "ml" for item صنف تحويل',
    'ml on a kg item with no version raises unknown unit'
  );

select
  lives_ok (
    $$select app.set_item_conversion(
      'e4010000-0000-4000-8000-000000000111',
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      12,
      '2026-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'كرتونة'
    )$$,
    'publish carton factor 12 from 2026-01-01'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      '2026-06-01 00:00:00+00'
    ) = 12,
    'explicit carton factor is 12'
  );

select
  is (
    app.set_item_conversion (
      'e4010000-0000-4000-8000-000000000111',
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      12,
      '2026-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'كرتونة'
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000111'
    ),
    'same conversion request returns the stored result'
  );

select
  is (
    (
      select
        count(*)
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000111'
    ),
    1::bigint,
    'same conversion request inserts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_conversion_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000002'
    ),
    1::bigint,
    'conversion replay does not add a version'
  );

select
  throws_ok (
    $$select app.set_item_conversion(
      'e4010000-0000-4000-8000-000000000111',
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      13,
      '2026-01-01 00:00:00+00',
      null,
      'stale-token',
      'كرتونة'
    )$$,
    '22023',
    'request_id already used for a different change',
    'same conversion request_id with different args is rejected before the token check'
  );

select
  throws_ok (
    $$select app.set_item_conversion(
      'e4010000-0000-4000-8000-000000000114',
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      13,
      '2026-07-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'سبب'
    )$$,
    '40001',
    'configuration changed',
    'stale conversion token is rejected'
  );

select
  lives_ok (
    $$select app.set_item_conversion(
      'e4010000-0000-4000-8000-000000000112',
      'e4010000-0000-4000-8000-000000000002',
      'g',
      0.002,
      '2026-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'جرام صريح'
    )$$,
    'publish an explicit g factor'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000002',
      'g',
      '2026-06-01 00:00:00+00'
    ) = 0.002,
    'explicit g overrides the implicit factor'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000002',
      'g',
      '2025-06-01 00:00:00+00'
    ) = 0.001,
    'before the explicit g version the implicit factor remains'
  );

select
  lives_ok (
    format(
      $$select app.set_item_conversion(
        'e4010000-0000-4000-8000-000000000113',
        'e4010000-0000-4000-8000-000000000002',
        'carton',
        null,
        '2026-05-01 00:00:00+00',
        '2026-06-01 00:00:00+00',
        %L,
        'إزالة تغطية'
      )$$,
      (
        select
          conv ->> 'token'
        from
          jsonb_array_elements(
            app.item_costing_schedule ('e4010000-0000-4000-8000-000000000002') -> 'conversions'
          ) conv
        where
          conv ->> 'unit_code' = 'carton'
      )
    ),
    'null factor removes carton coverage for May 2026'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      '2026-04-01 00:00:00+00'
    ) = 12,
    'carton factor works before the gap'
  );

select
  throws_ok (
    $$select app.item_factor_at(
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      '2026-05-15 00:00:00+00'
    )$$,
    '22023',
    'unknown unit "carton" for item صنف تحويل',
    'carton lookup raises inside the removed interval'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      '2026-06-01 00:00:00+00'
    ) = 12,
    'carton factor works at the half-open end of the gap'
  );

select
  is (
    (
      select
        conv ->> 'token'
      from
        jsonb_array_elements(
          app.item_costing_schedule ('e4010000-0000-4000-8000-000000000002') -> 'conversions'
        ) conv
      where
        conv ->> 'unit_code' = 'carton'
    ),
    (
      select
        result ->> 'token'
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000113'
    ),
    'published carton token matches the schedule read'
  );

reset role;

select
  throws_ok (
    $$insert into app.item_conversion_versions (
      effective_from, created_change_id, item_id, unit_code, factor_to_base
    ) values (
      '2026-01-01 00:00:00+00',
      (select id from app.costing_changes where request_id = 'e4010000-0000-4000-8000-0000000001f1'),
      'e4010000-0000-4000-8000-000000000002',
      'kg',
      1
    )$$,
    '23514',
    'conversion unit must differ from the item base_unit',
    'a conversion in the base unit is rejected'
  );

select
  throws_ok (
    $$insert into app.item_conversion_versions (
      effective_from, created_change_id, item_id, unit_code, factor_to_base
    ) values (
      '2026-02-01 00:00:00+00',
      (select id from app.costing_changes where request_id = 'e4010000-0000-4000-8000-0000000001f1'),
      'e4010000-0000-4000-8000-000000000002',
      'carton',
      3
    )$$,
    '23P01',
    null::text,
    'exclusion constraint blocks an overlapping current conversion version'
  );

select
  throws_ok (
    $$update app.item_conversion_versions
      set factor_to_base = 99
      where item_id = 'e4010000-0000-4000-8000-000000000002'
        and unit_code = 'carton'
        and superseded_change_id is null$$,
    '55000',
    'app.item_conversion_versions is immutable; only superseded_change_id may be set once',
    'conversion payload cannot be updated'
  );

select
  throws_ok (
    $$update app.item_conversion_versions
      set superseded_change_id = (
        select id from app.costing_changes
        where request_id = 'e4010000-0000-4000-8000-0000000001f1'
      )
      where item_id = 'e4010000-0000-4000-8000-000000000002'
        and superseded_change_id is not null$$,
    '55000',
    'app.item_conversion_versions is immutable; only superseded_change_id may be set once',
    'a conversion version cannot be superseded twice'
  );

select
  throws_ok (
    $$delete from app.item_conversion_versions
      where item_id = 'e4010000-0000-4000-8000-000000000002'$$,
    '55000',
    'app.item_conversion_versions is immutable; DELETE is not allowed',
    'conversion versions cannot be deleted'
  );

select
  throws_ok (
    'truncate table app.item_conversion_versions',
    '55000',
    'app.item_conversion_versions is immutable; TRUNCATE is not allowed',
    'conversion versions cannot be truncated'
  );

set
  local role authenticated;

-- 6. Backdating
select
  throws_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000121',
      'e4010000-0000-4000-8000-000000000008',
      0.05,
      '2000-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      null
    )$$,
    '22023',
    'reason is required for a backdated change',
    'a far-past loss without a reason is rejected'
  );

select
  throws_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000121',
      'e4010000-0000-4000-8000-000000000008',
      0.05,
      '2000-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      '   '
    )$$,
    '22023',
    'reason is required for a backdated change',
    'a whitespace reason does not satisfy a backdated change'
  );

select
  lives_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000122',
      'e4010000-0000-4000-8000-000000000008',
      0.05,
      '2000-01-01 00:00:00+00',
      '2000-02-01 00:00:00+00',
      md5('kg|ingredient||'),
      '  سبب قديم  '
    )$$,
    'a far-past loss with a reason is stored'
  );

select
  is (
    (
      select
        reason
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000122'
    ),
    'سبب قديم',
    'the backdated reason is trimmed and stored'
  );

select
  lives_ok (
    format(
      $$select app.set_item_loss(
        'e4010000-0000-4000-8000-000000000123',
        'e4010000-0000-4000-8000-000000000008',
        0.07,
        '2999-01-01 00:00:00+00',
        null,
        %L,
        null
      )$$,
      app.item_costing_schedule ('e4010000-0000-4000-8000-000000000008') -> 'loss' ->> 'token'
    ),
    'a far-future loss needs no reason'
  );

select
  ok (
    (
      select
        reason
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000123'
    ) is null,
    'a future change stores a null reason'
  );

-- Timestamps in the stored payload are UTC text, so a retry does not depend on TimeZone.
set
  local timezone to 'UTC';

select
  lives_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000151',
      'e4010000-0000-4000-8000-000000000012',
      0.15,
      '2026-08-01 12:30:00+00',
      '2026-09-01 18:45:00.5+00',
      md5('kg|ingredient||'),
      'توقيت فاقد'
    )$$,
    'publish loss under UTC'
  );

select
  lives_ok (
    $$select app.set_item_conversion(
      'e4010000-0000-4000-8000-000000000152',
      'e4010000-0000-4000-8000-000000000012',
      'carton',
      6,
      '2026-08-01 12:30:00+00',
      '2026-09-01 18:45:00.5+00',
      md5('kg|ingredient||'),
      'توقيت تحويل'
    )$$,
    'publish conversion under UTC'
  );

select
  is (
    (
      select
        payload ->> 'effective_from'
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000151'
    ),
    '2026-08-01T12:30:00.000000Z',
    'loss payload effective_from is UTC text'
  );

select
  is (
    (
      select
        payload ->> 'effective_to'
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000152'
    ),
    '2026-09-01T18:45:00.500000Z',
    'conversion payload effective_to is UTC text'
  );

set
  local timezone to 'Africa/Cairo';

select
  is (
    app.set_item_loss (
      'e4010000-0000-4000-8000-000000000151',
      'e4010000-0000-4000-8000-000000000012',
      0.15,
      '2026-08-01 12:30:00+00',
      '2026-09-01 18:45:00.5+00',
      md5('kg|ingredient||'),
      'توقيت فاقد'
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000151'
    ),
    'same loss request under Africa/Cairo returns the stored result'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000012'
    ),
    1::bigint,
    'cairo loss replay inserts nothing'
  );

select
  is (
    app.set_item_conversion (
      'e4010000-0000-4000-8000-000000000152',
      'e4010000-0000-4000-8000-000000000012',
      'carton',
      6,
      '2026-08-01 12:30:00+00',
      '2026-09-01 18:45:00.5+00',
      md5('kg|ingredient||'),
      'توقيت تحويل'
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000152'
    ),
    'same conversion request under Africa/Cairo returns the stored result'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_conversion_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000012'
    ),
    1::bigint,
    'cairo conversion replay inserts nothing'
  );

set
  local timezone to 'UTC';

-- Three consecutive loss versions, then a replacement that cuts all of them.
select
  lives_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000161',
      'e4010000-0000-4000-8000-000000000010',
      0.11,
      '2026-01-01 00:00:00+00',
      '2026-02-01 00:00:00+00',
      md5('kg|ingredient||'),
      'مدى أول'
    )$$,
    'publish the first of three consecutive loss versions'
  );

select
  lives_ok (
    format(
      $$select app.set_item_loss(
        'e4010000-0000-4000-8000-000000000162',
        'e4010000-0000-4000-8000-000000000010',
        0.22,
        '2026-02-01 00:00:00+00',
        '2026-03-01 00:00:00+00',
        %L,
        'مدى ثان'
      )$$,
      app.item_costing_schedule ('e4010000-0000-4000-8000-000000000010') -> 'loss' ->> 'token'
    ),
    'publish the second of three consecutive loss versions'
  );

select
  lives_ok (
    format(
      $$select app.set_item_loss(
        'e4010000-0000-4000-8000-000000000163',
        'e4010000-0000-4000-8000-000000000010',
        0.33,
        '2026-03-01 00:00:00+00',
        null,
        %L,
        'مدى ثالث'
      )$$,
      app.item_costing_schedule ('e4010000-0000-4000-8000-000000000010') -> 'loss' ->> 'token'
    ),
    'publish the third of three consecutive loss versions'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000010'
        and superseded_change_id is null
    ),
    3::bigint,
    'three consecutive loss versions are current'
  );

select
  lives_ok (
    format(
      $$select app.set_item_loss(
        'e4010000-0000-4000-8000-000000000164',
        'e4010000-0000-4000-8000-000000000010',
        0.44,
        '2026-01-15 00:00:00+00',
        '2026-03-15 00:00:00+00',
        %L,
        'مدى وسط'
      )$$,
      app.item_costing_schedule ('e4010000-0000-4000-8000-000000000010') -> 'loss' ->> 'token'
    ),
    'replace an interval spanning three loss versions'
  );

select
  is (
    (
      select
        jsonb_array_length(result -> 'superseded')
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000164'
    ),
    3::int,
    'a spanning replacement supersedes exactly those three versions'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000010'
        and superseded_change_id is null
        and effective_from = '2026-01-01 00:00:00+00'
        and effective_to = '2026-01-15 00:00:00+00'
        and loss_pct = 0.11
    ),
    'spanning replacement keeps a left fragment of the first version'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000010'
        and superseded_change_id is null
        and effective_from = '2026-03-15 00:00:00+00'
        and effective_to is null
        and loss_pct = 0.33
    ),
    'spanning replacement keeps a right fragment of the third version'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000010'
        and superseded_change_id is null
        and loss_pct = 0.22
    ),
    0::bigint,
    'the middle version contributes no fragment'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000010'
        and superseded_change_id is null
        and effective_from = '2026-01-15 00:00:00+00'
        and effective_to = '2026-03-15 00:00:00+00'
        and loss_pct = 0.44
    ),
    'spanning replacement inserts the new loss across the covered interval'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000010',
      '2026-01-14 00:00:00+00'
    )::text,
    '0.11000',
    'loss just before the spanning replacement stays on the first version'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000010',
      '2026-01-15 00:00:00+00'
    )::text,
    '0.44000',
    'loss at the spanning replacement start is the new value'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000010',
      '2026-02-01 00:00:00+00'
    )::text,
    '0.44000',
    'loss inside the superseded middle version is the new value'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000010',
      '2026-03-14 00:00:00+00'
    )::text,
    '0.44000',
    'loss just before the spanning replacement end is the new value'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000010',
      '2026-03-15 00:00:00+00'
    )::text,
    '0.33000',
    'loss at the spanning replacement end is the right fragment'
  );

select
  is (
    app.item_costing_schedule ('e4010000-0000-4000-8000-000000000010') -> 'loss' ->> 'token',
    (
      select
        result ->> 'token'
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000164'
    ),
    'spanning replacement token matches the schedule read'
  );

select
  lives_ok (
    format(
      $$select app.set_item_loss(
        'e4010000-0000-4000-8000-000000000165',
        'e4010000-0000-4000-8000-000000000010',
        0.55,
        '2026-01-15 00:00:00+00',
        '2026-03-15 00:00:00+00',
        %L,
        'حد مطابق'
      )$$,
      app.item_costing_schedule ('e4010000-0000-4000-8000-000000000010') -> 'loss' ->> 'token'
    ),
    'replace a loss interval exactly on existing boundaries'
  );

select
  is (
    (
      select
        jsonb_array_length(result -> 'superseded')
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000165'
    ),
    1::int,
    'boundary replacement supersedes one version'
  );

select
  is (
    (
      select
        jsonb_array_length(result -> 'inserted')
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000165'
    ),
    1::int,
    'boundary replacement creates no fragments'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_loss_versions v
        join app.costing_changes c on c.id = v.created_change_id
      where
        c.request_id = 'e4010000-0000-4000-8000-000000000164'
        and v.effective_from = '2026-01-01 00:00:00+00'
        and v.effective_to = '2026-01-15 00:00:00+00'
        and v.superseded_change_id is null
    )
    and exists (
      select
        1
      from
        app.item_loss_versions v
        join app.costing_changes c on c.id = v.created_change_id
      where
        c.request_id = 'e4010000-0000-4000-8000-000000000164'
        and v.effective_from = '2026-03-15 00:00:00+00'
        and v.effective_to is null
        and v.superseded_change_id is null
    ),
    'boundary replacement keeps the neighboring rows'
  );

select
  lives_ok (
    format(
      $$select app.set_item_loss(
        'e4010000-0000-4000-8000-000000000166',
        'e4010000-0000-4000-8000-000000000010',
        0.66,
        '2026-04-01 00:00:00+00',
        null,
        %L,
        'ذيل مفتوح'
      )$$,
      app.item_costing_schedule ('e4010000-0000-4000-8000-000000000010') -> 'loss' ->> 'token'
    ),
    'replace the open-ended tail of the last loss version'
  );

select
  is (
    (
      select
        jsonb_array_length(result -> 'superseded')
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000166'
    ),
    1::int,
    'open-ended replacement supersedes the last version'
  );

select
  is (
    (
      select
        jsonb_array_length(result -> 'inserted')
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000166'
    ),
    2::int,
    'open-ended replacement keeps a left fragment and a new open row'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000010'
        and superseded_change_id is null
        and effective_from = '2026-03-15 00:00:00+00'
        and effective_to = '2026-04-01 00:00:00+00'
        and loss_pct = 0.33
    )
    and exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000010'
        and superseded_change_id is null
        and effective_from = '2026-04-01 00:00:00+00'
        and effective_to is null
        and loss_pct = 0.66
    )
    and not exists (
      select
        1
      from
        app.item_loss_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000010'
        and superseded_change_id is null
        and effective_to is null
        and effective_from < '2026-04-01 00:00:00+00'
    ),
    'open-ended replacement creates no right fragment'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000010',
      '2026-03-20 00:00:00+00'
    )::text,
    '0.33000',
    'loss before the open-ended replacement stays on the fragment'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000010',
      '2026-04-01 00:00:00+00'
    )::text,
    '0.66000',
    'loss at the open-ended replacement start is the new value'
  );

select
  is (
    app.item_costing_schedule ('e4010000-0000-4000-8000-000000000010') -> 'loss' ->> 'token',
    (
      select
        result ->> 'token'
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000166'
    ),
    'open-ended replacement token matches the schedule read'
  );

select
  lives_ok (
    $$select app.set_item_conversion(
      'e4010000-0000-4000-8000-000000000171',
      'e4010000-0000-4000-8000-000000000011',
      'carton',
      12,
      '2026-01-01 00:00:00+00',
      '2026-03-01 00:00:00+00',
      md5('kg|ingredient||'),
      'قبل الفجوة'
    )$$,
    'publish the first carton version around a later gap'
  );

select
  lives_ok (
    format(
      $$select app.set_item_conversion(
        'e4010000-0000-4000-8000-000000000172',
        'e4010000-0000-4000-8000-000000000011',
        'carton',
        9,
        '2026-05-01 00:00:00+00',
        '2026-08-01 00:00:00+00',
        %L,
        'بعد الفجوة'
      )$$,
      (
        select
          conv ->> 'token'
        from
          jsonb_array_elements(
            app.item_costing_schedule ('e4010000-0000-4000-8000-000000000011') -> 'conversions'
          ) conv
        where
          conv ->> 'unit_code' = 'carton'
      )
    ),
    'publish the second carton version after the gap'
  );

select
  lives_ok (
    format(
      $$select app.set_item_conversion(
        'e4010000-0000-4000-8000-000000000173',
        'e4010000-0000-4000-8000-000000000011',
        'carton',
        null,
        '2026-02-01 00:00:00+00',
        '2026-06-01 00:00:00+00',
        %L,
        'مسح عبر الفجوة'
      )$$,
      (
        select
          conv ->> 'token'
        from
          jsonb_array_elements(
            app.item_costing_schedule ('e4010000-0000-4000-8000-000000000011') -> 'conversions'
          ) conv
        where
          conv ->> 'unit_code' = 'carton'
      )
    ),
    'null factor removes coverage across two versions and the gap'
  );

select
  is (
    (
      select
        jsonb_array_length(result -> 'superseded')
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000173'
    ),
    2::int,
    'removal across a gap supersedes both versions'
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_conversion_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000011'
        and unit_code = 'carton'
        and superseded_change_id is null
        and effective_from = '2026-01-01 00:00:00+00'
        and effective_to = '2026-02-01 00:00:00+00'
        and factor_to_base = 12
    )
    and exists (
      select
        1
      from
        app.item_conversion_versions
      where
        item_id = 'e4010000-0000-4000-8000-000000000011'
        and unit_code = 'carton'
        and superseded_change_id is null
        and effective_from = '2026-06-01 00:00:00+00'
        and effective_to = '2026-08-01 00:00:00+00'
        and factor_to_base = 9
    ),
    'removal across a gap keeps the outside fragments'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000011',
      'carton',
      '2026-01-15 00:00:00+00'
    ) = 12,
    'carton lookup works before the multi-version removal'
  );

select
  throws_ok (
    $$select app.item_factor_at(
      'e4010000-0000-4000-8000-000000000011',
      'carton',
      '2026-02-01 00:00:00+00'
    )$$,
    '22023',
    'unknown unit "carton" for item صنف فجوة',
    'carton lookup raises inside the multi-version removal'
  );

select
  throws_ok (
    $$select app.item_factor_at(
      'e4010000-0000-4000-8000-000000000011',
      'carton',
      '2026-04-01 00:00:00+00'
    )$$,
    '22023',
    'unknown unit "carton" for item صنف فجوة',
    'carton lookup raises inside the pre-existing gap'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000011',
      'carton',
      '2026-06-01 00:00:00+00'
    ) = 9,
    'carton lookup works on the right fragment after the removal'
  );

select
  throws_ok (
    $$select app.item_factor_at(
      'e4010000-0000-4000-8000-000000000011',
      'carton',
      '2026-08-01 00:00:00+00'
    )$$,
    '22023',
    'unknown unit "carton" for item صنف فجوة',
    'carton lookup raises at the half-open end of the right fragment'
  );

select
  is (
    (
      select
        conv ->> 'token'
      from
        jsonb_array_elements(
          app.item_costing_schedule ('e4010000-0000-4000-8000-000000000011') -> 'conversions'
        ) conv
      where
        conv ->> 'unit_code' = 'carton'
    ),
    (
      select
        result ->> 'token'
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000173'
    ),
    'removal across a gap token matches the schedule read'
  );

-- 7. Opening price
select
  lives_ok (
    $$select app.set_item_opening_price(
      'e4010000-0000-4000-8000-000000000131',
      'e4010000-0000-4000-8000-000000000003',
      55.5,
      null,
      null
    )$$,
    'set opening price 55.5'
  );

select
  ok (
    (
      select
        unit_cost = 55.5
      from
        app.item_opening_prices
      where
        item_id = 'e4010000-0000-4000-8000-000000000003'
        and superseded_change_id is null
    ),
    'current opening price is 55.5'
  );

select
  lives_ok (
    format(
      $$select app.set_item_opening_price(
        'e4010000-0000-4000-8000-000000000132',
        'e4010000-0000-4000-8000-000000000003',
        60,
        null,
        %L::uuid
      )$$,
      (
        select
          id
        from
          app.item_opening_prices
        where
          item_id = 'e4010000-0000-4000-8000-000000000003'
          and superseded_change_id is null
      )::text
    ),
    'replace opening price with 60 using the current id'
  );

select
  throws_ok (
    $$select app.set_item_opening_price(
      'e4010000-0000-4000-8000-000000000134',
      'e4010000-0000-4000-8000-000000000003',
      70,
      null,
      'e4010000-0000-4000-8000-000000000099'
    )$$,
    '40001',
    'configuration changed',
    'stale opening price id is rejected'
  );

select
  throws_ok (
    $$select app.set_item_opening_price(
      'e4010000-0000-4000-8000-000000000135',
      'e4010000-0000-4000-8000-000000000003',
      0,
      null,
      (select id from app.item_opening_prices
        where item_id = 'e4010000-0000-4000-8000-000000000003'
          and superseded_change_id is null)
    )$$,
    '22023',
    'zero_cost_reason is required when unit_cost is 0',
    'zero opening price without a reason is rejected'
  );

select
  lives_ok (
    format(
      $$select app.set_item_opening_price(
        'e4010000-0000-4000-8000-000000000136',
        'e4010000-0000-4000-8000-000000000003',
        0,
        'تكلفة صفر مقصودة',
        %L::uuid
      )$$,
      (
        select
          id
        from
          app.item_opening_prices
        where
          item_id = 'e4010000-0000-4000-8000-000000000003'
          and superseded_change_id is null
      )::text
    ),
    'zero opening price with a reason is stored'
  );

select
  is (
    (
      select
        zero_cost_reason
      from
        app.item_opening_prices
      where
        item_id = 'e4010000-0000-4000-8000-000000000003'
        and superseded_change_id is null
    ),
    'تكلفة صفر مقصودة',
    'zero cost reason is stored on the current row'
  );

select
  lives_ok (
    format(
      $$select app.set_item_opening_price(
        'e4010000-0000-4000-8000-000000000136',
        'e4010000-0000-4000-8000-000000000003',
        0,
        'تكلفة صفر مقصودة',
        %L::uuid
      )$$,
      (
        select
          payload ->> 'expected_current_id'
        from
          app.costing_changes
        where
          request_id = 'e4010000-0000-4000-8000-000000000136'
      )
    ),
    'same opening price request returns the stored result'
  );

select
  is (
    (
      select
        count(*)
      from
        app.costing_changes
      where
        request_id = 'e4010000-0000-4000-8000-000000000136'
    ),
    1::bigint,
    'opening price replay inserts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_opening_prices
      where
        item_id = 'e4010000-0000-4000-8000-000000000003'
        and superseded_change_id is null
    ),
    1::bigint,
    'one current opening price per item'
  );

-- Removing every current conversion leaves the item unconfigured.
select
  lives_ok (
    $$select app.set_item_conversion(
      'e4010000-0000-4000-8000-000000000141',
      'e4010000-0000-4000-8000-000000000009',
      'carton',
      4,
      '2026-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'تغطية'
    )$$,
    'publish a conversion that will be removed entirely'
  );

select
  lives_ok (
    format(
      $$select app.set_item_conversion(
        'e4010000-0000-4000-8000-000000000142',
        'e4010000-0000-4000-8000-000000000009',
        'carton',
        null,
        '2026-01-01 00:00:00+00',
        null,
        %L,
        'مسح التغطية'
      )$$,
      (
        select
          conv ->> 'token'
        from
          jsonb_array_elements(
            app.item_costing_schedule ('e4010000-0000-4000-8000-000000000009') -> 'conversions'
          ) conv
        where
          conv ->> 'unit_code' = 'carton'
      )
    ),
    'remove the whole carton schedule'
  );

select
  lives_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000143',
      'e4010000-0000-4000-8000-000000000004',
      0.10,
      '2026-01-01 00:00:00+00',
      null,
      md5('kg|ingredient||'),
      'تجميد'
    )$$,
    'configure the freeze item with a loss version'
  );

reset role;

select
  throws_ok (
    $$insert into app.item_opening_prices (item_id, base_unit, unit_cost, created_change_id)
      values (
        'e4010000-0000-4000-8000-000000000003',
        'piece',
        1,
        (select id from app.costing_changes where request_id = 'e4010000-0000-4000-8000-000000000131')
      )$$,
    '23514',
    'opening price base_unit must match the item base_unit',
    'opening price base_unit must match the item'
  );

select
  throws_ok (
    $$insert into app.item_opening_prices (item_id, base_unit, unit_cost, created_change_id)
      values (
        'e4010000-0000-4000-8000-000000000003',
        'kg',
        9,
        (select id from app.costing_changes where request_id = 'e4010000-0000-4000-8000-000000000131')
      )$$,
    '23505',
    null::text,
    'a second current opening price is rejected'
  );

select
  throws_ok (
    $$update app.item_opening_prices
      set unit_cost = 1
      where item_id = 'e4010000-0000-4000-8000-000000000003'
        and superseded_change_id is null$$,
    '55000',
    'app.item_opening_prices is immutable; only superseded_change_id may be set once',
    'opening price payload cannot be updated'
  );

select
  throws_ok (
    $$update app.item_opening_prices
      set superseded_change_id = (
        select id from app.costing_changes
        where request_id = 'e4010000-0000-4000-8000-0000000001f1'
      )
      where item_id = 'e4010000-0000-4000-8000-000000000003'
        and superseded_change_id is not null$$,
    '55000',
    'app.item_opening_prices is immutable; only superseded_change_id may be set once',
    'an opening price cannot be superseded twice'
  );

select
  throws_ok (
    $$delete from app.item_opening_prices
      where item_id = 'e4010000-0000-4000-8000-000000000003'$$,
    '55000',
    'app.item_opening_prices is immutable; DELETE is not allowed',
    'opening prices cannot be deleted'
  );

select
  throws_ok (
    'truncate table app.item_opening_prices',
    '55000',
    'app.item_opening_prices is immutable; TRUNCATE is not allowed',
    'opening prices cannot be truncated'
  );

-- 8. Freeze
select
  throws_ok (
    $$update app.stock_items set base_unit = 'liter'
      where id = 'e4010000-0000-4000-8000-000000000004'$$,
    '23514',
    'cannot change base_unit of an item that is configured or has movements',
    'configured item cannot change base_unit'
  );

select
  throws_ok (
    $$update app.stock_items set kind = 'packaging'
      where id = 'e4010000-0000-4000-8000-000000000004'$$,
    '23514',
    'cannot change kind of an item that is configured or has movements',
    'configured item cannot change kind'
  );

select
  throws_ok (
    $$update app.stock_items set parent_item_id = 'e4010000-0000-4000-8000-000000000006'
      where id = 'e4010000-0000-4000-8000-000000000004'$$,
    '23514',
    'cannot change parent_item_id of an item that is configured or has movements',
    'configured item cannot change parent_item_id'
  );

select
  throws_ok (
    $$update app.stock_items set base_unit = 'liter'
      where id = 'e4010000-0000-4000-8000-000000000002'$$,
    '23514',
    'cannot change base_unit of an item that is configured or has movements',
    'a conversion reference alone freezes base_unit'
  );

select
  throws_ok (
    $$update app.stock_items set kind = 'packaging'
      where id = 'e4010000-0000-4000-8000-000000000002'$$,
    '23514',
    'cannot change kind of an item that is configured or has movements',
    'a conversion reference alone freezes kind'
  );

select
  throws_ok (
    $$update app.stock_items set base_unit = 'liter'
      where id = 'e4010000-0000-4000-8000-000000000003'$$,
    '23514',
    'cannot change base_unit of an item that is configured or has movements',
    'an opening price alone freezes base_unit'
  );

select
  throws_ok (
    $$update app.stock_items set kind = 'packaging'
      where id = 'e4010000-0000-4000-8000-000000000003'$$,
    '23514',
    'cannot change kind of an item that is configured or has movements',
    'an opening price alone freezes kind'
  );

select
  ok (
    (
      select
        (t.tgtype & 1) = 0
        and (t.tgtype & 2) = 2
        and (t.tgtype & 16) = 16
        and (t.tgtype & 4) = 0
        and (t.tgtype & 8) = 0
        and (t.tgtype & 32) = 0
        and p.proname = 'trg_stock_items_base_unit_lock'
        and (
          select
            pg_catalog.array_agg (
              a.attname::text
              order by
                u.ord
            )
          from
            pg_catalog.unnest (t.tgattr::smallint[]) with ordinality as u (attnum, ord)
            join pg_catalog.pg_attribute a on a.attrelid = t.tgrelid
            and a.attnum = u.attnum
        ) = array['base_unit', 'kind', 'parent_item_id']::text[]
      from
        pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_proc p on p.oid = t.tgfoid
      where
        n.nspname = 'app'
        and c.relname = 'stock_items'
        and t.tgname = 'trg_stock_items_configured_identity_lock'
        and not t.tgisinternal
    ),
    'identity lock is a before statement trigger on base_unit, kind, and parent_item_id'
  );

select
  lives_ok (
    $$update app.stock_items set base_unit = 'liter'
      where id = 'e4010000-0000-4000-8000-000000000005'$$,
    'an unconfigured item can change base_unit'
  );

select
  lives_ok (
    $$update app.stock_items set kind = 'packaging'
      where id = 'e4010000-0000-4000-8000-000000000005'$$,
    'an unconfigured item can change kind'
  );

select
  lives_ok (
    $$update app.stock_items
      set kind = 'fish_size', parent_item_id = 'e4010000-0000-4000-8000-000000000006'
      where id = 'e4010000-0000-4000-8000-000000000005'$$,
    'an unconfigured item can change parent_item_id'
  );

select
  lives_ok (
    $$update app.stock_items set base_unit = 'piece'
      where id = 'e4010000-0000-4000-8000-000000000009'$$,
    'superseded conversions do not freeze base_unit'
  );

select
  lives_ok (
    $mv$do $body$
      declare
        v_item uuid := 'e4010000-0000-4000-8000-000000000007';
      begin
        insert into app.stock_items (id, name, kind, base_unit, count_frequency)
        values (v_item, 'صنف حركة تجميد', 'ingredient', 'kg', 'weekly');
        insert into app.stock_movements (
          batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost
        ) values (
          'e4010000-0000-4000-8000-0000000000a1', v_item, 'purchase',
          '2020-01-01 00:00:00+00', 1, 1, 1
        );
        begin
          update app.stock_items set base_unit = 'liter' where id = v_item;
          raise exception 'base_unit update should have failed';
        exception
          when sqlstate '23514' then
            if sqlerrm is distinct from 'cannot change base_unit of an item that has movements' then
              raise exception 'unexpected base_unit message: %', sqlerrm;
            end if;
        end;
        begin
          update app.stock_items set kind = 'packaging' where id = v_item;
          raise exception 'kind update should have failed';
        exception
          when sqlstate '23514' then
            if sqlerrm is distinct from 'cannot change kind of an item that is configured or has movements' then
              raise exception 'unexpected kind message: %', sqlerrm;
            end if;
        end;
        raise exception 'rollback movement fixture';
      exception
        when sqlstate 'P0001' then
          if sqlerrm is distinct from 'rollback movement fixture' then
            raise;
          end if;
      end
    $body$;$mv$,
    'a movement keeps the old base_unit message and blocks kind'
  );

-- 10. Append-only audit
select
  throws_ok (
    $$update app.costing_changes set reason = 'تغيير'
      where request_id = 'e4010000-0000-4000-8000-000000000122'$$,
    '55000',
    null::text,
    'costing_changes cannot be updated'
  );

select
  throws_ok (
    $$delete from app.costing_changes
      where request_id = 'e4010000-0000-4000-8000-000000000122'$$,
    '55000',
    null::text,
    'costing_changes cannot be deleted'
  );

select
  throws_ok (
    'truncate table app.costing_changes cascade',
    '55000',
    'app.costing_changes is append-only; TRUNCATE is not allowed',
    'costing_changes cannot be truncated'
  );

-- 9. Privileges
select
  is (
    has_schema_privilege('anon', 'app', 'usage'),
    false,
    'anon has no usage on schema app'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.set_item_loss(uuid,uuid,numeric,timestamptz,timestamptz,text,text)',
      'execute'
    )
    and has_function_privilege(
      'authenticated',
      'app.set_item_conversion(uuid,uuid,text,numeric,timestamptz,timestamptz,text,text)',
      'execute'
    )
    and has_function_privilege(
      'authenticated',
      'app.set_item_opening_price(uuid,uuid,numeric,text,uuid)',
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'app.set_item_loss(uuid,uuid,numeric,timestamptz,timestamptz,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'app.set_item_conversion(uuid,uuid,text,numeric,timestamptz,timestamptz,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'app.set_item_opening_price(uuid,uuid,numeric,text,uuid)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'app.set_item_loss(uuid,uuid,numeric,timestamptz,timestamptz,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'public',
      'app.set_item_loss(uuid,uuid,numeric,timestamptz,timestamptz,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'app.set_item_conversion(uuid,uuid,text,numeric,timestamptz,timestamptz,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'public',
      'app.set_item_conversion(uuid,uuid,text,numeric,timestamptz,timestamptz,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'app.set_item_opening_price(uuid,uuid,numeric,text,uuid)',
      'execute'
    )
    and not has_function_privilege(
      'public',
      'app.set_item_opening_price(uuid,uuid,numeric,text,uuid)',
      'execute'
    ),
    true,
    'writers are executable by authenticated only'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.item_loss_at(uuid,timestamptz)',
      'execute'
    )
    and has_function_privilege(
      'service_role',
      'app.item_loss_at(uuid,timestamptz)',
      'execute'
    )
    and has_function_privilege(
      'authenticated',
      'app.item_factor_at(uuid,text,timestamptz)',
      'execute'
    )
    and has_function_privilege(
      'service_role',
      'app.item_factor_at(uuid,text,timestamptz)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'app.item_loss_at(uuid,timestamptz)',
      'execute'
    )
    and not has_function_privilege(
      'public',
      'app.item_loss_at(uuid,timestamptz)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'app.item_factor_at(uuid,text,timestamptz)',
      'execute'
    )
    and not has_function_privilege(
      'public',
      'app.item_factor_at(uuid,text,timestamptz)',
      'execute'
    ),
    true,
    'lookups are executable by authenticated and service_role only'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.item_costing_schedule(uuid)',
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'app.item_costing_schedule(uuid)',
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'app.item_costing_schedule(uuid)',
      'execute'
    )
    and not has_function_privilege(
      'public',
      'app.item_costing_schedule(uuid)',
      'execute'
    ),
    true,
    'item_costing_schedule is executable by authenticated only'
  );

select
  is (
    (
      select
        count(*)
      from
        unnest(
          array[
            'app.schedule_token(text,uuid,text)',
            'app.costing_schedule_line(uuid,timestamptz,timestamptz,numeric)',
            'app.costing_timestamptz_text(timestamptz)',
            'app.costing_replay_result(uuid,jsonb)',
            'app.insert_owner_costing_change(uuid,text,jsonb,jsonb)',
            'app.trg_units_immutable()',
            'app.trg_units_no_truncate()',
            'app.trg_version_supersede_only()',
            'app.trg_version_no_truncate()',
            'app.trg_conversion_not_base_unit()',
            'app.trg_opening_price_base_unit()',
            'app.trg_stock_items_freeze_configured_identity()'
          ]::regprocedure[]
        ) as fn
    ),
    12::bigint,
    'privilege check names every internal costing helper'
  );

select
  is_empty (
    $$select r.role, fn::text
      from unnest(array[
        'app.schedule_token(text,uuid,text)',
        'app.costing_schedule_line(uuid,timestamptz,timestamptz,numeric)',
        'app.costing_timestamptz_text(timestamptz)',
        'app.costing_replay_result(uuid,jsonb)',
        'app.insert_owner_costing_change(uuid,text,jsonb,jsonb)',
        'app.trg_units_immutable()',
        'app.trg_units_no_truncate()',
        'app.trg_version_supersede_only()',
        'app.trg_version_no_truncate()',
        'app.trg_conversion_not_base_unit()',
        'app.trg_opening_price_base_unit()',
        'app.trg_stock_items_freeze_configured_identity()'
      ]::regprocedure[]) as fn
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      where has_function_privilege(r.role, fn, 'execute')$$,
    'internal helpers are not executable by anon, authenticated, service_role, or public'
  );

select
  is_empty (
    $$select r.role, c.relname, p.priv
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      cross join (values ('insert'), ('update'), ('delete'), ('truncate')) as p(priv)
      where n.nspname = 'app'
        and c.relname in (
          'costing_changes', 'units', 'item_loss_versions',
          'item_conversion_versions', 'item_opening_prices'
        )
        and has_table_privilege(r.role, c.oid, p.priv)$$,
    'API roles cannot insert, update, delete, or truncate costing tables'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        cross join (
          values
            ('authenticated'),
            ('service_role')
        ) as r (role)
      where
        n.nspname = 'app'
        and c.relname in (
          'costing_changes',
          'units',
          'item_loss_versions',
          'item_conversion_versions',
          'item_opening_prices'
        )
        and has_table_privilege(r.role, c.oid, 'select')
    ),
    10::bigint,
    'authenticated and service_role can select every new costing table'
  );

select
  is_empty (
    $$select r.role, c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('public')) as r(role)
      where n.nspname = 'app'
        and c.relname in (
          'costing_changes', 'units', 'item_loss_versions',
          'item_conversion_versions', 'item_opening_prices'
        )
        and has_table_privilege(r.role, c.oid, 'select')$$,
    'anon and public cannot select costing tables'
  );

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
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000191',
      'e4010000-0000-4000-8000-000000000001',
      0.10, '2090-01-01 00:00:00+00', null, md5('kg|ingredient||'), null
    )$$,
    '42501',
    'insufficient_privilege',
    'non-owner cannot set loss'
  );

select
  throws_ok (
    $$select app.set_item_conversion(
      'e4010000-0000-4000-8000-000000000192',
      'e4010000-0000-4000-8000-000000000002',
      'carton', 2, '2090-01-01 00:00:00+00', null, md5('kg|ingredient||'), null
    )$$,
    '42501',
    'insufficient_privilege',
    'non-owner cannot set a conversion'
  );

select
  throws_ok (
    $$select app.set_item_opening_price(
      'e4010000-0000-4000-8000-000000000193',
      'e4010000-0000-4000-8000-000000000003',
      1, null, null
    )$$,
    '42501',
    'insufficient_privilege',
    'non-owner cannot set an opening price'
  );

select
  throws_ok (
    $$select app.item_costing_schedule('e4010000-0000-4000-8000-000000000001')$$,
    '42501',
    'insufficient_privilege',
    'non-owner cannot read the costing schedule'
  );

select
  is (
    app.item_loss_at (
      'e4010000-0000-4000-8000-000000000001',
      '2026-02-28 12:00:00+00'
    )::text,
    '0.10000',
    'a non-owner can read a loss lookup'
  );

select
  throws_ok (
    $$select app.item_factor_at(
      'e4010000-0000-4000-8000-000000000002',
      'ml',
      '2026-06-01 00:00:00+00'
    )$$,
    '22023',
    'unknown unit "ml" for item e4010000-0000-4000-8000-000000000002',
    'a non-owner unknown-unit error does not include the item name'
  );

select
  is_empty (
    'select id from app.costing_changes',
    'non-owner sees no costing changes'
  );

select
  is_empty (
    'select code from app.units',
    'non-owner sees no units'
  );

select
  is_empty (
    'select id from app.item_loss_versions',
    'non-owner sees no loss versions'
  );

select
  is_empty (
    'select id from app.item_conversion_versions',
    'non-owner sees no conversion versions'
  );

select
  is_empty (
    'select id from app.item_opening_prices',
    'non-owner sees no opening prices'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    $$select app.set_item_loss(
      'e4010000-0000-4000-8000-000000000194',
      'e4010000-0000-4000-8000-000000000001',
      0.10, '2090-01-01 00:00:00+00', null, md5('kg|ingredient||'), null
    )$$,
    '42501',
    null::text,
    'anon cannot call a writer'
  );

select
  throws_ok (
    'select code from app.units',
    '42501',
    null::text,
    'anon cannot select units'
  );

reset role;

set
  local role service_role;

select
  throws_ok (
    $$select app.set_item_opening_price(
      'e4010000-0000-4000-8000-000000000195',
      'e4010000-0000-4000-8000-000000000003',
      1, null, null
    )$$,
    '42501',
    null::text,
    'service_role cannot execute an opening-price writer'
  );

select
  ok (
    app.item_factor_at (
      'e4010000-0000-4000-8000-000000000002',
      'g',
      '2025-06-01 00:00:00+00'
    ) = 0.001,
    'service_role can read a factor lookup'
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

select
  ok (
    (
      select
        count(*)
      from
        app.units
    ) >= 5,
    'owner can select units'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.costing_changes
    ) > 0,
    'owner can select costing changes'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.item_loss_versions
    ) > 0,
    'owner can select loss versions'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.item_conversion_versions
    ) > 0,
    'owner can select conversion versions'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.item_opening_prices
    ) > 0,
    'owner can select opening prices'
  );

select
  throws_ok (
    $$insert into app.units (code, label_ar, dimension, metric_scale)
      values ('box', 'علبة', 'custom', null)$$,
    '42501',
    null::text,
    'owner cannot insert units directly'
  );

reset role;

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
    ),
    (
      select
        movements
      from
        cf_ledger
    ),
    'stock_movements count is unchanged'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_balances
    ),
    (
      select
        balances
      from
        cf_ledger
    ),
    'item_balances count is unchanged'
  );

select
  *
from
  finish ();

rollback;
