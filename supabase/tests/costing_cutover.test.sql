begin;

select
  no_plan ();

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
-- The migration already ran the one-shot backfill. A second call is a no-op.
-- ============================================================================
select
  is (
    (
      select
        count(*)
      from
        app.costing_changes
      where
        kind = 'legacy'
        and payload ->> 'fn' = 'backfill_legacy_costing'
    ),
    1::bigint,
    'the migration stored one legacy cutover change'
  );

select
  is (
    (
      select
        result ->> 'loss_count'
      from
        app.costing_changes
      where
        payload ->> 'fn' = 'backfill_legacy_costing'
    ),
    '0',
    'an empty catalog backfills no loss versions'
  );

select
  is (
    (
      select
        result ->> 'alias_count'
      from
        app.costing_changes
      where
        payload ->> 'fn' = 'backfill_legacy_costing'
    ),
    '5',
    'cutover aliases are the five seeded labels'
  );

select
  is (
    app.backfill_legacy_costing ('2001-01-01T00:00:00Z'),
    (
      select
        result
      from
        app.costing_changes
      where
        payload ->> 'fn' = 'backfill_legacy_costing'
    ),
    'a second backfill returns the stored result'
  );

select
  is (
    (
      select
        count(*)
      from
        app.costing_changes
      where
        kind = 'legacy'
    ),
    1::bigint,
    'a second backfill writes no costing change'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions
    ),
    0::bigint,
    'a second backfill writes no loss version'
  );

-- ============================================================================
-- First-run snapshot behaviour, on fixtures the table owner seeds directly.
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
    'd4000000-0000-4000-8000-000000000001',
    'owner',
    null,
    null,
    '{"fn":"test_snapshot"}'::jsonb,
    '{"ok":true}'::jsonb
  );

alter table app.stock_items disable trigger trg_stock_items_loss_pct_frozen;

alter table app.item_unit_conversions disable trigger trg_item_unit_conversions_frozen;

alter table app.item_unit_conversions disable trigger trg_item_unit_conversions_reject_base_unit;

insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    loss_pct
  )
values
  (
    'd4000000-0000-4000-8000-000000000011',
    'صنف فاقد',
    'ingredient',
    'kg',
    'weekly',
    0.125
  ),
  (
    'd4000000-0000-4000-8000-000000000012',
    'صنف صفر',
    'ingredient',
    'kg',
    'weekly',
    0
  );

insert into
  app.item_unit_conversions (item_id, unit, factor_to_base)
values
  (
    'd4000000-0000-4000-8000-000000000011',
    'كرتونة',
    12
  ),
  (
    'd4000000-0000-4000-8000-000000000011',
    'لتر',
    0.92
  ),
  (
    'd4000000-0000-4000-8000-000000000011',
    'liter',
    0.92
  ),
  ('d4000000-0000-4000-8000-000000000011', 'kg', 1);

alter table app.stock_items enable trigger trg_stock_items_loss_pct_frozen;

alter table app.item_unit_conversions enable trigger trg_item_unit_conversions_reject_base_unit;

alter table app.item_unit_conversions enable trigger trg_item_unit_conversions_frozen;

-- A label that equals another unit's code must not become an alias.
insert into
  app.units (code, label_ar, dimension, metric_scale)
values
  ('كيس', 'kg', 'custom', null);

select
  app.legacy_costing_snapshot_work (
    '2000-06-01T00:00:00Z',
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'd4000000-0000-4000-8000-000000000001'
    )
  );

select
  results_eq (
    $$select si.name, v.loss_pct
      from app.item_loss_versions v
      join app.stock_items si on si.id = v.item_id
      where v.created_change_id = (
        select id from app.costing_changes
        where request_id = 'd4000000-0000-4000-8000-000000000001'
      )
      order by si.name$$,
    $$values ('صنف صفر'::text, 0::numeric), ('صنف فاقد'::text, 0.125::numeric)$$,
    'snapshot keeps a loss version for zero and for 0.125'
  );

select
  results_eq (
    $$select unit_code, factor_to_base
      from app.item_conversion_versions
      where item_id = 'd4000000-0000-4000-8000-000000000011'
        and superseded_change_id is null
      order by unit_code$$,
    $$values ('liter'::text, 0.92::numeric), ('كرتونة'::text, 12::numeric)$$,
    'لتر and liter merge onto liter, and كرتونة becomes a custom unit'
  );

select
  ok (
    exists (
      select
        1
      from
        app.units
      where
        code = 'كرتونة'
        and dimension = 'custom'
        and metric_scale is null
    ),
    'an unmapped legacy name becomes a custom unit'
  );

select
  is (
    (
      select
        count(*)
      from
        app.unit_aliases
      where
        alias in ('كرتونة', 'kg')
    ),
    0::bigint,
    'cutover skips an alias equal to a new code or to an existing code'
  );

select
  is (
    app.resolve_unit_code ('كرتونة'),
    'كرتونة',
    'a legacy name that became the code still resolves through the code'
  );

select
  is (
    (
      select
        unit_code
      from
        app.unit_aliases
      where
        alias = 'لتر'
    ),
    'liter',
    'the seeded لتر alias still points at liter'
  );

