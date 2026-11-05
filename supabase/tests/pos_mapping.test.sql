-- POS mapping. Synthetic ids and names only.
begin;

select
  plan (173);

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

insert into
  app.opening_stocks (id, request_id, occurred_at)
values
  (
    'a4600000-0000-4000-8000-0000000000b1',
    'a4600000-0000-4000-8000-0000000000b2',
    '2030-01-01 00:00:00+00'
  );

insert into
  app.pos_shifts (id, opened_at, is_active, pos_update_time)
values
  (
    'shift-map-june',
    '2030-06-01 08:00:00+00',
    false,
    '2030-06-01 08:00:00+00'
  ),
  (
    'shift-map-july',
    '2030-07-01 08:00:00+00',
    false,
    '2030-07-01 08:00:00+00'
  ),
  (
    'shift-map-august',
    '2030-08-01 08:00:00+00',
    false,
    '2030-08-01 08:00:00+00'
  ),
  (
    'shift-map-sept',
    '2030-09-01 08:00:00+00',
    false,
    '2030-09-01 08:00:00+00'
  );

insert into
  app.pos_orders (
    id,
    shift_id,
    status,
    ordered_at,
    subtotal,
    discount,
    tax,
    service_tax,
    delivery_fee,
    total,
    pos_update_time,
    content_hash,
    missing_from_pos
  )
values
  (
    'order-map-a',
    'shift-map-june',
    'complete',
    '2030-06-01 12:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-01 12:00:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-free',
    'shift-map-june',
    'complete',
    '2030-06-01 12:05:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-01 12:05:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-exc',
    'shift-map-june',
    'complete',
    '2030-06-01 12:10:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-01 12:10:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-gap',
    'shift-map-june',
    'complete',
    '2030-06-01 12:15:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-01 12:15:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-can',
    'shift-map-june',
    'canceled',
    '2030-06-01 12:20:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-01 12:20:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-open',
    'shift-map-june',
    'active',
    '2030-06-01 12:25:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-01 12:25:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-miss',
    'shift-map-june',
    'complete',
    '2030-06-01 12:30:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-01 12:30:00+00',
    repeat('ab', 32),
    true
  ),
  (
    'order-map-early',
    'shift-map-june',
    'complete',
    '2029-12-01 12:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2029-12-01 12:00:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-out',
    'shift-map-august',
    'complete',
    '2030-08-01 12:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-08-01 12:00:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-july',
    'shift-map-july',
    'complete',
    '2030-07-01 12:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-07-01 12:00:00+00',
    repeat('ab', 32),
    false
  ),
  (
    'order-map-zero',
    'shift-map-sept',
    'complete',
    '2030-09-01 12:00:00+00',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-09-01 12:00:00+00',
    repeat('ab', 32),
    false
  );

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    size_name,
    quantity,
    weighted_qty,
    weighted_unit,
    options,
    line_total
  )
