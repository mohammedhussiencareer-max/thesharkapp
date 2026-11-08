-- Synthetic ledger. No POS data and no customer fields.
-- Items e5100000-…-0001 cents, 0002 covered sale, 0003 waste, 0004 uncovered,
-- 0005 reallocation, 0006 seed, 0007 missing basis, 0008 approved zero,
-- 0009 known average, 000a same-instant order, 000b count compensation,
-- 000c legacy silent zero, 000d cover order, 000e reclass,
-- 000f overflow, 0010 negative unit, 0011 sort shape.
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
    'owner-51a@theshark.test',
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
    'e5100000-0000-4000-8000-000000000001',
    'p51-cents',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000002',
    'p51-covered',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000003',
    'p51-waste',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000004',
    'p51-uncovered',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000005',
    'p51-realloc',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000006',
    'p51-seed',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000007',
    'p51-missing',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000008',
    'p51-zero',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000009',
    'p51-known',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-00000000000a',
    'p51-order',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-00000000000b',
    'p51-count',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-00000000000c',
    'p51-legacy',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-00000000000d',
    'p51-cover',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-00000000000e',
    'p51-reclass',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-00000000000f',
    'p51-overflow',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000010',
    'p51-neg-unit',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'e5100000-0000-4000-8000-000000000011',
    'p51-sort-shape',
    'seafood',
    'kg',
    'daily',
    0,
    null
  );

insert into
  app.pos_shifts (id, opened_at, is_active, pos_update_time)
values
  (
    'shift-p51',
    '2026-01-01T00:00:00Z',
    true,
    '2026-01-01T00:00:00Z'
  ),
  (
    'shift-p51-reclass',
    '2027-01-01T00:00:00Z',
    true,
    '2026-01-01T00:00:00Z'
  );

create function pg_temp.caught (p_sql text) returns text language plpgsql as $$
declare
  v_state text;
  v_message text;
  v_detail text;
begin
  execute p_sql;

  return 'no-error';
exception
  when others then
    get stacked diagnostics
      v_state = returned_sqlstate,
      v_message = message_text,
      v_detail = pg_exception_detail;

    return v_state || '|' || v_message || '|' || coalesce(v_detail, '');
end;
$$;

create function pg_temp.nets_zero (p_target bigint) returns boolean language sql as $$
  select
    coalesce(sum(sm.quantity), 0) = 0
    and coalesce(sum(sm.total_cost), 0) = 0
  from
    app.stock_movements sm
  where
    sm.id = p_target
    or sm.reverses_movement_id = p_target
    or (
      sm.movement_type = 'cost_adjustment'
      and sm.adjusts_movement_id in (
        select
          related.id
        from
          app.stock_movements related
        where
          related.id = p_target
          or related.reverses_movement_id = p_target
      )
    );
$$;

create function pg_temp.break_pair_and_rebuild (p_target bigint, p_item uuid) returns void language plpgsql as $$
begin
  insert into
    app.stock_movements (
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      adjusts_movement_id
    )
  select
    'e5100000-0000-4000-8000-0000000000bb',
    sm.item_id,
    'cost_adjustment',
    sm.occurred_at,
    0,
    0.01,
    0.01,
    sm.id
  from
    app.stock_movements sm
  where
    sm.id = p_target;

  perform app.rebuild_derived_balances (
    array[p_item],
    'e5100000-0000-4000-8000-0000000000bc'
  );
end;
$$;

-- Lock is not held yet. These must fail before any poster takes it.
select
  throws_ok (
    $$select app.retire_movements(array[1]::bigint[], 'e5100000-0000-4000-8000-0000000000c0')$$,
    '55000',
    'ledger lock is required',
    'retire_movements refuses a caller that does not hold the ledger lock'
  );

select
  throws_ok (
    $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000001',
      'movement_type', 'sale',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 1
    )))$$,
    '55000',
    'ledger lock is required',
    'post_engine_outflows refuses a caller that does not hold the ledger lock'
  );

select
  throws_ok (
    $$select app.replay_component(
      array['e5100000-0000-4000-8000-000000000001']::uuid[],
      '[]'::jsonb,
      'e5100000-0000-4000-8000-0000000000c0',
      false
    )$$,
    '55000',
    'ledger lock is required',
    'replay_component refuses a caller that does not hold the ledger lock'
  );

select
  pg_advisory_xact_lock(7342750000000000001);

select
  results_eq (
    $$select enumlabel
      from pg_catalog.pg_enum e
      join pg_catalog.pg_type t on t.oid = e.enumtypid
      join pg_catalog.pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'app'
        and t.typname = 'movement_type'
        and e.enumlabel in ('waste_reversal', 'count_compensation')
      order by e.enumlabel$$,
    $$values ('count_compensation'::name), ('waste_reversal'::name)$$,
    'waste_reversal and count_compensation are committed movement kinds'
  );

select
  results_eq (
    $$select
        app.profit_bucket('sale'),
        app.profit_bucket('sale_reversal'),
        app.profit_bucket('waste'),
        app.profit_bucket('waste_reversal'),
        app.profit_bucket('sort_loss'),
        app.profit_bucket('count_adjustment'),
        app.profit_bucket('count_compensation'),
        app.profit_bucket('sort_out'),
        app.profit_bucket('sort_in'),
        app.profit_bucket('opening'),
        app.profit_bucket('purchase'),
        app.profit_bucket('cost_adjustment')$$,
    $$values (
      'cogs', 'cogs', 'waste', 'waste', 'waste', 'count', 'count',
      'sort_transfer', 'sort_transfer', null::text, null::text, null::text
    )$$,
    'profit buckets keep the old kinds and land each new kind in its target bucket'
  );

-- Exact inverse cents: purchase 3 kg at 3.333333 stores 10.00. A sale of 1 kg
-- takes -3.33. A backdated purchase of 1 kg at 3.34 revises that sale to -3.34.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000001',
        'movement_type', 'purchase',
        'occurred_at', '2026-11-08T08:00:00Z',
        'quantity', 3,
        'unit_cost', 3.333333::numeric
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000001',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 1
      )
    ))$$,
    'cents fixture posts the purchase and the sale'
  );

select
  results_eq (
    $$select sm.movement_type::text, sm.total_cost
      from app.stock_movements sm
      where sm.item_id = 'e5100000-0000-4000-8000-000000000001'
        and sm.movement_type in ('purchase', 'sale')
      order by sm.occurred_at, sm.id$$,
    $$values ('purchase', 10.00::numeric(14, 2)), ('sale', -3.33::numeric(14, 2))$$,
    'the sale stores -3.33, not a fresh rounding of the 3.333333 unit'
  );

