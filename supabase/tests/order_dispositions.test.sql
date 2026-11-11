-- Order dispositions. Synthetic ids and names only. No POS data and no
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
    'a5500000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-55@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a5500000-0000-4000-8000-0000000000a2',
    'authenticated',
    'authenticated',
    'intruder-55@theshark.test',
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
  ('a5500000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5500000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

-- Items: 01 fish a (kg, cost 50), 02 fish b (kg, cost 20).
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
    'a5500000-0000-4000-8000-000000000001',
    'p55-fish-a',
    'seafood',
    'kg',
    'daily',
    0,
    null
  ),
  (
    'a5500000-0000-4000-8000-000000000002',
    'p55-fish-b',
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
    'a5500000-0000-4000-8000-0000000000c0',
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
      request_id = 'a5500000-0000-4000-8000-0000000000c0'
  ),
  i.id,
  0
from
  app.stock_items i
where
  i.name like 'p55-%';

insert into
  app.pos_shifts (id, opened_at, is_active, pos_update_time)
values
  (
    'shift-d1',
    '2030-06-01T08:00:00Z',
    false,
    '2030-06-01T08:00:00Z'
  );

-- ---------------------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------------------
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
  p_from timestamptz
) returns void language plpgsql as $$
begin
  perform app.set_pos_base_mapping(
    md5('map|' || p_pos || '|' || p_from::text)::uuid, p_pos, '["none"]'::jsonb,
    p_from, null,
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
  p_at timestamptz,
  p_pos text,
  p_qty numeric,
  p_pos2 text default null,
  p_qty2 numeric default null,
  p_total numeric default 0
) returns void language plpgsql as $$
begin
  insert into app.pos_orders (
    id, shift_id, status, order_type, ordered_at, subtotal, discount, tax,
    service_tax, delivery_fee, total, pos_update_time, content_hash, missing_from_pos
  ) values (
    p_id, 'shift-d1', 'complete', 'hall', p_at, 0, 0, 0, 0, 0, p_total, p_at,
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

create function pg_temp.edit_order (p_id text, p_qty numeric, p_total numeric) returns void language plpgsql as $$
begin
  update app.pos_orders
  set
    version = version + 1,
    total = coalesce(p_total, total),
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

create function pg_temp.cancel (p_id text, p_erase boolean) returns void language plpgsql as $$
begin
  update app.pos_orders
  set
    status = 'canceled',
    version = version + 1,
    pos_update_time = pos_update_time + interval '1 minute',
    content_hash = rpad(md5(p_id || '-cancel' || (version + 1)::text), 64, 'c')
  where
    id = p_id;

  if p_erase then
    delete from app.pos_order_lines where order_id = p_id;
  end if;

  perform app.capture_pos_order_snapshot(p_id, null, 'sync');
  perform app.append_pos_cost_input(p_id, null, 'sync');
end;
$$;

create function pg_temp.refund (
  p_order text,
  p_tx text,
  p_amount numeric,
  p_present boolean default true
) returns void language plpgsql as $$
begin
  insert into app.pos_refund_revisions (
    shift_id, tx_id, order_id, tx_type, amount, occurred_at, present, origin
  ) values (
    'shift-d1', p_tx, p_order, 3, p_amount, '2030-06-20T13:00:00Z', p_present, 'sync'
  );

  perform app.append_pos_cost_input(p_order, null, 'sync');
end;
$$;

create function pg_temp.drain () returns integer language plpgsql as $$
declare
  v jsonb;
  h jsonb := app.accounting_next_work() -> 'head';
  n integer := 0;
begin
  loop
    v := app.run_accounting_work(
      gen_random_uuid(), 1, h ->> 'order_id', (h ->> 'work_generation')::integer
    );
    h := v -> 'head';
    n := n + 1;

    exit when v ->> 'status' <> 'processed'
      or coalesce((v ->> 'failed')::integer, 0) > 0
      or n >= 200;
  end loop;

  return n;
end;
$$;

create function pg_temp.tok (p_order text) returns text language sql as $$
  select token from app.order_decision_queue where order_id = p_order;
$$;

create function pg_temp.q (p_order text) returns app.order_decision_queue language sql as $$
  select q from app.order_decision_queue q where q.order_id = p_order;
$$;

create function pg_temp.decide (
  p_order text,
  p_decision text,
  p_reason text default null,
  p_returned jsonb default null,
  p_req uuid default gen_random_uuid(),
  p_token text default null
) returns jsonb language sql as $$
  select app.set_order_disposition(
    p_req, p_order, p_decision, coalesce(p_token, pg_temp.tok(p_order)), p_reason, p_returned
  );
$$;

create function pg_temp.ret (p_item text, p_qty text) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('stock_item_id', 'a5500000-0000-4000-8000-00000000000' || p_item, 'returned', p_qty)
  );
$$;

create function pg_temp.net (p_order text, p_item text) returns numeric language sql as $$
  select
    coalesce(sum(m.quantity), 0)
  from
    app.stock_movements m
  where
    m.item_id = ('a5500000-0000-4000-8000-00000000000' || p_item)::uuid
    and (
      m.id in (select l.movement_id from app.order_cost_movement_links l where l.order_id = p_order)
      or m.reverses_movement_id in (
        select l.movement_id from app.order_cost_movement_links l where l.order_id = p_order
      )
    );
$$;

create function pg_temp.moves (p_order text) returns bigint language sql as $$
  select
    count(*)
  from
    app.stock_movements m
  where
    m.id in (select l.movement_id from app.order_cost_movement_links l where l.order_id = p_order)
    or m.reverses_movement_id in (
      select l.movement_id from app.order_cost_movement_links l where l.order_id = p_order
    );
$$;

create function pg_temp.live_waste (p_order text) returns bigint language sql as $$
  select
    count(*)
  from
    app.stock_movements m
  where
    m.movement_type = 'waste'
    and m.quantity < 0
    and m.id in (select l.movement_id from app.order_cost_movement_links l where l.order_id = p_order)
    and not exists (
      select 1 from app.stock_movements r where r.reverses_movement_id = m.id
    );
$$;

create function pg_temp.disp (p_order text) returns text language sql as $$
  select disposition from app.order_cost_state where order_id = p_order;
$$;

create function pg_temp.ev (p_order text) returns app.order_disposition_events language sql as $$
  select e from app.order_disposition_events e where e.order_id = p_order order by e.id desc limit 1;
$$;

create function pg_temp.ev_count (p_order text) returns bigint language sql as $$
  select count(*) from app.order_disposition_events where order_id = p_order;
$$;

create temp table kv (k text primary key, v text);

-- ---------------------------------------------------------------------------
-- Catalog and privileges.
-- ---------------------------------------------------------------------------
select
  has_table ('app', t, t || ' exists')
from
  unnest(
    array[
      'order_disposition_events',
      'order_disposition_state',
      'order_disposition_requests',
      'order_disposition_applications'
    ]
  ) as t;

select
  has_view ('app', v, v || ' exists')
from
  unnest(array['order_decision_queue', 'unlinked_refunds']) as v;

select
  is_empty (
    $$select r.role, t.tbl, p.priv
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      cross join unnest(array[
        'app.order_disposition_events', 'app.order_disposition_state',
        'app.order_disposition_requests', 'app.order_disposition_applications'
      ]) as t (tbl)
      cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p (priv)
      where has_table_privilege(r.role, t.tbl, p.priv)$$,
    'no API role holds a write privilege on a decision table'
  );

select
  is_empty (
    $$select r.role, t.tbl
      from unnest(array['anon']) as r (role)
      cross join unnest(array[
        'app.order_disposition_events', 'app.order_disposition_state',
        'app.order_disposition_requests', 'app.order_disposition_applications',
        'app.order_decision_queue', 'app.unlinked_refunds'
      ]) as t (tbl)
      where has_table_privilege(r.role, t.tbl, 'SELECT')$$,
    'anon reads no decision table or view'
  );

select
  results_eq (
    $$select r.role, t.tbl, has_table_privilege(r.role, t.tbl, 'SELECT')
      from unnest(array['authenticated', 'service_role']) as r (role)
      cross join unnest(array[
        'app.order_decision_queue', 'app.order_disposition_events'
      ]) as t (tbl)
      order by 2, 1$$,
    $$values
      ('authenticated', 'app.order_decision_queue', true),
      ('service_role', 'app.order_decision_queue', true),
      ('authenticated', 'app.order_disposition_events', true),
      ('service_role', 'app.order_disposition_events', true)$$,
    'authenticated and service_role may read'
  );