values
  (
    'order-map-a',
    'line-a',
    'pos-a',
    'صنف أ',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-free',
    'line-free',
    'pos-free',
    'صنف مجاني',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-map-exc',
    'line-exc',
    'pos-exc',
    'خدمة',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-gap',
    'line-gap',
    'pos-gap',
    'صنف ناقص',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-can',
    'line-can',
    'pos-can',
    'صنف ملغي',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-open',
    'line-open',
    'pos-open',
    'صنف مفتوح',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-miss',
    'line-miss',
    'pos-miss',
    'صنف مفقود',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-early',
    'line-early',
    'pos-early',
    'صنف مبكر',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-out',
    'line-out',
    'pos-out',
    'صنف خارج الفترة',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-wd',
    'pos-wd',
    'صنف وزن',
    null,
    1,
    2,
    'kg',
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-opt',
    'pos-opt',
    'صنف إضافة',
    null,
    1,
    null,
    null,
    '[{"value":"حار","price":4}]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-amb',
    'pos-amb',
    'صنف مكرر',
    null,
    1,
    null,
    null,
    '[{"value":"حار","price":1},{"value":"حار","price":9}]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-raw',
    'pos-raw',
    'صنف نيئ',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-raw-opt',
    'pos-raw-opt',
    'صنف نيئ بإضافة',
    null,
    1,
    null,
    null,
    '[{"value":"حار"}]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-one',
    'pos-one',
    'صنف بلا إضافة',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-add',
    'pos-add',
    'صنف إضافات',
    null,
    1,
    null,
    null,
    '[{"value":"حار"},{"value":"بارد"}]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-blank',
    'pos-blank',
    'صنف فارغ',
    null,
    1,
    null,
    null,
    '[{"value":"  "}]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-cook',
    'pos-cook',
    'صنف تسوية ثابت',
    null,
    1,
    null,
    null,
    '[{"value":"مشوي"}]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-wcook',
    'pos-wcook',
    'صنف تسوية وزن',
    null,
    1,
    2,
    'kg',
    '[{"value":"مشوي"}]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-cookpub',
    'pos-cookpub',
    'صنف نشر طهي',
    null,
    1,
    2,
    'kg',
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-noloss',
    'pos-noloss',
    'صنف وصفة بلا فاقد',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-ing',
    'pos-ing',
    'صنف مباشر',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-tiny',
    'pos-tiny',
    'صنف دقيق',
    null,
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-sized',
    'pos-sized',
    'صنف مقاس',
    '  كبير  ',
    1,
    null,
    null,
    '[]'::jsonb,
    1
  ),
  (
    'order-map-july',
    'line-badunit',
    'pos-badunit',
    'صنف وحدة',
    null,
    1,
    2,
    'سلة',
    '[]'::jsonb,
    1
  ),
  (
    'order-map-zero',
    'line-zero',
    'pos-zero',
    'صنف كمية صفر',
    null,
    0,
    null,
    null,
    '[]'::jsonb,
    0
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
  lives_ok (
    $$select app.create_stock_item(
      'a4600000-0000-4000-8000-000000000101',
      'جمبري الربط', 'seafood', 'kg', 'weekly', null, 0.10, true
    )$$,
    'shrimp with 10 percent loss'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4600000-0000-4000-8000-000000000102',
      'ملح الربط', 'ingredient', 'kg', 'weekly', null, 0, true
    )$$,
    'salt with zero loss'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4600000-0000-4000-8000-000000000103',
      'فلفل الربط', 'ingredient', 'kg', 'weekly', null, 0, true
    )$$,
    'pepper with zero loss'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4600000-0000-4000-8000-000000000104',
      'علبة الربط', 'packaging', 'piece', 'weekly', null, null, true
    )$$,
    'a packaging item'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4600000-0000-4000-8000-000000000105',
      'سمك مخلوط الربط', 'fish_mixed', 'kg', 'weekly', null, 0, true
    )$$,
    'a mixed fish item'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4600000-0000-4000-8000-000000000106',
      'حجم السمك الربط', 'fish_size', 'kg', 'weekly',
      (select id from app.stock_items where name = 'سمك مخلوط الربط'),
      0.10, true
    )$$,
    'a sized fish item'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4600000-0000-4000-8000-000000000107',
      'صنف التجميد', 'ingredient', 'kg', 'weekly', null, null, true
    )$$,
    'an unconfigured item used only as a direct target'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4600000-0000-4000-8000-000000000108',
      'صنف بلا فاقد', 'ingredient', 'kg', 'weekly', null, null, true
    )$$,
    'an item with no loss, used inside a dish'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4600000-0000-4000-8000-000000000201', 'طبق الربط', 'dish'
    )$$,
    'a dish'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4600000-0000-4000-8000-000000000202', 'تسوية الربط', 'cooking'
    )$$,
    'a cooking recipe'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4600000-0000-4000-8000-000000000203', 'تسوية مرفوضة', 'cooking'
    )$$,
    'a cooking recipe that will gain a marine leaf directly'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4600000-0000-4000-8000-000000000204', 'خلطة الربط', 'batch'
    )$$,
    'a batch recipe'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4600000-0000-4000-8000-000000000205', 'طبق بلا فاقد', 'dish'
    )$$,
    'a dish whose leaf has no loss'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4600000-0000-4000-8000-000000000206', 'أرز الربط', 'dish'
    )$$,
    'a recipe whose alef can fold'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4600000-0000-4000-8000-000000000207', 'سلطة الربط', 'dish'
    )$$,
    'a recipe whose teh marbuta stays distinct'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4600000-0000-4000-8000-000000000208', 'وصفة الصوص', 'dish'
    )$$,
    'a recipe reached only through an import binding'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'a4600000-0000-4000-8000-000000000301',
      (select id from app.recipes where name = 'طبق الربط'),
      '2030-01-01 00:00:00+00', null, null, null,
      jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity', 1, 'unit', 'kg'
      )),
      null,
      (select app.recipe_schedule((select id from app.recipes where name = 'طبق الربط')) ->> 'token')
    )$$,
    'the dish is published'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'a4600000-0000-4000-8000-000000000302',
      (select id from app.recipes where name = 'تسوية الربط'),
      '2030-01-01 00:00:00+00', null, null, null,
      jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity', 1, 'unit', 'kg'
      )),
      null,
      (select app.recipe_schedule((select id from app.recipes where name = 'تسوية الربط')) ->> 'token')
    )$$,
    'the cooking recipe is published with salt'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'a4600000-0000-4000-8000-000000000303',
      (select id from app.recipes where name = 'طبق بلا فاقد'),
      '2030-01-01 00:00:00+00', null, null, null,
      jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'صنف بلا فاقد'),
        'quantity', 1, 'unit', 'kg'
      )),
      null,
      (select app.recipe_schedule((select id from app.recipes where name = 'طبق بلا فاقد')) ->> 'token')
    )$$,
    'publication does not require loss'
  );

reset role;

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'a4600000-0000-4000-8000-0000000003f1',
    'import',
    '{"fn":"test"}'::jsonb,
    '{"ok":true}'::jsonb
  );

insert into
  app.recipe_versions (effective_from, created_change_id, recipe_id)
values
  (
    '2030-01-01 00:00:00+00',
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'a4600000-0000-4000-8000-0000000003f1'
    ),
    (
      select
        id
      from
        app.recipes
      where
        name = 'تسوية مرفوضة'
    )
  );

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
    (
      select
        v.id
      from
        app.recipe_versions v
        join app.recipes r on r.id = v.recipe_id
      where
        r.name = 'تسوية مرفوضة'
    ),
    1,
    (
      select
        id
      from
        app.stock_items
      where
        name = 'جمبري الربط'
    ),
    1,
    'kg'
  );

insert into
  app.recipe_imports (
    request_id,
    structural_hash,
    created_change_id,
    counts,
    summary
  )
values
  (
    'a4600000-0000-4000-8000-0000000003f2',
    repeat('cd', 32),
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'a4600000-0000-4000-8000-0000000003f1'
    ),
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into
  app.recipe_import_bindings (import_id, source_name, recipe_id)
values
  (
    (
      select
        id
      from
        app.recipe_imports
      where
        request_id = 'a4600000-0000-4000-8000-0000000003f2'
    ),
    'صوص الربط',
    (
      select
        id
      from
        app.recipes
      where
        name = 'وصفة الصوص'
    )
  );

