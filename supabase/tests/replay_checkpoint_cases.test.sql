-- Remaining checkpoint cases. Synthetic ids only.
begin;

select
  set_config('app.test_clock', '2026-11-15 12:00:00+00', true);

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
    'c5200000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-c52@theshark.test',
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
  ('c5200000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c5200000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'c5200000-0000-4000-8000-000000000001',
    'c52 replaced',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5200000-0000-4000-8000-000000000002',
    'c52 cap',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5200000-0000-4000-8000-000000000003',
    'c52 deficit value',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5200000-0000-4000-8000-000000000004',
    'c52 shift',
    'seafood',
    'kg',
    'daily'
  ),
  (
    'c5200000-0000-4000-8000-000000000010',
    'c52 provisional',
    'seafood',
    'kg',
    'daily'
  );

-- Provisional outflow. Seed 10, nothing on hand, sell 5.
select
  app.set_item_opening_price (
    'c5200000-0000-4000-8000-000000000101',
    'c5200000-0000-4000-8000-000000000010',
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
        'c5200000-0000-4000-8000-000000000010',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-14T08:00:00Z',
        'quantity',
        5
      )
    )
  );

select
  is (
    (
      select
        balance.on_hand_qty
      from
        app.item_balances balance
      where
        balance.item_id = 'c5200000-0000-4000-8000-000000000010'
    ),
    -5::numeric,
    'a provisional sale of 5 finishes at quantity -5'
  );

select
  is (
    (
      select
        balance.on_hand_value
      from
        app.item_balances balance
      where
        balance.item_id = 'c5200000-0000-4000-8000-000000000010'
    ),
    -50::numeric,
    'a provisional sale of 5 at seed 10 finishes at value -50'
  );

select
  is (
    (
      select
        balance.avg_cost
      from
        app.item_balances balance
      where
        balance.item_id = 'c5200000-0000-4000-8000-000000000010'
    ),
    0::numeric,
    'a seed-valued sale does not change the stored average'
  );

select
  is (
    (
      select
        deficit.qty_uncovered
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
      where
        movement.item_id = 'c5200000-0000-4000-8000-000000000010'
    ),
    5::numeric,
    'the provisional sale leaves a deficit of 5 kg'
  );

select
  is (
    (
      select
        deficit.value_uncovered
      from
        app.provisional_deficits deficit
        join app.stock_movements movement on movement.id = deficit.movement_id
      where
        movement.item_id = 'c5200000-0000-4000-8000-000000000010'
    ),
    50::numeric,
    'the provisional sale leaves 50 uncovered'
  );

-- Replaced stock. Buy 10, sell 10, buy 10. The formula holds 5. The exact layer is 0.
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
    'c5200000-0000-4000-8000-000000000011',
    'c5200000-0000-4000-8000-000000000001',
    'purchase',
    '2026-09-01 08:00:00+00',
    10,
    10,
    100
  ),
  (
    'c5200000-0000-4000-8000-000000000012',
    'c5200000-0000-4000-8000-000000000001',
    'sale',
    '2026-09-02 08:00:00+00',
    -10,
    10,
    -100
  ),
  (
    'c5200000-0000-4000-8000-000000000013',
    'c5200000-0000-4000-8000-000000000001',
    'purchase',
    '2026-09-03 08:00:00+00',
    10,
    10,
    100
  );

insert into
  app.item_balances (item_id, on_hand_qty, on_hand_value, avg_cost)
values
  (
    'c5200000-0000-4000-8000-000000000001',
    10,
    100,
    10
  );

select
  is (
    (
      select
        jsonb_build_object(
          'formula',
          round(
            (
              app.closed_allocation (
                'c5200000-0000-4000-8000-000000000001',
                (
                  select
                    sm.id
                  from
                    app.stock_movements sm
                  where
                    sm.batch_id = 'c5200000-0000-4000-8000-000000000011'
                ),
                -100,
                -10,
                10,
                '2026-09-01 08:00:00+00',
                '2026-11-14 08:00:00+00'
              ) ->> 'held_qty'
            )::numeric,
            6
          ),
          'exact',
          0
        )
    ),
    jsonb_build_object('formula', 5, 'exact', 0),
    'replaced stock stores the formula hold of 5 against an exact 0'
  );

