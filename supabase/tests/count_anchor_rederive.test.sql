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
    'owner-anchor@theshark.test',
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
    'intruder-anchor@theshark.test',
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
    'e5200000-0000-4000-8000-000000000001',
    'anchor-example',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000002',
    'anchor-zero',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000003',
    'anchor-instant',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000004',
    'anchor-sign',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000005',
    'anchor-later',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000006',
    'anchor-value',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000007',
    'anchor-sort-raw',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000008',
    'anchor-sort-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'e5200000-0000-4000-8000-000000000007'
  ),
  (
    'e5200000-0000-4000-8000-000000000009',
    'anchor-reversal',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000010',
    'anchor-floor',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5200000-0000-4000-8000-000000000011',
    'anchor-chrono',
    'seafood',
    'kg',
    'daily',
    0,
    null
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
    'shift-anchor-83',
    '2026-11-01T08:00:00Z',
    '2026-11-01T12:00:00Z',
    false,
    '2026-11-01T08:00:00Z'
  ),
  (
    'shift-anchor-value',
    '2026-11-06T08:00:00Z',
    '2026-11-06T12:00:00Z',
    false,
    '2026-11-06T08:00:00Z'
  ),
  (
    'shift-anchor-sort',
    '2026-11-07T08:00:00Z',
    '2026-11-07T12:00:00Z',
    false,
    '2026-11-07T08:00:00Z'
  ),
  (
    'shift-anchor-rev',
    '2026-11-08T08:00:00Z',
    '2026-11-08T12:00:00Z',
    false,
    '2026-11-08T08:00:00Z'
  );

create function pg_temp.observe_count (
  p_count_id uuid,
  p_request_id uuid,
  p_item_id uuid,
  p_at timestamptz,
  p_counted numeric,
  p_expected numeric,
  p_movement_id bigint,
  p_value numeric
) returns void language plpgsql as $$
begin
  insert into
    app.stock_counts (id, request_id, frequency, counted_at)
  values
    (p_count_id, p_request_id, 'daily', p_at);

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
      p_count_id,
      1,
      p_item_id,
      'kg',
      p_counted,
      p_expected,
      p_counted - p_expected,
      p_value,
      p_movement_id
    );

  update app.item_balances
  set
    last_occurred_at = greatest (
      coalesce(last_occurred_at, p_at),
      p_at + interval '1 microsecond'
    )
  where
    item_id = p_item_id;
end;
$$;

-- 1. Late sale before a count. Inventory stays 8. COGS -200, count +200, profit 0.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000001',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-01T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000001',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-01T12:00:00Z',
        'quantity',
        -2
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c1',
    'e5200000-0000-4000-8000-0000000000d1',
    'e5200000-0000-4000-8000-000000000001',
    '2026-11-01T12:00:00Z',
    8,
    10,
    (
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000001'
        and sm.movement_type = 'count_adjustment'
    ),
    -200
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000001',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-01T10:00:00Z',
        'quantity',
        2
      )
    )
  );

select
  results_eq (
    $$select on_hand_qty, on_hand_value
      from app.item_balances
      where item_id = 'e5200000-0000-4000-8000-000000000001'$$,
    $$values (8::numeric(20, 6), 800.00::numeric(14, 2))$$,
    'the late sale leaves inventory at the counted 8'
  );

select
  results_eq (
    $$select sm.quantity, sm.unit_cost, sm.total_cost
      from app.stock_movements sm
      where sm.item_id = 'e5200000-0000-4000-8000-000000000001'
        and sm.movement_type = 'count_compensation'$$,
    $$values (2::numeric(20, 6), 0::numeric(20, 6), 200.00::numeric(14, 2))$$,
    'the compensator carries the quantity gap and the value gap, not a unit price'
  );

select
  results_eq (
    $$select line.counted_qty, line.expected_qty, line.delta_qty, line.delta_value
      from app.stock_count_lines line
      where line.count_id = 'e5200000-0000-4000-8000-0000000000c1'$$,
    $$values (
      8::numeric(20, 6),
      10::numeric(20, 6),
      -2::numeric(20, 6),
      -200.00::numeric(14, 2)
    )$$,
    'the original count line stays frozen'
  );

