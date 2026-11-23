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
    'sale'
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
      'cogs', 'sale'
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
    'sale'
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
    'waste'
  );

select
  results_eq (
    $$select movement.closed_bucket, movement.quantity::text, movement.total_cost::text
      from app.stock_movements movement
      where movement.item_id = 'f6e00000-0000-4000-8000-00000000000d'
        and movement.movement_type = 'closed_period'
      order by movement.closed_bucket, movement.total_cost desc$$,
    $$values ('cogs', '0.000000', '100.00'),
             ('waste', '0.000000', '-100.00')$$,
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
  app.post_closed_order_difference ('f6-n1', '[]'::jsonb, 'cogs', 'sale');

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

-- (a) A full walk preserves a cover that was posted in the window and has since aged out.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000011',
    'f6 full walk',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000301',
    'f6e00000-0000-4000-8000-000000000011',
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
        'f6e00000-0000-4000-8000-000000000011',
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
        10
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000011',
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
        movement.total_cost
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000011'
        and movement.movement_type = 'cost_adjustment'
    ),
    -50.00,
    'the in-window partial cover is an adjustment of 50 before it ages'
  );

create temp table f6_full_snap as
select
  balance.on_hand_qty,
  balance.on_hand_value,
  (
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object('id', movement.id, 'total', movement.total_cost)
          order by
            movement.id
        ),
        '[]'::jsonb
      )
    from
      app.stock_movements movement
    where
      movement.item_id = 'f6e00000-0000-4000-8000-000000000011'
  ) as movements
from
  app.item_balances balance
where
  balance.item_id = 'f6e00000-0000-4000-8000-000000000011';

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'full-walk'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000011'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000011']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000302',
    true
  );

select
  is (
    (
      select
        jsonb_build_object(
          'qty',
          balance.on_hand_qty,
          'value',
          balance.on_hand_value,
          'movements',
          (
            select
              coalesce(
                jsonb_agg(
                  jsonb_build_object('id', movement.id, 'total', movement.total_cost)
                  order by
                    movement.id
                ),
                '[]'::jsonb
              )
            from
              app.stock_movements movement
            where
              movement.item_id = 'f6e00000-0000-4000-8000-000000000011'
          )
        )
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-000000000011'
    ),
    (
      select
        jsonb_build_object(
          'qty',
          snap.on_hand_qty,
          'value',
          snap.on_hand_value,
          'movements',
          snap.movements
        )
      from
        f6_full_snap snap
    ),
    'a full walk leaves the aged adjustment untouched and the ledger equal to the snapshot'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

-- A checkpointed item keeps its cut when the call also names a new item.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000016',
    'f6 scale kept',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000017',
    'f6 scale new',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000316',
    'f6e00000-0000-4000-8000-000000000016',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000317',
    'f6e00000-0000-4000-8000-000000000017',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000016',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '3 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000016',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000016',
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
        1,
        'unit_cost',
        10
      )
    )
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000016']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000031c',
    true
  );

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000016',
      'f6e00000-0000-4000-8000-000000000017'
    ]::uuid[],
    jsonb_build_array(
      jsonb_build_object(
        'line_key',
        1,
        'item_id',
        'f6e00000-0000-4000-8000-000000000017',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10,
        'total_cost',
        10,
        'batch_id',
        'f6e00000-0000-4000-8000-000000000319'
      )
    ),
    'f6e00000-0000-4000-8000-000000000318',
    true
  );

select
  ok (
    (
      select
        (detail ->> 'checkpoint_id') is not null
        and (detail ->> 'rows_loaded')::bigint = 0
        and (detail ->> 'prefix_rows')::bigint = 0
        and (
          select
            count(*)
          from
            app.stock_movements movement
          where
            movement.item_id = 'f6e00000-0000-4000-8000-000000000016'
        ) >= 3
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000016'
    )
    and (
      select
        detail -> 'checkpoint_id' = 'null'::jsonb
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000017'
    ),
    'a checkpointed item keeps its cut and loads only its suffix beside a new item'
  );

-- A sort-linked pair walks together. An unrelated item in the same call does not.
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
    'f6e00000-0000-4000-8000-000000000018',
    'f6 scale mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000019',
    'f6 scale size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000018'
  ),
  (
    'f6e00000-0000-4000-8000-00000000001a',
    'f6 scale other',
    'seafood',
    'kg',
    'daily',
    null
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000328',
    'f6e00000-0000-4000-8000-000000000018',
    10,
    null,
    null,
    'kg|fish_mixed||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000329',
    'f6e00000-0000-4000-8000-000000000019',
    10,
    null,
    null,
    'kg|fish_size|f6e00000-0000-4000-8000-000000000018|'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-00000000032a',
    'f6e00000-0000-4000-8000-00000000001a',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000018',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000001a',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        4,
        'unit_cost',
        10
      )
    )
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000018',
    (
      select
        anchor.at - interval '1 day'
      from
        f6_anchor anchor
    ),
    4,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000019',
        'quantity',
        4
      )
    )
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000018',
      'f6e00000-0000-4000-8000-000000000019',
      'f6e00000-0000-4000-8000-00000000001a'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000032c',
    true
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'sort-component'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000019'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

delete from app.replay_read_probe;

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000018',
      'f6e00000-0000-4000-8000-000000000019',
      'f6e00000-0000-4000-8000-00000000001a'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000032b',
    true
  );

select
  ok (
    (
      select
        detail -> 'checkpoint_id' = 'null'::jsonb
        and (detail ->> 'rows_loaded')::bigint > 0
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000018'
    )
    and (
      select
        detail -> 'checkpoint_id' = 'null'::jsonb
        and (detail ->> 'rows_loaded')::bigint > 0
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000019'
    )
    and (
      select
        (detail ->> 'checkpoint_id') is not null
        and (detail ->> 'rows_loaded')::bigint = 0
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-00000000001a'
    )
    and (
      select
        probe.prefix_rows > 0
      from
        app.replay_read_probe probe
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
    ),
    'a sort-linked pair walks from the start, an unrelated item keeps its cut, and a full walk reports its prefix'
  );

-- (h1) A reason change of an uncovered closed waste keeps the original deficit.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000012',
    'f6 reason age',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000312',
    'f6e00000-0000-4000-8000-000000000012',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at - interval '40 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000322',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '40 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'staff_meal',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000012',
          'quantity',
          '10',
          'unit',
          'kg'
        )
      )
    )
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

create temp table f6_h1_waste as
select
  movement.id,
  movement.occurred_at
from
  app.stock_movements movement
  join app.waste_line_movements link on link.movement_id = movement.id
where
  movement.item_id = 'f6e00000-0000-4000-8000-000000000012'
  and movement.movement_type = 'waste';

select
  app.apply_closed_waste_delta (
    (
      select
        document.id
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000322'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000012',
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
      where movement.item_id = 'f6e00000-0000-4000-8000-000000000012'
      group by source.reason_code
      order by source.reason_code$$,
    $$values ('spoilage', '-60.00'), ('staff_meal', '100.00')$$,
    'a closed reason change returns the old reason at its posted value and posts the retained value on the new reason'
  );

select
  is (
    (
      select
        deficit.qty_uncovered
      from
        app.provisional_deficits deficit
      where
        deficit.movement_id = (
          select
            waste.id
          from
            f6_h1_waste waste
        )
    ),
    6::numeric,
    'the retained quantity stays on the original deficit'
  );

select
  is (
    (
      select
        movement.occurred_at
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
      where
        deficit.item_id = 'f6e00000-0000-4000-8000-000000000012'
        and deficit.qty_uncovered > 0
    ),
    (
      select
        waste.occurred_at
      from
        f6_h1_waste waste
    ),
    'the retained deficit keeps the original waste date'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000012',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        6,
        'unit_cost',
        20
      )
    )
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements movement
      where
        movement.movement_type = 'closed_period'
        and movement.cover_deficit_movement_id = (
          select
            waste.id
          from
            f6_h1_waste waste
        )
    ),
    'a later purchase covers the retained deficit through a closed carrier'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.movement_type = 'cost_adjustment'
        and movement.adjusts_movement_id = (
          select
            waste.id
          from
            f6_h1_waste waste
        )
    ),
    0::bigint,
    'the retained deficit is not covered by an in-window adjustment'
  );

-- (N1) An ordinary waste cover refreshes recognized value, so a void returns it.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000013',
    'f6 waste cover',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000313',
    'f6e00000-0000-4000-8000-000000000013',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000333',
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
          'f6e00000-0000-4000-8000-000000000013',
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
    'f6e00000-0000-4000-8000-000000000334',
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
      'explanation',
      'noted',
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'f6e00000-0000-4000-8000-000000000333'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000013',
          'quantity',
          '5',
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
        contribution.amount
      from
        app.recognized_contribution contribution
      where
        contribution.source_kind = 'waste'
        and contribution.item_id = 'f6e00000-0000-4000-8000-000000000013'
    ),
    50.00,
    'an explanation-only correction seeds the ordinary waste at 50'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000013',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
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
        contribution.source_kind = 'waste'
        and contribution.item_id = 'f6e00000-0000-4000-8000-000000000013'
    ),
    100.00,
    'a later purchase adds the cover to the ordinary waste recognized value'
  );

create temp table f6_n1_void as
select
  app.apply_closed_waste_delta (
    (
      select
        document.id
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-000000000334'
    ),
    '[]'::jsonb,
    true,
    null
  ) as cause;

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join app.closed_period_sources source on source.movement_id = movement.id
        join f6_n1_void voided on voided.cause = movement.batch_id
      where
        source.source_kind = 'return'
    ),
    100.00,
    'a void of the covered ordinary waste returns 100'
  );

-- A forward sort cover refreshes a closed order's recognized value.
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
    'f6e00000-0000-4000-8000-000000000015',
    'f6 forward mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000014',
    'f6 forward size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000015'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000314',
    'f6e00000-0000-4000-8000-000000000014',
    10,
    null,
    null,
    'kg|fish_size|f6e00000-0000-4000-8000-000000000015|'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000315',
    'f6e00000-0000-4000-8000-000000000015',
    20,
    null,
    null,
    'kg|fish_mixed||'
  );

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000014',
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
    'f6-fwd',
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
    rpad(md5('f6-fwd'), 64, 'a'),
    false
  );

select
  app.append_pos_cost_input ('f6-fwd', null, 'sync');

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
  'f6-fwd',
  input.id,
  input.snapshot_id,
  'posting',
  'sale',
  (
    select
      anchor.at - interval '40 days'
    from
      f6_anchor anchor
  ),
  'f6-shift',
  md5('f6-fwd-app'),
  '[]'::jsonb,
  1
from
  app.pos_cost_inputs input
where
  input.order_id = 'f6-fwd';

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
  'f6-fwd',
  input.id,
  application.id,
  application.id,
  'sale',
  md5('f6-fwd-app')
from
  app.pos_cost_inputs input
  join app.order_cost_applications application on application.order_id = input.order_id
where
  input.order_id = 'f6-fwd';

insert into
  app.order_cost_movement_links (movement_id, application_id, order_id, item_id)
select
  deficit.movement_id,
  application.id,
  'f6-fwd',
  deficit.item_id
from
  app.provisional_deficits deficit
  join app.order_cost_applications application on application.order_id = 'f6-fwd'
where
  deficit.item_id = 'f6e00000-0000-4000-8000-000000000014';

select
  app.seed_order_recognized ('f6-fwd');

select
  is (
    (
      select
        contribution.amount
      from
        app.recognized_contribution contribution
      where
        contribution.source_kind = 'order'
        and contribution.source_id = 'f6-fwd'
    ),
    50.00,
    'the closed order is recognized at its provisional 50 before the sort'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000015',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
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
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000015',
    (
      select
        anchor.at + interval '1 hour'
      from
        f6_anchor anchor
    ),
    5,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000014',
        'quantity',
        5
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
        contribution.source_kind = 'order'
        and contribution.source_id = 'f6-fwd'
    ),
    100.00,
    'a forward sort cover refreshes the closed order recognized value'
  );

-- Fully covered deficits do not stay in the restore set.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000001b',
    'f6 covered deficits',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-00000000033b',
    'f6e00000-0000-4000-8000-00000000001b',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_engine_outflows (
    (
      select
        pg_catalog.jsonb_agg (
          pg_catalog.jsonb_build_object (
            'item_id',
            'f6e00000-0000-4000-8000-00000000001b',
            'movement_type',
            'sale',
            'occurred_at',
            (
              select
                anchor.at - interval '2 days'
              from
                f6_anchor anchor
            ) + (sale.n || ' minutes')::interval,
            'quantity',
            1
          )
        )
      from
        pg_catalog.generate_series (1, 8) as sale (n)
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000001b',
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
        8,
        'unit_cost',
        10
      )
    )
  );

select
  app.post_engine_outflows (
    (
      select
        pg_catalog.jsonb_agg (
          pg_catalog.jsonb_build_object (
            'item_id',
            'f6e00000-0000-4000-8000-00000000001b',
            'movement_type',
            'sale',
            'occurred_at',
            (
              select
                anchor.at - interval '1 day'
              from
                f6_anchor anchor
            ) + (sale.n || ' minutes')::interval,
            'quantity',
            1
          )
        )
      from
        pg_catalog.generate_series (1, 8) as sale (n)
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000001b',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day' + interval '1 hour'
          from
            f6_anchor anchor
        ),
        'quantity',
        8,
        'unit_cost',
        10
      )
    )
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-00000000001b'
        and movement.movement_type = 'sale'
    ),
    16::bigint,
    'the covered-deficit fixture posted sixteen sales'
  );

select
  is (
    (
      select
        count(*)
      from
        app.replay_checkpoint_deficits deficit
        join app.replay_checkpoints
      checkpoint on checkpoint.id = deficit.checkpoint_id
      where
        checkpoint.item_id = 'f6e00000-0000-4000-8000-00000000001b'
        and deficit.qty_uncovered = 0
        and deficit.value_uncovered = 0
    ),
    0::bigint,
    'fully covered deficits do not grow the restore set'
  );

-- An increase keeps the original deficit and posts only the added quantity.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000001e',
    'f6 waste increase',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-00000000031e',
    'f6e00000-0000-4000-8000-00000000001e',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at - interval '40 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-00000000033e',
    jsonb_build_object(
      'occurred_at',
      (
        select
          anchor.at - interval '40 days'
        from
          f6_anchor anchor
      ),
      'reason_code',
      'staff_meal',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-00000000001e',
          'quantity',
          '10',
          'unit',
          'kg'
        )
      )
    )
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

create temp table f6_increase_waste as
select
  movement.id,
  movement.occurred_at
from
  app.stock_movements movement
  join app.waste_line_movements link on link.movement_id = movement.id
where
  movement.item_id = 'f6e00000-0000-4000-8000-00000000001e'
  and movement.movement_type = 'waste';

select
  app.apply_closed_waste_delta (
    (
      select
        document.id
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-00000000033e'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000001e',
        'base_quantity',
        12
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
      where movement.item_id = 'f6e00000-0000-4000-8000-00000000001e'
      group by source.reason_code
      order by source.reason_code$$,
    $$values ('spoilage', '-120.00'), ('staff_meal', '100.00')$$,
    'an increase moves the original value and posts only the added quantity on the new reason'
  );

select
  is (
    (
      select
        deficit.qty_uncovered
      from
        app.provisional_deficits deficit
      where
        deficit.movement_id = (
          select
            waste.id
          from
            f6_increase_waste waste
        )
    ),
    10::numeric,
    'an increase keeps the original deficit quantity'
  );

select
  is (
    (
      select
        count(*)
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
      where
        movement.item_id = 'f6e00000-0000-4000-8000-00000000001e'
        and deficit.qty_uncovered = 12
    ),
    0::bigint,
    'an increase does not replace the original deficit with the new total'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000001e',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        20
      )
    )
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.movement_type = 'closed_period'
        and movement.cover_deficit_movement_id = (
          select
            waste.id
          from
            f6_increase_waste waste
        )
    ),
    1::bigint,
    'a later purchase covers the original closed deficit'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.movement_type = 'cost_adjustment'
        and movement.adjusts_movement_id = (
          select
            waste.id
          from
            f6_increase_waste waste
        )
    ),
    0::bigint,
    'a later purchase does not adjust the retained deficit inside the window'
  );