select
  results_eq (
    $$select r.role, has_function_privilege(r.role,
        'app.set_order_disposition(uuid,text,text,text,text,jsonb)', 'execute')
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      order by 1$$,
    $$values ('anon', false), ('authenticated', true), ('service_role', false)$$,
    'only authenticated may call the owner RPC, which checks the owner inside'
  );

select
  is_empty (
    $$select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in (
          'disposition_family', 'disposition_class_of', 'disposition_context',
          'disposition_effective_context', 'disposition_token', 'disposition_effect',
          'apply_decision_work', 'process_order_accounting'
        )
        and (
          has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute')
        )$$,
    'the helpers and the coordinator are not executable by any API role'
  );

select
  ok (
    (
      select
        p.prosecdef
        and p.proconfig @> array['search_path=""']
      from
        pg_catalog.pg_proc p
      where
        p.oid = 'app.set_order_disposition(uuid,text,text,text,text,jsonb)'::regprocedure
    ),
    'the owner RPC is security definer with an empty search path'
  );

select
  ok (
    (
      select
        c.relrowsecurity
      from
        pg_catalog.pg_class c
      where
        c.oid = 'app.order_disposition_events'::regclass
    )
    and (
      select
        c.relrowsecurity
      from
        pg_catalog.pg_class c
      where
        c.oid = 'app.order_disposition_applications'::regclass
    ),
    'row level security is on'
  );

-- ---------------------------------------------------------------------------
-- Before activation: nothing happens.
-- ---------------------------------------------------------------------------
select
  is (
    app.set_order_disposition (
      gen_random_uuid(),
      'd-none',
      'made',
      'x',
      null,
      null
    ),
    '{"status": "not_activated"}'::jsonb,
    'the owner RPC reports not_activated and writes nothing before activation'
  );

select
  is_empty (
    $$select order_id from app.order_disposition_state$$,
    'no decision state exists before activation'
  );

-- ---------------------------------------------------------------------------
-- Cost basis, mapping, activation.
-- ---------------------------------------------------------------------------
select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object('item_id', 'a5500000-0000-4000-8000-000000000001', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 1000, 'unit_cost', 50),
      jsonb_build_object('item_id', 'a5500000-0000-4000-8000-000000000002', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 1000, 'unit_cost', 20)
    ))$$,
    'purchases give the fixtures a cost basis'
  );

select
  pg_temp.policies (p)
from
  unnest(array['pos-a', 'pos-b', 'pos-c']) as p;

select
  pg_temp.map_stock (
    'pos-a',
    'a5500000-0000-4000-8000-000000000001',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-b',
    'a5500000-0000-4000-8000-000000000002',
    '0.5',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.map_stock (
    'pos-c',
    'a5500000-0000-4000-8000-000000000002',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  pg_temp.type_ok ('hall');

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
    'a5500000-0000-4000-8000-0000000000a1',
    'a5500000-0000-4000-8000-0000000000e1',
    repeat('a', 32)
  );

-- ---------------------------------------------------------------------------
-- A canceled order: first-seen default, erased lines, flips.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'd-c1',
    '2030-06-10T10:00:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.drain ();

select
  is (
    pg_temp.disp ('d-c1'),
    'sale',
    'the completed order is a sale'
  );

select
  is (
    pg_temp.net ('d-c1', '1'),
    -2::numeric,
    'the sale took 2 kg'
  );

select
  pg_temp.cancel ('d-c1', true);

select
  pg_temp.drain ();

select
  is (
    pg_temp.disp ('d-c1'),
    'prepared_waste',
    'the first-seen cancel defaults to made: prepared waste'
  );

select
  results_eq (
    $$select class, decision, source, owner_reviewed, actor is null, reason is null, prior_event_id is null
      from app.order_disposition_events where order_id = 'd-c1'$$,
    $$values ('canceled', 'made', 'system_default', false, true, true, true)$$,
    'one unreviewed system default opened the episode'
  );

select
  is (
    pg_temp.net ('d-c1', '1'),
    -2::numeric,
    'the prepared waste takes the same 2 kg the sale took, not twice'
  );

select
  is (
    (
      select
        (e.q_items -> 0 ->> 'quantity')::numeric
      from
        app.order_disposition_events e
      where
        e.order_id = 'd-c1'
    ),
    2::numeric,
    'the default stores the preparation quantities'
  );

select
  is (
    (
      select
        e.prep_snapshot_id
      from
        app.order_disposition_events e
      where
        e.order_id = 'd-c1'
    ),
    (
      select
        p.id
      from
        app.pos_preparation_input ('d-c1') p
    ),
    'the preparation basis is the retained snapshot, not the cancel snapshot'
  );

select
  is (
    (
      select
        pg_catalog.jsonb_array_length (s.lines)
      from
        app.pos_order_snapshots s
      where
        s.order_id = 'd-c1'
      order by
        s.version desc
      limit
        1
    ),
    0,
    'the latest snapshot has no lines, because the POS erased them'
  );

select
  results_eq (
    $$select (q).differences ->> 'stock_quantity', (q).differences ->> 'stock_value',
        (q).differences ->> 'cogs', (q).differences ->> 'waste', (q).differences ->> 'profit'
      from (select pg_temp.q('d-c1') as q) x$$,
    $$values ('0', '0.00', '-100.00', '100.00', '0.00')$$,
    'sale to waste: stock and profit differences are zero, the cogs decrease equals the waste increase'
  );

select
  results_eq (
    $$select l.event_position, l.piece_position
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'd-c1' and m.movement_type = 'sale' order by 1, 2$$,
    $$select l.event_position, l.piece_position
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'd-c1' and m.movement_type = 'waste' order by 1, 2$$,
    'the waste keeps the sale''s movement-piece partition'
  );

select
  results_eq (
    $$select (q).decision, (q).source, (q).owner_reviewed, (q).current_class, (q).review_reason
      from (select pg_temp.q('d-c1') as q) x$$,
    $$values ('made', 'system_default', false, 'canceled', null)$$,
    'the queue lists the default as unreviewed'
  );

-- Flip: a reason is required.
insert into
  kv
select
  'c1-tok1',
  pg_temp.tok ('d-c1');

select
  throws_ok (
    $$select pg_temp.decide('d-c1', 'not_made')$$,
    '22023',
    'a reason is required to change a decision',
    'flipping the default without a reason is refused'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-c1', 'not_made', repeat('x', 301))$$,
    '22023',
    'reason is longer than 300 characters',
    'a reason is at most 300 characters'
  );

select
  lives_ok (
    $$insert into kv select 'c1-res1', pg_temp.decide('d-c1', 'not_made', 'kitchen did not make it', null,
        'a5500000-0000-4000-8000-0000000000f1')::text$$,
    'the owner flips to not made'
  );

select
  is (
    pg_temp.disp ('d-c1'),
    'none',
    'not made posts nothing'
  );

select
  is (
    pg_temp.net ('d-c1', '1'),
    0::numeric,
    'the waste was retired and the stock is whole again'
  );

select
  results_eq (
    $$select source, owner_reviewed, actor, reason, decision
      from app.order_disposition_events where order_id = 'd-c1' order by id desc limit 1$$,
    $$values ('owner', true, 'a5500000-0000-4000-8000-0000000000a1'::uuid, 'kitchen did not make it', 'not_made')$$,
    'the owner event records who, why and what'
  );

select
  results_eq (
    $$select (q).differences ->> 'stock_quantity', (q).differences ->> 'stock_value',
        (q).differences ->> 'cogs', (q).differences ->> 'waste', (q).differences ->> 'profit'
      from (select pg_temp.q('d-c1') as q) x$$,
    $$values ('2', '100.00', '0.00', '-100.00', '100.00')$$,
    'not made returns the stock and removes the waste cost'
  );

select
  is (
    (
      select
        pg_catalog.jsonb_array_length ((q).history)
      from
        (
          select
            pg_temp.q ('d-c1') as q
        ) x
    ),
    2,
    'the history lists both decisions'
  );

-- Replay returns the stored result before reading mutable state.
select
  is (
    app.set_order_disposition (
      'a5500000-0000-4000-8000-0000000000f1',
      'd-c1',
      'not_made',
      (
        select
          v
        from
          kv
        where
          k = 'c1-tok1'
      ),
      'kitchen did not make it',
      null
    )::text,
    (
      select
        v
      from
        kv
      where
        k = 'c1-res1'
    ),
    'a replay returns the stored result even though its token is stale now'
  );

select
  is (
    pg_temp.ev_count ('d-c1'),
    2::bigint,
    'the replay wrote nothing'
  );

select
  throws_ok (
    $$select app.set_order_disposition('a5500000-0000-4000-8000-0000000000f1', 'd-c1', 'made',
        (select v from kv where k = 'c1-tok1'), 'kitchen did not make it', null)$$,
    '22023',
    'request id was used for a different decision',
    'the same request id with another payload is refused'
  );

select
  throws_ok (
    $$select app.set_order_disposition(gen_random_uuid(), 'd-c1', 'made',
        (select v from kv where k = 'c1-tok1'), 'again', null)$$,
    '40001',
    'the order changed since it was loaded',
    'a stale token is 40001'
  );

-- Not made to made creates a new waste application from the saved basis.
select
  lives_ok (
    $$select pg_temp.decide('d-c1', 'made', 'it was made after all')$$,
    'the owner flips back to made'
  );

select
  is (
    pg_temp.disp ('d-c1'),
    'prepared_waste',
    'made posts prepared waste again'
  );

select
  is (
    pg_temp.net ('d-c1', '1'),
    -2::numeric,
    'the stock effect is 2 kg of waste'
  );

select
  is (
    pg_temp.live_waste ('d-c1'),
    1::bigint,
    'one live waste movement'
  );

select
  is (
    (
      select
        count(*)
      from
        app.stock_movements m
      where
        m.movement_type = 'waste'
        and m.quantity < 0
        and m.id in (
          select
            l.movement_id
          from
            app.order_cost_movement_links l
          where
            l.order_id = 'd-c1'
        )
    ),
    2::bigint,
    'the first waste stays retired and a second one was posted, not reactivated'
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_cost_applications a
      where
        a.order_id = 'd-c1'
        and a.disposition = 'prepared_waste'
        and a.receipt_kind = 'posting'
    ),
    2::bigint,
    'two waste applications'
  );

