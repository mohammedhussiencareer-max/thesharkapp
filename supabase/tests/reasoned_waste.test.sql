-- Reasoned manual waste. Synthetic ids and names only.
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
    'a6600000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-66@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a6600000-0000-4000-8000-0000000000a2',
    'authenticated',
    'authenticated',
    'intruder-66@theshark.test',
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
  ('a6600000-0000-4000-8000-0000000000a1');

-- ---------------------------------------------------------------------------
-- Helpers. u(n) is a synthetic uuid; items are 1..8, requests are 100 and up.
-- ---------------------------------------------------------------------------
create function pg_temp.u (p_n integer) returns uuid language sql immutable as $$
  select ('a6600000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;

create function pg_temp.ln (p_item integer, p_qty text, p_unit text) returns jsonb language sql immutable as $$
  select jsonb_build_object('item_id', pg_temp.u(p_item), 'quantity', p_qty, 'unit', p_unit);
$$;

create function pg_temp.d (
  p_at text,
  p_reason text,
  p_expl text,
  p_pred text,
  p_lines jsonb
) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'occurred_at', p_at,
    'reason_code', p_reason,
    'explanation', p_expl,
    'predecessor_id', p_pred,
    'lines', p_lines
  ));
$$;

create function pg_temp.state_of (p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;

  return 'no-error';
exception
  when others then
    return sqlstate;
end;
$$;

create function pg_temp.hint_of (p_sql text) returns text language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;

  return 'no-error';
exception
  when others then
    get stacked diagnostics v_hint = pg_exception_hint;

    return v_hint;
end;
$$;

create function pg_temp.message_of (p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;

  return 'no-error';
exception
  when others then
    return sqlerrm;
end;
$$;

create function pg_temp.as_user (p_sub text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated')::text,
    true
  );
$$;

create function pg_temp.on_hand (p_item integer) returns numeric language sql as $$
  select coalesce((select ib.on_hand_qty from app.item_balances ib where ib.item_id = pg_temp.u(p_item)), 0);
$$;

create function pg_temp.doc_id (p_req integer) returns bigint language sql as $$
  select d.id from app.waste_documents d where d.request_id = pg_temp.u(p_req);
$$;

create temp table kv (k text primary key, v jsonb);

select
  pg_temp.as_user ('a6600000-0000-4000-8000-0000000000a1');

-- Items: 1 fish-a, 2 fish-b, 3 loss 20%, 4 piece-converted, 5 thin stock,
-- 6 no cost basis, 7 counted.
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
    pg_temp.u (1),
    'p66-fish-a',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    pg_temp.u (2),
    'p66-fish-b',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    pg_temp.u (3),
    'p66-lossy',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    pg_temp.u (4),
    'p66-piece',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    pg_temp.u (5),
    'p66-thin',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    pg_temp.u (6),
    'p66-nobasis',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    pg_temp.u (7),
    'p66-counted',
    'seafood',
    'kg',
    'daily',
    0,
    null
  );

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    pg_temp.u (900),
    'legacy',
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    pg_temp.u (901),
    'legacy',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into
  app.item_loss_versions (
    effective_from,
    created_change_id,
    item_id,
    loss_pct
  )
select
  '2000-01-01 00:00:00+00',
  (
    select
      id
    from
      app.costing_changes
    where
      request_id = pg_temp.u (900)
  ),
  i.id,
  case
    when i.id = pg_temp.u (3) then 0.2
    else 0
  end
from
  app.stock_items i
where
  i.name like 'p66-%';

insert into
  app.item_opening_prices (item_id, base_unit, unit_cost, created_change_id)
values
  (
    pg_temp.u (5),
    'kg',
    40,
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = pg_temp.u (900)
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
values
  (
    'shift-w1',
    '2030-06-01T08:00:00Z',
    '2030-06-01T16:00:00Z',
    false,
    '2030-06-01T08:00:00Z'
  ),
  (
    'shift-w2',
    '2030-06-02T08:00:00Z',
    '2030-06-02T16:00:00Z',
    false,
    '2030-06-02T08:00:00Z'
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        pg_temp.u (1),
        'movement_type',
        'purchase',
        'occurred_at',
        '2030-05-01T00:00:00Z',
        'quantity',
        100,
        'unit_cost',
        50
      ),
      jsonb_build_object(
        'item_id',
        pg_temp.u (2),
        'movement_type',
        'purchase',
        'occurred_at',
        '2030-05-01T00:00:00Z',
        'quantity',
        100,
        'unit_cost',
        20
      ),
      jsonb_build_object(
        'item_id',
        pg_temp.u (3),
        'movement_type',
        'purchase',
        'occurred_at',
        '2030-05-01T00:00:00Z',
        'quantity',
        100,
        'unit_cost',
        10
      ),
      jsonb_build_object(
        'item_id',
        pg_temp.u (4),
        'movement_type',
        'purchase',
        'occurred_at',
        '2030-05-01T00:00:00Z',
        'quantity',
        100,
        'unit_cost',
        30
      ),
      jsonb_build_object(
        'item_id',
        pg_temp.u (5),
        'movement_type',
        'opening',
        'occurred_at',
        '2030-05-01T00:00:00Z',
        'quantity',
        1,
        'unit_cost',
        40
      ),
      jsonb_build_object(
        'item_id',
        pg_temp.u (7),
        'movement_type',
        'purchase',
        'occurred_at',
        '2030-05-01T00:00:00Z',
        'quantity',
        10,
        'unit_cost',
        100
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 1. Before activation: one specific refusal, nothing written.
-- ---------------------------------------------------------------------------
select
  throws_ok (
    $$select app.record_waste(pg_temp.u(100),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, null, jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
    '55000',
    'inventory is not activated',
    'record_waste is refused before inventory activation'
  );

select
  is_empty (
    $$select 1 from app.waste_documents union all select 1 from app.waste_requests$$,
    'the refusal before activation writes nothing'
  );

select
  pg_temp.as_user ('a6600000-0000-4000-8000-0000000000a2');

select
  throws_ok (
    $$select app.record_waste(pg_temp.u(100),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, null, jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
    '42501',
    'insufficient_privilege',
    'a non-owner is refused before anything else'
  );

select
  pg_temp.as_user ('a6600000-0000-4000-8000-0000000000a1');

insert into
  app.inventory_activation (
    stock_started_at,
    approved_by,
    request_id,
    opening_manifest_hash
  )
values
  (
    '2030-06-01T00:00:00Z',
    'a6600000-0000-4000-8000-0000000000a1',
    pg_temp.u (902),
    repeat('a', 32)
  );

-- ---------------------------------------------------------------------------
-- 2. Staff meal: one line, posted through the private engine path.
-- ---------------------------------------------------------------------------
insert into
  kv
select
  'w1',
  app.record_waste (
    pg_temp.u (101),
    pg_temp.d (
      '2030-06-01T10:00:00Z',
      'staff_meal',
      null,
      null,
      jsonb_build_array(pg_temp.ln (1, '2', 'kg'))
    )
  );

select
  is (
    (
      select
        v ->> 'status' || '/' || (v ->> 'kind')
      from
        kv
      where
        k = 'w1'
    ),
    'ok/record',
    'a staff meal is recorded'
  );

select
  results_eq (
    $$select sm.movement_type::text, sm.quantity::text, sm.total_cost::text, sm.source_type,
            sm.shift_id, sm.engine_valued
      from app.waste_line_movements wm
      join app.stock_movements sm on sm.id = wm.movement_id
      where wm.document_id = pg_temp.doc_id(101)$$,
    $$values ('waste', '-2.000000', '-100.00', 'engine', 'shift-w1', true)$$,
    'one engine waste movement, valued at the average cost, in the containing shift'
  );

select
  results_eq (
    $$select d.reason_code, d.explanation, d.shift_id, d.predecessor_id, d.is_void, d.actor::text,
            d.batch_id is not null, d.retire_batch_id is null
      from app.waste_documents d where d.request_id = pg_temp.u(101)$$,
    $$values ('staff_meal', null::text, 'shift-w1', null::bigint, false,
              'a6600000-0000-4000-8000-0000000000a1', true, true)$$,
    'the document keeps reason, shift, actor and batch'
  );

select
  results_eq (
    $$select l.input_quantity::text, l.input_unit, l.factor::text, l.factor_source,
            l.conversion_version_id is null, l.base_unit, l.base_quantity::text
      from app.waste_lines l where l.document_id = pg_temp.doc_id(101)$$,
    $$values ('2.000000', 'kg', '1', 'base', true, 'kg', '2.000000')$$,
    'the line saves the base conversion and the base quantity'
  );

select
  is (
    pg_temp.on_hand (1),
    98::numeric,
    'on-hand fell by the base quantity'
  );

select
  is (
    (
      select
        v -> 'differences'
      from
        kv
      where
        k = 'w1'
    ),
    '{"cogs": "0.00", "profit": "-100.00", "waste": "100.00", "stock_value": "-100.00", "stock_quantity": "-2"}'::jsonb,
    'the result carries the exact stock, cost and profit differences'
  );

select
  results_eq (
    $$select pr.bucket, pr.amount::text, pr.shift_id, pr.item_id, pr.source_movement_id = wm.movement_id
      from app.period_revisions pr
      join app.waste_documents d on d.batch_id = pr.cause_batch_id
      join app.waste_line_movements wm on wm.document_id = d.id
      where d.request_id = pg_temp.u(101)$$,
    $$values ('waste', '-100.00', 'shift-w1', pg_temp.u(1), true)$$,
    'one waste revision, caused by the posting batch, on the shift'
  );

select
  is (
    (
      select
        profit_delta::text
      from
        app.shift_report_flags
      where
        shift_id = 'shift-w1'
    ),
    '-100.00',
    'the shift is flagged as revised with the profit difference'
  );

-- ---------------------------------------------------------------------------
-- 3. Spoilage with an implicit metric conversion, and a unit alias.
-- ---------------------------------------------------------------------------
insert into
  kv
select
  'w2',
  app.record_waste (
    pg_temp.u (102),
    pg_temp.d (
      '2030-06-01T11:00:00Z',
      'spoilage',
      null,
      null,
      jsonb_build_array(pg_temp.ln (2, '500', 'g'))
    )
  );

select
  results_eq (
    $$select l.input_unit, l.factor = 0.001, l.factor_source, l.base_quantity::text,
            (select sm.total_cost::text from app.waste_line_movements wm
               join app.stock_movements sm on sm.id = wm.movement_id where wm.line_id = l.id)
      from app.waste_lines l where l.document_id = pg_temp.doc_id(102)$$,
    $$values ('g', true, 'metric', '0.500000', '-10.00')$$,
    'grams convert to kilograms with the implicit metric factor'
  );

select
  lives_ok (
    $$select app.record_waste(pg_temp.u(103),
        pg_temp.d('2030-06-01T11:30:00Z', 'spoilage', null, null,
          jsonb_build_array(pg_temp.ln(2, '250', E'جرام'))))$$,
    'a unit alias is accepted'
  );

select
  is (
    (
      select
        l.input_unit || '/' || l.base_quantity::text
      from
        app.waste_lines l
      where
        l.document_id = pg_temp.doc_id (103)
    ),
    'g/0.250000',
    'the alias is saved as the unit code'
  );

-- ---------------------------------------------------------------------------
-- 4. Reason "other" needs an explanation; engine-only and unknown reasons.
-- ---------------------------------------------------------------------------
select
  throws_ok (
    $$select app.record_waste(pg_temp.u(104),
        pg_temp.d('2030-06-01T12:00:00Z', 'other', null, null, jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
    '22023',
    'an explanation is required for the reason other',
    'other without an explanation is rejected'
  );

select
  throws_ok (
    $$select app.record_waste(pg_temp.u(104),
        pg_temp.d('2030-06-01T12:00:00Z', 'other', '   ', null, jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
    '22023',
    'an explanation is required for the reason other',
    'other with a blank explanation is rejected'
  );

select
  throws_ok (
    $$select app.record_waste(pg_temp.u(104),
        pg_temp.d('2030-06-01T12:00:00Z', 'cancel_after_preparation', null, null,
          jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
    '22023',
    'cancel_after_preparation is recorded by the system only',
    'the engine-only reason is rejected'
  );

select
  throws_ok (
    $$select app.record_waste(pg_temp.u(104),
        pg_temp.d('2030-06-01T12:00:00Z', 'theft', null, null, jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
    '22023',
    'unknown waste reason',
    'an unknown reason is rejected'
  );

select
  throws_ok (
    format(
      $$select app.record_waste(pg_temp.u(104),
          pg_temp.d('2030-06-01T12:00:00Z', 'other', %L, null, jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
      repeat('x', 301)
    ),
    '22023',
    'explanation is longer than 300 characters',
    'an explanation over 300 characters is rejected'
  );

insert into
  kv
select
  'w4',
  app.record_waste (
    pg_temp.u (105),
    pg_temp.d (
      '2030-06-01T12:00:00Z',
      'other',
      '  dropped tray  ',
      null,
      jsonb_build_array(pg_temp.ln (1, '1', 'kg'))
    )
  );

select
  is (
    (
      select
        d.reason_code || '/' || d.explanation
      from
        app.waste_documents d
      where
        d.request_id = pg_temp.u (105)
    ),
    'other/dropped tray',
    'other with an explanation is recorded, trimmed'
  );

-- ---------------------------------------------------------------------------
-- 5. Payload shape. Each refusal writes nothing.
-- ---------------------------------------------------------------------------
create temp table before_shape as
select
  (
    select
      count(*)
    from
      app.waste_documents
  ) as docs,
  (
    select
      count(*)
    from
      app.stock_movements
  ) as moves,
  (
    select
      count(*)
    from
      app.waste_requests
  ) as reqs;

select
  is (
    (
      select
        count(*)
      from
        (
          values
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '0', 'kg')))$$,
              'quantity must be greater than zero'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '-1', 'kg')))$$,
              'each line is {item_id, quantity, unit} with decimal text'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1.1234567', 'kg')))$$,
              'each line is {item_id, quantity, unit} with decimal text'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1e3', 'kg')))$$,
              'each line is {item_id, quantity, unit} with decimal text'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(jsonb_build_object('item_id', pg_temp.u(1), 'quantity', 1, 'unit', 'kg')))$$,
              'each line is {item_id, quantity, unit} with decimal text'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(jsonb_build_object('item_id', pg_temp.u(1), 'quantity', '1')))$$,
              'each line is {item_id, quantity, unit} with decimal text'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg') || '{"x": 1}'::jsonb))$$,
              'each line is {item_id, quantity, unit} with decimal text'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg'), pg_temp.ln(1, '2', 'kg')))$$,
              'a stock item is listed twice'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', '[]'::jsonb)$$,
              'a waste document needs at least one line'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', (select jsonb_agg(pg_temp.ln(1, '1', 'kg')) from generate_series(1, 51)))$$,
              'a waste document has at most 50 lines'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'note', 'x', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg')))$$,
              'invalid waste document'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg')))$$,
              'occurred_at must be an ISO timestamp with an offset'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-13-45T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg')))$$,
              'occurred_at is not a valid timestamp'
            ),
            (
              $$jsonb_build_object('reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg')))$$,
              'occurred_at must be an ISO timestamp with an offset'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'barrel')))$$,
              'unknown unit'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(99, '1', 'kg')))$$,
              'unknown stock item'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '0.000001', 'g')))$$,
              'quantity is too small in the base unit'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'predecessor_id', '0', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg')))$$,
              'invalid predecessor id'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'predecessor_id', '999999', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg')))$$,
              'unknown waste document'
            )
        ) as t (expr, msg)
      where
        pg_temp.state_of (
          format(
            'select app.record_waste(pg_temp.u(190), %s)',
            t.expr
          )
        ) = '22023'
        and pg_temp.hint_of (
          format(
            'select app.record_waste(pg_temp.u(190), %s)',
            t.expr
          )
        ) is not null
    ),
    19::bigint,
    'malformed documents are all refused with 22023'
  );