-- Cap binds on a downward correction while quantity is still on hand.
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
    'c5200000-0000-4000-8000-000000000021',
    'c5200000-0000-4000-8000-000000000002',
    'purchase',
    '2026-09-01 08:00:00+00',
    10,
    1,
    10
  );

insert into
  app.item_balances (item_id, on_hand_qty, on_hand_value, avg_cost)
values
  ('c5200000-0000-4000-8000-000000000002', 10, 10, 1);

select
  is (
    (
      app.closed_allocation (
        'c5200000-0000-4000-8000-000000000002',
        (
          select
            sm.id
          from
            app.stock_movements sm
          where
            sm.batch_id = 'c5200000-0000-4000-8000-000000000021'
        ),
        -50,
        0,
        10,
        '2026-09-01 08:00:00+00',
        '2026-11-14 08:00:00+00'
      ) ->> 'held'
    )::numeric,
    -10::numeric,
    'the cap stops the held correction at the on-hand value'
  );

select
  is (
    (
      app.closed_allocation (
        'c5200000-0000-4000-8000-000000000002',
        (
          select
            sm.id
          from
            app.stock_movements sm
          where
            sm.batch_id = 'c5200000-0000-4000-8000-000000000021'
        ),
        -50,
        0,
        10,
        '2026-09-01 08:00:00+00',
        '2026-11-14 08:00:00+00'
      ) ->> 'cogs'
    )::numeric,
    -40::numeric,
    'cap overflow lands in COGS when the other buckets are empty'
  );

-- A negative on-hand value is not pulled up to zero.
insert into
  app.item_balances (item_id, on_hand_qty, on_hand_value, avg_cost)
values
  (
    'c5200000-0000-4000-8000-000000000003',
    -5,
    -50,
    0
  );

select
  is (
    (
      app.closed_allocation (
        'c5200000-0000-4000-8000-000000000003',
        null,
        -10,
        0,
        0,
        '2026-09-01 08:00:00+00',
        '2026-11-14 08:00:00+00'
      ) ->> 'held'
    )::numeric,
    -10::numeric,
    'a provisional negative value is not capped up to zero'
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
            and pg_catalog.pg_get_functiondef (proc.oid) ilike '%a POS sync is running%'
        )
    ),
    0::bigint,
    'the nine owner paths do not refuse a running sync'
  );

select
  ok (
    (
      select
        pg_catalog.strpos (def, 'lock table app.pos_sync_runs in share mode') > 0
        and pg_catalog.strpos (def, 'lock table app.pos_sync_runs in share mode') < pg_catalog.strpos (def, 'a POS sync is running')
        and pg_catalog.strpos (def, 'a POS sync is running') < pg_catalog.strpos (def, 'lock table app.pos_shifts in share mode')
      from
        (
          select
            pg_catalog.pg_get_functiondef (proc.oid) as def
          from
            pg_catalog.pg_proc proc
            join pg_catalog.pg_namespace nsp on nsp.oid = proc.pronamespace
          where
            nsp.nspname = 'app'
            and proc.proname = 'set_order_disposition'
        ) body
    ),
    'the decision path refuses a running sync before it locks shifts'
  );

select
  ok (
    (
      select
        pg_catalog.strpos (def, 'lock table app.pos_sync_runs in share mode') > 0
        and pg_catalog.strpos (def, 'lock table app.pos_sync_runs in share mode') < pg_catalog.strpos (def, 'sync_running')
        and pg_catalog.strpos (def, 'sync_running') < pg_catalog.strpos (def, 'lock table app.pos_shifts in share mode')
        and def not ilike '%perform app.lock_owner_sync_shares%'
      from
        (
          select
            pg_catalog.pg_get_functiondef (proc.oid) as def
          from
            pg_catalog.pg_proc proc
            join pg_catalog.pg_namespace nsp on nsp.oid = proc.pronamespace
          where
            nsp.nspname = 'app'
            and proc.proname = 'run_accounting_work'
        ) body
    ),
    'the span path keeps its sync refusal ahead of the shifts lock'
  );

-- An old closed shift does not receive a cause posted now.
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
    'c52-old',
    '2026-09-01 08:00:00+00',
    '2026-09-01 20:00:00+00',
    false,
    '2026-09-01 08:00:00+00'
  );