select
  results_eq (
    $$select pr.bucket, pr.amount
      from app.period_revisions pr
      where pr.item_id = 'e5200000-0000-4000-8000-000000000001'
      order by pr.bucket$$,
    $$values ('cogs'::text, -200.00::numeric(14, 2)),
      ('count'::text, 200.00::numeric(14, 2))$$,
    'the sale raises COGS by 200 and the compensator lowers count loss by 200'
  );

select
  results_eq (
    $$select profit_delta, revised_at is not null
      from app.shift_report_flags
      where shift_id = 'shift-anchor-83'$$,
    $$values (0.00::numeric(14, 2), true)$$,
    'the revised day shows the badge and a zero profit difference'
  );

select
  results_eq (
    $$select shortage_value, surplus_value, has_surplus,
            revised_difference, compensator_sum, has_compensator
      from app.stock_count_history
      where id = 'e5200000-0000-4000-8000-0000000000c1'$$,
    $$values (
      200.00::numeric(14, 2),
      0.00::numeric(14, 2),
      false,
      200.00::numeric(14, 2),
      200.00::numeric(14, 2),
      true
    )$$,
    'history keeps the frozen shortage and shows the revised difference'
  );

select
  results_eq (
    $$select original_delta_qty, latest_required_qty, compensator_qty, has_compensator
      from app.stock_count_line_current
      where count_id = 'e5200000-0000-4000-8000-0000000000c1'$$,
    $$values (-2::numeric(20, 6), 0::numeric(20, 6), 2::numeric(20, 6), true)$$,
    'the line view keeps the original delta beside the latest required quantity'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000001'
    ),
    4::bigint,
    'the example posts opening, count, sale, and one compensator'
  );

select
  app.rebuild_derived_balances (
    array['e5200000-0000-4000-8000-000000000001']::uuid[],
    'e5200000-0000-4000-8000-0000000000e1'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000001'
    ),
    4::bigint,
    'a second replay of the example posts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_count_derivations deriv
      where
        deriv.count_id = 'e5200000-0000-4000-8000-0000000000c1'
    ),
    1::bigint,
    'a second replay adds no derivation'
  );

-- 2. A zero-delta count can acquire its first compensator.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000002',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-02T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c2',
    'e5200000-0000-4000-8000-0000000000d2',
    'e5200000-0000-4000-8000-000000000002',
    '2026-11-02T12:00:00Z',
    10,
    10,
    null,
    0
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000002',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-02T10:00:00Z',
        'quantity',
        2
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, line.movement_id is null, line.delta_qty,
            comp.quantity, comp.total_cost
      from app.item_balances ib
      join app.stock_count_lines line
        on line.item_id = ib.item_id
       and line.count_id = 'e5200000-0000-4000-8000-0000000000c2'
      join app.stock_movements comp
        on comp.item_id = ib.item_id
       and comp.movement_type = 'count_compensation'
      where ib.item_id = 'e5200000-0000-4000-8000-000000000002'$$,
    $$values (
      10::numeric(20, 6),
      true,
      0::numeric(20, 6),
      2::numeric(20, 6),
      200.00::numeric(14, 2)
    )$$,
    'a matching count gains its first compensator and on-hand stays the observation'
  );

-- 3. A movement at the count instant is before the anchor.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000003',
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
        'e5200000-0000-4000-8000-000000000003',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        -2
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c3',
    'e5200000-0000-4000-8000-0000000000d3',
    'e5200000-0000-4000-8000-000000000003',
    '2026-11-03T12:00:00Z',
    8,
    10,
    (
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000003'
        and sm.movement_type = 'count_adjustment'
    ),
    -200
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000003',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-03T12:00:00Z',
        'quantity',
        2
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, sale.occurred_at = counted.counted_at, comp.quantity, comp.total_cost
      from app.item_balances ib
      join app.stock_counts counted
        on counted.id = 'e5200000-0000-4000-8000-0000000000c3'
      join app.stock_movements sale
        on sale.item_id = ib.item_id
       and sale.movement_type = 'sale'
      join app.stock_movements comp
        on comp.item_id = ib.item_id
       and comp.movement_type = 'count_compensation'
      where ib.item_id = 'e5200000-0000-4000-8000-000000000003'$$,
    $$values (8::numeric(20, 6), true, 2::numeric(20, 6), 200.00::numeric(14, 2))$$,
    'a sale at the count instant is compensated and on-hand stays 8'
  );