select
  is (
    (
      select
        count(*)
      from
        (
          values
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '0', 'kg')))$$,
              'quantity must be greater than zero'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'barrel')))$$,
              'unknown unit'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg'), pg_temp.ln(1, '2', 'kg')))$$,
              'a stock item is listed twice'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'lines', '[]'::jsonb)$$,
              'a waste document needs at least one line'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00', 'reason_code', 'staff_meal', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg')))$$,
              'occurred_at must be an ISO timestamp with an offset'
            ),
            (
              $$jsonb_build_object('occurred_at', '2030-06-01T10:00:00Z', 'reason_code', 'staff_meal', 'predecessor_id', '999999', 'lines', jsonb_build_array(pg_temp.ln(1, '1', 'kg')))$$,
              'unknown waste document'
            )
        ) as t (expr, msg)
      where
        pg_temp.message_of (
          format(
            'select app.record_waste(pg_temp.u(190), %s)',
            t.expr
          )
        ) = t.msg
    ),
    6::bigint,
    'the refusal messages name the problem'
  );

select
  throws_ok (
    $$select app.record_waste(pg_temp.u(190),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, null, jsonb_build_array(pg_temp.ln(1, '1', 'piece'))))$$,
    '22023',
    null::text,
    'a unit with no conversion for the item is refused'
  );