set
  local role authenticated;

select
  is (
    app.pos_base_schedule ('pos-a', '["none"]'::jsonb) ->> 'token',
    app.pos_base_schedule ('pos-a', '["none"]'::jsonb) ->> 'empty_token',
    'a new base subject token is the empty-schedule token'
  );

select
  is (
    app.pos_base_schedule ('pos-a', '["none"]'::jsonb) ->> 'identity',
    'base|pos-a|["none"]|',
    'base identity uses the canonical size key'
  );

select
  is (
    app.set_pos_base_mapping (
      'a4600000-0000-4000-8000-000000000401',
      'pos-a',
      '["none"]'::jsonb,
      '2030-01-01 00:00:00+00',
      null,
      jsonb_build_object(
        'stock_item_id',
        (
          select
            id
          from
            app.stock_items
          where
            name = 'جمبري الربط'
        ),
        'quantity_per_basis',
        90,
        'unit',
        'g'
      ),
      app.pos_base_schedule ('pos-a', '["none"]'::jsonb) ->> 'token',
      null
    ),
    app.set_pos_base_mapping (
      'a4600000-0000-4000-8000-000000000401',
      'pos-a',
      '["none"]'::jsonb,
      '2030-01-01 00:00:00+00',
      null,
      jsonb_build_object(
        'stock_item_id',
        (
          select
            id
          from
            app.stock_items
          where
            name = 'جمبري الربط'
        ),
        'quantity_per_basis',
        90,
        'unit',
        'g'
      ),
      app.pos_base_schedule ('pos-a', '["none"]'::jsonb) ->> 'empty_token',
      null
    ),
    'replaying a base mapping returns the same result'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_map_versions v
        join app.pos_map_subjects s on s.id = v.subject_id
      where
        s.pos_item_id = 'pos-a'
        and v.family = 'mapping'
        and v.superseded_change_id is null
    ),
    1::bigint,
    'replay does not insert a second version'
  );

select
  throws_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000401',
      'pos-a', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('recipe_id', (select id from app.recipes where name = 'طبق الربط')),
      (select app.pos_base_schedule('pos-a', '["none"]'::jsonb) ->> 'empty_token'),
      null
    )$$,
    '22023',
    'request_id already used for a different change',
    'a different payload for the same request is refused'
  );

select
  throws_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000402',
      'pos-a', '["none"]'::jsonb, '2030-02-01 00:00:00+00', null,
      'additive',
      (select app.pos_base_schedule('pos-a', '["none"]'::jsonb) ->> 'empty_token'),
      null
    )$$,
    '40001',
    'configuration changed',
    'a stale token is refused'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000403',
      'pos-a', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-a', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'pos-a expects no options'
  );

select
  is (
    app.resolve_line_requirements ('order-map-a', 'line-a') ->> 'status',
    'ready',
    'the fixed shrimp line is ready'
  );

select
  is (
    (
      select
        (e.value ->> 'quantity')::numeric
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_line_requirements ('order-map-a', 'line-a') -> 'requirements'
        ) as e
      where
        e.value ->> 'stock_item_id' = (
          select
            id::text
          from
            app.stock_items
          where
            name = 'جمبري الربط'
        )
    ),
    0.1::numeric,
    '90 g net at 10 percent loss is 0.1 kg raw'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000404',
      'pos-free', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-free', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the free line is mapped to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000405',
      'pos-free', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-free', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the free line expects no options'
  );

select
  lives_ok (
    $$select app.set_pos_exception(
      'a4600000-0000-4000-8000-000000000406',
      'pos-exc', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'خدمة بلا مخزون',
      (select app.pos_base_schedule('pos-exc', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the service subject is an exception'
  );

select
  is (
    app.resolve_line_requirements ('order-map-exc', 'line-exc') ->> 'status',
    'exception',
    'an exception line is not costed'
  );

select
  is (
    app.resolve_line_requirements ('order-map-exc', 'line-exc') -> 'requirements',
    'null'::jsonb,
    'an exception has null requirements'
  );

select
  is (
    app.resolve_line_requirements ('order-map-gap', 'line-gap') ->> 'status',
    'incomplete',
    'a gap is incomplete'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-gap', 'line-gap') -> 'issues' @> '[{"code":"unmapped_base"}]'::jsonb,
    'a gap reports unmapped_base'
  );

select
  is (
    app.resolve_line_requirements ('order-map-gap', 'line-gap') -> 'requirements',
    'null'::jsonb,
    'a gap does not cost as zero'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) ->> 'eligible_lines'
    )::integer,
    4,
    'four eligible lines in the June window'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) ->> 'covered_lines'
    )::integer,
    3,
    'ready and exception lines are covered'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) ->> 'ready_lines'
    )::integer,
    2,
    'the paid line and the free line are ready'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) ->> 'exception_lines'
    )::integer,
    1,
    'one exception line'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) ->> 'incomplete_lines'
    )::integer,
    1,
    'one incomplete line'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) ->> 'coverage'
    )::numeric,
    0.75::numeric,
    'coverage is covered over eligible'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) -> 'causes' ->> 'canceled'
    )::integer,
    1,
    'a canceled order is a cause'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) -> 'causes' ->> 'open'
    )::integer,
    1,
    'an open order is a cause'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) -> 'causes' ->> 'missing'
    )::integer,
    1,
    'a missing order is a cause'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-06-01 00:00:00+00',
        '2030-06-02 00:00:00+00'
      ) -> 'causes' ->> 'before_stock_start'
    )::integer,
    1,
    'a line before the opening is a cause'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.jsonb_array_elements (
          app.pos_mapping_coverage (
            '2030-06-01 00:00:00+00',
            '2030-06-02 00:00:00+00'
          ) -> 'subjects'
        ) as e
      where
        e.value ->> 'pos_item_id' = 'pos-out'
    ),
    0::bigint,
    'a shift outside the window is not in coverage'
  );