-- 4. The required adjustment can change sign.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000004',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-04T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000004',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-04T12:00:00Z',
        'quantity',
        2
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c4',
    'e5200000-0000-4000-8000-0000000000d4',
    'e5200000-0000-4000-8000-000000000004',
    '2026-11-04T12:00:00Z',
    12,
    10,
    (
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000004'
        and sm.movement_type = 'count_adjustment'
    ),
    200
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000004',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-04T09:00:00Z',
        'quantity',
        5,
        'unit_cost',
        100
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value, deriv.required_qty, deriv.required_value,
            comp.quantity, comp.total_cost
      from app.item_balances ib
      join app.stock_count_derivations deriv
        on deriv.count_id = 'e5200000-0000-4000-8000-0000000000c4'
      join app.stock_movements comp
        on comp.item_id = ib.item_id
       and comp.movement_type = 'count_compensation'
      where ib.item_id = 'e5200000-0000-4000-8000-000000000004'$$,
    $$values (
      12::numeric(20, 6),
      1200.00::numeric(14, 2),
      -3::numeric(20, 6),
      -300.00::numeric(14, 2),
      -5::numeric(20, 6),
      -500.00::numeric(14, 2)
    )$$,
    'a surplus count becomes a shortage and the compensator posts both gaps'
  );

-- 5. Several later counts. Each anchor ends on its actual quantity.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000005',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-05T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000005',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-05T12:00:00Z',
        'quantity',
        -2
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c5',
    'e5200000-0000-4000-8000-0000000000d5',
    'e5200000-0000-4000-8000-000000000005',
    '2026-11-05T12:00:00Z',
    8,
    10,
    (
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000005'
        and sm.movement_type = 'count_adjustment'
        and sm.occurred_at = '2026-11-05T12:00:00Z'
    ),
    -200
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000005',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-05T13:00:00Z',
        'quantity',
        -2
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c6',
    'e5200000-0000-4000-8000-0000000000d6',
    'e5200000-0000-4000-8000-000000000005',
    '2026-11-05T13:00:00Z',
    6,
    8,
    (
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000005'
        and sm.movement_type = 'count_adjustment'
        and sm.occurred_at = '2026-11-05T13:00:00Z'
    ),
    -200
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000005',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-05T10:00:00Z',
        'quantity',
        2
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty,
            first_line.counted_qty,
            first_deriv.required_qty,
            (
              select coalesce(sum(sm.quantity), 0)::numeric(20, 6)
              from app.stock_count_postings posting
              join app.stock_movements sm on sm.id = posting.movement_id
              where posting.count_id = first_line.count_id
                and sm.movement_type in ('count_adjustment', 'count_compensation')
            ),
            second_line.counted_qty,
            second_line.delta_qty,
            (
              select count(*)
              from app.stock_count_derivations deriv
              where deriv.count_id = second_line.count_id
            ),
            (
              select count(*)
              from app.stock_count_postings posting
              join app.stock_movements sm on sm.id = posting.movement_id
              where posting.count_id = second_line.count_id
                and sm.movement_type = 'count_compensation'
            )
      from app.item_balances ib
      join app.stock_count_lines first_line
        on first_line.count_id = 'e5200000-0000-4000-8000-0000000000c5'
      join app.stock_count_derivations first_deriv
        on first_deriv.count_id = first_line.count_id
      join app.stock_count_lines second_line
        on second_line.count_id = 'e5200000-0000-4000-8000-0000000000c6'
      where ib.item_id = 'e5200000-0000-4000-8000-000000000005'$$,
    $$values (
      6::numeric(20, 6),
      8::numeric(20, 6),
      0::numeric(20, 6),
      0::numeric(20, 6),
      6::numeric(20, 6),
      -2::numeric(20, 6),
      0::bigint,
      0::bigint
    )$$,
    'the first anchor settles to 8 and the later anchor stays a shortage of 2'
  );

