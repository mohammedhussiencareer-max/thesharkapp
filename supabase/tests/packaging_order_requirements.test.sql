-- Packaging policies and order requirements. Synthetic ids and names only.
begin;

select
  plan (190);

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
    'a4700000-0000-4000-8000-0000000000b1',
    'a4700000-0000-4000-8000-0000000000b2',
    '2030-01-01 00:00:00+00'
  );

insert into
  app.pos_shifts (id, opened_at, is_active, pos_update_time)
values
  (
    'shift-pack-june',
    '2030-06-01 08:00:00+00',
    false,
    '2030-06-01 08:00:00+00'
  ),
  (
    'shift-pack-july',
    '2030-07-01 08:00:00+00',
    false,
    '2030-07-01 08:00:00+00'
  );

insert into
  app.pos_orders (
    id,
    shift_id,
    status,
    order_type,
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
select
  o.id,
  o.shift_id,
  o.status,
  o.order_type,
  o.ordered_at,
  0,
  0,
  0,
  0,
  0,
  0,
  o.ordered_at,
  rpad(md5(o.id), 64, 'a'),
  o.missing_from_pos
from
  (
    values
      (
        'order-cov-ready',
        'shift-pack-june',
        'complete',
        'covready',
        '2030-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-cov-line',
        'shift-pack-june',
        'complete',
        'covline',
        '2030-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-cov-gap',
        'shift-pack-june',
        'complete',
        'covgap',
        '2030-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-cov-block',
        'shift-pack-june',
        'complete',
        'covblock',
        '2030-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-cov-both',
        'shift-pack-june',
        'complete',
        'covboth',
        '2030-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-cov-cancel',
        'shift-pack-june',
        'canceled',
        'covcancel',
        '2030-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-cov-open',
        'shift-pack-june',
        'active',
        'covopen',
        '2030-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-cov-miss',
        'shift-pack-june',
        'complete',
        'covmiss',
        '2030-06-01 12:00:00+00'::timestamptz,
        true
      ),
      (
        'order-cov-old',
        'shift-pack-june',
        'complete',
        'covold',
        '2020-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-cov-blank',
        'shift-pack-june',
        'canceled',
        null,
        '2030-06-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-bare',
        'shift-pack-july',
        'complete',
        'bare',
        '2030-07-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-fixed',
        'shift-pack-july',
        'complete',
        'hall',
        '2030-07-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-weight',
        'shift-pack-july',
        'complete',
        'delivery',
        '2030-07-01 12:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-linear',
        'shift-pack-july',
        'complete',
        'delivery',
        '2030-07-01 13:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-grams',
        'shift-pack-july',
        'complete',
        'delivery',
        '2030-07-01 14:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-round',
        'shift-pack-july',
        'complete',
        'round',
        '2030-07-01 15:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-tiny',
        'shift-pack-july',
        'complete',
        'tiny',
        '2030-07-01 16:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-exc',
        'shift-pack-july',
        'complete',
        'empty',
        '2030-07-01 17:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-excgap',
        'shift-pack-july',
        'complete',
        'fresh',
        '2030-07-01 17:30:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-gapline',
        'shift-pack-july',
        'complete',
        'hall',
        '2030-07-01 18:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-block',
        'shift-pack-july',
        'complete',
        'blocknone',
        '2030-07-01 18:30:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-none',
        'shift-pack-july',
        'complete',
        null,
        '2030-07-01 19:00:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-long',
        'shift-pack-july',
        'complete',
        repeat('ن', 201),
        '2030-07-01 19:10:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-cap',
        'shift-pack-july',
        'complete',
        'capignore',
        '2030-07-01 19:20:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-cancel',
        'shift-pack-july',
        'canceled',
        'hall',
        '2030-07-01 19:30:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-open',
        'shift-pack-july',
        'active',
        'hall',
        '2030-07-01 19:40:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-miss',
        'shift-pack-july',
        'complete',
        'hall',
        '2030-07-01 19:50:00+00'::timestamptz,
        true
      ),
      (
        'order-pack-misscancel',
        'shift-pack-july',
        'canceled',
        'hall',
        '2030-07-01 19:55:00+00'::timestamptz,
        true
      ),
      (
        'order-pack-exact',
        'shift-pack-july',
        'complete',
        'delivery',
        '2030-07-01 20:10:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-tight',
        'shift-pack-july',
        'complete',
        'tight',
        '2030-07-01 20:20:00+00'::timestamptz,
        false
      ),
      (
        'order-pack-nest',
        'shift-pack-july',
        'complete',
        'nest',
        '2030-07-01 20:30:00+00'::timestamptz,
        false
      )
  ) as o (
    id,
    shift_id,
    status,
    order_type,
    ordered_at,
    missing_from_pos
  );

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    weighted_qty,
    weighted_unit,
    options,
    line_total
  )