select
  lives_ok (
    $fn$do $body$
      declare
        v_id bigint;
      begin
        insert into app.costing_changes (request_id, kind, actor_id, reason, payload, result)
        values (
          'd4000000-0000-4000-8000-000000000002',
          'owner',
          null,
          null,
          '{"fn":"test_collision"}'::jsonb,
          '{"ok":true}'::jsonb
        )
        returning id into v_id;
        alter table app.item_unit_conversions disable trigger trg_item_unit_conversions_frozen;
        insert into app.item_unit_conversions (item_id, unit, factor_to_base)
        values ('d4000000-0000-4000-8000-000000000012', 'كيلو', 2);
        perform app.legacy_costing_snapshot_work('2000-07-01T00:00:00Z', v_id);
        raise exception 'expected a collision';
      exception
        when sqlstate '22023' then
          if position('صنف صفر' in sqlerrm) = 0
          or position('kg' in sqlerrm) = 0 then
            raise exception 'unexpected collision message: %', sqlerrm;
          end if;
      end
      $body$;$fn$,
    'a legacy name that maps onto the base unit with another factor raises'
  );

-- The caught collision rolled its own rows back. A different-factor merge:
select
  lives_ok (
    $fn$do $body$
      declare
        v_id bigint;
      begin
        insert into app.costing_changes (request_id, kind, actor_id, reason, payload, result)
        values (
          'd4000000-0000-4000-8000-000000000003',
          'owner',
          null,
          null,
          '{"fn":"test_factor_collision"}'::jsonb,
          '{"ok":true}'::jsonb
        )
        returning id into v_id;
        alter table app.stock_items disable trigger trg_stock_items_loss_pct_frozen;
        alter table app.item_unit_conversions disable trigger trg_item_unit_conversions_frozen;
        insert into app.stock_items (id, name, kind, base_unit, count_frequency, loss_pct)
        values (
          'd4000000-0000-4000-8000-000000000013',
          'صنف تعارض',
          'ingredient',
          'kg',
          'weekly',
          0
        );
        insert into app.units (code, label_ar, dimension, metric_scale)
        values ('صندوق', 'صندوق', 'custom', null);
        insert into app.item_unit_conversions (item_id, unit, factor_to_base)
        values
          ('d4000000-0000-4000-8000-000000000013', 'صندوق', 4),
          ('d4000000-0000-4000-8000-000000000013', 'box', 5);
        insert into app.unit_aliases (alias, unit_code, created_change_id)
        values ('box', 'صندوق', v_id);
        perform app.legacy_costing_snapshot_work('2000-08-01T00:00:00Z', v_id);
        raise exception 'expected a factor collision';
      exception
        when sqlstate '22023' then
          if position('صنف تعارض' in sqlerrm) = 0
          or position('صندوق' in sqlerrm) = 0 then
            raise exception 'unexpected factor message: %', sqlerrm;
          end if;
      end
      $body$;$fn$,
    'two legacy names that share a code and differ in factor raise'
  );

-- ============================================================================
-- Frozen legacy data. No GUC lets an API role or the table owner through.
-- ============================================================================
select
  set_config('app.legacy_costing_cutover', 'on', true);

select
  set_config('app.bypass', 'on', true);

select
  throws_ok (
    $$update app.stock_items
      set loss_pct = 0.2
      where id = 'd4000000-0000-4000-8000-000000000011'$$,
    '55000'::char(5),
    'stock_items.loss_pct is frozen; use app.set_item_loss',
    'the table owner cannot change loss_pct'
  );

select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency, loss_pct)
      values ('صنف فاقد مباشر', 'ingredient', 'kg', 'weekly', 0.1)$$,
    '55000'::char(5),
    'stock_items.loss_pct is frozen; use app.set_item_loss',
    'the table owner cannot insert a non-zero loss_pct'
  );

select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('d4000000-0000-4000-8000-000000000011', 'دلو', 3)$$,
    '55000'::char(5),
    'item_unit_conversions is frozen; use app.set_item_conversion',
    'the table owner cannot insert a legacy conversion'
  );

select
  throws_ok (
    $$truncate app.item_unit_conversions$$,
    '55000'::char(5),
    'item_unit_conversions is frozen; use app.set_item_conversion',
    'the table owner cannot truncate legacy conversions'
  );

set
  local role service_role;

select
  throws_ok (
    $$update app.stock_items
      set loss_pct = loss_pct
      where id = 'd4000000-0000-4000-8000-000000000011'$$,
    '55000'::char(5),
    'stock_items.loss_pct is frozen; use app.set_item_loss',
    'service_role cannot change loss_pct even when a GUC is set'
  );