select
  lives_ok (
    $$select app.post_backdated_batch(
      'e5100000-0000-4000-8000-000000000c11',
      jsonb_build_array(jsonb_build_object(
        'line_key', 1,
        'batch_id', 'e5100000-0000-4000-8000-000000000c11',
        'item_id', 'e5100000-0000-4000-8000-000000000001',
        'movement_type', 'purchase',
        'occurred_at', '2026-11-08T09:00:00Z',
        'quantity', 1,
        'unit_cost', 3.34,
        'total_cost', 3.34,
        'is_input_total', true,
        'shift_id', null,
        'source_type', 'purchase',
        'source_id', 'p51-cents-backdated',
        'note', null
      ))
    )$$,
    'a cheaper-looking later purchase is posted between the first purchase and the sale'
  );

select
  is (
    (
      select
        coalesce(sum(ca.total_cost), 0)
      from
        app.stock_movements sale
        join app.stock_movements ca on ca.adjusts_movement_id = sale.id
        and ca.movement_type = 'cost_adjustment'
      where
        sale.item_id = 'e5100000-0000-4000-8000-000000000001'
        and sale.movement_type = 'sale'
    ),
    -0.01::numeric,
    'the backdated purchase adjusts the sale by exactly one piaster'
  );

select
  lives_ok (
    $$select app.retire_movements(
      array[(
        select id from app.stock_movements
        where item_id = 'e5100000-0000-4000-8000-000000000001'
          and movement_type = 'sale'
      )],
      'e5100000-0000-4000-8000-000000000c12'
    )$$,
    'retiring the adjusted sale appends its exact inverse'
  );

select
  is (
    (
      select
        rev.total_cost
      from
        app.stock_movements sale
        join app.stock_movements rev on rev.reverses_movement_id = sale.id
      where
        sale.item_id = 'e5100000-0000-4000-8000-000000000001'
        and sale.movement_type = 'sale'
    ),
    3.34::numeric(14, 2),
    'the reversal copies the effective -3.34, not the original -3.33'
  );

select
  ok (
    (
      select
        pg_temp.nets_zero (sale.id)
      from
        app.stock_movements sale
      where
        sale.item_id = 'e5100000-0000-4000-8000-000000000001'
        and sale.movement_type = 'sale'
    ),
    'after the cost adjustment, the sale and its reversal net to zero'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-000000000001'
    ),
    5::bigint,
    'the confirming replay of a just-reversed sale inserts no further row'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000001',
      'movement_type', 'purchase',
      'occurred_at', '2026-11-08T12:00:00Z',
      'quantity', 10,
      'unit_cost', 1
    )))$$,
    'a later cheaper purchase lands after the reversed sale'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-000000000001']::uuid[],
      'e5100000-0000-4000-8000-000000000c13'
    )$$,
    'replaying after the cheaper purchase succeeds'
  );

select
  ok (
    (
      select
        pg_temp.nets_zero (sale.id)
        and (
          select
            count(*)
          from
            app.stock_movements ca
          where
            ca.adjusts_movement_id = sale.id
            and ca.movement_type = 'cost_adjustment'
        ) = 1
      from
        app.stock_movements sale
      where
        sale.item_id = 'e5100000-0000-4000-8000-000000000001'
        and sale.movement_type = 'sale'
    ),
    'the retired pair still nets to zero and receives no later valuation change'
  );

-- Covered sale, shift attribution, one cogs revision, second reversal refused.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000002',
        'movement_type', 'purchase',
        'occurred_at', '2026-11-08T08:00:00Z',
        'quantity', 10,
        'unit_cost', 100
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000002',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 4
      )
    ))$$,
    'covered sale fixture posts'
  );

select
  lives_ok (
    $$select app.retire_movements(
      array[(
        select id from app.stock_movements
        where item_id = 'e5100000-0000-4000-8000-000000000002'
          and movement_type = 'sale'
      )],
      'e5100000-0000-4000-8000-000000000c21'
    )$$,
    'the covered sale is reversed'
  );

select
  results_eq (
    $$select
        sale.quantity,
        rev.quantity,
        sale.total_cost,
        rev.total_cost,
        sale.item_id = rev.item_id,
        sale.occurred_at = rev.occurred_at,
        sale.shift_id is not distinct from rev.shift_id,
        rev.movement_type::text
      from app.stock_movements sale
      join app.stock_movements rev on rev.reverses_movement_id = sale.id
      where sale.item_id = 'e5100000-0000-4000-8000-000000000002'
        and sale.movement_type = 'sale'$$,
    $$values (
      -4::numeric(20, 6),
      4::numeric(20, 6),
      -400::numeric(14, 2),
      400::numeric(14, 2),
      true,
      true,
      true,
      'sale_reversal'
    )$$,
    'a covered sale reversal copies item, instant, and shift and inverts quantity and value'
  );

select
  results_eq (
    $$select ma.shift_id
      from app.movement_attributions ma
      join app.stock_movements sm on sm.id = ma.movement_id
      where sm.item_id = 'e5100000-0000-4000-8000-000000000002'
        and sm.movement_type in ('sale', 'sale_reversal')
      order by sm.movement_type::text$$,
    $$values ('shift-p51'), ('shift-p51')$$,
    'the reversal keeps the shift attribution pinned on the target'
  );

select
  results_eq (
    $$select pr.bucket, pr.amount, pr.shift_id, count(*) over ()
      from app.period_revisions pr
      where pr.item_id = 'e5100000-0000-4000-8000-000000000002'$$,
    $$values ('cogs', 400::numeric(14, 2), 'shift-p51', 1::bigint)$$,
    'the sale reversal is noted once in the cogs bucket'
  );

select
  throws_ok (
    $$select app.retire_movements(
      array[(
        select id from app.stock_movements
        where item_id = 'e5100000-0000-4000-8000-000000000002'
          and movement_type = 'sale'
      )],
      'e5100000-0000-4000-8000-000000000c22'
    )$$,
    '22023',
    'movement is already reversed',
    'a second reversal of the same target is refused'
  );

select
  throws_ok (
    $$insert into app.stock_movements (
      batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, reverses_movement_id
    )
    select
      'e5100000-0000-4000-8000-0000000000aa',
      sale.item_id,
      'sale_reversal',
      sale.occurred_at,
      -sale.quantity,
      sale.unit_cost,
      -(sale.total_cost + coalesce((
        select sum(ca.total_cost)
        from app.stock_movements ca
        where ca.adjusts_movement_id = sale.id
          and ca.movement_type = 'cost_adjustment'
      ), 0)),
      sale.id
    from app.stock_movements sale
    where sale.item_id = 'e5100000-0000-4000-8000-000000000002'
      and sale.movement_type = 'sale'$$,
    '23505',
    'duplicate key value violates unique constraint "stock_movements_one_reversal_idx"',
    'the unique index also refuses a second reversal'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-000000000002'
    ),
    3::bigint,
    'covered sale has purchase, sale, and one reversal'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-000000000002']::uuid[],
      'e5100000-0000-4000-8000-000000000c23'
    )$$,
    'replaying the covered sale inserts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.period_revisions pr
      where
        pr.item_id = 'e5100000-0000-4000-8000-000000000002'
    ),
    1::bigint,
    'replay does not note the sale reversal a second time'
  );

