begin;

select
  no_plan ();

-- Synthetic ids only. No POS documents and no customer data.
delete from app.owner
where
  user_id in (
    'a5300001-0000-4000-8000-000000000301',
    'a5300002-0000-4000-8000-000000000301'
  );

delete from auth.identities
where
  user_id in (
    'a5300001-0000-4000-8000-000000000301',
    'a5300002-0000-4000-8000-000000000301'
  );

delete from auth.users
where
  id in (
    'a5300001-0000-4000-8000-000000000301',
    'a5300002-0000-4000-8000-000000000301'
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
    'a5300001-0000-4000-8000-000000000301',
    'authenticated',
    'authenticated',
    'owner-input@theshark.test',
    '',
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a5300002-0000-4000-8000-000000000301',
    'authenticated',
    'authenticated',
    'intruder-input@theshark.test',
    '',
    now(),
    '',
    '',
    '',
    ''
  );

insert into
  app.owner (user_id)
values
  ('a5300001-0000-4000-8000-000000000301');

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    'a5300000-0000-4000-8000-000000000011',
    'input coverage fish',
    'seafood',
    'kg',
    'daily'
  );

create temp table input_movements as
select
  count(*)::bigint as n
from
  app.stock_movements;

grant
select
  on table input_movements to authenticated;

create function pg_temp.shift_doc (
  p_id text,
  p_opened timestamptz,
  p_closed timestamptz,
  p_updated timestamptz,
  p_txs jsonb
) returns jsonb language sql as $$
  select
    jsonb_build_object(
      'id',
      p_id,
      'opened_at',
      p_opened,
      'closed_at',
      p_closed,
      'is_active',
      false,
      'pos_update_time',
      p_updated,
      'transactions',
      p_txs
    );
$$;

create function pg_temp.order_doc (
  p_id text,
  p_shift text,
  p_status text,
  p_at timestamptz,
  p_updated timestamptz,
  p_hash text,
  p_lines jsonb
) returns jsonb language sql as $$
  select
    jsonb_build_object(
      'id',
      p_id,
      'shift_id',
      p_shift,
      'status',
      p_status,
      'ordered_at',
      p_at,
      'subtotal',
      '10',
      'discount',
      '0',
      'tax',
      '0',
      'service_tax',
      '0',
      'delivery_fee',
      '0',
      'total',
      '10',
      'pos_update_time',
      p_updated,
      'content_hash',
      p_hash,
      'lines',
      p_lines
    );
$$;

create function pg_temp.line_doc (p_line text, p_qty numeric) returns jsonb language sql as $$
  select
    jsonb_build_object(
      'line_id',
      p_line,
      'item_id',
      'item-input-fish',
      'item_name',
      'بوري',
      'quantity',
      p_qty,
      'unit_price',
      10,
      'phone',
      '01000000000',
      'note',
      'pii-line'
    );
$$;

-- start_pos_sync_run stamps started_at with the transaction clock. A count's
-- prepared_at is clock_timestamp(), which is later in this same transaction.
-- Move the finished run forward so the wait is the scope, not the clock.
create function pg_temp.bump_run_after_prepare (p_run bigint) returns void language plpgsql security definer
set
  search_path = '' as $$
begin
  update app.pos_sync_runs
  set
    started_at = stamp.at,
    finished_at = stamp.at
  from
    (
      select
        greatest(
          request.prepared_at,
          coalesce(
            (
              select
                max(shift.close_recorded_at)
              from
                app.pos_shifts shift
              where
                shift.opened_at <= '2026-11-01T20:00:00Z'::timestamptz
            ),
            request.prepared_at
          )
        ) + interval '1 millisecond' as at
      from
        app.stock_count_requests request
      where
        request.request_id = 'a5300000-0000-4000-8000-0000000000c1'
    ) as stamp
  where
    id = p_run;
end;
$$;

create function pg_temp.refund_tx (p_amount numeric) returns jsonb language sql as $$
  select
    jsonb_build_array(
      jsonb_build_object(
        'tx_id',
        'tx-refund',
        'order_id',
        'order-refund',
        'tx_type',
        3,
        'amount',
        p_amount,
        'occurred_at',
        '2026-10-15T12:30:00Z',
        'description',
        'pii-should-drop'
      )
    );
$$;

create function pg_temp.count_c1 () returns jsonb language sql as $$
  select
    app.record_count (
      jsonb_build_object(
        'request_id',
        'a5300000-0000-4000-8000-0000000000c1',
        'frequency',
        'daily',
        'counted_at',
        '2026-11-01T20:00:00Z',
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            'a5300000-0000-4000-8000-000000000011',
            'counted_qty',
            '0',
            'expected_base_unit',
            'kg'
          )
        )
      )
    );
$$;

-- Order scope listing every shift opened at or before the count of c1.
create function pg_temp.relevant_shift_scope () returns jsonb language sql as $$
  select
    jsonb_build_object(
      'shift_ids',
      coalesce(
        jsonb_agg(
          shift.id
          order by
            shift.id
        ),
        '[]'::jsonb
      )
    )
  from
    app.pos_shifts shift
  where
    shift.opened_at <= '2026-11-01T20:00:00Z'::timestamptz;
$$;

-- One ok run that presents only the named mirror shifts (no transactions) and
-- applies p_scope, then moves its clock past the count's prepared_at.
create function pg_temp.finished_run (p_mode text, p_present text[], p_scope jsonb) returns bigint language plpgsql as $$
declare
  v_run bigint;