select
  app.post_closed_legs (
    null,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5200000-0000-4000-8000-000000000004',
        'quantity',
        0,
        'total_cost',
        25,
        'bucket',
        'inventory',
        'piece',
        0
      )
    )
  );

select
  is (
    (
      select
        sm.shift_id
      from
        app.stock_movements sm
      where
        sm.item_id = 'c5200000-0000-4000-8000-000000000004'
        and sm.movement_type = 'closed_period'
    ),
    null,
    'a closed row keeps a null movement shift'
  );

select
  is (
    (
      select
        attribution.shift_id
      from
        app.movement_attributions attribution
        join app.stock_movements sm on sm.id = attribution.movement_id
      where
        sm.item_id = 'c5200000-0000-4000-8000-000000000004'
    ),
    null,
    'a null shift resolution stays on the attribution'
  );

select
  is (
    (
      select
        row -> 'latest_difference' ->> 'inventory_difference'
      from
        app.list_shift_accounting_status ('2026-09-01 07:00:00+00', '', 20) row
      where
        row ->> 'shift_id' = 'c52-old'
    ),
    '0.00',
    'the old shift is unchanged when no current shift contains the cause'
  );

-- The same screen reads an inventory-only cause inside the current shift.
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
    'c52-open',
    app.test_clock_pin () - interval '1 hour',
    null,
    true,
    app.test_clock_pin ()
  );

select
  app.post_closed_legs (
    null,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'c5200000-0000-4000-8000-000000000004',
        'quantity',
        0,
        'total_cost',
        25,
        'bucket',
        'inventory',
        'piece',
        0
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
        join app.stock_movements sm on sm.id = attribution.movement_id
      where
        sm.item_id = 'c5200000-0000-4000-8000-000000000004'
        and sm.total_cost = 25
        and sm.id = (
          select
            max(later.id)
          from
            app.stock_movements later
          where
            later.item_id = sm.item_id
            and later.movement_type = 'closed_period'
        )
    ),
    'c52-open',
    'a cause inside a shift is attributed to that shift'
  );

select
  results_eq (
    $$select
        row -> 'latest_difference' ->> 'inventory_difference',
        row -> 'latest_difference' ->> 'profit_difference'
      from app.list_shift_accounting_status(
        (select opened_at - interval '1 second' from app.pos_shifts where id = 'c52-open'),
        '',
        20
      ) row
      where row ->> 'shift_id' = 'c52-open'$$,
    $$values ('25.00'::text, '0.00'::text)$$,
    'an inventory-only correction is returned and does not change profit'
  );

select
  is (
    (
      select
        count(*)
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'c5200000-0000-4000-8000-000000000004'
    ) > 0,
    true,
    'the confirming walk publishes a checkpoint'
  );

create temporary table checkpoint_count as
select
  count(*) as n
from
  app.replay_checkpoints
checkpoint
where
  checkpoint.item_id = 'c5200000-0000-4000-8000-000000000004';

select
  app.replay_prepare_tables ();

select
  app.replay_execute (
    array['c5200000-0000-4000-8000-000000000004']::uuid[],
    null,
    null,
    false
  );

select
  is (
    (
      select
        count(*)
      from
        app.replay_checkpoints
      checkpoint
      where
        checkpoint.item_id = 'c5200000-0000-4000-8000-000000000004'
    ),
    (
      select
        n
      from
        checkpoint_count
    ),
    'a dry walk publishes nothing'
  );

insert into
  app.replay_checkpoints (
    item_id,
    cut_occurred_at,
    max_movement_id,
    on_hand_qty,
    on_hand_value,
    avg_cost,
    cost_known,
    has_uncovered_deficit,
    anchor_count,
    digest
  )
select
  'c5200000-0000-4000-8000-000000000001',
  cut.cut_at,
  movement.id,
  10,
  100,
  10,
  true,
  false,
  0,
  cut.digest
from
  (
    values
      ('2026-09-01 08:00:00+00'::timestamptz, 'early'),
      ('2026-09-10 08:00:00+00'::timestamptz, 'later')
  ) as cut (cut_at, digest)
  cross join (
    select
      sm.id
    from
      app.stock_movements sm
    where
      sm.batch_id = 'c5200000-0000-4000-8000-000000000011'
  ) movement;