-- A cover that exists before the first correction is part of the seed.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000001f',
    'f6 cover before seed',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-00000000031f',
    'f6e00000-0000-4000-8000-00000000001f',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-00000000033f',
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
          'f6e00000-0000-4000-8000-00000000001f',
          'quantity',
          '5',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000001f',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
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

create temp table f6_seed_void as
select
  app.apply_closed_waste_delta (
    (
      select
        document.id
      from
        app.waste_documents document
      where
        document.request_id = 'f6e00000-0000-4000-8000-00000000033f'
    ),
    '[]'::jsonb,
    true,
    null
  ) as cause;

select
  is (
    (
      select
        coalesce(sum(movement.total_cost), 0)
      from
        app.stock_movements movement
        join app.closed_period_sources source on source.movement_id = movement.id
        join f6_seed_void voided on voided.cause = movement.batch_id
      where
        source.source_kind = 'return'
    ),
    100.00,
    'the first closed void returns a cover that happened before the seed'
  );

-- The document root is the row with no predecessor, however long the chain.
create temp table f6_waste_chain (n integer primary key, id bigint not null);

do $$
declare
  v_prev bigint;
  v_id bigint;
  v_i integer;
begin
  for v_i in 0..17 loop
    insert into
      app.waste_documents (
        request_id,
        occurred_at,
        reason_code,
        event_position,
        batch_id,
        retire_batch_id,
        predecessor_id,
        actor
      )
    values
      (
        pg_catalog.gen_random_uuid (),
        pg_catalog.clock_timestamp (),
        'spoilage',
        990000 + v_i,
        pg_catalog.gen_random_uuid (),
        case
          when v_prev is null then null
          else pg_catalog.gen_random_uuid ()
        end,
        v_prev,
        'f6e00000-0000-4000-8000-0000000000a1'
      )
    returning
      id into v_id;

    insert into
      f6_waste_chain (n, id)
    values
      (v_i, v_id);

    v_prev := v_id;
  end loop;
end $$;

select
  is (
    app.waste_document_root (
      (
        select
          chain.id
        from
          f6_waste_chain chain
        where
          chain.n = 17
      )
    ),
    (
      select
        chain.id
      from
        f6_waste_chain chain
      where
        chain.n = 0
    ),
    'a correction chain longer than 16 steps resolves to the original document'
  );

-- An unrelated earlier purchase does not pull this item off its checkpoint.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000021',
    'f6 boundary kept',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000022',
    'f6 boundary other',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000321',
    'f6e00000-0000-4000-8000-000000000021',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000322',
    'f6e00000-0000-4000-8000-000000000022',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000021',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '3 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000021',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000021',
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
        1,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000022',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '10 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10
      )
    )
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000021']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000421',
    true
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000022']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000422',
    true
  );

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000021',
      'f6e00000-0000-4000-8000-000000000022'
    ]::uuid[],
    jsonb_build_array(
      jsonb_build_object(
        'line_key',
        1,
        'item_id',
        'f6e00000-0000-4000-8000-000000000021',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10,
        'total_cost',
        10,
        'batch_id',
        'f6e00000-0000-4000-8000-000000000423'
      ),
      jsonb_build_object(
        'line_key',
        2,
        'item_id',
        'f6e00000-0000-4000-8000-000000000022',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '20 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10,
        'total_cost',
        10,
        'batch_id',
        'f6e00000-0000-4000-8000-000000000424'
      )
    ),
    'f6e00000-0000-4000-8000-000000000425',
    false
  );

select
  ok (
    (
      select
        (detail ->> 'checkpoint_id') is not null
        and (detail ->> 'rows_loaded')::bigint = 0
      from
        pg_catalog.jsonb_array_elements (
          (
            select
              probe.resume_detail
            from
              app.replay_read_probe probe
            order by
              probe.id desc
            limit
              1
          )
        ) as detail
      where
        detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000021'
    ),
    'a checkpointed item keeps its cut beside an unrelated earlier purchase'
  );

select
  ok (
    (
      select
        (detail ->> 'checkpoint_id') is null
      from
        pg_catalog.jsonb_array_elements (
          (
            select
              probe.resume_detail
            from
              app.replay_read_probe probe
            order by
              probe.id desc
            limit
              1
          )
        ) as detail
      where
        detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000022'
    ),
    'the unrelated item drops the cut that is after its own pending purchase'
  );

select
  set_config('app.replay_probe', '', true);

-- A posted cover whose inflow is still inside the window is not posted again.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000001c',
    'f6 in-window cover',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-00000000031c',
    'f6e00000-0000-4000-8000-00000000001c',
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
        'f6e00000-0000-4000-8000-00000000001c',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        10
      )
    )
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at + interval '30 days')::text
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
        'f6e00000-0000-4000-8000-00000000001c',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at + interval '30 days'
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
      where
        adjustment.movement_type = 'cost_adjustment'
        and adjustment.adjusts_movement_id = (
          select
            movement.id
          from
            app.stock_movements movement
          where
            movement.item_id = 'f6e00000-0000-4000-8000-00000000001c'
            and movement.movement_type = 'sale'
        )
    ),
    -50.00,
    'the in-window cover is one adjustment of -50'
  );

create temp table f6_inflow_before as
select
  balance.on_hand_value,
  (
    select
      count(*)
    from
      app.stock_movements movement
    where
      movement.item_id = 'f6e00000-0000-4000-8000-00000000001c'
  ) as movement_count
from
  app.item_balances balance
where
  balance.item_id = 'f6e00000-0000-4000-8000-00000000001c';

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'in-window-cover'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-00000000001c'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-00000000001c']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000041c',
    true
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-00000000001c'
    ),
    (
      select
        before.movement_count
      from
        f6_inflow_before before
    ),
    'a full replay does not post the cover again when its inflow is still in the window'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-00000000001c'
    ),
    (
      select
        before.on_hand_value
      from
        f6_inflow_before before
    ),
    'a full replay leaves the in-window cover ledger equal to the snapshot'
  );

-- Opposing historical covers stay as their own posted facts.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000001d',
    'f6 opposing covers',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-00000000031d',
    'f6e00000-0000-4000-8000-00000000001d',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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
        'f6e00000-0000-4000-8000-00000000001d',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        10
      )
    )
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at + interval '1 day')::text
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
        'f6e00000-0000-4000-8000-00000000001d',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at + interval '1 day'
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
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at + interval '2 days')::text
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
        'f6e00000-0000-4000-8000-00000000001d',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at + interval '2 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        5,
        'unit_cost',
        5
      )
    )
  );

select
  results_eq (
    $$select adjustment.total_cost::text
      from app.stock_movements adjustment
      where adjustment.movement_type = 'cost_adjustment'
        and adjustment.adjusts_movement_id = (
          select movement.id
          from app.stock_movements movement
          where movement.item_id = 'f6e00000-0000-4000-8000-00000000001d'
            and movement.movement_type = 'sale'
        )
      order by adjustment.id$$,
    $$values ('-50.00'), ('25.00')$$,
    'the two historical covers are adjustments of -50 and +25'
  );

create temp table f6_opposing_before as
select
  count(*) as movement_count
from
  app.stock_movements movement
where
  movement.item_id = 'f6e00000-0000-4000-8000-00000000001d';

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'opposing-covers'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-00000000001d'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-00000000001d']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000041d',
    true
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-00000000001d'
        and movement.movement_type = 'closed_period'
        and movement.cover_inflow_movement_id is not null
    ),
    0::bigint,
    'a full replay does not add carriers for opposing covers that are already posted'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-00000000001d'
    ),
    (
      select
        before.movement_count
      from
        f6_opposing_before before
    ),
    'a full replay leaves the opposing historical covers unchanged'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

-- Settled prefix rows are replaced by primary key, not by an item scan.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000023',
    'f6 settled prefix',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000323',
    'f6e00000-0000-4000-8000-000000000023',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_engine_outflows (
    (
      select
        pg_catalog.jsonb_agg (
          pg_catalog.jsonb_build_object (
            'item_id',
            'f6e00000-0000-4000-8000-000000000023',
            'movement_type',
            'sale',
            'occurred_at',
            (
              select
                anchor.at - interval '2 days'
              from
                f6_anchor anchor
            ) + (sale.n || ' minutes')::interval,
            'quantity',
            1
          )
        )
      from
        pg_catalog.generate_series (1, 20) as sale (n)
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000023',
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
        19,
        'unit_cost',
        10
      )
    )
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000023']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000426',
    true
  );

create temp table f6_settled_before as
select
  count(*) as settled_count
from
  app.provisional_deficits deficit
  join app.stock_movements movement on movement.id = deficit.movement_id
where
  movement.item_id = 'f6e00000-0000-4000-8000-000000000023'
  and deficit.qty_uncovered = 0
  and deficit.value_uncovered = 0;

-- A one-page deficit table makes a seq scan cheaper than the primary key.
-- These settled rows belong to another item. The replace must not read them.
set
  local session_replication_role = replica;

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000024',
    'f6 deficit filler',
    'seafood',
    'kg',
    'daily'
  );

insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost
  )
select
  pg_catalog.gen_random_uuid (),
  'f6e00000-0000-4000-8000-000000000024',
  'purchase',
  pg_catalog.clock_timestamp (),
  1,
  1,
  1
from
  pg_catalog.generate_series (1, 20000);

insert into
  app.provisional_deficits (
    movement_id,
    item_id,
    qty_uncovered,
    provisional_unit_cost,
    value_uncovered
  )
select
  movement.id,
  movement.item_id,
  0,
  0,
  0
from
  app.stock_movements movement
where
  movement.item_id = 'f6e00000-0000-4000-8000-000000000024';

set
  local session_replication_role = origin;

analyze app.provisional_deficits;

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000023']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000428',
    true
  );

select
  is (
    (
      select
        count(*)
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000023'
        and deficit.qty_uncovered = 0
        and deficit.value_uncovered = 0
    ),
    (
      select
        before.settled_count
      from
        f6_settled_before before
    ),
    'a resumed write leaves the settled historical deficits in place'
  );

select
  ok (
    (
      select
        probe.replace_plan <> ''
        and probe.replace_plan not like '%Seq Scan on provisional_deficits%'
        and probe.replace_plan like '%provisional_deficits_pkey%'
      from
        app.replay_read_probe probe
      order by
        probe.id desc
      limit
        1
    ),
    'the settled-deficit replace looks up recomputed movement ids by primary key'
  );

-- Sweep findings. The clock is put back on the anchor before each group.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000025',
    'f7 forward purchase',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-000000000026',
    'f7 forward movement',
    'seafood',
    'kg',
    'daily'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at - interval '60 days')::text
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
        'f6e00000-0000-4000-8000-000000000025',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000026',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
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
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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
  app.record_purchase (
    jsonb_build_object(
      'purchased_at',
      (
        select
          to_char(
            (anchor.at - interval '50 days') at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
        from
          f6_anchor anchor
      ),
      'request_id',
      'f6e00000-0000-4000-8000-000000000501',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000025',
          'quantity',
          '10',
          'unit',
          'kg',
          'amount_paid',
          '200.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000026',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '50 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        20
      )
    )
  );

select
  results_eq (
    $$select item_id::text, movement_type::text, quantity::text, total_cost::text
      from app.stock_movements
      where item_id in (
        'f6e00000-0000-4000-8000-000000000025',
        'f6e00000-0000-4000-8000-000000000026'
      )
        and occurred_at < app.restatement_window_start()
      order by item_id$$,
    $$values
      ('f6e00000-0000-4000-8000-000000000025', 'opening', '10.000000', '100.00'),
      ('f6e00000-0000-4000-8000-000000000026', 'opening', '10.000000', '100.00')$$,
    'a pre-window purchase does not rewrite the frozen opening'
  );

select
  results_eq (
    $$select item_id::text, closed_bucket, quantity::text, total_cost::text
      from app.stock_movements
      where item_id in (
        'f6e00000-0000-4000-8000-000000000025',
        'f6e00000-0000-4000-8000-000000000026'
      )
        and movement_type = 'closed_period'
        and closed_economic_kind = 'purchase'
      order by item_id$$,
    $$values
      ('f6e00000-0000-4000-8000-000000000025', 'inventory', '10.000000', '200.00'),
      ('f6e00000-0000-4000-8000-000000000026', 'inventory', '10.000000', '200.00')$$,
    'a pre-window purchase posts at the change as a closed receipt'
  );

-- First-time waste dated before the window uses today's basis.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000027',
    'f7 first waste',
    'seafood',
    'kg',
    'daily'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at - interval '60 days')::text
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
        'f6e00000-0000-4000-8000-000000000027',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
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
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at - interval '45 days')::text
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
        'f6e00000-0000-4000-8000-000000000027',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '45 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        5
      )
    )
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000027',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        20
      )
    )
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000502',
    jsonb_build_object(
      'occurred_at',
      (
        select
          to_char(
            (anchor.at - interval '50 days') at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
        from
          f6_anchor anchor
      ),
      'reason_code',
      'spoilage',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000027',
          'quantity',
          '1',
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
        balance.on_hand_qty::text || ' ' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-000000000027'
    ),
    '14.000000 233.33',
    'first-time pre-window waste costs the current basis'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000027'
        and movement.movement_type = 'waste'
        and movement.occurred_at < app.restatement_window_start ()
    ),
    0::bigint,
    'first-time pre-window waste is not posted on its old day'
  );

-- Closed sort: one transition, value allocated, loss in waste.
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
    'f6e00000-0000-4000-8000-000000000028',
    'f7 sort mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000029',
    'f7 sort size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000028'
  ),
  (
    'f6e00000-0000-4000-8000-000000000030',
    'f7 loss mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000031',
    'f7 loss size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000030'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at - interval '60 days')::text
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
        'f6e00000-0000-4000-8000-000000000028',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000030',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
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
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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
        'f6e00000-0000-4000-8000-000000000028',
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
        1
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000030',
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
        1
      )
    )
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000028',
    (
      select
        anchor.at - interval '50 days'
      from
        f6_anchor anchor
    ),
    5,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000029',
        'quantity',
        5
      )
    )
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000030',
    (
      select
        anchor.at - interval '50 days'
      from
        f6_anchor anchor
    ),
    5,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000031',
        'quantity',
        4
      )
    )
  );

select
  results_eq (
    $$select item_id::text, on_hand_qty::text, on_hand_value::text
      from app.item_balances
      where item_id in (
        'f6e00000-0000-4000-8000-000000000028',
        'f6e00000-0000-4000-8000-000000000029'
      )
      order by item_id$$,
    $$values
      ('f6e00000-0000-4000-8000-000000000028', '4.000000', '40.00'),
      ('f6e00000-0000-4000-8000-000000000029', '5.000000', '50.00')$$,
    'a closed sort moves the input value onto the output'
  );

select
  is (
    (
      select
        movement.closed_bucket || ' ' || movement.total_cost::text
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000030'
        and movement.closed_economic_kind = 'sort_loss'
    ),
    'waste -10.00',
    'a closed sort loss is waste, not inventory'
  );

-- Order bucket change keeps the deficit's identity.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000032',
    'f7 fifo order',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000503',
    'f6e00000-0000-4000-8000-000000000032',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_closed_order_difference (
    'f7-fifo-a',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000032',
        'quantity',
        5
      )
    ),
    'cogs',
    'sale'
  );

select
  app.post_closed_order_difference (
    'f7-fifo-b',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000032',
        'quantity',
        5
      )
    ),
    'cogs',
    'sale'
  );

select
  app.post_closed_order_difference (
    'f7-fifo-a',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000032',
        'quantity',
        5
      )
    ),
    'waste',
    'waste'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000032',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
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
  results_eq (
    $$select contribution.source_id, contribution.amount::text
      from app.recognized_contribution contribution
      where contribution.source_id in ('f7-fifo-a', 'f7-fifo-b')
        and contribution.quantity > 0
      order by contribution.source_id$$,
    $$values ('f7-fifo-a', '100.00'), ('f7-fifo-b', '50.00')$$,
    'a reclassified order keeps its deficit and is covered first'
  );