select
  throws_ok (
    $$insert into app.item_unit_conversions (item_id, unit, factor_to_base)
      values ('d4000000-0000-4000-8000-000000000011', 'دلو', 3)$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'service_role cannot insert a legacy conversion'
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
  throws_ok (
    $$update app.stock_items
      set loss_pct = 0
      where id = 'd4000000-0000-4000-8000-000000000011'$$,
    '42501'::char(5),
    'permission denied for table stock_items',
    'authenticated cannot update loss_pct'
  );

select
  throws_ok (
    $$insert into app.stock_items (name, kind, base_unit, count_frequency, loss_pct)
      values ('صنف ممنوع', 'ingredient', 'kg', 'weekly', 0)$$,
    '42501'::char(5),
    'permission denied for table stock_items',
    'authenticated cannot insert stock_items, with or without loss_pct'
  );

select
  throws_ok (
    $$delete from app.item_unit_conversions$$,
    '42501'::char(5),
    'permission denied for table item_unit_conversions',
    'authenticated cannot delete legacy conversions'
  );

select
  throws_ok (
    $$select app.add_unit_conversion(
      'd4000000-0000-4000-8000-000000000011',
      'كرتونة',
      9,
      'kg'
    )$$,
    '0A000'::char(5),
    'use app.set_item_conversion',
    'add_unit_conversion refuses'
  );

select
  throws_ok (
    $$select app.update_unit_conversion(
      'd4000000-0000-4000-8000-000000000011',
      'كرتونة',
      12,
      9,
      'kg'
    )$$,
    '0A000'::char(5),
    'use app.set_item_conversion',
    'update_unit_conversion refuses'
  );

select
  throws_ok (
    $$select app.delete_unit_conversion(
      'd4000000-0000-4000-8000-000000000011',
      'كرتونة',
      12,
      'kg'
    )$$,
    '0A000'::char(5),
    'use app.set_item_conversion',
    'delete_unit_conversion refuses'
  );

-- ============================================================================
-- Dated readers. The owner buys كرتونة at 12, then the factor becomes 10.
-- ============================================================================
select
  app.add_custom_unit (
    'd4000000-0000-4000-8000-000000000101',
    'علبة',
    'علبة شراء'
  );

select
  app.create_stock_item (
    'd4000000-0000-4000-8000-000000000102',
    'صنف شراء',
    'ingredient',
    'kg',
    'weekly',
    null,
    0,
    true
  );

select
  app.set_item_conversion (
    'd4000000-0000-4000-8000-000000000103',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف شراء'
    ),
    'علبة',
    12,
    '2020-01-01T00:00:00Z',
    null,
    md5('kg|ingredient||'),
    'بداية التحويل'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2020-06-01T00:00:00Z',
      'request_id',
      'd4000000-0000-4000-8000-000000000104',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          (
            select
              id
            from
              app.stock_items
            where
              name = 'صنف شراء'
          ),
          'quantity',
          '2',
          'unit',
          'علبة',
          'amount_paid',
          '24',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '12'
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
        p.request_id = 'd4000000-0000-4000-8000-000000000104'
    ),
    24::numeric,
    'a purchase at t1 uses factor 12'
  );

select
  app.set_item_conversion (
    'd4000000-0000-4000-8000-000000000105',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف شراء'
    ),
    'علبة',
    10,
    '2021-01-01T00:00:00Z',
    null,
    (
      select
        conv ->> 'token'
      from
        jsonb_array_elements(
          app.item_costing_schedule (
            (
              select
                id
              from
                app.stock_items
              where
                name = 'صنف شراء'
            )
          ) -> 'conversions'
        ) conv
      where
        conv ->> 'unit_code' = 'علبة'
    ),
    'تخفيض العلبة'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2020-06-01T00:00:00Z',
      'request_id',
      'd4000000-0000-4000-8000-000000000106',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          (
            select
              id
            from
              app.stock_items
            where
              name = 'صنف شراء'
          ),
          'quantity',
          '1',
          'unit',
          'علبة',
          'amount_paid',
          '12',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '12'
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
        p.request_id = 'd4000000-0000-4000-8000-000000000106'
    ),
    12::numeric,
    'a back-dated purchase at t1 still uses factor 12'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2020-06-01T00:00:00Z',
      'request_id', 'd4000000-0000-4000-8000-000000000107',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', (select id from app.stock_items where name = 'صنف شراء'),
        'quantity', '1', 'unit', 'علبة', 'amount_paid', '10',
        'expected_base_unit', 'kg', 'expected_factor', '10'
      ))
    ))$$,
    '40001'::char(5),
    'conversion changed',
    'expected factor 10 does not match t1'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2021-06-01T00:00:00Z',
      'request_id',
      'd4000000-0000-4000-8000-000000000108',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          (
            select
              id
            from
              app.stock_items
            where
              name = 'صنف شراء'
          ),
          'quantity',
          '2',
          'unit',
          'علبة',
          'amount_paid',
          '20',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '10'
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
        p.request_id = 'd4000000-0000-4000-8000-000000000108'
    ),
    20::numeric,
    'a purchase at t3 uses factor 10'
  );

select
  is (
    app.record_purchase (
      jsonb_build_object(
        'purchased_at',
        '2020-06-01T00:00:00Z',
        'request_id',
        'd4000000-0000-4000-8000-000000000104',
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            (
              select
                id
              from
                app.stock_items
              where
                name = 'صنف شراء'
            ),
            'quantity',
            '2',
            'unit',
            'علبة',
            'amount_paid',
            '24',
            'expected_base_unit',
            'kg',
            'expected_factor',
            '12'
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
        request_id = 'd4000000-0000-4000-8000-000000000104'
    ),
    'replaying the purchase from before the factor change returns the saved purchase'
  );

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      '2021-06-01T00:00:00Z',
      'request_id',
      'd4000000-0000-4000-8000-000000000109',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          (
            select
              id
            from
              app.stock_items
            where
              name = 'صنف شراء'
          ),
          'quantity',
          '1000',
          'unit',
          'g',
          'amount_paid',
          '5',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '0.001'
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
        p.request_id = 'd4000000-0000-4000-8000-000000000109'
    ),
    1::numeric,
    'g on a kg item uses the implicit factor 0.001'
  );

select
  throws_ok (
    $$select app.record_purchase(jsonb_build_object(
      'purchased_at', '2021-06-01T00:00:00Z',
      'request_id', 'd4000000-0000-4000-8000-00000000010a',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', (select id from app.stock_items where name = 'صنف شراء'),
        'quantity', '1', 'unit', 'دلو', 'amount_paid', '5',
        'expected_base_unit', 'kg', 'expected_factor', '1'
      ))
    ))$$,
    '22023'::char(5),
    'unknown unit "دلو" for item صنف شراء',
    'an unknown unit names the original text and the item'
  );

