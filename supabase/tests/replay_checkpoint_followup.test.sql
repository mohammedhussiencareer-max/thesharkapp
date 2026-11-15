-- Follow-up defects. Dates come from one anchor, and the owner pin is that
-- same instant, so in-window and closed stay put on any day. Synthetic ids.
begin;

select
  no_plan ();

select
  set_config('app.test_clock', '2020-06-15 12:00:00+00', true);

select
  is (
    app.restatement_window_start (),
    (
      (
        (
          '2020-06-15 12:00:00+00'::timestamptz at time zone 'Africa/Cairo'
        )::date - 34
      )::timestamp
    ) at time zone 'Africa/Cairo',
    'the owner clock pin chooses the restatement window'
  );

select
  is (
    app.test_clock_pin (),
    '2020-06-15 12:00:00+00'::timestamptz,
    'the database owner can read the clock pin'
  );

select
  is (
    has_function_privilege('anon', 'app.test_clock_pin()', 'execute'),
    false,
    'anon cannot execute the clock pin'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.test_clock_pin()',
      'execute'
    ),
    false,
    'authenticated cannot execute the clock pin'
  );

select
  is (
    has_function_privilege('service_role', 'app.test_clock_pin()', 'execute'),
    false,
    'service_role cannot execute the clock pin'
  );

select
  ok (
    app.replay_plan_uses_deficit_index (
      'Index Scan using replay_checkpoint_deficits_pkey on replay_checkpoint_deficits'
    ),
    'a deficit restore index scan is recognized'
  );

select
  ok (
    not app.replay_plan_uses_deficit_index ('Seq Scan on replay_checkpoint_deficits'),
    'a deficit restore sequence scan is not an index read'
  );

create temp table f6_anchor as
select
  pg_catalog.clock_timestamp () as at;

select
  set_config(
    'app.test_clock',
    (
      select
        anchor.at::text
      from
        f6_anchor anchor
    ),
    true
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
    'f6e00000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-f6@theshark.test',
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
  ('f6e00000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'f6e00000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000001',
    'f6 cover',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000002',
    'f6 add',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000003',
    'f6 reduce',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000004',
    'f6 seed',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000005',
    'f6 return',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000006',
    'f6 chain',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000007',
    'f6 void',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000008',
    'f6 reason',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000009',
    'f6 freeze',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-00000000000a',
    'f6 map a',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-00000000000b',
    'f6 map b',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000101',
    'f6e00000-0000-4000-8000-000000000001',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000102',
    'f6e00000-0000-4000-8000-000000000002',
    20,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000103',
    'f6e00000-0000-4000-8000-000000000003',
    20,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000104',
    'f6e00000-0000-4000-8000-000000000004',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000105',
    'f6e00000-0000-4000-8000-000000000005',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000106',
    'f6e00000-0000-4000-8000-000000000006',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000107',
    'f6e00000-0000-4000-8000-000000000007',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000108',
    'f6e00000-0000-4000-8000-000000000008',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000109',
    'f6e00000-0000-4000-8000-000000000009',
    10,
    null,
    null,
    'kg|seafood||'
  );

-- (a) A later purchase between two sales resumes the earlier checkpoint.
-- The deficit already has a cover. That cover's value has to come with it.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '3 days' + interval '8 hours'
          from
            f6_anchor anchor
        ),
        'quantity',
        10
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000001',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '3 days' + interval '10 hours'
          from
            f6_anchor anchor
        ),
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '3 days' + interval '12 hours'
          from
            f6_anchor anchor
        ),
        'quantity',
        1
      )
    )
  );

select
  ok (
    exists (
      select
        1
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000001'
        and not exists (
          select
            1
          from
            app.replay_checkpoint_invalidations invalidation
          where
            invalidation.checkpoint_id = checkpoint.id
        )
    ),
    'the partial cover publishes a checkpoint the next purchase can resume'
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day' + interval '8 hours'
          from
            f6_anchor anchor
        ),
        'quantity',
        1
      )
    )
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'f6e00000-0000-4000-8000-000000000001',
      'movement_type', 'purchase',
      'occurred_at', (select at - interval '2 days' + interval '8 hours' from f6_anchor),
      'quantity', 5,
      'unit_cost', 20
    )))$$,
    'a purchase between the two sales does not confirm critical'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-000000000001'
    ),
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000001'
    ),
    'a resumed partial cover keeps the earlier cover value in the ledger'
  );

-- (b) Additions use today's unit. Reductions give back the posted share.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000002',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        20,
        'unit_cost',
        20
      )
    )
  );

insert into
  app.recognized_contribution (
    source_kind,
    source_id,
    item_id,
    bucket,
    quantity,
    amount
  )
values
  (
    'order',
    'f6-add',
    'f6e00000-0000-4000-8000-000000000002',
    'cogs',
    10,
    100
  );

select
  app.post_closed_order_difference (
    'f6-add',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000002',
        'quantity',
        12
      )
    ),
    'cogs',
    'sale',
    null
  );

