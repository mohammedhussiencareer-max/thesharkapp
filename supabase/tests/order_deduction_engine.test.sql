-- Order deduction engine. Synthetic ids and names only. No POS data and no
-- customer fields.
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
    'a5400000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-54@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a5400000-0000-4000-8000-0000000000a2',
    'authenticated',
    'authenticated',
    'intruder-54@theshark.test',
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
  ('a5400000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5400000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

-- Items: 01 fish a, 02 fish b, 03 no cost basis, 04 counted, 05 late mapping,
-- 06 recipe leaf, 07 box, 08 superseded mapping, 09 inflow wake, 0a bulk.
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
    'a5400000-0000-4000-8000-000000000001',
    'p54-fish-a',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-000000000002',
    'p54-fish-b',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-000000000003',
    'p54-no-cost',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-000000000004',
    'p54-counted',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-000000000005',
    'p54-late',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-000000000006',
    'p54-leaf',
    'ingredient',
    'kg',
    'weekly',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-000000000007',
    'p54-box',
    'packaging',
    'piece',
    'weekly',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-000000000008',
    'p54-sup',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-000000000009',
    'p54-inflow',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-00000000000a',
    'p54-bulk',
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
    'a5400000-0000-4000-8000-0000000000c0',
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
      request_id = 'a5400000-0000-4000-8000-0000000000c0'
  ),
  i.id,
  0
from
  app.stock_items i
where
  i.name like 'p54-%'
  and i.kind <> 'packaging';

insert into
  app.pos_shifts (id, opened_at, is_active, pos_update_time)
values
  (
    'shift-e0',
    '2029-12-31T08:00:00Z',
    false,
    '2029-12-31T08:00:00Z'
  ),
  (
    'shift-e1',
    '2030-06-01T08:00:00Z',
    false,
    '2030-06-01T08:00:00Z'
  ),
  (
    'shift-e2',
    '2030-06-02T08:00:00Z',
    false,
    '2030-06-02T08:00:00Z'
  );

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------
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

create function pg_temp.state_of (p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;

  return 'no-error';
exception
  when others then
    return sqlstate;
end;
$$;

create function pg_temp.policies (p_pos text) returns void language plpgsql as $$
begin
  perform app.set_pos_option_policy(
    md5('opt|' || p_pos)::uuid, p_pos, '["none"]'::jsonb,
    '2030-01-01T00:00:00Z', null, 'none_expected',
    (select app.pos_base_schedule(p_pos, '["none"]'::jsonb) ->> 'token'), null
  );

  perform app.set_base_packaging(
    md5('bpk|' || p_pos)::uuid, p_pos, '["none"]'::jsonb,
    '2030-01-01T00:00:00Z', null, '{"none": true}'::jsonb,
    (select app.packaging_base_schedule(p_pos, '["none"]'::jsonb) ->> 'token'), null
  );
end;
$$;

create function pg_temp.map_stock (
  p_pos text,
  p_item uuid,
  p_qty text,
  p_from timestamptz,
  p_to timestamptz default null
) returns void language plpgsql as $$
begin
  perform app.set_pos_base_mapping(
    md5('map|' || p_pos || '|' || p_from::text)::uuid, p_pos, '["none"]'::jsonb,
    p_from, p_to,
    jsonb_build_object('stock_item_id', p_item, 'quantity_per_basis', p_qty, 'unit', 'kg'),
    (select app.pos_base_schedule(p_pos, '["none"]'::jsonb) ->> 'token'), null
  );
end;
$$;

create function pg_temp.type_ok (p_type text) returns void language plpgsql as $$
begin
  perform app.set_order_type_packaging(
    md5('ot|' || p_type)::uuid, p_type, '2030-01-01T00:00:00Z', null,
    '{"none": true}'::jsonb,
    (select app.packaging_order_type_schedule(p_type) ->> 'token'), null
  );
end;
$$;

create function pg_temp.mk_order (
  p_id text,
  p_shift text,
  p_status text,
  p_type text,
  p_at timestamptz,
  p_pos text,
  p_qty numeric,
  p_pos2 text default null,
  p_qty2 numeric default null
) returns void language plpgsql as $$
begin
  insert into app.pos_orders (
    id, shift_id, status, order_type, ordered_at, subtotal, discount, tax,
    service_tax, delivery_fee, total, pos_update_time, content_hash, missing_from_pos
  ) values (
    p_id, p_shift, p_status, p_type, p_at, 0, 0, 0, 0, 0, 0, p_at,
    rpad(md5(p_id), 64, 'a'), false
  );

  insert into app.pos_order_lines (
    order_id, line_id, item_id, item_name, quantity, weighted_qty,
    weighted_unit, options, line_total
  ) values (p_id, 'l1-' || p_id, p_pos, 'x', p_qty, null, null, '[]'::jsonb, 0);

  if p_pos2 is not null then
    insert into app.pos_order_lines (
      order_id, line_id, item_id, item_name, quantity, weighted_qty,
      weighted_unit, options, line_total
    ) values (p_id, 'l2-' || p_id, p_pos2, 'x', p_qty2, null, null, '[]'::jsonb, 0);
  end if;

  perform app.append_pos_cost_input(p_id, null, 'sync');
end;
$$;

create function pg_temp.edit_order (
  p_id text,
  p_qty numeric,
  p_total numeric,
  p_shift text default null,
  p_at timestamptz default null
) returns void language plpgsql as $$
begin
  update app.pos_orders
  set
    version = version + 1,
    total = coalesce(p_total, total),
    shift_id = coalesce(p_shift, shift_id),
    ordered_at = coalesce(p_at, ordered_at),
    pos_update_time = pos_update_time + interval '1 minute',
    content_hash = rpad(md5(p_id || (version + 1)::text), 64, 'b')
  where
    id = p_id;

  if p_qty is not null then
    update app.pos_order_lines set quantity = p_qty where order_id = p_id;
  end if;

  perform app.capture_pos_order_snapshot(p_id, null, 'sync');
  perform app.append_pos_cost_input(p_id, null, 'sync');
end;
$$;

create function pg_temp.sum_counts (acc jsonb, v jsonb) returns jsonb language plpgsql as $$
declare
  k text;
begin
  foreach k in array array[
    'processed', 'applied', 'unchanged', 'incomplete', 'none', 'blocked',
    'disposition_pending', 'failed'
  ] loop
    acc := acc || jsonb_build_object(
      k, coalesce((acc ->> k)::integer, 0) + coalesce((v ->> k)::integer, 0)
    );
  end loop;

  return acc;
end;
$$;

-- Works the way the runner does: a bound call for the head it was told about,
-- a maintenance call (no binding) when there is none. Stops at p_limit bound
-- calls, at the first call that is not 'processed', or at a failure. The worker
-- itself takes one order a call.
create function pg_temp.work (p_limit integer default 10) returns jsonb language plpgsql as $$
declare
  v jsonb;
  h jsonb := app.accounting_next_work() -> 'head';
  n integer := 0;
  g integer := 0;
  acc jsonb := '{}'::jsonb;
begin
  loop
    v := app.run_accounting_work(
      gen_random_uuid(), 1, h ->> 'order_id', (h ->> 'work_generation')::integer
    );
    g := g + 1;

    if h ->> 'order_id' is not null then
      n := n + 1;
    end if;

    h := v -> 'head';
    acc := pg_temp.sum_counts(acc, v);

    exit when v ->> 'status' <> 'processed'
      or coalesce((v ->> 'failed')::integer, 0) > 0
      or n >= p_limit
      or g >= 2000;
  end loop;

  return jsonb_build_object(
    'status',
    case
      when v ->> 'status' = 'empty'
        and coalesce((acc ->> 'processed')::integer, 0)
          + coalesce((acc ->> 'failed')::integer, 0) > 0 then 'processed'
      else v ->> 'status'
    end,
    'processed', coalesce((acc ->> 'processed')::integer, 0),
    'applied', coalesce((acc ->> 'applied')::integer, 0),
    'unchanged', coalesce((acc ->> 'unchanged')::integer, 0),
    'incomplete', coalesce((acc ->> 'incomplete')::integer, 0),
    'none', coalesce((acc ->> 'none')::integer, 0),
    'blocked', coalesce((acc ->> 'blocked')::integer, 0),
    'disposition_pending', coalesce((acc ->> 'disposition_pending')::integer, 0),
    'failed', coalesce((acc ->> 'failed')::integer, 0),
    'remaining', v -> 'remaining',
    'head', v -> 'head',
    'critical', v -> 'critical'
  );
end;
$$;

create function pg_temp.drain () returns jsonb language plpgsql as $$
declare
  v jsonb;
  h jsonb := app.accounting_next_work() -> 'head';
  n integer := 0;
  acc jsonb := '{}'::jsonb;
  k text;
begin
  loop
    v := app.run_accounting_work(
      gen_random_uuid(), 1, h ->> 'order_id', (h ->> 'work_generation')::integer
    );
    n := n + 1;
    h := v -> 'head';

    exit when v ->> 'status' <> 'processed' or n >= 800;

    foreach k in array array[
      'applied', 'unchanged', 'incomplete', 'none', 'blocked',
      'disposition_pending', 'failed'
    ] loop
      acc := acc || jsonb_build_object(
        k, coalesce((acc ->> k)::integer, 0) + (v ->> k)::integer
      );
    end loop;
  end loop;

  return acc || jsonb_build_object('status', v ->> 'status', 'calls', n);
end;
$$;

create function pg_temp.net_qty (p_order text, p_item uuid) returns numeric language sql as $$
  select
    coalesce(sum(m.quantity), 0)
  from
    app.stock_movements m
  where
    m.item_id = p_item
    and (
      m.id in (select l.movement_id from app.order_cost_movement_links l where l.order_id = p_order)
      or m.reverses_movement_id in (
        select l.movement_id from app.order_cost_movement_links l where l.order_id = p_order
      )
    );
$$;

create function pg_temp.engine_count () returns bigint language sql as $$
  select count(*) from app.stock_movements where source_type = 'engine';
$$;

create function pg_temp.app_count (p_order text, p_kind text) returns bigint language sql as $$
  select count(*) from app.order_cost_applications a
  where a.order_id = p_order and a.receipt_kind = p_kind;
$$;

create function pg_temp.head (p_order text) returns app.order_cost_state language sql as $$
  select h from app.order_cost_state h where h.order_id = p_order;
$$;

-- ---------------------------------------------------------------------------
-- Catalog and privileges before any rows.
-- ---------------------------------------------------------------------------
select
  has_table ('app', t, t || ' exists')
from
  unnest(
    array[
      'inventory_activation',
      'accounting_rederive_spans',
      'accounting_work_events',
      'accounting_work_state',
      'accounting_work_attempts',
      'accounting_work_completions',
      'order_cost_applications',
      'order_cost_movement_links',
      'order_cost_state'
    ]
  ) as t;

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname = 'app'
        and c.relname = any (
          array[
            'inventory_activation',
            'accounting_rederive_spans',
            'accounting_work_events',
            'accounting_work_state',
            'accounting_work_attempts',
            'accounting_work_completions',
            'order_cost_applications',
            'order_cost_movement_links',
            'order_cost_state'
          ]
        )
        and c.relrowsecurity
    ),
    9::bigint,
    'every new table has row level security on'
  );

select
  is_empty (
    $$select r.role || ' ' || p.fn
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      cross join unnest(array[
        'app.process_order_accounting(text,uuid,integer)',
        'app.accounting_pending_orders(integer)',
        'app.accounting_order_pending(text)',
        'app.resolve_order_snapshot_exact(bigint,boolean,boolean)',
        'app.round_order_requirements(jsonb)',
        'app.resolve_order_requirements_core(text,boolean,timestamptz,text,jsonb,boolean)',
        'app.resolve_line_requirements_core(text,text,timestamptz,numeric,numeric,text,jsonb,text)',
        'app.packaging_line_recipe_paths_core(text,text,timestamptz,numeric,numeric,text,jsonb,text)'
      ]) as p (fn)
      where has_function_privilege(r.role, p.fn, 'execute')$$,
    'internal functions are not executable by any API role'
  );

select
  results_eq (
    $$select r.role, p.fn, has_function_privilege(r.role, p.fn, 'execute')
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      cross join unnest(array[
        'app.run_accounting_work(uuid,integer,text,integer)',
        'app.record_accounting_call_failure(uuid,text,integer)',
        'app.accounting_next_work()',
        'app.retry_accounting_work(text)'
      ]) as p (fn)
      order by 2, 1$$,
    $$values
      ('anon', 'app.accounting_next_work()', false),
      ('authenticated', 'app.accounting_next_work()', true),
      ('service_role', 'app.accounting_next_work()', true),
      ('anon', 'app.record_accounting_call_failure(uuid,text,integer)', false),
      ('authenticated', 'app.record_accounting_call_failure(uuid,text,integer)', true),
      ('service_role', 'app.record_accounting_call_failure(uuid,text,integer)', true),
      ('anon', 'app.retry_accounting_work(text)', false),
      ('authenticated', 'app.retry_accounting_work(text)', true),
      ('service_role', 'app.retry_accounting_work(text)', true),
      ('anon', 'app.run_accounting_work(uuid,integer,text,integer)', false),
      ('authenticated', 'app.run_accounting_work(uuid,integer,text,integer)', true),
      ('service_role', 'app.run_accounting_work(uuid,integer,text,integer)', true)$$,
    'only authenticated and service_role may call the worker RPCs; they check the owner inside'
  );