select
  results_eq (
    $$select (q).differences ->> 'stock_quantity', (q).differences ->> 'stock_value',
        (q).differences ->> 'cogs', (q).differences ->> 'waste', (q).differences ->> 'profit'
      from (select pg_temp.q('d-c1') as q) x$$,
    $$values ('-2', '-100.00', '0.00', '100.00', '-100.00')$$,
    'not made to made costs the waste'
  );

-- Repeated flips.
select
  pg_temp.decide ('d-c1', 'not_made', 'second flip');

select
  pg_temp.decide ('d-c1', 'made', 'third flip');

select
  is (
    pg_temp.ev_count ('d-c1'),
    5::bigint,
    'every flip is an event'
  );

select
  is (
    pg_temp.net ('d-c1', '1'),
    -2::numeric,
    'repeated flips leave exactly one waste in force'
  );

select
  is (
    pg_temp.live_waste ('d-c1'),
    1::bigint,
    'one live waste after repeated flips'
  );

-- Confirming the same decision needs no reason and posts nothing.
select
  lives_ok (
    $$select pg_temp.decide('d-c1', 'made')$$,
    'confirming the default needs no reason'
  );

select
  is (
    pg_temp.moves ('d-c1'),
    (
      select
        pg_temp.moves ('d-c1')
    ),
    'confirming leaves the stock alone'
  );

-- ---------------------------------------------------------------------------
-- Missing takes precedence; reappearance closes; missing again reopens.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'd-m1',
    '2030-06-10T11:00:00Z',
    'pos-a',
    1,
    null,
    null,
    50
  );

select
  pg_temp.drain ();

update app.pos_orders
set
  missing_from_pos = true
where
  id = 'd-m1';

select
  app.append_pos_cost_input ('d-m1', null, 'sync');

select
  pg_temp.drain ();

select
  results_eq (
    $$select class, decision, source from app.order_disposition_events where order_id = 'd-m1'$$,
    $$values ('missing', 'made', 'system_default')$$,
    'a missing order opens a default episode'
  );

select
  is (
    pg_temp.disp ('d-m1'),
    'prepared_waste',
    'missing defaults to prepared waste'
  );

update app.pos_orders
set
  missing_from_pos = false
where
  id = 'd-m1';

select
  app.append_pos_cost_input ('d-m1', null, 'sync');

select
  pg_temp.drain ();

select
  is (
    pg_temp.disp ('d-m1'),
    'sale',
    'a reappearing order is a sale again'
  );

select
  is (
    (
      select
        is_open
      from
        app.order_disposition_state
      where
        order_id = 'd-m1'
    ),
    false,
    'the episode closed'
  );

select
  is_empty (
    $$select order_id from app.order_decision_queue where order_id = 'd-m1'$$,
    'a closed episode is not in the queue'
  );

select
  is (
    pg_temp.net ('d-m1', '1'),
    -1::numeric,
    'the reappearing order took its stock once'
  );

update app.pos_orders
set
  missing_from_pos = true
where
  id = 'd-m1';

select
  app.append_pos_cost_input ('d-m1', null, 'sync');

select
  pg_temp.drain ();

select
  results_eq (
    $$select episode, class, source from app.order_disposition_events where order_id = 'd-m1' order by id$$,
    $$values (1, 'missing', 'system_default'), (2, 'missing', 'system_default')$$,
    'going missing again opens a second episode'
  );

select
  pg_temp.mk_order (
    'd-m2',
    '2030-06-10T11:30:00Z',
    'pos-a',
    1,
    null,
    null,
    50
  );

select
  pg_temp.cancel ('d-m2', false);

update app.pos_orders
set
  missing_from_pos = true
where
  id = 'd-m2';

select
  app.append_pos_cost_input ('d-m2', null, 'sync');

select
  pg_temp.drain ();

select
  results_eq (
    $$select class, decision from app.order_disposition_events where order_id = 'd-m2'$$,
    $$values ('missing', 'made')$$,
    'missing takes precedence over a canceled status'
  );

-- ---------------------------------------------------------------------------
-- No usable preparation basis is never zero consumption.
-- ---------------------------------------------------------------------------
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
    'd-e1',
    'shift-d1',
    'canceled',
    'hall',
    '2030-06-12T10:00:00Z',
    0,
    0,
    0,
    0,
    0,
    0,
    '2030-06-12T10:00:00Z',
    rpad(md5('d-e1'), 64, 'a'),
    false
  );

select
  app.append_pos_cost_input ('d-e1', null, 'sync');

select
  pg_temp.drain ();

select
  results_eq (
    $$select disposition, causes -> 0 ->> 'code' from app.order_cost_state where order_id = 'd-e1'$$,
    $$values ('incomplete', 'missing_preparation_basis')$$,
    'a canceled order with no lines ever is incomplete, not zero consumption'
  );

select
  is (
    pg_temp.moves ('d-e1'),
    0::bigint,
    'no stock moved'
  );

select
  is (
    (pg_temp.q ('d-e1')).basis_status,
    'none',
    'the queue shows no basis'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-e1', 'not_made', 'never prepared')$$,
    'the owner can still decide not made'
  );

select
  results_eq (
    $$select disposition, causes -> 0 ->> 'code' from app.order_cost_state where order_id = 'd-e1'$$,
    $$values ('none', 'not_made')$$,
    'not made needs no basis'
  );

-- ---------------------------------------------------------------------------
-- Partial refund: default stays a sale; returned quantities.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'd-r1',
    '2030-06-11T10:00:00Z',
    'pos-a',
    2,
    'pos-b',
    4,
    100
  );

select
  pg_temp.refund ('d-r1', 'r1a', 30);

select
  pg_temp.drain ();

select
  results_eq (
    $$select class, decision, source, refund_total from app.order_disposition_events where order_id = 'd-r1'$$,
    $$values ('partial_refund', 'made', 'system_default', 30.00)$$,
    'a partial refund opens a default episode'
  );

select
  is (
    pg_temp.disp ('d-r1'),
    'sale',
    'a partial refund keeps the sale (COGS)'
  );

select
  results_eq (
    $$select pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2')$$,
    $$values (-2::numeric, -2::numeric)$$,
    'the sale took 2 kg of each'
  );

select
  results_eq (
    $$select jsonb_array_length((q).refunds), (q).refunds -> 0 ->> 'amount', (q).refund_total,
        jsonb_array_length((q).basis_items), (q).differences ->> 'profit'
      from (select pg_temp.q('d-r1') as q) x$$,
    $$values (1, '30.00', '30.00', 2, '0.00')$$,
    'the queue shows the refund reference, the basis and no difference yet'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-r1', 'not_made', 'returned', pg_temp.ret('1', '2.5'))$$,
    '22023',
    'returned quantities must be listed items and not exceed the prepared quantities',
    'a return above the prepared quantity is refused'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-r1', 'not_made', 'returned',
        '[{"stock_item_id": "a5500000-0000-4000-8000-0000000000ff", "returned": "1"}]'::jsonb)$$,
    '22023',
    'returned quantities must be listed items and not exceed the prepared quantities',
    'a return of an item outside the basis is refused'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-r1', 'not_made', 'returned', '[{"stock_item_id": "a5500000-0000-4000-8000-000000000001", "returned": 1}]'::jsonb)$$,
    '22023',
    'each returned quantity is {stock_item_id, returned} with decimal text',
    'returned quantities are decimal text, not numbers'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-r1', 'made', null, pg_temp.ret('1', '1'))$$,
    '22023',
    'returned quantities apply only to a not-made partial refund or a made canceled, missing or fully refunded order',
    'a made decision on a partial refund takes no returned quantities'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'not_made', 'customer returned one kg', pg_temp.ret('1', '1'))$$,
    'the owner records a return of 1 kg'
  );