-- Waste return connects an ordinary piece and a later closed addition.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000033',
    'f7 waste return',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000504',
    'f6e00000-0000-4000-8000-000000000033',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000505',
    jsonb_build_object(
      'occurred_at',
      (
        select
          to_char(
            anchor.at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
        from
          f6_anchor anchor
      ),
      'reason_code',
      'spoilage',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000033',
          'quantity',
          '5',
          'unit',
          'kg'
        )
      )
    )
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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
  app.post_closed_order_difference (
    'f7-other-b',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000033',
        'quantity',
        5
      )
    ),
    'cogs',
    'sale'
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000506',
    jsonb_build_object(
      'occurred_at',
      (
        select
          to_char(
            anchor.at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
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
          document.request_id = 'f6e00000-0000-4000-8000-000000000505'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000033',
          'quantity',
          '8',
          'unit',
          'kg'
        )
      )
    )
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000507',
    jsonb_build_object(
      'predecessor_id',
      (
        select
          document.id::text
        from
          app.waste_documents document
        where
          document.request_id = 'f6e00000-0000-4000-8000-000000000506'
      ),
      'lines',
      '[]'::jsonb
    )
  );

select
  is (
    (
      select
        coalesce(sum(deficit.qty_uncovered), 0)::text
      from
        app.provisional_deficits deficit
        join app.closed_period_sources src on src.movement_id = deficit.movement_id
      where
        src.source_id = 'f7-other-b'
    ),
    '5.000000',
    'voiding a waste document does not consume the unrelated order'
  );

select
  is (
    (
      select
        coalesce(sum(deficit.qty_uncovered), 0)::text
      from
        app.provisional_deficits deficit
      where
        deficit.movement_id in (
          select
            link.movement_id
          from
            app.waste_line_movements link
            join app.waste_documents document on document.id = link.document_id
          where
            document.request_id = 'f6e00000-0000-4000-8000-000000000505'
          union
          select
            src.movement_id
          from
            app.closed_period_sources src
          where
            src.source_kind = 'waste'
            and src.source_id = (
              select
                document.id::text
              from
                app.waste_documents document
              where
                document.request_id = 'f6e00000-0000-4000-8000-000000000505'
            )
        )
    ),
    '0.000000',
    'voiding a waste document clears its ordinary piece and its closed addition'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

-- A closed correction moved onto today can be voided.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000034',
    'f7 moved waste',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000508',
    'f6e00000-0000-4000-8000-000000000034',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.record_waste (
    'f6e00000-0000-4000-8000-000000000509',
    jsonb_build_object(
      'occurred_at',
      (
        select
          to_char(
            (anchor.at - interval '40 days') at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
        from
          f6_anchor anchor
      ),
      'reason_code',
      'spoilage',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000034',
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
    'f6e00000-0000-4000-8000-000000000510',
    jsonb_build_object(
      'occurred_at',
      (
        select
          to_char(
            anchor.at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
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
          document.request_id = 'f6e00000-0000-4000-8000-000000000509'
      ),
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000034',
          'quantity',
          '6',
          'unit',
          'kg'
        )
      )
    )
  );

select
  lives_ok (
    $$select app.record_waste(
      'f6e00000-0000-4000-8000-000000000511',
      jsonb_build_object(
        'predecessor_id',
        (
          select document.id::text
          from app.waste_documents document
          where document.request_id = 'f6e00000-0000-4000-8000-000000000510'
        ),
        'lines',
        '[]'::jsonb
      )
    )$$,
    'a closed waste document moved to today can be voided'
  );

-- Forward sort cover of an aged closed waste stays in waste.
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
    'f6e00000-0000-4000-8000-000000000035',
    'f7 cover mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000036',
    'f7 cover size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000035'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000512',
    'f6e00000-0000-4000-8000-000000000036',
    10,
    null,
    null,
    'kg|fish_size|f6e00000-0000-4000-8000-000000000035|'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config(
    'app.test_clock',
    (
      select
        (anchor.at - interval '40 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'f7-closed-waste',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000036',
        'quantity',
        5
      )
    ),
    'waste',
    'waste'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000035',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
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
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000035',
    (
      select
        anchor.at
      from
        f6_anchor anchor
    ),
    5,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000036',
        'quantity',
        5
      )
    )
  );

select
  is (
    (
      select
        movement.closed_bucket || ' ' || movement.total_cost::text
      from
        app.stock_movements movement
      where
        movement.item_id = 'f6e00000-0000-4000-8000-000000000036'
        and movement.cover_deficit_movement_id is not null
    ),
    'waste -50.00',
    'a forward sort covers aged closed waste in the waste bucket'
  );

-- Closed-span publication commits one slice, not every accumulated order.
insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'f6e00000-0000-4000-8000-000000000513',
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
  'f6e00000-0000-4000-8000-000000000514',
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
  change.request_id = 'f6e00000-0000-4000-8000-000000000513';

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
  'f7-slice-' || slice.n,
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
  rpad(md5('f7-slice-' || slice.n), 64, 'b'),
  false
from
  generate_series(1, 3) as slice (n);

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
select
  'f7-slice-' || slice.n,
  'l1',
  'f6-pos',
  'x',
  1,
  '[]'::jsonb,
  0
from
  generate_series(1, 3) as slice (n);

select
  app.append_pos_cost_input ('f7-slice-' || slice.n, null, 'sync')
from
  generate_series(1, 3) as slice (n);

update app.accounting_rederive_spans
set
  completed_at = pg_catalog.clock_timestamp ()
where
  completed_at is null
  and change_id <> (
    select
      change.id
    from
      app.costing_changes change
    where
      change.request_id = 'f6e00000-0000-4000-8000-000000000513'
  );

select
  set_config('app.span_slice_limit', '2', true);

select
  app.run_accounting_work (
    'f6e00000-0000-4000-8000-000000000515',
    1,
    null,
    null
  );

select
  is (
    (
      select
        count(*)
      from
        app.closed_span_orders accumulated
        join app.accounting_rederive_spans span on span.id = accumulated.span_id
        join app.costing_changes change on change.id = span.change_id
      where
        change.request_id = 'f6e00000-0000-4000-8000-000000000513'
    ),
    2::bigint,
    'one maintenance call publishes only its closed-order slice'
  );

select
  is (
    (
      select
        progress.status
      from
        app.accounting_attempt_progress progress
      where
        progress.attempt_id = 'f6e00000-0000-4000-8000-000000000515'
    ),
    'processed',
    'a maintenance call records the attempt in its own transaction'
  );

select
  is (
    app.recover_accounting_attempt ('f6e00000-0000-4000-8000-000000000515') ->> 'status',
    'committed',
    'an unbound maintenance attempt is recovered after the reply is lost'
  );

select
  is (
    app.recover_accounting_attempt ('f6e00000-0000-4000-8000-000000000516') ->> 'status',
    'absent',
    'an attempt that never committed is not recovered'
  );

select
  is (
    has_function_privilege(
      'anon',
      'app.recover_accounting_attempt(uuid)',
      'execute'
    ),
    false,
    'anon cannot recover an accounting attempt'
  );

select
  is (
    has_function_privilege(
      'authenticated',
      'app.recover_accounting_attempt(uuid)',
      'execute'
    ),
    true,
    'authenticated can recover an accounting attempt'
  );

-- Resumed quantity check reads the suffix, not the frozen history.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000037',
    'f7 resumed sum',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000517',
    'f6e00000-0000-4000-8000-000000000037',
    10,
    null,
    null,
    'kg|seafood||'
  );

set
  local session_replication_role = replica;

insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost,
    is_provisional,
    source_type,
    source_id
  )
select
  'f6e00000-0000-4000-8000-000000000518',
  'f6e00000-0000-4000-8000-000000000037',
  'purchase',
  (
    select
      anchor.at - interval '40 days'
    from
      f6_anchor anchor
  ),
  1,
  10,
  10,
  false,
  'purchase',
  'f7-prefix-' || g
from
  generate_series(1, 4000) as g;

set
  local session_replication_role = origin;

analyze app.stock_movements;

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000037']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000518',
    true
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000037',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        1,
        'unit_cost',
        10
      )
    )
  );

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000037']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000519',
    true
  );

select
  ok (
    (
      select
        probe.balance_plan <> ''
        and probe.balance_plan not like '%Seq Scan on stock_movements%'
        and probe.balance_plan like '%Index Scan%'
        and probe.balance_buffers > 0
        and probe.balance_buffers < 80
      from
        app.replay_read_probe probe
      order by
        probe.id desc
      limit
        1
    ),
    'a resumed write checks quantity from the checkpoint prefix plus the suffix'
  );

select
  is (
    (
      select
        probe.component_plan
      from
        app.replay_read_probe probe
      order by
        probe.id desc
      limit
        1
    ),
    'skipped',
    'empty pending does not construct a sort component from history'
  );

select
  ok (
    (
      select
        probe.replace_plan like '%stock_movements%'
        and probe.replace_plan like '%Index%'
        and probe.replace_plan not like '%Seq Scan on stock_movements%'
        and probe.replace_plan like '%provisional_deficits_pkey%'
        and probe.replace_plan like '%Buffers:%'
      from
        app.replay_read_probe probe
      order by
        probe.id desc
      limit
        1
    ),
    'replace-id collection uses the suffix indexes and is measured with the delete'
  );

select
  is (
    app.replay_sort_members (
      'f6e00000-0000-4000-8000-000000000037',
      '[]'::jsonb
    ),
    array['f6e00000-0000-4000-8000-000000000037']::uuid[],
    'empty pending returns only the item'
  );

select
  set_config('app.replay_probe', '', true);

-- Posted sort edges join pending items through the sort-edge index.
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
    'f6e00000-0000-4000-8000-000000000039',
    'f7 pending mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-00000000003a',
    'f7 pending size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000039'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000039',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at
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
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000039',
    (
      select
        anchor.at
      from
        f6_anchor anchor
    ),
    4,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000003a',
        'quantity',
        4
      )
    )
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.unnest (
          app.replay_sort_members (
            'f6e00000-0000-4000-8000-000000000039',
            jsonb_build_array(
              jsonb_build_object(
                'item_id',
                'f6e00000-0000-4000-8000-000000000039',
                'occurred_at',
                (
                  select
                    anchor.at
                  from
                    f6_anchor anchor
                ),
                'movement_type',
                'purchase'
              ),
              jsonb_build_object(
                'item_id',
                'f6e00000-0000-4000-8000-00000000003a',
                'occurred_at',
                (
                  select
                    anchor.at - interval '1 hour'
                  from
                    f6_anchor anchor
                ),
                'movement_type',
                'purchase'
              )
            )
          )
        ) as member (item_id)
    ),
    2::bigint,
    'posted sort edges join the pending items of one component'
  );

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000039',
      'f6e00000-0000-4000-8000-00000000003a'
    ]::uuid[],
    jsonb_build_array(
      jsonb_build_object(
        'line_key',
        1,
        'item_id',
        'f6e00000-0000-4000-8000-000000000039',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'movement_type',
        'purchase',
        'quantity',
        1,
        'unit_cost',
        10,
        'total_cost',
        10,
        'batch_id',
        'f6e00000-0000-4000-8000-000000000541'
      ),
      jsonb_build_object(
        'line_key',
        2,
        'item_id',
        'f6e00000-0000-4000-8000-00000000003a',
        'occurred_at',
        (
          select
            anchor.at - interval '1 hour'
          from
            f6_anchor anchor
        ),
        'movement_type',
        'purchase',
        'quantity',
        1,
        'unit_cost',
        10,
        'total_cost',
        10,
        'batch_id',
        'f6e00000-0000-4000-8000-000000000541'
      )
    ),
    'f6e00000-0000-4000-8000-000000000541',
    false
  );

select
  ok (
    (
      select
        probe.component_plan <> 'skipped'
        and probe.component_plan like '%stock_movements%'
        and probe.component_plan like '%Buffers:%'
      from
        app.replay_read_probe probe
      order by
        probe.id desc
      limit
        1
    ),
    'the sort probe explains the production helper statement with buffers'
  );

select
  set_config('app.replay_probe', '', true);

select
  is (
    (
      select
        count(*)
      from
        app.replay_bounded_sort_edges (
          'f6e00000-0000-4000-8000-000000000039',
          (
            select
              anchor.at + interval '1 hour'
            from
              f6_anchor anchor
          ),
          0,
          null,
          null,
          array['f6e00000-0000-4000-8000-00000000003a']::uuid[]
        )
    ),
    0::bigint,
    'a cut after the posted sort reads no frozen sort sibling'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.replay_bounded_sort_edges (
          'f6e00000-0000-4000-8000-000000000039',
          (
            select
              anchor.at - interval '1 hour'
            from
              f6_anchor anchor
          ),
          0,
          null,
          null,
          array['f6e00000-0000-4000-8000-00000000003a']::uuid[]
        )
    ) >= 1,
    'a cut before the posted sort still reads that sort sibling'
  );

select
  set_config('enable_seqscan', 'off', true);

create function pg_temp.explain_sort_edge () returns text language plpgsql as $$
declare
  v_plan text := '';
  v_line text;
  v_sql text;
  v_after timestamptz;
begin
  select
    anchor.at - interval '1 hour'
  into v_after
  from
    f6_anchor anchor;

  v_sql := app.replay_sort_edge_sql (
    'f6e00000-0000-4000-8000-000000000039',
    v_after,
    0,
    null,
    null,
    array['f6e00000-0000-4000-8000-00000000003a']::uuid[]
  );

  for v_line in execute 'explain (analyze, buffers) ' || v_sql
  loop
    v_plan := v_plan || v_line || e'\n';
  end loop;

  return v_plan;
end;
$$;

select
  ok (
    (
      select
        plan.plan like '%Index%'
        and (
          plan.plan like '%stock_movements_sort_edge%'
          or plan.plan like '%stock_movements_sort_time%'
          or plan.plan like '%stock_movements_item_occurred%'
        )
        and plan.plan not like '%Seq Scan on stock_movements%'
      from
        (
          select
            pg_temp.explain_sort_edge () as plan
        ) plan
    ),
    'posted sort-edge expansion uses the sort-edge index'
  );

select
  set_config('enable_seqscan', 'on', true);

-- The opening floor is the first movement. A later purchase before the window
-- is closed; this opening stays on its own day.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000038',
    'f7 opening floor',
    'seafood',
    'kg',
    'daily'
  );

select
  app.record_opening_stock (
    (
      select
        anchor.at - interval '60 days'
      from
        f6_anchor anchor
    ),
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-000000000038',
        'quantity',
        '10',
        'unit',
        'kg',
        'unit_cost',
        '10',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'f6e00000-0000-4000-8000-000000000520'
  );

select
  results_eq (
    $$select sm.movement_type::text, sm.quantity::text, sm.total_cost::text,
            (sm.occurred_at = (
              select anchor.at - interval '60 days' from f6_anchor anchor
            ))::text
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000038'$$,
    $$values ('opening', '10.000000', '100.00', 'true')$$,
    'an opening before the window stays the opening floor'
  );

-- ITEM 12. A new owner count whose counted_at is before window_start.
-- Observation stays coverage-only. Signed variance posts at t_change.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000003b',
    'f12 closed count',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-00000000003c',
    'f12 zero count',
    'seafood',
    'kg',
    'daily'
  );

select
  app.record_opening_stock (
    (
      select
        anchor.at - interval '60 days'
      from
        f6_anchor anchor
    ),
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000003b',
        'quantity',
        '10',
        'unit',
        'kg',
        'unit_cost',
        '10',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      ),
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000003c',
        'quantity',
        '10',
        'unit',
        'kg',
        'unit_cost',
        '10',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'f6e00000-0000-4000-8000-000000000530'
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-00000000003b',
      'f6e00000-0000-4000-8000-00000000003c'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000052a',
    true
  );

select
  app.post_movements (
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000003b',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '30 minutes'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        20
      )
    )
  );

-- f6-shift opened 80 days ago and is still open. Close it so a historical
-- observation can pass the shift guards. f6-hist already occupies the
-- 40-day mark, so the observation sits after that close.
update app.pos_shifts
set
  closed_at = opened_at + interval '1 hour',
  is_active = false
where
  id = 'f6-shift'
  and closed_at is null;

create temp table f12_count_at as
select
  anchor.at - interval '40 days' + interval '12 hours' as at
from
  f6_anchor anchor;

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-00000000003b'
    ),
    '20.000000/300.00',
    'the later purchase leaves today''s stock 20/300 before the old count'
  );

create function pg_temp.cover_prepared_count (p_count jsonb) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
declare
  v_result jsonb;
  v_prepared timestamptz;
  v_counted timestamptz;
  v_close timestamptz;
  v_start timestamptz;