-- 6. Zero quantity and a nonzero value posts cost_adjustment, not compensation.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000006',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-06T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000006',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-06T12:00:00Z',
        'quantity',
        -2
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c7',
    'e5200000-0000-4000-8000-0000000000d7',
    'e5200000-0000-4000-8000-000000000006',
    '2026-11-06T12:00:00Z',
    8,
    10,
    (
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000006'
        and sm.movement_type = 'count_adjustment'
    ),
    -200
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000006',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-06T09:00:00Z',
        'quantity',
        10,
        'unit_cost',
        300
      ),
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000006',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-06T10:00:00Z',
        'quantity',
        10
      )
    )
  );

select
  results_eq (
    $$select ib.on_hand_qty, ib.on_hand_value,
            hist.has_compensator, hist.revised_difference, hist.compensator_sum,
            ca.total_cost, ca.adjusts_movement_id = line.movement_id,
            pr.bucket, pr.amount
      from app.item_balances ib
      join app.stock_count_history hist
        on hist.id = 'e5200000-0000-4000-8000-0000000000c7'
      join app.stock_count_lines line
        on line.count_id = hist.id
      join app.stock_movements ca
        on ca.item_id = ib.item_id
       and ca.movement_type = 'cost_adjustment'
      join app.period_revisions pr
        on pr.source_movement_id = ca.id
      where ib.item_id = 'e5200000-0000-4000-8000-000000000006'$$,
    $$values (
      8::numeric(20, 6),
      1600.00::numeric(14, 2),
      false,
      -200.00::numeric(14, 2),
      0.00::numeric(14, 2),
      -200.00::numeric(14, 2),
      true,
      'count'::text,
      -200.00::numeric(14, 2)
    )$$,
    'a value-only gap adjusts the original count and follows the count bucket'
  );

select
  is_empty (
    $$select id
      from app.stock_movements
      where item_id = 'e5200000-0000-4000-8000-000000000006'
        and movement_type = 'count_compensation'$$,
    'a value-only gap posts no compensator'
  );

select
  ok (
    (
      select
        revised_at is not null
      from
        app.shift_report_flags
      where
        shift_id = 'shift-anchor-value'
    ),
    'the value-only revision still badges the shift'
  );

-- 7. Historical sorting still reaches a count on the sorted size.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000007',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-07T08:00:00Z',
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
      'e5200000-0000-4000-8000-0000000000b8',
      'mixed_item_id',
      'e5200000-0000-4000-8000-000000000007',
      'occurred_at',
      '2026-11-07T11:00:00Z',
      'qty_taken',
      '10',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          'e5200000-0000-4000-8000-000000000008',
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
        'e5200000-0000-4000-8000-000000000008',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2026-11-07T12:00:00Z',
        'quantity',
        -2
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c8',
    'e5200000-0000-4000-8000-0000000000d8',
    'e5200000-0000-4000-8000-000000000008',
    '2026-11-07T12:00:00Z',
    8,
    10,
    (
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000008'
        and sm.movement_type = 'count_adjustment'
    ),
    -200
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000007',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-07T09:00:00Z',
        'quantity',
        10,
        'unit_cost',
        300
      )
    )
  );

select
  results_eq (
    $$select raw_bal.on_hand_qty, raw_bal.on_hand_value,
            size_bal.on_hand_qty, size_bal.on_hand_value,
            ca.total_cost, pr.bucket
      from app.item_balances raw_bal
      join app.item_balances size_bal
        on size_bal.item_id = 'e5200000-0000-4000-8000-000000000008'
      join app.stock_count_lines line
        on line.count_id = 'e5200000-0000-4000-8000-0000000000c8'
      join app.stock_movements ca
        on ca.adjusts_movement_id = line.movement_id
       and ca.movement_type = 'cost_adjustment'
      join app.period_revisions pr
        on pr.source_movement_id = ca.id
      where raw_bal.item_id = 'e5200000-0000-4000-8000-000000000007'$$,
    $$values (
      10::numeric(20, 6),
      2000.00::numeric(14, 2),
      8::numeric(20, 6),
      1600.00::numeric(14, 2),
      -200.00::numeric(14, 2),
      'count'::text
    )$$,
    'a late purchase before the sort revalues the size count across the anchor'
  );