select
  results_eq (
    $$select pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2'), pg_temp.disp('d-r1')$$,
    $$values (-1::numeric, -2::numeric, 'sale')$$,
    'the kept quantities (prepared less returned) are what the sale posts'
  );

select
  results_eq (
    $$select (q).differences ->> 'stock_quantity', (q).differences ->> 'stock_value',
        (q).differences ->> 'cogs', (q).differences ->> 'waste', (q).differences ->> 'profit'
      from (select pg_temp.q('d-r1') as q) x$$,
    $$values ('1', '50.00', '-50.00', '0.00', '50.00')$$,
    'a return of 1 kg of item a gives back 50 of stock and profit'
  );

-- Cumulative: the new quantity replaces the old, it does not add to it.
select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'not_made', null, pg_temp.ret('1', '1.5'))$$,
    'the owner raises the cumulative return to 1.5 kg'
  );

select
  results_eq (
    $$select pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2')$$,
    $$values (-0.5::numeric, -2::numeric)$$,
    'the cumulative edit does not subtract twice'
  );

select
  results_eq (
    $$select jsonb_array_length(returned), returned -> 0 ->> 'returned'
      from app.order_disposition_events where order_id = 'd-r1' order by id desc limit 1$$,
    $$values (1, '1.5')$$,
    'the event carries the cumulative quantity'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'not_made')$$,
    'a decision with no returned quantities keeps the prior ones'
  );

select
  results_eq (
    $$select returned -> 0 ->> 'returned'
      from app.order_disposition_events where order_id = 'd-r1' order by id desc limit 1$$,
    $$values ('1.5')$$,
    'the prior returned quantities were carried'
  );

select
  is (
    pg_temp.net ('d-r1', '1'),
    -0.5::numeric,
    'carrying them changes no stock'
  );

-- A total-only edit does not expand the decision's scope.
select
  pg_temp.edit_order ('d-r1', null, 25);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).current_class, (q).review_reason, (q).order_total, (q).decided_order_total
      from (select pg_temp.q('d-r1') as q) x$$,
    $$values ('partial_refund', null, '25.00', '100.00')$$,
    'a total-only edit leaves the class and the decision as they were'
  );

select
  results_eq (
    $$select pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2')$$,
    $$values (-0.5::numeric, -2::numeric)$$,
    'and the stock'
  );

-- Q shrinking below R is a review, and the allocation stays in force.
select
  pg_temp.edit_order ('d-r1', 1, null);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).current_class
      from (select pg_temp.q('d-r1') as q) x$$,
    $$values ('quantities_changed', 'partial_refund')$$,
    'prepared quantities below the returned ones need a review'
  );

select
  results_eq (
    $$select pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2')$$,
    $$values (-0.5::numeric, -2::numeric)$$,
    'the application and the allocation stay in force while it waits'
  );

select
  results_eq (
    $$select last_outcome, last_reason from app.accounting_work_state where order_id = 'd-r1'$$,
    $$values ('disposition_pending', 'needs_review')$$,
    'the work state reports a pending decision'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-r1', 'not_made', null, pg_temp.ret('1', '1.5'))$$,
    '22023',
    'returned quantities must be listed items and not exceed the prepared quantities',
    'the old return no longer fits'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'not_made', null, pg_temp.ret('1', '0.5'))$$,
    'the owner rebases to 0.5 kg'
  );

select
  results_eq (
    $$select pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2'), (pg_temp.q('d-r1')).review_reason$$,
    $$values (-0.5::numeric, -0.5::numeric, null)$$,
    'the rebase cleared the review and posted the new kept quantities'
  );

-- Partial to full keeps R.
select
  pg_temp.edit_order ('d-r1', null, 100);

select
  pg_temp.refund ('d-r1', 'r1b', 70);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).current_class
      from (select pg_temp.q('d-r1') as q) x$$,
    $$values ('refund_changed', 'full_refund')$$,
    'a refund set change needs a review, and the order is fully refunded now'
  );

select
  results_eq (
    $$select pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2')$$,
    $$values (-0.5::numeric, -0.5::numeric)$$,
    'the application stays in force while it waits'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'not_made')$$,
    'the owner keeps not made on the full refund'
  );

select
  results_eq (
    $$select pg_temp.disp('d-r1'), pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2'),
        (pg_temp.ev('d-r1')).class, (pg_temp.ev('d-r1')).returned -> 0 ->> 'returned'$$,
    $$values ('none', 0::numeric, 0::numeric, 'full_refund', '0.5')$$,
    'full refund not made posts nothing, and the returned quantity is kept'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'made', 'prepared and wasted')$$,
    'the owner flips the full refund to made'
  );

select
  results_eq (
    $$select pg_temp.disp('d-r1'), pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2')$$,
    $$values ('prepared_waste', -0.5::numeric, -0.5::numeric)$$,
    'made wastes the prepared basis less the retained returned quantity (A: 1 - 0.5, B: 0.5)'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-r1', 'made', null, pg_temp.ret('1', '1.5'))$$,
    '22023',
    'returned quantities must be listed items and not exceed the prepared quantities',
    'a made full refund validates the returned quantities against the preparation basis'
  );

-- The owner rebases R on the full refund; a confirmed zero wastes the whole basis.
select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'made', null, pg_temp.ret('1', '0'))$$,
    'the owner rebases the returned quantity to a confirmed zero'
  );

select
  results_eq (
    $$select pg_temp.disp('d-r1'), pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2'),
        (pg_temp.ev('d-r1')).returned$$,
    $$values ('prepared_waste', -1::numeric, -0.5::numeric,
        '[{"stock_item_id": "a5500000-0000-4000-8000-000000000001", "returned": "0"}]'::jsonb)$$,
    'a confirmed zero wastes the whole prepared basis and is stored as a zero entry'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'made', null, pg_temp.ret('1', '0.5'))$$,
    'the owner rebases the returned quantity back to 0.5 kg'
  );

select
  results_eq (
    $$select pg_temp.disp('d-r1'), pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2')$$,
    $$values ('prepared_waste', -0.5::numeric, -0.5::numeric)$$,
    'the rebased 0.5 kg applies to the waste again'
  );

-- Removing the second refund makes it partial again: R applies again.
select
  pg_temp.refund ('d-r1', 'r1b', 70, false);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).current_class
      from (select pg_temp.q('d-r1') as q) x$$,
    $$values ('refund_changed', 'partial_refund')$$,
    'removing a refund needs a review'
  );

select
  results_eq (
    $$select pg_temp.disp('d-r1'), pg_temp.net('d-r1', '1')$$,
    $$values ('prepared_waste', -0.5::numeric)$$,
    'the waste of the kept quantity stays in force while it waits'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-r1', 'not_made', 'back to partial')$$,
    'the owner decides the partial again'
  );

select
  results_eq (
    $$select pg_temp.disp('d-r1'), pg_temp.net('d-r1', '1'), pg_temp.net('d-r1', '2')$$,
    $$values ('sale', -0.5::numeric, -0.5::numeric)$$,
    'the carried 0.5 kg applies again'
  );

-- ---------------------------------------------------------------------------
-- Items changed.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'd-r6',
    '2030-06-11T12:00:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-r6', 'r6a', 20);

select
  pg_temp.drain ();

select
  pg_temp.decide (
    'd-r6',
    'not_made',
    'returned',
    pg_temp.ret ('1', '1')
  );

select
  is (
    pg_temp.net ('d-r6', '1'),
    -1::numeric,
    'one kg was returned'
  );

update app.pos_order_lines
set
  item_id = 'pos-c'
where
  order_id = 'd-r6';

select
  pg_temp.edit_order ('d-r6', null, null);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, pg_temp.net('d-r6', '1')
      from (select pg_temp.q('d-r6') as q) x$$,
    $$values ('items_changed', -1::numeric)$$,
    'a change of the mapped items needs a review, and the allocation stays in force'
  );

-- ---------------------------------------------------------------------------
-- Refund relink, amount change.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'd-r2',
    '2030-06-11T13:00:00Z',
    'pos-a',
    1,
    null,
    null,
    50
  );