select
  is (
    (
      select
        p.proconfig
      from
        pg_catalog.pg_proc p
      where
        p.oid = 'app.run_accounting_work(uuid,integer,text,integer)'::regprocedure
    ),
    array[
      'search_path=""',
      'statement_timeout=6s',
      'lock_timeout=250ms'
    ],
    'the worker declares its timeouts as function settings, which PostgREST applies before the call'
  );

select
  is (
    (
      select
        p.proconfig
      from
        pg_catalog.pg_proc p
      where
        p.oid = 'app.record_accounting_call_failure(uuid,text,integer)'::regprocedure
    ),
    array['search_path=""', 'lock_timeout=250ms'],
    'the failure recorder declares its lock timeout as a function setting'
  );

select
  is_empty (
    $$select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in ('run_accounting_work', 'record_accounting_call_failure', 'retry_accounting_work')
        and p.prosrc ~ 'set_config'$$,
    'no worker function re-sets its timeouts inside the running statement'
  );

select
  is_empty (
    $$select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in (
          'trg_pos_cost_inputs_work_event', 'trg_record_rederive_span',
          'trg_wake_cost_basis_blockers'
        )
        and (
          has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
        )$$,
    'trigger functions are not executable by API roles'
  );

-- ---------------------------------------------------------------------------
-- Cost basis, catalog and the first order, all before activation.
-- ---------------------------------------------------------------------------
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-000000000001', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 100, 'unit_cost', 50),
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-000000000002', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 100, 'unit_cost', 20),
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-000000000005', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 100, 'unit_cost', 10),
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-000000000006', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 100, 'unit_cost', 5),
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-000000000007', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 1000, 'unit_cost', 2),
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-000000000008', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 100, 'unit_cost', 10)
    ))$$,
    'purchases give the fixtures a cost basis'
  );

select
  pg_temp.policies (p)
from
  unnest(
    array[
      'pos-a',
      'pos-b',
      'pos-c',
      'pos-d',
      'pos-late',
      'pos-sup',
      'pos-dish',
      'pos-pk',
      'pos-in'
    ]
  ) as p;

select
  pg_temp.map_stock (
    'pos-a',
    'a5400000-0000-4000-8000-000000000001',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-b',
    'a5400000-0000-4000-8000-000000000002',
    '0.5',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-c',
    'a5400000-0000-4000-8000-000000000003',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-d',
    'a5400000-0000-4000-8000-000000000004',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-sup',
    'a5400000-0000-4000-8000-000000000008',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-pk',
    'a5400000-0000-4000-8000-000000000002',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-in',
    'a5400000-0000-4000-8000-000000000009',
    '1',
    '2030-01-01T00:00:00Z'
  );

-- The late item is mapped only from July, so a June order has a gap.
select
  pg_temp.map_stock (
    'pos-late',
    'a5400000-0000-4000-8000-000000000005',
    '1',
    '2030-07-01T00:00:00Z'
  );

select
  pg_temp.type_ok ('hall');

select
  is (
    (
      select
        count(*)
      from
        app.accounting_rederive_spans
      where
        family = 'pos_map'
        and cause = 'insert'
    ),
    (
      select
        count(*)
      from
        app.pos_map_versions
    ),
    'each mapping version recorded one insert span'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_rederive_spans
      where
        family = 'packaging'
        and cause = 'insert'
    ),
    (
      select
        count(*)
      from
        app.packaging_versions
    ),
    'each packaging version recorded one insert span'
  );

select
  pg_temp.mk_order (
    'o-pre',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-02T12:00:00Z',
    'pos-a',
    2
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        order_id = 'o-pre'
        and cause = 'pos_input'
    ),
    1::bigint,
    'a new cost input wrote one pos_input work event'
  );

select
  is (
    (
      select
        source_key
      from
        app.accounting_work_events
      where
        order_id = 'o-pre'
    ),
    'input:' || (
      select
        id::text
      from
        app.pos_cost_inputs
      where
        order_id = 'o-pre'
    ),
    'the event key is stable per cost input'
  );

-- Not activated: nothing is processed and nothing is written.
select
  is (
    app.run_accounting_work (gen_random_uuid(), 1),
    '{"status": "not_activated"}'::jsonb,
    'the worker returns not_activated while no activation row exists'
  );

select
  is (
    app.accounting_next_work (),
    '{"status": "not_activated", "head": null}'::jsonb,
    'the peek returns not_activated while no activation row exists'
  );

select
  is_empty (
    $$select order_id from app.accounting_work_state$$,
    'not_activated creates no work state'
  );

select
  is (
    pg_temp.engine_count (),
    0::bigint,
    'not_activated posts nothing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        processed_at is null
    ),
    1::bigint,
    'the event stays open until activation'
  );

-- ---------------------------------------------------------------------------
-- Activation row: singleton and append-only. No API role can write it.
-- ---------------------------------------------------------------------------
select
  lives_ok (
    $$insert into app.inventory_activation (
        stock_started_at, approved_by, request_id, opening_manifest_hash
      ) values (
        '2030-06-01T00:00:00Z', 'a5400000-0000-4000-8000-0000000000a1',
        'a5400000-0000-4000-8000-0000000000e1', repeat('a', 32)
      )$$,
    'the fixture role inserts the activation row'
  );

select
  is (
    pg_temp.state_of (
      $$insert into app.inventory_activation (
          id, stock_started_at, request_id, opening_manifest_hash
        ) values (2, now(), 'a5400000-0000-4000-8000-0000000000e2', repeat('a', 32))$$
    ),
    '23514',
    'only the singleton id is allowed'
  );

select
  is (
    pg_temp.state_of (
      $$insert into app.inventory_activation (
          stock_started_at, request_id, opening_manifest_hash
        ) values (now(), 'a5400000-0000-4000-8000-0000000000e2', repeat('a', 32))$$
    ),
    '23505',
    'a second activation row is refused'
  );

select
  is (
    pg_temp.state_of (
      $$update app.inventory_activation set stock_started_at = now()$$
    ),
    '55000',
    'the activation row cannot be updated'
  );

select
  is (
    pg_temp.state_of ($$delete from app.inventory_activation$$),
    '55000',
    'the activation row cannot be deleted'
  );

select
  is (
    pg_temp.state_of ($$truncate app.inventory_activation$$),
    '55000',
    'the activation row cannot be truncated'
  );

-- ---------------------------------------------------------------------------
-- Argument checks.
-- ---------------------------------------------------------------------------
select
  throws_ok (
    $$select app.run_accounting_work(null, 5)$$,
    '22023',
    'attempt id is required',
    'the worker needs an attempt id'
  );

select
  throws_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 0)$$,
    '22023',
    'limit must be between 1 and 10',
    'limit 0 is refused'
  );

select
  throws_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 11)$$,
    '22023',
    'limit must be between 1 and 10',
    'limit 11 is refused'
  );

select
  throws_ok (
    $$select app.run_accounting_work(gen_random_uuid(), null)$$,
    '22023',
    'limit must be between 1 and 10',
    'a null limit is refused'
  );

select
  throws_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 1, 'o-pre', null)$$,
    '22023',
    'order id and work generation are given together',
    'a binding with an order and no generation is refused'
  );

select
  throws_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 1, null, 1)$$,
    '22023',
    'order id and work generation are given together',
    'a binding with a generation and no order is refused'
  );

select
  throws_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 1, 'o-pre', 0)$$,
    '22023',
    'order id and work generation are given together',
    'a binding with generation 0 is refused'
  );

select
  throws_ok (
    $$select app.record_accounting_call_failure(gen_random_uuid(), null, 1)$$,
    '22023',
    'attempt id, order id and work generation are required',
    'the failure report must name an order'
  );

select
  throws_ok (
    $$select app.record_accounting_call_failure(gen_random_uuid(), 'o-pre', null)$$,
    '22023',
    'attempt id, order id and work generation are required',
    'the failure report must name a generation'
  );

select
  throws_ok (
    $$select app.record_accounting_call_failure(null, 'o-pre', 1)$$,
    '22023',
    'attempt id, order id and work generation are required',
    'the failure report must name an attempt'
  );

-- ---------------------------------------------------------------------------
-- First deduction, replay, crash retry.
-- ---------------------------------------------------------------------------
create temp table first_run as
select
  app.run_accounting_work (
    'a5400000-0000-4000-8000-0000000000f1',
    10,
    'o-pre',
    1
  ) as r;

select
  is (
    (
      select
        r ->> 'status'
      from
        first_run
    ),
    'processed',
    'the first call processes the pending order'
  );

select
  is (
    (
      select
        (r ->> 'applied')::integer
      from
        first_run
    ),
    1,
    'the first call applies one order'
  );

select
  results_eq (
    $$select m.movement_type::text, m.quantity, m.total_cost, m.source_type::text,
             m.engine_valued, m.shift_id, m.occurred_at
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'o-pre'$$,
    $$values (
      'sale', -2::numeric(20, 6), -100.00::numeric(14, 2), 'engine', true,
      'shift-e1', '2030-06-02T12:00:00Z'::timestamptz
    )$$,
    'the sale is posted at the order instant and shift, valued at the average'
  );

select
  results_eq (
    $$select a.receipt_kind, a.disposition, a.predecessor_id is null,
             a.retired_application_id is null, a.movement_owner_id = a.id,
             a.posting_batch is not null, a.retire_batch is null,
             a.algorithm_version, a.work_generation, a.attempt_id::text
      from app.order_cost_applications a where a.order_id = 'o-pre'$$,
    $$values (
      'posting', 'sale', true, true, true, true, true, 1, 1,
      'a5400000-0000-4000-8000-0000000000f1'
    )$$,
    'the receipt records the posting, its generation and its attempt'
  );

select
  results_eq (
    $$select (h).disposition, (h).owner_application_id = (h).latest_application_id,
             (h).latest_input_id = (select id from app.pos_cost_inputs where order_id = 'o-pre')
      from (select pg_temp.head('o-pre') as h) x$$,
    $$values ('sale', true, true)$$,
    'the head points at the owning application and the latest input'
  );

select
  results_eq (
    $$select ws.last_outcome, ws.attempts, ws.failed_at is null, ws.work_generation
      from app.accounting_work_state ws where ws.order_id = 'o-pre'$$,
    $$values ('applied', 0, true, 1)$$,
    'the work state records the outcome'
  );

select
  results_eq (
    $$select c.attempt_id::text, c.order_id, c.work_generation, c.outcome,
             c.application_id = (select a.id from app.order_cost_applications a where a.order_id = 'o-pre')
      from app.accounting_work_completions c
      where c.attempt_id = 'a5400000-0000-4000-8000-0000000000f1'$$,
    $$values ('a5400000-0000-4000-8000-0000000000f1', 'o-pre', 1, 'applied', true)$$,
    'the call left completion evidence naming its order, generation and receipt'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        order_id = 'o-pre'
        and processed_at is null
    ),
    0::bigint,
    'the event is processed'
  );

select
  is (
    pg_temp.drain () ->> 'status',
    'empty',
    'draining the catalog spans ends with an empty queue'
  );

select
  is (
    pg_temp.work () - 'head',
    jsonb_build_object(
      'status',
      'empty',
      'processed',
      0,
      'applied',
      0,
      'unchanged',
      0,
      'incomplete',
      0,
      'none',
      0,
      'blocked',
      0,
      'disposition_pending',
      0,
      'failed',
      0,
      'remaining',
      0,
      'critical',
      null
    ),
    'a further call finds nothing to do'
  );

select
  is (
    pg_temp.engine_count (),
    1::bigint,
    'replay posts nothing new'
  );

-- A crash retry: the same input is evaluated again under a new attempt.
insert into
  app.accounting_work_events (order_id, cause, source_key)
values
  ('o-pre', 'decision', 'test:retry-1');

select
  is (
    (pg_temp.work () ->> 'unchanged')::integer,
    1,
    'a repeated evaluation of the same input changes nothing'
  );

select
  is (
    pg_temp.engine_count (),
    1::bigint,
    'a crash retry posts the order once'
  );

select
  is_empty (
    $$select a.id
      from app.order_cost_applications a
      where a.order_id = 'o-pre' and a.receipt_kind = 'evaluation'
        and (a.disposition <> 'sale' or a.posting_batch is not null or a.retire_batch is not null
             or a.movement_owner_id is distinct from (
               select p.id from app.order_cost_applications p
               where p.order_id = 'o-pre' and p.receipt_kind = 'posting'))$$,
    'unchanged evaluations write receipts that point at the owning application and move nothing'
  );