begin
  v_run := app.start_pos_sync_run (p_mode);

  perform app.ingest_pos_batch (
    v_run,
    coalesce(
      (
        select
          jsonb_agg(
            pg_temp.shift_doc (
              shift.id,
              shift.opened_at,
              shift.closed_at,
              shift.pos_update_time,
              '[]'::jsonb
            )
            order by
              shift.id
          )
        from
          app.pos_shifts shift
        where
          shift.id = any (p_present)
      ),
      '[]'::jsonb
    ),
    '[]'::jsonb,
    p_scope
  );

  perform app.finish_pos_sync_run (v_run, 'ok', null, null);
  perform pg_temp.bump_run_after_prepare (v_run);

  return v_run;
end;
$$;

-- ============================================================================
-- Catalog, privileges, append-only truncate before any rows.
-- ============================================================================
select
  has_table (
    'app',
    'pos_order_snapshots',
    'pos_order_snapshots exists'
  );

select
  has_table (
    'app',
    'pos_refund_revisions',
    'pos_refund_revisions exists'
  );

select
  has_table (
    'app',
    'pos_cost_inputs',
    'pos_cost_inputs exists'
  );

select
  has_table (
    'app',
    'pos_sync_coverage',
    'pos_sync_coverage exists'
  );

select
  ok (
    (
      select
        bool_and(cls.relrowsecurity)
      from
        pg_class cls
        join pg_namespace nsp on nsp.oid = cls.relnamespace
      where
        nsp.nspname = 'app'
        and cls.relname in (
          'pos_order_snapshots',
          'pos_refund_revisions',
          'pos_cost_inputs',
          'pos_sync_coverage'
        )
    ),
    'RLS is on for the new POS input tables'
  );

select
  is_empty (
    $$
      select
        table_name,
        column_name
      from
        information_schema.columns
      where
        table_schema = 'app'
        and table_name in (
          'pos_order_snapshots',
          'pos_refund_revisions',
          'pos_cost_inputs',
          'pos_sync_coverage'
        )
        and column_name ~* '(phone|address|email|customer|description|mobile|contact|payer|guest)'
    $$,
    'new POS input tables have no customer-field columns'
  );

select
  ok (
    not has_function_privilege(
      'anon',
      'app.pos_preparation_input(text)'::regprocedure,
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'app.pos_preparation_input(text)'::regprocedure,
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'app.pos_preparation_input(text)'::regprocedure,
      'execute'
    )
    and not has_function_privilege(
      'anon',
      'app.capture_pos_order_snapshot(text,bigint,text)'::regprocedure,
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'app.append_pos_cost_input(text,bigint,text)'::regprocedure,
      'execute'
    )
    and not has_function_privilege(
      'service_role',
      'app.capture_pos_refund_revisions(bigint,jsonb)'::regprocedure,
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'app.backfill_pos_accounting_inputs()'::regprocedure,
      'execute'
    ),
    'internal POS input helpers are revoked from API roles'
  );

select
  ok (
    position(
      '7342750000000000001' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) = 0
    and position(
      'assert_ledger_write_allowed' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) = 0
    and position(
      'stock_movements' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) = 0
    and position(
      'post_movements' in pg_get_functiondef(
        'app.ingest_pos_batch(bigint,jsonb,jsonb,jsonb)'::regprocedure
      )
    ) = 0,
    'ingest still does not take the ledger lock or post stock'
  );

select
  throws_ok (
    'truncate app.pos_order_snapshots',
    '0A000',
    'cannot truncate a table referenced in a foreign key constraint',
    'snapshots reject truncate because cost inputs reference them'
  );

select
  throws_ok (
    'truncate app.pos_refund_revisions',
    '55000',
    'app.pos_refund_revisions is append-only; TRUNCATE is not allowed',
    'refund revisions reject truncate'
  );

select
  throws_ok (
    'truncate app.pos_cost_inputs',
    '55000',
    'app.pos_cost_inputs is append-only; TRUNCATE is not allowed',
    'cost inputs reject truncate'
  );

select
  throws_ok (
    'truncate app.pos_sync_coverage',
    '55000',
    'app.pos_sync_coverage is append-only; TRUNCATE is not allowed',
    'sync coverage rejects truncate'
  );

set
  local role anon;

select
  throws_ok (
    'select * from app.pos_order_snapshots',
    '42501',
    null::text,
    'anon cannot select snapshots'
  );

select
  throws_ok (
    'select * from app.pos_cost_inputs',
    '42501',
    null::text,
    'anon cannot select cost inputs'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5300002-0000-4000-8000-000000000301',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  throws_ok (
    $$insert into app.pos_order_snapshots (
        order_id, version, shift_id, status, ordered_at,
        subtotal, discount, tax, service_tax, delivery_fee, total,
        pos_update_time, content_hash, lines, origin
      ) values (
        'x', 1, 's', 'complete', now(),
        1, 0, 0, 0, 0, 1, now(), repeat('ab', 32), '[]', 'sync'
      )$$,
    '42501',
    null::text,
    'non-owner cannot insert a snapshot'
  );