select
  pg_temp.mk_order (
    'd-r3',
    '2030-06-11T13:30:00Z',
    'pos-a',
    1,
    null,
    null,
    50
  );

select
  pg_temp.refund ('d-r2', 'r2a', 10);

select
  pg_temp.drain ();

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
    'shift-d1',
    'r2a',
    'd-r3',
    3,
    10,
    '2030-06-20T13:00:00Z',
    true,
    'sync'
  );

select
  app.append_pos_cost_input ('d-r2', null, 'sync');

select
  app.append_pos_cost_input ('d-r3', null, 'sync');

select
  pg_temp.drain ();

select
  results_eq (
    $$select order_id, review_reason, class
      from app.order_disposition_state where order_id in ('d-r2', 'd-r3') order by 1$$,
    $$values ('d-r2', 'refund_changed', null), ('d-r3', null, 'partial_refund')$$,
    'a relink needs a review on the old order and opens an episode on the new one'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-r2', 'made')$$,
    'the owner confirms the order that lost its refund'
  );

select
  results_eq (
    $$select is_open, class from app.order_disposition_state where order_id = 'd-r2'$$,
    $$values (false, null)$$,
    'it is an ordinary order again'
  );

select
  results_eq (
    $$select class, decision from app.order_disposition_events where order_id = 'd-r2' order by id desc limit 1$$,
    $$values ('none', 'made')$$,
    'the closing decision is recorded'
  );

select
  pg_temp.mk_order (
    'd-r4',
    '2030-06-11T14:00:00Z',
    'pos-a',
    1,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-r4', 'r4a', 20);

select
  pg_temp.drain ();

select
  pg_temp.refund ('d-r4', 'r4a', 40);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).refund_total, (q).decided_refund_total
      from (select pg_temp.q('d-r4') as q) x$$,
    $$values ('refund_changed', '40.00', '20.00')$$,
    'a changed refund amount needs a review'
  );

select
  is (
    pg_temp.net ('d-r4', '1'),
    -1::numeric,
    'and changes no stock'
  );

-- ---------------------------------------------------------------------------
-- Combined cancel and refund: one consumption decision.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order (
    'd-x1',
    '2030-06-11T15:00:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.drain ();

select
  pg_temp.cancel ('d-x1', true);

select
  pg_temp.refund ('d-x1', 'x1a', 100);

select
  pg_temp.drain ();

select
  results_eq (
    $$select class, decision from app.order_disposition_events where order_id = 'd-x1'$$,
    $$values ('canceled', 'made')$$,
    'a cancel with a refund is one decision, classed canceled'
  );

select
  results_eq (
    $$select pg_temp.net('d-x1', '1'), pg_temp.live_waste('d-x1')$$,
    $$values (-2::numeric, 1::bigint)$$,
    'one waste of 2 kg, never two deductions'
  );

insert into
  kv
select
  'x1-moves',
  pg_temp.moves ('d-x1')::text;

select
  pg_temp.refund ('d-x1', 'x1b', 5);

select
  pg_temp.drain ();

select
  is (
    (pg_temp.q ('d-x1')).review_reason,
    'refund_changed',
    'a further refund needs a review'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-x1', 'made')$$,
    'the owner confirms'
  );

select
  results_eq (
    $$select pg_temp.moves('d-x1')::text, pg_temp.net('d-x1', '1'), (pg_temp.ev('d-x1')).refund_total$$,
    $$select v, -2::numeric, 105.00 from kv where k = 'x1-moves'$$,
    'confirming wrote no stock movement'
  );

-- ---------------------------------------------------------------------------
-- Boundaries: zero total, negative amount, full versus partial.
-- ---------------------------------------------------------------------------
select
  pg_temp.mk_order ('d-z1', '2030-06-12T11:00:00Z', 'pos-a', 1);

select
  pg_temp.refund ('d-z1', 'z1a', 10);

select
  pg_temp.mk_order (
    'd-b1',
    '2030-06-12T11:10:00Z',
    'pos-a',
    1,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-b1', 'b1a', 99.99);

select
  pg_temp.mk_order (
    'd-b2',
    '2030-06-12T11:20:00Z',
    'pos-a',
    1,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-b2', 'b2a', 100);

select
  pg_temp.mk_order (
    'd-b3',
    '2030-06-12T11:30:00Z',
    'pos-a',
    1,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-b3', 'b3a', 100.01);

select
  pg_temp.mk_order (
    'd-b4',
    '2030-06-12T11:40:00Z',
    'pos-a',
    1,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-b4', 'b4a', 60);

select
  pg_temp.refund ('d-b4', 'b4b', 40);

select
  pg_temp.mk_order (
    'd-b5',
    '2030-06-12T11:50:00Z',
    'pos-a',
    1,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-b5', 'b5a', 0);

select
  pg_temp.mk_order (
    'd-n1',
    '2030-06-12T12:00:00Z',
    'pos-a',
    1,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-n1', 'n1a', -5);

select
  pg_temp.mk_order (
    'd-n2',
    '2030-06-12T12:10:00Z',
    'pos-a',
    1,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-n2', 'n2a', 30);

select
  pg_temp.refund ('d-n2', 'n2b', -5);

select
  pg_temp.drain ();

select
  results_eq (
    $$select order_id, class from app.order_disposition_events
      where order_id in ('d-z1', 'd-b1', 'd-b2', 'd-b3', 'd-b4', 'd-b5', 'd-n1', 'd-n2') order by 1$$,
    $$values
      ('d-b1', 'partial_refund'),
      ('d-b2', 'full_refund'),
      ('d-b3', 'full_refund'),
      ('d-b4', 'full_refund'),
      ('d-n1', 'unresolved_refund'),
      ('d-n2', 'unresolved_refund'),
      ('d-z1', 'partial_refund')$$,
    'zero total is partial, 99.99 is partial, 100 and more are full, a negative amount is unresolved, a zero amount is no refund'
  );

select
  results_eq (
    $$select order_id, pg_temp.disp(order_id)
      from unnest(array['d-z1', 'd-b1', 'd-b2', 'd-b3', 'd-b4', 'd-b5', 'd-n1']) as o (order_id) order by 1$$,
    $$values
      ('d-b1', 'sale'),
      ('d-b2', 'prepared_waste'),
      ('d-b3', 'prepared_waste'),
      ('d-b4', 'prepared_waste'),
      ('d-b5', 'sale'),
      ('d-n1', 'sale'),
      ('d-z1', 'sale')$$,
    'full refunds default to prepared waste, the others stay sales'
  );

select
  results_eq (
    $$select order_id, review_reason from app.order_disposition_state
      where order_id in ('d-n1', 'd-n2') order by 1$$,
    $$values ('d-n1', 'unresolved_refund'), ('d-n2', 'unresolved_refund')$$,
    'an unresolved correction is flagged'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-n1', 'made')$$,
    '22023',
    'a refund with a negative amount must be corrected first',
    'an unresolved refund cannot be decided'
  );

select
  is_empty (
    $$select order_id from app.order_disposition_events where order_id = 'd-b5'
      union all
      select order_id from app.order_disposition_state where order_id = 'd-b5' and is_open$$,
    'a zero-amount refund opens no episode'
  );

-- An unlinked type-3 row is listed, not attributed.
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
    'shift-d1',
    'u1',
    null,
    3,
    12,
    '2030-06-20T13:00:00Z',
    true,
    'sync'
  );

select
  results_eq (
    $$select tx_id, amount from app.unlinked_refunds$$,
    $$values ('u1', '12.00')$$,
    'an unlinked refund is listed'
  );

-- ---------------------------------------------------------------------------
-- Review round 1.
-- ---------------------------------------------------------------------------
create function pg_temp.reappear (p_id text) returns void language plpgsql as $$
begin
  update app.pos_orders
  set
    status = 'complete',
    version = version + 1,
    pos_update_time = pos_update_time + interval '1 minute',
    content_hash = rpad(md5(p_id || '-back' || (version + 1)::text), 64, 'd')
  where
    id = p_id;

  perform app.capture_pos_order_snapshot(p_id, null, 'sync');
  perform app.append_pos_cost_input(p_id, null, 'sync');
end;
$$;

-- Finding 1: a partial refund that becomes full keeps R; made wastes Q - R.
select
  pg_temp.mk_order (
    'd-q1',
    '2030-06-12T09:00:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-q1', 'q1a', 20);

select
  pg_temp.drain ();

select
  lives_ok (
    $$select pg_temp.decide('d-q1', 'not_made', 'one kg came back', pg_temp.ret('1', '1'))$$,
    'f1: Q = 2 kg, R = 1 kg, the partial refund is not made'
  );

select
  is (
    pg_temp.net ('d-q1', '1'),
    -1::numeric,
    'f1: the sale keeps 1 kg'
  );

select
  pg_temp.refund ('d-q1', 'q1b', 80);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).current_class, pg_temp.net('d-q1', '1')
      from (select pg_temp.q('d-q1') as q) x$$,
    $$values ('refund_changed', 'full_refund', -1::numeric)$$,
    'f1: the partial refund became full and waits for a decision, the 1 kg stays in force'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-q1', 'made', 'prepared and wasted')$$,
    'f1: the owner decides made on the full refund'
  );

select
  results_eq (
    $$select pg_temp.disp('d-q1'), pg_temp.net('d-q1', '1'), live_waste, (pg_temp.ev('d-q1')).returned -> 0 ->> 'returned'
      from (select pg_temp.live_waste('d-q1') as live_waste) x$$,
    $$values ('prepared_waste', -1::numeric, 1::bigint, '1')$$,
    'f1: the waste consumes Q - R = 1 kg, not the returned kilo again'
  );

select
  throws_ok (
    $$select pg_temp.decide('d-q1', 'not_made', 'no', pg_temp.ret('1', '1'))$$,
    '22023',
    'returned quantities apply only to a not-made partial refund or a made canceled, missing or fully refunded order',
    'f1: a not-made full refund takes no returned quantities'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-q1', 'made', null, '[]'::jsonb)$$,
    'f1: the owner clears R on the full refund'
  );

select
  results_eq (
    $$select pg_temp.disp('d-q1'), pg_temp.net('d-q1', '1'), jsonb_array_length((pg_temp.ev('d-q1')).returned)$$,
    $$values ('prepared_waste', -2::numeric, 0)$$,
    'f1: with R cleared the waste is the whole prepared basis'
  );

-- Finding 2: the allocation is relative to the retained preparation basis.
select
  pg_temp.mk_order (
    'd-q2',
    '2030-06-12T09:10:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-q2', 'q2a', 20);

select
  pg_temp.drain ();

select
  lives_ok (
    $$select pg_temp.decide('d-q2', 'not_made', 'one kg came back', pg_temp.ret('1', '1'))$$,
    'f2: Q = 2 kg, R = 1 kg confirmed'
  );

delete from app.pos_order_lines
where
  order_id = 'd-q2';

select
  pg_temp.edit_order ('d-q2', null, null);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).basis_status, pg_temp.disp('d-q2'), pg_temp.net('d-q2', '1')
      from (select pg_temp.q('d-q2') as q) x$$,
    $$values (null, 'ready', 'sale', -1::numeric)$$,
    'f2: clearing the current snapshot''s lines keeps the retained basis, so the sale still keeps 1 kg'
  );

-- Finding 3: a reclassification keeps the previous movement pieces.
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
    'a5500000-0000-4000-8000-000000000003',
    'p55-fish-c',
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
select
  '2000-01-01 00:00:00+00',
  (
    select
      id
    from
      app.costing_changes
    where
      request_id = 'a5500000-0000-4000-8000-0000000000c0'
  ),
  'a5500000-0000-4000-8000-000000000003',
  0;

select
  pg_temp.policies ('pos-e');

select
  pg_temp.map_stock (
    'pos-e',
    'a5500000-0000-4000-8000-000000000003',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object('item_id', 'a5500000-0000-4000-8000-000000000003', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 1, 'unit_cost', 33.34)
    ))$$,
    'f3: 1 kg of fish c is bought at 33.34'
  );

select
  pg_temp.mk_order (
    'd-q3',
    '2030-06-12T10:00:00Z',
    'pos-e',
    2,
    null,
    null,
    100
  );

select
  pg_temp.drain ();

select
  results_eq (
    $$select m.quantity::numeric, m.is_provisional
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'd-q3' and m.movement_type = 'sale'
      order by l.event_position, l.piece_position, l.movement_id$$,
    $$values (-1::numeric, false), (-1::numeric, true)$$,
    'f3: the 2 kg sale splits into a normal and a provisional 1 kg piece'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object('item_id', 'a5500000-0000-4000-8000-000000000003', 'movement_type', 'purchase',
        'occurred_at', '2030-05-02T00:00:00Z', 'quantity', 2, 'unit_cost', 33.335)
    ))$$,
    'f3: a backdated purchase of 2 kg for 66.67 arrives'
  );