select
  is (
    pg_temp.caught (
      format(
        'select pg_temp.break_pair_and_rebuild(%s, %L::uuid)',
        (
          select
            id
          from
            app.stock_movements
          where
            item_id = 'e5100000-0000-4000-8000-000000000002'
            and movement_type = 'sale'
        ),
        'e5100000-0000-4000-8000-000000000002'
      )
    ),
    '22023|recompute result is out of range|critical',
    'a pair that no longer nets to zero is a ledger invariant failure'
  );

select
  ok (
    (
      select
        pg_temp.nets_zero (id)
      from
        app.stock_movements
      where
        item_id = 'e5100000-0000-4000-8000-000000000002'
        and movement_type = 'sale'
    ),
    'the invariant probe rolls back and leaves the pair at zero'
  );

-- Waste reversal lands in the waste bucket once.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000003',
        'movement_type', 'purchase',
        'occurred_at', '2026-11-08T08:00:00Z',
        'quantity', 10,
        'unit_cost', 100
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000003',
        'movement_type', 'waste',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 2,
        'shift_id', 'shift-p51'
      )
    ))$$,
    'waste fixture posts'
  );

select
  lives_ok (
    $$select app.retire_movements(
      array[(
        select id from app.stock_movements
        where item_id = 'e5100000-0000-4000-8000-000000000003'
          and movement_type = 'waste'
      )],
      'e5100000-0000-4000-8000-000000000c31'
    )$$,
    'the waste movement is reversed'
  );

select
  results_eq (
    $$select rev.shift_id, rev.total_cost, pr.bucket, pr.amount
      from app.stock_movements waste
      join app.stock_movements rev on rev.reverses_movement_id = waste.id
      join app.period_revisions pr on pr.source_movement_id = rev.id
      where waste.item_id = 'e5100000-0000-4000-8000-000000000003'
        and waste.movement_type = 'waste'$$,
    $$values ('shift-p51', 200::numeric(14, 2), 'waste', 200::numeric(14, 2))$$,
    'waste_reversal keeps the target shift and is noted once in the waste bucket'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-000000000003']::uuid[],
      'e5100000-0000-4000-8000-000000000c32'
    )$$,
    'replaying the reversed waste inserts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.period_revisions pr
      where
        pr.item_id = 'e5100000-0000-4000-8000-000000000003'
    ),
    1::bigint,
    'replay does not note the waste reversal a second time'
  );

-- Two uncovered legacy sales. Reversing the first must not cover the second.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000004',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 2
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000004',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T11:00:00Z',
        'quantity', 3
      )
    ))$$,
    'two uncovered provisional sales post at the legacy zero'
  );

select
  lives_ok (
    $$select app.retire_movements(
      array[(
        select id from app.stock_movements
        where item_id = 'e5100000-0000-4000-8000-000000000004'
          and movement_type = 'sale'
          and quantity = -2
      )],
      'e5100000-0000-4000-8000-000000000c41'
    )$$,
    'the first uncovered sale is reversed'
  );

select
  results_eq (
    $$select
        ib.on_hand_qty,
        ib.on_hand_value,
        (
          select pd.qty_uncovered
          from app.provisional_deficits pd
          join app.stock_movements sm on sm.id = pd.movement_id
          where sm.item_id = ib.item_id
            and sm.quantity = -3
        ),
        (
          select count(*)
          from app.provisional_deficits pd
          join app.stock_movements sm on sm.id = pd.movement_id
          where sm.item_id = ib.item_id
            and (
              sm.quantity = -2
              or sm.movement_type = 'sale_reversal'
            )
        )
      from app.item_balances ib
      where ib.item_id = 'e5100000-0000-4000-8000-000000000004'$$,
    $$values (
      -3::numeric(20, 6),
      0::numeric(14, 2),
      3::numeric(20, 6),
      0::bigint
    )$$,
    'a reversal does not cover the other sale and is not itself a deficit'
  );

-- Covered piece plus uncovered piece, then a later purchase. Retiring the
-- split sale reallocates that cover onto the surviving sale.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000005',
        'movement_type', 'purchase',
        'occurred_at', '2026-11-08T08:00:00Z',
        'quantity', 4,
        'unit_cost', 100
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000005',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T09:00:00Z',
        'quantity', 6
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000005',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 2
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000005',
        'movement_type', 'purchase',
        'occurred_at', '2026-11-08T11:00:00Z',
        'quantity', 3,
        'unit_cost', 50
      )
    ))$$,
    'reallocation fixture posts both sales and the later purchase'
  );

select
  is (
    (
      select
        pd.qty_uncovered
      from
        app.provisional_deficits pd
        join app.stock_movements sm on sm.id = pd.movement_id
      where
        sm.item_id = 'e5100000-0000-4000-8000-000000000005'
        and sm.occurred_at = '2026-11-08T10:00:00Z'
    ),
    1::numeric,
    'before retirement the later sale is only partly covered'
  );

select
  lives_ok (
    $$select app.retire_movements(
      array(
        select sm.id
        from app.stock_movements sm
        where sm.item_id = 'e5100000-0000-4000-8000-000000000005'
          and sm.movement_type = 'sale'
          and sm.occurred_at = '2026-11-08T09:00:00Z'
        order by sm.id
      ),
      'e5100000-0000-4000-8000-000000000c51'
    )$$,
    'both pieces of the split sale are reversed together'
  );

select
  ok (
    (
      select
        bool_and(pg_temp.nets_zero (sm.id))
        and count(*) = 2
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-000000000005'
        and sm.movement_type = 'sale'
        and sm.occurred_at = '2026-11-08T09:00:00Z'
    ),
    'the covered piece and the uncovered piece each net to zero'
  );

select
  results_eq (
    $$select
        ib.on_hand_qty,
        ib.on_hand_value,
        (
          select count(*)
          from app.provisional_deficits pd
          where pd.item_id = ib.item_id
            and pd.qty_uncovered > 0
        ),
        (
          select sm.total_cost + coalesce(sum(ca.total_cost), 0)
          from app.stock_movements sm
          left join app.stock_movements ca
            on ca.adjusts_movement_id = sm.id
            and ca.movement_type = 'cost_adjustment'
          where sm.item_id = ib.item_id
            and sm.movement_type = 'sale'
            and sm.occurred_at = '2026-11-08T10:00:00Z'
          group by sm.id, sm.total_cost
        )
      from app.item_balances ib
      where ib.item_id = 'e5100000-0000-4000-8000-000000000005'$$,
    $$values (
      5::numeric(20, 6),
      350::numeric(14, 2),
      0::bigint,
      -200::numeric
    )$$,
    'after retirement the later sale is fully covered and the book is the surviving stock'
  );

