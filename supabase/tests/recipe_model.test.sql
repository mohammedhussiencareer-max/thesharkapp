begin;

select
  plan (183);

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
    '2020-01-01T00:00:00Z',
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
    '2020-01-01T00:00:00Z',
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
-- Fixtures the table owner seeds directly. Items: 11 shrimp (seafood, loss
-- 0.10), 12 salt (0), 13 oil (0, liter = 0.92 kg), 14 flour (no loss), 15 box
-- (packaging), 16 and 1d mixed fish, 17 sized fish, 18 spice (0.2 until 2031,
-- then 0.5), 19 tiny (0), 1a inactive (0), 1b free (no configuration).
-- ============================================================================
insert into
  app.costing_changes (
    request_id,
    kind,
    actor_id,
    reason,
    payload,
    result
  )
values
  (
    'f5000000-0000-4000-8000-0000000001f1',
    'owner',
    null,
    null,
    '{"fn":"test_fixture"}'::jsonb,
    '{"ok":true}'::jsonb
  );

-- An older "now" change whose end has since passed. The transaction clock
-- cannot move, so the stored change is seeded with the payload the writer builds.
insert into
  app.costing_changes (
    request_id,
    kind,
    actor_id,
    reason,
    payload,
    result
  )
values
  (
    'f5000000-0000-4000-8000-0000000001f2',
    'owner',
    null,
    null,
    jsonb_build_object(
      'fn',
      'set_recipe_version',
      'recipe_id',
      'f5000000-0000-4000-8000-000000000047'::uuid,
      'effective_from',
      'now',
      'effective_to',
      app.costing_timestamptz_text ('2020-06-01 00:00:00+00'::timestamptz),
      'batch_qty',
      null::numeric,
      'batch_unit',
      null::text,
      'lines',
      app.recipe_lines_normalize (
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb
      ),
      'expected_token',
      md5('dish|'),
      'reason',
      null::text
    ),
    '{"seeded":"older now replay"}'::jsonb
  );

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
    'f5000000-0000-4000-8000-000000000011',
    'جمبري وصفة',
    'seafood',
    'kg',
    'daily',
    true
  ),
  (
    'f5000000-0000-4000-8000-000000000012',
    'ملح وصفة',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'f5000000-0000-4000-8000-000000000013',
    'زيت وصفة',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'f5000000-0000-4000-8000-000000000014',
    'دقيق وصفة',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'f5000000-0000-4000-8000-000000000015',
    'علبة وصفة',
    'packaging',
    'piece',
    'weekly',
    true
  ),
  (
    'f5000000-0000-4000-8000-000000000016',
    'سمك مشكل وصفة',
    'fish_mixed',
    'kg',
    'daily',
    true
  ),
  (
    'f5000000-0000-4000-8000-00000000001d',
    'سمك مشكل ثان',
    'fish_mixed',
    'kg',
    'daily',
    true
  ),
  (
    'f5000000-0000-4000-8000-000000000018',
    'بهارات وصفة',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'f5000000-0000-4000-8000-000000000019',
    'صنف دقيق جدا',
    'ingredient',
    'kg',
    'weekly',
    true
  ),
  (
    'f5000000-0000-4000-8000-00000000001a',
    'صنف موقوف',
    'ingredient',
    'kg',
    'weekly',
    false
  ),
  (
    'f5000000-0000-4000-8000-00000000001b',
    'صنف حر وصفة',
    'ingredient',
    'kg',
    'weekly',
    true
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
    'f5000000-0000-4000-8000-000000000017',
    'سمك مقاس وصفة',
    'fish_size',
    'kg',
    'daily',
    'f5000000-0000-4000-8000-000000000016'
  );

insert into
  app.item_loss_versions (
    effective_from,
    effective_to,
    created_change_id,
    item_id,
    loss_pct
  )
select
  v.f,
  v.t,
  c.id,
  v.item,
  v.loss
from
  (
    values
      (
        '2020-01-01 00:00:00+00'::timestamptz,
        null::timestamptz,
        'f5000000-0000-4000-8000-000000000011'::uuid,
        0.10::numeric
      ),
      (
        '2020-01-01 00:00:00+00',
        null,
        'f5000000-0000-4000-8000-000000000012',
        0
      ),
      (
        '2020-01-01 00:00:00+00',
        null,
        'f5000000-0000-4000-8000-000000000013',
        0
      ),
      (
        '2020-01-01 00:00:00+00',
        '2031-01-01 00:00:00+00',
        'f5000000-0000-4000-8000-000000000018',
        0.20
      ),
      (
        '2031-01-01 00:00:00+00',
        null,
        'f5000000-0000-4000-8000-000000000018',
        0.50
      ),
      (
        '2020-01-01 00:00:00+00',
        null,
        'f5000000-0000-4000-8000-000000000019',
        0
      ),
      (
        '2020-01-01 00:00:00+00',
        null,
        'f5000000-0000-4000-8000-00000000001a',
        0
      )
  ) as v (f, t, item, loss)
  cross join (
    select
      id
    from
      app.costing_changes
    where
      request_id = 'f5000000-0000-4000-8000-0000000001f1'
  ) c;

insert into
  app.item_conversion_versions (
    effective_from,
    created_change_id,
    item_id,
    unit_code,
    factor_to_base
  )
select
  '2020-01-01 00:00:00+00',
  c.id,
  'f5000000-0000-4000-8000-000000000013',
  'liter',
  0.92
from
  app.costing_changes c
where
  c.request_id = 'f5000000-0000-4000-8000-0000000001f1';

insert into
  app.recipes (id, name, kind, created_change_id)
select
  v.id::uuid,
  v.name,
  v.kind,
  c.id
from
  (
    values
      (
        'f5000000-0000-4000-8000-000000000021',
        'طبق أول',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000022',
        'طهي أول',
        'cooking'
      ),
      (
        'f5000000-0000-4000-8000-000000000023',
        'صلصة',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000024',
        'دورة أ',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000025',
        'دورة ب',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000026',
        'طبق صلصة',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000027',
        'طبق بلا إصدار',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000028',
        'طبق عمق',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000029',
        'طبق بلا فاقد',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-00000000002a',
        'طبق دقة',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-00000000002b',
        'طبق تواريخ',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-00000000002c',
        'تجميع',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-00000000002d',
        'طبق تجميع',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-00000000002e',
        'سائل',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-00000000002f',
        'طبق سائل',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000030',
        'عمق 1',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000031',
        'عمق 2',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000032',
        'عمق 3',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000033',
        'عمق 4',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000034',
        'عمق 5',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000035',
        'عمق 6',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000036',
        'عمق 7',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000037',
        'عمق 8',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000038',
        'عمق 9',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-000000000039',
        'طبق أصل',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-00000000003a',
        'ابن',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-00000000003b',
        'أصل ثان',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-00000000003c',
        'ابن ثان',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-00000000003d',
        'طهي ثان',
        'cooking'
      ),
      (
        'f5000000-0000-4000-8000-00000000003e',
        'بحري',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-00000000003f',
        'طبق الآن',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000040',
        'طبق رجعي',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000041',
        'طبق فجوة',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000042',
        'طبق تجزئة',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000043',
        'طبق تجميد',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000044',
        'طبق حر',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000045',
        'طبق جمبري',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000046',
        'طبق وحدة',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000047',
        'طبق إعادة',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000048',
        'طبق لاحق',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-000000000049',
        'ابن لاحق',
        'batch'
      ),
      (
        'f5000000-0000-4000-8000-00000000004a',
        'طبق فجوة متداخلة',
        'dish'
      ),
      (
        'f5000000-0000-4000-8000-00000000004b',
        'ابن فجوة متداخلة',
        'batch'
      )
  ) as v (id, name, kind)
  cross join (
    select
      id
    from
      app.costing_changes
    where
      request_id = 'f5000000-0000-4000-8000-0000000001f1'
  ) c;

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
-- 1. create_recipe and update_recipe
-- ============================================================================
select
  lives_ok (
    $$select app.create_recipe(
      'f5000000-0000-4000-8000-000000000101', 'وصفة جديدة', 'dish'
    )$$,
    'the owner creates a recipe'
  );