select
  app.record_opening_stock (
    '2020-06-01T00:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        (
          select
            id
          from
            app.stock_items
          where
            name = 'صنف فاقد'
        ),
        'quantity',
        '3',
        'unit',
        'كرتونة',
        'unit_cost',
        '4',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '12'
      )
    ),
    'd4000000-0000-4000-8000-00000000010b'
  );

select
  is (
    (
      select
        on_hand_qty
      from
        app.item_balances
      where
        item_id = 'd4000000-0000-4000-8000-000000000011'
    ),
    36::numeric,
    'opening stock in كرتونة uses the dated factor 12'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'd4000000-0000-4000-8000-000000000011',
        'movement_type',
        'purchase',
        'occurred_at',
        '2020-07-01T00:00:00Z',
        'quantity',
        2,
        'unit',
        'كرتونة',
        'unit_cost',
        10
      )
    )
  );

select
  is (
    (
      select
        quantity
      from
        app.stock_movements
      where
        item_id = 'd4000000-0000-4000-8000-000000000011'
        and movement_type = 'purchase'
    ),
    24::numeric,
    'post_movements converts كرتونة with the dated factor'
  );

-- ============================================================================
-- Read models.
-- ============================================================================
select
  results_eq (
    $$select unit_code, source, factor_text
      from app.item_units_current
      where item_id = (select id from app.stock_items where name = 'صنف شراء')
      order by source, unit_code$$,
    $$values
      ('kg'::text, 'base'::text, '1'::text),
      ('علبة'::text, 'explicit'::text, '10'::text),
      ('g'::text, 'implicit'::text, '0.001'::text)$$,
    'current units are the base, the explicit علبة, and implicit g'
  );

select
  app.set_item_conversion (
    'd4000000-0000-4000-8000-000000000110',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف شراء'
    ),
    'g',
    0.002,
    null,
    null,
    md5('kg|ingredient||'),
    null
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_units_current
      where
        item_id = (
          select
            id
          from
            app.stock_items
          where
            name = 'صنف شراء'
        )
        and unit_code = 'g'
    ),
    1::bigint,
    'an explicit g replaces the implicit g instead of duplicating it'
  );

select
  is (
    (
      select
        source
      from
        app.item_units_current
      where
        item_id = (
          select
            id
          from
            app.stock_items
          where
            name = 'صنف شراء'
        )
        and unit_code = 'g'
    ),
    'explicit',
    'the explicit g is the row that remains'
  );

select
  is (
    (
      select
        factor_text
      from
        app.item_units_at (
          array[
            (
              select
                id
              from
                app.stock_items
              where
                name = 'صنف شراء'
            )
          ],
          '2020-06-01T00:00:00Z'
        )
      where
        unit_code = 'علبة'
    ),
    '12',
    'item_units_at resolves the factor that was in force at t1'
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
    'shift-open',
    '2024-01-01T08:00:00Z',
    null,
    true,
    '2024-01-01T08:00:00Z'
  );

set
  local role authenticated;

select
  is (
    app.current_shift_start (),
    '2024-01-01T08:00:00Z'::timestamptz,
    'current_shift_start is the open shift'
  );

reset role;

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
    content_hash
  )
values
  (
    'order-1',
    'shift-open',
    'complete',
    '2024-02-01T00:00:00Z',
    10,
    0,
    0,
    0,
    0,
    10,
    '2024-02-01T00:00:00Z',
    repeat('a', 64)
  ),
  (
    'order-2',
    'shift-open',
    'canceled',
    '2024-02-01T01:00:00Z',
    10,
    0,
    0,
    0,
    0,
    10,
    '2024-02-01T01:00:00Z',
    repeat('b', 64)
  );

set
  local role authenticated;

select
  is (
    app.costing_impact (
      '2024-01-01T00:00:00Z',
      '2024-03-01T00:00:00Z',
      'd4000000-0000-4000-8000-000000000012'
    ),
    jsonb_build_object(
      'orders',
      1,
      'shifts',
      1,
      'movements',
      (
        select
          count(*)
        from
          app.stock_movements
        where
          item_id = 'd4000000-0000-4000-8000-000000000012'
          and occurred_at >= '2024-01-01T00:00:00Z'
          and occurred_at < '2024-03-01T00:00:00Z'
      )
    ),
    'costing_impact counts complete orders and that item''s movements'
  );

reset role;

-- ============================================================================
-- Custom units, atomic create, and null effective_from.
-- ============================================================================
select
  is (
    app.add_custom_unit (
      'd4000000-0000-4000-8000-000000000101',
      'علبة',
      'علبة شراء'
    ),
    'علبة',
    'add_custom_unit replays the stored code'
  );

select
  throws_ok (
    $$select app.add_custom_unit(
      'd4000000-0000-4000-8000-000000000120',
      'كيلو',
      'كيلو تاني'
    )$$,
    '22023'::char(5),
    'unit already exists',
    'a code equal to an alias is refused'
  );

select
  is (
    (
      select
        result ->> 'alias'
      from
        app.costing_changes
      where
        request_id = 'd4000000-0000-4000-8000-000000000101'
    ),
    'علبة شراء',
    'add_custom_unit registers a free label as an alias'
  );

select
  is (
    app.add_custom_unit (
      'd4000000-0000-4000-8000-000000000150',
      'صندوق كود',
      'kg'
    ),
    'صندوق كود',
    'a label equal to an existing code still creates the unit'
  );