-- Wrong kind, cross item, reversal target, cost adjustment, and a non-reversal link.
select
  throws_ok (
    $$select app.retire_movements(
      array[(
        select id from app.stock_movements
        where item_id = 'e5100000-0000-4000-8000-000000000002'
          and movement_type = 'purchase'
        order by occurred_at, id
        limit 1
      )],
      'e5100000-0000-4000-8000-000000000c24'
    )$$,
    '22023',
    'only a sale or waste movement can be reversed',
    'a purchase cannot be reversed through the poster'
  );

select
  throws_ok (
    $$insert into app.stock_movements (
      batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, reverses_movement_id
    )
    select
      'e5100000-0000-4000-8000-0000000000ab',
      waste.item_id,
      'sale_reversal',
      waste.occurred_at,
      -waste.quantity,
      waste.unit_cost,
      -waste.total_cost,
      waste.id
    from app.stock_movements waste
    where waste.item_id = 'e5100000-0000-4000-8000-000000000003'
      and waste.movement_type = 'waste'$$,
    '22023',
    'reversal target kind is not allowed',
    'sale_reversal cannot target waste'
  );

select
  throws_ok (
    $$insert into app.stock_movements (
      batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, reverses_movement_id
    )
    select
      'e5100000-0000-4000-8000-0000000000ac',
      'e5100000-0000-4000-8000-000000000003',
      'sale_reversal',
      sale.occurred_at,
      -sale.quantity,
      sale.unit_cost,
      -sale.total_cost,
      sale.id
    from app.stock_movements sale
    where sale.item_id = 'e5100000-0000-4000-8000-000000000002'
      and sale.movement_type = 'sale'$$,
    '22023',
    'reversal item must match the target',
    'a reversal cannot point at another item'
  );

select
  throws_ok (
    $$insert into app.stock_movements (
      batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, reverses_movement_id
    )
    select
      'e5100000-0000-4000-8000-0000000000ad',
      rev.item_id,
      'sale_reversal',
      rev.occurred_at,
      -1,
      1,
      1,
      rev.id
    from app.stock_movements rev
    where rev.item_id = 'e5100000-0000-4000-8000-000000000002'
      and rev.movement_type = 'sale_reversal'$$,
    '22023',
    'a reversal cannot target a reversal',
    'a reversal cannot target a reversal'
  );

select
  throws_ok (
    $$insert into app.stock_movements (
      batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, reverses_movement_id
    )
    select
      'e5100000-0000-4000-8000-0000000000ae',
      ca.item_id,
      'sale_reversal',
      ca.occurred_at,
      1,
      1,
      0.01,
      ca.id
    from app.stock_movements ca
    where ca.item_id = 'e5100000-0000-4000-8000-000000000001'
      and ca.movement_type = 'cost_adjustment'
    limit 1$$,
    '22023',
    'a reversal cannot target a cost adjustment',
    'a reversal cannot target a cost adjustment'
  );

select
  throws_ok (
    $$insert into app.stock_movements (
      batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, reverses_movement_id
    )
    select
      'e5100000-0000-4000-8000-0000000000af',
      purchase.item_id,
      'sale',
      purchase.occurred_at,
      -1,
      1,
      -1,
      purchase.id
    from app.stock_movements purchase
    where purchase.item_id = 'e5100000-0000-4000-8000-000000000002'
      and purchase.movement_type = 'purchase'
    order by purchase.id
    limit 1$$,
    '22023',
    'reversal link does not match the movement kind',
    'a non-reversal row cannot carry reverses_movement_id'
  );

-- Seed captured once, then reused after the opening price changes.
select
  lives_ok (
    $$select app.set_item_opening_price(
      'e5100000-0000-4000-8000-000000000061',
      'e5100000-0000-4000-8000-000000000006',
      40,
      null,
      null,
      'kg|seafood||'
    )$$,
    'seed item gets an approved opening price of 40'
  );

select
  lives_ok (
    $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000006',
      'movement_type', 'sale',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 2
    )))$$,
    'the first engine shortage captures the seed'
  );

select
  results_eq (
    $$select seed.unit_cost, seed.opening_price_id, sm.quantity, sm.unit_cost, sm.total_cost
      from app.item_provisional_seeds seed
      join app.stock_movements sm on sm.item_id = seed.item_id
      where seed.item_id = 'e5100000-0000-4000-8000-000000000006'
        and sm.movement_type = 'sale'$$,
    $$values (
      40::numeric(20, 6),
      (
        select id from app.item_opening_prices
        where item_id = 'e5100000-0000-4000-8000-000000000006'
          and superseded_change_id is null
      ),
      -2::numeric(20, 6),
      40::numeric(20, 6),
      -80::numeric(14, 2)
    )$$,
    'the first shortage stores the approved price of 40'
  );

select
  lives_ok (
    format(
      $$select app.set_item_opening_price(
        'e5100000-0000-4000-8000-000000000062',
        'e5100000-0000-4000-8000-000000000006',
        90,
        null,
        %L::uuid,
        'kg|seafood||'
      )$$,
      (
        select
          id
        from
          app.item_opening_prices
        where
          item_id = 'e5100000-0000-4000-8000-000000000006'
          and superseded_change_id is null
      )
    ),
    'the opening price later becomes 90'
  );

select
  lives_ok (
    $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000006',
      'movement_type', 'sale',
      'occurred_at', '2026-11-08T11:00:00Z',
      'quantity', 3
    )))$$,
    'a later shortage still uses the saved seed'
  );

select
  results_eq (
    $$select
        (select count(*) from app.item_provisional_seeds where item_id = 'e5100000-0000-4000-8000-000000000006'),
        (select unit_cost from app.item_provisional_seeds where item_id = 'e5100000-0000-4000-8000-000000000006'),
        (select opening_price_id from app.item_provisional_seeds where item_id = 'e5100000-0000-4000-8000-000000000006'),
        (select total_cost from app.stock_movements where item_id = 'e5100000-0000-4000-8000-000000000006' and quantity = -2),
        (select unit_cost from app.stock_movements where item_id = 'e5100000-0000-4000-8000-000000000006' and quantity = -3),
        (select total_cost from app.stock_movements where item_id = 'e5100000-0000-4000-8000-000000000006' and quantity = -3),
        (select count(*) from app.stock_movements where item_id = 'e5100000-0000-4000-8000-000000000006' and movement_type = 'cost_adjustment')$$,
    $$values (
      1::bigint,
      40::numeric(20, 6),
      (
        select id from app.item_opening_prices
        where item_id = 'e5100000-0000-4000-8000-000000000006'
          and superseded_change_id is not null
      ),
      -80::numeric(14, 2),
      40::numeric(20, 6),
      -120::numeric(14, 2),
      0::bigint
    )$$,
    'the seed is captured once and ignores the later opening price'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-000000000006'
    ),
    2::bigint,
    'the seed item has two sales before the confirming rebuild'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-000000000006']::uuid[],
      'e5100000-0000-4000-8000-000000000c61'
    )$$,
    'replaying the seeded sales succeeds'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-000000000006'
    ),
    2::bigint,
    'forward post then replay inserts no adjustment on a seeded sale'
  );

