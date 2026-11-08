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
    'owner-27a@theshark.test',
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
    'intruder-27a@theshark.test',
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

insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    loss_pct,
    parent_item_id
  )
values
  (
    'e2700000-0000-4000-8000-000000000001',
    '27a-sale',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000002',
    '27a-sort-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000003',
    '27a-sort-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000002'
  ),
  (
    'e2700000-0000-4000-8000-000000000004',
    '27a-forward-cover',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000005',
    '27a-back-prov',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000006',
    '27a-two-deficits',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000007',
    '27a-cheaper',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000008',
    '27a-waste',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000009',
    '27a-same-instant',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000010',
    '27a-hist-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000011',
    '27a-hist-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000010'
  ),
  (
    'e2700000-0000-4000-8000-000000000012',
    '27a-short-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000013',
    '27a-short-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000012'
  ),
  (
    'e2700000-0000-4000-8000-000000000014',
    'before-opening-item',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000015',
    'before-opening-fish',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000016',
    'before-opening-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000015'
  ),
  (
    'e2700000-0000-4000-8000-000000000017',
    '27a-in-batch',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000018',
    '27a-count-item',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000019',
    '27a-zero-count',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000020',
    '27a-attr-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000021',
    '27a-attr-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000020'
  ),
  (
    'e2700000-0000-4000-8000-000000000022',
    '27a-history-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000023',
    '27a-history-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000022'
  ),
  (
    'e2700000-0000-4000-8000-000000000024',
    '27a-canary-cover',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000025',
    '27a-canary-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000026',
    '27a-canary-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000025'
  ),
  (
    'e2700000-0000-4000-8000-000000000027',
    '27a-frac-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000028',
    '27a-frac-size-a',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000027'
  ),
  (
    'e2700000-0000-4000-8000-000000000029',
    '27a-frac-size-b',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000027'
  ),
  (
    'e2700000-0000-4000-8000-000000000030',
    '27a-frac-size-c',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000027'
  ),
  (
    'e2700000-0000-4000-8000-000000000031',
    '27a-frac-sale',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000032',
    '27a-partial-cover',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000033',
    '27a-second-open',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000034',
    '27a-count-before',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000035',
    '27a-zero-before',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000036',
    '27a-inf-sale',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000037',
    '27a-inf-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000038',
    '27a-inf-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e2700000-0000-4000-8000-000000000037'
  ),
  (
    'e2700000-0000-4000-8000-000000000039',
    '27a-overflow',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e2700000-0000-4000-8000-000000000040',
    '27a-piaster-cover',
    'seafood',
    'kg',
    'daily',
    0,
    null
  );

create function pg_temp.ledger_counts () returns jsonb language sql as $$
  select
    jsonb_build_object(
      'movements',
      (
        select
          count(*)
        from
          app.stock_movements
      ),
      'revisions',
      (
        select
          count(*)
        from
          app.period_revisions
      ),
      'attributions',
      (
        select
          count(*)
        from
          app.movement_attributions
      ),
      'purchases',
      (
        select
          count(*)
        from
          app.purchases
      ),
      'sorts',
      (
        select
          count(*)
        from
          app.sort_batches
      ),
      'sort_lines',
      (
        select
          count(*)
        from
          app.sort_batch_lines
      ),
      'flags',
      (
        select
          count(*)
        from
          app.shift_report_flags
      )
    );
$$;

create function pg_temp.ledger_ok (p_items uuid[]) returns boolean language sql as $$
  select
    not exists (
      select
        1
      from
        app.item_balances ib
      where
        ib.item_id = any (p_items)
        and (
          ib.avg_cost < 0
          or ib.on_hand_qty is distinct from (
            select
              coalesce(sum(sm.quantity), 0)
            from
              app.stock_movements sm
            where
              sm.item_id = ib.item_id
          )
          or ib.on_hand_value is distinct from (
            select
              coalesce(sum(sm.total_cost), 0)
            from
              app.stock_movements sm
            where
              sm.item_id = ib.item_id
          )
        )
    )
    and not exists (
      select
        sm.batch_id
      from
        app.stock_movements sm
        join app.stock_movements ca on ca.adjusts_movement_id = sm.id
        and ca.movement_type = 'cost_adjustment'
      where
        sm.movement_type in ('sort_out', 'sort_in')
        and sm.item_id = any (p_items)
      group by
        sm.batch_id
      having
        sum(ca.total_cost) <> 0
    );
$$;

create function pg_temp.rebuild_stable (p_items uuid[]) returns boolean language plpgsql as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_mov bigint;
  v_rev bigint;
begin
  execute 'reset role';

  v_before := jsonb_build_object(
    'bal',
    coalesce(
      (
        select
          jsonb_agg(
            to_jsonb(ib)
            order by
              ib.item_id
          )
        from
          app.item_balances ib
        where
          ib.item_id = any (p_items)
      ),
      '[]'::jsonb
    ),
    'def',
    coalesce(
      (
        select
          jsonb_agg(
            to_jsonb(d)
            order by
              d.movement_id
          )
        from
          app.provisional_deficits d
        where
          d.item_id = any (p_items)
      ),
      '[]'::jsonb
    )
  );

  select
    count(*) into v_mov
  from
    app.stock_movements;

  select
    count(*) into v_rev
  from
    app.period_revisions;

  perform app.rebuild_derived_balances (
    p_items,
    '00000000-0000-4000-8000-00000000f277'::uuid
  );

  v_after := jsonb_build_object(
    'bal',
    coalesce(
      (
        select
          jsonb_agg(
            to_jsonb(ib)
            order by
              ib.item_id
          )
        from
          app.item_balances ib
        where
          ib.item_id = any (p_items)
      ),
      '[]'::jsonb
    ),
    'def',
    coalesce(
      (
        select
          jsonb_agg(
            to_jsonb(d)
            order by
              d.movement_id
          )
        from
          app.provisional_deficits d
        where
          d.item_id = any (p_items)
      ),
      '[]'::jsonb
    )
  );

  return v_before = v_after
  and (
    select
      count(*)
    from
      app.stock_movements
  ) = v_mov
  and (
    select
      count(*)
    from
      app.period_revisions
  ) = v_rev
  and pg_temp.ledger_ok (p_items);
end;
$$;

create function pg_temp.expect_refusal (
  p_sql text,
  p_state text,
  p_message text,
  p_detail text
) returns boolean language plpgsql as $$
declare
  v_before jsonb;
  v_message text;
  v_state text;
  v_detail text;