select
  isnt_empty (
    $$select id from app.order_cost_applications
      where order_id = 'o-pre' and receipt_kind = 'evaluation'$$,
    'the repeated evaluation left a receipt'
  );

select
  is (
    (pg_temp.head ('o-pre')).owner_application_id,
    (
      select
        id
      from
        app.order_cost_applications
      where
        order_id = 'o-pre'
        and receipt_kind = 'posting'
    ),
    'the owner stays the posting application'
  );

-- ---------------------------------------------------------------------------
-- Physical edit, then a financial-only edit.
-- ---------------------------------------------------------------------------
select
  pg_temp.edit_order ('o-pre', 3, null);

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'a physical edit posts a replacement'
  );

select
  is (
    pg_temp.net_qty ('o-pre', 'a5400000-0000-4000-8000-000000000001'),
    -3::numeric,
    'the order nets to the edited quantity'
  );

select
  results_eq (
    $$select m.movement_type::text, count(*)
      from app.stock_movements m
      where m.item_id = 'a5400000-0000-4000-8000-000000000001'
        and m.movement_type in ('sale', 'sale_reversal')
      group by 1 order by 1$$,
    $$values ('sale', 2::bigint), ('sale_reversal', 1::bigint)$$,
    'the old sale was reversed and a new one posted'
  );

select
  results_eq (
    $$select p.event_position = o.event_position, p.retire_batch is not null,
             p.predecessor_id is not null,
             coalesce(array_length(p.reversal_movement_ids, 1), 0)
      from app.order_cost_applications p
      join app.order_cost_applications o on o.id = p.retired_application_id
      where p.order_id = 'o-pre' and p.receipt_kind = 'posting'
        and o.receipt_kind = 'posting'$$,
    $$values (true, true, true, 1)$$,
    'the replacement keeps the logical event position and records the retirement'
  );

select
  pg_temp.edit_order ('o-pre', null, 99);

create temp table before_financial as
select
  pg_temp.engine_count () as moves,
  pg_temp.app_count ('o-pre', 'posting') as postings;

select
  is (
    (pg_temp.work () ->> 'unchanged')::integer,
    1,
    'a financial-only edit is unchanged'
  );

select
  results_eq (
    $$select pg_temp.engine_count (), pg_temp.app_count ('o-pre', 'posting')$$,
    $$select moves, postings from before_financial$$,
    'a financial-only edit posts and retires nothing'
  );

-- ---------------------------------------------------------------------------
-- Shift change and instant change.
-- ---------------------------------------------------------------------------
select
  pg_temp.edit_order ('o-pre', null, null, 'shift-e2');

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'a shift change replaces the sale'
  );

select
  is (
    (
      select
        m.shift_id
      from
        app.order_cost_movement_links l
        join app.stock_movements m on m.id = l.movement_id
      where
        l.order_id = 'o-pre'
        and m.movement_type = 'sale'
      order by
        m.id desc
      limit
        1
    ),
    'shift-e2',
    'the replacement sale carries the new shift'
  );

select
  pg_temp.edit_order ('o-pre', null, null, null, '2030-06-02T13:00:00Z');

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'an instant change replaces the sale'
  );

select
  is (
    (
      select
        m.occurred_at
      from
        app.order_cost_movement_links l
        join app.stock_movements m on m.id = l.movement_id
      where
        l.order_id = 'o-pre'
        and m.movement_type = 'sale'
      order by
        m.id desc
      limit
        1
    ),
    '2030-06-02T13:00:00Z'::timestamptz,
    'the replacement sale carries the new instant'
  );

select
  is (
    pg_temp.net_qty ('o-pre', 'a5400000-0000-4000-8000-000000000001'),
    -3::numeric,
    'the order still nets to one sale of 3 kg'
  );

-- ---------------------------------------------------------------------------
-- Whole-order atomicity with a packaging gap, then the gap is filled.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-gap',
    'shift-e1',
    'complete',
    'ghost',
    '2030-06-03T10:00:00Z',
    'pos-a',
    1,
    'pos-b',
    2
  );

select
  is (
    (pg_temp.work () ->> 'incomplete')::integer,
    1,
    'a packaging gap makes the whole order incomplete'
  );

select
  results_eq (
    $$select pg_temp.net_qty('o-gap', 'a5400000-0000-4000-8000-000000000001'),
             pg_temp.net_qty('o-gap', 'a5400000-0000-4000-8000-000000000002'),
             (select count(*) from app.order_cost_movement_links where order_id = 'o-gap')$$,
    $$values (0::numeric, 0::numeric, 0::bigint)$$,
    'no line of an incomplete order is deducted'
  );

select
  results_eq (
    $$select a.disposition, a.receipt_kind, a.requirements is null,
             a.causes <> '[]'::jsonb, a.movement_owner_id is null
      from app.order_cost_applications a where a.order_id = 'o-gap'$$,
    $$values ('incomplete', 'posting', true, true, true)$$,
    'an incomplete receipt keeps the causes and owns no movements'
  );

select
  results_eq (
    $$select ws.last_outcome, ws.last_reason is not null
      from app.accounting_work_state ws where ws.order_id = 'o-gap'$$,
    $$values ('incomplete', true)$$,
    'the work state says incomplete'
  );

select
  is (
    (pg_temp.head ('o-gap')).owner_application_id is null,
    true,
    'an incomplete order owns no application'
  );

create temp table gap_spans as
select
  coalesce(max(id), 0) as last_id
from
  app.accounting_rederive_spans;

select
  pg_temp.type_ok ('ghost');

select
  results_eq (
    $$select family, cause, effective_to is null, completed_at is null
      from app.accounting_rederive_spans
      where id > (select last_id from gap_spans)$$,
    $$values ('packaging', 'insert', true, true)$$,
    'filling the gap recorded one open insert span'
  );

select
  lives_ok (
    $$select pg_temp.drain()$$,
    'the worker drains the span'
  );

select
  results_eq (
    $$select pg_temp.net_qty('o-gap', 'a5400000-0000-4000-8000-000000000001'),
             pg_temp.net_qty('o-gap', 'a5400000-0000-4000-8000-000000000002'),
             (select count(distinct application_id) from app.order_cost_movement_links where order_id = 'o-gap'),
             (select count(distinct m.batch_id)
              from app.order_cost_movement_links l join app.stock_movements m on m.id = l.movement_id
              where l.order_id = 'o-gap')$$,
    $$values (-1::numeric, -1::numeric, 1::bigint, 1::bigint)$$,
    'the filled gap posts every line of the order together in one batch'
  );

select
  results_eq (
    $$select a.disposition, a.predecessor_id is not null, a.retired_application_id is null
      from app.order_cost_applications a
      where a.order_id = 'o-gap' and a.receipt_kind = 'posting'
      order by a.id desc limit 1$$,
    $$values ('sale', true, true)$$,
    'the sale follows the incomplete receipt without a retirement'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_rederive_spans
      where
        completed_at is null
    ),
    0::bigint,
    'the drain completed every span'
  );

-- ---------------------------------------------------------------------------
-- Incomplete, then filled by a dated mapping insert.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-late',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-10T10:00:00Z',
    'pos-late',
    2
  );

select
  is (
    (pg_temp.work () ->> 'incomplete')::integer,
    1,
    'an unmapped June order is incomplete'
  );

select
  pg_temp.map_stock (
    'pos-late',
    'a5400000-0000-4000-8000-000000000005',
    '1',
    '2030-01-01T00:00:00Z',
    '2030-07-01T00:00:00Z'
  );

select
  lives_ok (
    $$select pg_temp.drain()$$,
    'the dated mapping span drains'
  );

select
  is (
    pg_temp.net_qty ('o-late', 'a5400000-0000-4000-8000-000000000005'),
    -2::numeric,
    'the dated mapping insert completes the order'
  );

-- ---------------------------------------------------------------------------
-- Supersede-only change creates a gap (A1).
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-sup',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-11T10:00:00Z',
    'pos-sup',
    1
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'the superseded-mapping order is posted first'
  );

select
  is (
    pg_temp.net_qty ('o-sup', 'a5400000-0000-4000-8000-000000000008'),
    -1::numeric,
    'o-sup nets to its sale'
  );

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    'a5400000-0000-4000-8000-0000000000c1',
    'legacy',
    '{}'::jsonb,
    '{}'::jsonb
  );

create temp table spans_before as
select
  count(*) as n
from
  app.accounting_rederive_spans;

update app.pos_map_versions
set
  superseded_change_id = (
    select
      id
    from
      app.costing_changes
    where
      request_id = 'a5400000-0000-4000-8000-0000000000c1'
  )
where
  family = 'mapping'
  and stock_item_id = 'a5400000-0000-4000-8000-000000000008'
  and superseded_change_id is null;

select
  results_eq (
    $$select family, cause, effective_from, effective_to, orders_enqueued, completed_at is null
      from app.accounting_rederive_spans
      where id > (select max(id) - 1 from app.accounting_rederive_spans)$$,
    $$values (
      'pos_map', 'supersede', '2030-01-01T00:00:00Z'::timestamptz, null::timestamptz, 0::bigint, true
    )$$,
    'superseding a version recorded its old interval, attributed to the superseding change'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_rederive_spans
    ) - (
      select
        n
      from
        spans_before
    ),
    1::bigint,
    'the supersede wrote exactly one span'
  );

select
  lives_ok (
    $$select pg_temp.drain()$$,
    'the worker resolves the supersede span'
  );

select
  results_eq (
    $$select a.disposition, a.retired_application_id is not null, a.retire_batch is not null,
             a.movement_owner_id is null
      from app.order_cost_applications a
      where a.order_id = 'o-sup' and a.receipt_kind = 'posting'
      order by a.id desc limit 1$$,
    $$values ('incomplete', true, true, true)$$,
    'the gap retires the application and saves an incomplete receipt'
  );

select
  is (
    pg_temp.net_qty ('o-sup', 'a5400000-0000-4000-8000-000000000008'),
    0::numeric,
    'the retired order no longer takes stock'
  );

select
  is (
    (pg_temp.head ('o-sup')).owner_application_id is null,
    true,
    'the head owns nothing after the retirement'
  );

-- ---------------------------------------------------------------------------
-- Recipe ancestor change.
-- ---------------------------------------------------------------------------
select
  app.create_recipe (
    'a5400000-0000-4000-8000-000000000931',
    'p54-batch',
    'batch'
  );

select
  app.create_recipe (
    'a5400000-0000-4000-8000-000000000932',
    'p54-dish',
    'dish'
  );

select
  app.set_recipe_version (
    'a5400000-0000-4000-8000-000000000933',
    (
      select
        id
      from
        app.recipes
      where
        name = 'p54-batch'
    ),
    '2030-01-01 00:00:00+00',
    null,
    1,
    'kg',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'a5400000-0000-4000-8000-000000000006',
        'quantity',
        '1',
        'unit',
        'kg'
      )
    ),
    null,
    (
      select
        app.recipe_schedule (
          (
            select
              id
            from
              app.recipes
            where
              name = 'p54-batch'
          )
        ) ->> 'token'
    )
  );

select
  app.set_recipe_version (
    'a5400000-0000-4000-8000-000000000934',
    (
      select
        id
      from
        app.recipes
      where
        name = 'p54-dish'
    ),
    '2030-01-01 00:00:00+00',
    null,
    null,
    null,
    jsonb_build_array(
      jsonb_build_object(
        'child_recipe_id',
        (
          select
            id
          from
            app.recipes
          where
            name = 'p54-batch'
        ),
        'quantity',
        '1',
        'unit',
        'kg'
      )
    ),
    null,
    (
      select
        app.recipe_schedule (
          (
            select
              id
            from
              app.recipes
            where
              name = 'p54-dish'
          )
        ) ->> 'token'
    )
  );

select
  app.set_pos_base_mapping (
    'a5400000-0000-4000-8000-000000000935',
    'pos-dish',
    '["none"]'::jsonb,
    '2030-01-01 00:00:00+00',
    null,
    jsonb_build_object(
      'recipe_id',
      (
        select
          id
        from
          app.recipes
        where
          name = 'p54-dish'
      )
    ),
    (
      select
        app.pos_base_schedule ('pos-dish', '["none"]'::jsonb) ->> 'token'
    ),
    null
  );

select
  pg_temp.mk_order (
    'o-dish',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-12T10:00:00Z',
    'pos-dish',
    2
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'a recipe order is posted'
  );

select
  is (
    pg_temp.net_qty ('o-dish', 'a5400000-0000-4000-8000-000000000006'),
    -2::numeric,
    'the dish takes two kilograms of leaf through the batch'
  );

create temp table recipe_spans as
select
  coalesce(max(id), 0) as last_id
from
  app.accounting_rederive_spans;