-- No ledger average and no opening price.
select
  is (
    pg_temp.caught (
      $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-000000000007',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 1
      )))$$
    ),
    'P0001|missing_cost_basis|missing_cost_basis',
    'an engine shortage with no cost basis raises missing_cost_basis'
  );

select
  is_empty (
    $$select id from app.stock_movements where item_id = 'e5100000-0000-4000-8000-000000000007'$$,
    'missing_cost_basis stores no movement'
  );

select
  is_empty (
    $$select item_id from app.item_provisional_seeds where item_id = 'e5100000-0000-4000-8000-000000000007'$$,
    'missing_cost_basis stores no seed'
  );

-- An explicit zero opening is a known average and beats the opening price.
select
  lives_ok (
    $$select app.set_item_opening_price(
      'e5100000-0000-4000-8000-000000000081',
      'e5100000-0000-4000-8000-000000000008',
      40,
      null,
      null,
      'kg|seafood||'
    )$$,
    'the zero-average item also has an opening price of 40'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000008',
      'movement_type', 'opening',
      'occurred_at', '2026-11-08T08:00:00Z',
      'quantity', 5,
      'unit_cost', 0
    )))$$,
    'an opening movement at unit cost 0 establishes a known zero'
  );

select
  lives_ok (
    $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000008',
      'movement_type', 'sale',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 7
    )))$$,
    'the engine sale uses the known zero average'
  );

select
  results_eq (
    $$select sm.quantity, sm.unit_cost, sm.total_cost, sm.is_provisional
      from app.stock_movements sm
      where sm.item_id = 'e5100000-0000-4000-8000-000000000008'
        and sm.movement_type = 'sale'
      order by sm.piece_position, sm.id$$,
    $$values
      (-5::numeric(20, 6), 0::numeric(20, 6), 0::numeric(14, 2), false),
      (-2::numeric(20, 6), 0::numeric(20, 6), 0::numeric(14, 2), true)$$,
    'a known zero average prices both the covered and the provisional piece'
  );

select
  is_empty (
    $$select item_id from app.item_provisional_seeds where item_id = 'e5100000-0000-4000-8000-000000000008'$$,
    'a known zero average does not capture the opening price'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-000000000008'
        and sm.movement_type = 'cost_adjustment'
    ),
    0::bigint,
    'the known-zero engine sale needs no adjustment'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-000000000008']::uuid[],
      'e5100000-0000-4000-8000-000000000c81'
    )$$,
    'replaying the known-zero sale succeeds'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-000000000008'
        and sm.movement_type = 'cost_adjustment'
    ),
    0::bigint,
    'forward post then replay inserts nothing after a known zero'
  );

-- A purchase average beats today's opening price.
select
  lives_ok (
    $$select app.set_item_opening_price(
      'e5100000-0000-4000-8000-000000000091',
      'e5100000-0000-4000-8000-000000000009',
      40,
      null,
      null,
      'kg|seafood||'
    )$$,
    'the known-average item has an opening price of 40'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000009',
      'movement_type', 'purchase',
      'occurred_at', '2026-11-08T08:00:00Z',
      'quantity', 5,
      'unit_cost', 100
    )))$$,
    'a purchase establishes the average at 100'
  );

select
  lives_ok (
    $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000009',
      'movement_type', 'sale',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 8
    )))$$,
    'the engine shortage uses the ledger average'
  );

select
  results_eq (
    $$select sm.quantity, sm.unit_cost, sm.total_cost, sm.is_provisional
      from app.stock_movements sm
      where sm.item_id = 'e5100000-0000-4000-8000-000000000009'
        and sm.movement_type = 'sale'
      order by sm.is_provisional, sm.id$$,
    $$values
      (-5::numeric(20, 6), 100::numeric(20, 6), -500::numeric(14, 2), false),
      (-3::numeric(20, 6), 100::numeric(20, 6), -300::numeric(14, 2), true)$$,
    'the provisional piece uses the purchase average, not the opening price'
  );

select
  is_empty (
    $$select item_id from app.item_provisional_seeds where item_id = 'e5100000-0000-4000-8000-000000000009'$$,
    'a known ledger average does not capture a seed'
  );

-- Same instant: the later array element has the lower event position and the
-- higher id. Replay must value the lower position first.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-00000000000a',
      'movement_type', 'purchase',
      'occurred_at', '2026-11-08T08:00:00Z',
      'quantity', 10,
      'unit_cost', 100
    )))$$,
    'ordering fixture purchases 10 kg'
  );

select
  lives_ok (
    $$select app.post_engine_outflows(jsonb_build_array(
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-00000000000a',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T12:00:00Z',
        'quantity', 8,
        'event_position', 20
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-00000000000a',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T12:00:00Z',
        'quantity', 8,
        'event_position', 10
      )
    ))$$,
    'two same-instant sales are posted in the opposite id order'
  );

select
  results_eq (
    $$select sm.event_position, sm.piece_position, sm.quantity, sm.total_cost, sm.is_provisional
      from app.stock_movements sm
      where sm.item_id = 'e5100000-0000-4000-8000-00000000000a'
        and sm.movement_type = 'sale'
      order by sm.event_position, sm.piece_position, sm.id$$,
    $$values
      (10::bigint, 1, -8::numeric(20, 6), -800::numeric(14, 2), false),
      (20::bigint, 1, -2::numeric(20, 6), -200::numeric(14, 2), false),
      (20::bigint, 2, -6::numeric(20, 6), -600::numeric(14, 2), true)$$,
    'same-instant sales are valued by event position, not by id'
  );

select
  ok (
    (
      select
        max(sm.id) filter (
          where
            sm.event_position = 10
        ) > max(sm.id) filter (
          where
            sm.event_position = 20
        )
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-00000000000a'
        and sm.movement_type = 'sale'
    ),
    'the fully covered sale has the higher id'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-00000000000a'
        and sm.movement_type = 'cost_adjustment'
    ),
    0::bigint,
    'the same-instant post agrees with its own replay'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-00000000000a']::uuid[],
      'e5100000-0000-4000-8000-000000000ca1'
    )$$,
    'replaying the same-instant sales succeeds'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-00000000000a'
        and sm.movement_type = 'cost_adjustment'
    ),
    0::bigint,
    'forward post then replay inserts nothing for the same-instant sales'
  );