begin
  v_before := pg_temp.ledger_counts ();

  begin
    execute p_sql;

    raise exception 'expected refusal';
  exception
    when others then
      get stacked diagnostics v_message = message_text,
      v_state = returned_sqlstate,
      v_detail = pg_exception_detail;

      if v_message = 'expected refusal' then
        raise;
      end if;
  end;

  if v_state is distinct from p_state
  or v_message is distinct from p_message
  or (
    p_detail is not null
    and v_detail is distinct from p_detail
  ) then
    raise exception 'refusal diagnostics state=% message=% detail=%',
      v_state,
      v_message,
      v_detail;
  end if;

  if v_before is distinct from pg_temp.ledger_counts () then
    raise exception 'refusal wrote rows';
  end if;

  return true;
end;
$$;

-- 1. Back-dated purchase reprices the earlier sale.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000001',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        5,
        'shift_id',
        'shift-t01'
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000001',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        200
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, ib.avg_cost,
             sm.total_cost, ca.total_cost, ca.unit_cost, ca.shift_id, ca.quantity,
             ca.source_type, ca.is_provisional
      from app.item_balances ib
      join app.stock_movements sm
        on sm.item_id = ib.item_id
       and sm.movement_type = 'sale'
      join app.stock_movements ca
        on ca.adjusts_movement_id = sm.id
       and ca.movement_type = 'cost_adjustment'
      where ib.item_id = 'e2700000-0000-4000-8000-000000000001'$$,
    $$values (
      15::numeric(20, 6),
      2250.00::numeric(14, 2),
      150::numeric(20, 6),
      -500.00::numeric(14, 2),
      -250.00::numeric(14, 2),
      50::numeric(20, 6),
      'shift-t01'::text,
      0::numeric(20, 6),
      'recompute'::text,
      false
    )$$,
    'back-dated purchase writes one -250 adjustment on the sale'
  );

select
  results_eq (
    $$select bucket, amount, shift_id
      from app.period_revisions
      where item_id = 'e2700000-0000-4000-8000-000000000001'
      order by amount$$,
    $$values ('cogs'::text, -250.00::numeric(14, 2), 'shift-t01'::text)$$,
    'the sale adjustment is a cogs revision of -250'
  );

select
  results_eq (
    $$select profit_delta, sort_transfer_delta
      from app.shift_report_flags
      where shift_id = 'shift-t01'$$,
    $$values (-250.00::numeric(14, 2), 0::numeric(14, 2))$$,
    'shift-t01 profit delta is the sale adjustment'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000001']::uuid[]
    ),
    'sale example: a second rebuild inserts nothing'
  );

-- 2. Back-dated raw purchase reprices the sort and the size sale.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000002',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'e2700000-0000-4000-8000-00000000b002',
      'mixed_item_id',
      'e2700000-0000-4000-8000-000000000002',
      'occurred_at',
      '2026-11-03T10:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'e2700000-0000-4000-8000-000000000003',
          'quantity',
          '10'
        )
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000003',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T11:00:00Z',
        'quantity',
        5,
        'shift_id',
        'shift-t02'
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000002',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T09:00:00Z',
        'quantity',
        10,
        'unit_cost',
        200
      )
    )
  );

select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id in (
        'e2700000-0000-4000-8000-000000000002',
        'e2700000-0000-4000-8000-000000000003'
      )
      order by item_id$$,
    $$values
      (
        'e2700000-0000-4000-8000-000000000002'::uuid,
        10::numeric(20, 6),
        1500.00::numeric(14, 2),
        150::numeric(20, 6)
      ),
      (
        'e2700000-0000-4000-8000-000000000003'::uuid,
        5::numeric(20, 6),
        750.00::numeric(14, 2),
        150::numeric(20, 6)
      )$$,
    'sort example balances after the back-dated raw purchase'
  );

select
  results_eq (
    $$select sm.movement_type::text, ca.total_cost
      from app.stock_movements ca
      join app.stock_movements sm on sm.id = ca.adjusts_movement_id
      where ca.movement_type = 'cost_adjustment'
        and sm.item_id in (
          'e2700000-0000-4000-8000-000000000002',
          'e2700000-0000-4000-8000-000000000003'
        )
      order by sm.movement_type::text$$,
    $$values
      ('sale', -250.00::numeric(14, 2)),
      ('sort_in', 500.00::numeric(14, 2)),
      ('sort_out', -500.00::numeric(14, 2))$$,
    'sort example adjustments move value with the sort and the sale'
  );

select
  is (
    (
      select
        coalesce(sum(amount), 0)
      from
        app.period_revisions
      where
        bucket = 'sort_transfer'
        and item_id in (
          'e2700000-0000-4000-8000-000000000002',
          'e2700000-0000-4000-8000-000000000003'
        )
    ),
    0::numeric(14, 2),
    'sort transfer revisions sum to zero'
  );

select
  results_eq (
    $$select profit_delta, sort_transfer_delta
      from app.shift_report_flags
      where shift_id = 'shift-t02'$$,
    $$values (-250.00::numeric(14, 2), 0::numeric(14, 2))$$,
    'sort transfers do not change the sale shift profit delta'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array[
        'e2700000-0000-4000-8000-000000000002',
        'e2700000-0000-4000-8000-000000000003'
      ]::uuid[]
    ),
    'sort example: a second rebuild inserts nothing'
  );

-- 3. A forward provisional cover is already complete.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000004',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        2,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000004',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T09:00:00Z',
        'quantity',
        2,
        'shift_id',
        'shift-t03'
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000004',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        2,
        'shift_id',
        'shift-t03'
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000004',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T11:00:00Z',
        'quantity',
        5,
        'unit_cost',
        200
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, ib.avg_cost, ib.has_uncovered_deficit,
             pd.qty_uncovered, ca.total_cost
      from app.item_balances ib
      join app.provisional_deficits pd on pd.item_id = ib.item_id
      join app.stock_movements ca
        on ca.adjusts_movement_id = pd.movement_id
       and ca.movement_type = 'cost_adjustment'
      where ib.item_id = 'e2700000-0000-4000-8000-000000000004'$$,
    $$values (
      3::numeric(20, 6),
      600.00::numeric(14, 2),
      200::numeric(20, 6),
      false,
      0::numeric(20, 6),
      -200.00::numeric(14, 2)
    )$$,
    'forward cover stays -200 and keeps the deficit row at qty 0'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000004']::uuid[]
    ),
    'forward cover: rebuild inserts nothing'
  );