select
  is_empty (
    'select id from app.pos_order_snapshots',
    'non-owner select sees no snapshots'
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
  throws_ok (
    $$insert into app.pos_refund_revisions (
        shift_id, tx_id, tx_type, amount, occurred_at, present, origin
      ) values ('s', 't', 3, 1, now(), true, 'sync')$$,
    '42501',
    null::text,
    'service_role cannot insert a refund revision'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5300001-0000-4000-8000-000000000301',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

-- ============================================================================
-- Accepted versions, stale, unchanged, cancel.
-- ============================================================================
create temp table input_runs (k text primary key, n bigint);

insert into
  input_runs (k, n)
values
  ('r1', app.start_pos_sync_run ('recent'));

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r1'
    ),
    jsonb_build_array(
      pg_temp.shift_doc (
        'shift-main',
        '2026-10-15T08:00:00Z',
        '2026-10-15T18:00:00Z',
        '2026-10-15T18:00:00Z',
        '[]'::jsonb
      ),
      pg_temp.shift_doc (
        'shift-miss',
        '2026-10-15T08:00:00Z',
        '2026-10-15T18:00:00Z',
        '2026-10-15T18:00:00Z',
        '[]'::jsonb
      ),
      pg_temp.shift_doc (
        'shift-count-cover',
        '2026-10-15T08:00:00Z',
        '2026-10-15T18:00:00Z',
        '2026-10-15T18:00:00Z',
        '[]'::jsonb
      )
    ),
    jsonb_build_array(
      pg_temp.order_doc (
        'order-snap',
        'shift-main',
        'complete',
        '2026-10-15T12:00:00Z',
        '2026-10-15T12:00:00Z',
        repeat('11', 32),
        jsonb_build_array(pg_temp.line_doc ('line-old', 2))
      ),
      pg_temp.order_doc (
        'order-cancel',
        'shift-main',
        'complete',
        '2026-10-15T12:05:00Z',
        '2026-10-15T12:05:00Z',
        repeat('22', 32),
        jsonb_build_array(pg_temp.line_doc ('line-keep', 1))
      ),
      pg_temp.order_doc (
        'order-miss',
        'shift-miss',
        'complete',
        '2026-10-15T12:10:00Z',
        '2026-10-15T12:10:00Z',
        repeat('33', 32),
        jsonb_build_array(pg_temp.line_doc ('line-miss', 1))
      ),
      pg_temp.order_doc (
        'order-refund',
        'shift-main',
        'complete',
        '2026-10-15T12:20:00Z',
        '2026-10-15T12:20:00Z',
        repeat('44', 32),
        jsonb_build_array(pg_temp.line_doc ('line-refund', 1))
      )
    ),
    null
  );

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r1'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.order_doc (
        'order-snap',
        'shift-main',
        'complete',
        '2026-10-15T12:00:00Z',
        '2026-10-15T13:00:00Z',
        repeat('55', 32),
        jsonb_build_array(pg_temp.line_doc ('line-new', 4))
      )
    ),
    null
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-snap'
    ),
    2,
    'an accepted edit bumps the order version'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_order_snapshots
      where
        order_id = 'order-snap'
    ),
    2::bigint,
    'each accepted version has one snapshot'
  );

select
  ok (
    (
      select
        lines @> jsonb_build_array(jsonb_build_object('line_id', 'line-old'))
        and not lines @> jsonb_build_array(jsonb_build_object('line_id', 'line-new'))
        and lines::text not like '%01000000000%'
        and lines::text not like '%pii-line%'
      from
        app.pos_order_snapshots
      where
        order_id = 'order-snap'
        and version = 1
    ),
    'the first snapshot keeps the old line and drops customer keys'
  );

select
  ok (
    (
      select
        lines @> jsonb_build_array(jsonb_build_object('line_id', 'line-new'))
        and not lines @> jsonb_build_array(jsonb_build_object('line_id', 'line-old'))
        and origin = 'sync'
      from
        app.pos_order_snapshots
      where
        order_id = 'order-snap'
        and version = 2
    ),
    'the accepted version snapshots the new lines, not the old lines'
  );

select
  is (
    (
      select
        snap.version
      from
        app.pos_cost_inputs cost_input
        join app.pos_order_snapshots snap on snap.id = cost_input.snapshot_id
      where
        cost_input.order_id = 'order-snap'
      order by
        cost_input.input_revision desc
      limit
        1
    ),
    2,
    'the latest cost input points at the accepted snapshot'
  );

create temp table input_before_stale as
select
  (
    select
      count(*)
    from
      app.pos_order_snapshots
    where
      order_id = 'order-snap'
  ) as snapshots,
  (
    select
      count(*)
    from
      app.pos_cost_inputs
    where
      order_id = 'order-snap'
  ) as inputs,
  (
    select
      count(*)
    from
      app.pos_refund_revisions
  ) as revisions;

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r1'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.order_doc (
        'order-snap',
        'shift-main',
        'complete',
        '2026-10-15T12:00:00Z',
        '2026-10-15T11:00:00Z',
        repeat('66', 32),
        jsonb_build_array(pg_temp.line_doc ('line-stale', 9))
      )
    ),
    null
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_order_snapshots
      where
        order_id = 'order-snap'
    ),
    (
      select
        snapshots
      from
        input_before_stale
    ),
    'a stale payload adds no snapshot'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-snap'
    ),
    (
      select
        inputs
      from
        input_before_stale
    ),
    'a stale payload adds no cost input'
  );

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r1'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.order_doc (
        'order-snap',
        'shift-main',
        'complete',
        '2026-10-15T12:00:00Z',
        '2026-10-15T13:00:00Z',
        repeat('55', 32),
        jsonb_build_array(pg_temp.line_doc ('line-new', 4))
      )
    ),
    null
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_order_snapshots
      where
        order_id = 'order-snap'
    ),
    (
      select
        snapshots
      from
        input_before_stale
    ),
    'an unchanged payload adds no snapshot'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-snap'
    ),
    (
      select
        inputs
      from
        input_before_stale
    ),
    'an unchanged payload adds no cost input'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_refund_revisions
    ),
    (
      select
        revisions
      from
        input_before_stale
    ),
    'rewriting an empty transaction set adds no refund revision'
  );

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r1'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.order_doc (
        'order-cancel',
        'shift-main',
        'canceled',
        '2026-10-15T12:05:00Z',
        '2026-10-15T14:00:00Z',
        repeat('77', 32),
        '[]'::jsonb
      )
    ),
    null
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_order_snapshots
      where
        order_id = 'order-cancel'
    ),
    2::bigint,
    'a cancellation that clears lines keeps the earlier snapshot'
  );