begin
  v_result := app.record_count (p_count);

  if v_result ->> 'status' = 'posted' then
    return v_result;
  end if;

  select
    request.prepared_at,
    (request.payload ->> 'counted_at')::timestamptz
  into
    v_prepared,
    v_counted
  from
    app.stock_count_requests request
  where
    request.request_id = (p_count ->> 'request_id')::uuid;

  select
    pg_catalog.max(shift.close_recorded_at)
  into v_close
  from
    app.pos_shifts shift
  where
    shift.opened_at <= v_counted;

  v_start := greatest(v_prepared, coalesce(v_close, v_prepared)) + interval '1 millisecond';

  insert into
    app.pos_sync_runs (mode, status, started_at, finished_at, error)
  values
    (
      'recent',
      'ok',
      v_start,
      v_start + interval '1 minute',
      null
    );

  return app.record_count (p_count);
end;
$$;

select
  is (
    pg_temp.cover_prepared_count (
      pg_catalog.jsonb_build_object (
        'request_id',
        'f6e00000-0000-4000-8000-000000000531',
        'frequency',
        'daily',
        'counted_at',
        (
          select
            count_at.at::text
          from
            f12_count_at count_at
        ),
        'lines',
        pg_catalog.jsonb_build_array (
          pg_catalog.jsonb_build_object (
            'item_id',
            'f6e00000-0000-4000-8000-00000000003b',
            'counted_qty',
            '8',
            'expected_base_unit',
            'kg'
          )
        )
      )
    ) ->> 'status',
    'posted',
    'a pre-window count with later movements posts a closed count cause'
  );

select
  results_eq (
    $$select sm.movement_type::text, sm.quantity::text, sm.total_cost::text,
            sm.closed_bucket, src.source_kind,
            (sm.occurred_at = (
              select current_setting('app.t_change')::timestamptz
            ))::text
      from app.stock_movements sm
      join app.closed_period_sources src on src.movement_id = sm.id
      where sm.item_id = 'f6e00000-0000-4000-8000-00000000003b'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'$$,
    $$values (
      'closed_period',
      '-2.000000',
      '-30.00',
      'count',
      'count',
      'true'
    )$$,
    'the old count posts one -2/-30 count cause at t_change'
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-00000000003b'
    ),
    '18.000000/270.00',
    'closing stock is 18/270 after the closed count'
  );

select
  is (
    (
      select
        coalesce(- sum(sm.total_cost), 0)::text
      from
        app.stock_movements sm
        join app.movement_attributions attribution on attribution.movement_id = sm.id
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000003b'
        and sm.closed_bucket = 'count'
        and attribution.shift_id = 'f6-now'
    ),
    '30.00',
    'count variance is +30 in today''s shift'
  );

select
  results_eq (
    $$select counted.counted_at = (
        select count_at.at from f12_count_at count_at
      ),
      line.counted_qty, line.expected_qty, line.delta_qty, line.delta_value,
      line.movement_id is null, anchor.actual_qty, anchor.economic,
      (
        select count(*) from app.stock_count_postings posting
        where posting.count_id = counted.id
      )
      from app.stock_counts counted
      join app.stock_count_lines line on line.count_id = counted.id
      join app.stock_count_anchors anchor on anchor.count_id = counted.id
        and anchor.line_no = line.line_no
      where counted.request_id = 'f6e00000-0000-4000-8000-000000000531'$$,
    $$values (
      true,
      8::numeric(20, 6),
      10::numeric(20, 6),
      -2::numeric(20, 6),
      -30.00::numeric(14, 2),
      true,
      8::numeric(20, 6),
      false,
      0::bigint
    )$$,
    'the observation remains coverage at the counted instant and is not an economic anchor'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000003b'
        and sm.occurred_at = (
          select
            count_at.at
          from
            f12_count_at count_at
        )
    ),
    0::bigint,
    'no historical stock reset at the observation instant'
  );

select
  is (
    pg_temp.cover_prepared_count (
      pg_catalog.jsonb_build_object (
        'request_id',
        'f6e00000-0000-4000-8000-000000000531',
        'frequency',
        'daily',
        'counted_at',
        (
          select
            count_at.at::text
          from
            f12_count_at count_at
        ),
        'lines',
        pg_catalog.jsonb_build_array (
          pg_catalog.jsonb_build_object (
            'item_id',
            'f6e00000-0000-4000-8000-00000000003b',
            'counted_qty',
            '8',
            'expected_base_unit',
            'kg'
          )
        )
      )
    ) ->> 'status',
    'posted',
    'retry of the same pre-window count returns posted'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000003b'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'
    ),
    1::bigint,
    'retry of the same pre-window count does not post a second cause'
  );

-- A tip cut after the closed count keeps the cause in the prefix. Seed the
-- opening-day cut, drop the tip, and require the resume to walk the cause.
create temp table f12_pre_cause as
select
  checkpoint.id,
  checkpoint.cut_occurred_at,
  checkpoint.max_movement_id
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-00000000003b'
  and checkpoint.cut_occurred_at < (
    select
      sm.occurred_at
    from
      app.stock_movements sm
    where
      sm.item_id = 'f6e00000-0000-4000-8000-00000000003b'
      and sm.movement_type = 'closed_period'
      and sm.closed_bucket = 'count'
    order by
      sm.id
    limit
      1
  )
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  )
order by
  checkpoint.cut_occurred_at desc,
  checkpoint.id desc
limit
  1;

select
  ok (
    exists (
      select
        1
      from
        f12_pre_cause
    ),
    'a cut before the closed count cause exists'
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'item12-tip'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-00000000003b'
  and checkpoint.id not in (
    select
      pre_cause.id
    from
      f12_pre_cause pre_cause
  )
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-00000000003b']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000532',
    true
  );

select
  set_config('app.replay_probe', '', true);

select
  is (
    (
      select
        (detail ->> 'checkpoint_id')::bigint
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-00000000003b'
    ),
    (
      select
        pre_cause.id
      from
        f12_pre_cause pre_cause
    ),
    'resumed count selects the cut before the closed count cause'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements sm
        join f12_pre_cause pre_cause on true
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000003b'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'
        and (
          sm.occurred_at > pre_cause.cut_occurred_at
          or sm.id > pre_cause.max_movement_id
        )
    ),
    'the closed count movement is in the suffix of the pre-cause cut'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000003b'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'
    ),
    1::bigint,
    'resumed replay applies the closed count cause once'
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-00000000003b'
    ),
    '18.000000/270.00',
    'resumed replay leaves closing stock 18/270'
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'item12-full'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-00000000003b'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-00000000003b']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000533',
    true
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000003b'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'
    ),
    1::bigint,
    'full replay applies the closed count cause once'
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-00000000003b'
    ),
    '18.000000/270.00',
    'full replay leaves closing stock 18/270'
  );

select
  is (
    pg_temp.cover_prepared_count (
      pg_catalog.jsonb_build_object (
        'request_id',
        'f6e00000-0000-4000-8000-000000000534',
        'frequency',
        'daily',
        'counted_at',
        (
          select
            count_at.at::text
          from
            f12_count_at count_at
        ),
        'lines',
        pg_catalog.jsonb_build_array (
          pg_catalog.jsonb_build_object (
            'item_id',
            'f6e00000-0000-4000-8000-00000000003c',
            'counted_qty',
            '10',
            'expected_base_unit',
            'kg'
          )
        )
      )
    ) ->> 'status',
    'posted',
    'a pre-window zero-variance count posts'
  );

select
  results_eq (
    $$select line.counted_qty, line.expected_qty, line.delta_qty, line.delta_value,
            line.movement_id is null, anchor.economic,
            (
              select count(*) from app.stock_movements sm
              where sm.item_id = 'f6e00000-0000-4000-8000-00000000003c'
                and sm.movement_type = 'closed_period'
            )
      from app.stock_counts counted
      join app.stock_count_lines line on line.count_id = counted.id
      join app.stock_count_anchors anchor on anchor.count_id = counted.id
        and anchor.line_no = line.line_no
      where counted.request_id = 'f6e00000-0000-4000-8000-000000000534'$$,
    $$values (
      10::numeric(20, 6),
      10::numeric(20, 6),
      0::numeric(20, 6),
      0.00::numeric(14, 2),
      true,
      false,
      0::bigint
    )$$,
    'a pre-window zero-variance count is coverage only'
  );

-- In-window nonzero lines still need a count_adjustment. The relaxed
-- movement check allows a null movement_id so the closed pre-window path
-- can post its variance as a closed_period row. The insert trigger restores
-- the in-window invariant.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000003d',
    'f12 in-window line',
    'seafood',
    'kg',
    'daily'
  );

insert into
  app.stock_counts (id, request_id, frequency, counted_at)
values
  (
    'f6e00000-0000-4000-8000-000000000540',
    'f6e00000-0000-4000-8000-000000000535',
    'daily',
    (
      select
        anchor.at
      from
        f6_anchor anchor
    )
  );

select
  throws_ok (
    $$insert into app.stock_count_lines (
        count_id,
        line_no,
        item_id,
        expected_base_unit,
        counted_qty,
        expected_qty,
        delta_qty,
        delta_value,
        movement_id
      )
      values (
        'f6e00000-0000-4000-8000-000000000540',
        1,
        'f6e00000-0000-4000-8000-00000000003d',
        'kg',
        12,
        10,
        2,
        0,
        null
      )$$,
    '23514',
    'count line delta requires a movement',
    'an in-window count line with a nonzero delta and no movement raises 23514'
  );

-- Closed count surplus. Item 12 covers a shortage and a zero variance.
-- A pre-window observation above economic on-hand must post one positive
-- closed_period count cause at t_change.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000049',
    'f12 surplus count',
    'seafood',
    'kg',
    'daily'
  );

select
  app.record_opening_stock (
    (
      select
        anchor.at - interval '60 days'
      from
        f6_anchor anchor
    ),
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-000000000049',
        'quantity',
        '10',
        'unit',
        'kg',
        'unit_cost',
        '10',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'f6e00000-0000-4000-8000-000000000560'
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000049']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000561',
    true
  );

select
  app.post_movements (
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-000000000049',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '30 minutes'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        20
      )
    )
  );

create temp table f12_surplus_at as
select
  anchor.at - interval '50 days' + interval '12 hours' as at
from
  f6_anchor anchor;

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-000000000049'
    ),
    '20.000000/300.00',
    'the later purchase leaves today''s stock 20/300 before the surplus count'
  );

select
  lives_ok (
    $lives$
    select
      pg_temp.cover_prepared_count (
        pg_catalog.jsonb_build_object (
          'request_id',
          'f6e00000-0000-4000-8000-000000000562',
          'frequency',
          'daily',
          'counted_at',
          (
            select
              count_at.at::text
            from
              f12_surplus_at count_at
          ),
          'lines',
          pg_catalog.jsonb_build_array (
            pg_catalog.jsonb_build_object (
              'item_id',
              'f6e00000-0000-4000-8000-000000000049',
              'counted_qty',
              '12',
              'expected_base_unit',
              'kg'
            )
          )
        )
      )
    $lives$,
    'a pre-window surplus count posts a closed count cause'
  );

select
  results_eq (
    $$select sm.movement_type::text, sm.quantity::text, sm.total_cost::text,
            sm.closed_bucket, src.source_kind,
            (sm.occurred_at = (
              select current_setting('app.t_change')::timestamptz
            ))::text
      from app.stock_movements sm
      join app.closed_period_sources src on src.movement_id = sm.id
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000049'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'$$,
    $$values (
      'closed_period',
      '2.000000',
      '30.00',
      'count',
      'count',
      'true'
    )$$,
    'the old surplus count posts one +2/+30 count cause at t_change'
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-000000000049'
    ),
    '22.000000/330.00',
    'closing stock is 22/330 after the closed surplus count'
  );

select
  is (
    (
      select
        coalesce(sum(sm.total_cost), 0)::text
      from
        app.stock_movements sm
        join app.movement_attributions attribution on attribution.movement_id = sm.id
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000049'
        and sm.closed_bucket = 'count'
        and attribution.shift_id = 'f6-now'
    ),
    '30.00',
    'surplus count variance is +30 in today''s shift'
  );

select
  lives_ok (
    $lives$
    select
      pg_temp.cover_prepared_count (
        pg_catalog.jsonb_build_object (
          'request_id',
          'f6e00000-0000-4000-8000-000000000562',
          'frequency',
          'daily',
          'counted_at',
          (
            select
              count_at.at::text
            from
              f12_surplus_at count_at
          ),
          'lines',
          pg_catalog.jsonb_build_array (
            pg_catalog.jsonb_build_object (
              'item_id',
              'f6e00000-0000-4000-8000-000000000049',
              'counted_qty',
              '12',
              'expected_base_unit',
              'kg'
            )
          )
        )
      )
    $lives$,
    'retry of the same pre-window surplus count returns posted'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000049'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'
    ),
    1::bigint,
    'retry of the same pre-window surplus count does not post a second cause'
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'surplus-full'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000049'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000049']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000564',
    true
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000049'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'
    ),
    1::bigint,
    'full replay applies the closed surplus count cause once'
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-000000000049'
    ),
    '22.000000/330.00',
    'full replay leaves closing stock 22/330 after the surplus count'
  );

-- A. Posted sort reached through a later cut must join the walk of a
-- earlier pending purchase on the input.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  set_config('app.replay_probe', '', true);

create temp table f7a_days as
select
  anchor.at - interval '20 days' as day0,
  anchor.at - interval '17 days' as day3,
  anchor.at - interval '15 days' as day5
from
  f6_anchor anchor;

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
    'f6e00000-0000-4000-8000-000000000040',
    'f7a mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000041',
    'f7a size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000040'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000040',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            days.day0
          from
            f7a_days days
        ),
        'quantity',
        10,
        'unit_cost',
        10
      )
    )
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000040']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000550',
    true
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000040',
    (
      select
        days.day5
      from
        f7a_days days
    ),
    4,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000041',
        'quantity',
        4
      )
    )
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000040',
      'f6e00000-0000-4000-8000-000000000041'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000551',
    true
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
        checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000040'
        and checkpoint.cut_occurred_at = (
          select
            days.day0
          from
            f7a_days days
        )
        and not exists (
          select
            1
          from
            app.replay_checkpoint_invalidations invalidation
          where
            invalidation.checkpoint_id = checkpoint.id
        )
    )
    and exists (
      select
        1
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000040'
        and checkpoint.cut_occurred_at = (
          select
            days.day5
          from
            f7a_days days
        )
        and not exists (
          select
            1
          from
            app.replay_checkpoint_invalidations invalidation
          where
            invalidation.checkpoint_id = checkpoint.id
        )
    )
    and exists (
      select
        1
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000041'
        and checkpoint.cut_occurred_at = (
          select
            days.day5
          from
            f7a_days days
        )
        and not exists (
          select
            1
          from
            app.replay_checkpoint_invalidations invalidation
          where
            invalidation.checkpoint_id = checkpoint.id
        )
    ),
    'input keeps a day-0 cut and both items have a valid day-5 cut'
  );

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000040',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            days.day3
          from
            f7a_days days
        ),
        'quantity',
        10,
        'unit_cost',
        20
      )
    )
  );

select
  set_config('app.replay_probe', '', true);

create temp table f7a_resume as
select
  balance.item_id,
  balance.on_hand_qty,
  balance.on_hand_value
from
  app.item_balances balance
where
  balance.item_id in (
    'f6e00000-0000-4000-8000-000000000040',
    'f6e00000-0000-4000-8000-000000000041'
  );

select
  ok (
    (
      select
        coalesce(
          (detail ->> 'cut_occurred_at')::timestamptz,
          '-infinity'::timestamptz
        ) <= (
          select
            days.day0
          from
            f7a_days days
        )
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000041'
    ),
    'the output cut is demoted to day 0 or earlier'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements sm
        join app.replay_read_probe probe on probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        join lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail on detail ->> 'item_id' = sm.item_id::text
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000040'
        and sm.movement_type = 'sort_out'
        and (
          (detail ->> 'checkpoint_id') is null
          or sm.occurred_at > (detail ->> 'cut_occurred_at')::timestamptz
          or sm.id > (detail ->> 'max_movement_id')::bigint
        )
    )
    and exists (
      select
        1
      from
        app.stock_movements sm
        join app.replay_read_probe probe on probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        join lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail on detail ->> 'item_id' = sm.item_id::text
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000041'
        and sm.movement_type = 'sort_in'
        and (
          (detail ->> 'checkpoint_id') is null
          or sm.occurred_at > (detail ->> 'cut_occurred_at')::timestamptz
          or sm.id > (detail ->> 'max_movement_id')::bigint
        )
    ),
    'the walk includes both legs of the day-5 sort'
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'f7a-full'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id in (
    'f6e00000-0000-4000-8000-000000000040',
    'f6e00000-0000-4000-8000-000000000041'
  )
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000040',
      'f6e00000-0000-4000-8000-000000000041'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000552',
    true
  );