values
  (
    'order-cov-ready',
    'line-cov-ready',
    'pos-cov-ready',
    'جاهز',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-line',
    'line-cov-line',
    'pos-cov-line',
    'سطر',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-gap',
    'line-cov-gap',
    'pos-cov-gap',
    'فجوة',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-block',
    'line-cov-block',
    'pos-cov-block',
    'موقوف',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-both',
    'line-cov-both',
    'pos-cov-both',
    'الاثنان',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-cancel',
    'line-cov-cancel',
    'pos-cov-cancel',
    'ملغي',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-open',
    'line-cov-open',
    'pos-cov-open',
    'مفتوح',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-miss',
    'line-cov-miss',
    'pos-cov-miss',
    'ناقص',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-old',
    'line-cov-old',
    'pos-cov-old',
    'قديم',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-cov-blank',
    'line-cov-blank',
    'pos-cov-blank',
    'فاضي',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-bare',
    'line-bare',
    'pos-bare',
    'عادي',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-fixed',
    'line-fixed-a',
    'pos-fixed',
    'ثابت',
    4,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-fixed',
    'line-fixed-b',
    'pos-fixed',
    'ثابت',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-weight',
    'line-weight',
    'pos-weight',
    'وزن',
    1,
    2.3,
    'kg',
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-linear',
    'line-linear',
    'pos-linear',
    'خطي',
    1,
    2.3,
    'kg',
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-grams',
    'line-grams',
    'pos-weight',
    'وزن',
    1,
    2300,
    'g',
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-round',
    'line-r1',
    'pos-round',
    'تقريب',
    1,
    null,
    null,
    '[{"value":"زيادة"}]'::jsonb,
    0
  ),
  (
    'order-pack-round',
    'line-r2',
    'pos-round',
    'تقريب',
    1,
    null,
    null,
    '[{"value":"زيادة"}]'::jsonb,
    0
  ),
  (
    'order-pack-tiny',
    'line-tiny',
    'pos-tiny',
    'دقيق',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-exc',
    'line-exc',
    'pos-exc',
    'خدمة',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-excgap',
    'line-excgap',
    'pos-exc2',
    'خدمة',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-gapline',
    'line-gap',
    'pos-gap',
    'ناقص',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-block',
    'line-block',
    'pos-block',
    'وحدة',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-none',
    'line-none',
    'pos-none',
    'بلا نوع',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-long',
    'line-long',
    'pos-long',
    'نوع طويل',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-cap',
    'line-cap',
    'pos-cap',
    'سعة',
    1,
    null,
    null,
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-exact',
    'line-exact',
    'pos-weight',
    'وزن',
    1,
    2.0,
    'kg',
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-tight',
    'line-tight',
    'pos-tight',
    'حد',
    1,
    3,
    'kg',
    '[]'::jsonb,
    0
  ),
  (
    'order-pack-nest',
    'line-nest',
    'pos-nest',
    'طبق',
    1,
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
      'a4700000-0000-4000-8000-000000000101',
      'ملح التغليف', 'ingredient', 'kg', 'weekly', null, 0, true
    )$$,
    'salt is an ingredient'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4700000-0000-4000-8000-000000000102',
      'علبة التغليف', 'packaging', 'piece', 'weekly', null, null, true
    )$$,
    'the box is packaging with no loss row'
  );

select
  lives_ok (
    $$select app.create_stock_item(
      'a4700000-0000-4000-8000-000000000103',
      'علبة التجميد', 'packaging', 'piece', 'weekly', null, null, true
    )$$,
    'the freeze box is packaging'
  );

select
  is (
    app.packaging_order_type_key (' hall '),
    '["type", "hall"]'::jsonb,
    'an order type key is the trimmed type'
  );

select
  is (
    app.packaging_order_type_key ('   '),
    '["none"]'::jsonb,
    'a blank order type is its own none key'
  );

select
  is (
    app.packaging_order_type_key (null),
    '["none"]'::jsonb,
    'a null order type is the none key'
  );

select
  is (
    app.packaging_order_type_schedule ('unseen') ->> 'token',
    app.packaging_order_type_schedule ('unseen') ->> 'empty_token',
    'an order type with no policy hashes its identity alone'
  );

select
  is (
    app.packaging_order_type_schedule ('unseen') ->> 'subject_id',
    null,
    'reading a schedule does not create a subject'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000401',
      'pos-bare', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-bare', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the bare item maps to one kilogram of salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000402',
      'pos-bare', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-bare', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the bare item expects no options'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-bare', null) ->> 'status',
    'incomplete',
    'a mapped order with no packaging policy is incomplete'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-bare', null) -> 'causes',
    '["packaging_unreviewed"]'::jsonb,
    'missing packaging is unreviewed, not a line failure'
  );

select
  is (
    jsonb_typeof(
      app.resolve_order_requirements ('order-pack-bare', null) -> 'requirements'
    ),
    'null',
    'an unreviewed order returns null requirements'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-bare', null) -> 'order_packaging' ->> 'state',
    'gap',
    'the order-type policy is a gap until it is approved'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000403',
      'bare', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('bare') ->> 'token'),
      null
    )$$,
    'the bare order type is approved as no packaging'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-bare', null) -> 'causes',
    '["packaging_unreviewed"]'::jsonb,
    'an approved order type still waits for the item policy'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000404',
      'pos-bare', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_base_schedule('pos-bare', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the bare item is approved as no packaging'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-bare', null) ->> 'status',
    'ready',
    'approved none on both policies covers the order'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-bare', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'stock_item_id' = (
          select
            id::text
          from
            app.stock_items
          where
            name = 'ملح التغليف'
        )
    ),
    '1',
    'approved none adds no packaging on top of the mapped salt'
  );

select
  is (
    app.packaging_order_type_schedule ('bare') -> 'versions' -> 0 ->> 'decision',
    'none',
    'approved none is a dated version'
  );

select
  isnt (
    app.packaging_order_type_schedule ('bare') ->> 'token',
    app.packaging_order_type_schedule ('bare') ->> 'empty_token',
    'saving a policy changes the schedule token'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000411',
      'pos-fixed', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-fixed', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the fixed item maps to one kilogram'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000412',
      'pos-fixed', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-fixed', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the fixed item expects no options'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000413',
      'pos-fixed', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '2', 'unit', 'piece'
      ))),
      (select app.packaging_base_schedule('pos-fixed', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the fixed item uses two boxes per line unit'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000414',
      'hall', '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'piece'
      ))),
      (select app.packaging_order_type_schedule('hall') ->> 'token'),
      null
    )$$,
    'hall adds one box once per order'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-fixed', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'piece'
    ),
    '11',
    'fixed lines take quantity times two boxes, plus one box for the order'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-fixed', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'kg'
    ),
    '5',
    'the two fixed lines add to five kilograms'
  );