-- count_compensation is an ordinary signed movement in this replay. Its
-- revision is noted once by the generic adjustment loop.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-00000000000b',
      'movement_type', 'purchase',
      'occurred_at', '2026-11-08T08:00:00Z',
      'quantity', 10,
      'unit_cost', 100
    )))$$,
    'count fixture purchases 10 kg'
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
    'e5100000-0000-4000-8000-0000000000cc',
    'e5100000-0000-4000-8000-00000000000b',
    'count_compensation',
    '2026-11-08T15:00:00Z',
    -1,
    1,
    -1
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-00000000000b']::uuid[],
      'e5100000-0000-4000-8000-000000000cb1'
    )$$,
    'replaying a count compensation values it from the ledger average'
  );

select
  results_eq (
    $$select ca.total_cost, pr.bucket, pr.amount
      from app.stock_movements comp
      join app.stock_movements ca on ca.adjusts_movement_id = comp.id
      join app.period_revisions pr on pr.source_movement_id = ca.id
      where comp.item_id = 'e5100000-0000-4000-8000-00000000000b'
        and comp.movement_type = 'count_compensation'$$,
    $$values (-99::numeric(14, 2), 'count', -99::numeric(14, 2))$$,
    'count_compensation is revised once into the count bucket'
  );

select
  is (
    (
      select
        count(*)
      from
        app.period_revisions pr
      where
        pr.item_id = 'e5100000-0000-4000-8000-00000000000b'
    ),
    1::bigint,
    'the count compensation revision is not noted twice'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-00000000000b']::uuid[],
      'e5100000-0000-4000-8000-000000000cb2'
    )$$,
    'a second replay of the count compensation inserts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-00000000000b'
        and sm.movement_type = 'cost_adjustment'
    ),
    1::bigint,
    'the second count replay does not add another adjustment'
  );

-- Public post_movements keeps the silent zero even when an opening price exists.
select
  lives_ok (
    $$select app.set_item_opening_price(
      'e5100000-0000-4000-8000-0000000000c1',
      'e5100000-0000-4000-8000-00000000000c',
      25,
      null,
      null,
      'kg|seafood||'
    )$$,
    'the legacy item has an opening price'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-00000000000c',
      'movement_type', 'sale',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 1
    )))$$,
    'public post_movements still posts a legacy provisional sale'
  );

select
  results_eq (
    $$select sm.total_cost, sm.unit_cost, sm.is_provisional, sm.engine_valued
      from app.stock_movements sm
      where sm.item_id = 'e5100000-0000-4000-8000-00000000000c'
        and sm.movement_type = 'sale'$$,
    $$values (0::numeric(14, 2), 0::numeric(20, 6), true, null::boolean)$$,
    'the public poster leaves engine_valued null and the legacy zero in place'
  );

select
  is_empty (
    $$select item_id from app.item_provisional_seeds where item_id = 'e5100000-0000-4000-8000-00000000000c'$$,
    'the public poster does not capture a seed'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-00000000000c']::uuid[],
      'e5100000-0000-4000-8000-000000000cc1'
    )$$,
    'replaying a legacy provisional sale succeeds'
  );

select
  is_empty (
    $$select item_id from app.item_provisional_seeds where item_id = 'e5100000-0000-4000-8000-00000000000c'$$,
    'replay of a legacy row still does not capture a seed'
  );

select
  is (
    (
      select
        sm.total_cost
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-00000000000c'
        and sm.movement_type = 'sale'
    ),
    0::numeric(14, 2),
    'replay of a legacy row does not reprice the silent zero'
  );

select
  throws_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000001',
      'movement_type', 'sale_reversal',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 1
    )))$$,
    '22023',
    'disallowed movement_type in post_movements: sale_reversal',
    'post_movements rejects sale_reversal'
  );

select
  throws_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000001',
      'movement_type', 'waste_reversal',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 1
    )))$$,
    '22023',
    'disallowed movement_type in post_movements: waste_reversal',
    'post_movements rejects waste_reversal'
  );

select
  throws_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-000000000001',
      'movement_type', 'count_compensation',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 1
    )))$$,
    '22023',
    'disallowed movement_type in post_movements: count_compensation',
    'post_movements rejects count_compensation'
  );

-- Two same-instant seed shortages. The earlier event_position is inserted
-- second, so it has the newer id. A later purchase of 1 must cover that one.
select
  lives_ok (
    $$select app.set_item_opening_price(
      'e5100000-0000-4000-8000-0000000000d1',
      'e5100000-0000-4000-8000-00000000000d',
      40,
      null,
      null,
      'kg|seafood||'
    )$$,
    'cover-order item gets an opening price of 40'
  );

select
  lives_ok (
    $$select app.post_engine_outflows(jsonb_build_array(
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-00000000000d',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 1,
        'event_position', 20
      ),
      jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-00000000000d',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 1,
        'event_position', 10
      )
    ))$$,
    'two same-instant shortages are posted with the earlier position on the newer id'
  );

select
  ok (
    (
      select
        max(sm.id) filter (
          where
            sm.event_position = 10
        ) > max(sm.id) filter (
          where
            sm.event_position = 20
        )
      from
        app.stock_movements sm
      where
        sm.item_id = 'e5100000-0000-4000-8000-00000000000d'
        and sm.movement_type = 'sale'
    ),
    'the earlier shortage has the newer id'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-00000000000d',
      'movement_type', 'purchase',
      'occurred_at', '2026-11-08T12:00:00Z',
      'quantity', 1,
      'unit_cost', 100
    )))$$,
    'one purchased unit covers the first logical shortage'
  );

select
  results_eq (
    $$select sm.event_position, ca.total_cost
      from app.stock_movements ca
      join app.stock_movements sm on sm.id = ca.adjusts_movement_id
      where ca.item_id = 'e5100000-0000-4000-8000-00000000000d'
        and ca.movement_type = 'cost_adjustment'$$,
    $$values (10::bigint, -60::numeric(14, 2))$$,
    'the forward purchase covers event 10, the newer id, at seed 40'
  );

select
  is (
    (
      select
        pd.qty_uncovered
      from
        app.provisional_deficits pd
        join app.stock_movements sm on sm.id = pd.movement_id
      where
        sm.item_id = 'e5100000-0000-4000-8000-00000000000d'
        and sm.event_position = 20
    ),
    1::numeric,
    'the later event stays uncovered'
  );