select
  is_empty (
    $$select sm.id
      from app.stock_movements sm
      where sm.item_id = 'e5200000-0000-4000-8000-000000000008'
        and sm.movement_type = 'count_compensation'$$,
    'the revalued size count posts no compensator'
  );

create temp table sort_move_count on
commit
drop as
select
  count(*)::bigint as n
from
  app.stock_movements sm
where
  sm.item_id in (
    'e5200000-0000-4000-8000-000000000007',
    'e5200000-0000-4000-8000-000000000008'
  );

select
  app.rebuild_derived_balances (
    array['e5200000-0000-4000-8000-000000000007']::uuid[],
    'e5200000-0000-4000-8000-0000000000e8'
  );

select
  results_eq (
    $$select n from sort_move_count$$,
    $$select count(*)::bigint
      from app.stock_movements sm
      where sm.item_id in (
        'e5200000-0000-4000-8000-000000000007',
        'e5200000-0000-4000-8000-000000000008'
      )$$,
    'a second replay across the sort posts nothing'
  );

-- 8. Reversing a counted-period sale reveals a shortage. The observation stays.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000009',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-08T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      ),
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000009',
        'movement_type',
        'sale',
        'occurred_at',
        '2026-11-08T10:00:00Z',
        'quantity',
        2
      )
    )
  );

select
  pg_temp.observe_count (
    'e5200000-0000-4000-8000-0000000000c9',
    'e5200000-0000-4000-8000-0000000000d9',
    'e5200000-0000-4000-8000-000000000009',
    '2026-11-08T12:00:00Z',
    8,
    8,
    null,
    0
  );

select
  app.retire_movements (
    array(
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000009'
        and sm.movement_type = 'sale'
    ),
    'e5200000-0000-4000-8000-0000000000e9'
  );

select
  results_eq (
    $$select line.counted_qty, line.expected_qty, line.delta_qty, line.movement_id is null,
            ib.on_hand_qty, ib.on_hand_value, comp.quantity, comp.total_cost
      from app.stock_count_lines line
      join app.item_balances ib on ib.item_id = line.item_id
      join app.stock_movements comp
        on comp.item_id = line.item_id
       and comp.movement_type = 'count_compensation'
      where line.count_id = 'e5200000-0000-4000-8000-0000000000c9'$$,
    $$values (
      8::numeric(20, 6),
      8::numeric(20, 6),
      0::numeric(20, 6),
      true,
      8::numeric(20, 6),
      800.00::numeric(14, 2),
      -2::numeric(20, 6),
      -200.00::numeric(14, 2)
    )$$,
    'reversing the sale reveals the shortage without editing the observation'
  );

select
  results_eq (
    $$select pr.bucket, pr.amount
      from app.period_revisions pr
      where pr.item_id = 'e5200000-0000-4000-8000-000000000009'
      order by pr.bucket$$,
    $$values ('cogs'::text, 200.00::numeric(14, 2)),
      ('count'::text, -200.00::numeric(14, 2))$$,
    'the reversal and the revealed shortage offset'
  );

select
  results_eq (
    $$select profit_delta, revised_at is not null
      from app.shift_report_flags
      where shift_id = 'shift-anchor-rev'$$,
    $$values (0.00::numeric(14, 2), true)$$,
    'the revealed shortage badges the shift with a zero profit difference'
  );

select
  app.rebuild_derived_balances (
    array['e5200000-0000-4000-8000-000000000009']::uuid[],
    'e5200000-0000-4000-8000-0000000000ea'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000009'
        and sm.movement_type = 'count_compensation'
    ),
    1::bigint,
    'a second replay of the revealed shortage posts nothing'
  );

-- 9. The opening floor still refuses.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000010',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-09T10:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

select
  throws_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5200000-0000-4000-8000-000000000010',
      'movement_type', 'purchase',
      'occurred_at', '2026-11-09T08:00:00Z',
      'quantity', 1,
      'unit_cost', 50
    )))$$,
    'P0001',
    'movement is before opening stock',
    'a movement before opening stock is still refused'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5200000-0000-4000-8000-000000000010'
    ),
    1::bigint,
    'the opening-floor refusal writes nothing'
  );