-- 4. A new back-dated provisional sale is covered by the later inflow.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000005',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000005',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T09:00:00Z',
        'quantity',
        1
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000005',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        5,
        'unit_cost',
        200
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000005',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        2,
        'shift_id',
        'shift-t04'
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, ib.avg_cost,
             sm.total_cost, ca.total_cost, ca.unit_cost,
             (select sum(pr.amount)
                from app.period_revisions pr
               where pr.item_id = ib.item_id
                 and pr.bucket = 'cogs')
      from app.item_balances ib
      join app.stock_movements sm
        on sm.item_id = ib.item_id
       and sm.movement_type = 'sale'
       and sm.occurred_at = '2026-11-03T10:00:00Z'
      join app.stock_movements ca
        on ca.adjusts_movement_id = sm.id
       and ca.movement_type = 'cost_adjustment'
      where ib.item_id = 'e2700000-0000-4000-8000-000000000005'$$,
    $$values (
      3::numeric(20, 6),
      600.00::numeric(14, 2),
      200::numeric(20, 6),
      -200.00::numeric(14, 2),
      -200.00::numeric(14, 2),
      0::numeric(20, 6),
      -400.00::numeric
    )$$,
    'back-dated provisional sale is base -200 plus adjustment -200'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000005']::uuid[]
    ),
    'back-dated provisional sale: a second rebuild inserts nothing'
  );

-- 5. Deficits are covered in time order when ids run the other way.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000006',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000006',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T09:00:00Z',
        'quantity',
        1
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000006',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        1
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000006',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        1
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000006',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T13:00:00Z',
        'quantity',
        1,
        'unit_cost',
        200
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, ib.avg_cost
      from app.item_balances ib
      where ib.item_id = 'e2700000-0000-4000-8000-000000000006'$$,
    $$values (
      -1::numeric(20, 6),
      -100.00::numeric(14, 2),
      200::numeric(20, 6)
    )$$,
    'partial cover leaves one kilogram uncovered'
  );

select
  results_eq (
    $$select sm.occurred_at, pd.qty_uncovered,
             coalesce(ca.total_cost, 0)::numeric(14, 2)
      from app.provisional_deficits pd
      join app.stock_movements sm on sm.id = pd.movement_id
      left join app.stock_movements ca
        on ca.adjusts_movement_id = sm.id
       and ca.movement_type = 'cost_adjustment'
      where pd.item_id = 'e2700000-0000-4000-8000-000000000006'
      order by sm.occurred_at$$,
    $$values
      ('2026-11-03T10:00:00Z'::timestamptz, 0::numeric(20, 6), -100.00::numeric(14, 2)),
      ('2026-11-03T12:00:00Z'::timestamptz, 1::numeric(20, 6), 0::numeric(14, 2))$$,
    'the earlier deficit is covered even though its id is higher'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000006']::uuid[]
    ),
    'reverse-id deficits: rebuild inserts nothing'
  );

-- 6. A cheaper back-dated purchase lowers the sale cost.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000007',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000007',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        5,
        'shift_id',
        'shift-t06'
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000007',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        50
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, ib.avg_cost,
             sm.total_cost + ca.total_cost, ca.total_cost, ca.unit_cost
      from app.item_balances ib
      join app.stock_movements sm
        on sm.item_id = ib.item_id
       and sm.movement_type = 'sale'
      join app.stock_movements ca
        on ca.adjusts_movement_id = sm.id
       and ca.movement_type = 'cost_adjustment'
      where ib.item_id = 'e2700000-0000-4000-8000-000000000007'$$,
    $$values (
      15::numeric(20, 6),
      1125.00::numeric(14, 2),
      75::numeric(20, 6),
      -375.00::numeric(14, 2),
      125.00::numeric(14, 2),
      -25::numeric(20, 6)
    )$$,
    'cheaper back-dated purchase writes a positive sale adjustment'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000007']::uuid[]
    ),
    'cheaper purchase: a second rebuild inserts nothing'
  );

-- 7. Back-dated waste needs a revision and no cost adjustment.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000008',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000008',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000008',
        'movement_type',
        'waste',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        1,
        'shift_id',
        'shift-t07'
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, ib.avg_cost,
             (select count(*)
                from app.stock_movements ca
               where ca.item_id = ib.item_id
                 and ca.movement_type = 'cost_adjustment'),
             (select pr.amount
                from app.period_revisions pr
               where pr.item_id = ib.item_id
                 and pr.bucket = 'waste')
      from app.item_balances ib
      where ib.item_id = 'e2700000-0000-4000-8000-000000000008'$$,
    $$values (
      19::numeric(20, 6),
      1900.00::numeric(14, 2),
      100::numeric(20, 6),
      0::bigint,
      -100.00::numeric(14, 2)
    )$$,
    'back-dated waste keeps its base cost and revises the shift by -100'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000008']::uuid[]
    ),
    'back-dated waste: a second rebuild inserts nothing'
  );

-- 8. Same-instant unlinked rows stay in batch order and match a rebuild.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000009',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        100
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000009',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        1
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000009',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        1,
        'unit_cost',
        200
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000009',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        1
      )
    )
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = 'e2700000-0000-4000-8000-000000000009'$$,
    $$values (
      2::numeric(20, 6),
      266.67::numeric(14, 2),
      round(400::numeric / 3, 6)::numeric(20, 6)
    )$$,
    'same-instant count, purchase, and sale land at 2 / 266.67'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000009']::uuid[]
    ),
    'same-instant batch: rebuild inserts nothing'
  );

-- 9. A back-dated sort can use stock that was sold later.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000010',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000010',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        10
      )
    )
  );

select
  is (
    (
      select
        on_hand_qty
      from
        app.item_balances
      where
        item_id = 'e2700000-0000-4000-8000-000000000010'
    ),
    0::numeric(20, 6),
    'historical sort starts from raw stock that is currently zero'
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'e2700000-0000-4000-8000-00000000b010',
      'mixed_item_id',
      'e2700000-0000-4000-8000-000000000010',
      'occurred_at',
      '2026-11-03T10:00:00Z',
      'qty_taken',
      '4',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'e2700000-0000-4000-8000-000000000011',
          'quantity',
          '4'
        )
      )
    )
  );