select
  is (
    (
      select
        result -> 'alias'
      from
        app.costing_changes
      where
        request_id = 'd4000000-0000-4000-8000-000000000150'
    ),
    'null'::jsonb,
    'a label equal to an existing code skips the alias and reports it'
  );

select
  ok (
    not exists (
      select
        1
      from
        app.unit_aliases
      where
        alias = 'kg'
    ),
    'no alias row equals the kg code'
  );

select
  is (
    app.add_custom_unit (
      'd4000000-0000-4000-8000-000000000151',
      'زجاجة',
      'لتر'
    ),
    'زجاجة',
    'a label equal to an existing alias still creates the unit'
  );

select
  is (
    (
      select
        unit_code
      from
        app.unit_aliases
      where
        alias = 'لتر'
    ),
    'liter',
    'a label equal to an existing alias leaves that alias where it is'
  );

select
  is (
    app.create_stock_item (
      'd4000000-0000-4000-8000-000000000102',
      'صنف شراء',
      'ingredient',
      'kg',
      'weekly',
      null,
      0,
      true
    ),
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف شراء'
    ),
    'create_stock_item replays the stored item id'
  );

select
  app.create_stock_item (
    'd4000000-0000-4000-8000-000000000121',
    'صنف بلا فاقد',
    'ingredient',
    'kg',
    'weekly',
    null,
    null,
    true
  );

select
  is (
    app.item_loss_at (
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف بلا فاقد'
      ),
      now()
    ),
    null::numeric,
    'a null loss on create leaves the loss unset'
  );

select
  is (
    app.item_loss_at (
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف شراء'
      ),
      now()
    ),
    0::numeric,
    'an explicit zero loss is stored and is distinct from unset'
  );

select
  app.set_item_loss (
    'd4000000-0000-4000-8000-000000000122',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف بلا فاقد'
    ),
    0.05,
    null,
    null,
    md5('kg|ingredient||'),
    null
  );

select
  is (
    (
      select
        payload ->> 'effective_from'
      from
        app.costing_changes
      where
        request_id = 'd4000000-0000-4000-8000-000000000122'
    ),
    'now',
    'a null effective_from is stored as the text now'
  );

select
  is (
    (
      select
        v.effective_from
      from
        app.item_loss_versions v
        join app.stock_items si on si.id = v.item_id
      where
        si.name = 'صنف بلا فاقد'
        and v.superseded_change_id is null
    ),
    pg_catalog.date_trunc ('minute', pg_catalog.now ()),
    'a null effective_from is the current minute and needs no reason'
  );

select
  is (
    (
      select
        v.effective_from
      from
        app.item_loss_versions v
        join app.stock_items si on si.id = v.item_id
      where
        si.name = 'صنف شراء'
        and v.superseded_change_id is null
    ),
    pg_catalog.date_trunc ('minute', pg_catalog.now ()),
    'create_stock_item starts the first loss at the current minute'
  );

-- The purchase form submits the start of the current minute. A conversion
-- saved as "now" must already be in force at that instant, which is before
-- the call whenever the clock is not exactly on the minute.
select
  app.set_item_conversion (
    'd4000000-0000-4000-8000-000000000123',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف بلا فاقد'
    ),
    'liter',
    0.92,
    null,
    null,
    md5('kg|ingredient||'),
    null
  );

select
  is (
    (
      select
        payload ->> 'effective_from'
      from
        app.costing_changes
      where
        request_id = 'd4000000-0000-4000-8000-000000000123'
    ),
    'now',
    'a null conversion effective_from stays the replay marker now'
  );

select
  is (
    (
      select
        v.effective_from
      from
        app.item_conversion_versions v
        join app.stock_items si on si.id = v.item_id
      where
        si.name = 'صنف بلا فاقد'
        and v.unit_code = 'liter'
        and v.superseded_change_id is null
    ),
    pg_catalog.date_trunc ('minute', pg_catalog.now ()),
    'a null conversion effective_from is the current minute'
  );

set
  local role authenticated;

select
  ok (
    (
      select
        factor_to_base = 0.92
      from
        app.item_units_at (
          array[
            (
              select
                id
              from
                app.stock_items
              where
                name = 'صنف بلا فاقد'
            )
          ],
          pg_catalog.date_trunc ('minute', pg_catalog.now ())
        )
      where
        unit_code = 'liter'
        and source = 'explicit'
    ),
    'a conversion from now is in force at the start of the same minute'
  );

reset role;

select
  throws_ok (
    $$select app.item_factor_at(
      (select id from app.stock_items where name = 'صنف بلا فاقد'),
      'liter',
      pg_catalog.date_trunc('minute', pg_catalog.now()) - interval '1 second'
    )$$,
    '22023'::char(5),
    'unknown unit "liter" for item صنف بلا فاقد',
    'a conversion from now is not in force in the previous minute'
  );

select
  app.create_stock_item (
    'd4000000-0000-4000-8000-000000000160',
    'صنف موقوف',
    'ingredient',
    'kg',
    'weekly',
    null,
    null,
    false
  );

select
  is (
    (
      select
        active
      from
        app.stock_items
      where
        name = 'صنف موقوف'
    ),
    false,
    'create_stock_item honours an inactive item'
  );

select
  is (
    app.create_stock_item (
      'd4000000-0000-4000-8000-000000000160',
      'صنف موقوف',
      'ingredient',
      'kg',
      'weekly',
      null,
      null,
      false
    ),
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف موقوف'
    ),
    'create_stock_item replays an inactive item'
  );