select
  is (
    app.create_recipe (
      'f5000000-0000-4000-8000-000000000101',
      'وصفة جديدة',
      'dish'
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'f5000000-0000-4000-8000-000000000101'
    ),
    'replaying the same request returns the stored result'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipes
      where
        name = 'وصفة جديدة'
    ),
    1::bigint,
    'a replay creates no second recipe'
  );

select
  results_eq (
    $$select kind, active from app.recipes where name = 'وصفة جديدة'$$,
    $$values ('dish'::text, true)$$,
    'a new recipe is active and has the requested kind'
  );

select
  is (
    (
      select
        (result ->> 'recipe_id')::uuid
      from
        app.costing_changes
      where
        request_id = 'f5000000-0000-4000-8000-000000000101'
    ),
    (
      select
        id
      from
        app.recipes
      where
        name = 'وصفة جديدة'
    ),
    'the stored result carries the new recipe id'
  );

select
  throws_ok (
    $$select app.create_recipe(
      'f5000000-0000-4000-8000-000000000101', 'وصفة أخرى', 'dish'
    )$$,
    '22023',
    'request_id already used for a different change',
    'the same request id with a different payload is rejected'
  );

select
  throws_ok (
    $$select app.create_recipe(
      'f5000000-0000-4000-8000-000000000102', 'وصفة جديدة', 'batch'
    )$$,
    '23505',
    null::text,
    'a duplicate recipe name is rejected'
  );

select
  throws_ok (
    $$select app.create_recipe(
      'f5000000-0000-4000-8000-000000000103', 'وصفة', 'menu'
    )$$,
    '22023',
    'kind must be dish, cooking, or batch',
    'an unknown kind is rejected'
  );

select
  throws_ok (
    $$select app.create_recipe(
      'f5000000-0000-4000-8000-000000000104', '   ', 'dish'
    )$$,
    '22023',
    'name must be 1 to 120 characters',
    'a blank name is rejected'
  );

select
  lives_ok (
    $$select app.update_recipe(
      'f5000000-0000-4000-8000-000000000105',
      (select id from app.recipes where name = 'وصفة جديدة'),
      'وصفة معدلة', false, 'وصفة جديدة', true
    )$$,
    'the owner renames and deactivates a recipe'
  );

select
  results_eq (
    $$select name, kind, active from app.recipes where name = 'وصفة معدلة'$$,
    $$values ('وصفة معدلة'::text, 'dish'::text, false)$$,
    'rename and active changed, kind did not'
  );

select
  is (
    app.update_recipe (
      'f5000000-0000-4000-8000-000000000105',
      (
        select
          id
        from
          app.recipes
        where
          name = 'وصفة معدلة'
      ),
      'وصفة معدلة',
      false,
      'وصفة جديدة',
      true
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'f5000000-0000-4000-8000-000000000105'
    ),
    'replaying an update returns the stored result even though the expected values are now stale'
  );

select
  throws_ok (
    $$select app.update_recipe(
      'f5000000-0000-4000-8000-000000000106',
      (select id from app.recipes where name = 'وصفة معدلة'),
      'وصفة ثالثة', true, 'وصفة جديدة', true
    )$$,
    '40001',
    'configuration changed',
    'a stale expected name is rejected'
  );

select
  throws_ok (
    $$select app.update_recipe(
      'f5000000-0000-4000-8000-000000000107',
      (select id from app.recipes where name = 'وصفة معدلة'),
      'وصفة ثالثة', true, 'وصفة معدلة', true
    )$$,
    '40001',
    'configuration changed',
    'a stale expected active flag is rejected'
  );

select
  throws_ok (
    $$select app.update_recipe(
      'f5000000-0000-4000-8000-000000000108',
      (select id from app.recipes where name = 'وصفة معدلة'),
      'طبق أول', false, 'وصفة معدلة', false
    )$$,
    '23505',
    null::text,
    'renaming onto an existing recipe name is rejected'
  );

select
  throws_ok (
    $$select app.update_recipe(
      'f5000000-0000-4000-8000-000000000109',
      'f5000000-0000-4000-8000-0000000009ff',
      'اسم', true, 'اسم', true
    )$$,
    '22023',
    'unknown recipe id: f5000000-0000-4000-8000-0000000009ff',
    'updating an unknown recipe is rejected'
  );

-- ============================================================================
-- 2. recipe_schedule and set_recipe_version basics
-- ============================================================================
select
  is (
    app.recipe_schedule ('f5000000-0000-4000-8000-00000000003f') ->> 'identity',
    'dish|',
    'the recipe identity is its kind'
  );

select
  is (
    app.recipe_schedule ('f5000000-0000-4000-8000-00000000003f') ->> 'token',
    md5('dish|'),
    'an empty schedule token hashes the identity alone'
  );

select
  is (
    app.recipe_schedule ('f5000000-0000-4000-8000-00000000003f') ->> 'empty_token',
    md5('dish|'),
    'empty_token is the identity hash'
  );

select
  is (
    app.recipe_schedule ('f5000000-0000-4000-8000-000000000023') ->> 'empty_token',
    md5('batch|'),
    'a batch recipe hashes batch|'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000010b',
      'f5000000-0000-4000-8000-00000000003f',
      null, null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    'a null effective_from publishes from the current minute'
  );

select
  is (
    (
      select
        effective_from
      from
        app.recipe_versions
      where
        recipe_id = 'f5000000-0000-4000-8000-00000000003f'
        and superseded_change_id is null
    ),
    pg_catalog.date_trunc ('minute', pg_catalog.now ()),
    'the stored start is the server current minute'
  );

select
  is (
    (
      select
        payload ->> 'effective_from'
      from
        app.costing_changes
      where
        request_id = 'f5000000-0000-4000-8000-00000000010b'
    ),
    'now',
    'the payload keeps the marker now, not the resolved instant'
  );

select
  ok (
    (
      select
        reason is null
      from
        app.costing_changes
      where
        request_id = 'f5000000-0000-4000-8000-00000000010b'
    ),
    'a now change needs no reason'
  );

select
  is (
    app.set_recipe_version (
      'f5000000-0000-4000-8000-00000000010b',
      'f5000000-0000-4000-8000-00000000003f',
      null,
      null,
      null,
      null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null,
      md5('dish|')
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'f5000000-0000-4000-8000-00000000010b'
    ),
    'a replay returns the stored result before the stale token is checked'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions
      where
        recipe_id = 'f5000000-0000-4000-8000-00000000003f'
    ),
    1::bigint,
    'a replay writes no version'
  );

select
  is (
    app.set_recipe_version (
      'f5000000-0000-4000-8000-0000000001f2',
      'f5000000-0000-4000-8000-000000000047',
      null,
      '2020-06-01 00:00:00+00',
      null,
      null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null,
      md5('dish|')
    ),
    '{"seeded":"older now replay"}'::jsonb,
    'an older now change replays after its end has passed, before any now-dependent check'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000114',
      'f5000000-0000-4000-8000-000000000047',
      null, '2020-06-01 00:00:00+00', null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'effective_to must be a finite timestamp after effective_from',
    'the same arguments under a new request id fail the now-dependent end check'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions
      where
        recipe_id = 'f5000000-0000-4000-8000-000000000047'
    ),
    0::bigint,
    'neither the replay nor the rejected request wrote a version'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000010b',
      'f5000000-0000-4000-8000-00000000003f',
      null, null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":2,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'request_id already used for a different change',
    'the same request id with different lines is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000010c',
      'f5000000-0000-4000-8000-00000000003f',
      null, null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":2,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '40001',
    'configuration changed',
    'a new request with a stale token is rejected'
  );

select
  is (
    jsonb_array_length(
      app.recipe_schedule ('f5000000-0000-4000-8000-00000000003f') -> 'versions'
    ),
    1,
    'recipe_schedule lists the version'
  );