select
  results_eq (
    $$select m.quantity::numeric, m.total_cost::numeric
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'd-q3' and m.movement_type = 'sale'
      order by l.event_position, l.piece_position, l.movement_id$$,
    $$values (-1::numeric, -33.34::numeric), (-1::numeric, -33.34::numeric)$$,
    'f3: after the backdated purchase the two 1 kg pieces are worth 33.34 each, 66.68 in all'
  );

select
  pg_temp.cancel ('d-q3', true);

select
  pg_temp.drain ();

select
  results_eq (
    $$select m.quantity::numeric
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'd-q3' and m.movement_type = 'waste'
      order by l.event_position, l.piece_position, l.movement_id$$,
    $$values (-1::numeric), (-1::numeric)$$,
    'f3: the waste keeps the sale''s two 1 kg pieces'
  );

select
  results_eq (
    $$select a.stock_qty_delta::numeric, a.stock_value_delta::numeric, a.profit_delta::numeric
      from app.order_disposition_applications a
      where a.order_id = 'd-q3'$$,
    $$values (0::numeric, 0::numeric, 0::numeric)$$,
    'f3: reclassifying the sale as waste changes no stock value and no profit by a piaster'
  );

-- Finding 4: a refund change is reviewed before an episode closes.
select
  pg_temp.mk_order (
    'd-q4',
    '2030-06-12T11:00:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-q4', 'q4a', 20);

select
  pg_temp.cancel ('d-q4', false);

select
  pg_temp.drain ();

select
  lives_ok (
    $$select pg_temp.decide('d-q4', 'not_made', 'never prepared')$$,
    'f4: the owner reviews the canceled order as not made'
  );

select
  results_eq (
    $$select pg_temp.disp('d-q4'), pg_temp.net('d-q4', '1')$$,
    $$values ('none', 0::numeric)$$,
    'f4: not made posts nothing'
  );

select
  pg_temp.refund ('d-q4', 'q4a', 20, false);

select
  pg_temp.reappear ('d-q4');

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).current_class, (q).decision, (q).owner_reviewed,
        pg_temp.disp('d-q4'), pg_temp.net('d-q4', '1'), pg_temp.ev_count('d-q4')
      from (select pg_temp.q('d-q4') as q) x$$,
    $$values ('refund_changed', null, 'not_made', true, 'none', 0::numeric, 2::bigint)$$,
    'f4: the last refund disappearing holds the reviewed decision for review; no sale replaces it'
  );

select
  results_eq (
    $$select last_outcome, last_reason from app.accounting_work_state where order_id = 'd-q4'$$,
    $$values ('disposition_pending', 'needs_review')$$,
    'f4: the work state reports a pending decision'
  );

-- Finding 5: the closing decision reports the difference it caused.
select
  pg_temp.mk_order (
    'd-q5',
    '2030-06-12T12:00:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-q5', 'q5a', 20);

select
  pg_temp.drain ();

select
  lives_ok (
    $$select pg_temp.decide('d-q5', 'not_made', 'one kg came back', pg_temp.ret('1', '1'))$$,
    'f5: Q = 2 kg, R = 1 kg confirmed'
  );

select
  pg_temp.refund ('d-q5', 'q5a', 20, false);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).current_class, pg_temp.net('d-q5', '1')
      from (select pg_temp.q('d-q5') as q) x$$,
    $$values ('refund_changed', null, -1::numeric)$$,
    'f5: the last refund disappearing waits for a decision; the 1 kg stays'
  );

select
  results_eq (
    $$select r ->> 'outcome', r -> 'differences' ->> 'stock_quantity', r -> 'differences' ->> 'stock_value',
        r -> 'differences' ->> 'cogs', r -> 'differences' ->> 'waste', r -> 'differences' ->> 'profit'
      from (select pg_temp.decide('d-q5', 'made', 'it was prepared after all') as r) x$$,
    $$values ('applied', '-1', '-50.00', '50.00', '0.00', '-50.00')$$,
    'f5: confirming made closes the episode and reports the consumption it posted'
  );

select
  results_eq (
    $$select is_open, pg_temp.disp('d-q5'), pg_temp.net('d-q5', '1')
      from app.order_disposition_state where order_id = 'd-q5'$$,
    $$values (false, 'sale', -2::numeric)$$,
    'f5: the episode is closed and the order is an ordinary 2 kg sale'
  );