select
  is (
    (
      select
        jsonb_array_length(lines)
      from
        app.pos_order_snapshots
      where
        order_id = 'order-cancel'
        and version = 2
    ),
    0,
    'the cancellation snapshot stores the cleared lines'
  );

reset role;

select
  is (
    (
      select
        version
      from
        app.pos_preparation_input ('order-cancel')
    ),
    1,
    'the preparation input is the latest non-empty snapshot'
  );

select
  ok (
    (
      select
        lines @> jsonb_build_array(jsonb_build_object('line_id', 'line-keep'))
      from
        app.pos_preparation_input ('order-cancel')
    ),
    'the preparation input still has the lines from before the cancel'
  );

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5300001-0000-4000-8000-000000000301',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  app.finish_pos_sync_run (
    (
      select
        n
      from
        input_runs
      where
        k = 'r1'
    ),
    'ok',
    '{"orders":4}'::jsonb,
    null
  );

select
  is (
    (
      select
        orders_scope_applied
      from
        app.pos_sync_coverage
      where
        run_id = (
          select
            n
          from
            input_runs
          where
            k = 'r1'
        )
    ),
    false,
    'an ok finish without a scope still records coverage and does not claim the read'
  );

-- ============================================================================
-- missing_from_pos flip and reappearance do not bump version.
-- ============================================================================
insert into
  input_runs (k, n)
values
  ('r2', app.start_pos_sync_run ('recent'));

reset role;

update app.pos_orders
set
  last_synced_at = pg_catalog.now () - interval '1 minute'
where
  id = 'order-miss';

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5300001-0000-4000-8000-000000000301',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r2'
    ),
    jsonb_build_array(
      pg_temp.shift_doc (
        'shift-miss',
        '2026-10-15T08:00:00Z',
        '2026-10-15T18:00:00Z',
        '2026-10-15T18:00:00Z',
        '[]'::jsonb
      )
    ),
    '[]'::jsonb,
    jsonb_build_object('shift_ids', jsonb_build_array('shift-miss'))
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-miss'
    ),
    1,
    'marking an order missing does not bump version'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-miss'
    ),
    true,
    'the completed scope marks the absent order missing'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_order_snapshots
      where
        order_id = 'order-miss'
    ),
    1::bigint,
    'a missing flip does not add a snapshot'
  );

select
  is (
    (
      select
        cost_input.missing_from_pos
      from
        app.pos_cost_inputs cost_input
      where
        cost_input.order_id = 'order-miss'
      order by
        cost_input.input_revision desc
      limit
        1
    ),
    true,
    'a missing flip appends a cost input'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-miss'
    ),
    2::bigint,
    'the missing flip is a second cost input'
  );

select
  app.finish_pos_sync_run (
    (
      select
        n
      from
        input_runs
      where
        k = 'r2'
    ),
    'ok',
    null,
    null
  );

insert into
  input_runs (k, n)
values
  ('r3', app.start_pos_sync_run ('recent'));

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r3'
    ),
    '[]'::jsonb,
    jsonb_build_array(
      pg_temp.order_doc (
        'order-miss',
        'shift-miss',
        'complete',
        '2026-10-15T12:10:00Z',
        '2026-10-15T12:10:00Z',
        repeat('33', 32),
        jsonb_build_array(pg_temp.line_doc ('line-miss', 1))
      )
    ),
    null
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-miss'
    ),
    1,
    'reappearance does not bump version'
  );

select
  is (
    (
      select
        missing_from_pos
      from
        app.pos_orders
      where
        id = 'order-miss'
    ),
    false,
    'seeing the order again clears missing_from_pos'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_order_snapshots
      where
        order_id = 'order-miss'
    ),
    1::bigint,
    'reappearance does not add a snapshot'
  );

select
  is (
    (
      select
        cost_input.missing_from_pos
      from
        app.pos_cost_inputs cost_input
      where
        cost_input.order_id = 'order-miss'
      order by
        cost_input.input_revision desc
      limit
        1
    ),
    false,
    'reappearance appends a cost input with missing cleared'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-miss'
    ),
    3::bigint,
    'reappearance is a third cost input'
  );

select
  app.finish_pos_sync_run (
    (
      select
        n
      from
        input_runs
      where
        k = 'r3'
    ),
    'ok',
    null,
    null
  );

-- ============================================================================
-- Refund add, identical delete/insert, replace, tombstone.
-- ============================================================================
insert into
  input_runs (k, n)
values
  ('r4', app.start_pos_sync_run ('recent'));

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r4'
    ),
    jsonb_build_array(
      pg_temp.shift_doc (
        'shift-main',
        '2026-10-15T08:00:00Z',
        '2026-10-15T18:00:00Z',
        '2026-10-15T18:00:00Z',
        pg_temp.refund_tx (5)
      )
    ),
    jsonb_build_array(
      pg_temp.order_doc (
        'order-refund',
        'shift-main',
        'complete',
        '2026-10-15T12:20:00Z',
        '2026-10-15T12:20:00Z',
        repeat('44', 32),
        jsonb_build_array(pg_temp.line_doc ('line-refund', 1))
      )
    ),
    null
  );