select
  is (
    (
      select
        movement.quantity::text || '/' || movement.total_cost::text
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000002'
        and movement.movement_type = 'closed_period'
        and movement.quantity <> 0
    ),
    '-2.000000/-40.00',
    'two added units are priced at today''s unit, not the whole quantity'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000003',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        20,
        'unit_cost',
        20
      )
    )
  );

insert into
  app.recognized_contribution (
    source_kind,
    source_id,
    item_id,
    bucket,
    quantity,
    amount
  )
values
  (
    'order',
    'f6-reduce',
    'f6e00000-0000-4000-8000-000000000003',
    'cogs',
    10,
    100
  );

select
  lives_ok (
    $$select app.post_closed_order_difference(
      'f6-reduce',
      jsonb_build_array(jsonb_build_object(
        'stock_item_id', 'f6e00000-0000-4000-8000-000000000003',
        'quantity', 9
      )),
      'cogs', 'sale', null
    )$$,
    'returning one posted unit is not rejected'
  );

select
  is (
    (
      select
        movement.quantity::text || '/' || movement.total_cost::text
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000003'
        and movement.movement_type = 'closed_period'
        and movement.quantity <> 0
    ),
    '1.000000/10.00',
    'a reduction returns the posted share of the recognized value'
  );

-- (g) An unpriced closed waste takes the current basis before it is frozen.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000009',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000009',
        'movement_type',
        'waste',
        'occurred_at',
        (
          select
            anchor.at - interval '40 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        5
      )
    )
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-000000000009'
    ),
    '5.000000/50.00',
    'a closed waste posted after stock exists is priced from the current basis'
  );

select
  is (
    (
      select
        movement.closed_bucket
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000009'
        and movement.movement_type = 'closed_period'
    ),
    'waste',
    'a closed waste is posted in the waste bucket'
  );

-- (d) Seeding counts cost adjustments already attached to the posted sale.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000004',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        5
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000004',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days' + interval '1 hour'
          from
            f6_anchor anchor
        ),
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
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
values
  (
    'f6-seed',
    'f6-shift',
    'complete',
    'hall',
    (
      select
        anchor.at - interval '2 days'
      from
        f6_anchor anchor
    ),
    0,
    0,
    0,
    0,
    0,
    0,
    (
      select
        anchor.at - interval '2 days'
      from
        f6_anchor anchor
    ),
    rpad(md5('f6-seed'), 64, 'a'),
    false
  );

select
  app.append_pos_cost_input ('f6-seed', null, 'sync');

insert into
  app.order_cost_applications (
    order_id,
    cost_input_id,
    snapshot_id,
    receipt_kind,
    disposition,
    occurred_at,
    shift_id,
    signature,
    requirements,
    work_generation
  )
select
  'f6-seed',
  input.id,
  input.snapshot_id,
  'posting',
  'sale',
  (
    select
      anchor.at - interval '2 days'
    from
      f6_anchor anchor
  ),
  'f6-shift',
  md5('f6-seed-app'),
  '[]'::jsonb,
  1
from
  app.pos_cost_inputs input
where
  input.order_id = 'f6-seed';

insert into
  app.order_cost_state (
    order_id,
    latest_input_id,
    latest_application_id,
    owner_application_id,
    disposition,
    signature
  )
select
  'f6-seed',
  input.id,
  application.id,
  application.id,
  'sale',
  md5('f6-seed-app')
from
  app.pos_cost_inputs input
  join app.order_cost_applications application on application.order_id = input.order_id
where
  input.order_id = 'f6-seed';

insert into
  app.order_cost_movement_links (movement_id, application_id, order_id, item_id)
select
  movement.id,
  application.id,
  'f6-seed',
  movement.item_id
from
  app.stock_movements movement
  join app.order_cost_applications application on application.order_id = 'f6-seed'
where
  movement.item_id = 'f6e00000-0000-4000-8000-000000000004'
  and movement.movement_type = 'sale';

select
  app.seed_order_recognized ('f6-seed');

select
  is (
    (
      select
        contribution.quantity::text || '/' || contribution.amount::text
      from
        app.recognized_contribution contribution
      where
        contribution.source_kind = 'order'
        and contribution.source_id = 'f6-seed'
    ),
    '5.000000/100.00',
    'a covered provisional sale seeds the posted cost, including its adjustment'
  );

-- (h, i) A reason-only closed correction posts both reason legs and no
-- historical shift.
update app.accounting_rederive_spans
set
  completed_at = pg_catalog.clock_timestamp ()
where
  completed_at is null;

insert into
  app.inventory_activation (
    stock_started_at,
    approved_by,
    request_id,
    opening_manifest_hash
  )
values
  (
    (
      select
        anchor.at - interval '80 days'
      from
        f6_anchor anchor
    ),
    'f6e00000-0000-4000-8000-0000000000a1',
    'f6e00000-0000-4000-8000-000000000111',
    repeat('c', 32)
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000008',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      )
    )
  );

insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time
  )
select
  'f6-hist',
  anchor.at - interval '40 days',
  anchor.at - interval '40 days' + interval '8 hours',
  false,
  anchor.at - interval '40 days'
from
  f6_anchor anchor;

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000201',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '40 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'spoilage',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000008',
          'quantity',
          '5',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000202',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '40 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'other',
      'explanation',
      'moved',
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'f6e00000-0000-4000-8000-000000000201'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000008',
          'quantity',
          '5',
          'unit',
          'kg'
        )
      )
    )
  );

select
  ok (
    (
      select
        document.batch_id is not null
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000202'
    ),
    'a reason-only closed correction still has a posting batch'
  );

select
  results_eq (
    $$select movement.quantity::text, movement.total_cost::text, source.reason_code, source.report_class
      from app.stock_movements movement
      join app.closed_period_sources source on source.movement_id = movement.id
      join app.waste_documents document on document.batch_id = movement.batch_id
      where document.request_id = 'f6e00000-0000-4000-8000-000000000202'
      order by movement.piece_position$$,
    $$values ('0.000000', '50.00', 'spoilage', 'manual'),
             ('0.000000', '-50.00', 'other', 'manual')$$,
    'a reason change posts the old reason back and the new reason out'
  );

select
  is (
    (
      select
        source.waste_chain_id
      from
        app.closed_period_sources source
        join app.waste_documents document on document.batch_id = source.closed_cause_id
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000202'
      limit
        1
    ),
    'f6e00000-0000-4000-8000-000000000201'::uuid,
    'a closed waste correction keeps the root request as its chain'
  );

select
  is (
    (
      select
        attribution.shift_id
      from
        app.movement_attributions attribution
        join app.stock_movements movement on movement.id = attribution.movement_id
        join app.waste_documents document on document.batch_id = movement.batch_id
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000202'
      limit
        1
    ),
    null::text,
    'a closed correction with only a historical shift is attributed to none'
  );

select
  is (
    (
      select
        document.shift_id
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000202'
    ),
    'f6-hist',
    'the correction document keeps the historical shift'
  );

insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time
  )
select
  'f6-now',
  anchor.at - interval '1 hour',
  anchor.at + interval '2 hours',
  true,
  anchor.at
from
  f6_anchor anchor;

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000203',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '40 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'other',
      'explanation',
      'trimmed',
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'f6e00000-0000-4000-8000-000000000202'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000008',
          'quantity',
          '4',
          'unit',
          'kg'
        )
      )
    )
  );

select
  is (
    (
      select
        attribution.shift_id
      from
        app.movement_attributions attribution
        join app.stock_movements movement on movement.id = attribution.movement_id
        join app.waste_documents document on document.batch_id = movement.batch_id
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000203'
      limit
        1
    ),
    'f6-now',
    'a closed correction is attributed to the shift that contains the change'
  );

-- (f) A closed correction seeds the live chain, not the root alone.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000006',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        20,
        'unit_cost',
        10
      )
    )
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000211',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '2 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'spoilage',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000006',
          'quantity',
          '5',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000212',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '2 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'spoilage',
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'f6e00000-0000-4000-8000-000000000211'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000006',
          'quantity',
          '7',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.apply_closed_waste_delta (
    (
      select
        document.id
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000212'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000006',
        'base_quantity',
        8
      )
    ),
    false,
    'spoilage'
  );

select
  is (
    (
      select
        coalesce(sum(- movement.quantity), 0)
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000006'
        and movement.movement_type in ('waste', 'waste_reversal', 'closed_period')
    ),
    8::numeric,
    'a closed correction of a live chain adds the difference from the live quantity'
  );

create temporary table f6_void as
select
  app.apply_closed_waste_delta (
    (
      select
        document.id
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000212'
    ),
    '[]'::jsonb,
    true,
    null
  ) as cause;

select
  is (
    (
      select
        coalesce(sum(movement.quantity), 0)
      from
        app.stock_movements movement
        join f6_void voided on voided.cause = movement.batch_id
    ),
    8::numeric,
    'a void of a live waste chain returns 8, the live quantity'
  );

-- (e) A return cancels the returned order's own deficit before FIFO.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000005',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      )
    )
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000005',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day' + interval '1 hour'
          from
            f6_anchor anchor
        ),
        'quantity',
        10
      )
    )
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000005',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day' + interval '2 hours'
          from
            f6_anchor anchor
        ),
        'quantity',
        5
      )
    )
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
values
  (
    'f6-qb',
    'f6-shift',
    'complete',
    'hall',
    (
      select
        anchor.at - interval '1 day'
      from
        f6_anchor anchor
    ),
    0,
    0,
    0,
    0,
    0,
    0,
    (
      select
        anchor.at - interval '1 day'
      from
        f6_anchor anchor
    ),
    rpad(md5('f6-qb'), 64, 'a'),
    false
  ),
  (
    'f6-qa',
    'f6-shift',
    'complete',
    'hall',
    (
      select
        anchor.at - interval '1 day'
      from
        f6_anchor anchor
    ),
    0,
    0,
    0,
    0,
    0,
    0,
    (
      select
        anchor.at - interval '1 day'
      from
        f6_anchor anchor
    ),
    rpad(md5('f6-qa'), 64, 'a'),
    false
  );

