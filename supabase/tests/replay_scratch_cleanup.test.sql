begin;

select
  plan (6);

create function pg_temp.check_small_replay_scratch () returns setof text language plpgsql as $$
declare
  v_owner constant uuid := '8a400000-0000-4000-8000-000000000001';
  v_item constant uuid := '8a400000-0000-4000-8000-000000000002';
  v_at constant timestamptz := date_trunc('second', clock_timestamp()) - interval '3 days';
  v_sale jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);

  truncate ledger_scratch.recompute_row,
    ledger_scratch.recompute_def,
    ledger_scratch.recompute_effect,
    ledger_scratch.recompute_override,
    ledger_scratch.recompute_anchor,
    ledger_scratch.recompute_seq;

  insert into ledger_scratch.recompute_row (
    movement_id, is_pending, batch_id, item_id, movement_type, occurred_at,
    quantity, unit_cost, total_cost, is_input_total, ord_class, line_key, consumed,
    event_position, piece_position
  ) values (
    1, true, '8a300000-0000-4000-8000-000000000001',
    '8a300000-0000-4000-8000-000000000002', 'sale', '2026-11-01 12:00:00+00',
    -1, 10, -10, false, 0, 1, false, 1, 0
  );
  insert into ledger_scratch.recompute_seq (next_id) values (1);

  return next lives_ok(
    'select app.replay_prepare_tables()',
    'small replay scratch cleanup succeeds in a worker session with safeupdate'
  );

  return next is(
    (select count(*) from ledger_scratch.recompute_row) +
    (select count(*) from ledger_scratch.recompute_seq),
    0::bigint,
    'small replay scratch cleanup removes the prior movement and sequence rows'
  );

  -- pg_prove logs in as postgres, while PostgREST preloads safeupdate as
  -- authenticator. Check every scratch DELETE in the routine in either session.
  return next is_empty(
    $query$select statement
    from regexp_matches(
      pg_get_functiondef('app.replay_prepare_tables()'::regprocedure),
      '(delete\s+from\s+ledger_scratch\.\w+\s*;)',
      'gi'
    ) as match (statement)$query$,
    'replay scratch cleanup contains no DELETE without a predicate'
  );

  insert into auth.users (id, aud, role, email)
  values (v_owner, 'authenticated', 'authenticated', 'provisional-replay@theshark.test');
  insert into app.owner (user_id) values (v_owner);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into app.stock_items (id, name, kind, base_unit, count_frequency)
  values (v_item, 'Provisional replay fixture', 'seafood', 'kg', 'daily');

  perform app.post_movements(jsonb_build_array(jsonb_build_object(
    'item_id', v_item, 'movement_type', 'purchase', 'occurred_at', v_at,
    'quantity', 1, 'unit_cost', 10
  )));
  perform app.post_movements(jsonb_build_array(jsonb_build_object(
    'item_id', v_item, 'movement_type', 'purchase', 'occurred_at', v_at + interval '2 days',
    'quantity', 1, 'unit_cost', 10
  )));
  v_sale := jsonb_build_array(jsonb_build_object(
    'item_id', v_item, 'movement_type', 'sale', 'occurred_at', v_at + interval '1 day',
    'quantity', 3
  ));

  return next lives_ok(
    format('select app.post_movements(%L::jsonb)', v_sale),
    'backdated sale with a known basis and insufficient stock survives safeupdate'
  );
  return next is(
    (
      select jsonb_agg(jsonb_build_array(sm.is_provisional, sm.quantity, sm.unit_cost, sm.total_cost)
        order by sm.is_provisional)
      from app.stock_movements sm
      where sm.item_id = v_item and sm.movement_type = 'sale'
    ),
    '[[false,-1,10,-10],[true,-2,10,-20]]'::jsonb,
    'backdated sale posts one known-cost unit and two provisional units'
  );
  return next is_empty(
    $query$select statement
    from regexp_matches(
      pg_get_functiondef('app.replay_outflow(bigint,uuid,app.movement_type,timestamptz,numeric,numeric,boolean,integer,text,text,text,text)'::regprocedure),
      '(update\s+ledger_scratch\.recompute_seq\s+set\s+next_id\s*=\s*next_id\s*\+\s*1\s+returning)',
      'gi'
    ) as match (statement)$query$,
    'provisional outflow updates the scratch sequence with a predicate'
  );
end;
$$;

select
  *
from
  pg_temp.check_small_replay_scratch ();

select
  *
from
  finish ();

rollback;