select
  app.set_recipe_version (
    'a5400000-0000-4000-8000-000000000936',
    (
      select
        id
      from
        app.recipes
      where
        name = 'p54-batch'
    ),
    '2030-01-01 00:00:00+00',
    null,
    1,
    'kg',
    jsonb_build_array(
      jsonb_build_object(
        'stock_item_id',
        'a5400000-0000-4000-8000-000000000006',
        'quantity',
        '2',
        'unit',
        'kg'
      )
    ),
    null,
    (
      select
        app.recipe_schedule (
          (
            select
              id
            from
              app.recipes
            where
              name = 'p54-batch'
          )
        ) ->> 'token'
    )
  );

select
  results_eq (
    $$select family, cause from app.accounting_rederive_spans
      where id > (select last_id from recipe_spans) order by cause$$,
    $$values ('recipe', 'insert'), ('recipe', 'supersede')$$,
    'the new batch version recorded an insert span and a supersede span'
  );

select
  lives_ok (
    $$select pg_temp.drain()$$,
    'the recipe spans drain'
  );

select
  is (
    pg_temp.net_qty ('o-dish', 'a5400000-0000-4000-8000-000000000006'),
    -4::numeric,
    'a change to the ancestor batch re-posts the dish order'
  );

-- ---------------------------------------------------------------------------
-- Packaging line change.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-pk',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-13T10:00:00Z',
    'pos-pk',
    2
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'a packaged order starts without boxes'
  );

select
  app.set_base_packaging (
    'a5400000-0000-4000-8000-000000000941',
    'pos-pk',
    '["none"]'::jsonb,
    '2030-01-01 00:00:00+00',
    null,
    jsonb_build_object(
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'stock_item_id',
          'a5400000-0000-4000-8000-000000000007',
          'quantity',
          '1',
          'unit',
          'piece'
        )
      )
    ),
    (
      select
        app.packaging_base_schedule ('pos-pk', '["none"]'::jsonb) ->> 'token'
    ),
    null
  );

select
  lives_ok (
    $$select pg_temp.drain()$$,
    'the packaging spans drain'
  );

select
  is (
    pg_temp.net_qty ('o-pk', 'a5400000-0000-4000-8000-000000000007'),
    -2::numeric,
    'a packaging change adds the boxes to the order'
  );

select
  is (
    pg_temp.net_qty ('o-pk', 'a5400000-0000-4000-8000-000000000002'),
    -2::numeric,
    'and the fish line stays at its quantity after the replacement'
  );

-- ---------------------------------------------------------------------------
-- missing_cost_basis blocks the order; an opening price wakes it.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-nocost',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-14T10:00:00Z',
    'pos-c',
    1
  );

select
  is (
    (pg_temp.work () ->> 'blocked')::integer,
    1,
    'an order with no cost basis is blocked'
  );

select
  results_eq (
    $$select ws.last_outcome, ws.last_reason, ws.blocked_item_ids, ws.failed_at is null, ws.attempts
      from app.accounting_work_state ws where ws.order_id = 'o-nocost'$$,
    $$values ('blocked', 'missing_cost_basis',
              array['a5400000-0000-4000-8000-000000000003']::uuid[], true, 0)$$,
    'the work state names the blocking item and counts no failure'
  );

select
  is (
    (pg_temp.head ('o-nocost')).causes,
    jsonb_build_array(
      jsonb_build_object(
        'code',
        'missing_cost_basis',
        'item_ids',
        jsonb_build_array('a5400000-0000-4000-8000-000000000003')
      )
    ),
    'the head keeps a structured cause'
  );

select
  is (
    pg_temp.app_count ('o-nocost', 'posting') + pg_temp.app_count ('o-nocost', 'evaluation'),
    0::bigint,
    'a blocked order writes no receipt'
  );

select
  results_eq (
    $$select c.outcome, c.work_generation, c.application_id is null
      from app.accounting_work_completions c where c.order_id = 'o-nocost'$$,
    $$values ('blocked', 1, true)$$,
    'a blocked call leaves completion evidence for its attempt although it has no receipt'
  );

select
  is (
    app.record_accounting_call_failure (
      (
        select
          c.attempt_id
        from
          app.accounting_work_completions c
        where
          c.order_id = 'o-nocost'
      ),
      'o-nocost',
      1
    ) ->> 'status',
    'committed',
    'a late failure report for the blocked call is answered committed'
  );

-- The same late report, naming an unrelated order that is pending now.
select
  pg_temp.mk_order (
    'o-late-1',
    'shift-e0',
    'complete',
    'hall',
    '2030-03-03T10:00:00Z',
    'pos-a',
    1
  );

select
  is (
    app.record_accounting_call_failure (
      (
        select
          c.attempt_id
        from
          app.accounting_work_completions c
        where
          c.order_id = 'o-nocost'
      ),
      'o-late-1',
      1
    ) ->> 'status',
    'committed',
    'a late report of a committed blocked call cannot charge an unrelated pending order'
  );

select
  is_empty (
    $$select 1 from app.accounting_work_attempts where order_id = 'o-late-1'
      union all
      select 1 from app.accounting_work_state where order_id = 'o-late-1' and attempts <> 0$$,
    'the unrelated order was not charged'
  );

select
  is (
    (pg_temp.work () ->> 'none')::integer,
    1,
    'the unrelated order is processed normally'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        item_id = 'a5400000-0000-4000-8000-000000000003'
    ),
    0::bigint,
    'a blocked order posts no movement'
  );

select
  is (
    (pg_temp.work () ->> 'status'),
    'empty',
    'a blocked order is not retried until something changes'
  );

select
  lives_ok (
    $$select app.set_item_opening_price(
      'a5400000-0000-4000-8000-0000000000b1',
      'a5400000-0000-4000-8000-000000000003',
      40, null, null, 'kg|seafood||'
    )$$,
    'the owner approves an opening price for the blocking item'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        order_id = 'o-nocost'
        and cause = 'cost_basis'
        and processed_at is null
    ),
    1::bigint,
    'the opening price woke the blocked order'
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'the woken order is posted'
  );

select
  is (
    (
      select
        total_cost
      from
        app.stock_movements
      where
        item_id = 'a5400000-0000-4000-8000-000000000003'
        and movement_type = 'sale'
    ),
    -40.00::numeric(14, 2),
    'the sale is valued at the approved opening price'
  );

-- A valued inflow wakes a blocked order too.
select
  pg_temp.mk_order (
    'o-inflow',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-15T10:00:00Z',
    'pos-in',
    1
  );

select
  is (
    (pg_temp.work () ->> 'blocked')::integer,
    1,
    'the inflow-wake order is blocked'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'a5400000-0000-4000-8000-000000000009', 'movement_type', 'purchase',
      'occurred_at', '2030-06-14T00:00:00Z', 'quantity', 5, 'unit_cost', 30
    )))$$,
    'a purchase arrives for the blocking item'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        order_id = 'o-inflow'
        and cause = 'cost_basis'
        and processed_at is null
    ),
    1::bigint,
    'a valued inflow woke the blocked order'
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'the order is posted from the purchase'
  );

-- ---------------------------------------------------------------------------
-- disposition_pending: canceled, missing, refunded keep their application.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-cancel',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-16T10:00:00Z',
    'pos-a',
    1
  );

select
  pg_temp.mk_order (
    'o-miss',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-16T11:00:00Z',
    'pos-a',
    1
  );

select
  pg_temp.mk_order (
    'o-refund',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-16T12:00:00Z',
    'pos-a',
    1
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    3,
    'three ordinary orders are posted'
  );

create temp table pending_before as
select
  h.order_id,
  h.owner_application_id,
  (
    select
      count(*)
    from
      app.order_cost_applications a
    where
      a.order_id = h.order_id
  ) as receipts
from
  app.order_cost_state h
where
  h.order_id in ('o-cancel', 'o-miss', 'o-refund');

update app.pos_orders
set
  status = 'canceled',
  version = version + 1,
  content_hash = rpad(md5('o-cancel-cancel'), 64, 'c'),
  pos_update_time = pos_update_time + interval '1 minute'
where
  id = 'o-cancel';

select
  app.capture_pos_order_snapshot ('o-cancel', null, 'sync');

select
  app.append_pos_cost_input ('o-cancel', null, 'sync');

update app.pos_orders
set
  missing_from_pos = true
where
  id = 'o-miss';

select
  app.append_pos_cost_input ('o-miss', null, 'sync');

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
values
  (
    'shift-e1',
    'tx-54-refund',
    'o-refund',
    3,
    10,
    '2030-06-16T13:00:00Z',
    true,
    'sync'
  );

select
  app.append_pos_cost_input ('o-refund', null, 'sync');

select
  results_eq (
    $$select (w ->> 'applied')::integer, (w ->> 'unchanged')::integer, (w ->> 'disposition_pending')::integer
      from (select pg_temp.work () as w) x$$,
    $$values (2, 1, 0)$$,
    'a canceled and a missing order default to made and post prepared waste; a partly refunded order stays a sale'
  );

select
  results_eq (
    $$select h.order_id, h.disposition
      from app.order_cost_state h
      where h.order_id in ('o-cancel', 'o-miss', 'o-refund') order by 1$$,
    $$values
      ('o-cancel', 'prepared_waste'),
      ('o-miss', 'prepared_waste'),
      ('o-refund', 'sale')$$,
    'each head carries the default decision''s disposition'
  );

select
  results_eq (
    $$select e.order_id, e.class, e.decision, e.source, e.owner_reviewed
      from app.order_disposition_events e
      where e.order_id in ('o-cancel', 'o-miss', 'o-refund') order by 1$$,
    $$values
      ('o-cancel', 'canceled', 'made', 'system_default', false),
      ('o-miss', 'missing', 'made', 'system_default', false),
      ('o-refund', 'partial_refund', 'made', 'system_default', false)$$,
    'each episode starts with one unreviewed system default'
  );

select
  is_empty (
    $$select h.order_id
      from app.order_cost_state h
      join pending_before b on b.order_id = h.order_id
      where h.order_id = 'o-refund'
        and (h.owner_application_id is distinct from b.owner_application_id
         or (select count(*) from app.order_cost_applications a where a.order_id = h.order_id) <> b.receipts + 1)$$,
    'the partly refunded order keeps its sale application and gains an evaluation receipt'
  );

select
  is (
    pg_temp.net_qty (
      'o-cancel',
      'a5400000-0000-4000-8000-000000000001'
    ),
    -1::numeric,
    'the canceled order''s stock effect is the prepared waste, not the sale and the waste together'
  );

select
  is (
    (
      select
        last_outcome
      from
        app.accounting_work_state
      where
        order_id = 'o-cancel'
    ),
    'applied',
    'the work state records the applied default'
  );

select
  results_eq (
    $$select c.order_id, c.outcome, c.application_id is not null
      from app.accounting_work_completions c
      where c.order_id in ('o-cancel', 'o-miss', 'o-refund')
        and c.work_generation = (select max(c2.work_generation) from app.accounting_work_completions c2 where c2.order_id = c.order_id)
      order by 1$$,
    $$values ('o-cancel', 'applied', true),
             ('o-miss', 'applied', true),
             ('o-refund', 'unchanged', true)$$,
    'each default call left completion evidence with its receipt'
  );

select
  is (
    app.record_accounting_call_failure (
      (
        select
          c.attempt_id
        from
          app.accounting_work_completions c
        where
          c.order_id = 'o-cancel'
        order by
          c.work_generation desc
        limit
          1
      ),
      'o-cancel',
      (
        select
          max(c.work_generation)
        from
          app.accounting_work_completions c
        where
          c.order_id = 'o-cancel'
      )
    ) ->> 'status',
    'committed',
    'a late failure report for the default call is answered committed'
  );

-- ---------------------------------------------------------------------------
-- Chronological processing.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-ch-3',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-20T12:00:00Z',
    'pos-a',
    1
  );

select
  pg_temp.mk_order (
    'o-ch-1',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-20T08:00:00Z',
    'pos-a',
    1
  );

select
  pg_temp.mk_order (
    'o-ch-2',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-20T10:00:00Z',
    'pos-a',
    1
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    3,
    'the three out-of-order orders are posted in one call'
  );

select
  is (
    (
      select
        array_agg(
          a.order_id
          order by
            a.id
        )
      from
        app.order_cost_applications a
      where
        a.order_id like 'o-ch-%'
    ),
    array['o-ch-1', 'o-ch-2', 'o-ch-3'],
    'orders are processed by occurrence, not by arrival'
  );

-- ---------------------------------------------------------------------------
-- A count before the deduction is compensated.
-- ---------------------------------------------------------------------------
select
  app.post_movements_internal (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        'a5400000-0000-4000-8000-000000000004',
        'movement_type',
        'opening',
        'occurred_at',
        '2030-06-05T08:00:00Z',
        'quantity',
        10,
        'unit_cost',
        40
      ),
      jsonb_build_object(
        'item_id',
        'a5400000-0000-4000-8000-000000000004',
        'movement_type',
        'count_adjustment',
        'occurred_at',
        '2030-06-05T12:00:00Z',
        'quantity',
        -2
      )
    )
  );