select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id in (
        'e2700000-0000-4000-8000-000000000010',
        'e2700000-0000-4000-8000-000000000011'
      )
      order by item_id$$,
    $$values
      (
        'e2700000-0000-4000-8000-000000000010'::uuid,
        -4::numeric(20, 6),
        -400.00::numeric(14, 2),
        100::numeric(20, 6)
      ),
      (
        'e2700000-0000-4000-8000-000000000011'::uuid,
        4::numeric(20, 6),
        400.00::numeric(14, 2),
        100::numeric(20, 6)
      )$$,
    'historical sort withdraws from the stock that existed then'
  );

select
  results_eq (
    $$select sm.is_provisional, pd.qty_uncovered, pd.value_uncovered
      from app.provisional_deficits pd
      join app.stock_movements sm on sm.id = pd.movement_id
      where pd.item_id = 'e2700000-0000-4000-8000-000000000010'$$,
    $$values (false, 4::numeric(20, 6), 400.00::numeric(14, 2))$$,
    'the later full sale stays one row and keeps a deficit of 4 kg'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array[
        'e2700000-0000-4000-8000-000000000010',
        'e2700000-0000-4000-8000-000000000011'
      ]::uuid[]
    ),
    'historical sort: a second rebuild inserts nothing'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000012',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000012',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        10
      )
    )
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.record_sort(jsonb_build_object(
        'request_id', 'e2700000-0000-4000-8000-00000000b012',
        'mixed_item_id', 'e2700000-0000-4000-8000-000000000012',
        'occurred_at', '2026-11-03T10:00:00Z',
        'qty_taken', '11',
        'lines', jsonb_build_array(jsonb_build_object(
          'item_id', 'e2700000-0000-4000-8000-000000000013',
          'quantity', '11'
        ))
      ))$sql$,
      '22023',
      'not enough stock to sort',
      null
    ),
    'a historical shortage raises not enough stock to sort and writes nothing'
  );

-- 10. Movement before opening stock.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000014',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000015',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.post_movements(jsonb_build_array(jsonb_build_object(
        'item_id', 'e2700000-0000-4000-8000-000000000014',
        'movement_type', 'sale',
        'occurred_at', '2026-11-03T08:00:00Z',
        'quantity', 1
      )))$sql$,
      'P0001',
      'movement is before opening stock',
      'before-opening-item'
    ),
    'post_movements refuses a movement before opening stock'
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.record_purchase(jsonb_build_object(
        'purchased_at', '2026-11-03T08:00:00Z',
        'request_id', 'e2700000-0000-4000-8000-00000000a014',
        'lines', jsonb_build_array(jsonb_build_object(
          'item_id', 'e2700000-0000-4000-8000-000000000014',
          'quantity', '1', 'unit', 'kg', 'amount_paid', '10',
          'expected_base_unit', 'kg', 'expected_factor', '1'
        ))
      ))$sql$,
      'P0001',
      'movement is before opening stock',
      'before-opening-item'
    ),
    'record_purchase refuses a purchase before opening stock'
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.record_sort(jsonb_build_object(
        'request_id', 'e2700000-0000-4000-8000-00000000a015',
        'mixed_item_id', 'e2700000-0000-4000-8000-000000000015',
        'occurred_at', '2026-11-03T08:00:00Z',
        'qty_taken', '1',
        'lines', jsonb_build_array(jsonb_build_object(
          'item_id', 'e2700000-0000-4000-8000-000000000016',
          'quantity', '1'
        ))
      ))$sql$,
      'P0001',
      'movement is before opening stock',
      'before-opening-fish'
    ),
    'record_sort refuses a sort before opening stock'
  );

-- 11. In-batch sales are priced at their own time.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000017',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000017',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        10,
        'unit_cost',
        300
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000017',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T13:00:00Z',
        'quantity',
        1
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000017',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        1
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, ib.avg_cost,
             (select sm.total_cost
                from app.stock_movements sm
               where sm.item_id = ib.item_id
                 and sm.occurred_at = '2026-11-03T10:00:00Z'),
             (select sm.total_cost
                from app.stock_movements sm
               where sm.item_id = ib.item_id
                 and sm.occurred_at = '2026-11-03T13:00:00Z')
      from app.item_balances ib
      where ib.item_id = 'e2700000-0000-4000-8000-000000000017'$$,
    $$values (
      18::numeric(20, 6),
      (3900::numeric - round(3900::numeric / 19, 2))::numeric(14, 2),
      round(3900::numeric / 19, 6)::numeric(20, 6),
      -100.00::numeric(14, 2),
      -round(3900::numeric / 19, 2)::numeric(14, 2)
    )$$,
    'out-of-order sales in one batch are priced at their own time'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000017']::uuid[]
    ),
    'in-batch sales: a second rebuild inserts nothing'
  );

-- 12. A registered count is an anchor. A movement at that instant is replayed
-- before the anchor and compensated, and the observation stays.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000018',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000018',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        1
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000019',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

insert into
  app.stock_counts (id, request_id, frequency, counted_at)
values
  (
    'e2700000-0000-4000-8000-00000000c018',
    'e2700000-0000-4000-8000-00000000d018',
    'daily',
    '2026-11-03T10:00:00Z'
  ),
  (
    'e2700000-0000-4000-8000-00000000c019',
    'e2700000-0000-4000-8000-00000000d019',
    'daily',
    '2026-11-03T10:00:00Z'
  );