select
  is (
    app.recipe_schedule ('f5000000-0000-4000-8000-00000000003f') -> 'versions' -> 0 -> 'lines' -> 0 ->> 'unit',
    'kg',
    'recipe_schedule lists the version lines with the resolved unit'
  );

select
  is (
    app.recipe_schedule ('f5000000-0000-4000-8000-00000000003f') ->> 'token',
    (
      select
        md5(
          'dish|' || v.id::text || '|' || to_char(
            v.effective_from at time zone 'UTC',
            'YYYY-MM-DD HH24:MI:SS.US'
          ) || '|||'
        )
      from
        app.recipe_versions v
      where
        v.recipe_id = 'f5000000-0000-4000-8000-00000000003f'
        and v.superseded_change_id is null
    ),
    'the token is the md5 of the kind prefix dish| and the version line'
  );

select
  isnt (
    app.recipe_schedule ('f5000000-0000-4000-8000-00000000003f') ->> 'token',
    (
      select
        md5(
          v.id::text || '|' || to_char(
            v.effective_from at time zone 'UTC',
            'YYYY-MM-DD HH24:MI:SS.US'
          ) || '|||'
        )
      from
        app.recipe_versions v
      where
        v.recipe_id = 'f5000000-0000-4000-8000-00000000003f'
        and v.superseded_change_id is null
    ),
    'the kind prefix is part of the populated token'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000010d',
      'f5000000-0000-4000-8000-000000000040',
      '2020-01-01 00:00:00+00', '2020-06-01 00:00:00+00', null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'reason is required for a backdated change',
    'an explicit earlier instant needs a reason'
  );

select
  throws_ok (
    format(
      $f$select app.set_recipe_version(
        'f5000000-0000-4000-8000-00000000010e',
        'f5000000-0000-4000-8000-000000000040',
        '2020-01-01 00:00:00+00', '2020-06-01 00:00:00+00', null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
        %L, md5('dish|')
      )$f$,
      repeat('x', 501)
    ),
    '22023',
    'reason must be at most 500 characters',
    'a reason over 500 characters is rejected'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000010f',
      'f5000000-0000-4000-8000-000000000040',
      '2020-01-01 00:00:00+00', '2020-06-01 00:00:00+00', null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      'تصحيح تاريخ', md5('dish|')
    )$$,
    'a backdated change with a reason is accepted'
  );

select
  is (
    (
      select
        reason
      from
        app.costing_changes
      where
        request_id = 'f5000000-0000-4000-8000-00000000010f'
    ),
    'تصحيح تاريخ',
    'the reason is stored with the change'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000110',
      'f5000000-0000-4000-8000-000000000041',
      '2035-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    'a future version is published'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000111',
      'f5000000-0000-4000-8000-000000000041',
      null, null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":2,"unit":"kg"}]'::jsonb,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000041') ->> 'token')
    )$$,
    '40001',
    'configuration changed',
    'the gap guard rejects an open end that would cover a later version'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000112',
      'f5000000-0000-4000-8000-000000000041',
      null, '2035-01-01 00:00:00+00', null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":2,"unit":"kg"}]'::jsonb,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000041') ->> 'token')
    )$$,
    'the gap guard accepts an end at the next version'
  );

select
  results_eq (
    $$select effective_from = date_trunc('minute', now()), effective_to
      from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-000000000041'
        and superseded_change_id is null
      order by effective_from$$,
    $$values (true, '2035-01-01 00:00:00+00'::timestamptz), (false, null::timestamptz)$$,
    'the now version fills the gap and the later version is untouched'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000113',
      'f5000000-0000-4000-8000-0000000009ff',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'unknown recipe id: f5000000-0000-4000-8000-0000000009ff',
    'publishing for an unknown recipe is rejected'
  );

-- ============================================================================
-- 3. Batch fields, payload allowlist and line rules
-- ============================================================================
select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000120',
      'f5000000-0000-4000-8000-000000000023',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    '22023',
    'a batch recipe version requires batch_qty and batch_unit',
    'a batch version without batch_qty is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000121',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'batch_qty and batch_unit are only for batch recipes',
    'a dish version with batch_qty is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000122',
      'f5000000-0000-4000-8000-000000000023',
      '2030-01-01 00:00:00+00', null, 1, 'no-such-unit',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    '22023',
    'unknown unit "no-such-unit" for batch_unit',
    'an unknown batch unit is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000123',
      'f5000000-0000-4000-8000-000000000023',
      '2030-01-01 00:00:00+00', null, 0, 'kg',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    '22023',
    'batch_qty must be finite and greater than 0',
    'a zero batch_qty is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000124',
      'f5000000-0000-4000-8000-000000000023',
      '2030-01-01 00:00:00+00', null, 1, 'kg', null,
      null, md5('batch|')
    )$$,
    '22023',
    'batch_qty and batch_unit must be null when lines is null',
    'a gap carries no batch fields'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000125',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null, '[]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'lines must not be empty; send null to leave a gap',
    'an empty lines array is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000126',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null, '{"quantity":1}'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'lines must be a json array',
    'lines must be an array'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000127',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg","note":"x"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'unknown key "note" in line 1',
    'an unknown line key is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000128',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg","price":3}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'price-like key "price" is not allowed in a recipe payload',
    'a price key is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000129',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":{"unit_cost":1},"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'price-like key "unit_cost" is not allowed in a recipe payload',
    'a price-like key is rejected at a nested level'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000012a',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg","amount":3}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'price-like key "amount" is not allowed in a recipe payload',
    'an amount key is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000012b',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg","LineCost":3}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'price-like key "LineCost" is not allowed in a recipe payload',
    'a key containing cost is rejected whatever its case'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000012c',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","child_recipe_id":"f5000000-0000-4000-8000-000000000023","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'line 1 needs exactly one of stock_item_id and child_recipe_id',
    'a line with two targets is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000012d',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'line 1 needs exactly one of stock_item_id and child_recipe_id',
    'a line with no target is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000012e',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":0,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'quantity in line 1 must be finite and greater than 0',
    'a zero quantity is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000012f',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"no-such-unit"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'unknown unit "no-such-unit" in line 1',
    'an unknown line unit is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000130',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000015","quantity":1,"unit":"piece"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'line 1: a packaging item cannot be a recipe leaf',
    'a packaging leaf is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000131',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000016","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'line 1: a fish_mixed item cannot be a recipe leaf',
    'a fish_mixed leaf is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000132',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000026","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'line 1: only a batch recipe can be a child',
    'a dish cannot be a child'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000133',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-0000000009ff","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '22023',
    'unknown stock_item id: f5000000-0000-4000-8000-0000000009ff in line 1',
    'an unknown stock item is rejected'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000134',
      'f5000000-0000-4000-8000-000000000044',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, 'wrong-token'
    )$$,
    '40001',
    'configuration changed',
    'a wrong expected token is rejected'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions
      where
        recipe_id in (
          'f5000000-0000-4000-8000-000000000021',
          'f5000000-0000-4000-8000-000000000023'
        )
    ),
    0::bigint,
    'no rejected publish left a version behind'
  );

-- ============================================================================
-- 4. Publication validation (cycles, depth, gaps, ancestors, marine, units)
-- ============================================================================
select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000140',
      'f5000000-0000-4000-8000-000000000025',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    'batch B is published'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000141',
      'f5000000-0000-4000-8000-000000000024',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000025","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    'batch A uses batch B'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000142',
      'f5000000-0000-4000-8000-000000000025',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000024","quantity":1,"unit":"kg"}]'::jsonb,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000025') ->> 'token')
    )$$,
    '%would be invalid%cycle%',
    'A to B to A is rejected at save'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000143',
      'f5000000-0000-4000-8000-000000000024',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000024","quantity":1,"unit":"kg"}]'::jsonb,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000024') ->> 'token')
    )$$,
    '%would be invalid%cycle%',
    'a recipe using itself is rejected at save'
  );