select
  is (
    (
      select
        version
      from
        app.pos_orders
      where
        id = 'order-refund'
    ),
    1,
    'a linked refund does not bump the order version'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_refund_revisions
      where
        shift_id = 'shift-main'
        and tx_id = 'tx-refund'
    ),
    1::bigint,
    'adding a refund appends one revision'
  );

select
  is (
    (
      select
        to_jsonb(revision) ? 'description'
      from
        app.pos_refund_revisions revision
      where
        revision.tx_id = 'tx-refund'
    ),
    false,
    'a refund revision does not store description'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-refund'
    ),
    2::bigint,
    'a linked refund appends a cost input'
  );

select
  is (
    (
      select
        coalesce(array_length(refund_revision_ids, 1), 0)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-refund'
      order by
        input_revision desc
      limit
        1
    ),
    1,
    'the cost input stores the linked refund revision'
  );

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r4'
    ),
    jsonb_build_array(
      pg_temp.shift_doc (
        'shift-main',
        '2026-10-15T08:00:00Z',
        '2026-10-15T18:00:00Z',
        '2026-10-15T18:00:00Z',
        pg_temp.refund_tx (5)
      )
    ),
    jsonb_build_array(
      pg_temp.order_doc (
        'order-refund',
        'shift-main',
        'complete',
        '2026-10-15T12:20:00Z',
        '2026-10-15T12:20:00Z',
        repeat('44', 32),
        jsonb_build_array(pg_temp.line_doc ('line-refund', 1))
      )
    ),
    null
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_refund_revisions
      where
        tx_id = 'tx-refund'
    ),
    1::bigint,
    'delete and insert of the same refund adds no revision'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-refund'
    ),
    2::bigint,
    'an unchanged refund digest adds no cost input'
  );

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r4'
    ),
    jsonb_build_array(
      pg_temp.shift_doc (
        'shift-main',
        '2026-10-15T08:00:00Z',
        '2026-10-15T18:00:00Z',
        '2026-10-15T18:00:00Z',
        pg_temp.refund_tx (8)
      )
    ),
    '[]'::jsonb,
    null
  );

select
  is (
    (
      select
        amount
      from
        app.pos_refund_revisions
      where
        tx_id = 'tx-refund'
      order by
        id desc
      limit
        1
    ),
    8::numeric,
    'replacing a refund amount appends a revision'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-refund'
    ),
    3::bigint,
    'a changed linked refund appends a cost input'
  );

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'r4'
    ),
    jsonb_build_array(
      pg_temp.shift_doc (
        'shift-main',
        '2026-10-15T08:00:00Z',
        '2026-10-15T18:00:00Z',
        '2026-10-15T18:00:00Z',
        '[]'::jsonb
      )
    ),
    '[]'::jsonb,
    null
  );

select
  is (
    (
      select
        present
      from
        app.pos_refund_revisions
      where
        tx_id = 'tx-refund'
      order by
        id desc
      limit
        1
    ),
    false,
    'removing a refund appends a disappearance tombstone'
  );

select
  is (
    (
      select
        coalesce(array_length(refund_revision_ids, 1), 0)
      from
        app.pos_cost_inputs
      where
        order_id = 'order-refund'
      order by
        input_revision desc
      limit
        1
    ),
    0,
    'the tombstone drops the refund from the cost input'
  );

select
  app.finish_pos_sync_run (
    (
      select
        n
      from
        input_runs
      where
        k = 'r4'
    ),
    'ok',
    null,
    null
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
        n
      from
        input_movements
    ),
    'sync still posts no stock movement'
  );

-- ============================================================================
-- Failed finish claims no coverage. Append-only updates.
-- ============================================================================
insert into
  input_runs (k, n)
values
  ('failed', app.start_pos_sync_run ('recent'));

select
  app.finish_pos_sync_run (
    (
      select
        n
      from
        input_runs
      where
        k = 'failed'
    ),
    'failed',
    null,
    'synthetic failure'
  );

select
  is_empty (
    $$
      select
        run_id
      from
        app.pos_sync_coverage
      where
        run_id = (
          select
            n
          from
            input_runs
          where
            k = 'failed'
        )
    $$,
    'a failed run claims no coverage'
  );

reset role;

select
  throws_ok (
    $$update app.pos_order_snapshots set origin = 'backfill'$$,
    '55000',
    'app.pos_order_snapshots is append-only; UPDATE is not allowed',
    'snapshots reject update'
  );

select
  throws_ok (
    'delete from app.pos_order_snapshots',
    '55000',
    'app.pos_order_snapshots is append-only; DELETE is not allowed',
    'snapshots reject delete'
  );

select
  throws_ok (
    $$update app.pos_refund_revisions set present = true$$,
    '55000',
    'app.pos_refund_revisions is append-only; UPDATE is not allowed',
    'refund revisions reject update'
  );

select
  throws_ok (
    'delete from app.pos_refund_revisions',
    '55000',
    'app.pos_refund_revisions is append-only; DELETE is not allowed',
    'refund revisions reject delete'
  );

select
  throws_ok (
    $$update app.pos_cost_inputs set origin = 'backfill'$$,
    '55000',
    'app.pos_cost_inputs is append-only; UPDATE is not allowed',
    'cost inputs reject update'
  );

select
  throws_ok (
    'delete from app.pos_cost_inputs',
    '55000',
    'app.pos_cost_inputs is append-only; DELETE is not allowed',
    'cost inputs reject delete'
  );

