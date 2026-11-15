-- Checkpoint and closed-period behavior. Synthetic ids only.
begin;

select
  set_config('app.test_clock', '2026-11-15 12:00:00+00', true);

select
  no_plan ();

select
  ok (
    'closed_period'::text = any (enum_range(null::app.movement_type)::text[]),
    'closed_period is a movement kind'
  );

select
  is (
    app.accounting_scaling_ready (),
    true,
    'the checkpoint migration makes scaling ready'
  );

select
  is_empty (
    $$select r.role
      from unnest(array['public', 'anon', 'authenticated', 'service_role']) as r (role)
      where has_function_privilege(r.role, 'app.accounting_scaling_ready()', 'execute')$$,
    'no API role can call accounting_scaling_ready'
  );

select
  is (
    (
      select
        count(*)
      from
        unnest(
          array[
            'set_item_opening_price',
            'record_purchase',
            'post_movements',
            'post_movements_internal',
            'record_opening_stock',
            'post_sort',
            'record_sort',
            'post_backdated_batch',
            'record_count'
          ]
        ) as name (proname)
      where
        exists (
          select
            1
          from
            pg_catalog.pg_proc proc
            join pg_catalog.pg_namespace nsp on nsp.oid = proc.pronamespace
          where
            nsp.nspname = 'app'
            and proc.proname = name.proname
            and pg_catalog.pg_get_functiondef (proc.oid) ilike '%perform app.lock_owner_sync_shares%'
        )
    ),
    9::bigint,
    'the nine owner paths take the sync share helper'
  );