select
  is (
    (
      select
        count(*)
      from
        app.costing_changes
      where
        request_id in (
          'f5000000-0000-4000-8000-000000000142',
          'f5000000-0000-4000-8000-000000000143'
        )
    ),
    0::bigint,
    'a rejected cycle leaves no costing change'
  );

select
  lives_ok (
    $t$do $b$
    declare
      k integer;
    begin
      for k in reverse 8..1 loop
        perform app.set_recipe_version(
          gen_random_uuid(),
          ('f5000000-0000-4000-8000-0000000000' || to_hex(47 + k))::uuid,
          '2030-01-01 00:00:00+00', null, 1, 'kg',
          case
            when k = 8 then jsonb_build_array(jsonb_build_object(
              'stock_item_id', 'f5000000-0000-4000-8000-000000000012',
              'quantity', 1, 'unit', 'kg'))
            else jsonb_build_array(jsonb_build_object(
              'child_recipe_id', 'f5000000-0000-4000-8000-0000000000' || to_hex(48 + k),
              'quantity', 1, 'unit', 'kg'))
          end,
          null, md5('batch|')
        );
      end loop;
      perform app.set_recipe_version(
        gen_random_uuid(), 'f5000000-0000-4000-8000-000000000028'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000030","quantity":1,"unit":"kg"}]'::jsonb,
        null, md5('dish|')
      );
    end
    $b$;$t$,
    'a dish nested eight batches deep is accepted'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000144',
      'f5000000-0000-4000-8000-000000000038',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    'the ninth batch is published on its own'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000145',
      'f5000000-0000-4000-8000-000000000037',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000038","quantity":1,"unit":"kg"}]'::jsonb,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000037') ->> 'token')
    )$$,
    '%recipe "طبق عمق" would be invalid%depth_exceeded%',
    'a ninth level is rejected and the invalidated ancestor is named'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000146',
      'f5000000-0000-4000-8000-00000000003d',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000011","quantity":0.1,"unit":"kg"}]'::jsonb,
      null, md5('cooking|')
    )$$,
    '%cooking_marine%',
    'a cooking recipe with a seafood leaf is rejected'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000147',
      'f5000000-0000-4000-8000-00000000003d',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000017","quantity":0.1,"unit":"kg"}]'::jsonb,
      null, md5('cooking|')
    )$$,
    '%cooking_marine%',
    'a cooking recipe with a fish_size leaf is rejected'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000148',
      'f5000000-0000-4000-8000-00000000003e',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000011","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    'a batch may hold a marine item'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000149',
      'f5000000-0000-4000-8000-00000000003d',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"child_recipe_id":"f5000000-0000-4000-8000-00000000003e","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('cooking|')
    )$$,
    '%cooking_marine%',
    'a cooking recipe reaching a marine leaf through a batch is rejected'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000014a',
      'f5000000-0000-4000-8000-00000000003a',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    'the child batch is published'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000014b',
      'f5000000-0000-4000-8000-000000000039',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"child_recipe_id":"f5000000-0000-4000-8000-00000000003a","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    'the parent dish is published'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000014c',
      'f5000000-0000-4000-8000-00000000003a',
      '2031-01-01 00:00:00+00', null, null, null, null,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-00000000003a') ->> 'token')
    )$$,
    '%recipe "طبق أصل" would be invalid%no_version_in_force%',
    'republishing a child with a gap invalidates the ancestor, which is named'
  );

select
  results_eq (
    $$select effective_from, effective_to
      from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-00000000003a'
        and superseded_change_id is null$$,
    $$values ('2030-01-01 00:00:00+00'::timestamptz, null::timestamptz)$$,
    'the rejected republish left the child schedule unchanged'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000014d',
      'f5000000-0000-4000-8000-00000000003c',
      '2030-01-01 00:00:00+00', '2030-06-01 00:00:00+00', 1, 'kg',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    'a child with a bounded version is published'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000014e',
      'f5000000-0000-4000-8000-00000000003b',
      '2030-01-01 00:00:00+00', '2030-09-01 00:00:00+00', null, null,
      '[{"child_recipe_id":"f5000000-0000-4000-8000-00000000003c","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '%recipe "أصل ثان" would be invalid%no_version_in_force%',
    'a child gap inside the parent interval is rejected'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-00000000014f',
      'f5000000-0000-4000-8000-00000000003b',
      '2030-01-01 00:00:00+00', '2030-06-01 00:00:00+00', null, null,
      '[{"child_recipe_id":"f5000000-0000-4000-8000-00000000003c","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    'a parent interval inside the child coverage is accepted'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000153',
      'f5000000-0000-4000-8000-000000000049',
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('batch|')
    )$$,
    'the child of a late ancestor is published from 2030-01-01'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000154',
      'f5000000-0000-4000-8000-000000000048',
      '2030-06-01 00:00:00+00', null, null, null,
      '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000049","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    'the ancestor starts later, on 2030-06-01'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000155',
      'f5000000-0000-4000-8000-000000000049',
      '2030-05-01 00:00:00+00', '2030-09-01 00:00:00+00', null, null, null,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000049') ->> 'token')
    )$$,
    '%recipe "طبق لاحق" would be invalid at 2030-06-01T00:00:00.000000Z: no_version_in_force in recipe "ابن لاحق"%',
    'a gap that reaches an ancestor starting after the change start is rejected at that start'
  );

select
  results_eq (
    $$select effective_from, effective_to
      from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-000000000049'
        and superseded_change_id is null$$,
    $$values ('2030-01-01 00:00:00+00'::timestamptz, null::timestamptz)$$,
    'the rejected gap left the child schedule unchanged'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000156',
      'f5000000-0000-4000-8000-000000000049',
      '2030-05-01 00:00:00+00', '2030-06-01 00:00:00+00', null, null, null,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000049') ->> 'token')
    )$$,
    'a gap that ends exactly when the ancestor starts is accepted'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions
      where
        recipe_id = 'f5000000-0000-4000-8000-000000000049'
        and superseded_change_id is null
    ),
    2::bigint,
    'the accepted gap split the child into two current versions'
  );