select
  throws_ok (
    $$update app.pos_sync_coverage set legacy_direct = true$$,
    '55000',
    'app.pos_sync_coverage is append-only; UPDATE is not allowed',
    'sync coverage rejects update'
  );

select
  throws_ok (
    'delete from app.pos_sync_coverage',
    '55000',
    'app.pos_sync_coverage is append-only; DELETE is not allowed',
    'sync coverage rejects delete'
  );

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5300001-0000-4000-8000-000000000301',
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
        app.pos_order_snapshots
    ) > 0
    and (
      select
        count(*)
      from
        app.pos_cost_inputs
    ) > 0
    and (
      select
        count(*)
      from
        app.pos_sync_coverage
    ) > 0,
    'the owner can select the accounting inputs'
  );

select
  throws_ok (
    $$update app.pos_cost_inputs set origin = 'backfill'$$,
    '42501',
    null::text,
    'the owner cannot update a cost input directly'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5300002-0000-4000-8000-000000000301',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  is_empty (
    'select id from app.pos_order_snapshots',
    'non-owner select sees no snapshots after rows exist'
  );

select
  is_empty (
    'select id from app.pos_refund_revisions',
    'non-owner select sees no refund revisions'
  );

select
  is_empty (
    'select id from app.pos_cost_inputs',
    'non-owner select sees no cost inputs'
  );

select
  is_empty (
    'select run_id from app.pos_sync_coverage',
    'non-owner select sees no sync coverage'
  );

-- ============================================================================
-- Count coverage. A direct ok insert is legacy. A finished scope that misses
-- the shifts does not post. A scope that lists them does.
-- ============================================================================
reset role;

insert into
  app.pos_sync_runs (mode, status, started_at, finished_at)
values
  (
    'recent',
    'ok',
    '2000-01-01T00:00:00Z',
    '2000-01-01T00:01:00Z'
  );

select
  ok (
    (
      select
        cov.legacy_direct
        and cov.scope_kind = 'all'
        and not cov.transactions_covered
      from
        app.pos_sync_coverage cov
        join app.pos_sync_runs run on run.id = cov.run_id
      where
        run.started_at = '2000-01-01T00:00:00Z'
    ),
    'an ok run inserted already finished is legacy coverage'
  );

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5300001-0000-4000-8000-000000000301',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  is (
    app.record_count (
      jsonb_build_object(
        'request_id',
        'a5300000-0000-4000-8000-0000000000c1',
        'frequency',
        'daily',
        'counted_at',
        '2026-11-01T20:00:00Z',
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            'a5300000-0000-4000-8000-000000000011',
            'counted_qty',
            '0',
            'expected_base_unit',
            'kg'
          )
        )
      )
    ),
    jsonb_build_object('status', 'waiting_for_sync'),
    'the first count submit waits for a covering sync'
  );

insert into
  input_runs (k, n)
values
  ('narrow', app.start_pos_sync_run ('recent'));

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'narrow'
    ),
    '[]'::jsonb,
    '[]'::jsonb,
    jsonb_build_object('shift_ids', jsonb_build_array('shift-other'))
  );

select
  app.finish_pos_sync_run (
    (
      select
        n
      from
        input_runs
      where
        k = 'narrow'
    ),
    'ok',
    null,
    null
  );

select
  pg_temp.bump_run_after_prepare (
    (
      select
        n
      from
        input_runs
      where
        k = 'narrow'
    )
  );

select
  is (
    (
      select
        transactions_covered
      from
        app.pos_sync_coverage
      where
        run_id = (
          select
            n
          from
            input_runs
          where
            k = 'narrow'
        )
    ),
    false,
    'a shift_ids scope that was not presented is not transaction coverage'
  );

select
  is (
    app.record_count (
      jsonb_build_object(
        'request_id',
        'a5300000-0000-4000-8000-0000000000c1',
        'frequency',
        'daily',
        'counted_at',
        '2026-11-01T20:00:00Z',
        'lines',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            'a5300000-0000-4000-8000-000000000011',
            'counted_qty',
            '0',
            'expected_base_unit',
            'kg'
          )
        )
      )
    ),
    jsonb_build_object('status', 'waiting_for_sync'),
    'a count stays waiting when the newest ok scope misses the shifts'
  );

select
  is_empty (
    $$
      select
        id
      from
        app.stock_counts
      where
        request_id = 'a5300000-0000-4000-8000-0000000000c1'
    $$,
    'a count with a missing covering scope posts nothing'
  );

-- ---------------------------------------------------------------------------
-- The order scope matches, but the transaction subcollections were not read
-- for every shift opened by the count. The count stays waiting.
-- ---------------------------------------------------------------------------
insert into
  input_runs (k, n)
values
  (
    'noread',
    pg_temp.finished_run (
      'recent',
      '{}'::text[],
      pg_temp.relevant_shift_scope ()
    )
  );

select
  ok (
    (
      select
        cov.orders_scope_applied
        and cov.scope_kind = 'shift_ids'
        and not cov.legacy_direct
        and cov.scope_shift_ids = (
          select
            array_agg(
              shift.id
              order by
                shift.id
            )
          from
            app.pos_shifts shift
          where
            shift.opened_at <= '2026-11-01T20:00:00Z'::timestamptz
        )
        and cov.presented_shift_ids = '{}'::text[]
        and not cov.transactions_covered
      from
        app.pos_sync_coverage cov
      where
        cov.run_id = (
          select
            n
          from
            input_runs
          where
            k = 'noread'
        )
    ),
    'a shift_ids scope listing every relevant shift but presenting none is not transaction coverage'
  );