insert into
  app.stock_count_lines (
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
select
  'e2700000-0000-4000-8000-00000000c018',
  1,
  sm.item_id,
  'kg',
  11,
  10,
  1,
  sm.total_cost,
  sm.id
from
  app.stock_movements sm
where
  sm.item_id = 'e2700000-0000-4000-8000-000000000018'
  and sm.movement_type = 'count_adjustment';

insert into
  app.stock_count_lines (
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
values
  (
    'e2700000-0000-4000-8000-00000000c019',
    1,
    'e2700000-0000-4000-8000-000000000019',
    'kg',
    10,
    10,
    0,
    0,
    null
  );

update app.item_balances
set
  last_occurred_at = '2026-11-03T10:00:00Z'::timestamptz + interval '1 microsecond'
where
  item_id in (
    'e2700000-0000-4000-8000-000000000018',
    'e2700000-0000-4000-8000-000000000019'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e2700000-0000-4000-8000-000000000018',
      'movement_type', 'sale',
      'occurred_at', '2026-11-03T10:00:00Z',
      'quantity', 1
    )))$$,
    'a movement at a registered count is compensated and the observation stays'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e2700000-0000-4000-8000-000000000019',
      'movement_type', 'sale',
      'occurred_at', '2026-11-03T10:00:00Z',
      'quantity', 1
    )))$$,
    'a movement at a zero-delta count is compensated and the observation stays'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000018',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T10:00:00Z'::timestamptz + interval '1 microsecond',
        'quantity',
        1,
        'unit_cost',
        50
      )
    )
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value, avg_cost
      from app.item_balances
      where item_id = 'e2700000-0000-4000-8000-000000000018'$$,
    $$values (
      12::numeric(20, 6),
      1150.00::numeric(14, 2),
      round(1150::numeric / 12, 6)::numeric(20, 6)
    )$$,
    'a purchase at the count watermark is forward'
  );

-- 13. A gap sort is attributed to the shift that just closed, and stays there.
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
    'shift-a',
    '2026-11-03T08:00:00Z',
    '2026-11-03T12:00:00Z',
    false,
    '2026-11-03T08:00:00Z'
  ),
  (
    'shift-b',
    '2026-11-03T14:00:00Z',
    '2026-11-03T20:00:00Z',
    false,
    '2026-11-03T14:00:00Z'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000020',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'e2700000-0000-4000-8000-00000000b020',
      'mixed_item_id',
      'e2700000-0000-4000-8000-000000000020',
      'occurred_at',
      '2026-11-03T13:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'e2700000-0000-4000-8000-000000000021',
          'quantity',
          '8'
        )
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000020',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T11:00:00Z',
        'quantity',
        10,
        'unit_cost',
        200
      )
    )
  );

select
  results_eq (
    $$select ma.shift_id, f.profit_delta, f.sort_transfer_delta
      from app.stock_movements sm
      join app.movement_attributions ma on ma.movement_id = sm.id
      join app.shift_report_flags f on f.shift_id = ma.shift_id
      where sm.item_id = 'e2700000-0000-4000-8000-000000000020'
        and sm.movement_type = 'sort_loss'$$,
    $$values ('shift-a'::text, -100.00::numeric(14, 2), 0::numeric(14, 2))$$,
    'a sort loss in the gap is charged to the shift that just closed'
  );

update app.pos_shifts
set
  closed_at = '2026-11-03T09:00:00Z'
where
  id = 'shift-a';

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
    'shift-c',
    '2026-11-03T12:00:00Z',
    '2026-11-03T12:50:00Z',
    false,
    '2026-11-03T12:00:00Z'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000020',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T11:30:00Z',
        'quantity',
        10,
        'unit_cost',
        300
      )
    )
  );

select
  results_eq (
    $$select ca.shift_id, ca.total_cost, ma.shift_id
      from app.stock_movements sm
      join app.stock_movements ca
        on ca.adjusts_movement_id = sm.id
       and ca.movement_type = 'cost_adjustment'
      join app.movement_attributions ma on ma.movement_id = sm.id
      where sm.item_id = 'e2700000-0000-4000-8000-000000000020'
        and sm.movement_type = 'sort_loss'
      order by ca.id desc
      limit 1$$,
    $$values ('shift-a'::text, -100.00::numeric(14, 2), 'shift-a'::text)$$,
    'a later adjustment keeps the stored attribution'
  );

select
  results_eq (
    $$select profit_delta, sort_transfer_delta
      from app.shift_report_flags
      where shift_id = 'shift-a'$$,
    $$values (-200.00::numeric(14, 2), 0::numeric(14, 2))$$,
    'the second loss revision stays on shift-a and sort transfers net to zero'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array[
        'e2700000-0000-4000-8000-000000000020',
        'e2700000-0000-4000-8000-000000000021'
      ]::uuid[]
    ),
    'attribution: a second rebuild inserts nothing'
  );

-- 14. Sort history shows the effective loss and per-kg.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000022',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      'e2700000-0000-4000-8000-00000000b022',
      'mixed_item_id',
      'e2700000-0000-4000-8000-000000000022',
      'occurred_at',
      '2026-11-03T10:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'e2700000-0000-4000-8000-000000000023',
          'quantity',
          '8'
        )
      )
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000022',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T09:00:00Z',
        'quantity',
        10,
        'unit_cost',
        300
      )
    )
  );

select
  results_eq (
    $$select loss_qty, loss_value, cost_per_kg
      from app.sort_history
      where mixed_item_id = 'e2700000-0000-4000-8000-000000000022'$$,
    $$values (
      2::numeric(20, 6),
      400.00::numeric(14, 2),
      200::numeric(20, 6)
    )$$,
    'sort history shows the effective loss and the effective per-kg'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array[
        'e2700000-0000-4000-8000-000000000022',
        'e2700000-0000-4000-8000-000000000023'
      ]::uuid[]
    ),
    'sort history: a second rebuild inserts nothing'
  );

-- 15. A forward fixture is reproduced exactly by a rebuild.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000024',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        2,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000024',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T09:00:00Z',
        'quantity',
        2
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000024',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        2
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000024',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T11:00:00Z',
        'quantity',
        5,
        'unit_cost',
        200
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000025',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-03T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  app.post_sort (
    'e2700000-0000-4000-8000-000000000025',
    '2026-11-03T09:00:00Z',
    4,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000026',
        'quantity',
        4
      )
    ),
    null
  );

select
  ok (
    pg_temp.rebuild_stable (
      array[
        'e2700000-0000-4000-8000-000000000024',
        'e2700000-0000-4000-8000-000000000025',
        'e2700000-0000-4000-8000-000000000026'
      ]::uuid[]
    ),
    'forward canary: rebuild reproduces balances and deficits'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000024',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        1
      )
    )
  );

select
  ok (
    pg_temp.rebuild_stable (
      array[
        'e2700000-0000-4000-8000-000000000024',
        'e2700000-0000-4000-8000-000000000025',
        'e2700000-0000-4000-8000-000000000026'
      ]::uuid[]
    ),
    'forward canary: a later post and a second rebuild still insert nothing'
  );