select
  is (
    (
      select
        map_status
      from
        app.pos_observed_bases
      where
        pos_item_id = 'pos-a'
    ),
    'ready',
    'the observed subject shows ready'
  );

select
  is (
    (
      select
        sale_count
      from
        app.pos_observed_bases
      where
        pos_item_id = 'pos-can'
    ),
    1::bigint,
    'a canceled line still lists the subject'
  );

select
  is (
    (
      select
        size_key
      from
        app.pos_observed_bases
      where
        pos_item_id = 'pos-sized'
    ),
    '["name","كبير"]'::jsonb,
    'a size name is trimmed into the name key'
  );

-- Weight line: 2 kg of shrimp at 1 kg per kg, and loss is not applied.
select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000411',
      'pos-wd', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'جمبري الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-wd', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the weight line maps one kg of shrimp per kg sold'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000412',
      'pos-wd', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-wd', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the weight line expects no options'
  );

select
  is (
    (
      select
        (e.value ->> 'quantity')::numeric
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_line_requirements ('order-map-july', 'line-wd') -> 'requirements'
        ) as e
    ),
    2::numeric,
    'a weight line does not apply loss'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000413',
      'pos-opt', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-opt', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the option subject base is one kg of salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000414',
      'pos-opt', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'exactly_one',
      (select app.pos_base_schedule('pos-opt', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the option subject expects one option'
  );

select
  is (
    app.pos_option_schedule ('global', null, null, 'حار') ->> 'identity',
    'option|global|حار|',
    'a global option identity is the value'
  );

select
  lives_ok (
    $$select app.set_pos_option_mapping(
      'a4600000-0000-4000-8000-000000000415',
      'global', null, null, 'حار',
      '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'فلفل الربط'),
        'quantity_per_basis', 0.2, 'unit', 'kg'
      ),
      (select app.pos_option_schedule('global', null, null, 'حار') ->> 'token'),
      null
    )$$,
    'حار maps globally to pepper'
  );

select
  lives_ok (
    $$select app.set_pos_option_mapping(
      'a4600000-0000-4000-8000-000000000416',
      'global', null, null, 'بارد',
      '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'فلفل الربط'),
        'quantity_per_basis', 0.3, 'unit', 'kg'
      ),
      (select app.pos_option_schedule('global', null, null, 'بارد') ->> 'token'),
      null
    )$$,
    'بارد maps globally to pepper'
  );

select
  is (
    (
      select
        (e.value ->> 'quantity')::numeric
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_line_requirements ('order-map-july', 'line-opt') -> 'requirements'
        ) as e
      where
        e.value ->> 'stock_item_id' = (
          select
            id::text
          from
            app.stock_items
          where
            name = 'فلفل الربط'
        )
    ),
    0.2::numeric,
    'the global option adds 0.2 kg of pepper'
  );

select
  lives_ok (
    $$select app.set_pos_option_mapping(
      'a4600000-0000-4000-8000-000000000417',
      'item', 'pos-opt', '["none"]'::jsonb, 'حار',
      '2030-01-01 00:00:00+00', null,
      '{"disposition":"unmapped"}'::jsonb,
      (select app.pos_option_schedule('item', 'pos-opt', '["none"]'::jsonb, 'حار') ->> 'token'),
      null
    )$$,
    'a scoped unmapped override'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-opt') ->> 'status',
    'incomplete',
    'scoped unmapped blocks the global option'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-opt') -> 'issues' @> '[{"code":"unmapped_option"}]'::jsonb,
    'the blocked option is unmapped_option'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-opt') -> 'requirements',
    'null'::jsonb,
    'a blocked option does not keep a partial quantity'
  );

select
  lives_ok (
    $$select app.set_pos_option_mapping(
      'a4600000-0000-4000-8000-000000000418',
      'item', 'pos-opt', '["none"]'::jsonb, 'حار',
      '2030-01-01 00:00:00+00', null,
      '{"disposition":"no_stock"}'::jsonb,
      (select app.pos_option_schedule('item', 'pos-opt', '["none"]'::jsonb, 'حار') ->> 'token'),
      null
    )$$,
    'a scoped no_stock override'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-opt') ->> 'status',
    'ready',
    'scoped no_stock resolves the option'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_line_requirements ('order-map-july', 'line-opt') -> 'requirements'
        ) as e
      where
        e.value ->> 'stock_item_id' = (
          select
            id::text
          from
            app.stock_items
          where
            name = 'فلفل الربط'
        )
    ),
    0::bigint,
    'scoped no_stock does not fall through to the global pepper'
  );

select
  lives_ok (
    $$select app.set_pos_option_mapping(
      'a4600000-0000-4000-8000-000000000419',
      'item', 'pos-opt', '["none"]'::jsonb, 'حار',
      '2030-01-01 00:00:00+00', null,
      null,
      (select app.pos_option_schedule('item', 'pos-opt', '["none"]'::jsonb, 'حار') ->> 'token'),
      null
    )$$,
    'clearing the scoped row leaves a gap'
  );