select
  is (
    jsonb_typeof(
      app.resolve_order_requirements ('order-pack-fixed', null) -> 'requirements' -> 0 -> 'quantity'
    ),
    'string',
    'a ready order returns quantities as decimal text'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-fixed', null) -> 'provenance' ->> 'algorithm_version',
    '1',
    'the order lookup records algorithm version 1'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-fixed', null) -> 'provenance' ->> 'at',
    '2030-07-01T12:00:00.000000Z',
    'the order is resolved at its ordered_at'
  );

select
  throws_ok (
    $$select app.resolve_order_requirements('order-pack-fixed', 2)$$,
    '40001',
    'order changed',
    'a stale order version is rejected'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-fixed', 1) ->> 'status',
    'ready',
    'the current order version resolves'
  );

select
  throws_ok (
    $$select app.resolve_order_requirements('missing-order', null)$$,
    '22023',
    'unknown order',
    'an unknown order is rejected'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000421',
      'delivery', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('delivery') ->> 'token'),
      null
    )$$,
    'delivery is approved as no order packaging'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000422',
      'pos-weight', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-weight', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the weight item maps to one kilogram per kilogram'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000423',
      'pos-weight', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-weight', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the weight item expects no options'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000424',
      'pos-weight', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'piece', 'capacity_kg', '1'
      ))),
      (select app.packaging_base_schedule('pos-weight', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the weight item uses one box per kilogram of capacity'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-weight', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'piece'
    ),
    '3',
    '2.3 kilograms in a 1 kilogram box rounds up to 3 boxes'
  );

select
  is (
    (
      select
        e.value ->> 'containers'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-weight', null) -> 'provenance' -> 'paths'
        ) as e
      where
        e.value ->> 'source' = 'item_packaging'
    ),
    '3',
    'the expansion path records the container count as text'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-exact', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'piece'
    ),
    '2',
    'an exact multiple of the capacity is that many boxes'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000921',
      'pos-tight', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-tight', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the tight-capacity item maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000922',
      'pos-tight', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-tight', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the tight-capacity item expects no options'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000923',
      'tight', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('tight') ->> 'token'),
      null
    )$$,
    'the tight order type has no packaging'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000924',
      'pos-tight', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'piece', 'capacity_kg', '2.99999999999999999'
      ))),
      (select app.packaging_base_schedule('pos-tight', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the tight capacity is just under 3 kilograms'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-tight', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'piece'
    ),
    '2',
    '3 kilograms in a box of 2.99999999999999999 kilograms is 2 boxes'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4700000-0000-4000-8000-000000000931', 'خلطة التغليف', 'batch'
    )$$,
    'a batch recipe used inside a dish'
  );

select
  lives_ok (
    $$select app.create_recipe(
      'a4700000-0000-4000-8000-000000000932', 'طبق التغليف', 'dish'
    )$$,
    'a dish that uses the batch'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'a4700000-0000-4000-8000-000000000933',
      (select id from app.recipes where name = 'خلطة التغليف'),
      '2030-01-01 00:00:00+00', null, 1, 'kg',
      jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity', '1', 'unit', 'kg'
      )),
      null,
      (select app.recipe_schedule((select id from app.recipes where name = 'خلطة التغليف')) ->> 'token')
    )$$,
    'the batch is one kilogram of salt'
  );

select
  lives_ok (
    $$select app.set_recipe_version(
      'a4700000-0000-4000-8000-000000000934',
      (select id from app.recipes where name = 'طبق التغليف'),
      '2030-01-01 00:00:00+00', null, null, null,
      jsonb_build_array(jsonb_build_object(
        'child_recipe_id', (select id from app.recipes where name = 'خلطة التغليف'),
        'quantity', '1', 'unit', 'kg'
      )),
      null,
      (select app.recipe_schedule((select id from app.recipes where name = 'طبق التغليف')) ->> 'token')
    )$$,
    'the dish uses one batch'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000935',
      'pos-nest', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'recipe_id', (select id from app.recipes where name = 'طبق التغليف')
      ),
      (select app.pos_base_schedule('pos-nest', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the nested item maps to the dish'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000936',
      'pos-nest', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-nest', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the nested item expects no options'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000937',
      'nest', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('nest') ->> 'token'),
      null
    )$$,
    'the nested order type has no packaging'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000938',
      'pos-nest', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_base_schedule('pos-nest', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the nested item has no packaging'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-nest', null) ->> 'status',
    'ready',
    'a dish of a batch is ready'
  );

select
  is (
    (
      select
        bool_or(
          e.value -> 'path' = pg_catalog.jsonb_build_array (
            (
              select
                id::text
              from
                app.recipes
              where
                name = 'طبق التغليف'
            ),
            (
              select
                id::text
              from
                app.recipes
              where
                name = 'خلطة التغليف'
            ),
            (
              select
                id::text
              from
                app.stock_items
              where
                name = 'ملح التغليف'
            )
          )
          and e.value ->> 'source' = 'recipe'
          and e.value ->> 'role' = 'base'
          and e.value ->> 'line_id' = 'line-nest'
          and e.value ->> 'stock_item_id' = (
            select
              id::text
            from
              app.stock_items
            where
              name = 'ملح التغليف'
          )
        )
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-nest', null) -> 'provenance' -> 'paths'
        ) as e
    ),
    true,
    'the expansion path is the dish, the batch and the stock item'
  );