select
  results_eq (
    $$select item_id::text, on_hand_qty::text, on_hand_value::text
      from app.item_balances
      where item_id in (
        'f6e00000-0000-4000-8000-000000000040',
        'f6e00000-0000-4000-8000-000000000041'
      )
      order by item_id$$,
    $$select item_id::text, on_hand_qty::text, on_hand_value::text
      from f7a_resume
      order by item_id$$,
    'the resumed sort walk equals a forced full walk'
  );

-- B. A closed sort cannot take more than the mixed item holds at t_change.
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
    'f6e00000-0000-4000-8000-000000000042',
    'f7b mixed short',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000043',
    'f7b size short',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000042'
  ),
  (
    'f6e00000-0000-4000-8000-000000000044',
    'f7b mixed ok',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000045',
    'f7b size ok',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000044'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000042',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        2,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000044',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        2,
        'unit_cost',
        10
      )
    )
  );

create temp table f7b_before as
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
      app.provisional_deficits
  ) as deficits,
  (
    select
      count(*)
    from
      app.stock_movements
    where
      movement_type in (
        'sort_out'::app.movement_type,
        'sort_in'::app.movement_type,
        'sort_loss'::app.movement_type,
        'closed_period'::app.movement_type
      )
      and item_id in (
        'f6e00000-0000-4000-8000-000000000042',
        'f6e00000-0000-4000-8000-000000000043'
      )
  ) as sort_rows;

select
  throws_ok (
    $$select app.post_sort(
      'f6e00000-0000-4000-8000-000000000042',
      (select at - interval '50 days' from f6_anchor),
      5,
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000043',
          'quantity',
          5
        )
      )
    )$$,
    '22023',
    'not enough stock to sort: on_hand_qty 2.000000, requested 5.000000',
    'a closed sort of more than on-hand raises 22023'
  );

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
        before.movements
      from
        f7b_before before
    ),
    'a closed shortage sort writes no movement'
  );

select
  is (
    (
      select
        count(*)
      from
        app.provisional_deficits
    ),
    (
      select
        before.deficits
      from
        f7b_before before
    ),
    'a closed shortage sort writes no deficit'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type in (
          'sort_out'::app.movement_type,
          'sort_in'::app.movement_type,
          'sort_loss'::app.movement_type,
          'closed_period'::app.movement_type
        )
        and item_id in (
          'f6e00000-0000-4000-8000-000000000042',
          'f6e00000-0000-4000-8000-000000000043'
        )
    ),
    (
      select
        before.sort_rows
      from
        f7b_before before
    ),
    'a closed shortage sort writes no sort batch'
  );

select
  lives_ok (
    $$select app.post_sort(
      'f6e00000-0000-4000-8000-000000000044',
      (select at - interval '50 days' from f6_anchor),
      2,
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000045',
          'quantity',
          2
        )
      )
    )$$,
    'a closed sort within on-hand still posts'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000044'
        and sm.movement_type in (
          'sort_out'::app.movement_type,
          'closed_period'::app.movement_type
        )
        and sm.quantity < 0
    )
    and exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000045'
        and sm.movement_type in (
          'sort_in'::app.movement_type,
          'closed_period'::app.movement_type
        )
        and sm.quantity > 0
    ),
    'the in-stock closed sort writes both legs'
  );

-- C. A closed count before the opening floor is refused.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000046',
    'f7c before opening',
    'seafood',
    'kg',
    'daily'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000046',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '50 days'
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

create temp table f7c_before as
select
  (
    select
      count(*)
    from
      app.stock_movements
    where
      item_id = 'f6e00000-0000-4000-8000-000000000046'
  ) as movements,
  (
    select
      count(*)
    from
      app.stock_counts
  ) as counts,
  (
    select
      count(*)
    from
      app.stock_count_lines
    where
      item_id = 'f6e00000-0000-4000-8000-000000000046'
  ) as lines;

create temp table f7c_count_at as
select
  anchor.at - interval '60 days' as at
from
  f6_anchor anchor;

create function pg_temp.f7c_before_open_count () returns jsonb language plpgsql as $$
begin
  return pg_temp.cover_prepared_count (
    pg_catalog.jsonb_build_object (
      'request_id',
      'f6e00000-0000-4000-8000-000000000557',
      'frequency',
      'daily',
      'counted_at',
      (
        select
          count_at.at::text
        from
          f7c_count_at count_at
      ),
      'lines',
      pg_catalog.jsonb_build_array (
        pg_catalog.jsonb_build_object (
          'item_id',
          'f6e00000-0000-4000-8000-000000000046',
          'counted_qty',
          '2',
          'expected_base_unit',
          'kg'
        )
      )
    )
  );
end;
$$;

select
  throws_ok (
    'select pg_temp.f7c_before_open_count()',
    'P0001',
    'movement is before opening stock',
    'a closed count before opening is refused'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        item_id = 'f6e00000-0000-4000-8000-000000000046'
    ),
    (
      select
        before.movements
      from
        f7c_before before
    ),
    'a count before opening writes no movement'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_counts
    ),
    (
      select
        before.counts
      from
        f7c_before before
    ),
    'a count before opening writes no count'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_count_lines
      where
        item_id = 'f6e00000-0000-4000-8000-000000000046'
    ),
    (
      select
        before.lines
      from
        f7c_before before
    ),
    'a count before opening writes no count line'
  );

-- D. A cover dated before a reclass uses the bucket in force at the inflow.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000047',
    'f7d cover as-of',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000558',
    'f6e00000-0000-4000-8000-000000000047',
    10,
    null,
    null,
    'kg|seafood||'
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
  'f7d-aged',
  anchor.at - interval '40 days',
  anchor.at - interval '40 days' + interval '8 hours',
  false,
  anchor.at - interval '40 days'
from
  f6_anchor anchor;

insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time
  )
select
  'f7d-mid',
  anchor.at - interval '12 days',
  anchor.at - interval '9 days',
  false,
  anchor.at - interval '12 days'
from
  f6_anchor anchor;

select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (
          anchor.at - interval '40 days' + interval '1 hour'
        )::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'f7d-order',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000047',
        'quantity',
        5
      )
    ),
    'cogs',
    'sale'
  );

select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (anchor.at - interval '10 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'f7d-order',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000047',
        'quantity',
        5
      )
    ),
    'waste',
    'waste'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000047',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '11 days'
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
  results_eq (
    $$select sm.closed_bucket, sm.total_cost::text
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000047'
        and sm.movement_type = 'closed_period'
        and sm.cover_inflow_movement_id is not null
      order by sm.id$$,
    $$values ('cogs', '-50.00')$$,
    'the day -11 carrier uses the COGS bucket in force at the inflow'
  );

select
  results_eq (
    $$select (sm.occurred_at at time zone 'Africa/Cairo')::date,
             sm.closed_bucket,
             sum(sm.total_cost)::text
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000047'
        and sm.movement_type = 'closed_period'
      group by 1, 2
      order by 1, 2$$,
    $$select *
      from (
        values
          (
            ((select at - interval '40 days' + interval '1 hour' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '-50.00'
          ),
          (
            ((select at - interval '11 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '-50.00'
          ),
          (
            ((select at - interval '10 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '100.00'
          ),
          (
            ((select at - interval '10 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'waste',
            '-100.00'
          )
      ) as expected (day, bucket, total)
      order by 1, 2$$,
    'cover and reclass keep per-day bucket totals'
  );

-- E. A closed count deficit cover stays in the count bucket.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000048',
    'f7e count cover',
    'seafood',
    'kg',
    'daily'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000048',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        3,
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
        'f6e00000-0000-4000-8000-000000000048',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        2
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
        balance.item_id = 'f6e00000-0000-4000-8000-000000000048'
    ),
    '1.000000/10.00',
    'current stock is 1/10 before the closed count shortage'
  );

select
  is (
    pg_temp.cover_prepared_count (
      pg_catalog.jsonb_build_object (
        'request_id',
        'f6e00000-0000-4000-8000-000000000561',
        'frequency',
        'daily',
        'counted_at',
        (
          select
            (anchor.at - interval '50 days')::text
          from
            f6_anchor anchor
        ),
        'lines',
        pg_catalog.jsonb_build_array (
          pg_catalog.jsonb_build_object (
            'item_id',
            'f6e00000-0000-4000-8000-000000000048',
            'counted_qty',
            '0',
            'expected_base_unit',
            'kg'
          )
        )
      )
    ) ->> 'status',
    'posted',
    'the closed count shortage posts'
  );

select
  is (
    (
      select
        deficit.qty_uncovered::text || '/' || deficit.value_uncovered::text
      from
        app.provisional_deficits deficit
        join app.stock_movements sm on sm.id = deficit.movement_id
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000048'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'
        and deficit.qty_uncovered > 0
    ),
    '2.000000/20.00',
    'the closed count shortage opens a 2/20 count deficit'
  );

create temp table f7e_cogs_before as
select
  coalesce(
    sum(sm.total_cost) filter (
      where
        sm.closed_bucket = 'cogs'
    ),
    0
  ) as cogs
from
  app.stock_movements sm
where
  sm.item_id = 'f6e00000-0000-4000-8000-000000000048'
  and sm.movement_type = 'closed_period';

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
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000048',
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
        2,
        'unit_cost',
        20
      )
    )
  );

select
  results_eq (
    $$select sm.closed_bucket, sm.total_cost::text
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000048'
        and sm.movement_type = 'closed_period'
        and sm.cover_inflow_movement_id is not null
      order by sm.id$$,
    $$values ('count', '-20.00')$$,
    'the count-deficit carrier lands in the count bucket'
  );

select
  is (
    (
      select
        coalesce(
          sum(sm.total_cost) filter (
            where
              sm.closed_bucket = 'cogs'
          ),
          0
        )
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000048'
        and sm.movement_type = 'closed_period'
    ),
    (
      select
        before.cogs
      from
        f7e_cogs_before before
    ),
    'covering a count deficit leaves COGS unchanged'
  );

-- G. Replace-id collection: each reversal condition is its own union arm
-- so the default planner can drive the suffix ranges. The prior EXISTS
-- form is frozen here; the production set must stay identical.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

create function pg_temp.legacy_replace_movement_ids (p_item_ids uuid[]) returns bigint[] language sql stable security definer
set
  search_path = '' as $$
  select
    coalesce(
      pg_catalog.array_agg(distinct touched.movement_id),
      '{}'::bigint[]
    )
  from
    (
      select
        walked.movement_id
      from
        ledger_scratch.recompute_row walked
      where
        walked.item_id = any (p_item_ids)
        and not walked.is_pending
        and walked.movement_id is not null
      union
      select
        rebuilt.movement_id
      from
        ledger_scratch.recompute_def rebuilt
      where
        rebuilt.item_id = any (p_item_ids)
        and rebuilt.movement_id is not null
      union
      select
        sm.id
      from
        ledger_scratch.replay_resume resume
        join app.stock_movements sm on sm.item_id = resume.item_id
        and sm.occurred_at > resume.cut_occurred_at
      where
        resume.checkpoint_id is not null
        and resume.item_id = any (p_item_ids)
        and (
          sm.reverses_movement_id is not null
          or sm.movement_type in (
            'sale_reversal'::app.movement_type,
            'waste_reversal'::app.movement_type
          )
          or exists (
            select
              1
            from
              app.stock_movements rev
            where
              rev.reverses_movement_id = sm.id
          )
        )
      union
      select
        sm.id
      from
        ledger_scratch.replay_resume resume
        join app.stock_movements sm on sm.item_id = resume.item_id
        and sm.id > resume.max_movement_id
      where
        resume.checkpoint_id is not null
        and resume.item_id = any (p_item_ids)
        and (
          sm.reverses_movement_id is not null
          or sm.movement_type in (
            'sale_reversal'::app.movement_type,
            'waste_reversal'::app.movement_type
          )
          or exists (
            select
              1
            from
              app.stock_movements rev
            where
              rev.reverses_movement_id = sm.id
          )
        )
      union
      select
        sm.id
      from
        ledger_scratch.replay_resume resume
        join app.stock_movements sm on sm.item_id = resume.item_id
      where
        resume.checkpoint_id is null
        and resume.item_id = any (p_item_ids)
        and (
          sm.reverses_movement_id is not null
          or sm.movement_type in (
            'sale_reversal'::app.movement_type,
            'waste_reversal'::app.movement_type
          )
          or exists (
            select
              1
            from
              app.stock_movements rev
            where
              rev.reverses_movement_id = sm.id
          )
        )
    ) touched;
$$;

create function pg_temp.replace_ids_default_plan (p_item_ids uuid[]) returns text language plpgsql security definer
set
  search_path = '' as $$
declare
  v_plan text := '';
  v_line text;
begin
  for v_line in execute pg_catalog.format(
    $explain$
    explain (analyze, buffers)
    select
      coalesce(
        pg_catalog.array_agg(distinct touched.movement_id),
        '{}'::bigint[]
      )
    from
      (
        select
          walked.movement_id
        from
          ledger_scratch.recompute_row walked
        where
          walked.item_id = any (%1$L::uuid[])
          and not walked.is_pending
          and walked.movement_id is not null
        union
        select
          rebuilt.movement_id
        from
          ledger_scratch.recompute_def rebuilt
        where
          rebuilt.item_id = any (%1$L::uuid[])
          and rebuilt.movement_id is not null
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
          and sm.occurred_at > resume.cut_occurred_at
        where
          resume.checkpoint_id is not null
          and resume.item_id = any (%1$L::uuid[])
          and sm.reverses_movement_id is not null
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
          and sm.occurred_at > resume.cut_occurred_at
        where
          resume.checkpoint_id is not null
          and resume.item_id = any (%1$L::uuid[])
          and sm.movement_type in (
            'sale_reversal'::app.movement_type,
            'waste_reversal'::app.movement_type
          )
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
          and sm.occurred_at > resume.cut_occurred_at
          join app.stock_movements rev on rev.reverses_movement_id = sm.id
        where
          resume.checkpoint_id is not null
          and resume.item_id = any (%1$L::uuid[])
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
          and sm.id > resume.max_movement_id
        where
          resume.checkpoint_id is not null
          and resume.item_id = any (%1$L::uuid[])
          and sm.reverses_movement_id is not null
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
          and sm.id > resume.max_movement_id
        where
          resume.checkpoint_id is not null
          and resume.item_id = any (%1$L::uuid[])
          and sm.movement_type in (
            'sale_reversal'::app.movement_type,
            'waste_reversal'::app.movement_type
          )
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
          and sm.id > resume.max_movement_id
          join app.stock_movements rev on rev.reverses_movement_id = sm.id
        where
          resume.checkpoint_id is not null
          and resume.item_id = any (%1$L::uuid[])
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
        where
          resume.checkpoint_id is null
          and resume.item_id = any (%1$L::uuid[])
          and sm.reverses_movement_id is not null
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
        where
          resume.checkpoint_id is null
          and resume.item_id = any (%1$L::uuid[])
          and sm.movement_type in (
            'sale_reversal'::app.movement_type,
            'waste_reversal'::app.movement_type
          )
        union
        select
          sm.id
        from
          ledger_scratch.replay_resume resume
          join app.stock_movements sm on sm.item_id = resume.item_id
          join app.stock_movements rev on rev.reverses_movement_id = sm.id
        where
          resume.checkpoint_id is null
          and resume.item_id = any (%1$L::uuid[])
      ) touched
    $explain$,
    p_item_ids
  )
  loop
    v_plan := v_plan || v_line || e'\n';
  end loop;

  return v_plan;
end;
$$;

create function pg_temp.sorted_ids (p_ids bigint[]) returns bigint[] language sql immutable as $$
  select
    coalesce(
      pg_catalog.array_agg(listed.id order by listed.id),
      '{}'::bigint[]
    )
  from
    pg_catalog.unnest(p_ids) as listed (id);
$$;

select
  ok (
    pg_catalog.pg_get_functiondef (
      'app.replay_replace_movement_ids(uuid[])'::regprocedure
    ) ~* 'join app\.stock_movements rev on rev\.reverses_movement_id = sm\.id'
    and pg_catalog.pg_get_functiondef (
      'app.replay_replace_movement_ids(uuid[])'::regprocedure
    ) !~* 'or exists',
    'replace-id collection joins reversed targets as their own union arms'
  );

select
  app.replay_prepare_tables ();

select
  app.replay_bind_resume (
    array['f6e00000-0000-4000-8000-000000000037']::uuid[],
    '[]'::jsonb
  );

select
  is (
    pg_catalog.current_setting ('enable_seqscan'),
    'on',
    'the replace-id default-planner probe leaves sequential scans enabled'
  );

select
  ok (
    (
      select
        plan.plan like '%stock_movements%'
        and plan.plan like '%Index%'
        and plan.plan not like '%Seq Scan on stock_movements%'
        and plan.plan like '%Buffers:%'
      from
        (
          select
            pg_temp.replace_ids_default_plan (
              array['f6e00000-0000-4000-8000-000000000037']::uuid[]
            ) as plan
        ) as plan
    ),
    'replace-id collection under the default planner stays on the suffix indexes'
  );

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000004a',
    'g suffix pair',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-00000000004b',
    'g original prefix',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-00000000004c',
    'g reversal prefix',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000565',
    'f6e00000-0000-4000-8000-00000000004a',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000566',
    'f6e00000-0000-4000-8000-00000000004b',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000567',
    'f6e00000-0000-4000-8000-00000000004c',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.post_movements (
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000004a',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      ),
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000004b',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      ),
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000004c',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '2 days'
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
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000004b',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        2
      )
    )
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-00000000004a',
      'f6e00000-0000-4000-8000-00000000004b',
      'f6e00000-0000-4000-8000-00000000004c'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000568',
    true
  );

select
  app.post_engine_outflows (
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000004a',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        2
      ),
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000004c',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        2
      )
    )
  );