-- 17. A stored opening is the floor. A pending opening cannot move it back.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000033',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.post_movements(jsonb_build_array(jsonb_build_object(
        'item_id', 'e2700000-0000-4000-8000-000000000033',
        'movement_type', 'opening',
        'occurred_at', '2026-11-03T09:00:00Z',
        'quantity', 1,
        'unit_cost', 50
      )))$sql$,
      'P0001',
      'movement is before opening stock',
      '27a-second-open'
    ),
    'an earlier second opening is refused and writes nothing'
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.post_movements(jsonb_build_array(
        jsonb_build_object(
          'item_id', 'e2700000-0000-4000-8000-000000000033',
          'movement_type', 'opening',
          'occurred_at', '2026-11-03T09:00:00Z',
          'quantity', 1,
          'unit_cost', 50
        ),
        jsonb_build_object(
          'item_id', 'e2700000-0000-4000-8000-000000000033',
          'movement_type', 'sale',
          'occurred_at', '2026-11-03T09:30:00Z',
          'quantity', 1
        )
      ))$sql$,
      'P0001',
      'movement is before opening stock',
      '27a-second-open'
    ),
    'an earlier second opening plus a sale between the two times is refused and writes nothing'
  );

select
  results_eq (
    $$select movement_type::text, occurred_at
      from app.stock_movements
      where item_id = 'e2700000-0000-4000-8000-000000000033'
      order by occurred_at, id$$,
    $$values ('opening'::text, '2026-11-03T10:00:00Z'::timestamptz)$$,
    'an earlier second opening leaves only the stored opening'
  );

-- 18. A count before opening stock uses the opening diagnostic, before the
-- generic chronological refusal, for both a normal delta and a zero delta.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000034',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T07:30:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000035',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T07:30:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

create temporary table review_sync_before as
select
  count(*)::bigint as n
from
  app.pos_sync_runs;

-- Prepares the count, covers it with an ok sync, then posts. An exception
-- from the post rolls the prepare and the sync insert back with the statement.
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
  into
    v_close
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
  ok (
    pg_temp.expect_refusal (
      $sql$select pg_temp.cover_prepared_count(jsonb_build_object(
        'request_id', 'e2700000-0000-4000-8000-00000000c034',
        'frequency', 'daily',
        'counted_at', '2026-11-03T07:00:00Z',
        'lines', jsonb_build_array(jsonb_build_object(
          'item_id', 'e2700000-0000-4000-8000-000000000034',
          'counted_qty', '7',
          'expected_base_unit', 'kg'
        ))
      ))$sql$,
      'P0001',
      'movement is before opening stock',
      '27a-count-before'
    ),
    'a normal-delta count before opening stock is refused and writes nothing'
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select pg_temp.cover_prepared_count(jsonb_build_object(
        'request_id', 'e2700000-0000-4000-8000-00000000c035',
        'frequency', 'daily',
        'counted_at', '2026-11-03T07:00:00Z',
        'lines', jsonb_build_array(jsonb_build_object(
          'item_id', 'e2700000-0000-4000-8000-000000000035',
          'counted_qty', '10',
          'expected_base_unit', 'kg'
        ))
      ))$sql$,
      'P0001',
      'movement is before opening stock',
      '27a-zero-before'
    ),
    'a zero-delta count before opening stock is refused and writes nothing'
  );

select
  is_empty (
    $$select request_id from app.stock_count_requests
      where request_id in (
        'e2700000-0000-4000-8000-00000000c034',
        'e2700000-0000-4000-8000-00000000c035'
      )$$,
    'counts before opening stock leave no count request'
  );

select
  is_empty (
    $$select request_id from app.stock_counts
      where request_id in (
        'e2700000-0000-4000-8000-00000000c034',
        'e2700000-0000-4000-8000-00000000c035'
      )$$,
    'counts before opening stock leave no stock count'
  );

select
  is_empty (
    $$select item_id from app.stock_count_lines
      where item_id in (
        'e2700000-0000-4000-8000-000000000034',
        'e2700000-0000-4000-8000-000000000035'
      )$$,
    'counts before opening stock leave no count line'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_sync_runs
    ),
    (
      select
        n
      from
        review_sync_before
    ),
    'counts before opening stock leave no sync run'
  );

select
  results_eq (
    $$select item_id, on_hand_qty, on_hand_value
      from app.item_balances
      where item_id in (
        'e2700000-0000-4000-8000-000000000034',
        'e2700000-0000-4000-8000-000000000035'
      )
      order by item_id$$,
    $$values
      (
        'e2700000-0000-4000-8000-000000000034'::uuid,
        10::numeric(20, 6),
        1000.00::numeric(14, 2)
      ),
      (
        'e2700000-0000-4000-8000-000000000035'::uuid,
        10::numeric(20, 6),
        1000.00::numeric(14, 2)
      )$$,
    'counts before opening stock leave the opening balance'
  );

-- 19. Finiteness is still the refusal when an opening is already stored.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000036',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000037',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-03T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.post_movements(jsonb_build_array(jsonb_build_object(
        'item_id', 'e2700000-0000-4000-8000-000000000036',
        'movement_type', 'sale',
        'occurred_at', '-infinity',
        'quantity', 1
      )))$sql$,
      '22023',
      'occurred_at must be a finite timestamp',
      null
    ),
    'a sale at -infinity is refused as a non-finite timestamp when an opening is stored'
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.post_sort(
        'e2700000-0000-4000-8000-000000000037',
        '-infinity',
        1,
        jsonb_build_array(jsonb_build_object(
          'item_id', 'e2700000-0000-4000-8000-000000000038',
          'quantity', 1
        )),
        null
      )$sql$,
      '22023',
      'occurred_at must be a finite timestamp',
      null
    ),
    'a sort at -infinity is refused as a non-finite timestamp when an opening is stored'
  );

-- 20. Forward fixtures with fractional money survive a rebuild unchanged.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000027',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-05T08:00:00Z',
        'quantity',
        0.04,
        'unit_cost',
        0.5
      )
    )
  );

select
  app.post_sort (
    'e2700000-0000-4000-8000-000000000027',
    '2026-11-05T09:00:00Z',
    0.04,
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000028',
        'quantity',
        0.01
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000029',
        'quantity',
        0.01
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000030',
        'quantity',
        0.01
      )
    ),
    null
  );