-- 10. A count before last_occurred_at is still refused. Backdated counts are not added.
select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000011',
        'movement_type',
        'opening',
        'occurred_at',
        '2026-11-10T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        40
      ),
      jsonb_build_object(
        'item_id',
        'e5200000-0000-4000-8000-000000000011',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-10T12:00:00Z',
        'quantity',
        1,
        'unit_cost',
        40
      )
    )
  );

set
  local role authenticated;

select
  is (
    app.record_count (
      jsonb_build_object(
        'request_id',
        'e5200000-0000-4000-8000-0000000000db',
        'frequency',
        'daily',
        'counted_at',
        '2026-11-10T10:00:00Z',
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            'e5200000-0000-4000-8000-000000000011',
            'counted_qty',
            '10',
            'expected_base_unit',
            'kg'
          )
        )
      )
    ),
    jsonb_build_object('status', 'waiting_for_sync'),
    'a count before the watermark waits for sync before the chronological guard'
  );

reset role;

insert into
  app.pos_sync_runs (mode, status, started_at, finished_at)
select
  'recent',
  'ok',
  greatest(
    request.prepared_at,
    coalesce(
      (
        select
          max(shift.close_recorded_at)
        from
          app.pos_shifts shift
        where
          shift.opened_at <= '2026-11-10T10:00:00Z'::timestamptz
      ),
      request.prepared_at
    )
  ) + interval '1 second',
  greatest(
    request.prepared_at,
    coalesce(
      (
        select
          max(shift.close_recorded_at)
        from
          app.pos_shifts shift
        where
          shift.opened_at <= '2026-11-10T10:00:00Z'::timestamptz
      ),
      request.prepared_at
    )
  ) + interval '2 seconds'
from
  app.stock_count_requests request
where
  request.request_id = 'e5200000-0000-4000-8000-0000000000db';

set
  local role authenticated;

select
  throws_ok (
    $$select app.record_count(jsonb_build_object(
      'request_id', 'e5200000-0000-4000-8000-0000000000db',
      'frequency', 'daily',
      'counted_at', '2026-11-10T10:00:00Z',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', 'e5200000-0000-4000-8000-000000000011',
        'counted_qty', '10',
        'expected_base_unit', 'kg'
      ))
    ))$$,
    'P0001',
    'back-dated movement not supported yet',
    'a count before last_occurred_at is still refused'
  );

reset role;

select
  is_empty (
    $$select id
      from app.stock_counts
      where request_id = 'e5200000-0000-4000-8000-0000000000db'$$,
    'the refused count does not become an anchor'
  );

-- 11. Privileges, RLS, and append-only guards.
select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_proc proc
        join pg_catalog.pg_namespace namespace on namespace.oid = proc.pronamespace
      where
        namespace.nspname = 'app'
        and proc.proname = 'assert_count_barrier'
    ),
    1::bigint,
    'assert_count_barrier still exists'
  );

select
  is_empty (
    $$select r.role, fn::text
      from unnest(array[
        'app.replay_apply_anchor(bigint)',
        'app.settle_count_anchors(uuid,uuid[])',
        'app.trg_stock_count_lines_anchor()',
        'app.trg_stock_count_postings_shape()',
        'app.replay_execute(uuid[],jsonb,uuid,boolean)',
        'app.replay_component(uuid[],jsonb,uuid,boolean)',
        'app.post_backdated_batch(uuid,jsonb)',
        'app.replay_prepare_tables()',
        'app.assert_count_barrier(uuid[],timestamptz[],uuid[])'
      ]::regprocedure[]) as fn
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r (role)
      where has_function_privilege(r.role, fn, 'execute')$$,
    'anchor functions stay private to the ledger'
  );