select
  app.retire_movements (
    array[
      (
        select
          sm.id
        from
          app.stock_movements sm
        where
          sm.item_id = 'f6e00000-0000-4000-8000-00000000004a'
          and sm.movement_type = 'sale'
      )
    ]::bigint[],
    'f6e00000-0000-4000-8000-00000000056b'
  );

set
  local session_replication_role = replica;

insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost,
    is_provisional,
    source_type,
    source_id,
    reverses_movement_id
  )
select
  'f6e00000-0000-4000-8000-00000000056c',
  sale.item_id,
  'sale_reversal',
  (
    select
      anchor.at
    from
      f6_anchor anchor
  ),
  - sale.quantity,
  sale.unit_cost,
  - sale.total_cost,
  false,
  'reversal',
  sale.id::text,
  sale.id
from
  app.stock_movements sale
where
  sale.item_id = 'f6e00000-0000-4000-8000-00000000004b'
  and sale.movement_type = 'sale';

insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost,
    is_provisional,
    source_type,
    source_id,
    reverses_movement_id
  )
select
  'f6e00000-0000-4000-8000-00000000056d',
  sale.item_id,
  'sale_reversal',
  (
    select
      anchor.at - interval '3 days'
    from
      f6_anchor anchor
  ),
  - sale.quantity,
  sale.unit_cost,
  - sale.total_cost,
  false,
  'reversal',
  sale.id::text,
  sale.id
from
  app.stock_movements sale
where
  sale.item_id = 'f6e00000-0000-4000-8000-00000000004c'
  and sale.movement_type = 'sale';

set
  local session_replication_role = origin;

select
  app.replay_prepare_tables ();

select
  app.replay_bind_resume (
    array[
      'f6e00000-0000-4000-8000-00000000004a',
      'f6e00000-0000-4000-8000-00000000004b',
      'f6e00000-0000-4000-8000-00000000004c'
    ]::uuid[],
    '[]'::jsonb
  );

select
  is (
    pg_temp.sorted_ids (
      app.replay_replace_movement_ids (
        array[
          'f6e00000-0000-4000-8000-00000000004a',
          'f6e00000-0000-4000-8000-00000000004b',
          'f6e00000-0000-4000-8000-00000000004c'
        ]::uuid[]
      )
    ),
    pg_temp.sorted_ids (
      pg_temp.legacy_replace_movement_ids (
        array[
          'f6e00000-0000-4000-8000-00000000004a',
          'f6e00000-0000-4000-8000-00000000004b',
          'f6e00000-0000-4000-8000-00000000004c'
        ]::uuid[]
      )
    ),
    'replace-id collection matches the prior exists form on the reversal fixtures'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements sale
        join app.stock_movements rev on rev.reverses_movement_id = sale.id
      where
        sale.item_id = 'f6e00000-0000-4000-8000-00000000004a'
        and sale.movement_type = 'sale'
        and sale.id = any (
          app.replay_replace_movement_ids (
            array['f6e00000-0000-4000-8000-00000000004a']::uuid[]
          )
        )
        and rev.id = any (
          app.replay_replace_movement_ids (
            array['f6e00000-0000-4000-8000-00000000004a']::uuid[]
          )
        )
    ),
    'a reversal pair inside the suffix is collected'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements sale
        join app.stock_movements rev on rev.reverses_movement_id = sale.id
        join ledger_scratch.replay_resume resume on resume.item_id = sale.item_id
      where
        sale.item_id = 'f6e00000-0000-4000-8000-00000000004b'
        and sale.movement_type = 'sale'
        and resume.checkpoint_id is not null
        and sale.occurred_at <= resume.cut_occurred_at
        and sale.id <= resume.max_movement_id
        and (
          rev.occurred_at > resume.cut_occurred_at
          or rev.id > resume.max_movement_id
        )
        and sale.id <> all (
          app.replay_replace_movement_ids (
            array['f6e00000-0000-4000-8000-00000000004b']::uuid[]
          )
        )
        and rev.id = any (
          app.replay_replace_movement_ids (
            array['f6e00000-0000-4000-8000-00000000004b']::uuid[]
          )
        )
    ),
    'a prefix original is omitted and its suffix reversal is collected'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements sale
        join app.stock_movements rev on rev.reverses_movement_id = sale.id
      where
        sale.item_id = 'f6e00000-0000-4000-8000-00000000004c'
        and sale.movement_type = 'sale'
        and rev.occurred_at < sale.occurred_at
        and sale.id = any (
          app.replay_replace_movement_ids (
            array['f6e00000-0000-4000-8000-00000000004c']::uuid[]
          )
        )
    ),
    'a reversal dated before its original still collects the original'
  );

-- P2-1. Both items already cut immediately before a posted sort. A later
-- in-suffix change must keep those cuts and walk a short suffix. The
-- original split-sort case above still demotes.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

create temp table p21_days as
select
  anchor.at - interval '20 days' as opening_at,
  anchor.at - interval '19 days' as hist1,
  anchor.at - interval '18 days' as hist2,
  anchor.at - interval '17 days' as hist3,
  anchor.at - interval '15 days' as sort1,
  anchor.at - interval '13 days' as later_at,
  anchor.at - interval '12 days' as sort2
from
  f6_anchor anchor;

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
    'f6e00000-0000-4000-8000-00000000004d',
    'p21 mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-00000000004e',
    'p21 size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-00000000004d'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000004d',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            days.opening_at
          from
            p21_days days
        ),
        'quantity',
        20,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000004d',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            days.hist1
          from
            p21_days days
        ),
        'quantity',
        1,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000004d',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            days.hist2
          from
            p21_days days
        ),
        'quantity',
        1,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000004d',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            days.hist3
          from
            p21_days days
        ),
        'quantity',
        1,
        'unit_cost',
        10
      )
    )
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-00000000004d']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000570',
    true
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-00000000004d',
    (
      select
        days.sort1
      from
        p21_days days
    ),
    4,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000004e',
        'quantity',
        4
      )
    )
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-00000000004d',
      'f6e00000-0000-4000-8000-00000000004e'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000571',
    true
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-00000000004d',
    (
      select
        days.sort2
      from
        p21_days days
    ),
    3,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000004e',
        'quantity',
        3
      )
    )
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-00000000004d',
      'f6e00000-0000-4000-8000-00000000004e'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000572',
    true
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'p21-keep-pre-sort'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id in (
    'f6e00000-0000-4000-8000-00000000004d',
    'f6e00000-0000-4000-8000-00000000004e'
  )
  and checkpoint.cut_occurred_at = (
    select
      days.sort2
    from
      p21_days days
  )
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000004d',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            days.later_at
          from
            p21_days days
        ),
        'quantity',
        1,
        'unit_cost',
        10
      )
    )
  );

select
  set_config('app.replay_probe', '', true);

select
  ok (
    coalesce(
      (
        select
          (detail ->> 'checkpoint_id') is not null
          and (detail ->> 'cut_occurred_at')::timestamptz is not distinct from (
            select
              days.sort1
            from
              p21_days days
          )
          and coalesce((detail ->> 'prefix_rows')::bigint, -1) = 0
          and coalesce((detail ->> 'rows_loaded')::bigint, 99) < 5
        from
          app.replay_read_probe probe,
          lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
        where
          probe.id = (
            select
              max(latest.id)
            from
              app.replay_read_probe latest
          )
          and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-00000000004d'
      ),
      false
    )
    and coalesce(
      (
        select
          (detail ->> 'checkpoint_id') is not null
          and (detail ->> 'cut_occurred_at')::timestamptz is not distinct from (
            select
              days.sort1
            from
              p21_days days
          )
          and coalesce((detail ->> 'prefix_rows')::bigint, -1) = 0
          and coalesce((detail ->> 'rows_loaded')::bigint, 99) < 5
        from
          app.replay_read_probe probe,
          lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
        where
          probe.id = (
            select
              max(latest.id)
            from
              app.replay_read_probe latest
          )
          and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-00000000004e'
      ),
      false
    ),
    'cuts immediately before a posted sort stay put and the suffix walk is short'
  );

-- P2-2. A later-dated receipt must not satisfy a closed sort at t_change.
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
    'f6e00000-0000-4000-8000-00000000004f',
    'p22 mixed short',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000050',
    'p22 size short',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-00000000004f'
  ),
  (
    'f6e00000-0000-4000-8000-000000000051',
    'p22 mixed ok',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000052',
    'p22 size ok',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000051'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000004f',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        2,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000051',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
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
        'f6e00000-0000-4000-8000-00000000004f',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at + interval '1 hour'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000051',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at + interval '1 hour'
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

create temp table p22_before as
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
      app.provisional_deficits
  ) as deficits,
  (
    select
      count(*)
    from
      app.stock_movements
    where
      movement_type in (
        'sort_out'::app.movement_type,
        'sort_in'::app.movement_type,
        'sort_loss'::app.movement_type,
        'closed_period'::app.movement_type
      )
      and item_id in (
        'f6e00000-0000-4000-8000-00000000004f',
        'f6e00000-0000-4000-8000-000000000050'
      )
  ) as sort_rows;

select
  throws_ok (
    $$select app.post_sort(
      'f6e00000-0000-4000-8000-00000000004f',
      (select at - interval '50 days' from f6_anchor),
      5,
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000050',
          'quantity',
          5
        )
      )
    )$$,
    '22023',
    'not enough stock to sort: on_hand_qty 2.000000, requested 5.000000',
    'a closed sort that only the later-dated receipt would cover raises 22023'
  );

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
        before.movements
      from
        p22_before before
    ),
    'a closed sort that only the later-dated receipt would cover writes no movement'
  );

select
  is (
    (
      select
        count(*)
      from
        app.provisional_deficits
    ),
    (
      select
        before.deficits
      from
        p22_before before
    ),
    'a closed sort that only the later-dated receipt would cover writes no deficit'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        movement_type in (
          'sort_out'::app.movement_type,
          'sort_in'::app.movement_type,
          'sort_loss'::app.movement_type,
          'closed_period'::app.movement_type
        )
        and item_id in (
          'f6e00000-0000-4000-8000-00000000004f',
          'f6e00000-0000-4000-8000-000000000050'
        )
    ),
    (
      select
        before.sort_rows
      from
        p22_before before
    ),
    'a closed sort that only the later-dated receipt would cover writes no sort batch'
  );

select
  lives_ok (
    $$select app.post_sort(
      'f6e00000-0000-4000-8000-000000000051',
      (select at - interval '50 days' from f6_anchor),
      5,
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-000000000052',
          'quantity',
          5
        )
      )
    )$$,
    'a closed sort within on-hand at t_change still posts when a later receipt exists'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000051'
        and sm.movement_type in (
          'sort_out'::app.movement_type,
          'closed_period'::app.movement_type
        )
        and sm.quantity < 0
    )
    and exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000052'
        and sm.movement_type in (
          'sort_in'::app.movement_type,
          'closed_period'::app.movement_type
        )
        and sm.quantity > 0
    ),
    'the in-stock-at-t_change closed sort writes both legs'
  );

-- P2-3. A closed surplus keeps its stored receipt total through replay.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000053',
    'p23 free surplus',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000574',
    'f6e00000-0000-4000-8000-000000000053',
    10,
    null,
    null,
    'kg|seafood||'
  );

set
  local session_replication_role = replica;

insert into
  app.stock_movements (
    batch_id,
    item_id,
    movement_type,
    occurred_at,
    quantity,
    unit_cost,
    total_cost,
    is_provisional,
    source_type,
    source_id
  )
select
  'f6e00000-0000-4000-8000-00000000057b',
  'f6e00000-0000-4000-8000-000000000053',
  'purchase',
  anchor.at - interval '30 minutes',
  10,
  0,
  0,
  false,
  'purchase',
  'p23-free'
from
  f6_anchor anchor;

set
  local session_replication_role = origin;

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000053']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000057b',
    true
  );

select
  is (
    (
      select
        sm.quantity::text || '/' || sm.total_cost::text
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000053'
        and sm.movement_type = 'purchase'
    ),
    '10.000000/0.00',
    'live stock is 10/0 from a free receipt before the closed surplus'
  );

select
  is (
    app.closed_unit_cost ('f6e00000-0000-4000-8000-000000000053')::text,
    '10.000000',
    'the closed surplus prices off the opening basis of 10'
  );

select
  lives_ok (
    $lives$
    select
      pg_temp.cover_prepared_count (
        pg_catalog.jsonb_build_object (
          'request_id',
          'f6e00000-0000-4000-8000-000000000575',
          'frequency',
          'daily',
          'counted_at',
          (
            select
              (anchor.at - interval '50 days')::text
            from
              f6_anchor anchor
          ),
          'lines',
          pg_catalog.jsonb_build_array (
            pg_catalog.jsonb_build_object (
              'item_id',
              'f6e00000-0000-4000-8000-000000000053',
              'counted_qty',
              '2',
              'expected_base_unit',
              'kg'
            )
          )
        )
      )
    $lives$,
    'a closed surplus against a free receipt posts'
  );

select
  results_eq (
    $$select sm.quantity::text, sm.total_cost::text, sm.closed_bucket,
            (
              select count(*)
              from app.stock_movements ca
              where ca.item_id = 'f6e00000-0000-4000-8000-000000000053'
                and ca.movement_type = 'cost_adjustment'
            )
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000053'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'$$,
    $$values (
      '2.000000',
      '20.00',
      'count',
      0::bigint
    )$$,
    'the closed surplus is one +20 posting with no cost adjustment'
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000053']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000576',
    true
  );

select
  results_eq (
    $$select sm.quantity::text, sm.total_cost::text, sm.closed_bucket,
            (
              select count(*)
              from app.stock_movements ca
              where ca.item_id = 'f6e00000-0000-4000-8000-000000000053'
                and ca.movement_type = 'cost_adjustment'
            )
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000053'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'$$,
    $$values (
      '2.000000',
      '20.00',
      'count',
      0::bigint
    )$$,
    'replay keeps the stored closed surplus total and writes no CA'
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'p23-full'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000053'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000053']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000577',
    true
  );

select
  results_eq (
    $$select sm.quantity::text, sm.total_cost::text, sm.closed_bucket,
            (
              select count(*)
              from app.stock_movements ca
              where ca.item_id = 'f6e00000-0000-4000-8000-000000000053'
                and ca.movement_type = 'cost_adjustment'
            )
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000053'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'$$,
    $$values (
      '2.000000',
      '20.00',
      'count',
      0::bigint
    )$$,
    'forced full replay keeps the stored closed surplus total and writes no CA'
  );