select
  app.append_pos_cost_input ('f6-qb', null, 'sync');

select
  app.append_pos_cost_input ('f6-qa', null, 'sync');

insert into
  app.order_cost_applications (
    order_id,
    cost_input_id,
    snapshot_id,
    receipt_kind,
    disposition,
    occurred_at,
    shift_id,
    signature,
    requirements,
    work_generation
  )
select
  orders.id,
  input.id,
  input.snapshot_id,
  'posting',
  'sale',
  (
    select
      anchor.at - interval '1 day'
    from
      f6_anchor anchor
  ),
  'f6-shift',
  md5(orders.id),
  '[]'::jsonb,
  1
from
  app.pos_orders orders
  join app.pos_cost_inputs input on input.order_id = orders.id
where
  orders.id in ('f6-qb', 'f6-qa');

insert into
  app.order_cost_state (
    order_id,
    latest_input_id,
    latest_application_id,
    owner_application_id,
    disposition,
    signature
  )
select
  application.order_id,
  application.cost_input_id,
  application.id,
  application.id,
  'sale',
  application.signature
from
  app.order_cost_applications application
where
  application.order_id in ('f6-qb', 'f6-qa');

insert into
  app.order_cost_movement_links (movement_id, application_id, order_id, item_id)
select
  movement.id,
  application.id,
  application.order_id,
  movement.item_id
from
  app.order_cost_applications application
  join app.stock_movements movement on movement.item_id = 'f6e00000-0000-4000-8000-000000000005'
  and movement.movement_type = 'sale'
  and (
    (
      application.order_id = 'f6-qb'
      and movement.quantity = -10
    )
    or (
      application.order_id = 'f6-qa'
      and movement.quantity = -5
    )
  );

insert into
  app.recognized_contribution (
    source_kind,
    source_id,
    item_id,
    bucket,
    quantity,
    amount
  )
values
  (
    'order',
    'f6-qb',
    'f6e00000-0000-4000-8000-000000000005',
    'cogs',
    10,
    100
  );

select
  app.post_closed_order_difference (
    'f6-qb',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000005',
        'quantity',
        12
      )
    ),
    'cogs',
    'sale',
    null
  );

insert into
  app.order_cost_movement_links (movement_id, application_id, order_id, item_id)
select
  movement.id,
  application.id,
  'f6-qb',
  movement.item_id
from
  app.stock_movements movement
  join app.order_cost_applications application on application.order_id = 'f6-qb'
where
  movement.item_id = 'f6e00000-0000-4000-8000-000000000005'
  and movement.movement_type = 'closed_period'
  and movement.quantity < 0;

select
  app.post_recognized_delta (
    'f6e00000-0000-4000-8000-000000000301',
    'order',
    'f6-qb',
    'f6e00000-0000-4000-8000-000000000005',
    'cogs',
    'sale',
    10,
    100,
    null,
    null,
    null,
    (
      select
        movement.id
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000005'
        and movement.movement_type = 'sale'
        and movement.quantity = -10
    ),
    null,
    1
  );

select
  app.finish_closed_cause (
    'f6e00000-0000-4000-8000-000000000301',
    array['f6e00000-0000-4000-8000-000000000005']::uuid[]
  );

select
  is (
    (
      select
        deficit.qty_uncovered
      from
        app.provisional_deficits deficit
        join app.order_cost_movement_links link on link.movement_id = deficit.movement_id
      where
        link.order_id = 'f6-qa'
    ),
    5::numeric,
    'a return of order B does not consume order A''s deficit'
  );

select
  is (
    (
      select
        coalesce(sum(deficit.qty_uncovered), 0)
      from
        app.provisional_deficits deficit
        join app.order_cost_movement_links link on link.movement_id = deficit.movement_id
      where
        link.order_id = 'f6-qb'
        and deficit.qty_uncovered > 0
    ),
    0::numeric,
    'a return cancels the deficit that belongs to the returned order'
  );

-- (c) A span returns an item the order no longer uses.
select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-00000000010a',
    'f6e00000-0000-4000-8000-00000000000a',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-00000000010b',
    'f6e00000-0000-4000-8000-00000000000b',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_loss (
    'f6e00000-0000-4000-8000-00000000010c',
    'f6e00000-0000-4000-8000-00000000000b',
    0,
    (
      select
        anchor.at - interval '80 days'
      from
        f6_anchor anchor
    ),
    null,
    (
      select
        app.schedule_token (
          'loss',
          'f6e00000-0000-4000-8000-00000000000b',
          null
        )
    ),
    'fixture'
  );