select
  is (
    (
      select
        doc -> 'provenance' -> 'recipe_versions' @> pg_catalog.jsonb_build_array (
          pg_catalog.to_jsonb (dish.id),
          pg_catalog.to_jsonb (batch.id)
        )
      from
        (
          select
            app.resolve_order_requirements ('order-pack-nest', null) as doc
        ) resolved
        cross join (
          select
            v.id
          from
            app.recipe_versions v
            join app.recipes r on r.id = v.recipe_id
          where
            r.name = 'طبق التغليف'
            and v.superseded_change_id is null
        ) dish
        cross join (
          select
            v.id
          from
            app.recipe_versions v
            join app.recipes r on r.id = v.recipe_id
          where
            r.name = 'خلطة التغليف'
            and v.superseded_change_id is null
        ) batch
    ),
    true,
    'the order provenance lists both recipe versions'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-grams', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'piece'
    ),
    '3',
    '2300 grams is the same 2.3 kilograms and the same 3 boxes'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000431',
      'pos-linear', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-linear', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the linear item maps to one kilogram per kilogram'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000432',
      'pos-linear', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-linear', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the linear item expects no options'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000433',
      'pos-linear', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '2', 'unit', 'piece'
      ))),
      (select app.packaging_base_schedule('pos-linear', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the linear item uses two boxes per kilogram'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-linear', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'piece'
    ),
    '4.6',
    'a weight line without capacity is linear per kilogram'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000441',
      'pos-cap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-cap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the capacity-ignore item maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000442',
      'pos-cap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-cap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the capacity-ignore item expects no options'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000443',
      'capignore', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('capignore') ->> 'token'),
      null
    )$$,
    'capignore has no order packaging'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000444',
      'pos-cap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'piece', 'capacity_kg', '0.4'
      ))),
      (select app.packaging_base_schedule('pos-cap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'a fixed line may carry a capacity that is not used'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-cap', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'piece'
    ),
    '1',
    'capacity is ignored on a fixed line'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000451',
      'pos-round', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '0.0000002', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-round', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'each rounding line maps a tiny salt quantity'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000452',
      'pos-round', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'exactly_one',
      (select app.pos_base_schedule('pos-round', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the rounding item expects one option'
  );

select
  lives_ok (
    $$select app.set_pos_option_mapping(
      'a4700000-0000-4000-8000-000000000453',
      'item', 'pos-round', '["none"]'::jsonb, 'زيادة',
      '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '0.0000002', 'unit', 'kg'
      ),
      (select app.pos_option_schedule('item', 'pos-round', '["none"]'::jsonb, 'زيادة') ->> 'token'),
      null
    )$$,
    'the rounding option adds the same tiny salt quantity'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000454',
      'pos-round', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '0.0000002', 'unit', 'piece'
      ))),
      (select app.packaging_base_schedule('pos-round', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'each rounding line adds a tiny box quantity'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000455',
      'round', '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '0.0000004', 'unit', 'piece'
      ))),
      (select app.packaging_order_type_schedule('round') ->> 'token'),
      null
    )$$,
    'the rounding order adds a tiny box quantity once'
  );

select
  is (
    app.resolve_line_requirements ('order-pack-round', 'line-r1') ->> 'status',
    'incomplete',
    'each rounding line is below precision on its own'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-round', null) ->> 'status',
    'ready',
    'the order rounds the summed lines once and stays ready'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-round', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'kg'
    ),
    '0.000001',
    'salt from both lines and their options rounds once to 0.000001'
  );

select
  is (
    (
      select
        e.value ->> 'quantity'
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements ('order-pack-round', null) -> 'requirements'
        ) as e
      where
        e.value ->> 'base_unit' = 'piece'
    ),
    '0.000001',
    'boxes from both lines plus the order round once to 0.000001'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000461',
      'pos-tiny', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '0.0000004', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-tiny', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the tiny order maps a quantity that rounds to zero'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000462',
      'pos-tiny', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-tiny', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the tiny item expects no options'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000463',
      'pos-tiny', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_base_schedule('pos-tiny', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the tiny item has no packaging'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000464',
      'tiny', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('tiny') ->> 'token'),
      null
    )$$,
    'the tiny order type has no packaging'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-tiny', null) ->> 'status',
    'incomplete',
    'an order total that rounds to zero is incomplete'
  );

select
  is (
    jsonb_typeof(
      app.resolve_order_requirements ('order-pack-tiny', null) -> 'requirements'
    ),
    'null',
    'below_precision clears the order requirements'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-tiny', null) -> 'causes',
    '["blocked"]'::jsonb,
    'below_precision is an order-level blocked cause'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-tiny', null) -> 'issues' -> 0 ->> 'code',
    'below_precision',
    'the order issue names below_precision'
  );