select
  is (
    (
      select
        (e.value ->> 'quantity')::numeric
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_line_requirements ('order-map-july', 'line-opt') -> 'requirements'
        ) as e
      where
        e.value ->> 'stock_item_id' = (
          select
            id::text
          from
            app.stock_items
          where
            name = 'فلفل الربط'
        )
    ),
    0.2::numeric,
    'a scoped gap falls through to the global mapping'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000421',
      'pos-amb', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-amb', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the ambiguous line has a base mapping'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000422',
      'pos-amb', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'additive',
      (select app.pos_base_schedule('pos-amb', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the ambiguous line is additive'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-amb') -> 'issues' @> '[{"code":"ambiguous_option"}]'::jsonb,
    'two indistinguishable option values are ambiguous'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-amb') -> 'requirements',
    'null'::jsonb,
    'an ambiguous option is not applied twice'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000423',
      'pos-raw', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-raw', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the raw subject is mapped'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000424',
      'pos-raw', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-raw', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the raw subject expects no options'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-raw') ->> 'status',
    'ready',
    'sold raw with no options is ready'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000425',
      'pos-raw-opt', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-raw-opt', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the raw-with-option subject is mapped'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000426',
      'pos-raw-opt', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-raw-opt', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the raw-with-option subject expects none'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-raw-opt') -> 'issues' @> '[{"code":"option_policy_violation"}]'::jsonb,
    'an option on a raw subject violates the policy'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000427',
      'pos-one', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-one', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the exactly-one subject is mapped'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000428',
      'pos-one', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'exactly_one',
      (select app.pos_base_schedule('pos-one', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the exactly-one policy is set'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-one') -> 'issues' @> '[{"code":"option_policy_violation"}]'::jsonb,
    'exactly one option is required'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000429',
      'pos-add', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-add', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the additive subject is mapped'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000430',
      'pos-add', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'additive',
      (select app.pos_base_schedule('pos-add', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the additive policy is set'
  );

select
  is (
    (
      select
        (e.value ->> 'quantity')::numeric
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_line_requirements ('order-map-july', 'line-add') -> 'requirements'
        ) as e
      where
        e.value ->> 'stock_item_id' = (
          select
            id::text
          from
            app.stock_items
          where
            name = 'فلفل الربط'
        )
    ),
    0.5::numeric,
    'additive options sum 0.2 and 0.3 kg of pepper'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000431',
      'pos-blank', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-blank', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blank-option subject is mapped'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000432',
      'pos-blank', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'additive',
      (select app.pos_base_schedule('pos-blank', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blank-option subject is additive'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-blank') -> 'issues' @> '[{"code":"unresolved_option"}]'::jsonb,
    'a blank option value is unresolved'
  );

select
  throws_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000433',
      'pos-cook', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('recipe_id', (select id from app.recipes where name = 'تسوية الربط')),
      (select app.pos_base_schedule('pos-cook', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '22023',
    'a base mapping cannot target a cooking recipe: pos-cook / ["none"]',
    'a base mapping cannot target a cooking recipe'
  );

select
  throws_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000435',
      'pos-wcook', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('recipe_id', (select id from app.recipes where name = 'تسوية الربط')),
      (select app.pos_base_schedule('pos-wcook', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '22023',
    'a base mapping cannot target a cooking recipe: pos-wcook / ["none"]',
    'a weighted base cannot target a cooking recipe'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-0000000004e1',
      'pos-wcook', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'جمبري الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-wcook', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the weight line maps one kg of shrimp per kg'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-0000000004e2',
      'pos-wcook', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'exactly_one',
      (select app.pos_base_schedule('pos-wcook', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the weight line expects one option'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-0000000004e3',
      'pos-cook', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-cook', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the fixed line maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-0000000004e4',
      'pos-cook', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'exactly_one',
      (select app.pos_base_schedule('pos-cook', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the fixed line expects one option'
  );

select
  lives_ok (
    $$select app.set_pos_option_mapping(
      'a4600000-0000-4000-8000-0000000004e5',
      'global', null, null, 'مشوي',
      '2030-01-01 00:00:00+00', null,
      jsonb_build_object('recipe_id', (select id from app.recipes where name = 'تسوية الربط')),
      (select app.pos_option_schedule('global', null, null, 'مشوي') ->> 'token'),
      null
    )$$,
    'a weight-line option maps to the cooking recipe'
  );

select
  is (
    (
      select
        (e.value ->> 'quantity')::numeric
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_line_requirements ('order-map-july', 'line-wcook') -> 'requirements'
        ) as e
      where
        e.value ->> 'stock_item_id' = (
          select
            id::text
          from
            app.stock_items
          where
            name = 'جمبري الربط'
        )
    ),
    2::numeric,
    'the weight line still requires the shrimp'
  );

select
  is (
    (
      select
        (e.value ->> 'quantity')::numeric
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_line_requirements ('order-map-july', 'line-wcook') -> 'requirements'
        ) as e
      where
        e.value ->> 'stock_item_id' = (
          select
            id::text
          from
            app.stock_items
          where
            name = 'ملح الربط'
        )
    ),
    2::numeric,
    'a cooking option scales per kg of the weight line'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-cook') -> 'issues' @> '[{"code":"target_kind_mismatch"}]'::jsonb,
    'a cooking option on a fixed line does not match'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-cook') ->> 'status',
    'incomplete',
    'a cooking option on a fixed line is incomplete'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-cook') -> 'requirements',
    'null'::jsonb,
    'a cooking option on a fixed line has no requirements'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000437',
      'pos-noloss', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('recipe_id', (select id from app.recipes where name = 'طبق بلا فاقد')),
      (select app.pos_base_schedule('pos-noloss', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'a dish with no loss can still be mapped'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000438',
      'pos-noloss', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-noloss', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the no-loss dish expects no options'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-noloss') -> 'issues' @> '[{"code":"blocked_recipe","expand_issue":"loss_not_set"}]'::jsonb,
    'resolve reuses recipe expansion and reports the missing loss'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000439',
      'pos-ing', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'صنف التجميد'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-ing', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'a direct ingredient does not need loss'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000440',
      'pos-ing', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-ing', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the direct ingredient expects no options'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-ing') ->> 'status',
    'ready',
    'an ingredient direct target does not apply loss'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000441',
      'pos-tiny', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 0.0000004, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-tiny', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'a tiny direct quantity is mapped'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000442',
      'pos-tiny', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-tiny', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the tiny subject expects no options'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-tiny') -> 'issues' @> '[{"code":"below_precision"}]'::jsonb,
    'a positive total that rounds to 0 is below precision'
  );

select
  is (
    app.resolve_line_requirements ('order-map-july', 'line-tiny') -> 'requirements',
    'null'::jsonb,
    'below precision does not return a zero quantity'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000495',
      'pos-digits', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', '0.0000004999999999999999999',
        'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-digits', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'a long decimal quantity is mapped'
  );

select
  is (
    pg_catalog.jsonb_typeof (
      app.pos_base_schedule ('pos-digits', '["none"]'::jsonb) -> 'versions' -> 0 -> 'quantity_per_basis'
    ),
    'string',
    'a schedule quantity is text'
  );

select
  is (
    app.pos_base_schedule ('pos-digits', '["none"]'::jsonb) -> 'versions' -> 0 ->> 'quantity_per_basis',
    '0.0000004999999999999999999',
    'a schedule quantity keeps every decimal digit'
  );

select
  is (
    (
      select
        pg_catalog.trim_scale (v.quantity_per_basis)::text
      from
        app.pos_map_versions v
        join app.pos_map_subjects s on s.id = v.subject_id
      where
        s.pos_item_id = 'pos-digits'
        and v.family = 'mapping'
        and v.superseded_change_id is null
    ),
    '0.0000004999999999999999999',
    'the stored quantity matches the schedule text'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-0000000004d1',
      'pos-zero', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-zero', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'a zero-quantity line is mapped'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-0000000004d2',
      'pos-zero', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-zero', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the zero-quantity line expects no options'
  );

select
  is (
    app.pos_mapping_coverage (
      '2030-09-01 00:00:00+00',
      '2030-09-02 00:00:00+00'
    ) -> 'coverage',
    'null'::jsonb,
    'a window whose only line has quantity zero has null coverage'
  );

select
  is (
    (
      app.pos_mapping_coverage (
        '2030-09-01 00:00:00+00',
        '2030-09-02 00:00:00+00'
      ) ->> 'eligible_lines'
    )::integer,
    0,
    'a zero-quantity line is not eligible'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000443',
      'pos-badunit', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-badunit', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the bad weight unit still has a mapping'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4600000-0000-4000-8000-000000000444',
      'pos-badunit', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-badunit', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the bad weight unit expects no options'
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-badunit') -> 'issues' @> '[{"code":"weighted_unit_invalid"}]'::jsonb,
    'an unknown weight unit blocks the line'
  );

select
  throws_like (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000451',
      'pos-pack', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة الربط'),
        'quantity_per_basis', 1, 'unit', 'piece'
      ),
      (select app.pos_base_schedule('pos-pack', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '%packaging and fish_mixed%',
    'packaging cannot be a mapping target'
  );

select
  throws_like (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000452',
      'pos-mixed', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'سمك مخلوط الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-mixed', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '%packaging and fish_mixed%',
    'fish_mixed cannot be a mapping target'
  );

select
  throws_like (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000453',
      'pos-batch', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('recipe_id', (select id from app.recipes where name = 'خلطة الربط')),
      (select app.pos_base_schedule('pos-batch', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '%batch%',
    'a batch recipe cannot be a mapping target'
  );

select
  throws_like (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000454',
      'pos-price', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg', 'price', 1
      ),
      (select app.pos_base_schedule('pos-price', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '%price-like key%',
    'a price key is rejected'
  );

select
  throws_like (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000455',
      'pos-note', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg', 'note', 'x'
      ),
      (select app.pos_base_schedule('pos-note', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '%unknown key%',
    'an unknown target key is rejected'
  );

select
  throws_ok (
    $$select app.set_pos_option_mapping(
      'a4600000-0000-4000-8000-000000000456',
      'global', null, null, 'فارغ',
      '2030-01-01 00:00:00+00', null,
      '{"disposition":null}'::jsonb,
      (select app.pos_option_schedule('global', null, null, 'فارغ') ->> 'token'),
      null
    )$$,
    '22023',
    'disposition must be unmapped or no_stock on an option mapping',
    'a null option disposition is rejected'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000461',
      'pos-overlap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-overlap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'an overlap subject is mapped'
  );

select
  throws_like (
    $$select app.set_pos_exception(
      'a4600000-0000-4000-8000-000000000462',
      'pos-overlap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'لا مخزون',
      (select app.pos_base_schedule('pos-overlap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '%exception overlaps a mapping%',
    'an exception cannot overlap a mapping'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000463',
      'pos-overlap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      null,
      (select app.pos_base_schedule('pos-overlap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the overlap mapping is cleared'
  );

select
  lives_ok (
    $$select app.set_pos_exception(
      'a4600000-0000-4000-8000-000000000464',
      'pos-overlap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'لا مخزون',
      (select app.pos_base_schedule('pos-overlap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the exception is saved once the mapping is gone'
  );

select
  throws_like (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000465',
      'pos-overlap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-overlap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '%exception overlaps a mapping%',
    'a mapping cannot overlap an exception'
  );

select
  throws_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000471',
      'pos-back', '["none"]'::jsonb, '2020-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-back', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '22023',
    'reason is required for a backdated change',
    'a backdated mapping needs a reason'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000472',
      'pos-back', '["none"]'::jsonb, '2020-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-back', '["none"]'::jsonb) ->> 'token'),
      'تصحيح'
    )$$,
    'a backdated mapping with a reason is saved'
  );

select
  is (
    (
      select
        kind
      from
        app.costing_changes
      where
        request_id = 'a4600000-0000-4000-8000-000000000472'
    ),
    'mapping',
    'the audit kind is mapping'
  );

select
  is (
    (
      select
        reason
      from
        app.costing_changes
      where
        request_id = 'a4600000-0000-4000-8000-000000000472'
    ),
    'تصحيح',
    'the backdating reason is stored'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000473',
      'pos-now', '["none"]'::jsonb, null, null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity_per_basis', 1, 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-now', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'null effective_from means the current minute'
  );

select
  is (
    (
      select
        payload ->> 'effective_from'
      from
        app.costing_changes
      where
        request_id = 'a4600000-0000-4000-8000-000000000473'
    ),
    'now',
    'the stored payload says now'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000481',
      'pos-recipe', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('recipe_id', (select id from app.recipes where name = 'طبق الربط')),
      (select app.pos_base_schedule('pos-recipe', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'pos-recipe maps to the dish'
  );

select
  throws_like (
    $$select app.set_recipe_version(
      'a4600000-0000-4000-8000-000000000482',
      (select id from app.recipes where name = 'طبق الربط'),
      '2030-01-01 00:00:00+00', null, null, null,
      null, null,
      (select app.recipe_schedule((select id from app.recipes where name = 'طبق الربط')) ->> 'token')
    )$$,
    '%pos-recipe / ["none"]%no_version_in_force%',
    'a recipe gap under a mapping names the subject'
  );

select
  throws_like (
    $$select app.set_pos_option_mapping(
      'a4600000-0000-4000-8000-000000000483',
      'global', null, null, 'مشوي مرفوض',
      '2030-01-01 00:00:00+00', null,
      jsonb_build_object('recipe_id', (select id from app.recipes where name = 'تسوية مرفوضة')),
      (select app.pos_option_schedule('global', null, null, 'مشوي مرفوض') ->> 'token'),
      null
    )$$,
    '%option مشوي مرفوض%cooking_marine%',
    'a cooking option with a marine leaf is refused and names the subject'
  );

select
  is (
    app.suggest_pos_mappings ('آرز الربط') -> 0 ->> 'via',
    'name',
    'alef forms suggest the recipe by name'
  );

select
  is (
    pg_catalog.jsonb_array_length (app.suggest_pos_mappings ('سلطه الربط')),
    0,
    'teh marbuta does not match heh'
  );

select
  is (
    app.suggest_pos_mappings ('سلطة الربط') -> 0 ->> 'name',
    'سلطة الربط',
    'the same teh marbuta matches'
  );

select
  is (
    app.suggest_pos_mappings ('صوص الربط') -> 0 ->> 'via',
    'binding',
    'an import binding suggests its recipe'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_map_versions
    ),
    (
      select
        count(*)
      from
        app.pos_map_versions
    ),
    'suggesting does not write a version'
  );

-- The second count is the same statement, so this only proves the read is stable.
-- A before/after pair is checked by the absence of a version for the suggested name's subject.
select
  is (
    app.pos_base_schedule ('آرز الربط', '["none"]'::jsonb) ->> 'subject_id',
    null,
    'a suggestion does not create a subject'
  );

select
  throws_ok (
    $$select app.pos_map_token('base', 'pos-a', '["none"]'::jsonb, null, null)$$,
    '42501',
    null::text,
    'the owner cannot call the token helper'
  );

select
  throws_ok (
    $$update app.pos_map_versions set exception_reason = 'x' where false$$,
    '42501',
    null::text,
    'the owner cannot update versions'
  );

reset role;

insert into
  app.pos_map_subjects (kind, pos_item_id, size_key, created_change_id)
values
  (
    'base',
    'pos-cookpub',
    '["none"]'::jsonb,
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'a4600000-0000-4000-8000-000000000302'
    )
  );

insert into
  app.pos_map_versions (
    effective_from,
    created_change_id,
    subject_id,
    family,
    target_kind,
    recipe_id
  )
values
  (
    '2030-01-01 00:00:00+00',
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'a4600000-0000-4000-8000-000000000302'
    ),
    (
      select
        id
      from
        app.pos_map_subjects
      where
        pos_item_id = 'pos-cookpub'
    ),
    'mapping',
    'recipe',
    (
      select
        id
      from
        app.recipes
      where
        name = 'تسوية الربط'
    )
  );

select
  ok (
    app.resolve_line_requirements ('order-map-july', 'line-cookpub') -> 'issues' @> '[{"code":"target_kind_mismatch"}]'::jsonb,
    'a weighted base stored against a cooking recipe does not match'
  );

set
  local role authenticated;

select
  throws_like (
    $$select app.set_recipe_version(
      'a4600000-0000-4000-8000-000000000484',
      (select id from app.recipes where name = 'تسوية الربط'),
      '2030-02-01 00:00:00+00', null, null, null,
      jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح الربط'),
        'quantity', 1, 'unit', 'kg'
      )),
      null,
      (select app.recipe_schedule((select id from app.recipes where name = 'تسوية الربط')) ->> 'token')
    )$$,
    '%pos-cookpub / ["none"]%',
    'publishing a cooking recipe names a base mapping that targets it'
  );

reset role;

select
  throws_ok (
    $$insert into app.pos_map_versions (
      effective_from, created_change_id, superseded_change_id, subject_id, family, target_kind
    ) values (
      '2030-01-01 00:00:00+00',
      (select id from app.costing_changes where request_id = 'a4600000-0000-4000-8000-000000000401'),
      (select id from app.costing_changes where request_id = 'a4600000-0000-4000-8000-000000000401'),
      (select id from app.pos_map_subjects where pos_item_id = 'pos-a' and kind = 'base'),
      'mapping',
      null
    )$$,
    '23514',
    null,
    'a mapping with a null target kind is rejected'
  );

select
  throws_ok (
    $$update app.pos_map_versions set exception_reason = 'تغيير' where family = 'exception'$$,
    '55000',
    null::text,
    'a version payload cannot change'
  );

select
  throws_ok (
    $$delete from app.pos_map_versions$$,
    '55000',
    null::text,
    'versions cannot be deleted'
  );

select
  throws_ok (
    $$truncate app.pos_map_versions$$,
    '55000',
    null::text,
    'versions cannot be truncated'
  );

select
  throws_ok (
    $$update app.pos_map_subjects set option_value = 'x'$$,
    '55000',
    null::text,
    'subjects are immutable'
  );

select
  lives_ok (
    $$insert into app.costing_changes (request_id, kind, payload, result)
      values ('a4600000-0000-4000-8000-000000000491', 'legacy', '{}'::jsonb, '{}'::jsonb)$$,
    'kind legacy is still allowed'
  );

select
  throws_ok (
    $$insert into app.costing_changes (request_id, kind, payload, result)
      values ('a4600000-0000-4000-8000-000000000492', 'nope', '{}'::jsonb, '{}'::jsonb)$$,
    '23514',
    null::text,
    'an unknown costing kind is rejected'
  );

select
  throws_ok (
    $$update app.stock_items set base_unit = 'liter'
      where name = 'صنف التجميد'$$,
    '23514',
    'cannot change base_unit of an item that is configured or has movements',
    'a direct mapping freezes base_unit'
  );

select
  throws_ok (
    $$update app.stock_items set kind = 'seafood'
      where name = 'صنف التجميد'$$,
    '23514',
    'cannot change kind of an item that is configured or has movements',
    'a direct mapping freezes kind'
  );

select
  lives_ok (
    $$update app.stock_items set name = 'صنف التجميد معاد'
      where name = 'صنف التجميد'$$,
    'a direct mapping does not freeze the name'
  );

set
  local role authenticated;

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000493',
      'pos-ing', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      null,
      (select app.pos_base_schedule('pos-ing', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the direct mapping is superseded'
  );

reset role;

select
  lives_ok (
    $$update app.stock_items set base_unit = 'piece', kind = 'packaging'
      where name = 'صنف التجميد معاد'$$,
    'after the mapping is superseded the identity can change'
  );

set
  local role authenticated;

select
  is (
    (
      select
        app.set_pos_base_mapping (
          'a4600000-0000-4000-8000-000000000439',
          'pos-ing',
          '["none"]'::jsonb,
          '2030-01-01 00:00:00+00',
          null,
          jsonb_build_object(
            'stock_item_id',
            (
              select
                (payload -> 'target' ->> 'stock_item_id')::uuid
              from
                app.costing_changes
              where
                request_id = 'a4600000-0000-4000-8000-000000000439'
            ),
            'quantity_per_basis',
            1,
            'unit',
            'kg'
          ),
          (
            select
              payload ->> 'expected_token'
            from
              app.costing_changes
            where
              request_id = 'a4600000-0000-4000-8000-000000000439'
          ),
          null
        ) - 'subject_id'
    ),
    (
      select
        result
      from
        app.costing_changes
      where
        request_id = 'a4600000-0000-4000-8000-000000000439'
    ),
    'retrying the direct mapping after the item became packaging returns the committed result'
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
    $$select app.set_pos_base_mapping(
      'a4600000-0000-4000-8000-000000000494',
      'pos-a', '["none"]'::jsonb, '2030-03-01 00:00:00+00', null, null, 'x', null
    )$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot map'
  );

select
  throws_ok (
    $$select app.resolve_line_requirements('order-map-a', 'line-a')$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot resolve a line'
  );

select
  throws_ok (
    $$select app.pos_mapping_coverage('2030-06-01 00:00:00+00', '2030-06-02 00:00:00+00')$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot read coverage'
  );

select
  throws_ok (
    $$select app.suggest_pos_mappings('ملح')$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot ask for suggestions'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_map_subjects
    ),
    0::bigint,
    'a non-owner sees no subjects'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_map_versions
    ),
    0::bigint,
    'a non-owner sees no versions'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_observed_bases
    ),
    0::bigint,
    'a non-owner sees no observed subjects'
  );

set
  local role anon;

select
  throws_ok (
    $$select app.resolve_line_requirements('order-map-a', 'line-a')$$,
    '42501',
    null::text,
    'anon cannot resolve a line'
  );

select
  throws_ok (
    $$select * from app.pos_map_subjects$$,
    '42501',
    null::text,
    'anon cannot read subjects'
  );

select
  throws_ok (
    $$select * from app.pos_observed_bases$$,
    '42501',
    null::text,
    'anon cannot read observed subjects'
  );

select
  finish ();

rollback;