select
  app.set_pos_option_policy (
    'f6e00000-0000-4000-8000-00000000010d',
    'f6-pos',
    '["none"]'::jsonb,
    (
      select
        anchor.at - interval '80 days'
      from
        f6_anchor anchor
    ),
    null,
    'none_expected',
    (
      select
        app.pos_base_schedule ('f6-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_base_packaging (
    'f6e00000-0000-4000-8000-00000000010e',
    'f6-pos',
    '["none"]'::jsonb,
    (
      select
        anchor.at - interval '80 days'
      from
        f6_anchor anchor
    ),
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_base_schedule ('f6-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_pos_base_mapping (
    'f6e00000-0000-4000-8000-00000000010f',
    'f6-pos',
    '["none"]'::jsonb,
    (
      select
        anchor.at - interval '80 days'
      from
        f6_anchor anchor
    ),
    null,
    jsonb_build_object(
      'stock_item_id',
      'f6e00000-0000-4000-8000-00000000000b',
      'quantity_per_basis',
      '1',
      'unit',
      'kg'
    ),
    (
      select
        app.pos_base_schedule ('f6-pos', '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

select
  app.set_order_type_packaging (
    'f6e00000-0000-4000-8000-000000000110',
    'hall',
    (
      select
        anchor.at - interval '80 days'
      from
        f6_anchor anchor
    ),
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_order_type_schedule ('hall') ->> 'token'
    ),
    'fixture'
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
    'f6-shift',
    (
      select
        anchor.at - interval '80 days'
      from
        f6_anchor anchor
    ),
    null,
    true,
    (
      select
        anchor.at - interval '80 days'
      from
        f6_anchor anchor
    )
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
values
  (
    'f6-map',
    'f6-shift',
    'complete',
    'hall',
    (
      select
        anchor.at - interval '40 days'
      from
        f6_anchor anchor
    ),
    0,
    0,
    0,
    0,
    0,
    0,
    (
      select
        anchor.at - interval '40 days'
      from
        f6_anchor anchor
    ),
    rpad(md5('f6-map'), 64, 'a'),
    false
  );

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    options,
    line_total
  )
values
  ('f6-map', 'l1', 'f6-pos', 'x', 10, '[]'::jsonb, 0);

select
  app.append_pos_cost_input ('f6-map', null, 'sync');

insert into
  app.recognized_contribution (
    source_kind,
    source_id,
    item_id,
    bucket,
    quantity,
    amount
  )
values
  (
    'order',
    'f6-map',
    'f6e00000-0000-4000-8000-00000000000a',
    'cogs',
    10,
    100
  );

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'f6e00000-0000-4000-8000-000000000112',
    'owner',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into
  app.accounting_rederive_spans (
    family,
    version_id,
    cause,
    change_id,
    effective_from
  )
select
  'pos_map',
  'f6e00000-0000-4000-8000-000000000113',
  'insert',
  change.id,
  (
    select
      anchor.at - interval '80 days'
    from
      f6_anchor anchor
  )
from
  app.costing_changes change
where
  change.request_id = 'f6e00000-0000-4000-8000-000000000112';

insert into
  app.closed_span_orders (span_id, order_id, ordered_at)
select
  span.id,
  'f6-map',
  (
    select
      anchor.at - interval '40 days'
    from
      f6_anchor anchor
  )
from
  app.accounting_rederive_spans span
  join app.costing_changes change on change.id = span.change_id
where
  change.request_id = 'f6e00000-0000-4000-8000-000000000112';

select
  app.post_accumulated_closed_span (
    (
      select
        span.id
      from
        app.accounting_rederive_spans span
        join app.costing_changes change on change.id = span.change_id
      where
        change.request_id = 'f6e00000-0000-4000-8000-000000000112'
    )
  );

select
  is (
    (
      select
        coalesce(sum(movement.quantity), 0)
      from
        app.stock_movements movement
      where
        movement.source_id = 'f6-map'
        and movement.item_id = 'f6e00000-0000-4000-8000-00000000000a'
    ),
    10::numeric,
    'a span returns the item the order no longer uses'
  );

select
  is (
    (
      select
        coalesce(sum(movement.quantity), 0)
      from
        app.stock_movements movement
      where
        movement.source_id = 'f6-map'
        and movement.item_id = 'f6e00000-0000-4000-8000-00000000000b'
    ),
    -10::numeric,
    'a span deducts the item the order now uses'
  );

-- A purchase that is the newest movement still replays when it covers an
-- open deficit, so the checkpoint restore is the cover's read.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000000c',
    'f6 aged cover',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000114',
    'f6e00000-0000-4000-8000-00000000000c',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000000c',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '40 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        1
      )
    )
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-00000000000c']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000401',
    true
  );

delete from app.replay_read_probe;

select
  set_config('app.replay_probe', '1', true);

select
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      (
        select
          to_char(
            anchor.at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
        from
          f6_anchor anchor
      ),
      'request_id',
      'f6e00000-0000-4000-8000-000000000115',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-00000000000c',
          'quantity',
          '1',
          'unit',
          'kg',
          'amount_paid',
          '10.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  is (
    (
      select
        probe.deficit_rows > 0
        and probe.deficit_plan <> ''
      from
        app.replay_read_probe probe
      order by
        probe.id desc
      limit
        1
    ),
    true,
    'a newest purchase covering an open deficit replays that checkpoint'
  );

select
  is (
    (
      select
        coalesce(sum(deficit.qty_uncovered), 0)
      from
        app.provisional_deficits deficit
      where
        deficit.item_id = 'f6e00000-0000-4000-8000-00000000000c'
    ),
    0::numeric,
    'that purchase covers the aged deficit'
  );

-- (b) A reclassification moves the retained quantity at its posted value.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000000d',
    'f6 reclass',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000116',
    'f6e00000-0000-4000-8000-00000000000d',
    20,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000000d',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        20,
        'unit_cost',
        20
      )
    )
  );