select
  ok (
    pg_temp.rebuild_stable (
      array[
        'e2700000-0000-4000-8000-000000000027',
        'e2700000-0000-4000-8000-000000000028',
        'e2700000-0000-4000-8000-000000000029',
        'e2700000-0000-4000-8000-000000000030'
      ]::uuid[]
    ),
    'fractional sort canary: 0.04 kg worth 0.02 with 0.01 loss and three sizes rebuilds with no new cost adjustment'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000031',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-05T08:00:00Z',
        'quantity',
        3,
        'unit_cost',
        33.333333
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000031',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-05T09:00:00Z',
        'quantity',
        1
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000031',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-05T10:00:00Z',
        'quantity',
        1
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000031',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-05T11:00:00Z',
        'quantity',
        1
      )
    )
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000031']::uuid[]
    ),
    'fractional outflow canary: 3 kg at 100/3, two 1 kg sales, then a drain, rebuilds with no new cost adjustment'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000032',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-05T08:00:00Z',
        'quantity',
        2,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000032',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-05T09:00:00Z',
        'quantity',
        5
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000032',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-05T10:00:00Z',
        'quantity',
        1,
        'unit_cost',
        200
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000032',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-05T11:00:00Z',
        'quantity',
        4,
        'unit_cost',
        200
      )
    )
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000032']::uuid[]
    ),
    'partial deficit cover canary: sale of 5 into stock 2, then purchase 1, then purchase 4, rebuilds with no new cost adjustment'
  );

-- Same piaster case as stock_ledger_core §86. Average 100.50, a provisional
-- sale of 0.02 kg costing 2.01, then two purchases of 0.01 kg at 101. The
-- forward cover shares are 1.01 and then the remaining 1.00, so the sale's
-- effective cost is -2.02. Pricing both shares from the unit cost would
-- leave -2.01.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000040',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:00:00Z',
        'quantity',
        1,
        'unit_cost',
        100.50
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000040',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T08:10:00Z',
        'quantity',
        1
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000040',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-10-16T08:20:00Z',
        'quantity',
        0.02
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000040',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:30:00Z',
        'quantity',
        0.01,
        'unit_cost',
        101
      ),
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000040',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-10-16T08:40:00Z',
        'quantity',
        0.01,
        'unit_cost',
        101
      )
    )
  );

select
  results_eq (
    $$select
        (
          select
            (sm.total_cost + coalesce(sum(ca.total_cost), 0))::numeric(14, 2)
          from app.stock_movements sm
          left join app.stock_movements ca
            on ca.adjusts_movement_id = sm.id
            and ca.movement_type = 'cost_adjustment'
          where sm.item_id = ib.item_id
            and sm.movement_type = 'sale'
            and sm.is_provisional
            and sm.quantity = -0.020000
          group by sm.id, sm.total_cost
        ),
        pd.qty_uncovered,
        pd.value_uncovered
      from app.item_balances ib
      join app.provisional_deficits pd on pd.item_id = ib.item_id
      where ib.item_id = 'e2700000-0000-4000-8000-000000000040'$$,
    $$values (
      -2.02::numeric(14, 2),
      0.000000::numeric(20, 6),
      0.00::numeric(14, 2)
    )$$,
    'piaster cover canary: provisional sale of 0.02 kg at avg 100.50, covered by two 0.01 kg purchases at 101, has effective cost -2.02 and no remaining deficit'
  );

select
  ok (
    pg_temp.rebuild_stable (
      array['e2700000-0000-4000-8000-000000000040']::uuid[]
    ),
    'piaster cover canary: rebuild inserts no cost adjustment and leaves balances and deficits unchanged'
  );

-- Two in-range purchases whose replayed sum exceeds numeric(14,2). A
-- 100001-row component is not built here: the replay cap stays the literal
-- 100000 and a fixture of that size is too slow for this suite.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e2700000-0000-4000-8000-000000000039',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-05T12:00:00Z',
        'quantity',
        1,
        'unit_cost',
        600000000000
      )
    )
  );

select
  ok (
    pg_temp.expect_refusal (
      $sql$select app.post_movements(jsonb_build_array(jsonb_build_object(
        'item_id', 'e2700000-0000-4000-8000-000000000039',
        'movement_type', 'purchase',
        'occurred_at', '2026-11-05T08:00:00Z',
        'quantity', 1,
        'unit_cost', 600000000000
      )))$sql$,
      '22023',
      'recompute result is out of range',
      null
    ),
    'a replay whose value exceeds numeric(14,2) is refused and writes nothing'
  );

select
  results_eq (
    $$select count(*)::bigint, sum(total_cost)
      from app.stock_movements
      where item_id = 'e2700000-0000-4000-8000-000000000039'$$,
    $$values (1::bigint, 600000000000.00::numeric)$$,
    'an out-of-range recompute leaves the in-range purchase'
  );

-- 16. Append-only tables and privileges.
select
  ok (
    (
      select
        count(*)
      from
        app.period_revisions
    ) > 0
    and (
      select
        count(*)
      from
        app.stock_movements
    ) > 0,
    'append-only checks have rows to reject'
  );

insert into
  app.movement_attributions (movement_id, shift_id)
select
  sm.id,
  'shift-stored'
from
  app.stock_movements sm
where
  not exists (
    select
      1
    from
      app.movement_attributions ma
    where
      ma.movement_id = sm.id
  )
limit
  1;

select
  throws_ok (
    $$update app.stock_movements set note = note$$,
    '55000',
    'app.stock_movements is append-only; UPDATE is not allowed',
    'stock movements still reject update'
  );

select
  throws_ok (
    $$delete from app.stock_movements$$,
    '55000',
    'app.stock_movements is append-only; DELETE is not allowed',
    'stock movements still reject delete'
  );

-- Plain TRUNCATE never reaches the append-only trigger: provisional_deficits
-- (and later purchase, count, attribution, and revision rows) reference the
-- ledger. CASCADE is what exercises the trigger, and it still raises 55000.
select
  throws_ok (
    $$truncate app.stock_movements cascade$$,
    '55000',
    'app.stock_movements is append-only; TRUNCATE is not allowed',
    'stock movements still reject truncate'
  );

select
  throws_ok (
    $$update app.period_revisions set amount = amount$$,
    '55000',
    'app.period_revisions is append-only; UPDATE is not allowed',
    'period revisions reject update'
  );

select
  throws_ok (
    $$delete from app.period_revisions$$,
    '55000',
    'app.period_revisions is append-only; DELETE is not allowed',
    'period revisions reject delete'
  );