-- A finite version, a gap, then an open version. An edit inside the finite
-- version must stop at that version's own end.
select
  app.create_stock_item (
    'd4000000-0000-4000-8000-000000000180',
    'صنف فجوة',
    'ingredient',
    'kg',
    'weekly',
    null,
    null,
    true
  );

select
  app.set_item_loss (
    'd4000000-0000-4000-8000-000000000181',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف فجوة'
    ),
    0.10,
    '2000-01-01T00:00:00Z',
    '2000-06-01T00:00:00Z',
    md5('kg|ingredient||'),
    'تأسيس'
  );

select
  app.set_item_loss (
    'd4000000-0000-4000-8000-000000000182',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف فجوة'
    ),
    0.20,
    '2000-09-01T00:00:00Z',
    null,
    (
      select
        app.item_costing_schedule (si.id) -> 'loss' ->> 'token'
      from
        app.stock_items si
      where
        si.name = 'صنف فجوة'
    ),
    'لاحق'
  );

create temp table gap_later (id uuid) on
commit
drop;

insert into
  gap_later
select
  v.id
from
  app.item_loss_versions v
  join app.stock_items si on si.id = v.item_id
where
  si.name = 'صنف فجوة'
  and v.effective_from = '2000-09-01T00:00:00Z'
  and v.superseded_change_id is null;

select
  app.set_item_loss (
    'd4000000-0000-4000-8000-000000000183',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف فجوة'
    ),
    0.30,
    '2000-03-01T00:00:00Z',
    '2000-06-01T00:00:00Z',
    (
      select
        app.item_costing_schedule (si.id) -> 'loss' ->> 'token'
      from
        app.stock_items si
      where
        si.name = 'صنف فجوة'
    ),
    'تعديل جوه النسخة'
  );

select
  is (
    (
      select
        superseded_change_id
      from
        app.item_loss_versions
      where
        id = (
          select
            id
          from
            gap_later
        )
    ),
    null::bigint,
    'an edit inside a finite loss version leaves the later version row in place'
  );

select
  results_eq (
    $$select v.loss_pct::numeric, v.effective_from, v.effective_to
      from app.item_loss_versions v
      join app.stock_items si on si.id = v.item_id
      where si.name = 'صنف فجوة'
        and v.superseded_change_id is null
      order by v.effective_from$$,
    $$values
      (0.10::numeric, '2000-01-01T00:00:00Z'::timestamptz, '2000-03-01T00:00:00Z'::timestamptz),
      (0.30::numeric, '2000-03-01T00:00:00Z'::timestamptz, '2000-06-01T00:00:00Z'::timestamptz),
      (0.20::numeric, '2000-09-01T00:00:00Z'::timestamptz, null::timestamptz)$$,
    'an edit inside a finite loss version keeps that end and leaves the gap'
  );

select
  app.set_item_loss (
    'd4000000-0000-4000-8000-000000000184',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف فجوة'
    ),
    0.15,
    '2000-07-01T00:00:00Z',
    '2000-09-01T00:00:00Z',
    (
      select
        app.item_costing_schedule (si.id) -> 'loss' ->> 'token'
      from
        app.stock_items si
      where
        si.name = 'صنف فجوة'
    ),
    'تعديل جوه الفجوة'
  );

select
  is (
    app.item_loss_at (
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف فجوة'
      ),
      '2000-07-15T00:00:00Z'
    ),
    0.15::numeric,
    'an edit inside a gap stops at the next version'
  );

select
  is (
    (
      select
        superseded_change_id
      from
        app.item_loss_versions
      where
        id = (
          select
            id
          from
            gap_later
        )
    ),
    null::bigint,
    'an edit inside a gap leaves the later version row in place'
  );

-- A version ends 30 seconds into the current minute. The next version starts
-- at the next minute. "now" resolves to the truncated minute, inside the
-- first version, so an end at the next minute would fill the gap.
select
  app.create_stock_item (
    'd4000000-0000-4000-8000-000000000190',
    'صنف دقيقة',
    'ingredient',
    'kg',
    'weekly',
    null,
    null,
    true
  );

select
  app.set_item_loss (
    'd4000000-0000-4000-8000-000000000191',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف دقيقة'
    ),
    0.10,
    pg_catalog.date_trunc ('minute', pg_catalog.now ()),
    pg_catalog.date_trunc ('minute', pg_catalog.now ()) + interval '30 seconds',
    md5('kg|ingredient||'),
    'فجوة دقيقة'
  );

select
  app.set_item_loss (
    'd4000000-0000-4000-8000-000000000192',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف دقيقة'
    ),
    0.20,
    pg_catalog.date_trunc ('minute', pg_catalog.now ()) + interval '1 minute',
    null,
    (
      select
        app.item_costing_schedule (si.id) -> 'loss' ->> 'token'
      from
        app.stock_items si
      where
        si.name = 'صنف دقيقة'
    ),
    null
  );

select
  throws_ok (
    $$select app.set_item_loss(
      'd4000000-0000-4000-8000-000000000193',
      (select id from app.stock_items where name = 'صنف دقيقة'),
      0.30,
      null,
      pg_catalog.date_trunc('minute', pg_catalog.now()) + interval '1 minute',
      (
        select app.item_costing_schedule(si.id) -> 'loss' ->> 'token'
        from app.stock_items si
        where si.name = 'صنف دقيقة'
      ),
      null
    )$$,
    '40001'::char(5),
    'configuration changed',
    'a now write must not fill the sub-minute gap up to the next version'
  );