select
  is_empty (
    $$select r.role, p.privilege_type, t.table_name
      from (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r (role)
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p (privilege_type)
      cross join (values
        ('app.stock_count_anchors'),
        ('app.stock_count_derivations'),
        ('app.stock_count_postings')
      ) as t (table_name)
      where has_table_privilege(r.role, t.table_name, p.privilege_type)$$,
    'API roles cannot write anchor tables'
  );

select
  results_eq (
    $$select r.role, t.table_name
      from (values ('authenticated'), ('service_role')) as r (role)
      cross join (values
        ('app.stock_count_anchors'),
        ('app.stock_count_derivations'),
        ('app.stock_count_postings'),
        ('app.stock_count_line_current')
      ) as t (table_name)
      where has_table_privilege(r.role, t.table_name, 'SELECT')
      order by 2, 1$$,
    $$values
      ('authenticated', 'app.stock_count_anchors'),
      ('service_role', 'app.stock_count_anchors'),
      ('authenticated', 'app.stock_count_derivations'),
      ('service_role', 'app.stock_count_derivations'),
      ('authenticated', 'app.stock_count_line_current'),
      ('service_role', 'app.stock_count_line_current'),
      ('authenticated', 'app.stock_count_postings'),
      ('service_role', 'app.stock_count_postings')$$,
    'authenticated and service_role can select the anchor tables and the line view'
  );

select
  results_eq (
    $$select c.relname, c.relrowsecurity
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app'
        and c.relname in (
          'stock_count_anchors',
          'stock_count_derivations',
          'stock_count_postings'
        )
      order by c.relname$$,
    $$values
      ('stock_count_anchors'::name, true),
      ('stock_count_derivations'::name, true),
      ('stock_count_postings'::name, true)$$,
    'anchor tables enable row level security'
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
  is_empty (
    $$select count_id from app.stock_count_anchors
      union all
      select count_id from app.stock_count_derivations
      union all
      select count_id from app.stock_count_postings
      union all
      select id from app.stock_count_history
      union all
      select count_id from app.stock_count_line_current$$,
    'a non-owner sees no anchor, derivation, posting, or history rows'
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
        app.stock_count_anchors
    ) > 0
    and (
      select
        count(*)
      from
        app.stock_count_history
      where
        has_compensator
    ) > 0,
    'the owner can read anchors and the revised history'
  );

reset role;

select
  throws_ok (
    $$update app.stock_count_anchors set actual_qty = actual_qty$$,
    '55000',
    'app.stock_count_anchors is append-only; UPDATE is not allowed',
    'anchors reject update'
  );

select
  throws_ok (
    $$delete from app.stock_count_anchors$$,
    '55000',
    'app.stock_count_anchors is append-only; DELETE is not allowed',
    'anchors reject delete'
  );

select
  throws_ok (
    $$truncate app.stock_count_anchors$$,
    '55000',
    'app.stock_count_anchors is append-only; TRUNCATE is not allowed',
    'anchors reject truncate'
  );

select
  throws_ok (
    $$update app.stock_count_derivations set required_qty = required_qty$$,
    '55000',
    'app.stock_count_derivations is append-only; UPDATE is not allowed',
    'derivations reject update'
  );

select
  throws_ok (
    $$delete from app.stock_count_derivations$$,
    '55000',
    'app.stock_count_derivations is append-only; DELETE is not allowed',
    'derivations reject delete'
  );

select
  throws_ok (
    $$truncate app.stock_count_derivations$$,
    '55000',
    'app.stock_count_derivations is append-only; TRUNCATE is not allowed',
    'derivations reject truncate'
  );

select
  throws_ok (
    $$update app.stock_count_postings set posting_role = posting_role$$,
    '55000',
    'app.stock_count_postings is append-only; UPDATE is not allowed',
    'postings reject update'
  );

select
  throws_ok (
    $$delete from app.stock_count_postings$$,
    '55000',
    'app.stock_count_postings is append-only; DELETE is not allowed',
    'postings reject delete'
  );

select
  throws_ok (
    $$truncate app.stock_count_postings$$,
    '55000',
    'app.stock_count_postings is append-only; TRUNCATE is not allowed',
    'postings reject truncate'
  );

-- A 100001-event component is too slow for this suite (see
-- backdated_recompute.test.sql), so the cap's inputs are checked in the source.
select
  matches (
    pg_catalog.pg_get_functiondef (
      'app.replay_execute(uuid[],jsonb,uuid,boolean)'::regprocedure
    ),
    'ledger_scratch\.recompute_row\s+\)\s+\+\s+\(\s+select\s+count\(\*\)\s+from\s+app\.stock_count_anchors',
    'the replay cap counts anchors together with replay rows'
  );

select
  *
from
  finish ();

rollback;