select
  lives_ok (
    $$select app.set_pos_exception(
      'a4700000-0000-4000-8000-000000000471',
      'pos-exc', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'خدمة',
      (select app.pos_base_schedule('pos-exc', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the service line is an exception'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000472',
      'empty', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('empty') ->> 'token'),
      null
    )$$,
    'the exception order type is approved as none'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-exc', null) ->> 'status',
    'ready',
    'an exception line does not block a covered order'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-exc', null) -> 'requirements',
    '[]'::jsonb,
    'an exception line contributes no requirements'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-exc', null) -> 'lines' -> 0 -> 'packaging' ->> 'state',
    'skipped',
    'item packaging is not required for an exception line'
  );

select
  lives_ok (
    $$select app.set_pos_exception(
      'a4700000-0000-4000-8000-000000000473',
      'pos-exc2', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'خدمة',
      (select app.pos_base_schedule('pos-exc2', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the second service line is an exception'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-excgap', null) -> 'causes',
    '["packaging_unreviewed"]'::jsonb,
    'an exception order with no order-type policy is unreviewed only'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-gapline', null) -> 'causes',
    '["line", "packaging_unreviewed"]'::jsonb,
    'an unmapped line and a missing item policy are both causes'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000481',
      'pos-block', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-block', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blocked item maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000482',
      'pos-block', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-block', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blocked item expects no options'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000483',
      'blocknone', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('blocknone') ->> 'token'),
      null
    )$$,
    'the blocked order type is approved as none'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000484',
      'pos-block', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'kg'
      ))),
      (select app.packaging_base_schedule('pos-block', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'a kilogram on a piece box is stored and blocked at resolve time'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-block', null) -> 'causes',
    '["blocked"]'::jsonb,
    'a packaging unit that cannot convert blocks the order'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-block', null) -> 'lines' -> 0 -> 'packaging' -> 'issues' -> 0 ->> 'code',
    'packaging_unit',
    'the blocked issue is packaging_unit'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-cancel', null) ->> 'status',
    'sales_only',
    'a canceled order is sales only'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-cancel', null) ->> 'cause',
    'canceled',
    'a canceled order names that cause'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-open', null) ->> 'cause',
    'open',
    'an active order is open'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-miss', null) ->> 'cause',
    'missing',
    'a missing order is missing'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-misscancel', null) ->> 'cause',
    'missing',
    'missing wins over a canceled status'
  );

select
  is (
    jsonb_typeof(
      app.resolve_order_requirements ('order-pack-cancel', null) -> 'requirements'
    ),
    'null',
    'a sales-only order has null requirements'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000491',
      'pos-none', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-none', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blank-type item maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000492',
      'pos-none', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-none', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blank-type item expects no options'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000493',
      'pos-none', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_base_schedule('pos-none', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blank-type item has no packaging'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000494',
      null, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule(null) ->> 'token'),
      null
    )$$,
    'a null order type can be approved'
  );

select
  is (
    app.packaging_order_type_schedule (null) ->> 'subject_id',
    app.packaging_order_type_schedule ('   ') ->> 'subject_id',
    'blank and null order types share one subject'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-none', null) ->> 'status',
    'ready',
    'a blank order type uses the none policy'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000495',
      'pos-long', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-long', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the long-type item maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000496',
      'pos-long', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-long', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the long-type item expects no options'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000497',
      'pos-long', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_base_schedule('pos-long', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the long-type item has no packaging'
  );

select
  throws_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000498',
      repeat('ن', 201), '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule(repeat('ن', 201)) ->> 'token'),
      null
    )$$,
    '22023',
    'order_type must be at most 200 characters',
    'a policy cannot be saved for a type longer than 200 characters'
  );

select
  is (
    app.resolve_order_requirements ('order-pack-long', null) -> 'causes',
    '["packaging_unreviewed"]'::jsonb,
    'a stored type longer than 200 characters stays unreviewed'
  );

-- June coverage. Line policies are ready where mapped; packaging policies differ by type.
select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000601',
      'pos-cov-ready', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-cov-ready', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the covered order item maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000602',
      'pos-cov-ready', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-cov-ready', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the covered order item expects no options'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000603',
      'pos-cov-ready', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_base_schedule('pos-cov-ready', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the covered order item has no packaging'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000604',
      'covready', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('covready') ->> 'token'),
      null
    )$$,
    'the covered order type has no packaging'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000611',
      'pos-cov-line', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_base_schedule('pos-cov-line', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the unmapped coverage line has an item policy'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000612',
      'covline', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('covline') ->> 'token'),
      null
    )$$,
    'the unmapped coverage order type has a policy'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000621',
      'pos-cov-gap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-cov-gap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the unreviewed coverage item maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000622',
      'pos-cov-gap', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-cov-gap', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the unreviewed coverage item expects no options'
  );

select
  lives_ok (
    $$select app.set_pos_base_mapping(
      'a4700000-0000-4000-8000-000000000631',
      'pos-cov-block', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity_per_basis', '1', 'unit', 'kg'
      ),
      (select app.pos_base_schedule('pos-cov-block', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blocked coverage item maps to salt'
  );

select
  lives_ok (
    $$select app.set_pos_option_policy(
      'a4700000-0000-4000-8000-000000000632',
      'pos-cov-block', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      'none_expected',
      (select app.pos_base_schedule('pos-cov-block', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blocked coverage item expects no options'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000633',
      'pos-cov-block', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_base_schedule('pos-cov-block', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the blocked coverage item has no packaging'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000634',
      'covblock', '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'kg'
      ))),
      (select app.packaging_order_type_schedule('covblock') ->> 'token'),
      null
    )$$,
    'the blocked coverage order type uses a unit that cannot convert'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000641',
      'covboth', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('covboth') ->> 'token'),
      null
    )$$,
    'the double-cause order type is approved'
  );

create temporary table pack_cov as
select
  app.pos_mapping_coverage (
    '2030-06-01 00:00:00+00',
    '2030-07-01 00:00:00+00'
  ) as doc;

select
  is (
    (
      select
        (doc ->> 'eligible_lines')::integer
      from
        pack_cov
    ),
    5,
    'line eligibility is unchanged by packaging'
  );

select
  is (
    (
      select
        (doc ->> 'ready_lines')::integer
      from
        pack_cov
    ),
    3,
    'a mapped line stays ready when only packaging is missing'
  );