select
  results_eq (
    $$select (select count(*) from app.waste_documents) = b.docs,
            (select count(*) from app.stock_movements) = b.moves,
            (select count(*) from app.waste_requests) = b.reqs
      from before_shape b$$,
    $$values (true, true, true)$$,
    'refused documents write nothing'
  );

-- ---------------------------------------------------------------------------
-- 6. Dated conversion: the version in force at the occurrence is saved.
-- ---------------------------------------------------------------------------
insert into
  app.item_conversion_versions (
    effective_from,
    effective_to,
    created_change_id,
    item_id,
    unit_code,
    factor_to_base
  )
select
  v.f,
  v.t,
  (
    select
      id
    from
      app.costing_changes
    where
      request_id = pg_temp.u (900)
  ),
  pg_temp.u (4),
  'piece',
  v.factor
from
  (
    values
      (
        '2030-06-01T00:00:00Z'::timestamptz,
        '2030-07-01T00:00:00Z'::timestamptz,
        0.4
      ),
      (
        '2030-07-01T00:00:00Z'::timestamptz,
        null::timestamptz,
        0.5
      )
  ) as v (f, t, factor);

insert into
  kv
select
  'verA',
  to_jsonb(id::text)
from
  app.item_conversion_versions
where
  item_id = pg_temp.u (4)
  and effective_from = '2030-06-01T00:00:00Z';