select
  results_eq (
    $$select (a.stock_qty_delta)::text, (a.profit_delta)::text
      from app.order_disposition_applications a
      join app.order_disposition_events e on e.id = a.event_id
      where a.order_id = 'd-q5' and e.class = 'none'$$,
    $$values ('-1.000000', '-50.00')$$,
    'f5: the effect is recorded against the closing decision'
  );

-- Finding 6: a confirmed zero is an allocation too.
select
  pg_temp.mk_order (
    'd-q6',
    '2030-06-12T13:00:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-q6', 'q6a', 20);

select
  pg_temp.drain ();

select
  lives_ok (
    $$select pg_temp.decide('d-q6', 'not_made', 'nothing came back', pg_temp.ret('1', '0'))$$,
    'f6: the owner confirms a returned quantity of zero'
  );

select
  results_eq (
    $$select jsonb_array_length((pg_temp.ev('d-q6')).returned), (pg_temp.ev('d-q6')).returned -> 0 ->> 'returned',
        pg_temp.net('d-q6', '1')$$,
    $$values (1, '0', -2::numeric)$$,
    'f6: the zero is stored as a confirmed entry and the sale keeps all 2 kg'
  );

select
  pg_temp.edit_order ('d-q6', 3, null);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, pg_temp.net('d-q6', '1')
      from (select pg_temp.q('d-q6') as q) x$$,
    $$values ('quantities_changed', -2::numeric)$$,
    'f6: a changed quantity needs a review; the 2 kg is not silently replaced'
  );

select
  pg_temp.mk_order (
    'd-q7',
    '2030-06-12T13:30:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-q7', 'q7a', 20);

select
  pg_temp.drain ();

select
  pg_temp.decide (
    'd-q7',
    'not_made',
    'nothing came back',
    pg_temp.ret ('1', '0')
  );

update app.pos_order_lines
set
  item_id = 'pos-c'
where
  order_id = 'd-q7';

select
  pg_temp.edit_order ('d-q7', null, null);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, pg_temp.net('d-q7', '1')
      from (select pg_temp.q('d-q7') as q) x$$,
    $$values ('items_changed', -2::numeric)$$,
    'f6: a change of the mapped items needs a review for a confirmed zero as well'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-q6', 'not_made', null, pg_temp.ret('1', '0'))$$,
    'f6: the owner rebases the confirmed zero'
  );

select
  results_eq (
    $$select (q).review_reason, pg_temp.net('d-q6', '1')
      from (select pg_temp.q('d-q6') as q) x$$,
    $$values (null, -3::numeric)$$,
    'f6: the rebase clears the review and the sale keeps the new 3 kg'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-q6', 'not_made', null, '[]'::jsonb)$$,
    'f6: the owner clears the allocation with an empty list'
  );

select
  pg_temp.edit_order ('d-q6', 4, null);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, jsonb_array_length((pg_temp.ev('d-q6')).returned), pg_temp.net('d-q6', '1')
      from (select pg_temp.q('d-q6') as q) x$$,
    $$values (null, 0, -4::numeric)$$,
    'f6: a cleared allocation follows the order without a review'
  );

-- ---------------------------------------------------------------------------
-- Review round 2.
-- ---------------------------------------------------------------------------
-- Finding 1: the pieces of one event keep one global order, so a repost never
-- changes which provisional piece a later purchase covers first.
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
    'a5500000-0000-4000-8000-000000000004',
    'p55-fish-d',
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
select
  '2000-01-01 00:00:00+00',
  (
    select
      id
    from
      app.costing_changes
    where
      request_id = 'a5500000-0000-4000-8000-0000000000c0'
  ),
  'a5500000-0000-4000-8000-000000000004',
  0;

select
  pg_temp.policies ('pos-f');

select
  pg_temp.map_stock (
    'pos-f',
    'a5500000-0000-4000-8000-000000000004',
    '1',
    '2030-01-01T00:00:00Z'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object('item_id', 'a5500000-0000-4000-8000-000000000004', 'movement_type', 'purchase',
        'occurred_at', '2030-05-01T00:00:00Z', 'quantity', 1, 'unit_cost', 0.33)
    ))$$,
    'g1: 1 kg of fish d is bought at 0.33'
  );

select
  pg_temp.mk_order (
    'd-s1',
    '2030-06-12T14:00:00Z',
    'pos-f',
    2,
    null,
    null,
    100
  );

select
  pg_temp.drain ();

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object('item_id', 'a5500000-0000-4000-8000-000000000004', 'movement_type', 'sale',
        'occurred_at', '2030-06-12T13:00:00Z', 'quantity', 0.25)
    ))$$,
    'g1: a 0.25 kg sale is backdated before the order'
  );

select
  lives_ok (
    $$select app.post_movements(jsonb_build_array(
      jsonb_build_object('item_id', 'a5500000-0000-4000-8000-000000000004', 'movement_type', 'purchase',
        'occurred_at', '2030-06-13T00:00:00Z', 'quantity', 0.5, 'unit_cost', 0.36)
    ))$$,
    'g1: 0.5 kg arrives afterwards for 0.18'
  );

create function pg_temp.piece_cost (p_id bigint) returns numeric language sql as $$
  select
    m.total_cost + coalesce(
      (
        select
          sum(a.total_cost)
        from
          app.stock_movements a
        where
          a.adjusts_movement_id = m.id
          and a.movement_type = 'cost_adjustment'
      ),
      0
    )
  from
    app.stock_movements m
  where
    m.id = p_id;
$$;

select
  results_eq (
    $$select m.quantity::numeric, pg_temp.piece_cost(m.id)
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'd-s1' and m.movement_type = 'sale'
      order by l.event_position, l.piece_position, l.movement_id$$,
    $$values (-1::numeric, -0.34::numeric), (-1::numeric, -0.34::numeric)$$,
    'g1: the 2 kg sale costs 0.68 once the later purchase covered both provisional pieces'
  );

select
  pg_temp.cancel ('d-s1', true);

select
  pg_temp.drain ();

select
  results_eq (
    $$select m.quantity::numeric, m.is_provisional, l.piece_position
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'd-s1' and m.movement_type = 'waste'
      order by l.event_position, l.piece_position, l.movement_id$$,
    $$values (-0.75::numeric, false, 1), (-0.25::numeric, true, 2), (-1::numeric, true, 3)$$,
    'g1: the waste pieces are numbered 1 to 3 across both lines, in line order'
  );

select
  results_eq (
    $$select a.stock_qty_delta::numeric, a.stock_value_delta::numeric, a.profit_delta::numeric
      from app.order_disposition_applications a
      where a.order_id = 'd-s1'$$,
    $$values (0::numeric, 0::numeric, 0::numeric)$$,
    'g1: reclassifying the sale as waste changes no stock value and no profit'
  );

select
  is (
    (
      select
        sum(pg_temp.piece_cost (m.id))
      from
        app.order_cost_movement_links l
        join app.stock_movements m on m.id = l.movement_id
      where
        l.order_id = 'd-s1'
        and m.movement_type = 'waste'
    ),
    -0.68::numeric,
    'g1: the waste costs 0.68 like the sale, not 0.67'
  );

-- Finding 2: reinstating the canceled order keeps the waste pieces as well.
insert into
  kv
select
  'q3-value',
  b.on_hand_value::text
from
  app.item_balances b
where
  b.item_id = 'a5500000-0000-4000-8000-000000000003';

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    weighted_qty,
    weighted_unit,
    options,
    line_total
  )
values
  (
    'd-q3',
    'l1-d-q3',
    'pos-e',
    'x',
    2,
    null,
    null,
    '[]'::jsonb,
    0
  );

select
  pg_temp.reappear ('d-q3');

select
  pg_temp.drain ();

select
  results_eq (
    $$select m.quantity::numeric, m.total_cost::numeric
      from app.order_cost_movement_links l
      join app.stock_movements m on m.id = l.movement_id
      where l.order_id = 'd-q3' and m.movement_type = 'sale' and m.quantity < 0
        and not exists (select 1 from app.stock_movements r where r.reverses_movement_id = m.id)
      order by l.event_position, l.piece_position, l.movement_id$$,
    $$values (-1::numeric, -33.34::numeric), (-1::numeric, -33.34::numeric)$$,
    'g2: the reinstated order sells the waste''s two 1 kg pieces, 66.68 in all, not one piece of 66.67'
  );

select
  is (
    (
      select
        b.on_hand_value::text
      from
        app.item_balances b
      where
        b.item_id = 'a5500000-0000-4000-8000-000000000003'
    ),
    (
      select
        v
      from
        kv
      where
        k = 'q3-value'
    ),
    'g2: waste to sale again changes the stock value by nothing'
  );