select
  is (
    (
      select
        (doc ->> 'covered_lines')::integer
      from
        pack_cov
    ),
    3,
    'line coverage still counts ready lines'
  );

select
  is (
    (
      select
        (doc ->> 'coverage')::numeric
      from
        pack_cov
    ),
    0.6::numeric,
    'line coverage stays ready over eligible'
  );

select
  is (
    (
      select
        doc -> 'orders'
      from
        pack_cov
    ),
    jsonb_build_object(
      'eligible',
      5,
      'ready',
      1,
      'incomplete',
      4,
      'coverage',
      pg_catalog.round (1::numeric / 5, 6),
      'causes',
      jsonb_build_object(
        'line',
        2,
        'packaging_unreviewed',
        2,
        'blocked',
        1
      ),
      'excluded',
      jsonb_build_object(
        'canceled',
        2,
        'open',
        1,
        'missing',
        1,
        'before_stock_start',
        1
      )
    ),
    'order coverage counts ready orders and every incomplete cause'
  );

select
  is (
    (
      select
        e.value -> 'blocked'
      from
        pack_cov,
        pg_catalog.jsonb_array_elements (doc -> 'order_types') as e
      where
        e.value ->> 'label' = 'covblock'
    ),
    '1'::jsonb,
    'an order type is blocked only by its own policy'
  );

select
  is (
    (
      select
        e.value -> 'unreviewed'
      from
        pack_cov,
        pg_catalog.jsonb_array_elements (doc -> 'order_types') as e
      where
        e.value ->> 'label' = 'covgap'
    ),
    '1'::jsonb,
    'an order type with no policy is unreviewed'
  );

select
  is (
    (
      select
        e.value -> 'covered'
      from
        pack_cov,
        pg_catalog.jsonb_array_elements (doc -> 'order_types') as e
      where
        e.value ->> 'label' = 'covboth'
    ),
    '1'::jsonb,
    'item packaging does not change the order-type coverage'
  );

select
  is (
    (
      select
        e.value -> 'coverage'
      from
        pack_cov,
        pg_catalog.jsonb_array_elements (doc -> 'order_types') as e
      where
        e.value -> 'order_type_key' = '["none"]'::jsonb
    ),
    'null'::jsonb,
    'an order type with no eligible order has null coverage'
  );

select
  is (
    app.pos_mapping_coverage (
      '2031-01-01 00:00:00+00',
      '2031-02-01 00:00:00+00'
    ) -> 'orders' -> 'coverage',
    'null'::jsonb,
    'an empty window has null order coverage'
  );

select
  is (
    app.pos_mapping_coverage (
      '2031-01-01 00:00:00+00',
      '2031-02-01 00:00:00+00'
    ) -> 'order_types',
    '[]'::jsonb,
    'an empty window lists no order types'
  );

select
  is (
    jsonb_typeof(
      app.packaging_base_schedule ('pos-weight', '["none"]'::jsonb) -> 'versions' -> 0 -> 'lines' -> 0 -> 'quantity'
    ),
    'string',
    'schedule quantities are decimal text'
  );

select
  is (
    app.packaging_base_schedule ('pos-weight', '["none"]'::jsonb) -> 'versions' -> 0 -> 'lines' -> 0 ->> 'capacity_kg',
    '1',
    'schedule capacity is decimal text'
  );

select
  is (
    (
      select
        kind
      from
        app.costing_changes
      where
        request_id = 'a4700000-0000-4000-8000-000000000414'
    ),
    'mapping',
    'a packaging change reuses the mapping costing kind'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000701',
      'replay', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('replay') ->> 'empty_token'),
      null
    )$$,
    'the first replay request is saved'
  );

select
  is (
    app.set_order_type_packaging (
      'a4700000-0000-4000-8000-000000000701',
      'replay',
      '2030-01-01 00:00:00+00',
      null,
      '{"none": true}'::jsonb,
      (
        select
          app.packaging_order_type_schedule ('replay') ->> 'empty_token'
      ),
      null
    ) ->> 'token',
    app.packaging_order_type_schedule ('replay') ->> 'token',
    'the same request returns the committed token'
  );

select
  is (
    (
      select
        result ? 'subject_id'
      from
        app.costing_changes
      where
        request_id = 'a4700000-0000-4000-8000-000000000701'
    ),
    false,
    'the stored audit result has no subject id'
  );

select
  throws_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000701',
      'replay', '2030-01-01 00:00:00+00', null,
      'null'::jsonb,
      (select app.packaging_order_type_schedule('replay') ->> 'token'),
      null
    )$$,
    '22023',
    'request_id already used for a different change',
    'a different payload cannot reuse the request id'
  );

select
  throws_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000702',
      'replay', '2030-06-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('replay') ->> 'empty_token'),
      null
    )$$,
    '40001',
    'configuration changed',
    'a stale packaging token is rejected'
  );

select
  throws_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000711',
      'back', '2024-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('back') ->> 'token'),
      null
    )$$,
    '22023',
    'reason is required for a backdated change',
    'a backdated packaging policy needs a reason'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000712',
      'back', '2024-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('back') ->> 'token'),
      'مراجعة'
    )$$,
    'a backdated packaging policy with a reason is saved'
  );

select
  is (
    (
      select
        reason
      from
        app.costing_changes
      where
        request_id = 'a4700000-0000-4000-8000-000000000712'
    ),
    'مراجعة',
    'the backdating reason is stored'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000721',
      'nowtype', null, null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('nowtype') ->> 'token'),
      null
    )$$,
    'a null effective time is the now marker'
  );