-- ============================================================================
-- 5. Expansion fixtures, published in one go
-- ============================================================================
select
  lives_ok (
    $t$do $b$
    begin
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-000000000023'::uuid,
        '2030-01-01 00:00:00+00', null, 2, 'kg',
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":0.2,"unit":"kg"},
          {"stock_item_id":"f5000000-0000-4000-8000-000000000018","quantity":0.4,"unit":"kg"}]'::jsonb,
        null, md5('batch|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-000000000026'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000023","quantity":250,"unit":"g"}]'::jsonb,
        null, md5('dish|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-000000000045'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000011","quantity":90,"unit":"g"}]'::jsonb,
        null, md5('dish|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-000000000022'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":0.05,"unit":"kg"},
          {"stock_item_id":"f5000000-0000-4000-8000-000000000013","quantity":0.1,"unit":"liter"}]'::jsonb,
        null, md5('cooking|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-000000000029'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000014","quantity":1,"unit":"kg"}]'::jsonb,
        null, md5('dish|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-00000000002a'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000019","quantity":0.0000001,"unit":"kg"}]'::jsonb,
        null, md5('dish|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-00000000002b'::uuid,
        '2030-01-01 00:00:00+00', '2030-07-01 00:00:00+00', null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
        null, md5('dish|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-00000000002b'::uuid,
        '2030-07-01 00:00:00+00', null, null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":2,"unit":"kg"}]'::jsonb,
        null, (select app.recipe_schedule('f5000000-0000-4000-8000-00000000002b') ->> 'token'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-00000000002c'::uuid,
        '2030-01-01 00:00:00+00', null, 1, 'kg',
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":0.0000004,"unit":"kg"}]'::jsonb,
        null, md5('batch|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-00000000002d'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":0.0000004,"unit":"kg"},
          {"child_recipe_id":"f5000000-0000-4000-8000-00000000002c","quantity":1,"unit":"kg"}]'::jsonb,
        null, md5('dish|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-00000000002e'::uuid,
        '2030-01-01 00:00:00+00', null, 1, 'liter',
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000013","quantity":1,"unit":"liter"}]'::jsonb,
        null, md5('batch|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-00000000002f'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"child_recipe_id":"f5000000-0000-4000-8000-00000000002e","quantity":250,"unit":"ml"}]'::jsonb,
        null, md5('dish|'));
      perform app.set_recipe_version(gen_random_uuid(),
        'f5000000-0000-4000-8000-000000000046'::uuid,
        '2030-01-01 00:00:00+00', null, null, null,
        '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"piece"}]'::jsonb,
        null, md5('dish|'));
    end
    $b$;$t$,
    'the expansion fixtures are published'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000150',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000023","quantity":1,"unit":"liter"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '%unit_not_convertible%',
    'a batch line in a volume unit for a mass batch is rejected'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000151',
      'f5000000-0000-4000-8000-000000000021',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"child_recipe_id":"f5000000-0000-4000-8000-000000000023","quantity":1,"unit":"piece"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '%unit_not_convertible%',
    'a batch line in a count unit is rejected'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000152',
      'f5000000-0000-4000-8000-000000000044',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-00000000001a","quantity":1,"unit":"kg"},
        {"stock_item_id":"f5000000-0000-4000-8000-000000000017","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    'an inactive stock item and a fish_size item are allowed as leaves'
  );

-- ============================================================================
-- 6. Supersede and fragments
-- ============================================================================
select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000160',
      'f5000000-0000-4000-8000-000000000042',
      '2030-01-01 00:00:00+00', '2030-05-01 00:00:00+00', null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    'version one is published'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000161',
      'f5000000-0000-4000-8000-000000000042',
      '2030-07-01 00:00:00+00', '2030-10-01 00:00:00+00', null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":3,"unit":"kg"}]'::jsonb,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000042') ->> 'token')
    )$$,
    'version three leaves a gap before it'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000162',
      'f5000000-0000-4000-8000-000000000042',
      '2030-02-01 00:00:00+00', '2030-03-01 00:00:00+00', null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":2,"unit":"kg"}]'::jsonb,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000042') ->> 'token')
    )$$,
    'a version in the middle of version one is published'
  );

select
  results_eq (
    $$select v.effective_from, v.effective_to, l.quantity
      from app.recipe_versions v
      join app.recipe_lines l on l.version_id = v.id
      where v.recipe_id = 'f5000000-0000-4000-8000-000000000042'
        and v.superseded_change_id is null
      order by v.effective_from$$,
    $$values
      ('2030-01-01 00:00:00+00'::timestamptz, '2030-02-01 00:00:00+00'::timestamptz, 1::numeric),
      ('2030-02-01 00:00:00+00', '2030-03-01 00:00:00+00', 2),
      ('2030-03-01 00:00:00+00', '2030-05-01 00:00:00+00', 1),
      ('2030-07-01 00:00:00+00', '2030-10-01 00:00:00+00', 3)$$,
    'the edit splits version one into two fragments with copied lines around the new version'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions
      where
        recipe_id = 'f5000000-0000-4000-8000-000000000042'
        and superseded_change_id is not null
    ),
    1::bigint,
    'only the replaced version was superseded'
  );

select
  is (
    (
      select
        created_change_id
      from
        app.recipe_versions
      where
        recipe_id = 'f5000000-0000-4000-8000-000000000042'
        and effective_from = '2030-07-01 00:00:00+00'
        and superseded_change_id is null
    ),
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'f5000000-0000-4000-8000-000000000161'
    ),
    'the later version was not rewritten'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions
      where
        recipe_id = 'f5000000-0000-4000-8000-000000000042'
        and superseded_change_id is null
        and valid_during @> '2030-06-01 00:00:00+00'::timestamptz
    ),
    0::bigint,
    'the gap between the versions stays a gap'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000163',
      'f5000000-0000-4000-8000-000000000042',
      '2030-03-15 00:00:00+00', '2030-04-01 00:00:00+00', null, null, null,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000042') ->> 'token')
    )$$,
    'null lines punch a gap into a version'
  );

select
  results_eq (
    $$select effective_from, effective_to
      from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-000000000042'
        and superseded_change_id is null
        and effective_from >= '2030-03-01 00:00:00+00'
      order by effective_from$$,
    $$values
      ('2030-03-01 00:00:00+00'::timestamptz, '2030-03-15 00:00:00+00'::timestamptz),
      ('2030-04-01 00:00:00+00', '2030-05-01 00:00:00+00'),
      ('2030-07-01 00:00:00+00', '2030-10-01 00:00:00+00')$$,
    'the gap removes only its own interval'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000042',
      1,
      'portion',
      '2030-03-20 00:00:00+00'
    ) -> 'issues' -> 0 ->> 'code',
    'no_version_in_force',
    'a gap blocks an expansion'
  );

-- ============================================================================
-- 7. expand_recipe
-- ============================================================================
select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000045',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements' -> 0 ->> 'quantity',
    '0.100000',
    '90 g net at 10 percent loss needs 0.100000 kg'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000045',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements',
    '[{"stock_item_id":"f5000000-0000-4000-8000-000000000011","base_unit":"kg","quantity":0.1}]'::jsonb,
    'the requirement names the item and its base unit'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000045',
      3,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements' -> 0 ->> 'quantity',
    '0.300000',
    'three portions scale the requirement'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000045',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) ->> 'status',
    'ready',
    'a fully costed expansion is ready'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000026',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements',
    '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","base_unit":"kg","quantity":0.025},
      {"stock_item_id":"f5000000-0000-4000-8000-000000000018","base_unit":"kg","quantity":0.0625}]'::jsonb,
    'a dish using 250 g of a 2 kg batch needs one eighth of each batch line, loss applied at the leaf'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000026',
      1,
      'portion',
      '2031-06-01 00:00:00+00'
    ) -> 'requirements' -> 1 ->> 'quantity',
    '0.100000',
    'the loss in force at p_at is used: 0.5 from 2031'
  );

select
  is (
    jsonb_array_length(
      app.expand_recipe (
        'f5000000-0000-4000-8000-000000000026',
        1,
        'portion',
        '2030-06-01 00:00:00+00'
      ) -> 'provenance' -> 'versions'
    ),
    2,
    'provenance lists the dish and the batch version'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000026',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'provenance' ->> 'algorithm_version',
    '1',
    'provenance carries the algorithm version'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000026',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'provenance' ->> 'at',
    '2030-06-01T00:00:00.000000Z',
    'provenance carries the instant in UTC'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000023',
      1,
      'kg',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements',
    '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","base_unit":"kg","quantity":0.1},
      {"stock_item_id":"f5000000-0000-4000-8000-000000000018","base_unit":"kg","quantity":0.25}]'::jsonb,
    'a batch expands per its own batch quantity'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000023',
      500,
      'g',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements',
    '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","base_unit":"kg","quantity":0.05},
      {"stock_item_id":"f5000000-0000-4000-8000-000000000018","base_unit":"kg","quantity":0.125}]'::jsonb,
    'a batch accepts a same-dimension metric unit'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000022',
      1.5,
      'kg',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements',
    '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","base_unit":"kg","quantity":0.075},
      {"stock_item_id":"f5000000-0000-4000-8000-000000000013","base_unit":"kg","quantity":0.138}]'::jsonb,
    'a cooking recipe per 1 kg asked for 1.5 kg, with a liter to kg conversion'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000022',
      1500,
      'g',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements',
    '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","base_unit":"kg","quantity":0.075},
      {"stock_item_id":"f5000000-0000-4000-8000-000000000013","base_unit":"kg","quantity":0.138}]'::jsonb,
    'a cooking recipe accepts grams'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-00000000002f',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements',
    '[{"stock_item_id":"f5000000-0000-4000-8000-000000000013","base_unit":"kg","quantity":0.23}]'::jsonb,
    '250 ml of a liter batch converts through the item conversion'
  );