insert into
  app.stock_counts (id, request_id, frequency, counted_at)
values
  (
    'a5400000-0000-4000-8000-0000000000d1',
    'a5400000-0000-4000-8000-0000000000d2',
    'daily',
    '2030-06-05T12:00:00Z'
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
values
  (
    'a5400000-0000-4000-8000-0000000000d1',
    1,
    'a5400000-0000-4000-8000-000000000004',
    'kg',
    8,
    10,
    -2,
    -80,
    (
      select
        id
      from
        app.stock_movements
      where
        item_id = 'a5400000-0000-4000-8000-000000000004'
        and movement_type = 'count_adjustment'
    )
  );

update app.item_balances
set
  last_occurred_at = greatest(
    coalesce(last_occurred_at, '2030-06-05T12:00:00Z'),
    '2030-06-05T12:00:00Z'::timestamptz + interval '1 microsecond'
  )
where
  item_id = 'a5400000-0000-4000-8000-000000000004';

select
  pg_temp.mk_order (
    'o-count',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-05T10:00:00Z',
    'pos-d',
    2
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'an order before the count is posted'
  );

select
  results_eq (
    $$select sm.quantity, sm.total_cost
      from app.stock_movements sm
      where sm.item_id = 'a5400000-0000-4000-8000-000000000004'
        and sm.movement_type = 'count_compensation'$$,
    $$values (2::numeric(20, 6), 80.00::numeric(14, 2))$$,
    'the count is compensated so the counted stock stays 8'
  );

select
  results_eq (
    $$select on_hand_qty from app.item_balances
      where item_id = 'a5400000-0000-4000-8000-000000000004'$$,
    $$values (8::numeric(20, 6))$$,
    'on-hand stays at the counted quantity'
  );

-- ---------------------------------------------------------------------------
-- Items opened after the order make it incomplete.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-early',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-04T10:00:00Z',
    'pos-d',
    1
  );

select
  is (
    (pg_temp.work () ->> 'incomplete')::integer,
    1,
    'an order before the item opening is incomplete'
  );

select
  is (
    (pg_temp.head ('o-early')).causes -> 0 ->> 'code',
    'before_item_opening',
    'the cause says the item had not opened'
  );

-- ---------------------------------------------------------------------------
-- Orders before stock start and open orders are none.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-old',
    'shift-e0',
    'complete',
    'hall',
    '2029-12-31T10:00:00Z',
    'pos-a',
    1
  );

select
  pg_temp.mk_order (
    'o-open',
    'shift-e1',
    'active',
    'hall',
    '2030-06-21T10:00:00Z',
    'pos-a',
    1
  );

select
  is (
    (pg_temp.work () ->> 'none')::integer,
    2,
    'an order before stock start and an open order take no stock'
  );

select
  results_eq (
    $$select h.order_id, h.disposition, h.causes -> 0 ->> 'code'
      from app.order_cost_state h where h.order_id in ('o-old', 'o-open') order by 1$$,
    $$values ('o-old', 'none', 'before_stock_start'), ('o-open', 'none', 'open')$$,
    'the none outcomes carry their cause'
  );

-- ---------------------------------------------------------------------------
-- Failures: attempts, generations, retry.
-- ---------------------------------------------------------------------------
create function public.p54_boom () returns trigger language plpgsql as $$
declare
  m text := coalesce(current_setting('p54.boom', true), 'off');
begin
  if m = 'plain' then
    raise exception 'synthetic failure' using errcode = 'XX000';
  elsif m = 'limit' then
    raise exception 'recompute result is out of range'
      using errcode = '22023', detail = 'recompute_limit';
  elsif m = 'critical' then
    raise exception 'recompute result is out of range'
      using errcode = '22023', detail = 'critical';
  elsif m = 'sleep' then
    perform pg_sleep(2);
  end if;

  return new;
end;
$$;

create trigger p54_boom
before insert on app.order_cost_applications for each row when (
  new.order_id like 'o-fail%'
  or new.order_id like 'o-slow%'
)
execute function public.p54_boom ();

select
  is (
    pg_temp.drain () ->> 'status',
    'empty',
    'everything so far is processed'
  );

select
  set_config('p54.boom', 'plain', true);

select
  pg_temp.mk_order (
    'o-fail',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-22T10:00:00Z',
    'pos-a',
    1
  );

create temp table fail_run as
select
  app.run_accounting_work (
    'a5400000-0000-4000-8000-0000000000f2',
    10,
    'o-fail',
    1
  ) as r;

select
  results_eq (
    $$select (r ->> 'failed')::integer, (r ->> 'processed')::integer, r ->> 'status'
      from fail_run$$,
    $$values (1, 0, 'processed')$$,
    'a failing order is counted as failed, not processed'
  );

select
  results_eq (
    $$select ws.attempts, ws.failed_at is null, ws.last_error_code, ws.last_reason,
             ws.work_generation
      from app.accounting_work_state ws where ws.order_id = 'o-fail'$$,
    $$values (1, true, 'XX000', 'error', 1)$$,
    'the first failure records one attempt in generation 1'
  );

select
  results_eq (
    $$select t.kind, t.sqlstate, t.reason, t.work_generation
      from app.accounting_work_attempts t where t.order_id = 'o-fail'$$,
    $$values ('caught', 'XX000', 'error', 1)$$,
    'the caught failure is recorded with its SQLSTATE'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements
      where
        source_id in (
          select
            id::text
          from
            app.order_cost_applications
          where
            order_id = 'o-fail'
        )
    ),
    0::bigint,
    'the failed order left no movement behind'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        order_id = 'o-fail'
        and processed_at is null
    ),
    1::bigint,
    'the failed order keeps its event open'
  );

select
  pg_temp.work ()
from
  generate_series(1, 4);

select
  results_eq (
    $$select ws.attempts, ws.failed_at is not null, ws.work_generation
      from app.accounting_work_state ws where ws.order_id = 'o-fail'$$,
    $$values (5, true, 1)$$,
    'five failed attempts park the order'
  );

select
  is (
    (pg_temp.work () ->> 'status'),
    'empty',
    'a parked order is skipped'
  );

select
  pg_temp.edit_order ('o-fail', 2, null);

select
  is (
    (
      select
        (r ->> 'failed')::integer
      from
        (
          select
            pg_temp.work () as r
        ) x
    ),
    1,
    'a new POS input is eligible even though the previous generation exhausted its attempts'
  );

select
  results_eq (
    $$select ws.attempts, ws.failed_at is null, ws.work_generation
      from app.accounting_work_state ws where ws.order_id = 'o-fail'$$,
    $$values (1, true, 2)$$,
    'the new generation starts with a clean attempt count'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_attempts
      where
        order_id = 'o-fail'
    ),
    6::bigint,
    'attempts are kept per generation'
  );

select
  is (
    app.retry_accounting_work ('o-fail') ->> 'status',
    'not_failed',
    'retry does nothing for an order that is not parked'
  );

select
  pg_temp.work ()
from
  generate_series(1, 4);

select
  is (
    (
      select
        failed_at is not null
      from
        app.accounting_work_state
      where
        order_id = 'o-fail'
    ),
    true,
    'the second generation parks after five attempts'
  );

select
  is (
    app.retry_accounting_work ('no-such-order') ->> 'status',
    'not_failed',
    'retry of an unknown order does nothing'
  );

select
  set_config('p54.boom', 'off', true);

select
  is (
    app.retry_accounting_work ('o-fail') ->> 'status',
    'retried',
    'retry clears the parked order'
  );

select
  results_eq (
    $$select ws.attempts, ws.failed_at is null, ws.work_generation
      from app.accounting_work_state ws where ws.order_id = 'o-fail'$$,
    $$values (0, true, 3)$$,
    'retry opens a new generation'
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'the retried order is posted once the fault is gone'
  );

select
  is (
    pg_temp.net_qty ('o-fail', 'a5400000-0000-4000-8000-000000000001'),
    -2::numeric,
    'it takes the edited quantity'
  );

-- The machine-readable reason separates the row cap from a critical stop.
select
  set_config('p54.boom', 'limit', true);

select
  pg_temp.mk_order (
    'o-fail-limit',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-23T10:00:00Z',
    'pos-a',
    1
  );

select
  is (
    (pg_temp.work () ->> 'status'),
    'processed',
    'a replay row cap failure does not stop the worker'
  );

select
  is (
    (
      select
        reason
      from
        app.accounting_work_attempts
      where
        order_id = 'o-fail-limit'
    ),
    'recompute_limit',
    'the row cap is recorded as recompute_limit'
  );

select
  is (
    (
      select
        failed_at is not null
      from
        app.accounting_work_state
      where
        order_id = 'o-fail-limit'
    ),
    true,
    'a caught recompute_limit parks the order on the first attempt'
  );

select
  pg_temp.mk_order (
    'o-next',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-23T11:00:00Z',
    'pos-a',
    1
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_applications
      where
        order_id = 'o-next'
        and receipt_kind = 'posting'
    ),
    0::bigint,
    'the later order has no receipt before the worker runs'
  );

select
  pg_temp.work ();

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_applications
      where
        order_id = 'o-next'
        and receipt_kind = 'posting'
    ),
    1::bigint,
    'a later order still posts while the capped order is parked'
  );

select
  set_config('p54.boom', 'off', true);

select
  app.retry_accounting_work ('o-fail-limit');

select
  is (
    pg_temp.drain () ->> 'status',
    'empty',
    'the row cap order recovers once the fault is gone'
  );

select
  set_config('p54.boom', 'critical', true);

select
  pg_temp.mk_order (
    'o-fail-crit',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-24T10:00:00Z',
    'pos-a',
    1
  );

create temp table crit_run as
select
  pg_temp.work (10) as r;

select
  results_eq (
    $$select r ->> 'status', r -> 'critical' ->> 'order_id' from crit_run$$,
    $$values ('critical', 'o-fail-crit')$$,
    'a ledger invariant failure stops the worker and is surfaced'
  );

select
  is (
    (
      select
        reason
      from
        app.accounting_work_attempts
      where
        order_id = 'o-fail-crit'
    ),
    'critical',
    'the invariant failure is recorded as critical'
  );

select
  set_config('p54.boom', 'off', true);

select
  is (
    pg_temp.drain () ->> 'status',
    'empty',
    'once the fault is gone the pending orders recover'
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_state
      where
        order_id in ('o-fail-limit', 'o-fail-crit')
        and owner_application_id is not null
    ),
    2::bigint,
    'both recovered orders are posted'
  );

-- ---------------------------------------------------------------------------
-- Escaped failures: the worker call never replied.
-- ---------------------------------------------------------------------------
select
  set_config('p54.boom', 'sleep', true);

select
  pg_temp.mk_order (
    'o-slow',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-25T10:00:00Z',
    'pos-a',
    1
  );

create function pg_temp.run_with_timeout (
  p_attempt uuid,
  p_order text default null,
  p_generation integer default null
) returns text language plpgsql as $$
begin
  perform app.run_accounting_work(p_attempt, 1, p_order, p_generation);

  return 'finished';
exception
  when query_canceled then
    return 'canceled';
end;
$$;

set
  local statement_timeout = '400ms';

create temp table slow_run as
select
  pg_temp.run_with_timeout (
    'a5400000-0000-4000-8000-0000000000f3',
    'o-slow',
    1
  ) as r;

set
  local statement_timeout = 0;

select
  is (
    (
      select
        r
      from
        slow_run
    ),
    'canceled',
    'a statement timeout escapes the per-order handler as 57014'
  );

select
  is_empty (
    $$select order_id from app.accounting_work_attempts where order_id = 'o-slow'$$,
    'the cancelled call rolled back everything, including its own attempt'
  );

select
  results_eq (
    $$select app.record_accounting_call_failure('a5400000-0000-4000-8000-0000000000f3', 'o-slow', 1) ->> 'status',
             app.record_accounting_call_failure('a5400000-0000-4000-8000-0000000000f3', 'o-slow', 1) ->> 'status'$$,
    $$values ('recorded', 'duplicate')$$,
    'the recorder reports the escaped call, and a repeat is a no-op'
  );

select
  results_eq (
    $$select t.kind, t.reason, t.work_generation, count(*) over ()
      from app.accounting_work_attempts t where t.order_id = 'o-slow'$$,
    $$values ('escaped', 'escaped', 1, 1::bigint)$$,
    'the escaped call counts once'
  );

select
  results_eq (
    $$select ws.attempts, ws.last_reason, ws.failed_at is null
      from app.accounting_work_state ws where ws.order_id = 'o-slow'$$,
    $$values (1, 'escaped', true)$$,
    'the bound order was charged one attempt'
  );

select
  is (
    app.record_accounting_call_failure (
      'a5400000-0000-4000-8000-0000000000f4',
      'o-slow',
      99
    ) ->> 'status',
    'stale',
    'a generation that no longer matches is stale'
  );