insert into
  app.recognized_contribution (
    source_kind,
    source_id,
    item_id,
    bucket,
    quantity,
    amount
  )
values
  (
    'order',
    'f6-reclass',
    'f6e00000-0000-4000-8000-00000000000d',
    'cogs',
    10,
    100
  );

select
  app.post_closed_order_difference (
    'f6-reclass',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-00000000000d',
        'quantity',
        10
      )
    ),
    'waste',
    'waste',
    null
  );

select
  results_eq (
    $$select movement.closed_bucket, movement.quantity::text, movement.total_cost::text
      from app.stock_movements movement
      where movement.item_id = 'f6e00000-0000-4000-8000-00000000000d'
        and movement.movement_type = 'closed_period'
        and movement.quantity <> 0
      order by movement.closed_bucket$$,
    $$values ('cogs', '10.000000', '100.00'),
             ('waste', '-10.000000', '-100.00')$$,
    'a reclassification transfers the posted 100 and does not reprice it at 20'
  );

-- (h1) 10/100 staff_meal corrected to 6/60 spoilage.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000007',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        20,
        'unit_cost',
        10
      )
    )
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000221',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '2 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'staff_meal',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000007',
          'quantity',
          '10',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.apply_closed_waste_delta (
    (
      select
        document.id
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000221'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000007',
        'base_quantity',
        6
      )
    ),
    false,
    'spoilage'
  );

select
  results_eq (
    $$select source.reason_code, sum(movement.total_cost)::text
      from app.stock_movements movement
      join app.closed_period_sources source on source.movement_id = movement.id
      where movement.item_id = 'f6e00000-0000-4000-8000-000000000007'
      group by source.reason_code
      order by source.reason_code$$,
    $$values ('spoilage', '-60.00'), ('staff_meal', '100.00')$$,
    'a reason change returns the old reason at its posted value and posts the new quantity on the new reason'
  );

-- (h2) An explanation-only correction still inserts the document.
select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000222',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '40 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'other',
      'explanation',
      'noted',
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'f6e00000-0000-4000-8000-000000000203'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000008',
          'quantity',
          '4',
          'unit',
          'kg'
        )
      )
    )
  );

select
  ok (
    (
      select
        document.batch_id is not null
        and not document.is_void
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000222'
    ),
    'an explanation-only closed correction inserts with a batch'
  );

-- (h2) A reason change of a zero-cost line still inserts the document.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000010',
    'f6 zero waste',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000223',
    'f6e00000-0000-4000-8000-000000000010',
    0,
    'fixture',
    null,
    'kg|seafood||'
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000224',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '40 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'other',
      'explanation',
      'zero',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000010',
          'quantity',
          '1',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000225',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '40 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'spoilage',
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'f6e00000-0000-4000-8000-000000000224'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000010',
          'quantity',
          '1',
          'unit',
          'kg'
        )
      )
    )
  );

select
  ok (
    (
      select
        document.batch_id is not null
        and not document.is_void
        and document.reason_code = 'spoilage'
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000225'
    ),
    'a zero-cost reason change inserts with a batch'
  );

-- (a) A cover already in the frozen prefix survives after the deficit ages.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000000e',
    'f6 aged deficit',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000117',
    'f6e00000-0000-4000-8000-00000000000e',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000000e',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '10 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        10
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000000e',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '9 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-00000000000e']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000402',
    true
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at + interval '40 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000000e',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at + interval '40 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
  );

select
  is (
    (
      select
        coalesce(sum(adjustment.total_cost), 0)
      from
        app.stock_movements adjustment
        join app.stock_movements sale on sale.id = adjustment.adjusts_movement_id
      where
        sale.item_id = 'f6e00000-0000-4000-8000-00000000000e'
        and sale.movement_type = 'sale'
        and adjustment.movement_type = 'cost_adjustment'
    ),
    -50::numeric,
    'covering the rest of an aged deficit keeps the prefix cover'
  );