select
  is (
    pg_temp.count_c1 (),
    jsonb_build_object('status', 'waiting_for_sync'),
    'a count stays waiting when the scope matches but no shift transactions were read'
  );

select
  is_empty (
    $$
      select
        id
      from
        app.stock_counts
      where
        request_id = 'a5300000-0000-4000-8000-0000000000c1'
    $$,
    'a count refused for missing transaction reads posts nothing'
  );

insert into
  input_runs (k, n)
values
  (
    'fullnone',
    pg_temp.finished_run (
      'full',
      '{}'::text[],
      jsonb_build_object('all', true)
    )
  ),
  (
    'fullpart',
    pg_temp.finished_run (
      'full',
      array['shift-main', 'shift-miss'],
      jsonb_build_object('all', true)
    )
  );

select
  is (
    (
      select
        transactions_covered
      from
        app.pos_sync_coverage
      where
        run_id = (
          select
            n
          from
            input_runs
          where
            k = 'fullnone'
        )
    ),
    false,
    'an all scope that presented no shift is not transaction coverage'
  );

select
  is (
    (
      select
        transactions_covered
      from
        app.pos_sync_coverage
      where
        run_id = (
          select
            n
          from
            input_runs
          where
            k = 'fullpart'
        )
    ),
    false,
    'an all scope that presented only some shifts is not transaction coverage'
  );

select
  is (
    pg_temp.count_c1 (),
    jsonb_build_object('status', 'waiting_for_sync'),
    'a count stays waiting when an all scope presented only some shifts'
  );

insert into
  input_runs (k, n)
values
  (
    'fromnone',
    pg_temp.finished_run (
      'window35',
      '{}'::text[],
      jsonb_build_object('from', '2000-01-01T00:00:00Z'::timestamptz)
    )
  );

select
  is (
    (
      select
        transactions_covered
      from
        app.pos_sync_coverage
      where
        run_id = (
          select
            n
          from
            input_runs
          where
            k = 'fromnone'
        )
    ),
    false,
    'a from scope that presented no shift is not transaction coverage'
  );

select
  is (
    pg_temp.count_c1 (),
    jsonb_build_object('status', 'waiting_for_sync'),
    'a count stays waiting when a from scope presented no shift'
  );

insert into
  input_runs (k, n)
values
  (
    'fullall',
    pg_temp.finished_run (
      'full',
      (
        select
          array_agg(shift.id)
        from
          app.pos_shifts shift
      ),
      jsonb_build_object('all', true)
    )
  ),
  (
    'fromall',
    pg_temp.finished_run (
      'window35',
      (
        select
          array_agg(shift.id)
        from
          app.pos_shifts shift
      ),
      jsonb_build_object('from', '2000-01-01T00:00:00Z'::timestamptz)
    )
  );

select
  is (
    (
      select
        array_agg(
          cov.transactions_covered
          order by
            cov.run_id
        )
      from
        app.pos_sync_coverage cov
      where
        cov.run_id in (
          select
            n
          from
            input_runs
          where
            k in ('fullall', 'fromall')
        )
    ),
    array[true, true],
    'all and from scopes that presented every shift are transaction coverage'
  );

-- ---------------------------------------------------------------------------
-- Migration transition. A sync that applied its scope before scope_kind
-- existed finishes after the migration with applied true and kind null. Every
-- shift is presented, so only the unknown scope can keep the count waiting.
-- ---------------------------------------------------------------------------
reset role;

with
  inserted as (
    insert into
      app.pos_sync_runs (mode, scope_applied, presented_shift_ids)
    values
      (
        'recent',
        true,
        (
          select
            array_agg(
              shift.id
              order by
                shift.id
            )
          from
            app.pos_shifts shift
        )
      )
    returning
      id
  )
insert into
  input_runs (k, n)
select
  'preapplied',
  id
from
  inserted;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a5300001-0000-4000-8000-000000000301',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  app.finish_pos_sync_run (
    (
      select
        n
      from
        input_runs
      where
        k = 'preapplied'
    ),
    'ok',
    null,
    null
  );

select
  pg_temp.bump_run_after_prepare (
    (
      select
        n
      from
        input_runs
      where
        k = 'preapplied'
    )
  );

select
  ok (
    (
      select
        cov.orders_scope_applied
        and cov.scope_kind is null
        and not cov.legacy_direct
        and not cov.transactions_covered
        and cov.presented_shift_ids = (
          select
            array_agg(
              shift.id
              order by
                shift.id
            )
          from
            app.pos_shifts shift
        )
      from
        app.pos_sync_coverage cov
      where
        cov.run_id = (
          select
            n
          from
            input_runs
          where
            k = 'preapplied'
        )
    ),
    'a run that applied its scope before scope_kind existed finishes with an unknown scope'
  );

select
  is (
    pg_temp.count_c1 (),
    jsonb_build_object('status', 'waiting_for_sync'),
    'a count stays waiting when the newest ok run applied an unknown scope'
  );

select
  is_empty (
    $$
      select
        id
      from
        app.stock_counts
      where
        request_id = 'a5300000-0000-4000-8000-0000000000c1'
    $$,
    'a count refused for an unknown scope posts nothing'
  );

insert into
  input_runs (k, n)
values
  ('cover', app.start_pos_sync_run ('recent'));