select
  is (
    app.record_accounting_call_failure (
      'a5400000-0000-4000-8000-0000000000f2',
      'o-slow',
      1
    ) ->> 'status',
    'duplicate',
    'an attempt id that already failed in a caught call is not counted again'
  );

select
  is (
    (
      select
        attempts
      from
        app.accounting_work_state
      where
        order_id = 'o-slow'
    ),
    1,
    'the repeat did not change the count'
  );

select
  is (
    app.record_accounting_call_failure (
      'a5400000-0000-4000-8000-0000000000f1',
      'o-slow',
      1
    ) ->> 'status',
    'committed',
    'an attempt that committed is reported committed, not failed'
  );

select
  app.record_accounting_call_failure (gen_random_uuid(), 'o-slow', 1)
from
  generate_series(1, 4);

select
  results_eq (
    $$select ws.attempts, ws.failed_at is not null
      from app.accounting_work_state ws where ws.order_id = 'o-slow'$$,
    $$values (5, true)$$,
    'five distinct escaped calls park the order'
  );

select
  is (
    app.record_accounting_call_failure (gen_random_uuid(), 'o-slow', 1) ->> 'status',
    'no_work',
    'a parked order has nothing pending to charge'
  );

select
  set_config('p54.boom', 'off', true);

select
  app.retry_accounting_work ('o-slow');

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'the order recovers after the retry'
  );

-- A statement timeout is recorded on its own path and parks immediately.
select
  set_config('p54.boom', 'sleep', true);

select
  pg_temp.mk_order (
    'o-slow-park',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-25T12:00:00Z',
    'pos-a',
    1
  );

select
  is (
    (
      app.accounting_next_work () -> 'head' ->> 'order_id'
    ),
    'o-slow-park',
    'the timeout order is the head'
  );

create temp table park_gen as
select
  (
    app.accounting_next_work () -> 'head' ->> 'work_generation'
  )::integer as g;

set
  local statement_timeout = '400ms';

select
  is (
    pg_temp.run_with_timeout (
      'a5400000-0000-4000-8000-0000000000f5',
      'o-slow-park',
      (
        select
          g
        from
          park_gen
      )
    ),
    'canceled',
    'the timeout order is cancelled before a reply'
  );

set
  local statement_timeout = 0;

select
  is (
    app.record_accounting_recompute_timeout (
      'a5400000-0000-4000-8000-0000000000f5',
      'o-slow-park',
      (
        select
          g
        from
          park_gen
      )
    ) ->> 'status',
    'recorded',
    'a statement timeout is recorded as recompute_limit'
  );

select
  is (
    app.record_accounting_recompute_timeout (
      'a5400000-0000-4000-8000-0000000000f5',
      'o-slow-park',
      (
        select
          g
        from
          park_gen
      )
    ) ->> 'status',
    'duplicate',
    'a repeated timeout report is not charged again'
  );

select
  results_eq (
    $$select t.reason, t.sqlstate, ws.failed_at is not null, ws.attempts
      from app.accounting_work_attempts t
      join app.accounting_work_state ws on ws.order_id = t.order_id
      where t.order_id = 'o-slow-park'$$,
    $$values ('recompute_limit', '57014', true, 1)$$,
    'the first timeout charge parks the order'
  );

select
  set_config('p54.boom', 'off', true);

select
  pg_temp.mk_order (
    'o-park-next',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-25T13:00:00Z',
    'pos-a',
    1
  );

select
  pg_temp.work ();

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_applications
      where
        order_id = 'o-park-next'
        and receipt_kind = 'posting'
    ),
    1::bigint,
    'another order still posts after a timeout park'
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_applications
      where
        order_id = 'o-slow-park'
    ),
    0::bigint,
    'the parked timeout order was not posted'
  );

-- ---------------------------------------------------------------------------
-- A failed call can only charge the order it was bound to. The orders sit
-- before stock start, so they take no stock.
-- ---------------------------------------------------------------------------
select
  set_config('p54.boom', 'sleep', true);

select
  pg_temp.mk_order (
    'o-ok-1',
    'shift-e0',
    'complete',
    'hall',
    '2030-03-01T10:00:00Z',
    'pos-a',
    1
  );

select
  pg_temp.mk_order (
    'o-slow-2',
    'shift-e0',
    'complete',
    'hall',
    '2030-03-01T11:00:00Z',
    'pos-a',
    1
  );

select
  results_eq (
    $$select app.accounting_next_work() ->> 'status',
             app.accounting_next_work() -> 'head' ->> 'order_id',
             (app.accounting_next_work() -> 'head' ->> 'work_generation')::integer$$,
    $$values ('ok', 'o-ok-1', 1)$$,
    'the peek names the head of the queue and its generation'
  );

select
  results_eq (
    $$select r ->> 'status', r -> 'head' ->> 'order_id'
      from (select app.run_accounting_work('a5400000-0000-4000-8000-000000000101', 1, 'o-slow-2', 1) as r) x$$,
    $$values ('stale', 'o-ok-1')$$,
    'a call bound to an order that is not the head is stale and names the real head'
  );

select
  is_empty (
    $$select 1 from app.accounting_work_completions where attempt_id = 'a5400000-0000-4000-8000-000000000101'
      union all select 1 from app.accounting_work_attempts where order_id in ('o-ok-1', 'o-slow-2')
      union all select 1 from app.accounting_work_state where order_id in ('o-ok-1', 'o-slow-2')$$,
    'a stale call changed nothing'
  );

-- A call that names no order is maintenance: it processes nothing even though
-- two orders are pending, writes no per-order row, and names the head.
create temp table maintenance_run as
select
  app.run_accounting_work ('a5400000-0000-4000-8000-000000000105', 10) as r;

select
  results_eq (
    $$select r ->> 'status', (r ->> 'processed')::integer, (r ->> 'failed')::integer,
             r -> 'head' ->> 'order_id', (r -> 'head' ->> 'work_generation')::integer
      from maintenance_run$$,
    $$values ('processed', 0, 0, 'o-ok-1', 1)$$,
    'a call with no order processes nothing and returns the head'
  );

select
  is_empty (
    $$select 1 from app.accounting_work_completions where attempt_id = 'a5400000-0000-4000-8000-000000000105'
      union all select 1 from app.accounting_work_attempts where order_id in ('o-ok-1', 'o-slow-2')
      union all select 1 from app.accounting_work_state where order_id in ('o-ok-1', 'o-slow-2')
      union all select 1 from app.order_cost_state where order_id in ('o-ok-1', 'o-slow-2')
      union all select 1 from app.order_cost_applications where order_id in ('o-ok-1', 'o-slow-2')$$,
    'and leaves no evidence, state or receipt for any order'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        order_id in ('o-ok-1', 'o-slow-2')
        and processed_at is null
    ),
    2::bigint,
    'and both pending events stay open'
  );

-- Bound to the head the maintenance call named, with room for ten orders, the
-- call still takes that one order only.
create temp table room_run as
select
  app.run_accounting_work (
    'a5400000-0000-4000-8000-000000000102',
    10,
    m.r -> 'head' ->> 'order_id',
    (m.r -> 'head' ->> 'work_generation')::integer
  ) as r
from
  maintenance_run m;

select
  results_eq (
    $$select (r ->> 'processed')::integer, (r ->> 'none')::integer, (r ->> 'failed')::integer,
             (r ->> 'remaining')::integer, r -> 'head' ->> 'order_id'
      from room_run$$,
    $$values (1, 1, 0, 1, 'o-slow-2')$$,
    'the bound call takes the head only and names the next order'
  );

set
  local statement_timeout = '400ms';

create temp table bound_slow_run as
select
  pg_temp.run_with_timeout (
    'a5400000-0000-4000-8000-000000000103',
    'o-slow-2',
    1
  ) as r;

set
  local statement_timeout = 0;

select
  is (
    (
      select
        r
      from
        bound_slow_run
    ),
    'canceled',
    'the slow bound call is cancelled and rolls back'
  );

select
  is (
    app.record_accounting_call_failure (
      'a5400000-0000-4000-8000-000000000103',
      'o-slow-2',
      1
    ) ->> 'status',
    'recorded',
    'the report charges the order the call was bound to'
  );

select
  is (
    app.record_accounting_call_failure (
      'a5400000-0000-4000-8000-000000000104',
      'o-ok-1',
      1
    ) ->> 'status',
    'no_work',
    'a report naming the healthy, already processed order charges nothing'
  );

select
  results_eq (
    $$select ws.order_id, ws.attempts, ws.failed_at is null
      from app.accounting_work_state ws where ws.order_id in ('o-ok-1', 'o-slow-2') order by 1$$,
    $$values ('o-ok-1', 0, true), ('o-slow-2', 1, true)$$,
    'only the slow order carries the failure; the healthy order is at zero'
  );

select
  results_eq (
    $$select t.order_id from app.accounting_work_attempts t where t.order_id in ('o-ok-1', 'o-slow-2')$$,
    $$values ('o-slow-2')$$,
    'the healthy order has no attempt row'
  );

select
  set_config('p54.boom', 'off', true);

select
  is (
    pg_temp.drain () ->> 'status',
    'empty',
    'the charged order recovers once the fault is gone'
  );

select
  results_eq (
    $$select ws.attempts, ws.failed_at is null from app.accounting_work_state ws where ws.order_id = 'o-slow-2'$$,
    $$values (0, true)$$,
    'a success resets the count'
  );

-- ---------------------------------------------------------------------------
-- A caught attempt that is repeated is charged once.
-- ---------------------------------------------------------------------------
select
  set_config('p54.boom', 'plain', true);

select
  pg_temp.mk_order (
    'o-fail-rep',
    'shift-e0',
    'complete',
    'hall',
    '2030-03-02T10:00:00Z',
    'pos-a',
    1
  );

select
  app.run_accounting_work (
    'a5400000-0000-4000-8000-000000000111',
    1,
    'o-fail-rep',
    1
  )
from
  generate_series(1, 5);

select
  results_eq (
    $$select ws.attempts, ws.failed_at is null, ws.last_error_code
      from app.accounting_work_state ws where ws.order_id = 'o-fail-rep'$$,
    $$values (1, true, 'XX000')$$,
    'one attempt id repeated five times is charged once and does not park the order'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_attempts
      where
        order_id = 'o-fail-rep'
    ),
    1::bigint,
    'and leaves one attempt row'
  );

select
  app.run_accounting_work (gen_random_uuid(), 1, 'o-fail-rep', 1);

select
  results_eq (
    $$select ws.attempts from app.accounting_work_state ws where ws.order_id = 'o-fail-rep'$$,
    $$values (2)$$,
    'a different attempt id is a new attempt'
  );

select
  set_config('p54.boom', 'off', true);

select
  is (
    pg_temp.drain () ->> 'status',
    'empty',
    'the order recovers once the fault is gone'
  );

-- ---------------------------------------------------------------------------
-- A running POS sync defers the worker.
-- ---------------------------------------------------------------------------
drop trigger p54_boom on app.order_cost_applications;

select
  pg_temp.mk_order (
    'o-sync',
    'shift-e1',
    'complete',
    'hall',
    '2030-06-26T10:00:00Z',
    'pos-a',
    1
  );

create temp table run_ids as
select
  app.start_pos_sync_run ('recent') as id;

select
  is (
    pg_temp.work () ->> 'status',
    'sync_running',
    'the worker defers while a sync run is open'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        order_id = 'o-sync'
        and processed_at is null
    ),
    1::bigint,
    'a deferred call leaves the order pending'
  );

select
  app.finish_pos_sync_run (
    (
      select
        id
      from
        run_ids
    ),
    'ok',
    null,
    null
  );

select
  is (
    (pg_temp.work () ->> 'applied')::integer,
    1,
    'the order is posted once the sync has finished'
  );

-- ---------------------------------------------------------------------------
-- Bulk span: keyset pages of 100.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'o-bulk-' || lpad(n::text, 3, '0'),
    'shift-e0',
    'complete',
    'hall',
    '2029-12-31T09:00:00Z'::timestamptz + n * interval '1 second',
    'pos-bulk',
    1
  )
from
  generate_series(1, 120) as n;

select
  pg_temp.map_stock (
    'pos-bulk',
    'a5400000-0000-4000-8000-00000000000a',
    '1',
    '2029-12-01T00:00:00Z',
    '2030-01-01T00:00:00Z'
  );

set
  local statement_timeout = 0;

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        cause = 'pos_input'
        and order_id like 'o-bulk-%'
        and processed_at is null
    ),
    120::bigint,
    'all 120 bulk orders are pending before the maintenance call'
  );

create temp table bulk_first as
select
  app.run_accounting_work (gen_random_uuid(), 1) as r;

select
  results_eq (
    $$select orders_enqueued, completed_at is null
      from app.accounting_rederive_spans
      where family = 'pos_map' and effective_to = '2030-01-01T00:00:00Z'$$,
    $$values (100::bigint, true)$$,
    'a call with no order still expands at most 100 orders of a span'
  );