select
  is (
    (
      select
        payload ->> 'effective_from'
      from
        app.costing_changes
      where
        request_id = 'a4700000-0000-4000-8000-000000000721'
    ),
    'now',
    'the now marker is stored as text'
  );

select
  is (
    (
      select
        date_trunc('minute', v.effective_from) = date_trunc('minute', now())
      from
        app.packaging_versions v
        join app.packaging_subjects s on s.id = v.subject_id
      where
        s.order_type_key = '["type", "nowtype"]'::jsonb
        and v.superseded_change_id is null
    ),
    true,
    'the now marker starts at the current minute'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000731',
      'frag', '2030-01-01 00:00:00+00', null,
      '{"none": true}'::jsonb,
      (select app.packaging_order_type_schedule('frag') ->> 'token'),
      null
    )$$,
    'the fragment subject starts as approved none'
  );

select
  lives_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000732',
      'frag', '2030-06-01 00:00:00+00', '2030-07-01 00:00:00+00',
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'piece'
      ))),
      (select app.packaging_order_type_schedule('frag') ->> 'token'),
      null
    )$$,
    'a middle interval splits the open policy'
  );

select
  is (
    (
      select
        jsonb_agg(
          v.value ->> 'decision'
          order by
            v.value ->> 'effective_from'
        )
      from
        pg_catalog.jsonb_array_elements (
          app.packaging_order_type_schedule ('frag') -> 'versions'
        ) as v
    ),
    '["none", "lines", "none"]'::jsonb,
    'the fragment keeps the approved none on both sides'
  );

select
  throws_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000801',
      'pos-kind', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'ملح التغليف'),
        'quantity', '1', 'unit', 'piece'
      ))),
      (select app.packaging_base_schedule('pos-kind', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '22023',
    'only packaging items can be packaging targets',
    'an ingredient cannot be a packaging target'
  );

select
  throws_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000802',
      'pos-price', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'piece', 'price', 1
      ))),
      (select app.packaging_base_schedule('pos-price', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '22023',
    'price-like key "price" is not allowed in a packaging payload',
    'a price key is rejected'
  );

select
  throws_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000803',
      'pos-extra', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'piece', 'note', 'x'
      ))),
      (select app.packaging_base_schedule('pos-extra', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '22023',
    'unknown key in packaging policy',
    'an unknown line key is rejected'
  );

select
  throws_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000804',
      'pos-dup', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(
        jsonb_build_object(
          'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
          'quantity', '1', 'unit', 'piece'
        ),
        jsonb_build_object(
          'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
          'quantity', '2', 'unit', 'piece'
        )
      )),
      (select app.packaging_base_schedule('pos-dup', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    '22023',
    'a packaging list names an item twice',
    'a packaging list cannot repeat an item'
  );

select
  throws_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000805',
      'capacity', '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التغليف'),
        'quantity', '1', 'unit', 'piece', 'capacity_kg', '1'
      ))),
      (select app.packaging_order_type_schedule('capacity') ->> 'token'),
      null
    )$$,
    '22023',
    'order packaging has no capacity',
    'an order-type line cannot carry capacity'
  );

select
  throws_ok (
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000806',
      'empty-lines', '2030-01-01 00:00:00+00', null,
      '{"lines": []}'::jsonb,
      (select app.packaging_order_type_schedule('empty-lines') ->> 'token'),
      null
    )$$,
    '22023',
    'a packaging list needs at least one line',
    'an empty packaging list is rejected'
  );

select
  lives_ok (
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000741',
      'pos-freeze', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
        'stock_item_id', (select id from app.stock_items where name = 'علبة التجميد'),
        'quantity', '1', 'unit', 'piece'
      ))),
      (select app.packaging_base_schedule('pos-freeze', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'the freeze box is referenced by a packaging policy'
  );

reset role;

select
  throws_ok (
    $$update app.stock_items set kind = 'ingredient' where name = 'علبة التجميد'$$,
    '23514',
    'cannot change kind of an item that is configured or has movements',
    'a packaging line freezes kind'
  );

select
  throws_ok (
    $$update app.stock_items set base_unit = 'kg' where name = 'علبة التجميد'$$,
    '23514',
    'cannot change base_unit of an item that is configured or has movements',
    'a packaging line freezes base_unit'
  );

select
  lives_ok (
    $$update app.stock_items set name = 'علبة التجميد معاد' where name = 'علبة التجميد'$$,
    'a packaging line does not freeze the name'
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
    $$select app.set_base_packaging(
      'a4700000-0000-4000-8000-000000000742',
      'pos-freeze', '["none"]'::jsonb, '2030-01-01 00:00:00+00', null,
      null,
      (select app.packaging_base_schedule('pos-freeze', '["none"]'::jsonb) ->> 'token'),
      null
    )$$,
    'clearing the policy supersedes the freeze'
  );

reset role;

select
  lives_ok (
    $$update app.stock_items set kind = 'ingredient' where name = 'علبة التجميد معاد'$$,
    'after the packaging version is superseded the kind can change'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.jsonb_array_elements (
          app.resolve_order_requirements_exact ('order-pack-round', null) -> 'requirements'
        ) as e
      where
        (e.value ->> 'numerator')::numeric / (e.value ->> 'denominator')::numeric = 0.0000008
    ),
    2::bigint,
    'the exact lookup keeps both unrounded 0.0000008 totals'
  );

select
  throws_ok (
    $$update app.packaging_versions set decision = 'none' where decision = 'lines'$$,
    '55000',
    null::text,
    'a version payload cannot change'
  );

select
  throws_ok (
    $$delete from app.packaging_versions$$,
    '55000',
    null::text,
    'a version cannot be deleted'
  );