select
  app.invalidate_checkpoints_from (
    'c5200000-0000-4000-8000-000000000001',
    '2026-09-05 08:00:00+00',
    'closed'
  );

select
  is (
    (
      select
        count(*)
      from
        app.replay_checkpoints
      checkpoint
      join app.replay_checkpoint_invalidations invalidation on invalidation.checkpoint_id = checkpoint.id
      where
        checkpoint.item_id = 'c5200000-0000-4000-8000-000000000001'
        and checkpoint.digest = 'later'
    ),
    1::bigint,
    'a closed cause invalidates a checkpoint at or after the change'
  );

select
  is (
    (
      select
        count(*)
      from
        app.replay_checkpoints
      checkpoint
      left join app.replay_checkpoint_invalidations invalidation on invalidation.checkpoint_id = checkpoint.id
      where
        checkpoint.item_id = 'c5200000-0000-4000-8000-000000000001'
        and checkpoint.digest = 'early'
        and invalidation.checkpoint_id is null
    ),
    1::bigint,
    'a checkpoint strictly before the change stays valid'
  );

select
  throws_ok (
    $$insert into app.replay_checkpoints (
      item_id, cut_occurred_at, max_movement_id, on_hand_qty, on_hand_value,
      avg_cost, cost_known, has_uncovered_deficit, anchor_count, digest
    ) values (
      'c5200000-0000-4000-8000-000000000001',
      '2026-09-01 08:00:00+00',
      9223372036854775807, 0, 0, 0, false, false, 0, 'missing'
    )$$,
    '23503',
    null,
    'a checkpoint cannot name a movement that is not in the ledger'
  );

create function pg_temp.suffix_plan () returns text language plpgsql as $$
declare
  v_line text;
  v_plan text := '';
  v_bound bigint;
begin
  insert into
    app.stock_items (id, name, kind, base_unit, count_frequency)
  values
    (
      'c5200000-0000-4000-8000-000000000098',
      'c52 later ids',
      'seafood',
      'kg',
      'daily'
    ),
    (
      'c5200000-0000-4000-8000-000000000099',
      'c52 plan',
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
    'c5200000-0000-4000-8000-000000000099',
    'purchase',
    '2026-08-01 00:00:00+00'::timestamptz + (series.i || ' minutes')::interval,
    1,
    1,
    1
  from
    pg_catalog.generate_series(1, 400) as series (i);

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
    'c5200000-0000-4000-8000-000000000098',
    'purchase',
    '2026-08-01 00:00:00+00'::timestamptz + (series.i || ' seconds')::interval,
    1,
    1,
    1
  from
    pg_catalog.generate_series(1, 8000) as series (i);

  analyze app.stock_movements;

  select
    min(bound.id) + 10
  into v_bound
  from
    app.stock_movements bound
  where
    bound.item_id = 'c5200000-0000-4000-8000-000000000099';

  for v_line in
  execute format(
    'explain select sm.id from app.stock_movements sm where sm.item_id = %L and sm.occurred_at > %L union select sm.id from app.stock_movements sm where sm.item_id = %L and sm.id > %s',
    'c5200000-0000-4000-8000-000000000099',
    '2026-08-01 02:00:00+00',
    'c5200000-0000-4000-8000-000000000099',
    v_bound
  )
  loop
    v_plan := v_plan || v_line || E'\n';
  end loop;

  return v_plan;
end;
$$;

select
  ok (
    exists (
      select
        1
      from
        pg_catalog.pg_indexes
      where
        schemaname = 'app'
        and indexname = 'stock_movements_item_id_idx'
    ),
    'the suffix has an index on item and movement id'
  );

select
  set_config('enable_seqscan', 'off', true);

create temporary table suffix_plan_text as
select
  pg_temp.suffix_plan () as plan;

select
  ok (
    (
      select
        plan
      from
        suffix_plan_text
    ) ilike '%Index%Scan%stock_movements_item_occurred_idx%'
    and (
      select
        plan
      from
        suffix_plan_text
    ) ilike '%occurred_at >%'
    and (
      select
        plan
      from
        suffix_plan_text
    ) ilike '%id >%'
    and (
      select
        plan
      from
        suffix_plan_text
    ) not ilike '%Seq Scan on stock_movements%',
    'the two suffix ranges are index scans, one by time and one by id'
  );

select
  *
from
  finish ();

rollback;