-- (N1) A later cover refreshes the recognized value before a full return.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000000f',
    'f6 recognized cover',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000118',
    'f6e00000-0000-4000-8000-00000000000f',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        anchor.at::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000000f',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '40 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        5
      )
    )
  );

insert into
  app.recognized_contribution (
    source_kind,
    source_id,
    item_id,
    bucket,
    quantity,
    amount
  )
values
  (
    'order',
    'f6-n1',
    'f6e00000-0000-4000-8000-00000000000f',
    'cogs',
    5,
    50
  );

insert into
  app.order_cost_movement_links (movement_id, application_id, order_id, item_id)
select
  movement.id,
  (
    select
      application.id
    from
      app.order_cost_applications application
    where
      application.order_id = 'f6-qb'
    limit
      1
  ),
  'f6-n1',
  movement.item_id
from
  app.stock_movements movement
where
  movement.item_id = 'f6e00000-0000-4000-8000-00000000000f'
  and movement.movement_type = 'sale';

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000000f',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        5,
        'unit_cost',
        20
      )
    )
  );

select
  is (
    (
      select
        contribution.amount
      from
        app.recognized_contribution contribution
      where
        contribution.source_id = 'f6-n1'
        and contribution.item_id = 'f6e00000-0000-4000-8000-00000000000f'
    ),
    100::numeric,
    'a cover refreshes the recognized value of the closed pieces'
  );

select
  app.post_closed_order_difference ('f6-n1', '[]'::jsonb, 'cogs', 'sale', null);

select
  is (
    (
      select
        movement.quantity::text || '/' || movement.total_cost::text
      from
        app.stock_movements movement
        join app.closed_period_sources source on source.movement_id = movement.id
      where
        source.source_kind = 'return'
        and movement.item_id = 'f6e00000-0000-4000-8000-00000000000f'
    ),
    '5.000000/100.00',
    'a full return restores the covered value'
  );

-- The earlier cover moved the pin. These orders are judged from the anchor.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        anchor.at::text
      from
        f6_anchor anchor
    ),
    true
  );

-- A span is the first poster of a complete order that needs 10 and has a
-- confirmed return of 2, so the deduction is 8.
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
  'f6-ret',
  'f6-shift',
  'complete',
  'hall',
  anchor.at - interval '40 days',
  0,
  0,
  0,
  0,
  0,
  100,
  anchor.at - interval '40 days',
  rpad(md5('f6-ret'), 64, 'a'),
  false
from
  f6_anchor anchor;

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    options,
    line_total
  )
values
  ('f6-ret', 'l1', 'f6-pos', 'x', 10, '[]'::jsonb, 0);

insert into
  app.pos_refund_revisions (
    shift_id,
    tx_id,
    order_id,
    tx_type,
    amount,
    occurred_at,
    present,
    origin
  )
select
  'f6-shift',
  'f6-ret-tx',
  'f6-ret',
  3,
  20,
  anchor.at - interval '40 days',
  true,
  'sync'
from
  f6_anchor anchor;

select
  app.append_pos_cost_input ('f6-ret', null, 'sync');

do $$
declare
  v_input bigint;
  v_ctx jsonb;
  v_event bigint;
begin
  v_input := app.order_processing_input_id ('f6-ret');
  v_ctx := app.disposition_effective_context (v_input, null);

  insert into
    app.order_disposition_events (
      order_id,
      episode,
      decision,
      class,
      source,
      owner_reviewed,
      actor,
      reason,
      cost_input_id,
      prep_snapshot_id,
      prep_hash,
      q_items,
      q_signature,
      refund_revision_ids,
      refund_signature,
      order_total,
      refund_total,
      returned
    )
  values
    (
      'f6-ret',
      1,
      'not_made',
      v_ctx ->> 'class',
      'owner',
      true,
      'f6e00000-0000-4000-8000-0000000000a1',
      'returned two',
      v_input,
      (v_ctx ->> 'prep_snapshot_id')::bigint,
      v_ctx ->> 'prep_hash',
      v_ctx -> 'q_items',
      v_ctx ->> 'q_signature',
      coalesce(
        (
          select
            pg_catalog.array_agg(elem.value::bigint)
          from
            pg_catalog.jsonb_array_elements_text(v_ctx -> 'refund_ids') as elem (value)
        ),
        '{}'::bigint[]
      ),
      v_ctx ->> 'refund_signature',
      (v_ctx ->> 'order_total')::numeric,
      (v_ctx ->> 'refund_total')::numeric,
      jsonb_build_array(
        jsonb_build_object(
          'stock_item_id',
          'f6e00000-0000-4000-8000-00000000000b',
          'returned',
          '2'
        )
      )
    )
  returning
    id into v_event;

  insert into
    app.order_disposition_state (
      order_id,
      episode,
      is_open,
      event_id,
      class,
      cost_input_id
    )
  values
    (
      'f6-ret',
      1,
      true,
      v_event,
      v_ctx ->> 'class',
      v_input
    );