select
  throws_ok (
    $$update app.movement_attributions set shift_id = shift_id$$,
    '55000',
    'app.movement_attributions is append-only; UPDATE is not allowed',
    'attributions reject update'
  );

select
  throws_ok (
    $$delete from app.movement_attributions$$,
    '55000',
    'app.movement_attributions is append-only; DELETE is not allowed',
    'attributions reject delete'
  );

select
  throws_ok (
    $$insert into app.shift_report_flags (shift_id, revised_at, profit_delta, sort_transfer_delta)
      values ('shift-direct', '2026-11-03T08:00:00Z', 0, 0)$$,
    '42501',
    'app.shift_report_flags is writable only by ledger functions',
    'shift flags reject a direct insert'
  );

select
  throws_ok (
    $$truncate app.shift_report_flags$$,
    '42501',
    'app.shift_report_flags is writable only by ledger functions',
    'shift flags reject truncate'
  );

set
  local role anon;

select
  throws_ok (
    $$select * from app.movement_attributions$$,
    '42501',
    null::text,
    'anon cannot select attributions'
  );

select
  throws_ok (
    $$select * from app.period_revisions$$,
    '42501',
    null::text,
    'anon cannot select revisions'
  );

select
  throws_ok (
    $$select * from app.shift_report_flags$$,
    '42501',
    null::text,
    'anon cannot select shift flags'
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
  is_empty (
    $$select * from app.movement_attributions$$,
    'a non-owner cannot read attributions'
  );

select
  is_empty (
    $$select * from app.period_revisions$$,
    'a non-owner cannot read revisions'
  );

select
  is_empty (
    $$select * from app.shift_report_flags$$,
    'a non-owner cannot read shift flags'
  );

select
  throws_ok (
    $$select app.rebuild_derived_balances(
      array['e2700000-0000-4000-8000-000000000001']::uuid[],
      '00000000-0000-4000-8000-00000000f277'::uuid
    )$$,
    '42501',
    null::text,
    'authenticated cannot execute rebuild_derived_balances'
  );

reset role;

set
  local role service_role;

select
  throws_ok (
    $$select app.rebuild_derived_balances(
      array['e2700000-0000-4000-8000-000000000001']::uuid[],
      '00000000-0000-4000-8000-00000000f277'::uuid
    )$$,
    '42501',
    null::text,
    'service_role cannot execute rebuild_derived_balances'
  );

reset role;

-- Catalog privileges, not an invoke. An EXECUTE grant to authenticated would
-- still fail the invoke above, because a non-owner jwt is refused by the
-- ledger lock before the body runs.
select
  is (
    (
      select
        count(*)
      from
        unnest(
          array[
            'app.rebuild_derived_balances(uuid[],uuid)',
            'app.post_backdated_batch(uuid,jsonb)',
            'app.replay_prepare_tables()',
            'app.replay_touch_deficit_flag(uuid)',
            'app.replay_outflow(bigint,uuid,app.movement_type,timestamptz,numeric,numeric,boolean,integer,text,text,text,text)',
            'app.replay_inflow(bigint,uuid,app.movement_type,timestamptz,numeric,numeric,numeric,boolean,integer,text,text,text,text)',
            'app.replay_execute(uuid[],jsonb,uuid,boolean)',
            'app.recompute_item_set(uuid[])',
            'app.assert_not_before_opening(uuid[],timestamptz[],text[])',
            'app.assert_count_barrier(uuid[],timestamptz[],uuid[])',
            'app.assert_recompute_range(numeric,integer,boolean)',
            'app.note_period_revision(bigint,text,text,numeric,uuid,uuid)',
            'app.resolve_shift_id(timestamptz)',
            'app.shift_for_target(bigint)',
            'app.profit_bucket(app.movement_type)',
            'app.batch_is_forward(uuid[],timestamptz[])',
            'app.prepare_balance_locks(uuid[])',
            'app.prevent_append_only_mutation()',
            'app.prevent_shift_flag_direct_write()'
          ]::regprocedure[]
        ) as fn
    ),
    19::bigint,
    'privilege check names every new function in the recompute migration'
  );

select
  is_empty (
    $$select r.role, fn::text
      from unnest(array[
        'app.rebuild_derived_balances(uuid[],uuid)',
        'app.post_backdated_batch(uuid,jsonb)',
        'app.replay_prepare_tables()',
        'app.replay_touch_deficit_flag(uuid)',
        'app.replay_outflow(bigint,uuid,app.movement_type,timestamptz,numeric,numeric,boolean,integer,text,text,text,text)',
        'app.replay_inflow(bigint,uuid,app.movement_type,timestamptz,numeric,numeric,numeric,boolean,integer,text,text,text,text)',
        'app.replay_execute(uuid[],jsonb,uuid,boolean)',
        'app.recompute_item_set(uuid[])',
        'app.assert_not_before_opening(uuid[],timestamptz[],text[])',
        'app.assert_count_barrier(uuid[],timestamptz[],uuid[])',
        'app.assert_recompute_range(numeric,integer,boolean)',
        'app.note_period_revision(bigint,text,text,numeric,uuid,uuid)',
        'app.resolve_shift_id(timestamptz)',
        'app.shift_for_target(bigint)',
        'app.profit_bucket(app.movement_type)',
        'app.batch_is_forward(uuid[],timestamptz[])',
        'app.prepare_balance_locks(uuid[])',
        'app.prevent_append_only_mutation()',
        'app.prevent_shift_flag_direct_write()'
      ]::regprocedure[]) as fn
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r (role)
      where has_function_privilege(r.role, fn, 'execute')$$,
    'new recompute functions are not executable by anon, authenticated, service_role, or public'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname = 'ledger_scratch'
        and c.relkind = 'r'
    ),
    8::bigint,
    'ledger_scratch has the eight replay tables'
  );

select
  is_empty (
    $$select r.role
      from (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r (role)
      where has_schema_privilege(r.role, 'ledger_scratch', 'usage')$$,
    'ledger_scratch usage is denied to anon, authenticated, service_role, and public'
  );

select
  is_empty (
    $$select r.role, c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r (role)
      where n.nspname = 'ledger_scratch'
        and c.relkind = 'r'
        and has_table_privilege(r.role, c.oid, 'select')$$,
    'ledger_scratch tables are not selectable by anon, authenticated, service_role, or public'
  );

select
  *
from
  finish ();

rollback;