select
  results_eq (
    $$select (r ->> 'processed')::integer, (r ->> 'failed')::integer, r ->> 'status',
             r -> 'head' ->> 'order_id' is not null
      from bulk_first$$,
    $$values (0, 0, 'processed', true)$$,
    'while processing none of the pending orders'
  );

select
  is_empty (
    $$select 1 from app.accounting_work_state where order_id like 'o-bulk-%'
      union all select 1 from app.order_cost_state where order_id like 'o-bulk-%'
      union all select 1 from app.order_cost_applications where order_id like 'o-bulk-%'$$,
    'and touches no per-order row'
  );

select
  pg_temp.work (1);

select
  results_eq (
    $$select orders_enqueued, completed_at is not null
      from app.accounting_rederive_spans
      where family = 'pos_map' and effective_to = '2030-01-01T00:00:00Z'$$,
    $$values (121::bigint, true)$$,
    'the next call finishes the span with the keyset cursor'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        cause = 'config_span'
        and order_id like 'o-bulk-%'
    ),
    120::bigint,
    'every bulk order got exactly one span event'
  );

set
  local statement_timeout = 0;

select
  lives_ok (
    $$select pg_temp.drain()$$,
    'the bulk orders drain'
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_state h
      where
        h.order_id like 'o-bulk-%'
        and h.disposition = 'none'
    ),
    120::bigint,
    'orders before stock start take no stock'
  );

-- ---------------------------------------------------------------------------
-- Public resolver is unchanged on identical input.
-- ---------------------------------------------------------------------------
select
  is_empty (
    $$select o.id
      from app.pos_orders o
      join lateral (
        select i.snapshot_id from app.pos_cost_inputs i
        where i.order_id = o.id order by i.input_revision desc limit 1
      ) li on true
      where o.status = 'complete'
        and not o.missing_from_pos
        and o.id in (select order_id from app.order_cost_state where disposition in ('sale', 'incomplete'))
        and (app.resolve_order_requirements(o.id, null) - 'provenance')
            is distinct from
            (app.round_order_requirements(app.resolve_order_snapshot_exact(li.snapshot_id)) - 'provenance')$$,
    'the snapshot resolver matches the owner resolver on every sale and incomplete order'
  );

select
  is (
    (
      select
        jsonb_typeof(
          app.resolve_order_snapshot_exact (
            (
              select
                snapshot_id
              from
                app.pos_cost_inputs
              where
                order_id = 'o-pre'
              order by
                input_revision desc
              limit
                1
            )
          ) -> 'provenance' -> 'loss_versions'
        )
    ),
    'array',
    'ready snapshots carry the applied loss versions'
  );

select
  is (
    (
      select
        jsonb_typeof(
          app.resolve_order_snapshot_exact (
            (
              select
                snapshot_id
              from
                app.pos_cost_inputs
              where
                order_id = 'o-pre'
              order by
                input_revision desc
              limit
                1
            )
          ) -> 'provenance' -> 'conversion_versions'
        )
    ),
    'array',
    'ready snapshots carry the applied conversion versions'
  );

select
  is (
    app.resolve_order_snapshot_exact (
      (
        select
          snapshot_id
        from
          app.pos_cost_inputs
        where
          order_id = 'o-open'
        order by
          input_revision desc
        limit
          1
      ),
      false
    ) ->> 'status',
    'sales_only',
    'an open order is not eligible'
  );

select
  is (
    app.resolve_order_snapshot_exact (
      (
        select
          snapshot_id
        from
          app.pos_cost_inputs
        where
          order_id = 'o-open'
        order by
          input_revision desc
        limit
          1
      ),
      true
    ) ->> 'status',
    'ready',
    'preparation mode bypasses only the eligibility gate'
  );

select
  is (
    app.resolve_order_snapshot_exact (
      (
        select
          snapshot_id
        from
          app.pos_cost_inputs
        where
          order_id = 'o-pre'
        order by
          input_revision desc
        limit
          1
      ),
      false,
      true
    ) ->> 'status',
    'sales_only',
    'a missing order is not eligible'
  );

select
  throws_ok (
    $$select app.resolve_order_snapshot_exact(-1)$$,
    '22023',
    'unknown snapshot',
    'an unknown snapshot is refused'
  );

-- ---------------------------------------------------------------------------
-- Forward then replay inserts nothing.
-- ---------------------------------------------------------------------------
create temp table replay_before as
select
  pg_temp.engine_count () as moves,
  (
    select
      count(*)
    from
      app.stock_movements
  ) as all_moves,
  (
    select
      count(*)
    from
      app.order_cost_applications
    where
      receipt_kind = 'posting'
  ) as postings,
  (
    select
      count(*)
    from
      app.order_cost_movement_links
  ) as links;

insert into
  app.accounting_work_events (order_id, cause, source_key)
select
  h.order_id,
  'decision',
  'test:replay:' || h.order_id
from
  app.order_cost_state h;

set
  local statement_timeout = 0;

select
  lives_ok (
    $$select pg_temp.drain()$$,
    'a replay of every order completes'
  );

select
  results_eq (
    $$select pg_temp.engine_count(),
             (select count(*) from app.stock_movements),
             (select count(*) from app.order_cost_applications where receipt_kind = 'posting'),
             (select count(*) from app.order_cost_movement_links)$$,
    $$select moves, all_moves, postings, links from replay_before$$,
    'forward then replay inserts no movement, no posting receipt and no link'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events
      where
        processed_at is null
    ),
    0::bigint,
    'no event is left open'
  );

select
  is_empty (
    $$select order_id from app.order_cost_state h
      where h.owner_application_id is not null
        and not exists (
          select 1 from app.order_cost_movement_links l
          where l.application_id = h.owner_application_id)$$,
    'every owned application has its movements linked'
  );

select
  is_empty (
    $$select l.movement_id from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where m.source_type <> 'engine' or m.movement_type not in ('sale', 'waste')$$,
    'links point only at engine sale and prepared-waste movements'
  );

-- ---------------------------------------------------------------------------
-- A sale that turns incomplete and is repaired keeps its place among the
-- events at the same instant (design 5.5).
-- ---------------------------------------------------------------------------
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
    'a5400000-0000-4000-8000-00000000000b',
    'p54-ev',
    'seafood',
    'kg',
    'daily',
    0,
    null
  );

insert into
  app.item_loss_versions (
    effective_from,
    created_change_id,
    item_id,
    loss_pct
  )
values
  (
    '2000-01-01 00:00:00+00',
    (
      select
        id
      from
        app.costing_changes
      where
        request_id = 'a5400000-0000-4000-8000-0000000000c0'
    ),
    'a5400000-0000-4000-8000-00000000000b',
    0
  );

select
  pg_temp.policies ('pos-ev');

select
  pg_temp.map_stock (
    'pos-ev',
    'a5400000-0000-4000-8000-00000000000b',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'a5400000-0000-4000-8000-00000000000b', 'movement_type', 'opening',
      'occurred_at', '2030-07-02T08:00:00Z', 'quantity', 1, 'unit_cost', 10
    )))$$,
    'the item opens with one unit at 10'
  );

select
  is (
    pg_temp.drain () ->> 'status',
    'empty',
    'the new mapping drains'
  );

create function pg_temp.live_cost (p_order text) returns numeric language sql as $$
  select
    coalesce(sum(abs(m.total_cost)), 0)
  from
    app.order_cost_movement_links l
    join app.stock_movements m on m.id = l.movement_id
  where
    l.application_id = (
      select h.owner_application_id from app.order_cost_state h where h.order_id = p_order
    );
$$;

select
  pg_temp.mk_order (
    'o-ev',
    'shift-e1',
    'complete',
    'hall',
    '2030-07-02T10:00:00Z',
    'pos-ev',
    1
  );

select
  is (
    (pg_temp.drain () ->> 'applied')::integer,
    1,
    'the sale is posted'
  );

select
  is (
    pg_temp.live_cost ('o-ev'),
    10::numeric,
    'it takes the only unit, at 10'
  );

create temp table ev_before as
select
  h.event_position,
  h.owner_application_id
from
  app.order_cost_state h
where
  h.order_id = 'o-ev';

select
  isnt (
    (
      select
        event_position
      from
        ev_before
    ),
    null,
    'the order took a position at its first sale'
  );

-- The order moves before the item opened: it turns incomplete and its sale is retired.
select
  pg_temp.edit_order ('o-ev', null, null, null, '2030-07-02T07:00:00Z');

select
  is (
    (pg_temp.drain () ->> 'incomplete')::integer,
    1,
    'the order turns incomplete'
  );

select
  results_eq (
    $$select h.disposition, h.owner_application_id is null, h.event_position
      from app.order_cost_state h where h.order_id = 'o-ev'$$,
    $$select 'incomplete', true, event_position from ev_before$$,
    'it no longer owns an application but keeps its position'
  );

-- A purchase arrives at the instant of the original sale.
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(jsonb_build_object(
      'item_id', 'a5400000-0000-4000-8000-00000000000b', 'movement_type', 'purchase',
      'occurred_at', '2030-07-02T10:00:00Z', 'quantity', 1, 'unit_cost', 30
    )))$$,
    'a purchase of one unit at 30 arrives at the same instant as the sale'
  );

-- The gap is repaired: the order moves back to its instant.
select
  pg_temp.edit_order ('o-ev', null, null, null, '2030-07-02T10:00:00Z');

select
  is (
    (pg_temp.drain () ->> 'applied')::integer,
    1,
    'the repaired order posts a new sale'
  );

select
  results_eq (
    $$select h.event_position, h.owner_application_id is distinct from b.owner_application_id
      from app.order_cost_state h, ev_before b where h.order_id = 'o-ev'$$,
    $$select event_position, true from ev_before$$,
    'the replacement application keeps the original position'
  );

select
  results_eq (
    $$select m.event_position = b.event_position
      from app.order_cost_state h
      join app.order_cost_movement_links l on l.application_id = h.owner_application_id
      join app.stock_movements m on m.id = l.movement_id, ev_before b
      where h.order_id = 'o-ev'$$,
    $$values (true)$$,
    'and so does the new sale movement'
  );

select
  is (
    pg_temp.live_cost ('o-ev'),
    10::numeric,
    'the repaired sale still replays before the same-instant purchase and costs 10, not 20'
  );

select
  is (
    pg_temp.state_of (
      $$update app.order_cost_state set event_position = event_position + 1 where order_id = 'o-ev'$$
    ),
    '55000',
    'an order event position cannot be changed'
  );

select
  is (
    pg_temp.state_of (
      $$update app.order_cost_state set event_position = null where order_id = 'o-ev'$$
    ),
    '55000',
    'or cleared'
  );

-- ---------------------------------------------------------------------------
-- Append-only guards.
-- ---------------------------------------------------------------------------
select
  is (
    pg_temp.state_of (
      $$update app.accounting_work_completions set outcome = 'none'$$
    ),
    '55000',
    'completion evidence cannot be updated'
  );

select
  is (
    pg_temp.state_of ($$delete from app.accounting_work_completions$$),
    '55000',
    'completion evidence cannot be deleted'
  );

select
  ok (
    pg_temp.state_of ($$truncate app.accounting_work_completions$$) in ('55000', '0A000'),
    'completion evidence cannot be truncated'
  );

select
  is (
    pg_temp.state_of (
      $$update app.order_cost_applications set signature = repeat('0', 32)$$
    ),
    '55000',
    'applications cannot be updated'
  );

select
  is (
    pg_temp.state_of ($$delete from app.order_cost_applications$$),
    '55000',
    'applications cannot be deleted'
  );

select
  ok (
    pg_temp.state_of ($$truncate app.order_cost_applications$$) in ('55000', '0A000'),
    'applications cannot be truncated'
  );

select
  is (
    pg_temp.state_of (
      $$update app.order_cost_movement_links set item_id = item_id$$
    ),
    '55000',
    'links cannot be updated'
  );

select
  is (
    pg_temp.state_of ($$delete from app.order_cost_movement_links$$),
    '55000',
    'links cannot be deleted'
  );

select
  ok (
    pg_temp.state_of ($$truncate app.order_cost_movement_links$$) in ('55000', '0A000'),
    'links cannot be truncated'
  );

select
  is (
    pg_temp.state_of (
      $$update app.accounting_work_attempts set reason = 'error'$$
    ),
    '55000',
    'attempts cannot be updated'
  );

select
  is (
    pg_temp.state_of ($$delete from app.accounting_work_attempts$$),
    '55000',
    'attempts cannot be deleted'
  );

select
  is (
    pg_temp.state_of (
      $$update app.accounting_work_events set order_id = 'x'$$
    ),
    '55000',
    'event identity is immutable'
  );

select
  is (
    pg_temp.state_of (
      $$update app.accounting_work_events set work_generation = 99 where work_generation is not null$$
    ),
    '55000',
    'a claimed event keeps its generation'
  );