select
  results_eq (
    $$select
        r ->> 'status',
        r -> 'issues' -> 0 ->> 'code',
        r -> 'issues' -> 0 ->> 'stock_item_id',
        r -> 'requirements'
      from (
        select app.expand_recipe(
          'f5000000-0000-4000-8000-000000000029', 1, 'portion',
          '2030-06-01 00:00:00+00'
        ) as r
      ) x$$,
    $$values (
      'blocked'::text,
      'loss_not_set'::text,
      'f5000000-0000-4000-8000-000000000014'::text,
      'null'::jsonb
    )$$,
    'an item without a loss blocks the expansion and requirements is null, not empty'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000027',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'issues' -> 0 ->> 'code',
    'no_version_in_force',
    'a recipe with no version is blocked'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-00000000002b',
      1,
      'portion',
      '2029-12-31 23:59:59+00'
    ) ->> 'status',
    'blocked',
    'asking before the first version is blocked'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-00000000002b',
      1,
      'portion',
      '2030-06-30 23:59:59+00'
    ) -> 'requirements' -> 0 ->> 'quantity',
    '1.000000',
    'the earlier version applies just before the boundary'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-00000000002b',
      1,
      'portion',
      '2030-07-01 00:00:00+00'
    ) -> 'requirements' -> 0 ->> 'quantity',
    '2.000000',
    'the later version applies from the boundary'
  );

select
  results_eq (
    $$select
        r ->> 'status',
        r -> 'issues' -> 0 ->> 'code',
        r -> 'requirements'
      from (
        select app.expand_recipe(
          'f5000000-0000-4000-8000-00000000002a', 1, 'portion',
          '2030-06-01 00:00:00+00'
        ) as r
      ) x$$,
    $$values ('blocked'::text, 'below_precision'::text, 'null'::jsonb)$$,
    'a positive aggregate that rounds to zero is below_precision and blocks'
  );

select
  results_eq (
    $$select
        r ->> 'status',
        jsonb_array_length(r -> 'requirements'),
        r -> 'requirements' -> 0 ->> 'quantity',
        jsonb_array_length(r -> 'provenance' -> 'paths')
      from (
        select app.expand_recipe(
          'f5000000-0000-4000-8000-00000000002d', 1, 'portion',
          '2030-06-01 00:00:00+00'
        ) as r
      ) x$$,
    $$values ('ready'::text, 1, '0.000001'::text, 2)$$,
    'two paths to one item are summed before the single rounding'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000046',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'issues' -> 0 ->> 'code',
    'unit_not_convertible',
    'a line unit with no conversion blocks the expansion'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000021',
      1,
      'kg',
      '2030-06-01 00:00:00+00'
    ) -> 'issues' -> 0 ->> 'code',
    'invalid_output_unit',
    'a dish asked in kg is an invalid output unit'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000022',
      1,
      'portion',
      '2030-06-01 00:00:00+00'
    ) -> 'issues' -> 0 ->> 'code',
    'invalid_output_unit',
    'a cooking recipe asked in portions is an invalid output unit'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000023',
      1,
      'liter',
      '2030-06-01 00:00:00+00'
    ) -> 'issues' -> 0 ->> 'code',
    'invalid_output_unit',
    'a batch asked in another dimension is an invalid output unit'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-000000000022',
      1,
      'no-such-unit',
      '2030-06-01 00:00:00+00'
    ) -> 'requirements',
    'null'::jsonb,
    'an unknown output unit blocks with null requirements'
  );

select
  throws_ok (
    $$select app.expand_recipe(
      'f5000000-0000-4000-8000-000000000045', 0, 'portion',
      '2030-06-01 00:00:00+00'
    )$$,
    '22023',
    'output_qty must be finite and greater than 0',
    'a zero output quantity is rejected'
  );

select
  throws_ok (
    $$select app.expand_recipe(
      'f5000000-0000-4000-8000-0000000009ff', 1, 'portion',
      '2030-06-01 00:00:00+00'
    )$$,
    '22023',
    'unknown recipe id: f5000000-0000-4000-8000-0000000009ff',
    'expanding an unknown recipe is rejected'
  );

-- ============================================================================
-- 8. Non-owner, internal helpers and privileges
-- ============================================================================
select
  throws_ok (
    $$select app.recipe_expand_exact(
      'f5000000-0000-4000-8000-000000000045', '2030-06-01 00:00:00+00', 1
    )$$,
    '42501',
    null::text,
    'the owner cannot call the internal expansion through the API role'
  );

select
  throws_ok (
    $$select app.recipe_walk(
      'f5000000-0000-4000-8000-000000000045', '2030-06-01 00:00:00+00', 1, false
    )$$,
    '42501',
    null::text,
    'the owner cannot call the internal walk through the API role'
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

select
  throws_ok (
    $$select app.create_recipe(
      'f5000000-0000-4000-8000-000000000190', 'وصفة غريبة', 'dish'
    )$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot create a recipe'
  );

select
  throws_ok (
    $$select app.update_recipe(
      'f5000000-0000-4000-8000-000000000191',
      'f5000000-0000-4000-8000-000000000021',
      'اسم', true, 'طبق أول', true
    )$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot update a recipe'
  );

select
  throws_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-000000000192',
      'f5000000-0000-4000-8000-000000000021',
      '2090-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot publish a version'
  );

select
  throws_ok (
    $$select app.recipe_schedule('f5000000-0000-4000-8000-000000000042')$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot read a recipe schedule'
  );

select
  throws_ok (
    $$select app.expand_recipe(
      'f5000000-0000-4000-8000-000000000045', 1, 'portion',
      '2030-06-01 00:00:00+00'
    )$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot expand a recipe'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipes
    ),
    0::bigint,
    'a non-owner sees no recipes'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_versions
    ),
    0::bigint,
    'a non-owner sees no recipe versions'
  );

select
  is (
    (
      select
        count(*)
      from
        app.recipe_lines
    ),
    0::bigint,
    'a non-owner sees no recipe lines'
  );

reset role;

select
  is_empty (
    $$select c.relname, r.role, p.privilege
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      cross join (
        values ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')
      ) as p(privilege)
      where n.nspname = 'app'
        and c.relname in ('recipes', 'recipe_versions', 'recipe_lines')
        and has_table_privilege(r.role, c.oid, p.privilege)$$,
    'no API role can write the recipe tables'
  );

select
  results_eq (
    $$select c.relname::text collate "default", r.role
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      where n.nspname = 'app'
        and c.relname in ('recipes', 'recipe_versions', 'recipe_lines')
        and has_table_privilege(r.role, c.oid, 'select')
      order by 1, 2$$,
    $$values
      ('recipe_lines'::text, 'authenticated'::text),
      ('recipe_lines', 'service_role'),
      ('recipe_versions', 'authenticated'),
      ('recipe_versions', 'service_role'),
      ('recipes', 'authenticated'),
      ('recipes', 'service_role')$$,
    'only authenticated and service_role can select the recipe tables'
  );

select
  is_empty (
    $$select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app'
        and c.relname in ('recipes', 'recipe_versions', 'recipe_lines')
        and not c.relrowsecurity$$,
    'row level security is on for every recipe table'
  );

select
  results_eq (
    $$select p.proname::text collate "default", r.role
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      where n.nspname = 'app'
        and p.proname in (
          'create_recipe', 'update_recipe', 'set_recipe_version',
          'recipe_schedule', 'expand_recipe'
        )
        and has_function_privilege(r.role, p.oid, 'execute')
      order by 1, 2$$,
    $$values
      ('create_recipe'::text, 'authenticated'::text),
      ('expand_recipe', 'authenticated'),
      ('recipe_schedule', 'authenticated'),
      ('set_recipe_version', 'authenticated'),
      ('update_recipe', 'authenticated')$$,
    'the recipe writers and readers are executable by authenticated only'
  );