-- P2-4. Double reclass: class in force at the inflow is waste, then back to COGS.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000054',
    'p24 double reclass',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000578',
    'f6e00000-0000-4000-8000-000000000054',
    10,
    null,
    null,
    'kg|seafood||'
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
  'p24-aged',
  anchor.at - interval '40 days',
  anchor.at - interval '40 days' + interval '8 hours',
  false,
  anchor.at - interval '40 days'
from
  f6_anchor anchor;

insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time
  )
select
  'p24-mid',
  anchor.at - interval '16 days',
  anchor.at - interval '9 days',
  false,
  anchor.at - interval '16 days'
from
  f6_anchor anchor;

select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (
          anchor.at - interval '40 days' + interval '1 hour'
        )::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'p24-order',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000054',
        'quantity',
        5
      )
    ),
    'cogs',
    'sale'
  );

select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (anchor.at - interval '15 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'p24-order',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000054',
        'quantity',
        5
      )
    ),
    'waste',
    'waste'
  );

select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (anchor.at - interval '10 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'p24-order',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-000000000054',
        'quantity',
        5
      )
    ),
    'cogs',
    'sale'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000054',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '12 days'
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
  results_eq (
    $$select sm.closed_bucket, sm.total_cost::text
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000054'
        and sm.movement_type = 'closed_period'
        and sm.cover_inflow_movement_id is not null
      order by sm.id$$,
    $$values ('waste', '-50.00')$$,
    'the inflow between two reclasses uses the waste bucket in force then'
  );

select
  results_eq (
    $$select (sm.occurred_at at time zone 'Africa/Cairo')::date,
             sm.closed_bucket,
             sum(sm.total_cost)::text
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-000000000054'
        and sm.movement_type = 'closed_period'
      group by 1, 2
      order by 1, 2$$,
    $$select *
      from (
        values
          (
            ((select at - interval '40 days' + interval '1 hour' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '-50.00'
          ),
          (
            ((select at - interval '15 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '50.00'
          ),
          (
            ((select at - interval '15 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'waste',
            '-50.00'
          ),
          (
            ((select at - interval '12 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'waste',
            '-50.00'
          ),
          (
            ((select at - interval '10 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '-100.00'
          ),
          (
            ((select at - interval '10 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'waste',
            '100.00'
          )
      ) as expected (day, bucket, total)
      order by 1, 2$$,
    'a COGS to waste to COGS reclass moves the cover on the later transfer'
  );

-- P2-5. Covering a closed count deficit before it ages keeps the 20 in count.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-000000000055',
    'p25 count cover young',
    'seafood',
    'kg',
    'daily'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000055',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
          from
            f6_anchor anchor
        ),
        'quantity',
        3,
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
        'f6e00000-0000-4000-8000-000000000055',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '1 day'
          from
            f6_anchor anchor
        ),
        'quantity',
        2
      )
    )
  );

select
  is (
    pg_temp.cover_prepared_count (
      pg_catalog.jsonb_build_object (
        'request_id',
        'f6e00000-0000-4000-8000-000000000579',
        'frequency',
        'daily',
        'counted_at',
        (
          select
            (anchor.at - interval '50 days')::text
          from
            f6_anchor anchor
        ),
        'lines',
        pg_catalog.jsonb_build_array (
          pg_catalog.jsonb_build_object (
            'item_id',
            'f6e00000-0000-4000-8000-000000000055',
            'counted_qty',
            '0',
            'expected_base_unit',
            'kg'
          )
        )
      )
    ) ->> 'status',
    'posted',
    'the closed count shortage before aging posts'
  );

select
  is (
    (
      select
        deficit.qty_uncovered::text || '/' || deficit.value_uncovered::text
      from
        app.provisional_deficits deficit
        join app.stock_movements sm on sm.id = deficit.movement_id
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000055'
        and sm.movement_type = 'closed_period'
        and sm.closed_bucket = 'count'
        and deficit.qty_uncovered > 0
    ),
    '2.000000/20.00',
    'the closed count shortage before aging opens a 2/20 count deficit'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000055',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at
          from
            f6_anchor anchor
        ),
        'quantity',
        2,
        'unit_cost',
        20
      )
    )
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements ca
        join app.stock_movements target on target.id = ca.adjusts_movement_id
      where
        ca.item_id = 'f6e00000-0000-4000-8000-000000000055'
        and ca.movement_type = 'cost_adjustment'
        and target.movement_type = 'closed_period'
        and target.closed_bucket = 'count'
        and abs(ca.total_cost) = 20
    ),
    'covering the count deficit before aging writes a CA against the closed count'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements ca
        join app.period_revisions revision on revision.source_movement_id = ca.id
      where
        ca.item_id = 'f6e00000-0000-4000-8000-000000000055'
        and ca.movement_type = 'cost_adjustment'
        and revision.bucket = 'count'
        and abs(revision.amount) = 20
    ),
    'the CA against the closed count is revised into the count bucket'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements ca
        join app.period_revisions revision on revision.source_movement_id = ca.id
        join app.accounting_revision_differences diff on diff.cause_id = revision.cause_batch_id::text
        and diff.shift_id = revision.shift_id
      where
        ca.item_id = 'f6e00000-0000-4000-8000-000000000055'
        and ca.movement_type = 'cost_adjustment'
        and abs(diff.count_difference::numeric) = 20
    ),
    'the revision view reports the covered count variance of 20'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements ca
        join app.period_revisions revision on revision.source_movement_id = ca.id
        join app.pos_shifts shift on shift.id = revision.shift_id
        join lateral app.list_shift_accounting_status (shift.opened_at - interval '1 second', '', 20) as row on row ->> 'shift_id' = shift.id
        join lateral pg_catalog.jsonb_array_elements (coalesce(row -> 'revisions', '[]'::jsonb)) as hist (value) on hist.value ->> 'cause_id' = revision.cause_batch_id::text
      where
        ca.item_id = 'f6e00000-0000-4000-8000-000000000055'
        and ca.movement_type = 'cost_adjustment'
        and abs((hist.value ->> 'count_difference')::numeric) = 20
    ),
    'the shift accounting RPC reports the covered count variance of 20'
  );

create temp table p25_after_cover as
select
  (
    select
      count(*)
    from
      app.stock_movements sm
    where
      sm.item_id = 'f6e00000-0000-4000-8000-000000000055'
      and sm.movement_type = 'cost_adjustment'
  ) as cas,
  (
    select
      sm.quantity::text || '/' || sm.total_cost::text
    from
      app.stock_movements sm
    where
      sm.item_id = 'f6e00000-0000-4000-8000-000000000055'
      and sm.movement_type = 'closed_period'
      and sm.closed_bucket = 'count'
      and sm.cover_inflow_movement_id is null
    order by
      sm.id
    limit
      1
  ) as count_row;

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000055']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000057a',
    true
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000055'
        and sm.movement_type = 'cost_adjustment'
    ),
    (
      select
        after.cas
      from
        p25_after_cover after
    ),
    'replay of a count deficit covered before aging is stable'
  );

-- P2-1h. Three-item B1 demotion must reach a fixed point. Raw B has an
-- earlier sort B->C and a later sort B->A. A's cut exposes B->A, so B
-- moves to its only earlier cut (before B->C). C kept the old cut and is
-- not in the first candidate set, so B->C straddles until C is demoted.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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

create temp table p21h_days as
select
  anchor.at - interval '20 days' as opening_at,
  anchor.at - interval '18 days' as sort_bc,
  anchor.at - interval '12 days' as sort_ba,
  anchor.at - interval '10 days' as later_at
from
  f6_anchor anchor;

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
    'f6e00000-0000-4000-8000-000000000056',
    'p21h mixed B',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000057',
    'p21h size C',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000056'
  ),
  (
    'f6e00000-0000-4000-8000-000000000058',
    'p21h size A',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000056'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000056',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            days.opening_at
          from
            p21h_days days
        ),
        'quantity',
        20,
        'unit_cost',
        10
      )
    )
  );

select
  app.replay_execute (
    array['f6e00000-0000-4000-8000-000000000056']::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000057b',
    true
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000056',
    (
      select
        days.sort_bc
      from
        p21h_days days
    ),
    4,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000057',
        'quantity',
        4
      )
    )
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-000000000056',
    (
      select
        days.sort_ba
      from
        p21h_days days
    ),
    3,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000058',
        'quantity',
        3
      )
    )
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000056',
      'f6e00000-0000-4000-8000-000000000057',
      'f6e00000-0000-4000-8000-000000000058'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000057c',
    true
  );

-- A newest in-window purchase skips replay unless it covers an open
-- deficit. Oversell A after B->A, then drop A's cuts so the covering
-- purchase still binds and A's walk exposes B->A.
select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000058',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            days.sort_ba + interval '1 hour'
          from
            p21h_days days
        ),
        'quantity',
        4
      )
    )
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'p21h-expose-a'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000058'
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000058',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            days.later_at
          from
            p21h_days days
        ),
        'quantity',
        1,
        'unit_cost',
        20
      )
    )
  );

select
  set_config('app.replay_probe', '', true);

create temp table p21h_resume as
select
  balance.item_id,
  balance.on_hand_qty,
  balance.on_hand_value
from
  app.item_balances balance
where
  balance.item_id in (
    'f6e00000-0000-4000-8000-000000000056',
    'f6e00000-0000-4000-8000-000000000057',
    'f6e00000-0000-4000-8000-000000000058'
  );

select
  ok (
    exists (
      select
        1
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000056'
        and (
          (detail ->> 'checkpoint_id') is null
          or (detail ->> 'cut_occurred_at')::timestamptz < (
            select
              days.sort_bc
            from
              p21h_days days
          )
        )
    )
    and exists (
      select
        1
      from
        app.replay_read_probe probe,
        lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as detail
      where
        probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        and detail ->> 'item_id' = 'f6e00000-0000-4000-8000-000000000057'
        and (
          (detail ->> 'checkpoint_id') is null
          or (detail ->> 'cut_occurred_at')::timestamptz < (
            select
              days.sort_bc
            from
              p21h_days days
          )
        )
    ),
    'B and C both resume before the earlier sort B->C'
  );

select
  ok (
    not exists (
      select
        1
      from
        app.stock_movements edge
        join app.stock_movements walker on walker.batch_id = edge.batch_id
        and walker.item_id <> edge.item_id
        and walker.movement_type in (
          'sort_out'::app.movement_type,
          'sort_in'::app.movement_type,
          'sort_loss'::app.movement_type
        )
        join app.replay_read_probe probe on probe.id = (
          select
            max(latest.id)
          from
            app.replay_read_probe latest
        )
        join lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as edge_detail on edge_detail ->> 'item_id' = edge.item_id::text
        join lateral pg_catalog.jsonb_array_elements (probe.resume_detail) as walk_detail on walk_detail ->> 'item_id' = walker.item_id::text
      where
        edge.item_id in (
          'f6e00000-0000-4000-8000-000000000056',
          'f6e00000-0000-4000-8000-000000000057',
          'f6e00000-0000-4000-8000-000000000058'
        )
        and edge.movement_type in (
          'sort_out'::app.movement_type,
          'sort_in'::app.movement_type,
          'sort_loss'::app.movement_type
        )
        and (edge_detail ->> 'checkpoint_id') is not null
        and edge.occurred_at <= (edge_detail ->> 'cut_occurred_at')::timestamptz
        and (
          (walk_detail ->> 'checkpoint_id') is null
          or edge.occurred_at > (walk_detail ->> 'cut_occurred_at')::timestamptz
        )
    ),
    'three-item demotion reaches a fixed point: no sort straddles a cut'
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'p21h-full'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id in (
    'f6e00000-0000-4000-8000-000000000056',
    'f6e00000-0000-4000-8000-000000000057',
    'f6e00000-0000-4000-8000-000000000058'
  )
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-000000000056',
      'f6e00000-0000-4000-8000-000000000057',
      'f6e00000-0000-4000-8000-000000000058'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000057d',
    true
  );

select
  results_eq (
    $$select item_id::text, on_hand_qty::text, on_hand_value::text
      from app.item_balances
      where item_id in (
        'f6e00000-0000-4000-8000-000000000056',
        'f6e00000-0000-4000-8000-000000000057',
        'f6e00000-0000-4000-8000-000000000058'
      )
      order by item_id$$,
    $$select item_id::text, on_hand_qty::text, on_hand_value::text
      from p21h_resume
      order by item_id$$,
    'the three-item resumed walk equals a forced full walk'
  );

-- P2-2h. Closed-sort availability uses as-of uncovered-deficit at t_change.
-- 10 at noon, a later waste of 11 leaves a tail deficit; noon quantity is
-- still 10, so a noon sort of 5 must post.
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
    'f6e00000-0000-4000-8000-000000000059',
    'p22h mixed deficit',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-00000000005a',
    'p22h size deficit',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-000000000059'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-000000000059',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
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
        'f6e00000-0000-4000-8000-000000000059',
        'movement_type',
        'waste',
        'occurred_at',
        (
          select
            anchor.at + interval '1 hour'
          from
            f6_anchor anchor
        ),
        'quantity',
        11
      )
    )
  );

select
  lives_ok (
    $$select app.post_sort(
      'f6e00000-0000-4000-8000-000000000059',
      (select at - interval '50 days' from f6_anchor),
      5,
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'f6e00000-0000-4000-8000-00000000005a',
          'quantity',
          5
        )
      )
    )$$,
    'a closed sort of 5 posts when only a later-dated waste created the live deficit'
  );

select
  ok (
    exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-000000000059'
        and sm.movement_type in (
          'sort_out'::app.movement_type,
          'closed_period'::app.movement_type
        )
        and sm.quantity < 0
    )
    and exists (
      select
        1
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000005a'
        and sm.movement_type in (
          'sort_in'::app.movement_type,
          'closed_period'::app.movement_type
        )
        and sm.quantity > 0
    ),
    'the as-of-available closed sort writes both legs'
  );

-- P2-3h. Closed sort pricing uses the same as-of state. 10/100 at noon and
-- a 10/1000 receipt at 13:00: a noon sort of 5 transfers 50, not 275.
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
    'f6e00000-0000-4000-8000-00000000005b',
    'p22h mixed price',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-00000000005c',
    'p22h size price',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-00000000005b'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000005b',
        'movement_type',
        'opening',
        'occurred_at',
        (
          select
            anchor.at - interval '60 days'
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
        'f6e00000-0000-4000-8000-00000000005b',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at + interval '1 hour'
          from
            f6_anchor anchor
        ),
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  app.post_sort (
    'f6e00000-0000-4000-8000-00000000005b',
    (
      select
        anchor.at - interval '50 days'
      from
        f6_anchor anchor
    ),
    5,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000005c',
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
        balance.item_id = 'f6e00000-0000-4000-8000-00000000005c'
    ),
    '5.000000/50.00',
    'a closed noon sort of 5 transfers the as-of 50, not the live 275'
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-00000000005b'
    ),
    '15.000000/1050.00',
    'the mixed item keeps the as-of remainder after the closed noon sort'
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-00000000005b',
      'f6e00000-0000-4000-8000-00000000005c'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000057e',
    true
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-00000000005c'
    ),
    '5.000000/50.00',
    'replay keeps the as-of closed sort transfer of 50'
  );

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'p22h-price-full'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id in (
    'f6e00000-0000-4000-8000-00000000005b',
    'f6e00000-0000-4000-8000-00000000005c'
  )
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-00000000005b',
      'f6e00000-0000-4000-8000-00000000005c'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-00000000057f',
    true
  );

select
  is (
    (
      select
        balance.on_hand_qty::text || '/' || balance.on_hand_value::text
      from
        app.item_balances balance
      where
        balance.item_id = 'f6e00000-0000-4000-8000-00000000005c'
    ),
    '5.000000/50.00',
    'forced full replay keeps the as-of closed sort transfer of 50'
  );

-- P2-4h. Cover transfer reconciliation uses the exact source. Ordinary
-- 5/50 sale deficit, a late -50 cover, then a reclass must move that
-- source; an unrelated closed -50 on the same item must not inflate it.
insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'f6e00000-0000-4000-8000-00000000005d',
    'p24h ordinary cover',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'f6e00000-0000-4000-8000-00000000005e',
    'p24h unrelated closed',
    'seafood',
    'kg',
    'daily'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000580',
    'f6e00000-0000-4000-8000-00000000005d',
    10,
    null,
    null,
    'kg|seafood||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000581',
    'f6e00000-0000-4000-8000-00000000005e',
    10,
    null,
    null,
    'kg|seafood||'
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
  'p24h-sale',
  anchor.at - interval '40 days',
  anchor.at - interval '40 days' + interval '8 hours',
  false,
  anchor.at - interval '40 days'