select
  lives_ok (
    $$select app.rebuild_derived_balances(
      array['e5100000-0000-4000-8000-00000000000d']::uuid[],
      'e5100000-0000-4000-8000-0000000000d2'
    )$$,
    'replaying the two shortages keeps the same cover'
  );

select
  results_eq (
    $$select sm.event_position, ca.total_cost
      from app.stock_movements ca
      join app.stock_movements sm on sm.id = ca.adjusts_movement_id
      where ca.item_id = 'e5100000-0000-4000-8000-00000000000d'
        and ca.movement_type = 'cost_adjustment'$$,
    $$values (10::bigint, -60::numeric(14, 2))$$,
    'replay covers the same earlier event and does not move the adjustment'
  );

-- Retire a -100 sale and repost it as -100 waste. Stock and profit_delta stay
-- where the sale left them; the new cogs and waste revisions are opposite.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-00000000000e',
      'movement_type', 'purchase',
      'occurred_at', '2026-11-08T08:00:00Z',
      'quantity', 1,
      'unit_cost', 100
    )))$$,
    'reclass item purchases 1 kg at 100'
  );

select
  lives_ok (
    $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-00000000000e',
      'movement_type', 'sale',
      'occurred_at', '2026-11-08T10:00:00Z',
      'quantity', 1,
      'shift_id', 'shift-p51-reclass'
    )))$$,
    'the engine sale is posted and noted'
  );

select
  results_eq (
    $$select
        ib.on_hand_qty,
        ib.on_hand_value,
        pr.bucket,
        pr.amount,
        (
          select f.profit_delta
          from app.shift_report_flags f
          where f.shift_id = 'shift-p51-reclass'
        ),
        (
          select count(*)
          from app.period_revisions noted
          where noted.source_movement_id = sale.id
        )
      from app.item_balances ib
      join app.stock_movements sale
        on sale.item_id = ib.item_id
        and sale.movement_type = 'sale'
      join app.period_revisions pr on pr.source_movement_id = sale.id
      where ib.item_id = 'e5100000-0000-4000-8000-00000000000e'$$,
    $$values (
      0::numeric(20, 6),
      0::numeric(14, 2),
      'cogs',
      -100::numeric(14, 2),
      -100::numeric(14, 2),
      1::bigint
    )$$,
    'the engine sale is noted once in cogs and clears the stock'
  );

select
  lives_ok (
    $$select app.retire_movements(
      array[(
        select id from app.stock_movements
        where item_id = 'e5100000-0000-4000-8000-00000000000e'
          and movement_type = 'sale'
      )],
      'e5100000-0000-4000-8000-0000000000e1'
    )$$,
    'the sale is retired'
  );

select
  lives_ok (
    $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
      'item_id', 'e5100000-0000-4000-8000-00000000000e',
      'movement_type', 'waste',
      'occurred_at', '2026-11-08T11:00:00Z',
      'quantity', 1,
      'shift_id', 'shift-p51-reclass'
    )))$$,
    'the same quantity is reposted as waste'
  );

select
  results_eq (
    $$select
        ib.on_hand_qty,
        ib.on_hand_value,
        (
          select coalesce(sum(pr.amount), 0)
          from app.period_revisions pr
          where pr.item_id = ib.item_id
            and pr.bucket = 'cogs'
        ),
        (
          select coalesce(sum(pr.amount), 0)
          from app.period_revisions pr
          where pr.item_id = ib.item_id
            and pr.bucket = 'waste'
        ),
        (
          select f.profit_delta
          from app.shift_report_flags f
          where f.shift_id = 'shift-p51-reclass'
        ),
        (
          select count(*)
          from app.stock_movements sm
          where sm.item_id = ib.item_id
            and sm.movement_type = 'cost_adjustment'
        )
      from app.item_balances ib
      where ib.item_id = 'e5100000-0000-4000-8000-00000000000e'$$,
    $$values (
      0::numeric(20, 6),
      0::numeric(14, 2),
      0::numeric,
      -100::numeric,
      -100::numeric(14, 2),
      0::bigint
    )$$,
    'reclass leaves stock and profit_delta unchanged, with cogs and waste opposite'
  );

select
  results_eq (
    $$select pr.bucket, pr.amount
      from app.period_revisions pr
      join app.stock_movements sm on sm.id = pr.source_movement_id
      where pr.item_id = 'e5100000-0000-4000-8000-00000000000e'
        and sm.movement_type in ('sale_reversal', 'waste')
      order by sm.movement_type::text$$,
    $$values ('cogs', 100::numeric(14, 2)), ('waste', -100::numeric(14, 2))$$,
    'retirement adds 100 cogs and the waste repost adds -100 waste'
  );

-- Real replay failures, not the helper in isolation.
select
  lives_ok (
    $$select app.set_item_opening_price(
      'e5100000-0000-4000-8000-0000000000f0',
      'e5100000-0000-4000-8000-00000000000f',
      1000000,
      null,
      null,
      'kg|seafood||'
    )$$,
    'overflow item gets an opening price of 1000000'
  );

select
  is (
    pg_temp.caught (
      $$select app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
        'item_id', 'e5100000-0000-4000-8000-00000000000f',
        'movement_type', 'sale',
        'occurred_at', '2026-11-08T10:00:00Z',
        'quantity', 1000000
      )))$$
    ),
    '22023|recompute result is out of range|critical',
    'a shortage whose seed value overflows numeric(14,2) is detail critical'
  );

select
  is_empty (
    $$select sm.id::text from app.stock_movements sm
      where sm.item_id = 'e5100000-0000-4000-8000-00000000000f'
      union all
      select seed.item_id::text from app.item_provisional_seeds seed
      where seed.item_id = 'e5100000-0000-4000-8000-00000000000f'$$,
    'the overflow rolls back the movement and the seed'
  );

select
  is (
    pg_temp.caught (
      $$insert into app.stock_movements (
          batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost
        ) values (
          'e5100000-0000-4000-8000-000000000101',
          'e5100000-0000-4000-8000-000000000010',
          'purchase',
          '2026-11-08T08:00:00Z',
          1, -1, -1
        );
        select app.rebuild_derived_balances(
          array['e5100000-0000-4000-8000-000000000010']::uuid[],
          'e5100000-0000-4000-8000-000000000102'
        )$$
    ),
    '22023|recompute result is out of range|critical',
    'replaying a negative unit cost is detail critical'
  );

select
  is (
    pg_temp.caught (
      $$insert into app.stock_movements (
          batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost
        ) values (
          'e5100000-0000-4000-8000-000000000111',
          'e5100000-0000-4000-8000-000000000011',
          'sort_in',
          '2026-11-08T08:00:00Z',
          1, 1, 1
        );
        select app.rebuild_derived_balances(
          array['e5100000-0000-4000-8000-000000000011']::uuid[],
          'e5100000-0000-4000-8000-000000000112'
        )$$
    ),
    '22023|recompute result is out of range|critical',
    'a sort batch without its sort_out is detail critical'
  );