select
  app.ingest_pos_batch (
    (
      select
        n
      from
        input_runs
      where
        k = 'cover'
    ),
    (
      select
        jsonb_agg(
          pg_temp.shift_doc (
            shift.id,
            shift.opened_at,
            shift.closed_at,
            shift.pos_update_time,
            '[]'::jsonb
          )
          order by
            shift.id
        )
      from
        app.pos_shifts shift
      where
        shift.opened_at <= '2026-11-01T20:00:00Z'::timestamptz
    ),
    '[]'::jsonb,
    (
      select
        jsonb_build_object(
          'shift_ids',
          coalesce(
            jsonb_agg(
              shift.id
              order by
                shift.id
            ),
            '[]'::jsonb
          )
        )
      from
        app.pos_shifts shift
      where
        shift.opened_at <= '2026-11-01T20:00:00Z'::timestamptz
    )
  );

select
  app.finish_pos_sync_run (
    (
      select
        n
      from
        input_runs
      where
        k = 'cover'
    ),
    'ok',
    null,
    null
  );

select
  pg_temp.bump_run_after_prepare (
    (
      select
        n
      from
        input_runs
      where
        k = 'cover'
    )
  );

select
  is (
    (
      select
        orders_scope_applied
        and scope_kind = 'shift_ids'
        and transactions_covered
        and not legacy_direct
      from
        app.pos_sync_coverage
      where
        run_id = (
          select
            n
          from
            input_runs
          where
            k = 'cover'
        )
    ),
    true,
    'the covering finish records the presented shifts and the applied scope'
  );

select
  ok (
    (
      select
        app.record_count (
          jsonb_build_object(
            'request_id',
            'a5300000-0000-4000-8000-0000000000c1',
            'frequency',
            'daily',
            'counted_at',
            '2026-11-01T20:00:00Z',
            'lines',
            jsonb_build_array(
              jsonb_build_object(
                'item_id',
                'a5300000-0000-4000-8000-000000000011',
                'counted_qty',
                '0',
                'expected_base_unit',
                'kg'
              )
            )
          )
        ) ->> 'status' = 'posted'
    ),
    'a count posts when the newest ok scope covers the shifts'
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
        n
      from
        input_movements
    ),
    'the zero count posts no stock movement'
  );

-- ============================================================================
-- Backfill shape. A direct mirror row is labeled backfill. A second call
-- appends nothing, and rows already captured by sync stay sync.
-- ============================================================================
reset role;

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
    'shift-backfill',
    '2026-12-01T08:00:00Z',
    '2026-12-01T18:00:00Z',
    false,
    '2026-12-01T18:00:00Z'
  );

insert into
  app.pos_orders (
    id,
    shift_id,
    status,
    ordered_at,
    subtotal,
    discount,
    tax,
    service_tax,
    delivery_fee,
    total,
    pos_update_time,
    content_hash,
    version
  )
values
  (
    'order-backfill',
    'shift-backfill',
    'complete',
    '2026-12-01T12:00:00Z',
    10,
    0,
    0,
    0,
    0,
    10,
    '2026-12-01T12:00:00Z',
    repeat('ab', 32),
    4
  );

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    quantity,
    unit_price,
    options,
    line_total
  )
values
  (
    'order-backfill',
    'line-backfill',
    'item-input-fish',
    1,
    10,
    '[]'::jsonb,
    10
  );

insert into
  app.pos_shift_transactions (
    shift_id,
    tx_id,
    order_id,
    tx_type,
    amount,
    occurred_at
  )
values
  (
    'shift-backfill',
    'tx-backfill',
    'order-backfill',
    3,
    2.50,
    '2026-12-01T12:30:00Z'
  );

select
  lives_ok (
    'select app.backfill_pos_accounting_inputs()',
    'backfill copies the current mirror'
  );

select
  is (
    (
      select
        version
      from
        app.pos_order_snapshots
      where
        order_id = 'order-backfill'
        and origin = 'backfill'
    ),
    4,
    'backfill snapshots the current mirror version'
  );

select
  ok (
    (
      select
        lines @> jsonb_build_array(jsonb_build_object('line_id', 'line-backfill'))
        and source_run_id is null
      from
        app.pos_order_snapshots
      where
        order_id = 'order-backfill'
    ),
    'the backfill snapshot copies the mirror lines and has no sync run'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_order_snapshots
      where
        order_id = 'order-snap'
        and origin = 'backfill'
    ),
    0::bigint,
    'backfill does not relabel a snapshot captured by sync'
  );

select
  ok (
    (
      select
        present
        and origin = 'backfill'
        and amount = 2.50
        and source_run_id is null
      from
        app.pos_refund_revisions
      where
        tx_id = 'tx-backfill'
    ),
    'backfill writes one present revision for a current transaction'
  );

select
  is (
    (
      select
        input_revision
      from
        app.pos_cost_inputs
      where
        order_id = 'order-backfill'
        and origin = 'backfill'
    ),
    1,
    'backfill writes one cost input revision'
  );

create temp table input_backfill_counts as
select
  (
    select
      count(*)
    from
      app.pos_order_snapshots
  ) as snapshots,
  (
    select
      count(*)
    from
      app.pos_refund_revisions
  ) as revisions,
  (
    select
      count(*)
    from
      app.pos_cost_inputs
  ) as inputs;

select
  lives_ok (
    'select app.backfill_pos_accounting_inputs()',
    'a second backfill is a no-op'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_order_snapshots
    ),
    (
      select
        snapshots
      from
        input_backfill_counts
    ),
    'the second backfill adds no snapshot'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_refund_revisions
    ),
    (
      select
        revisions
      from
        input_backfill_counts
    ),
    'the second backfill adds no refund revision'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_cost_inputs
    ),
    (
      select
        inputs
      from
        input_backfill_counts
    ),
    'the second backfill adds no cost input'
  );

select
  *
from
  finish ();

rollback;