end;
$$;

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'f6e00000-0000-4000-8000-000000000119',
    'owner',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into
  app.accounting_rederive_spans (
    family,
    version_id,
    cause,
    change_id,
    effective_from
  )
select
  'pos_map',
  'f6e00000-0000-4000-8000-00000000011a',
  'insert',
  change.id,
  (
    select
      anchor.at - interval '80 days'
    from
      f6_anchor anchor
  )
from
  app.costing_changes change
where
  change.request_id = 'f6e00000-0000-4000-8000-000000000119';

insert into
  app.closed_span_orders (span_id, order_id, ordered_at)
select
  span.id,
  'f6-ret',
  (
    select
      anchor.at - interval '40 days'
    from
      f6_anchor anchor
  )
from
  app.accounting_rederive_spans span
  join app.costing_changes change on change.id = span.change_id
where
  change.request_id = 'f6e00000-0000-4000-8000-000000000119';

select
  app.post_accumulated_closed_span (
    (
      select
        span.id
      from
        app.accounting_rederive_spans span
        join app.costing_changes change on change.id = span.change_id
      where
        change.request_id = 'f6e00000-0000-4000-8000-000000000119'
    )
  );

select
  is (
    (
      select
        coalesce(sum(movement.quantity), 0)
      from
        app.stock_movements movement
      where
        movement.source_id = 'f6-ret'
        and movement.item_id = 'f6e00000-0000-4000-8000-00000000000b'
    ),
    -8::numeric,
    'a span over an order that needs 10 with a confirmed return of 2 deducts 8'
  );

-- (N2) A closed correction 10 -> 8 keeps the return on the new owner, so a
-- later move into the window does not post the 8 again.
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
  'f6-n2',
  'f6-shift',
  'complete',
  'hall',
  anchor.at - interval '40 days',
  0,
  0,
  0,
  0,
  0,
  0,
  anchor.at - interval '40 days',
  rpad(md5('f6-n2'), 64, 'a'),
  false
from
  f6_anchor anchor;

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    options,
    line_total
  )
values
  ('f6-n2', 'l1', 'f6-pos', 'x', 10, '[]'::jsonb, 0);

select
  app.append_pos_cost_input ('f6-n2', null, 'sync');

select
  app.process_order_accounting (
    'f6-n2',
    'f6e00000-0000-4000-8000-00000000011c',
    1
  );

update app.pos_orders
set
  version = version + 1,
  pos_update_time = pos_update_time + interval '1 minute',
  content_hash = rpad(md5('f6-n2-8'), 64, 'b')
where
  id = 'f6-n2';

update app.pos_order_lines
set
  quantity = 8
where
  order_id = 'f6-n2';

select
  app.capture_pos_order_snapshot ('f6-n2', null, 'sync');

select
  app.append_pos_cost_input ('f6-n2', null, 'sync');

select
  app.process_order_accounting (
    'f6-n2',
    'f6e00000-0000-4000-8000-00000000011d',
    1
  );

select
  ok (
    (
      select
        exists (
          select
            1
          from
            app.order_cost_state state
            join app.order_cost_movement_links link on link.application_id = state.owner_application_id
            join app.closed_period_sources source on source.movement_id = link.movement_id
          where
            state.order_id = 'f6-n2'
            and source.source_kind = 'return'
        )
    ),
    'a closed correction links its return to the new owner'
  );

update app.pos_orders
set
  version = version + 1,
  ordered_at = (
    select
      anchor.at - interval '1 day'
    from
      f6_anchor anchor
  ),
  pos_update_time = pos_update_time + interval '1 minute',
  content_hash = rpad(md5('f6-n2-in'), 64, 'c')
where
  id = 'f6-n2';

select
  app.capture_pos_order_snapshot ('f6-n2', null, 'sync');

select
  app.append_pos_cost_input ('f6-n2', null, 'sync');

select
  app.process_order_accounting (
    'f6-n2',
    'f6e00000-0000-4000-8000-00000000011e',
    1
  );

select
  is (
    (
      select
        coalesce(sum(movement.quantity), 0)
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-00000000000b'
        and (
          movement.source_id = 'f6-n2'
          or exists (
            select
              1
            from
              app.order_cost_movement_links link
            where
              link.movement_id = movement.id
              and link.order_id = 'f6-n2'
          )
          or exists (
            select
              1
            from
              app.closed_period_sources source
              join app.stock_movements original on original.id::text = source.source_id
            where
              source.movement_id = movement.id
              and source.source_kind = 'return'
              and (
                original.source_id = 'f6-n2'
                or exists (
                  select
                    1
                  from
                    app.order_cost_movement_links prior
                  where
                    prior.order_id = 'f6-n2'
                    and prior.movement_id = original.id
                )
              )
          )
        )
    ),
    -8::numeric,
    'moving a corrected closed order into the window does not post the 8 again'
  );

select
  finish ();

rollback;