select
  app.set_item_loss (
    'd4000000-0000-4000-8000-000000000194',
    (
      select
        id
      from
        app.stock_items
      where
        name = 'صنف دقيقة'
    ),
    0.30,
    null,
    pg_catalog.date_trunc ('minute', pg_catalog.now ()) + interval '30 seconds',
    (
      select
        app.item_costing_schedule (si.id) -> 'loss' ->> 'token'
      from
        app.stock_items si
      where
        si.name = 'صنف دقيقة'
    ),
    null
  );

select
  is (
    app.item_loss_at (
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف دقيقة'
      ),
      pg_catalog.date_trunc ('minute', pg_catalog.now ()) + interval '45 seconds'
    ),
    null::numeric,
    'the sub-minute gap stays empty after the corrected now write'
  );

-- Halfway through the time already elapsed in this minute: earlier than
-- now(), and inside the minute whenever the clock is not exactly on it.
-- Only a null effective_from is exempt from the reason.
select
  throws_ok (
    $$select app.set_item_loss(
      'd4000000-0000-4000-8000-000000000195',
      (select id from app.stock_items where name = 'صنف بلا فاقد'),
      0.15,
      pg_catalog.date_trunc('minute', pg_catalog.now())
        + (
          pg_catalog.now() - pg_catalog.date_trunc('minute', pg_catalog.now())
        ) / 2,
      null,
      (
        select app.item_costing_schedule(si.id) -> 'loss' ->> 'token'
        from app.stock_items si
        where si.name = 'صنف بلا فاقد'
      ),
      null
    )$$,
    '22023'::char(5),
    'reason is required for a backdated change',
    'an explicit start inside the current minute needs a reason'
  );

select
  throws_ok (
    $$select app.set_item_conversion(
      'd4000000-0000-4000-8000-000000000196',
      (select id from app.stock_items where name = 'صنف بلا فاقد'),
      'liter',
      0.92,
      pg_catalog.date_trunc('minute', pg_catalog.now())
        + (
          pg_catalog.now() - pg_catalog.date_trunc('minute', pg_catalog.now())
        ) / 2,
      null,
      (
        select conv ->> 'token'
        from jsonb_array_elements(
          app.item_costing_schedule(
            (select id from app.stock_items where name = 'صنف بلا فاقد')
          ) -> 'conversions'
        ) conv
        where conv ->> 'unit_code' = 'liter'
      ),
      null
    )$$,
    '22023'::char(5),
    'reason is required for a backdated change',
    'a shift start inside the current minute needs a reason'
  );

-- The stored effective_to is already in the past. Replay must return the
-- stored result before the range check against now().
reset role;

insert into
  app.costing_changes (
    request_id,
    kind,
    actor_id,
    reason,
    payload,
    result
  )
select
  'd4000000-0000-4000-8000-000000000170',
  'owner',
  null,
  null,
  jsonb_build_object(
    'fn',
    'set_item_loss',
    'item_id',
    si.id,
    'loss_pct',
    pg_catalog.round (0.05, 5)::numeric(6, 5),
    'effective_from',
    'now',
    'effective_to',
    app.costing_timestamptz_text ('1999-01-01T00:00:00Z'),
    'expected_token',
    'ignored-token',
    'reason',
    null
  ),
  '{"sentinel":"loss-replay"}'::jsonb
from
  app.stock_items si
where
  si.name = 'صنف بلا فاقد';

insert into
  app.costing_changes (
    request_id,
    kind,
    actor_id,
    reason,
    payload,
    result
  )
select
  'd4000000-0000-4000-8000-000000000171',
  'owner',
  null,
  null,
  jsonb_build_object(
    'fn',
    'set_item_conversion',
    'item_id',
    si.id,
    'unit_code',
    'piece',
    'factor',
    pg_catalog.round (2, 9)::numeric(18, 9),
    'effective_from',
    'now',
    'effective_to',
    app.costing_timestamptz_text ('1999-01-01T00:00:00Z'),
    'expected_token',
    'ignored-token',
    'reason',
    null
  ),
  '{"sentinel":"conversion-replay"}'::jsonb
from
  app.stock_items si
where
  si.name = 'صنف بلا فاقد';

set
  local role authenticated;

select
  is (
    app.set_item_loss (
      'd4000000-0000-4000-8000-000000000170',
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف بلا فاقد'
      ),
      0.05,
      null,
      '1999-01-01T00:00:00Z',
      'ignored-token',
      null
    ),
    '{"sentinel":"loss-replay"}'::jsonb,
    'replay of a now-bounded loss returns the stored result after effective_to has passed'
  );

select
  is (
    app.set_item_conversion (
      'd4000000-0000-4000-8000-000000000171',
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف بلا فاقد'
      ),
      'piece',
      2,
      null,
      '1999-01-01T00:00:00Z',
      'ignored-token',
      null
    ),
    '{"sentinel":"conversion-replay"}'::jsonb,
    'replay of a now-bounded conversion returns the stored result after effective_to has passed'
  );

-- A conversion approved against kg must not land after the base unit becomes liter.
select
  app.create_stock_item (
    'd4000000-0000-4000-8000-000000000210',
    'صنف هوية',
    'ingredient',
    'kg',
    'weekly',
    null,
    null,
    true
  );

select
  is (
    app.item_costing_schedule (
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف هوية'
      )
    ) ->> 'empty_token',
    md5('kg|ingredient||'),
    'an empty schedule token is bound to base unit, kind, and parent'
  );