select
  throws_ok (
    $$truncate app.packaging_versions$$,
    '0A000',
    null::text,
    'versions cannot be truncated while lines reference them'
  );

select
  throws_ok (
    $$update app.packaging_subjects set kind = 'base'$$,
    '55000',
    null::text,
    'a subject cannot change'
  );

select
  throws_ok (
    $$delete from app.packaging_lines$$,
    '55000',
    null::text,
    'a packaging line cannot be deleted'
  );

select
  throws_ok (
    $$truncate app.packaging_lines$$,
    '55000',
    null::text,
    'packaging lines cannot be truncated'
  );

insert into
  app.packaging_subjects (kind, order_type_key, created_change_id)
values
  (
    'order_type',
    '["type", "شكل"]'::jsonb,
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'a4700000-0000-4000-8000-000000000403'
    )
  );

insert into
  app.packaging_versions (
    effective_from,
    effective_to,
    created_change_id,
    subject_id,
    decision
  )
values
  (
    '2031-01-01 00:00:00+00',
    '2031-02-01 00:00:00+00',
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'a4700000-0000-4000-8000-000000000403'
    ),
    (
      select
        id
      from
        app.packaging_subjects
      where
        order_type_key = '["type", "شكل"]'::jsonb
    ),
    'none'
  );

select
  throws_ok (
    $$insert into app.packaging_versions (
      effective_from, effective_to, created_change_id, subject_id, decision
    ) values (
      '2031-01-15 00:00:00+00', '2031-03-01 00:00:00+00',
      (select id from app.costing_changes where request_id = 'a4700000-0000-4000-8000-000000000403'),
      (select id from app.packaging_subjects where order_type_key = '["type", "شكل"]'::jsonb),
      'none'
    )$$,
    '23P01',
    null::text,
    'two packaging versions cannot cover the same time'
  );

select
  throws_ok (
    $shape$do $body$
    begin
      insert into app.packaging_versions (
        effective_from, effective_to, created_change_id, subject_id, decision
      ) values (
        '2040-01-01 00:00:00+00', '2040-02-01 00:00:00+00',
        (select id from app.costing_changes where request_id = 'a4700000-0000-4000-8000-000000000403'),
        (select id from app.packaging_subjects where order_type_key = '["type", "شكل"]'::jsonb),
        'lines'
      );
      set constraints app.trg_packaging_versions_shape immediate;
    end
    $body$$shape$,
    '23514',
    'a packaging list needs at least one line',
    'a lines version without lines is rejected'
  );

select
  throws_ok (
    $$insert into app.packaging_lines (
      version_id, line_no, stock_item_id, quantity, unit_code
    )
    select v.id, 9, (select id from app.stock_items where name = 'ملح التغليف'), 1, 'kg'
    from app.packaging_versions v
    where v.decision = 'lines' and v.superseded_change_id is null
    limit 1$$,
    '23514',
    'only packaging items can be packaging targets',
    'a direct line cannot target an ingredient'
  );

select
  throws_ok (
    $$insert into app.packaging_lines (
      version_id, line_no, stock_item_id, quantity, unit_code, capacity_kg
    )
    select v.id, 2, (select id from app.stock_items where name = 'علبة التغليف'), 1, 'piece', 1
    from app.packaging_versions v
    join app.packaging_subjects s on s.id = v.subject_id
    where s.order_type_key = '["type", "hall"]'::jsonb
      and v.decision = 'lines'
      and v.superseded_change_id is null
    limit 1$$,
    '23514',
    'order packaging has no capacity',
    'a direct order-type line cannot carry capacity'
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
  throws_ok (
    $$select app.resolve_order_requirements_exact('order-pack-round', null)$$,
    '42501',
    null::text,
    'the exact order lookup is not an API function'
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
    $$select app.set_order_type_packaging(
      'a4700000-0000-4000-8000-000000000901',
      'hall', '2030-03-01 00:00:00+00', null, null, 'x', null
    )$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot set packaging'
  );

select
  throws_ok (
    $$select app.resolve_order_requirements('order-pack-fixed', null)$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot resolve an order'
  );

select
  throws_ok (
    $$select app.packaging_order_type_schedule('hall')$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot read a packaging schedule'
  );

select
  throws_ok (
    $$select app.pos_mapping_coverage('2030-06-01 00:00:00+00', '2030-07-01 00:00:00+00')$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot read coverage'
  );

select
  is (
    (
      select
        count(*)
      from
        app.packaging_subjects
    ),
    0::bigint,
    'a non-owner sees no packaging subjects'
  );

select
  is (
    (
      select
        count(*)
      from
        app.packaging_versions
    ),
    0::bigint,
    'a non-owner sees no packaging versions'
  );

select
  is (
    (
      select
        count(*)
      from
        app.packaging_observed_order_types
    ),
    0::bigint,
    'a non-owner sees no observed order types'
  );

set
  local role anon;

select
  throws_ok (
    $$select app.resolve_order_requirements('order-pack-fixed', null)$$,
    '42501',
    null::text,
    'anon cannot resolve an order'
  );

select
  throws_ok (
    $$select * from app.packaging_subjects$$,
    '42501',
    null::text,
    'anon cannot read packaging subjects'
  );

select
  throws_ok (
    $$select * from app.packaging_observed_order_types$$,
    '42501',
    null::text,
    'anon cannot read observed order types'
  );

set
  local role service_role;

select
  ok (
    (
      select
        count(*)
      from
        app.packaging_observed_order_types
    ) > 0,
    'service_role can read observed order types that have rows'
  );

select
  finish ();

rollback;