select
  is (
    pg_temp.caught (
      $$select app.replay_component(
        array['e5100000-0000-4000-8000-000000000011']::uuid[],
        jsonb_build_array(jsonb_build_object(
          'line_key', 1,
          'batch_id', 'e5100000-0000-4000-8000-000000000113',
          'item_id', 'e5100000-0000-4000-8000-000000000011',
          'movement_type', 'sale',
          'occurred_at', '2026-11-08T10:00:00Z',
          'quantity', 0,
          'unit_cost', 1,
          'total_cost', 0,
          'is_input_total', false,
          'source_type', 'engine',
          'engine_valued', false
        )),
        'e5100000-0000-4000-8000-000000000114',
        false
      )$$
    ),
    '22023|recompute result is out of range|critical',
    'a zero-quantity replay row is detail critical'
  );

select
  is (
    pg_temp.caught (
      $$select app.raise_recompute_failure('recompute_limit')$$
    ),
    '22023|recompute result is out of range|recompute_limit',
    'the replay row cap keeps the historical message and a recompute_limit detail'
  );

select
  is (
    pg_temp.caught (
      $$select app.raise_recompute_failure('not a known reason')$$
    ),
    '22023|recompute result is out of range|critical',
    'any other recompute failure is detail critical'
  );

select
  ok (
    (
      select
        pg_catalog.pg_get_functiondef (
          'app.replay_execute(uuid[],jsonb,uuid,boolean)'::regprocedure
        ) like '%recompute_limit%'
        and pg_catalog.pg_get_functiondef (
          'app.replay_execute(uuid[],jsonb,uuid,boolean)'::regprocedure
        ) like '%critical%'
        and pg_catalog.pg_get_functiondef (
          'app.replay_execute(uuid[],jsonb,uuid,boolean)'::regprocedure
        ) like '%> 100000%'
    ),
    'replay_execute still caps at 100000 rows and names both failure details'
  );

-- Append-only guards on the new columns.
select
  throws_ok (
    $$update app.stock_movements
      set reverses_movement_id = null
      where item_id = 'e5100000-0000-4000-8000-000000000002'
        and movement_type = 'sale'$$,
    '55000',
    'app.stock_movements is append-only; UPDATE is not allowed',
    'reverses_movement_id cannot be updated'
  );

select
  throws_ok (
    $$update app.stock_movements
      set event_position = 1
      where item_id = 'e5100000-0000-4000-8000-000000000002'
        and movement_type = 'sale'$$,
    '55000',
    'app.stock_movements is append-only; UPDATE is not allowed',
    'event_position cannot be updated'
  );

select
  throws_ok (
    $$update app.stock_movements
      set piece_position = 1
      where item_id = 'e5100000-0000-4000-8000-000000000002'
        and movement_type = 'sale'$$,
    '55000',
    'app.stock_movements is append-only; UPDATE is not allowed',
    'piece_position cannot be updated'
  );

select
  throws_ok (
    $$update app.stock_movements
      set engine_valued = true
      where item_id = 'e5100000-0000-4000-8000-000000000002'
        and movement_type = 'sale'$$,
    '55000',
    'app.stock_movements is append-only; UPDATE is not allowed',
    'engine_valued cannot be updated'
  );

select
  throws_ok (
    $$update app.item_provisional_seeds
      set unit_cost = 1
      where item_id = 'e5100000-0000-4000-8000-000000000006'$$,
    '55000',
    'app.item_provisional_seeds is append-only; UPDATE is not allowed',
    'a provisional seed cannot be updated'
  );

select
  throws_ok (
    $$delete from app.item_provisional_seeds
      where item_id = 'e5100000-0000-4000-8000-000000000006'$$,
    '55000',
    'app.item_provisional_seeds is append-only; DELETE is not allowed',
    'a provisional seed cannot be deleted'
  );

select
  throws_ok (
    $$truncate app.item_provisional_seeds$$,
    '55000',
    'app.item_provisional_seeds is append-only; TRUNCATE is not allowed',
    'provisional seeds cannot be truncated'
  );

select
  is (
    (
      select
        c.relrowsecurity
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname = 'app'
        and c.relname = 'item_provisional_seeds'
    ),
    true,
    'item_provisional_seeds has row level security'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_policy pol
        join pg_catalog.pg_class c on c.oid = pol.polrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname = 'app'
        and c.relname = 'item_provisional_seeds'
        and pol.polcmd = 'r'
    ),
    1::bigint,
    'item_provisional_seeds has one owner select policy'
  );

select
  is_empty (
    $$select r.role, p.privilege_type
      from (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r (role)
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p (privilege_type)
      where has_table_privilege(r.role, 'app.item_provisional_seeds', p.privilege_type)$$,
    'API roles cannot write item_provisional_seeds'
  );

select
  results_eq (
    $$select r.role
      from (values ('authenticated'), ('service_role')) as r (role)
      where has_table_privilege(r.role, 'app.item_provisional_seeds', 'SELECT')
      order by 1$$,
    $$values ('authenticated'), ('service_role')$$,
    'authenticated and service_role can select item_provisional_seeds'
  );

select
  is_empty (
    $$select r.role
      from (values ('anon'), ('public')) as r (role)
      where has_table_privilege(r.role, 'app.item_provisional_seeds', 'SELECT')$$,
    'anon and public cannot select item_provisional_seeds'
  );

select
  is (
    (
      select
        count(*)
      from
        unnest(
          array[
            'app.assert_ledger_lock_held()',
            'app.raise_recompute_failure(text)',
            'app.ensure_provisional_seed(uuid)',
            'app.trg_stock_movements_reversal_shape()',
            'app.replay_component(uuid[],jsonb,uuid,boolean)',
            'app.retire_movements(bigint[],uuid)',
            'app.post_engine_outflows(jsonb)'
          ]::regprocedure[]
        ) as fn
    ),
    7::bigint,
    'privilege check names every new internal function'
  );

select
  is_empty (
    $$select r.role, fn::text
      from unnest(array[
        'app.assert_ledger_lock_held()',
        'app.raise_recompute_failure(text)',
        'app.ensure_provisional_seed(uuid)',
        'app.trg_stock_movements_reversal_shape()',
        'app.replay_component(uuid[],jsonb,uuid,boolean)',
        'app.retire_movements(bigint[],uuid)',
        'app.post_engine_outflows(jsonb)'
      ]::regprocedure[]) as fn
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as r (role)
      where has_function_privilege(r.role, fn, 'execute')$$,
    'new internal functions are not executable by anon, authenticated, service_role, or public'
  );

select
  *
from
  finish ();

rollback;