insert into
  kv
select
  'verB',
  to_jsonb(id::text)
from
  app.item_conversion_versions
where
  item_id = pg_temp.u (4)
  and effective_from = '2030-07-01T00:00:00Z';

select
  app.record_waste (
    pg_temp.u (130),
    pg_temp.d (
      '2030-06-10T10:00:00Z',
      'spoilage',
      null,
      null,
      jsonb_build_array(pg_temp.ln (4, '5', 'piece'))
    )
  );

select
  app.record_waste (
    pg_temp.u (131),
    pg_temp.d (
      '2030-07-05T10:00:00Z',
      'spoilage',
      null,
      null,
      jsonb_build_array(pg_temp.ln (4, '2', 'piece'))
    )
  );

select
  results_eq (
    $$select l.factor = 0.4, l.factor_source, l.conversion_version_id::text = (select v #>> '{}' from kv where k = 'verA'),
            l.base_quantity::text, l.base_unit
      from app.waste_lines l where l.document_id = pg_temp.doc_id(130)$$,
    $$values (true, 'explicit', true, '2.000000', 'kg')$$,
    'a June occurrence saves the June explicit factor and its version id'
  );

select
  results_eq (
    $$select l.factor = 0.5, l.factor_source, l.conversion_version_id::text = (select v #>> '{}' from kv where k = 'verB'),
            l.base_quantity::text
      from app.waste_lines l where l.document_id = pg_temp.doc_id(131)$$,
    $$values (true, 'explicit', true, '1.000000')$$,
    'a July occurrence saves the July explicit factor and its version id'
  );

update app.item_conversion_versions
set
  superseded_change_id = (
    select
      id
    from
      app.costing_changes
    where
      request_id = pg_temp.u (901)
  )
where
  id::text = (
    select
      v #>> '{}'
    from
      kv
    where
      k = 'verA'
  );

insert into
  app.item_conversion_versions (
    effective_from,
    effective_to,
    created_change_id,
    item_id,
    unit_code,
    factor_to_base
  )
values
  (
    '2030-06-01T00:00:00Z',
    '2030-07-01T00:00:00Z',
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = pg_temp.u (901)
    ),
    pg_temp.u (4),
    'piece',
    0.6
  );

select
  app.record_waste (
    pg_temp.u (132),
    pg_temp.d (
      '2030-06-15T10:00:00Z',
      'spoilage',
      null,
      null,
      jsonb_build_array(pg_temp.ln (4, '5', 'piece'))
    )
  );

select
  results_eq (
    $$select l.factor = 0.4, l.base_quantity::text
      from app.waste_lines l where l.document_id = pg_temp.doc_id(130)$$,
    $$values (true, '2.000000')$$,
    'a later conversion change does not alter the saved snapshot'
  );

select
  results_eq (
    $$select l.factor = 0.6, l.base_quantity::text, l.conversion_version_id::text <> (select v #>> '{}' from kv where k = 'verA')
      from app.waste_lines l where l.document_id = pg_temp.doc_id(132)$$,
    $$values (true, '3.000000', true)$$,
    'a new record after the change uses the new factor and version'
  );

select
  is (
    (
      select
        sm.total_cost::text
      from
        app.waste_line_movements wm
        join app.stock_movements sm on sm.id = wm.movement_id
      where
        wm.document_id = pg_temp.doc_id (130)
    ),
    '-60.00',
    'the saved base quantity, not today''s factor, drives the saved value'
  );

-- ---------------------------------------------------------------------------
-- 7. No cleaning loss: the quantity is the physical stock removed.
-- ---------------------------------------------------------------------------
select
  app.record_waste (
    pg_temp.u (140),
    pg_temp.d (
      '2030-06-01T10:30:00Z',
      'spoilage',
      null,
      null,
      jsonb_build_array(pg_temp.ln (3, '1', 'kg'))
    )
  );

select
  results_eq (
    $$select sm.quantity::text, sm.total_cost::text
      from app.waste_line_movements wm join app.stock_movements sm on sm.id = wm.movement_id
      where wm.document_id = pg_temp.doc_id(140)$$,
    $$values ('-1.000000', '-10.00')$$,
    'a 20 percent loss item loses exactly the recorded quantity'
  );

-- ---------------------------------------------------------------------------
-- 8. Negative stock uses the provisional valuation.
-- ---------------------------------------------------------------------------
select
  app.record_waste (
    pg_temp.u (150),
    pg_temp.d (
      '2030-06-01T13:00:00Z',
      'spoilage',
      null,
      null,
      jsonb_build_array(pg_temp.ln (5, '3', 'kg'))
    )
  );

select
  is (
    pg_temp.on_hand (5),
    -2::numeric,
    'waste beyond stock leaves negative on-hand'
  );

select
  results_eq (
    $$select coalesce(sum(sm.total_cost), 0)::text, bool_or(sm.is_provisional)
      from app.waste_line_movements wm join app.stock_movements sm on sm.id = wm.movement_id
      where wm.document_id = pg_temp.doc_id(150)$$,
    $$values ('-120.00', true)$$,
    'the uncovered part is valued at the saved provisional price'
  );

-- ---------------------------------------------------------------------------
-- 9. Missing cost basis and multi-line atomicity.
-- ---------------------------------------------------------------------------
select
  throws_ok (
    $$select app.record_waste(pg_temp.u(160),
        pg_temp.d('2030-06-01T14:00:00Z', 'spoilage', null, null, jsonb_build_array(pg_temp.ln(6, '1', 'kg'))))$$,
    'P0001',
    null::text,
    'an item without any cost basis is refused'
  );

select
  ok (
    pg_temp.hint_of (
      format(
        $$select app.record_waste(pg_temp.u(160),
          pg_temp.d('2030-06-01T14:00:00Z', 'spoilage', null, null, jsonb_build_array(pg_temp.ln(6, '1', 'kg'))))$$
      )
    ) like '%' || pg_temp.u (6)::text || '%',
    'the refusal names the blocked item'
  );

create temp table before_atomic as
select
  (
    select
      count(*)
    from
      app.waste_documents
  ) as docs,
  (
    select
      count(*)
    from
      app.stock_movements
  ) as moves,
  pg_temp.on_hand (1) as fish_a;

select
  throws_ok (
    $$select app.record_waste(pg_temp.u(161),
        pg_temp.d('2030-06-01T14:00:00Z', 'spoilage', null, null,
          jsonb_build_array(pg_temp.ln(1, '1', 'kg'), pg_temp.ln(6, '1', 'kg'))))$$,
    'P0001',
    null::text,
    'a document with one blocked line is refused whole'
  );

select
  results_eq (
    $$select (select count(*) from app.waste_documents) = b.docs,
            (select count(*) from app.stock_movements) = b.moves,
            pg_temp.on_hand(1) = b.fish_a,
            not exists (select 1 from app.waste_requests where request_id = pg_temp.u(161))
      from before_atomic b$$,
    $$values (true, true, true, true)$$,
    'the refused multi-line document leaves no document, movement or request'
  );

select
  lives_ok (
    $$select app.record_waste(pg_temp.u(162),
        pg_temp.d('2030-06-01T14:30:00Z', 'spoilage', null, null,
          jsonb_build_array(pg_temp.ln(1, '1', 'kg'), pg_temp.ln(2, '1', 'kg'), pg_temp.ln(3, '1', 'kg'))))$$,
    'a three-line document posts'
  );

select
  results_eq (
    $$select count(*)::int, count(distinct sm.batch_id)::int, count(distinct sm.event_position)::int
      from app.waste_line_movements wm join app.stock_movements sm on sm.id = wm.movement_id
      where wm.document_id = pg_temp.doc_id(162)$$,
    $$values (3, 1, 1)$$,
    'all lines share one posting batch and one event position'
  );

-- ---------------------------------------------------------------------------
-- 10. Gap attribution between shifts.
-- ---------------------------------------------------------------------------
select
  app.record_waste (
    pg_temp.u (170),
    pg_temp.d (
      '2030-06-01T20:00:00Z',
      'staff_meal',
      null,
      null,
      jsonb_build_array(pg_temp.ln (1, '1', 'kg'))
    )
  );

select
  app.record_waste (
    pg_temp.u (171),
    pg_temp.d (
      '2030-06-02T10:00:00Z',
      'staff_meal',
      null,
      null,
      jsonb_build_array(pg_temp.ln (1, '1', 'kg'))
    )
  );

select
  app.record_waste (
    pg_temp.u (172),
    pg_temp.d (
      '2030-05-20T10:00:00Z',
      'staff_meal',
      null,
      null,
      jsonb_build_array(pg_temp.ln (1, '1', 'kg'))
    )
  );

select
  results_eq (
    $$select d.request_id, d.shift_id from app.waste_documents d
      where d.request_id in (pg_temp.u(170), pg_temp.u(171), pg_temp.u(172)) order by d.request_id$$,
    $$values (pg_temp.u(170), 'shift-w1'), (pg_temp.u(171), 'shift-w2'), (pg_temp.u(172), null::text)$$,
    'a gap goes to the last closed shift, a shift time to its shift, earlier than any shift to none'
  );

select
  results_eq (
    $$select sm.shift_id from app.waste_line_movements wm join app.stock_movements sm on sm.id = wm.movement_id
      where wm.document_id = pg_temp.doc_id(170)$$,
    $$values ('shift-w1')$$,
    'the movement carries the same shift as the document'
  );

-- ---------------------------------------------------------------------------
-- 11. Replay and payload mismatch.
-- ---------------------------------------------------------------------------
create temp table before_replay as
select
  (
    select
      count(*)
    from
      app.waste_documents
  ) as docs,
  (
    select
      count(*)
    from
      app.stock_movements
  ) as moves;

select
  is (
    app.record_waste (
      pg_temp.u (101),
      pg_temp.d (
        '2030-06-01T10:00:00Z',
        'staff_meal',
        null,
        null,
        jsonb_build_array(pg_temp.ln (1, '2', 'kg'))
      )
    ),
    (
      select
        v
      from
        kv
      where
        k = 'w1'
    ),
    'the same request and payload return the stored result'
  );

select
  is (
    app.record_waste (
      pg_temp.u (101),
      pg_temp.d (
        '2030-06-01T10:00:00.000000Z',
        'staff_meal',
        '',
        null,
        jsonb_build_array(pg_temp.ln (1, '2.0', 'kg'))
      )
    ),
    (
      select
        v
      from
        kv
      where
        k = 'w1'
    ),
    'an equal payload spelled differently still replays'
  );

select
  throws_ok (
    $$select app.record_waste(pg_temp.u(101),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, null, jsonb_build_array(pg_temp.ln(1, '3', 'kg'))))$$,
    '22023',
    'request id was used for a different waste document',
    'the same request id with a different payload is refused'
  );

select
  results_eq (
    $$select (select count(*) from app.waste_documents) = b.docs,
            (select count(*) from app.stock_movements) = b.moves
      from before_replay b$$,
    $$values (true, true)$$,
    'replays and mismatches write nothing'
  );

-- ---------------------------------------------------------------------------
-- 12. Correction: retire the old application, post the replacement.
-- ---------------------------------------------------------------------------
create temp table before_correct as
select
  pg_temp.on_hand (1) as fish_a;

insert into
  kv
select
  'old101',
  to_jsonb(wm.movement_id)
from
  app.waste_line_movements wm
where
  wm.document_id = pg_temp.doc_id (101);

insert into
  kv
select
  'c1',
  app.record_waste (
    pg_temp.u (180),
    pg_temp.d (
      '2030-06-01T10:00:00Z',
      'staff_meal',
      null,
      pg_temp.doc_id (101)::text,
      jsonb_build_array(pg_temp.ln (1, '5', 'kg'))
    )
  );

select
  results_eq (
    $$select (v ->> 'kind'), v -> 'differences' from kv where k = 'c1'$$,
    $$values ('correction', '{"cogs": "0.00", "profit": "-150.00", "waste": "150.00", "stock_value": "-150.00", "stock_quantity": "-3"}'::jsonb)$$,
    'a correction reports the exact net stock, waste and profit effect'
  );

select
  results_eq (
    $$select sm.movement_type::text, sm.quantity::text, sm.total_cost::text, sm.source_type,
            sm.reverses_movement_id = (select (v #>> '{}')::bigint from kv where k = 'old101'),
            sm.event_position = (select d.event_position from app.waste_documents d where d.request_id = pg_temp.u(101)),
            sm.shift_id
      from app.stock_movements sm
      where sm.reverses_movement_id = (select (v #>> '{}')::bigint from kv where k = 'old101')$$,
    $$values ('waste_reversal', '2.000000', '100.00', 'reversal', true, true, 'shift-w1')$$,
    'the old movement gets an exact inverse at the same event position'
  );

select
  results_eq (
    $$select sm.quantity::text, sm.total_cost::text
      from app.stock_movements sm where sm.id = (select (v #>> '{}')::bigint from kv where k = 'old101')$$,
    $$values ('-2.000000', '-100.00')$$,
    'the original movement is never edited'
  );

select
  results_eq (
    $$select d.predecessor_id = pg_temp.doc_id(101), d.is_void, d.retire_batch_id is not null, d.batch_id is not null,
            d.event_position = o.event_position, d.shift_id
      from app.waste_documents d, app.waste_documents o
      where d.request_id = pg_temp.u(180) and o.request_id = pg_temp.u(101)$$,
    $$values (true, false, true, true, true, 'shift-w1')$$,
    'the replacement points at its predecessor and inherits the event position'
  );

select
  is (
    pg_temp.on_hand (1),
    (
      select
        fish_a
      from
        before_correct
    ) - 3,
    'on-hand reflects the larger quantity'
  );

select
  results_eq (
    $$select h.kind, h.is_current, h.successor_id = pg_temp.doc_id(180)
      from app.waste_history h where h.id = pg_temp.doc_id(101)$$,
    $$values ('record', false, true)$$,
    'the history marks the old document as superseded by the correction'
  );

select
  results_eq (
    $$select h.kind, h.is_current, h.successor_id is null, h.value::text
      from app.waste_history h where h.id = pg_temp.doc_id(180)$$,
    $$values ('correction', true, true, '250.00')$$,
    'the history shows the correction as current with its saved value'
  );

select
  results_eq (
    $$select pr.bucket, sum(pr.amount)::text
      from app.period_revisions pr
      join app.waste_documents d on pr.cause_batch_id in (d.batch_id, d.retire_batch_id)
      where d.request_id = pg_temp.u(180)
      group by pr.bucket order by pr.bucket$$,
    $$values ('waste', '-150.00')$$,
    'the correction notes revisions for both the retire and the replacement batches'
  );

-- Item and occurrence time change in one correction.
select
  app.record_waste (
    pg_temp.u (181),
    pg_temp.d (
      '2030-06-02T10:30:00Z',
      'spoilage',
      null,
      pg_temp.doc_id (102)::text,
      jsonb_build_array(pg_temp.ln (1, '1', 'kg'))
    )
  );

select
  results_eq (
    $$select d.shift_id, d.event_position = o.event_position
      from app.waste_documents d, app.waste_documents o
      where d.request_id = pg_temp.u(181) and o.request_id = pg_temp.u(102)$$,
    $$values ('shift-w2', true)$$,
    'a correction may change item and time; the new time picks its shift'
  );

select
  is (
    pg_temp.on_hand (2),
    98.75::numeric,
    'the old item got its stock back (100 - 0.25 - 1 from the three-line record)'
  );

-- Reason-only correction: no value change, revisions still recorded.
insert into
  kv
select
  'c3',
  app.record_waste (
    pg_temp.u (182),
    pg_temp.d (
      '2030-06-01T10:00:00Z',
      'spoilage',
      null,
      pg_temp.doc_id (180)::text,
      jsonb_build_array(pg_temp.ln (1, '5', 'kg'))
    )
  );

select
  is (
    (
      select
        v -> 'differences'
      from
        kv
      where
        k = 'c3'
    ),
    '{"cogs": "0.00", "profit": "0.00", "waste": "0.00", "stock_value": "0.00", "stock_quantity": "0"}'::jsonb,
    'a reason-only correction has zero differences'
  );

select
  results_eq (
    $$select count(*)::int > 0 from app.period_revisions pr
      join app.waste_documents d on pr.cause_batch_id in (d.batch_id, d.retire_batch_id)
      where d.request_id = pg_temp.u(182)$$,
    $$values (true)$$,
    'the reason-only correction still notes revisions'
  );

-- ---------------------------------------------------------------------------
-- 13. Stale correction, void, unknown predecessor.
-- ---------------------------------------------------------------------------
select
  throws_ok (
    format(
      $$select app.record_waste(pg_temp.u(183),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, %L,
          jsonb_build_array(pg_temp.ln(1, '4', 'kg'))))$$,
      pg_temp.doc_id (101)::text
    ),
    '40001',
    'the waste document was already corrected',
    'correcting an already corrected document is a stale write'
  );

select
  throws_ok (
    format(
      $$select app.record_waste(pg_temp.u(183),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, %L,
          jsonb_build_array(pg_temp.ln(1, '4', 'kg'))))$$,
      pg_temp.doc_id (180)::text
    ),
    '40001',
    'the waste document was already corrected',
    'a document with a successor cannot be corrected again'
  );

create temp table before_void as
select
  pg_temp.on_hand (1) as fish_a;

insert into
  kv
select
  'v1',
  app.record_waste (
    pg_temp.u (184),
    jsonb_build_object(
      'predecessor_id',
      pg_temp.doc_id (182)::text,
      'lines',
      '[]'::jsonb
    )
  );

select
  results_eq (
    $$select v ->> 'kind', v -> 'differences' ->> 'stock_quantity', v -> 'differences' ->> 'profit'
      from kv where k = 'v1'$$,
    $$values ('void', '5', '250.00')$$,
    'a void restores the stock and reports the profit effect'
  );

select
  is (
    pg_temp.on_hand (1),
    (
      select
        fish_a
      from
        before_void
    ) + 5,
    'on-hand is restored by the void'
  );

select
  results_eq (
    $$select d.is_void, d.batch_id is null, d.retire_batch_id is not null, d.predecessor_id = pg_temp.doc_id(182),
            (select count(*) from app.waste_lines l where l.document_id = d.id)::int
      from app.waste_documents d where d.request_id = pg_temp.u(184)$$,
    $$values (true, true, true, true, 0)$$,
    'a void is a document with a predecessor, no lines and no posting batch'
  );

select
  results_eq (
    $$select h.kind, h.is_void, h.is_current, jsonb_array_length(h.lines)
      from app.waste_history h where h.id = pg_temp.doc_id(184)$$,
    $$values ('void', true, false, 0)$$,
    'the history shows the void as the end of its chain, with no live document'
  );

select
  throws_ok (
    format(
      $$select app.record_waste(pg_temp.u(185),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, %L,
          jsonb_build_array(pg_temp.ln(1, '4', 'kg'))))$$,
      pg_temp.doc_id (184)::text
    ),
    '22023',
    null::text,
    'a void cannot be corrected'
  );

select
  throws_ok (
    format(
      $$select app.record_waste(pg_temp.u(186),
        jsonb_build_object('predecessor_id', %L, 'lines', '[]'::jsonb))$$,
      pg_temp.doc_id (182)::text
    ),
    '40001',
    'the waste document was already corrected',
    'voiding a document that already has a successor is stale'
  );

-- ---------------------------------------------------------------------------
-- 14. Correction after a later count: anchor-aware replay and compensation.
-- ---------------------------------------------------------------------------
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
  insert into app.stock_counts (id, request_id, frequency, counted_at)
  values (p_count_id, p_request_id, 'daily', p_at);

  insert into app.stock_count_lines (
    count_id, line_no, item_id, expected_base_unit, counted_qty, expected_qty,
    delta_qty, delta_value, movement_id
  )
  values (p_count_id, 1, p_item_id, 'kg', p_counted, p_expected, p_counted - p_expected, p_value, p_movement_id);

  update app.item_balances
  set last_occurred_at = greatest (coalesce(last_occurred_at, p_at), p_at + interval '1 microsecond')
  where item_id = p_item_id;
end;
$$;

select
  app.record_waste (
    pg_temp.u (190),
    pg_temp.d (
      '2030-06-01T10:00:00Z',
      'spoilage',
      null,
      null,
      jsonb_build_array(pg_temp.ln (7, '1', 'kg'))
    )
  );

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        pg_temp.u (7),
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2030-06-01T12:00:00Z',
        'quantity',
        -1
      )
    )
  );

select
  pg_temp.observe_count (
    pg_temp.u (700),
    pg_temp.u (701),
    pg_temp.u (7),
    '2030-06-01T12:00:00Z',
    8,
    9,
    (
      select
        sm.id
      from
        app.stock_movements sm
      where
        sm.item_id = pg_temp.u (7)
        and sm.movement_type = 'count_adjustment'
    ),
    -100
  );

select
  is (
    pg_temp.on_hand (7),
    8::numeric,
    'the count left eight kilograms'
  );

select
  app.record_waste (
    pg_temp.u (191),
    pg_temp.d (
      '2030-06-01T10:00:00Z',
      'spoilage',
      null,
      pg_temp.doc_id (190)::text,
      jsonb_build_array(pg_temp.ln (7, '3', 'kg'))
    )
  );

select
  results_eq (
    $$select sum(sm.quantity)::text, sum(sm.total_cost)::text, count(*)::int
      from app.stock_movements sm
      where sm.item_id = pg_temp.u(7) and sm.movement_type = 'count_compensation'$$,
    $$values ('2.000000', '200.00', 2)$$,
    'the counted anchor holds: one compensation per replay step, netting +2 kg for the extra waste'
  );

select
  is (
    pg_temp.on_hand (7),
    8::numeric,
    'on-hand stays at the counted quantity after the correction'
  );

-- ---------------------------------------------------------------------------
-- 15. A running POS sync defers the write.
-- ---------------------------------------------------------------------------
insert into
  app.pos_sync_runs (mode, status)
values
  ('recent', 'running');

select
  throws_ok (
    $$select app.record_waste(pg_temp.u(200),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, null, jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
    '55P03',
    'a POS sync is running',
    'record_waste waits for a running POS sync'
  );

update app.pos_sync_runs
set
  status = 'failed',
  finished_at = now()
where
  status = 'running';

select
  lives_ok (
    $$select app.record_waste(pg_temp.u(200),
        pg_temp.d('2030-06-01T10:00:00Z', 'staff_meal', null, null, jsonb_build_array(pg_temp.ln(1, '1', 'kg'))))$$,
    'the same request succeeds once the sync is over'
  );

-- ---------------------------------------------------------------------------
-- 16. Privileges and RLS.
-- ---------------------------------------------------------------------------
select
  results_eq (
    $$select (c.relname::text) collate "default", c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relname in ('waste_documents', 'waste_lines', 'waste_line_movements', 'waste_requests')
      order by c.relname$$,
    $$values ('waste_documents', true), ('waste_line_movements', true), ('waste_lines', true), ('waste_requests', true)$$,
    'row-level security is enabled on every waste table'
  );

select
  results_eq (
    $$select has_function_privilege('anon', 'app.record_waste(uuid, jsonb)', 'execute'),
            has_function_privilege('authenticated', 'app.record_waste(uuid, jsonb)', 'execute'),
            has_function_privilege('service_role', 'app.record_waste(uuid, jsonb)', 'execute'),
            has_function_privilege('authenticated', 'app.post_engine_outflows(jsonb)', 'execute'),
            has_function_privilege('authenticated', 'app.retire_movements(bigint[], uuid)', 'execute')$$,
    $$values (false, true, false, false, false)$$,
    'only authenticated may execute record_waste; the private posting path stays closed'
  );

select
  results_eq (
    $$select has_table_privilege('authenticated', 'app.waste_documents', 'select'),
            has_table_privilege('authenticated', 'app.waste_documents', 'insert'),
            has_table_privilege('authenticated', 'app.waste_lines', 'update'),
            has_table_privilege('authenticated', 'app.waste_requests', 'delete'),
            has_table_privilege('anon', 'app.waste_history', 'select'),
            has_table_privilege('authenticated', 'app.waste_history', 'select'),
            has_sequence_privilege('authenticated', 'app.waste_documents_id_seq', 'usage'),
            has_sequence_privilege('authenticated', 'app.waste_lines_id_seq', 'usage')$$,
    $$values (true, false, false, false, false, true, false, false)$$,
    'authenticated reads but cannot write or use the sequences; anon reads nothing'
  );

set
  local role authenticated;

select
  isnt_empty (
    $$select 1 from app.waste_documents$$,
    'the owner reads waste documents'
  );

select
  isnt_empty (
    $$select 1 from app.waste_history$$,
    'the owner reads the history view'
  );

select
  throws_ok (
    $$insert into app.waste_documents (request_id, occurred_at, reason_code, event_position, actor)
      values (gen_random_uuid(), now(), 'spoilage', 1, 'a6600000-0000-4000-8000-0000000000a1')$$,
    '42501',
    null::text,
    'authenticated cannot insert a waste document directly'
  );

select
  pg_temp.as_user ('a6600000-0000-4000-8000-0000000000a2');

select
  is_empty (
    $$select 1 from app.waste_documents$$,
    'a non-owner reads no documents'
  );

select
  is_empty (
    $$select 1 from app.waste_history$$,
    'a non-owner reads no history'
  );

select
  is_empty (
    $$select 1 from app.waste_lines union all select 1 from app.waste_line_movements union all select 1 from app.waste_requests$$,
    'a non-owner reads no lines, links or request results'
  );

reset role;

select
  pg_temp.as_user ('a6600000-0000-4000-8000-0000000000a1');

-- ---------------------------------------------------------------------------
-- 17. Append-only.
-- ---------------------------------------------------------------------------
set
  local client_min_messages = warning;

select
  is (
    (
      select
        count(*)
      from
        (
          values
            (
              'update app.waste_documents set explanation = ''x'''
            ),
            ('delete from app.waste_documents'),
            ('truncate app.waste_documents cascade'),
            ('update app.waste_lines set base_quantity = 1'),
            ('delete from app.waste_lines'),
            ('truncate app.waste_lines cascade'),
            (
              'update app.waste_line_movements set line_id = line_id'
            ),
            ('delete from app.waste_line_movements'),
            ('truncate app.waste_line_movements cascade'),
            (
              'update app.waste_requests set payload_hash = payload_hash'
            ),
            ('delete from app.waste_requests'),
            ('truncate app.waste_requests cascade')
        ) as t (stmt)
      where
        pg_temp.state_of (t.stmt) = '55000'
    ),
    12::bigint,
    'update, delete and truncate are refused on every waste table'
  );

-- ---------------------------------------------------------------------------
-- 18. History paging by keyset.
-- ---------------------------------------------------------------------------
select
  results_eq (
    $$with page1 as (select id from app.waste_history order by id desc limit 3),
           page2 as (select id from app.waste_history where id < (select min(id) from page1) order by id desc limit 3)
      select (select count(*) from page1)::int, (select count(*) from page2)::int,
             (select max(id) from page2) < (select min(id) from page1)$$,
    $$values (3, 3, true)$$,
    'keyset paging walks the history newest first without overlap'
  );

select
  results_eq (
    $$select h.value::text, jsonb_array_length(h.lines), h.lines -> 0 ->> 'input_quantity', h.lines -> 0 ->> 'input_unit',
            h.lines -> 0 ->> 'factor_source', h.lines -> 0 ->> 'base_quantity', h.lines -> 0 ->> 'name'
      from app.waste_history h where h.id = pg_temp.doc_id(130)$$,
    $$values ('60.00', 1, '5', 'piece', 'explicit', '2', 'p66-piece')$$,
    'the history exposes the saved conversion, quantities as decimal text and the value'
  );

select
  *
from
  finish ();

rollback;