select
  is_empty (
    $$select p.proname, r.role
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r(role)
      where n.nspname = 'app'
        and p.proname in (
          'recipe_schedule_line', 'recipe_schedule_token', 'recipe_unit_factor',
          'recipe_payload_assert_no_price_keys', 'recipe_lines_normalize',
          'recipe_walk', 'recipe_expand_exact', 'recipe_validate_publication',
          'trg_recipes_guard', 'trg_recipe_versions_batch_fields',
          'trg_recipe_lines_target', 'trg_recipe_lines_immutable'
        )
        and has_function_privilege(r.role, p.oid, 'execute')$$,
    'no API role can execute an internal recipe helper'
  );

select
  is_empty (
    $$select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and (
          p.proname like 'recipe\_%'
          or p.proname like 'trg\_recipe%'
          or p.proname in ('create_recipe', 'update_recipe', 'set_recipe_version', 'expand_recipe')
        )
        and not exists (
          select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as c(setting)
          where c.setting in ('search_path=""', 'search_path=')
        )$$,
    'every recipe function pins an empty search_path'
  );

select
  is_empty (
    $$select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and (
          p.proname like 'recipe\_%'
          or p.proname like 'trg\_recipe%'
          or p.proname in ('create_recipe', 'update_recipe', 'set_recipe_version', 'expand_recipe')
        )
        and coalesce(obj_description(p.oid, 'pg_proc'), '') = ''$$,
    'every recipe function and trigger function carries a comment'
  );

select
  results_eq (
    $$select p.proname::text collate "default", p.prosecdef
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in (
          'create_recipe', 'update_recipe', 'set_recipe_version',
          'recipe_schedule', 'expand_recipe'
        )
      order by 1$$,
    $$values
      ('create_recipe'::text, true),
      ('expand_recipe', true),
      ('recipe_schedule', false),
      ('set_recipe_version', true),
      ('update_recipe', true)$$,
    'writers and expand_recipe are definers; recipe_schedule reads as the caller'
  );

-- ============================================================================
-- 9. Immutability and table constraints, as the table owner
-- ============================================================================
select
  throws_ok (
    $$update app.recipe_lines set quantity = 5 where version_id is not null$$,
    '55000',
    'app.recipe_lines is immutable; UPDATE is not allowed',
    'recipe lines cannot be updated'
  );

select
  throws_ok (
    $$delete from app.recipe_lines$$,
    '55000',
    'app.recipe_lines is immutable; DELETE is not allowed',
    'recipe lines cannot be deleted'
  );

select
  throws_ok (
    $$truncate table app.recipe_lines$$,
    '55000',
    null::text,
    'recipe lines cannot be truncated'
  );

select
  throws_ok (
    $$update app.recipe_versions set effective_to = '2040-01-01 00:00:00+00'
      where effective_to is null$$,
    '55000',
    null::text,
    'a version payload cannot be updated'
  );

select
  throws_ok (
    $$delete from app.recipe_versions$$,
    '55000',
    null::text,
    'recipe versions cannot be deleted'
  );

select
  throws_ok (
    $$truncate table app.recipe_versions cascade$$,
    '55000',
    null::text,
    'recipe versions cannot be truncated'
  );

select
  throws_ok (
    $$update app.recipes set kind = 'batch' where name = 'طبق أول'$$,
    '55000',
    'app.recipes id, kind, and created_change_id are immutable',
    'a recipe kind cannot change'
  );

select
  lives_ok (
    $$update app.recipes set name = 'طبق أول معدل', active = false where name = 'طبق أول'$$,
    'a recipe name and active flag can change'
  );

select
  throws_ok (
    $$delete from app.recipes$$,
    '55000',
    null::text,
    'recipes cannot be deleted'
  );

select
  throws_ok (
    $$truncate table app.recipes cascade$$,
    '55000',
    null::text,
    'recipes cannot be truncated'
  );

select
  throws_ok (
    $$insert into app.recipe_versions (
        effective_from, effective_to, created_change_id, recipe_id
      ) values (
        '2030-07-15 00:00:00+00', '2030-08-01 00:00:00+00',
        (select id from app.costing_changes where request_id = 'f5000000-0000-4000-8000-0000000001f1'),
        'f5000000-0000-4000-8000-000000000042'
      )$$,
    '23P01',
    null::text,
    'the exclusion constraint blocks an overlapping current version'
  );

select
  throws_ok (
    $$insert into app.recipe_versions (
        effective_from, created_change_id, recipe_id
      ) values (
        '2040-01-01 00:00:00+00',
        (select id from app.costing_changes where request_id = 'f5000000-0000-4000-8000-0000000001f1'),
        'f5000000-0000-4000-8000-000000000023'
      )$$,
    '23514',
    'a batch recipe version requires batch_qty and batch_unit',
    'a batch version row needs its batch fields'
  );

select
  throws_ok (
    $$insert into app.recipe_versions (
        effective_from, created_change_id, recipe_id, batch_qty, batch_unit
      ) values (
        '2040-01-01 00:00:00+00',
        (select id from app.costing_changes where request_id = 'f5000000-0000-4000-8000-0000000001f1'),
        'f5000000-0000-4000-8000-000000000042', 1, 'kg'
      )$$,
    '23514',
    'only a batch recipe version carries batch_qty and batch_unit',
    'a non-batch version row cannot carry batch fields'
  );

select
  throws_ok (
    $$insert into app.recipe_versions (
        effective_from, created_change_id, recipe_id, batch_qty
      ) values (
        '2040-01-01 00:00:00+00',
        (select id from app.costing_changes where request_id = 'f5000000-0000-4000-8000-0000000001f1'),
        'f5000000-0000-4000-8000-000000000023', 1
      )$$,
    '23514',
    null::text,
    'batch_qty and batch_unit come as a pair'
  );

select
  throws_ok (
    $$insert into app.recipe_versions (
        effective_from, effective_to, created_change_id, recipe_id
      ) values (
        '2040-01-01 00:00:00+00', '2040-01-01 00:00:00+00',
        (select id from app.costing_changes where request_id = 'f5000000-0000-4000-8000-0000000001f1'),
        'f5000000-0000-4000-8000-000000000042'
      )$$,
    '23514',
    null::text,
    'a version cannot end where it starts'
  );

select
  throws_ok (
    $$insert into app.recipe_lines (version_id, line_no, quantity, unit)
      select id, 9, 1, 'kg' from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-000000000042' limit 1$$,
    '23514',
    null::text,
    'a line needs a target'
  );

select
  throws_ok (
    $$insert into app.recipe_lines (version_id, line_no, stock_item_id, quantity, unit)
      select id, 1, 'f5000000-0000-4000-8000-000000000012', 1, 'kg'
      from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-000000000042' limit 1$$,
    '23505',
    null::text,
    'a line number is unique inside a version'
  );

select
  throws_ok (
    $$insert into app.recipe_lines (version_id, line_no, stock_item_id, quantity, unit)
      select id, 9, 'f5000000-0000-4000-8000-000000000012', 'Infinity'::numeric, 'kg'
      from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-000000000042' limit 1$$,
    '23514',
    null::text,
    'a line quantity must be finite'
  );

select
  throws_ok (
    $$insert into app.recipe_lines (version_id, line_no, stock_item_id, quantity, unit)
      select id, 9, 'f5000000-0000-4000-8000-000000000015', 1, 'piece'
      from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-000000000042' limit 1$$,
    '23514',
    'packaging and fish_mixed items cannot be recipe leaves',
    'the table refuses a packaging leaf'
  );

select
  throws_ok (
    $$insert into app.recipe_lines (version_id, line_no, child_recipe_id, quantity, unit)
      select id, 9, 'f5000000-0000-4000-8000-000000000026', 1, 'kg'
      from app.recipe_versions
      where recipe_id = 'f5000000-0000-4000-8000-000000000042' limit 1$$,
    '23514',
    'only a batch recipe can be a child of a recipe line',
    'the table refuses a dish as a child'
  );