from
  f6_anchor anchor;

insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time
  )
select
  'p24h-reclass',
  anchor.at - interval '16 days',
  anchor.at - interval '9 days',
  false,
  anchor.at - interval '16 days'
from
  f6_anchor anchor;

select
  app.post_engine_outflows (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000005d',
        'movement_type',
        'sale',
        'occurred_at',
        (
          select
            anchor.at - interval '40 days' + interval '1 hour'
          from
            f6_anchor anchor
        ),
        'quantity',
        5,
        'source_id',
        'p24h-order',
        'shift_id',
        'p24h-sale'
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
select
  'p24h-order',
  'p24h-sale',
  'complete',
  'hall',
  anchor.at - interval '40 days' + interval '1 hour',
  0,
  0,
  0,
  0,
  0,
  0,
  anchor.at - interval '40 days' + interval '1 hour',
  rpad(md5('p24h-order'), 64, 'a'),
  false
from
  f6_anchor anchor;

select
  app.append_pos_cost_input ('p24h-order', null, 'sync');

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
  'p24h-order',
  input.id,
  input.snapshot_id,
  'posting',
  'sale',
  (
    select
      anchor.at - interval '40 days' + interval '1 hour'
    from
      f6_anchor anchor
  ),
  'p24h-sale',
  md5('p24h-order-app'),
  '[]'::jsonb,
  1
from
  app.pos_cost_inputs input
where
  input.order_id = 'p24h-order';

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
  'p24h-order',
  input.id,
  application.id,
  application.id,
  'sale',
  md5('p24h-order-app')
from
  app.pos_cost_inputs input
  join app.order_cost_applications application on application.order_id = input.order_id
where
  input.order_id = 'p24h-order';

insert into
  app.order_cost_movement_links (movement_id, application_id, order_id, item_id)
select
  movement.id,
  application.id,
  'p24h-order',
  movement.item_id
from
  app.stock_movements movement
  join app.order_cost_applications application on application.order_id = 'p24h-order'
where
  movement.item_id = 'f6e00000-0000-4000-8000-00000000005d'
  and movement.movement_type = 'sale';

select
  app.seed_order_recognized ('p24h-order');

select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (anchor.at - interval '10 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'p24h-order',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-00000000005d',
        'quantity',
        5
      )
    ),
    'waste',
    'waste'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000005d',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '11 days'
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
        coalesce(
          sum(sm.total_cost) filter (
            where
              sm.movement_type = 'sale'
              or sm.closed_bucket = 'cogs'
              or (
                sm.movement_type = 'cost_adjustment'
                and exists (
                  select
                    1
                  from
                    app.stock_movements sale
                  where
                    sale.id = sm.adjusts_movement_id
                    and sale.movement_type = 'sale'
                )
              )
          ),
          0
        )::text
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000005d'
    ),
    '0.00',
    'an ordinary covered sale reclass leaves no residual in COGS'
  );

select
  results_eq (
    $$select (sm.occurred_at at time zone 'Africa/Cairo')::date,
             sm.closed_bucket,
             sum(sm.total_cost)::text
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-00000000005d'
        and sm.movement_type = 'closed_period'
      group by 1, 2
      order by 1, 2$$,
    $$select *
      from (
        values
          (
            ((select at - interval '11 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '-50.00'
          ),
          (
            ((select at - interval '10 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '100.00'
          ),
          (
            ((select at - interval '10 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'waste',
            '-100.00'
          )
      ) as expected (day, bucket, total)
      order by 1, 2$$,
    'ordinary-deficit cover transfer keeps per-day bucket totals'
  );

-- Unrelated closed -50 on the same item as a covered closed sale. The
-- source sale is first so the covering purchase attaches to it; the
-- unrelated row must not inflate that source's transfer.
select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (
          anchor.at - interval '40 days' + interval '1 hour'
        )::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'p24h-order-b',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-00000000005e',
        'quantity',
        5
      )
    ),
    'cogs',
    'sale'
  );

select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (
          anchor.at - interval '40 days' + interval '2 hours'
        )::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'p24h-unrelated',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-00000000005e',
        'quantity',
        5
      )
    ),
    'cogs',
    'sale'
  );

select
  set_config('app.t_change_chosen', '1', true);

select
  set_config(
    'app.t_change',
    (
      select
        (anchor.at - interval '10 days')::text
      from
        f6_anchor anchor
    ),
    true
  );

select
  app.post_closed_order_difference (
    'p24h-order-b',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'f6e00000-0000-4000-8000-00000000005e',
        'quantity',
        5
      )
    ),
    'waste',
    'waste'
  );

select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'f6e00000-0000-4000-8000-00000000005e',
        'movement_type',
        'purchase',
        'occurred_at',
        (
          select
            anchor.at - interval '11 days'
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
        coalesce(
          sum(sm.total_cost) filter (
            where
              sm.closed_bucket = 'cogs'
              and not exists (
                select
                  1
                from
                  app.closed_period_sources src
                where
                  src.movement_id = sm.id
                  and src.source_id = 'p24h-unrelated'
              )
          ),
          0
        )::text
      from
        app.stock_movements sm
      where
        sm.item_id = 'f6e00000-0000-4000-8000-00000000005e'
    ),
    '0.00',
    'an unrelated closed -50 does not inflate the ordinary source transfer'
  );

select
  results_eq (
    $$select (sm.occurred_at at time zone 'Africa/Cairo')::date,
             sm.closed_bucket,
             sum(sm.total_cost)::text
      from app.stock_movements sm
      where sm.item_id = 'f6e00000-0000-4000-8000-00000000005e'
        and sm.movement_type = 'closed_period'
      group by 1, 2
      order by 1, 2$$,
    $$select *
      from (
        values
          (
            ((select at - interval '40 days' + interval '1 hour' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '-100.00'
          ),
          (
            ((select at - interval '11 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '-50.00'
          ),
          (
            ((select at - interval '10 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'cogs',
            '100.00'
          ),
          (
            ((select at - interval '10 days' from f6_anchor) at time zone 'Africa/Cairo')::date,
            'waste',
            '-100.00'
          )
      ) as expected (day, bucket, total)
      order by 1, 2$$,
    'unrelated closed row keeps its own day total and does not inflate the reclass'
  );

-- Item 5. Backdated record_purchase behind valid certified cuts with frozen
-- sort history must bound sort-edge reads, stay below 5000 shared buffers,
-- and match a forced full walk identically.
select
  set_config('app.t_change_chosen', '', true);

select
  set_config('app.t_change', '', true);

select
  set_config('app.restatement_window_start', '', true);

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
    'f6e00000-0000-4000-8000-00000000005f',
    'p5 sort bound mixed',
    'fish_mixed',
    'kg',
    'daily',
    null
  ),
  (
    'f6e00000-0000-4000-8000-000000000060',
    'p5 sort bound size',
    'fish_size',
    'kg',
    'daily',
    'f6e00000-0000-4000-8000-00000000005f'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000590',
    'f6e00000-0000-4000-8000-00000000005f',
    10,
    null,
    null,
    'kg|fish_mixed||'
  );

select
  app.set_item_opening_price (
    'f6e00000-0000-4000-8000-000000000591',
    'f6e00000-0000-4000-8000-000000000060',
    10,
    null,
    null,
    'kg|fish_size|f6e00000-0000-4000-8000-00000000005f|'
  );

select
  app.record_opening_stock (
    (
      select
        anchor.at - interval '28 days'
      from
        f6_anchor anchor
    ),
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        'f6e00000-0000-4000-8000-00000000005f',
        'quantity',
        '1000',
        'unit',
        'kg',
        'unit_cost',
        '10',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    'f6e00000-0000-4000-8000-000000000592'
  );

do $$
declare
  d integer;
  v_anchor timestamptz := (select anchor.at from f6_anchor anchor);
begin
  for d in 0..39 loop
    perform app.post_sort (
      'f6e00000-0000-4000-8000-00000000005f',
      v_anchor - interval '25 days' + d * interval '12 hours',
      1,
      pg_catalog.jsonb_build_array (
        pg_catalog.jsonb_build_object (
          'item_id',
          'f6e00000-0000-4000-8000-000000000060',
          'quantity',
          1
        )
      ),
      null
    );
  end loop;
end
$$;

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-00000000005f',
      'f6e00000-0000-4000-8000-000000000060'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000593',
    true
  );

select
  app.record_purchase (
    pg_catalog.jsonb_build_object (
      'purchased_at',
      to_char(
        (
          (
            select
              anchor.at + interval '14 hours'
            from
              f6_anchor anchor
          ) at time zone 'UTC'
        ),
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      ),
      'request_id',
      'f6e00000-0000-4000-8000-000000000594',
      'lines',
      pg_catalog.jsonb_build_array (
        pg_catalog.jsonb_build_object (
          'item_id',
          'f6e00000-0000-4000-8000-00000000005f',
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

create function pg_temp.explain_post_cut_sort_edge () returns jsonb language plpgsql as $$
declare
  v_cut_at timestamptz;
  v_cut_id bigint;
  v_sql text;
  v_plan jsonb;
begin
  select
    checkpoint.cut_occurred_at,
    checkpoint.max_movement_id
  into
    v_cut_at,
    v_cut_id
  from
    app.replay_checkpoints checkpoint
  where
    checkpoint.item_id = 'f6e00000-0000-4000-8000-000000000060'
    and not exists (
      select
        1
      from
        app.replay_checkpoint_invalidations invalidation
      where
        invalidation.checkpoint_id = checkpoint.id
    )
  order by
    checkpoint.cut_occurred_at desc,
    checkpoint.id desc
  limit
    1;

  v_sql := app.replay_sort_edge_sql (
    'f6e00000-0000-4000-8000-000000000060',
    v_cut_at,
    v_cut_id,
    null,
    null,
    array['f6e00000-0000-4000-8000-00000000005f']::uuid[]
  );

  execute 'explain (analyze, buffers, format json) ' || v_sql into v_plan;

  return v_plan -> 0 -> 'Plan';
end;
$$;

with recursive
  plan_nodes (node) as (
    select
      pg_temp.explain_post_cut_sort_edge ()
    union all
    select
      child.node
    from
      plan_nodes parent
      cross join lateral jsonb_array_elements(parent.node -> 'Plans') child (node)
  )
select
  ok (
    count(*) filter (
      where
        node ->> 'Node Type' = 'Seq Scan'
    ) = 0
    and count(*) filter (
      where
        node ->> 'Node Type' in ('Index Scan', 'Index Only Scan')
        and node ->> 'Index Name' = 'stock_movements_sort_time_idx'
        and node ->> 'Index Cond' like '%item_id = %'
        and node ->> 'Index Cond' like '%ROW(occurred_at, id) > ROW(%'
        and (node ->> 'Actual Loops')::bigint = 1
        and (node ->> 'Actual Rows')::bigint = 0
        and coalesce((node ->> 'Rows Removed by Filter')::bigint, 0) = 0
    ) = 1
    and count(*) filter (
      where
        (node ->> 'Actual Loops')::bigint > 0
        or (node ->> 'Actual Rows')::bigint > 0
        or (node ->> 'Shared Hit Blocks')::bigint > 0
        or (node ->> 'Shared Read Blocks')::bigint > 0
    ) = 1,
    'post-cut sort-edge scan uses the full cut as an index bound and reads no frozen sorts'
  )
from
  plan_nodes
where
  node ->> 'Relation Name' = 'stock_movements';

create temp table p5_item_set_resumed as
select
  app.recompute_item_set (
    array['f6e00000-0000-4000-8000-00000000005f']::uuid[]
  ) as items;

select
  set_config('app.replay_probe', '1', true);

delete from app.replay_read_probe;

create function pg_temp.explain_backdated_sort_purchase () returns text language plpgsql as $$
declare
  v_at text;
  v_line text;
  v_plan text := '';
begin
  select
    to_char (
      (anchor.at + interval '13 hours') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    )
  into v_at
  from
    f6_anchor anchor;

  for v_line in execute pg_catalog.format(
    $ex$
    explain (analyze, buffers)
    select app.record_purchase(pg_catalog.jsonb_build_object(
      'purchased_at', %L,
      'request_id', 'f6e00000-0000-4000-8000-000000000595',
      'lines', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'item_id', 'f6e00000-0000-4000-8000-00000000005f',
        'quantity', '1',
        'unit', 'kg',
        'amount_paid', '15.00',
        'expected_base_unit', 'kg',
        'expected_factor', '1'
      ))
    ))
    $ex$,
    v_at
  )
  loop
    v_plan := v_plan || v_line || e'\n';
  end loop;

  return v_plan;
end;
$$;

select
  ok (
    app.replay_plan_shared_buffers (pg_temp.explain_backdated_sort_purchase ()) < 5000,
    'backdated record_purchase behind certified sort cuts stays under 5000 shared buffers'
  );

select
  set_config('app.replay_probe', '', true);

select
  is (
    (
      select
        probe.prefix_rows
      from
        app.replay_read_probe probe
      order by
        probe.id desc
      limit
        1
    ),
    0::bigint,
    'backdated record_purchase behind certified sort cuts reads zero prefix rows'
  );

create temp table p5_resumed_balances as
select
  balance.item_id,
  balance.on_hand_qty,
  balance.on_hand_value,
  balance.avg_cost,
  balance.has_uncovered_deficit
from
  app.item_balances balance
where
  balance.item_id in (
    'f6e00000-0000-4000-8000-00000000005f',
    'f6e00000-0000-4000-8000-000000000060'
  );

create temp table p5_resumed_ledger as
select
  sm.item_id,
  sum(sm.quantity) as total_qty,
  sum(sm.total_cost) as total_cost
from
  app.stock_movements sm
where
  sm.item_id in (
    'f6e00000-0000-4000-8000-00000000005f',
    'f6e00000-0000-4000-8000-000000000060'
  )
group by
  sm.item_id;

insert into
  app.replay_checkpoint_invalidations (checkpoint_id, reason)
select
  checkpoint.id,
  'p5-sort-bound-full'
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id in (
    'f6e00000-0000-4000-8000-00000000005f',
    'f6e00000-0000-4000-8000-000000000060'
  )
  and not exists (
    select
      1
    from
      app.replay_checkpoint_invalidations invalidation
    where
      invalidation.checkpoint_id = checkpoint.id
  );

select
  is (
    (
      select
        items
      from
        p5_item_set_resumed
    ),
    app.recompute_item_set (
      array['f6e00000-0000-4000-8000-00000000005f']::uuid[]
    ),
    'recompute_item_set with certified cuts matches an uncheckpointed full walk'
  );

select
  app.replay_execute (
    array[
      'f6e00000-0000-4000-8000-00000000005f',
      'f6e00000-0000-4000-8000-000000000060'
    ]::uuid[],
    '[]'::jsonb,
    'f6e00000-0000-4000-8000-000000000596',
    true
  );

select
  results_eq (
    $$select item_id::text, on_hand_qty::text, on_hand_value::text, avg_cost::text, has_uncovered_deficit
      from app.item_balances
      where item_id in (
        'f6e00000-0000-4000-8000-00000000005f',
        'f6e00000-0000-4000-8000-000000000060'
      )
      order by item_id$$,
    $$select item_id::text, on_hand_qty::text, on_hand_value::text, avg_cost::text, has_uncovered_deficit
      from p5_resumed_balances
      order by item_id$$,
    'backdated record_purchase behind certified sort cuts matches a forced full walk balance'
  );

select
  results_eq (
    $$select sm.item_id::text, sum(sm.quantity)::text, sum(sm.total_cost)::text
      from app.stock_movements sm
      where sm.item_id in (
        'f6e00000-0000-4000-8000-00000000005f',
        'f6e00000-0000-4000-8000-000000000060'
      )
      group by sm.item_id
      order by sm.item_id$$,
    $$select item_id::text, total_qty::text, total_cost::text
      from p5_resumed_ledger
      order by item_id$$,
    'backdated record_purchase behind certified sort cuts matches a forced full walk ledger'
  );

select
  finish ();

rollback;