select
  is (
    pg_temp.state_of (
      $$update app.accounting_work_events set processed_at = now() where processed_at is not null$$
    ),
    '55000',
    'a processed event keeps its processed time'
  );

select
  is (
    pg_temp.state_of ($$delete from app.accounting_work_events$$),
    '55000',
    'events cannot be deleted'
  );

select
  ok (
    pg_temp.state_of ($$truncate app.accounting_work_events$$) in ('55000', '0A000'),
    'events cannot be truncated'
  );

select
  is (
    pg_temp.state_of (
      $$update app.accounting_rederive_spans set effective_from = effective_from - interval '1 day'$$
    ),
    '55000',
    'span identity is immutable'
  );

select
  is (
    pg_temp.state_of ($$delete from app.accounting_rederive_spans$$),
    '55000',
    'spans cannot be deleted'
  );

select
  ok (
    pg_temp.state_of ($$truncate app.accounting_rederive_spans$$) in ('55000', '0A000'),
    'spans cannot be truncated'
  );

-- ---------------------------------------------------------------------------
-- Unrelated histories are replayed as separate components (design 8.5). The
-- 100000-row cap is per replay, so the proxy for it is the item set every
-- replay loads, logged when the scratch table is next truncated.
-- ---------------------------------------------------------------------------
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
    'a5400000-0000-4000-8000-00000000000c',
    'p54-comp-x',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-00000000000d',
    'p54-comp-y',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-00000000000e',
    'p54-comp-mix',
    'fish_mixed',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5400000-0000-4000-8000-00000000000f',
    'p54-comp-size',
    'fish_size',
    'kg',
    'daily',
    0,
    'a5400000-0000-4000-8000-00000000000e'
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
      request_id = 'a5400000-0000-4000-8000-0000000000c0'
  ),
  i.id,
  0
from
  app.stock_items i
where
  i.name like 'p54-comp-%';

select
  is (
    (
      select
        count(*)
      from
        app.replay_components (
          array[
            'a5400000-0000-4000-8000-00000000000d',
            'a5400000-0000-4000-8000-00000000000c'
          ]::uuid[]
        )
    ),
    2::bigint,
    'two unrelated items are two components'
  );

select
  results_eq (
    $$select member_ids from app.replay_components(array[
        'a5400000-0000-4000-8000-00000000000d',
        'a5400000-0000-4000-8000-00000000000c',
        'a5400000-0000-4000-8000-00000000000c']::uuid[])$$,
    $$values (array['a5400000-0000-4000-8000-00000000000c']::uuid[]),
             (array['a5400000-0000-4000-8000-00000000000d']::uuid[])$$,
    'components come in ascending order of their lowest item, each item once'
  );

select
  results_eq (
    $$select member_ids from app.replay_components(array[
        'a5400000-0000-4000-8000-00000000000f',
        'a5400000-0000-4000-8000-00000000000d',
        'a5400000-0000-4000-8000-00000000000e',
        'a5400000-0000-4000-8000-00000000000c']::uuid[])$$,
    $$values (array['a5400000-0000-4000-8000-00000000000c']::uuid[]),
             (array['a5400000-0000-4000-8000-00000000000d']::uuid[]),
             (array['a5400000-0000-4000-8000-00000000000e',
                    'a5400000-0000-4000-8000-00000000000f']::uuid[])$$,
    'a mixed fish and its size item stay one component'
  );

select
  is_empty (
    $$select 1 from app.replay_components(array[null, null]::uuid[])$$,
    'no item, no component'
  );

select
  is_empty (
    $$select 1 from app.replay_components(null)$$,
    'a missing list has no component'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-00000000000c', 'movement_type', 'opening',
        'occurred_at', '2030-08-01T08:00:00Z', 'quantity', 100, 'unit_cost', 10),
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-00000000000d', 'movement_type', 'opening',
        'occurred_at', '2030-08-01T08:00:00Z', 'quantity', 100, 'unit_cost', 20),
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-00000000000e', 'movement_type', 'opening',
        'occurred_at', '2030-08-01T08:00:00Z', 'quantity', 100, 'unit_cost', 30),
      jsonb_build_object('item_id', 'a5400000-0000-4000-8000-00000000000f', 'movement_type', 'opening',
        'occurred_at', '2030-08-01T08:00:00Z', 'quantity', 100, 'unit_cost', 40)
    ))$$,
    'the four stock items open'
  );

select
  pg_temp.policies ('pos-cx');

select
  pg_temp.policies ('pos-cy');

select
  pg_temp.policies ('pos-cz');

select
  pg_temp.map_stock (
    'pos-cx',
    'a5400000-0000-4000-8000-00000000000c',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-cy',
    'a5400000-0000-4000-8000-00000000000d',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-cz',
    'a5400000-0000-4000-8000-00000000000f',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  is (
    pg_temp.drain () ->> 'status',
    'empty',
    'the new mappings drain'
  );

create table public.p54_replay_log (n serial primary key, items uuid[] not null);

create function public.p54_log_replay () returns trigger language plpgsql as $$
begin
  insert into public.p54_replay_log (items)
  select coalesce(array_agg(distinct r.item_id order by r.item_id), '{}')
  from ledger_scratch.recompute_row r;

  return null;
end;
$$;

create trigger p54_log_replay
before truncate on ledger_scratch.recompute_row for each statement
execute function public.p54_log_replay ();

truncate ledger_scratch.recompute_row;

delete from public.p54_replay_log;

select
  pg_temp.mk_order (
    'o-comp-1',
    'shift-e1',
    'complete',
    'hall',
    '2030-08-01T10:00:00Z',
    'pos-cx',
    2,
    'pos-cy',
    3
  );

select
  is (
    (pg_temp.drain () ->> 'applied')::integer,
    1,
    'an order that consumes two unrelated items is posted'
  );

truncate ledger_scratch.recompute_row;

select
  is (
    pg_temp.net_qty (
      'o-comp-1',
      'a5400000-0000-4000-8000-00000000000c'
    ),
    -2::numeric,
    'the first item is taken in full'
  );

select
  is (
    pg_temp.net_qty (
      'o-comp-1',
      'a5400000-0000-4000-8000-00000000000d'
    ),
    -3::numeric,
    'the second item is taken in full'
  );

select
  is_empty (
    $$select n from public.p54_replay_log
      where items @> array['a5400000-0000-4000-8000-00000000000c']::uuid[]
        and items @> array['a5400000-0000-4000-8000-00000000000d']::uuid[]$$,
    'posting never replays the two unrelated items together'
  );

select
  results_eq (
    $$select count(*) filter (where items = array['a5400000-0000-4000-8000-00000000000c']::uuid[]),
             count(*) filter (where items = array['a5400000-0000-4000-8000-00000000000d']::uuid[])
      from public.p54_replay_log$$,
    $$values (2::bigint, 2::bigint)$$,
    'each item is valued and then confirmed in a replay of its own'
  );

select
  ok (
    (
      select
        min(m.id)
      from
        app.stock_movements m
      where
        m.item_id = 'a5400000-0000-4000-8000-00000000000c'
        and m.source_type = 'engine'
    ) < (
      select
        min(m.id)
      from
        app.stock_movements m
      where
        m.item_id = 'a5400000-0000-4000-8000-00000000000d'
        and m.source_type = 'engine'
    ),
    'components are posted in ascending order of their lowest item'
  );

delete from public.p54_replay_log;

select
  pg_temp.edit_order ('o-comp-1', 4, null);

select
  is (
    (pg_temp.drain () ->> 'applied')::integer,
    1,
    'the edited order is retired and posted again'
  );

truncate ledger_scratch.recompute_row;

select
  is_empty (
    $$select n from public.p54_replay_log
      where items @> array['a5400000-0000-4000-8000-00000000000c']::uuid[]
        and items @> array['a5400000-0000-4000-8000-00000000000d']::uuid[]$$,
    'retirement and reposting never replay the two unrelated items together'
  );

select
  results_eq (
    $$select count(*) filter (where items = array['a5400000-0000-4000-8000-00000000000c']::uuid[]),
             count(*) filter (where items = array['a5400000-0000-4000-8000-00000000000d']::uuid[])
      from public.p54_replay_log$$,
    $$values (3::bigint, 3::bigint)$$,
    'each item is replayed once to retire and twice to post'
  );

select
  results_eq (
    $$select pg_temp.net_qty('o-comp-1', 'a5400000-0000-4000-8000-00000000000c'),
             pg_temp.net_qty('o-comp-1', 'a5400000-0000-4000-8000-00000000000d')$$,
    $$values (-4::numeric, -4::numeric)$$,
    'only the new quantities are left on the ledger'
  );

delete from public.p54_replay_log;

select
  pg_temp.mk_order (
    'o-comp-2',
    'shift-e1',
    'complete',
    'hall',
    '2030-08-01T11:00:00Z',
    'pos-cx',
    1,
    'pos-cz',
    1
  );

select
  is (
    (pg_temp.drain () ->> 'applied')::integer,
    1,
    'an order that consumes a size item and an unrelated item is posted'
  );

truncate ledger_scratch.recompute_row;

select
  is_empty (
    $$select n from public.p54_replay_log
      where items && array['a5400000-0000-4000-8000-00000000000c']::uuid[]
        and items && array['a5400000-0000-4000-8000-00000000000e',
                           'a5400000-0000-4000-8000-00000000000f']::uuid[]$$,
    'the unrelated item is never replayed with the mixed fish family'
  );

select
  ok (
    exists (
      select
        1
      from
        public.p54_replay_log
      where
        items @> array[
          'a5400000-0000-4000-8000-00000000000e',
          'a5400000-0000-4000-8000-00000000000f'
        ]::uuid[]
    ),
    'the size item is replayed together with its mixed fish'
  );

drop trigger p54_log_replay on ledger_scratch.recompute_row;

drop table public.p54_replay_log;

drop function public.p54_log_replay ();

-- ---------------------------------------------------------------------------
-- Privileges and RLS.
-- ---------------------------------------------------------------------------
select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5400000-0000-4000-8000-0000000000a2',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  throws_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 1)$$,
    '42501',
    null::text,
    'a non-owner cannot run the worker'
  );

select
  throws_ok (
    $$select app.record_accounting_call_failure(gen_random_uuid(), 'o-fail', 1)$$,
    '42501',
    null::text,
    'a non-owner cannot report a failed call'
  );

select
  throws_ok (
    $$select app.retry_accounting_work('o-fail')$$,
    '42501',
    null::text,
    'a non-owner cannot retry'
  );

select
  throws_ok (
    $$select app.process_order_accounting('o-pre', gen_random_uuid(), 1)$$,
    '42501',
    null::text,
    'the coordinator is not callable'
  );

select
  is_empty (
    $$select order_id from app.order_cost_state$$,
    'a non-owner sees no order cost state'
  );

select
  is_empty (
    $$select id from app.order_cost_applications$$,
    'a non-owner sees no applications'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5400000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  isnt_empty (
    $$select order_id from app.order_cost_state$$,
    'the owner reads the order cost state'
  );

select
  isnt_empty (
    $$select id from app.order_cost_applications$$,
    'the owner reads the applications'
  );

select
  isnt_empty (
    $$select id from app.accounting_work_events$$,
    'the owner reads the work events'
  );

select
  throws_ok (
    $$insert into app.accounting_work_events (order_id, cause, source_key) values ('x', 'decision', 'k')$$,
    '42501',
    null::text,
    'the owner cannot write work events through the API'
  );

select
  throws_ok (
    $$insert into app.inventory_activation (stock_started_at, request_id, opening_manifest_hash)
      values (now(), gen_random_uuid(), repeat('a', 32))$$,
    '42501',
    null::text,
    'no API role can write the activation row'
  );

select
  throws_ok (
    $$update app.order_cost_state set disposition = 'none'$$,
    '42501',
    null::text,
    'the owner cannot write the order cost state through the API'
  );

select
  lives_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 1)$$,
    'the owner may run the worker'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    '{"role":"service_role"}',
    true
  );

set
  local role service_role;

select
  lives_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 1)$$,
    'service_role may run the worker'
  );

select
  isnt_empty (
    $$select order_id from app.order_cost_state$$,
    'service_role reads the order cost state'
  );

select
  throws_ok (
    $$insert into app.accounting_work_state (order_id) values ('x')$$,
    '42501',
    null::text,
    'service_role cannot write work state'
  );

reset role;

select
  set_config('request.jwt.claims', '{"role":"anon"}', true);

set
  local role anon;

select
  throws_ok (
    $$select app.run_accounting_work(gen_random_uuid(), 1)$$,
    '42501',
    null::text,
    'anon cannot run the worker'
  );

select
  throws_ok (
    $$select order_id from app.order_cost_state$$,
    '42501',
    null::text,
    'anon cannot read the order cost state'
  );

reset role;

select
  *
from
  finish ();

rollback;