select
  ok (
    (
      select
        pg_catalog.pg_get_functiondef (proc.oid) ilike '%in row exclusive mode%'
      from
        pg_catalog.pg_proc proc
        join pg_catalog.pg_namespace nsp on nsp.oid = proc.pronamespace
      where
        nsp.nspname = 'app'
        and proc.proname = 'ingest_pos_batch'
    ),
    'ingest takes row exclusive on pos_sync_runs'
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
    'c5100000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-c51@theshark.test',
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
  ('c5100000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c5100000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'c5100000-0000-4000-8000-000000000001',
    'c51 mix',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5100000-0000-4000-8000-000000000002',
    'c51 known',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5100000-0000-4000-8000-000000000003',
    'c51 reason',
    'seafood',
    'kg',
    'daily'
  );

-- Unknown mix. 100 kg at total 1, then 10 kg at total 100, then a sale of 20.
-- The 10 kg document is corrected by -99. Held is exactly -81 and consumption -18.
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
values
  (
    'c5100000-0000-4000-8000-000000000011',
    'c5100000-0000-4000-8000-000000000001',
    'purchase',
    '2026-09-01 08:00:00+00',
    100,
    0.010000,
    1.00
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
values
  (
    'c5100000-0000-4000-8000-000000000012',
    'c5100000-0000-4000-8000-000000000001',
    'purchase',
    '2026-09-02 08:00:00+00',
    10,
    10,
    100.00
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
values
  (
    'c5100000-0000-4000-8000-000000000013',
    'c5100000-0000-4000-8000-000000000001',
    'sale',
    '2026-09-03 08:00:00+00',
    -20,
    0.918182,
    -18.36
  );

insert into
  app.item_balances (item_id, on_hand_qty, on_hand_value, avg_cost)
values
  (
    'c5100000-0000-4000-8000-000000000001',
    90,
    82.64,
    0.918222
  );

select
  is (
    round(
      (
        app.closed_allocation (
          'c5100000-0000-4000-8000-000000000001',
          (
            select
              sm.id
            from
              app.stock_movements sm
            where
              sm.batch_id = 'c5100000-0000-4000-8000-000000000012'
          ),
          -99,
          0,
          10,
          '2026-09-02 08:00:00+00',
          '2026-11-14 08:00:00+00'
        ) ->> 'held_qty'
      )::numeric,
      6
    ),
    8.181818::numeric,
    'the unknown mix holds 8.181818 kg'
  );

select
  is (
    (
      app.closed_allocation (
        'c5100000-0000-4000-8000-000000000001',
        (
          select
            sm.id
          from
            app.stock_movements sm
          where
            sm.batch_id = 'c5100000-0000-4000-8000-000000000012'
        ),
        -99,
        0,
        10,
        '2026-09-02 08:00:00+00',
        '2026-11-14 08:00:00+00'
      ) ->> 'raw_held'
    )::numeric,
    -81::numeric,
    'the unknown mix puts -81 on inventory'
  );

select
  is (
    (
      app.closed_allocation (
        'c5100000-0000-4000-8000-000000000001',
        (
          select
            sm.id
          from
            app.stock_movements sm
          where
            sm.batch_id = 'c5100000-0000-4000-8000-000000000012'
        ),
        -99,
        0,
        10,
        '2026-09-02 08:00:00+00',
        '2026-11-14 08:00:00+00'
      ) ->> 'consumed'
    )::numeric,
    -18::numeric,
    'the unknown mix puts -18 on consumption'
  );

select
  lives_ok (
    $$select app.post_closed_document_correction(
      null,
      'c5100000-0000-4000-8000-000000000001',
      (select sm.id from app.stock_movements sm where sm.batch_id = 'c5100000-0000-4000-8000-000000000012'),
      -99,
      0,
      10,
      'purchase',
      null,
      'purchase',
      null,
      null,
      null
    )$$,
    'the unknown-mix correction posts'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5100000-0000-4000-8000-000000000001'
    ),
    1.64::numeric,
    'stock finishes at 1.64 and the cap does not bind'
  );

-- Zero denominator: nothing on hand and no outflow. held_qty is 0.
select
  is (
    (
      app.closed_allocation (
        'c5100000-0000-4000-8000-000000000003',
        null,
        -10,
        0,
        5,
        '2026-09-01 08:00:00+00',
        '2026-11-14 08:00:00+00'
      ) ->> 'held_qty'
    )::numeric,
    0::numeric,
    'a zero denominator holds nothing'
  );

-- Known layer: the document is the only positive inflow, and a later sale
-- does not by itself make the layer unknown.
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
values
  (
    'c5100000-0000-4000-8000-000000000021',
    'c5100000-0000-4000-8000-000000000002',
    'purchase',
    '2026-09-01 08:00:00+00',
    10,
    10,
    100
  ),
  (
    'c5100000-0000-4000-8000-000000000022',
    'c5100000-0000-4000-8000-000000000002',
    'sale',
    '2026-09-02 08:00:00+00',
    -4,
    10,
    -40
  );

insert into
  app.item_balances (item_id, on_hand_qty, on_hand_value, avg_cost)
values
  ('c5100000-0000-4000-8000-000000000002', 6, 60, 10);

select
  is (
    (
      app.closed_allocation (
        'c5100000-0000-4000-8000-000000000002',
        (
          select
            sm.id
          from
            app.stock_movements sm
          where
            sm.batch_id = 'c5100000-0000-4000-8000-000000000021'
        ),
        -20,
        0,
        10,
        '2026-09-01 08:00:00+00',
        '2026-11-14 08:00:00+00'
      ) ->> 'known'
    )::boolean,
    true,
    'a lone inflow stays a known layer after a later sale'
  );

select
  is (
    (
      app.closed_allocation (
        'c5100000-0000-4000-8000-000000000002',
        (
          select
            sm.id
          from
            app.stock_movements sm
          where
            sm.batch_id = 'c5100000-0000-4000-8000-000000000021'
        ),
        -20,
        0,
        10,
        '2026-09-01 08:00:00+00',
        '2026-11-14 08:00:00+00'
      ) ->> 'held'
    )::numeric,
    -12::numeric,
    'the known layer holds the quantity still on hand'
  );

-- Missing basis writes nothing.
select
  throws_ok (
    $$select app.post_closed_document_correction(
      null,
      'c5100000-0000-4000-8000-000000000003',
      null,
      -10,
      -1,
      1,
      'manual',
      'c51-missing',
      'sale',
      null,
      null,
      null
    )$$,
    'P0001',
    'missing_cost_basis',
    'an added outflow with no cost basis raises missing_cost_basis'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'c5100000-0000-4000-8000-000000000003'
    ),
    0::bigint,
    'a missing basis writes no movement'
  );

-- Reason move: +100 spoilage and -100 other, net 0, two revisions.
select
  lives_ok (
    $$select app.post_closed_legs(
      null,
      jsonb_build_array(
        jsonb_build_object(
          'item_id', 'c5100000-0000-4000-8000-000000000003',
          'quantity', 0,
          'total_cost', 100,
          'bucket', 'waste',
          'reason_code', 'spoilage',
          'report_class', 'waste',
          'piece', 0
        ),
        jsonb_build_object(
          'item_id', 'c5100000-0000-4000-8000-000000000003',
          'quantity', 0,
          'total_cost', -100,
          'bucket', 'waste',
          'reason_code', 'other',
          'report_class', 'waste',
          'piece', 1
        )
      )
    )$$,
    'a reason move posts both rows'
  );

select
  is (
    (
      select
        coalesce(sum(sm.total_cost), 0)
      from
        app.stock_movements sm
      where
        sm.item_id = 'c5100000-0000-4000-8000-000000000003'
        and sm.movement_type = 'closed_period'
    ),
    0::numeric,
    'the reason move nets to zero'
  );

select
  is (
    (
      select
        count(*)
      from
        app.period_revisions revision
        join app.stock_movements sm on sm.id = revision.source_movement_id
      where
        sm.item_id = 'c5100000-0000-4000-8000-000000000003'
    ),
    2::bigint,
    'the reason move records both revisions'
  );

-- A duplicate queue key does not change the eligible count.
select
  app.enqueue_accounting_event (
    'c51-order',
    'activation',
    'c51:event:1',
    null,
    null
  );

select
  is (
    (
      select
        stats.eligible_count
      from
        app.accounting_queue_stats stats
      where
        stats.id = 1
    ),
    1::bigint,
    'one new event makes the order eligible'
  );

select
  app.enqueue_accounting_event (
    'c51-order',
    'activation',
    'c51:event:1',
    null,
    null
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events event
      where
        event.source_key = 'c51:event:1'
    ),
    1::bigint,
    'a duplicate source key inserts nothing'
  );

-- No API role can write a checkpoint.
set
  local role anon;

select
  throws_ok (
    $$insert into app.replay_checkpoints (
      item_id, cut_occurred_at, max_movement_id, on_hand_qty, on_hand_value,
      avg_cost, cost_known, has_uncovered_deficit, anchor_count, digest
    ) values (
      'c5100000-0000-4000-8000-000000000001',
      '2026-09-01 08:00:00+00',
      1, 0, 0, 0, false, false, 0, 'forged'
    )$$,
    '42501',
    null,
    'anon cannot insert a checkpoint'
  );

select
  throws_ok (
    $$insert into app.replay_checkpoint_invalidations (checkpoint_id, reason)
      values (1, 'forged')$$,
    '42501',
    null,
    'anon cannot insert an invalidation'
  );

reset role;

select
  *
from
  finish ();

rollback;