select
  is (
    app.item_costing_schedule (
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف هوية'
      )
    ) -> 'loss' ->> 'token',
    md5('kg|ingredient||'),
    'an empty loss token matches the identity-bound empty token'
  );

select
  lives_ok (
    $$update app.stock_items
      set base_unit = 'liter'
      where name = 'صنف هوية'$$,
    'base unit can change while the item has no loss, conversion, or movement'
  );

select
  is (
    app.item_costing_schedule (
      (
        select
          id
        from
          app.stock_items
        where
          name = 'صنف هوية'
      )
    ) -> 'loss' ->> 'token',
    md5('liter|ingredient||'),
    'the empty loss token follows the new base unit'
  );

select
  throws_ok (
    $$select app.set_item_conversion(
      'd4000000-0000-4000-8000-000000000211',
      (select id from app.stock_items where name = 'صنف هوية'),
      'piece',
      4,
      null,
      null,
      md5('kg|ingredient||'),
      null
    )$$,
    '40001'::char(5),
    'configuration changed',
    'retrying a conversion after the base unit changed is a conflict'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_conversion_versions v
        join app.stock_items si on si.id = v.item_id
      where
        si.name = 'صنف هوية'
    ),
    0::bigint,
    'a conflicting conversion retry inserts no conversion'
  );

select
  throws_ok (
    $$select app.set_item_loss(
      'd4000000-0000-4000-8000-000000000212',
      (select id from app.stock_items where name = 'صنف هوية'),
      0.10,
      null,
      null,
      md5('kg|ingredient||'),
      null
    )$$,
    '40001'::char(5),
    'configuration changed',
    'retrying a loss after the base unit changed is a conflict'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_loss_versions v
        join app.stock_items si on si.id = v.item_id
      where
        si.name = 'صنف هوية'
    ),
    0::bigint,
    'a conflicting loss retry inserts no loss'
  );

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

select
  throws_ok (
    $$select app.add_custom_unit(
      'd4000000-0000-4000-8000-000000000130',
      'دلو',
      'دلو'
    )$$,
    '42501'::char(5),
    'insufficient_privilege',
    'a non-owner cannot add a custom unit'
  );

select
  throws_ok (
    $$select app.create_stock_item(
      'd4000000-0000-4000-8000-000000000131',
      'صنف دخيل',
      'ingredient',
      'kg',
      'weekly',
      null,
      null,
      true
    )$$,
    '42501'::char(5),
    'insufficient_privilege',
    'a non-owner cannot create a stock item'
  );

select
  throws_ok (
    $$select * from app.item_units_at(array[]::uuid[], '2020-01-01T00:00:00Z')$$,
    '42501'::char(5),
    'insufficient_privilege',
    'a non-owner cannot call item_units_at'
  );

select
  throws_ok (
    $$select app.current_shift_start()$$,
    '42501'::char(5),
    'insufficient_privilege',
    'a non-owner cannot call current_shift_start'
  );

select
  throws_ok (
    $$select app.costing_impact('2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z', null)$$,
    '42501'::char(5),
    'insufficient_privilege',
    'a non-owner cannot call costing_impact'
  );

select
  is_empty (
    $$select * from app.item_units_current$$,
    'item_units_current exposes no rows to a non-owner'
  );

select
  is_empty (
    $$select * from app.unit_aliases$$,
    'unit_aliases exposes no rows to a non-owner'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    $$select * from app.item_units_current$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot read item_units_current'
  );

select
  throws_ok (
    $$select * from app.unit_aliases$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot read unit_aliases'
  );

select
  throws_ok (
    $$select * from app.item_units_at(array[]::uuid[], '2020-01-01T00:00:00Z')$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot call item_units_at'
  );

select
  throws_ok (
    $$select app.current_shift_start()$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot call current_shift_start'
  );

select
  throws_ok (
    $$select app.costing_impact('2020-01-01T00:00:00Z', null, null)$$,
    '42501'::char(5),
    'permission denied for schema app',
    'anon cannot call costing_impact'
  );

reset role;

-- ============================================================================
-- Privileges.
-- ============================================================================
select
  ok (
    has_function_privilege(
      'authenticated',
      'app.add_custom_unit(uuid,text,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'app.create_stock_item(uuid,text,text,text,text,uuid,numeric,boolean)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'app.item_units_at(uuid[],timestamptz)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'app.current_shift_start()',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'app.costing_impact(timestamptz,timestamptz,uuid)',
      'EXECUTE'
    ),
    'authenticated can execute the catalog writers and read models'
  );

select
  ok (
    not has_function_privilege(
      'anon',
      'app.add_custom_unit(uuid,text,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app.create_stock_item(uuid,text,text,text,text,uuid,numeric,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app.backfill_legacy_costing(timestamptz)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'app.legacy_costing_snapshot_work(timestamptz,bigint)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'app.resolve_unit_code(text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'public',
      'app.backfill_legacy_costing(timestamptz)',
      'EXECUTE'
    ),
    'internal cutover functions and service_role writers stay revoked'
  );

select
  ok (
    has_table_privilege(
      'authenticated',
      'app.item_units_current',
      'SELECT'
    )
    and has_table_privilege(
      'service_role',
      'app.item_units_current',
      'SELECT'
    )
    and has_table_privilege('authenticated', 'app.unit_aliases', 'SELECT')
    and not has_table_privilege('authenticated', 'app.unit_aliases', 'INSERT')
    and not has_table_privilege('service_role', 'app.unit_aliases', 'UPDATE'),
    'the units view and aliases are readable and not writable by API roles'
  );

select
  *
from
  finish ();

rollback;