-- ============================================================================
-- 10. Runtime guards: a cycle or a ninth level that bypassed the writer
-- ============================================================================
update app.recipe_versions
set
  superseded_change_id = (
    select
      id
    from
      app.costing_changes
    where
      request_id = 'f5000000-0000-4000-8000-0000000001f1'
  )
where
  recipe_id = 'f5000000-0000-4000-8000-000000000025'
  and superseded_change_id is null;

insert into
  app.recipe_versions (
    id,
    effective_from,
    created_change_id,
    recipe_id,
    batch_qty,
    batch_unit
  )
select
  'f5000000-0000-4000-8000-000000000c01',
  '2030-01-01 00:00:00+00',
  c.id,
  'f5000000-0000-4000-8000-000000000025',
  1,
  'kg'
from
  app.costing_changes c
where
  c.request_id = 'f5000000-0000-4000-8000-0000000001f1';

insert into
  app.recipe_lines (
    version_id,
    line_no,
    child_recipe_id,
    quantity,
    unit
  )
values
  (
    'f5000000-0000-4000-8000-000000000c01',
    1,
    'f5000000-0000-4000-8000-000000000024',
    1,
    'kg'
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

select
  results_eq (
    $$select
        r ->> 'status',
        r -> 'issues' -> 0 ->> 'code',
        r -> 'requirements'
      from (
        select app.expand_recipe(
          'f5000000-0000-4000-8000-000000000024', 1, 'kg',
          '2030-06-01 00:00:00+00'
        ) as r
      ) x$$,
    $$values ('blocked'::text, 'cycle'::text, 'null'::jsonb)$$,
    'a cycle found at run time blocks the expansion instead of looping'
  );

update app.recipe_versions
set
  superseded_change_id = (
    select
      id
    from
      app.costing_changes
    where
      request_id = 'f5000000-0000-4000-8000-0000000001f1'
  )
where
  recipe_id = 'f5000000-0000-4000-8000-000000000037'
  and superseded_change_id is null;

insert into
  app.recipe_versions (
    id,
    effective_from,
    created_change_id,
    recipe_id,
    batch_qty,
    batch_unit
  )
select
  'f5000000-0000-4000-8000-000000000c02',
  '2030-01-01 00:00:00+00',
  c.id,
  'f5000000-0000-4000-8000-000000000037',
  1,
  'kg'
from
  app.costing_changes c
where
  c.request_id = 'f5000000-0000-4000-8000-0000000001f1';

insert into
  app.recipe_lines (
    version_id,
    line_no,
    child_recipe_id,
    quantity,
    unit
  )
values
  (
    'f5000000-0000-4000-8000-000000000c02',
    1,
    'f5000000-0000-4000-8000-000000000038',
    1,
    'kg'
  );

select
  results_eq (
    $$select
        r ->> 'status',
        r -> 'issues' -> 0 ->> 'code',
        r -> 'requirements'
      from (
        select app.expand_recipe(
          'f5000000-0000-4000-8000-000000000028', 1, 'portion',
          '2030-06-01 00:00:00+00'
        ) as r
      ) x$$,
    $$values ('blocked'::text, 'depth_exceeded'::text, 'null'::jsonb)$$,
    'a ninth level found at run time blocks the expansion instead of truncating'
  );

insert into
  app.recipe_versions (
    id,
    effective_from,
    effective_to,
    created_change_id,
    recipe_id,
    batch_qty,
    batch_unit
  )
select
  'f5000000-0000-4000-8000-000000000c03',
  '2030-01-01 00:00:00+00',
  '2030-03-01 00:00:00+00',
  c.id,
  'f5000000-0000-4000-8000-00000000004b',
  1,
  'kg'
from
  app.costing_changes c
where
  c.request_id = 'f5000000-0000-4000-8000-0000000001f1';

insert into
  app.recipe_lines (
    version_id,
    line_no,
    stock_item_id,
    quantity,
    unit
  )
values
  (
    'f5000000-0000-4000-8000-000000000c03',
    1,
    'f5000000-0000-4000-8000-000000000012',
    1,
    'kg'
  );

insert into
  app.recipe_versions (id, effective_from, created_change_id, recipe_id)
select
  'f5000000-0000-4000-8000-000000000c04',
  '2030-01-01 00:00:00+00',
  c.id,
  'f5000000-0000-4000-8000-00000000004a'
from
  app.costing_changes c
where
  c.request_id = 'f5000000-0000-4000-8000-0000000001f1';

insert into
  app.recipe_lines (
    version_id,
    line_no,
    child_recipe_id,
    quantity,
    unit
  )
values
  (
    'f5000000-0000-4000-8000-000000000c04',
    1,
    'f5000000-0000-4000-8000-00000000004b',
    1,
    'kg'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-00000000004a',
      1,
      'portion',
      '2030-02-01 00:00:00+00'
    ) ->> 'status',
    'ready',
    'the injected parent expands while its child has a version in force'
  );

select
  results_eq (
    $$select
        r ->> 'status',
        r -> 'issues' -> 0 ->> 'code',
        r -> 'issues' -> 0 ->> 'recipe_id',
        r -> 'requirements'
      from (
        select app.expand_recipe(
          'f5000000-0000-4000-8000-00000000004a', 1, 'portion',
          '2030-06-01 00:00:00+00'
        ) as r
      ) x$$,
    $$values (
      'blocked'::text,
      'no_version_in_force'::text,
      'f5000000-0000-4000-8000-00000000004b'::text,
      'null'::jsonb
    )$$,
    'a child with no version at p_at blocks the expansion and names the child'
  );

select
  is (
    app.expand_recipe (
      'f5000000-0000-4000-8000-00000000004a',
      1,
      'portion',
      '2030-03-01 00:00:00+00'
    ) -> 'issues' -> 0 ->> 'code',
    'no_version_in_force',
    'the child end is exclusive: asking at its end instant is blocked'
  );

-- ============================================================================
-- 11. Stock item identity freeze
-- ============================================================================
select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-0000000001a0',
      'f5000000-0000-4000-8000-000000000043',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-00000000001b","quantity":1,"unit":"kg"}]'::jsonb,
      null, md5('dish|')
    )$$,
    'a current recipe line references the free item'
  );

select
  throws_ok (
    $$update app.stock_items set base_unit = 'liter'
      where id = 'f5000000-0000-4000-8000-00000000001b'$$,
    '23514',
    'cannot change base_unit of an item that is configured or has movements',
    'a recipe line freezes base_unit'
  );

select
  throws_ok (
    $$update app.stock_items set kind = 'seafood'
      where id = 'f5000000-0000-4000-8000-00000000001b'$$,
    '23514',
    'cannot change kind of an item that is configured or has movements',
    'a recipe line freezes kind'
  );

select
  throws_ok (
    $$update app.stock_items
      set parent_item_id = 'f5000000-0000-4000-8000-00000000001d'
      where id = 'f5000000-0000-4000-8000-000000000017'$$,
    '23514',
    'cannot change parent_item_id of an item that is configured or has movements',
    'a recipe line freezes parent_item_id'
  );

select
  lives_ok (
    $$update app.stock_items set name = 'صنف حر معاد تسميته'
      where id = 'f5000000-0000-4000-8000-00000000001b'$$,
    'a recipe line does not freeze the item name'
  );

set
  local role authenticated;

select
  lives_ok (
    $$select app.set_recipe_version(
      'f5000000-0000-4000-8000-0000000001a1',
      'f5000000-0000-4000-8000-000000000043',
      '2030-01-01 00:00:00+00', null, null, null,
      '[{"stock_item_id":"f5000000-0000-4000-8000-000000000012","quantity":1,"unit":"kg"}]'::jsonb,
      null,
      (select app.recipe_schedule('f5000000-0000-4000-8000-000000000043') ->> 'token')
    )$$,
    'the recipe is republished without the free item'
  );

reset role;

select
  lives_ok (
    $$update app.stock_items set base_unit = 'liter', kind = 'seafood'
      where id = 'f5000000-0000-4000-8000-00000000001b'$$,
    'once only superseded versions reference the item, its identity can change'
  );

select
  finish ();

rollback;