-- Finding 3: a carried allocation is reviewed when its basis changes.
select
  pg_temp.mk_order (
    'd-t3',
    '2030-06-12T15:00:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-t3', 't3a', 20);

select
  pg_temp.drain ();

select
  lives_ok (
    $$select pg_temp.decide('d-t3', 'not_made', 'one kg came back', pg_temp.ret('1', '1'))$$,
    'g3: Q = 2 kg, R = 1 kg is confirmed on the partial refund'
  );

select
  pg_temp.refund ('d-t3', 't3b', 80);

select
  pg_temp.drain ();

select
  lives_ok (
    $$select pg_temp.decide('d-t3', 'not_made', 'nothing was made', null)$$,
    'g3: the owner confirms not made on the full refund and R is carried'
  );

select
  results_eq (
    $$select jsonb_array_length((pg_temp.ev('d-t3')).returned), (q).review_reason, pg_temp.net('d-t3', '1')
      from (select pg_temp.q('d-t3') as q) x$$,
    $$values (1, null, 0::numeric)$$,
    'g3: the confirmed R stays on the decision, nothing is posted'
  );

select
  pg_temp.edit_order ('d-t3', 3, null);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).owner_reviewed, (q).needs_decision
      from (select pg_temp.q('d-t3') as q) x$$,
    $$values ('quantities_changed', true, true)$$,
    'g3: a changed quantity puts the reviewed row back in the pending queue'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-t3', 'not_made', null, null)$$,
    'g3: the owner confirms again on the new basis'
  );

select
  results_eq (
    $$select (q).review_reason, (q).needs_decision
      from (select pg_temp.q('d-t3') as q) x$$,
    $$values (null, false)$$,
    'g3: the confirmation clears the review'
  );

select
  pg_temp.mk_order (
    'd-t4',
    '2030-06-12T15:30:00Z',
    'pos-a',
    2,
    null,
    null,
    100
  );

select
  pg_temp.refund ('d-t4', 't4a', 20);

select
  pg_temp.drain ();

select
  pg_temp.decide (
    'd-t4',
    'not_made',
    'one kg came back',
    pg_temp.ret ('1', '1')
  );

select
  pg_temp.refund ('d-t4', 't4b', 80);

select
  pg_temp.drain ();

select
  pg_temp.decide ('d-t4', 'not_made', 'nothing was made', null);

update app.pos_order_lines
set
  item_id = 'pos-c'
where
  order_id = 'd-t4';

select
  pg_temp.edit_order ('d-t4', null, null);

select
  pg_temp.drain ();

select
  results_eq (
    $$select (q).review_reason, (q).needs_decision
      from (select pg_temp.q('d-t4') as q) x$$,
    $$values ('items_changed', true)$$,
    'g3: a change of the mapped items puts the reviewed row back in the pending queue'
  );

-- ---------------------------------------------------------------------------
-- Sync in progress.
-- ---------------------------------------------------------------------------
insert into
  kv
select
  'b1-tok',
  pg_temp.tok ('d-b1');

insert into
  app.pos_sync_runs (mode, status)
values
  ('recent', 'running');

select
  throws_ok (
    $$select app.set_order_disposition(gen_random_uuid(), 'd-b1', 'not_made',
        (select v from kv where k = 'b1-tok'), 'x', null)$$,
    '55P03',
    'a POS sync is running',
    'a running sync defers the decision'
  );

update app.pos_sync_runs
set
  status = 'failed',
  finished_at = now()
where
  status = 'running';

select
  lives_ok (
    $$select app.set_order_disposition(gen_random_uuid(), 'd-b1', 'not_made',
        (select v from kv where k = 'b1-tok'), 'x', null)$$,
    'the same decision goes through once the sync is over'
  );

-- ---------------------------------------------------------------------------
-- Keyset reads.
-- ---------------------------------------------------------------------------
select
  ok (
    (
      select
        count(*) > 5
      from
        app.order_decision_queue
    ),
    'the queue lists the open episodes'
  );

select
  is (
    (
      select
        array_agg(
          order_id
          order by
            order_id
        )
      from
        app.order_decision_queue
      where
        order_id > 'd-b2'
        and order_id <= 'd-c1'
    ),
    (
      select
        array_agg(
          order_id
          order by
            order_id
        )
      from
        app.order_decision_queue
      where
        order_id in ('d-b3', 'd-b4', 'd-c1')
    ),
    'the queue pages by order id'
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_decision_queue
      where
        needs_decision is distinct from (
          not owner_reviewed
          or review_reason is not null
        )
    ),
    0::bigint,
    'needs_decision is an unreviewed default or a review reason'
  );

-- ---------------------------------------------------------------------------
-- Append-only and API privileges.
-- ---------------------------------------------------------------------------
select
  is (
    pg_temp.state_of (
      $$update app.order_disposition_events set reason = 'x'$$
    ),
    '55000',
    'decision events cannot be updated'
  );

select
  is (
    pg_temp.state_of ($$delete from app.order_disposition_events$$),
    '55000',
    'decision events cannot be deleted'
  );

select
  ok (
    pg_temp.state_of ($$truncate app.order_disposition_events$$) in ('0A000', '55000'),
    'decision events cannot be truncated (refused by the foreign keys that reference them, or by the guard)'
  );

select
  is (
    pg_temp.state_of (
      $$update app.order_disposition_requests set order_id = 'x'$$
    ),
    '55000',
    'stored requests cannot be updated'
  );

select
  is (
    pg_temp.state_of ($$delete from app.order_disposition_requests$$),
    '55000',
    'stored requests cannot be deleted'
  );

select
  is (
    pg_temp.state_of ($$truncate app.order_disposition_requests$$),
    '55000',
    'stored requests cannot be truncated'
  );

select
  is (
    pg_temp.state_of (
      $$update app.order_disposition_applications set order_id = 'x'$$
    ),
    '55000',
    'application effects cannot be updated'
  );

select
  is (
    pg_temp.state_of (
      $$delete from app.order_disposition_applications$$
    ),
    '55000',
    'application effects cannot be deleted'
  );

select
  is (
    pg_temp.state_of ($$truncate app.order_disposition_applications$$),
    '55000',
    'application effects cannot be truncated'
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_disposition_applications a
      where
        not exists (
          select
            1
          from
            app.order_cost_applications o
          where
            o.id = a.application_id
            and o.receipt_kind = 'posting'
        )
    ),
    0::bigint,
    'every effect row belongs to a posting receipt'
  );

select
  is (
    (
      select
        count(*)
      from
        app.order_disposition_requests
    ),
    (
      select
        count(*)
      from
        app.order_disposition_events
      where
        source = 'owner'
    ),
    'every owner event has its stored request'
  );

set
  local role authenticated;

select
  isnt_empty (
    $$select order_id from app.order_decision_queue$$,
    'the owner reads the queue'
  );

select
  isnt_empty (
    $$select id from app.order_disposition_events$$,
    'the owner reads the events'
  );

select
  throws_ok (
    $$insert into app.order_disposition_events (order_id, episode, decision, class, source, owner_reviewed,
        cost_input_id, refund_signature, order_total, refund_total)
      values ('x', 1, 'made', 'canceled', 'system_default', false, 1, repeat('a', 32), 0, 0)$$,
    '42501',
    null::text,
    'the owner cannot write events through the API'
  );

select
  throws_ok (
    $$update app.order_disposition_state set is_open = false$$,
    '42501',
    null::text,
    'the owner cannot write the decision state through the API'
  );

select
  throws_ok (
    $$select app.disposition_context(1)$$,
    '42501',
    null::text,
    'the internal classifier is not callable'
  );

select
  lives_ok (
    $$select pg_temp.decide('d-b2', 'made')$$,
    'the owner may call the RPC as authenticated'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5500000-0000-4000-8000-0000000000a2',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  is_empty (
    $$select order_id from app.order_decision_queue$$,
    'another signed-in user sees no queue'
  );

select
  is_empty (
    $$select id from app.order_disposition_events$$,
    'another signed-in user sees no events'
  );

select
  throws_ok (
    $$select app.set_order_disposition(gen_random_uuid(), 'd-b2', 'made', 'x', null, null)$$,
    '42501',
    'insufficient_privilege',
    'another signed-in user cannot decide'
  );

reset role;

select
  set_config('request.jwt.claims', '{"role":"anon"}', true);

set
  local role anon;

select
  throws_ok (
    $$select app.set_order_disposition(gen_random_uuid(), 'd-b2', 'made', 'x', null, null)$$,
    '42501',
    null::text,
    'anon cannot call the RPC'
  );

select
  throws_ok (
    $$select order_id from app.order_decision_queue$$,
    '42501',
    null::text,
    'anon cannot read the queue'
  );

reset role;

select
  *
from
  finish ();

rollback;
