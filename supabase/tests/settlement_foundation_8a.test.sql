-- Round 8a active foundation tests: section-2 schema & constraints, dormancy
-- control, RLS/grants/search_path, section-3 private run contract, and
-- privileged replay probe & cut-override security. Synthetic IDs only.
begin;

select
  set_config('app.test_clock', '2026-11-15 12:00:00+00', true);

select
  no_plan ();

-- Runs SQL in a subtransaction; returns 'OK' or SQLSTATE (with detail for P0001).
-- Prevents missing-object errors on the baseline DB from aborting the file early.
create function pg_temp.exec_sqlstate (p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception
  when sqlstate 'P0001' then
    return sqlstate || ':' || sqlerrm;
  when others then
    return sqlstate;
end;
$$;

-- Runs SQL in a subtransaction and ALWAYS rolls back that subtransaction while
-- returning 'OK' or SQLSTATE (with detail for P0001).
create function pg_temp.probe_sqlstate (p_sql text) returns text language plpgsql as $$
declare
  v_code text;
begin
  begin
    execute p_sql;
    v_code := 'OK';
    raise exception '__probe_rollback__' using errcode = 'P9999';
  exception
    when sqlstate 'P9999' then
      return v_code;
    when sqlstate 'P0001' then
      return sqlstate || ':' || sqlerrm;
    when others then
      return sqlstate;
  end;
end;
$$;

-- ============================================================================
-- Fixture setup (synthetic owner + catalog items)
-- ============================================================================
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
    '00000000-0000-4000-8000-000000000000',
    '8a000000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-8a@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-4000-8000-000000000000',
    '8a000000-0000-4000-8000-0000000000a2',
    'authenticated',
    'authenticated',
    'other-8a@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  )
on conflict (id) do nothing;

insert into
  app.owner (user_id)
values
  ('8a000000-0000-4000-8000-0000000000a1');

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      '8a000000-0000-4000-8000-0000000000a1',
      'role',
      'authenticated'
    )::text,
    true
  );

insert into
  app.stock_items (id, name, kind, base_unit, count_frequency)
values
  (
    '8a000000-0000-4000-8000-000000000001',
    '8a item one',
    'seafood',
    'kg',
    'daily'
  ),
  (
    '8a000000-0000-4000-8000-000000000002',
    '8a item two',
    'seafood',
    'kg',
    'daily'
  ),
  (
    '8a000000-0000-4000-8000-000000000003',
    '8a mixed fish',
    'fish_mixed',
    'kg',
    'daily'
  );

insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    parent_item_id
  )
values
  (
    '8a000000-0000-4000-8000-000000000004',
    '8a fish size',
    'fish_size',
    'kg',
    'daily',
    '8a000000-0000-4000-8000-000000000003'
  );

-- ============================================================================
-- Group 0 (pre-lock): Section-3 run entry lock-ownership checks (must run
-- before any writer acquires transaction-level ledger/sync/shifts locks).
-- ============================================================================
select
  is (
    pg_temp.probe_sqlstate (
      $$select app.accounting_run_enter('test_no_lock', null, true, true)$$
    ),
    '55000',
    '8a run contract: accounting_run_enter rejects missing ledger advisory lock'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$select pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);
        select app.accounting_run_enter('test_no_sync_lock', null, true, true)$$
    ),
    '55000',
    '8a run contract: accounting_run_enter rejects missing pos_sync_runs share lock'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$select pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);
        lock table app.pos_sync_runs in share mode;
        select app.accounting_run_enter('test_no_shifts_lock', null, true, true)$$
    ),
    '55000',
    '8a run contract: accounting_run_enter rejects missing pos_shifts share lock'
  );

-- ============================================================================
-- Group 1: Dormancy control — existing writers succeed without run state or
-- new posting links, and accounting results remain unchanged.
-- ============================================================================
select
  lives_ok (
    $$select app.record_opening_stock(
      '2026-11-01T08:00:00Z',
      jsonb_build_array(jsonb_build_object(
        'item_id', '8a000000-0000-4000-8000-000000000001',
        'quantity', '10',
        'unit', 'kg',
        'unit_cost', '10',
        'expected_base_unit', 'kg',
        'expected_factor', '1'
      )),
      '8a000000-0000-4000-8000-000000000101'
    )$$,
    'control: record_opening_stock succeeds while new protocol is dormant'
  );

select
  lives_ok (
    $$select app.record_purchase(jsonb_build_object(
      'request_id', '8a000000-0000-4000-8000-000000000102',
      'purchased_at', '2026-11-02T08:00:00Z',
      'supplier', '8a supplier',
      'invoice_no', '8A-1',
      'lines', jsonb_build_array(jsonb_build_object(
        'item_id', '8a000000-0000-4000-8000-000000000001',
        'quantity', '5',
        'unit', 'kg',
        'amount_paid', '100.00',
        'expected_base_unit', 'kg',
        'expected_factor', '1'
      ))
    ))$$,
    'control: record_purchase succeeds while new protocol is dormant'
  );

select
  is (
    (
      select
        ib.on_hand_qty::text || '/' || ib.on_hand_value::text
      from
        app.item_balances ib
      where
        ib.item_id = '8a000000-0000-4000-8000-000000000001'
    ),
    '15.000000/200.00',
    'control: existing writer balances remain unchanged (15/200)'
  );

-- ============================================================================
-- Group 2: Section-2 schema objects, columns, and section-8 indexes exist
-- ============================================================================
select
  is (
    (
      select
        count(*)
      from
        unnest(
          array[
            'app.accounting_runs',
            'app.accounting_piece_keys',
            'app.deficit_settlements',
            'app.deficit_settlement_effects',
            'app.deficit_settlement_events',
            'app.deficit_settlement_event_deltas',
            'app.movement_value_heads',
            'app.dependent_operation_heads',
            'app.source_classification_intervals',
            'app.recognized_class_amounts',
            'app.reversal_settlement_splits',
            'app.legacy_certification_groups',
            'app.legacy_certification_members',
            'app.legacy_certification_splits',
            'app.open_deficit_queue',
            'app.sort_group_items',
            'ledger_scratch.accounting_run_context',
            'ledger_scratch.replay_probe_control',
            'ledger_scratch.replay_probe_pieces'
          ]
        ) as t (name)
      where
        pg_catalog.to_regclass (t.name) is not null
    ),
    19::bigint,
    '8a schema: all 19 new section-2, section-3, section-8, and probe tables exist'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname = 'app'
        and c.relname = 'stock_movements'
        and a.attnum > 0
        and not a.attisdropped
        and a.attname = any (
          array[
            'accounting_run_id',
            'settlement_event_id',
            'settlement_locus',
            'dependent_operation_id',
            'dependent_role',
            'dependent_mode',
            'posting_bucket',
            'posting_waste_reason',
            'posting_report_class'
          ]
        )
    ),
    9::bigint,
    '8a schema: stock_movements has all 9 nullable posting link columns'
  );

select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_class ic
        join pg_catalog.pg_namespace n on n.oid = ic.relnamespace
      where
        n.nspname = 'app'
        and ic.relkind = 'i'
        and ic.relname = any (
          array[
            'deficit_settlements_active_inflow_idx',
            'deficit_settlements_active_deficit_idx',
            'open_deficit_queue_fifo_idx',
            'open_deficit_queue_source_idx',
            'sort_group_items_item_at_batch_idx',
            'sort_group_items_batch_item_idx',
            'dependent_operation_heads_source_key_idx',
            'dependent_operation_heads_item_key_idx',
            'source_classification_intervals_scope_idx',
            'stock_movements_settlement_event_idx',
            'stock_movements_dependent_op_idx',
            'stock_movements_dependent_run_delta_uidx',
            'reversal_settlement_splits_event_idx'
          ]
        )
    ),
    13::bigint,
    '8a schema: all 13 required section-8 indexes exist'
  );

select
  is (
    (
      select
        count(distinct c.oid)::text || '/' || count(*) filter (
          where
            a.atttypid = 'uuid'::regtype
            and a.attname ~ '(_by|^actor_id|^owner_id|(^|_)user_id)$'
        )::text
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid = c.oid
        and a.attnum > 0
        and not a.attisdropped
      where
        n.nspname = 'app'
        and c.relname = any (
          array[
            'accounting_runs',
            'accounting_piece_keys',
            'deficit_settlements',
            'deficit_settlement_effects',
            'deficit_settlement_events',
            'deficit_settlement_event_deltas',
            'movement_value_heads',
            'dependent_operation_heads',
            'source_classification_intervals',
            'recognized_class_amounts',
            'reversal_settlement_splits',
            'legacy_certification_groups',
            'legacy_certification_members',
            'legacy_certification_splits',
            'open_deficit_queue',
            'sort_group_items'
          ]
        )
    ),
    '16/0',
    '8a backup: all 16 new app tables exist and add zero owner-remap columns'
  );

-- ============================================================================
-- Group 3: Direct schema constraint exercises
-- ============================================================================
select
  app.record_opening_stock (
    '2026-11-01T09:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '8a000000-0000-4000-8000-000000000002',
        'quantity',
        '5',
        'unit',
        'kg',
        'unit_cost',
        '20',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    '8a000000-0000-4000-8000-000000000103'
  );

create temp table t8a_ids (label text primary key, id bigint not null) on
commit
drop;

insert into
  t8a_ids (label, id)
select
  'm1_open',
  sm.id
from
  app.stock_movements sm
where
  sm.item_id = '8a000000-0000-4000-8000-000000000001'
  and sm.movement_type = 'opening'
order by
  sm.id
limit
  1;

insert into
  t8a_ids (label, id)
select
  'm1_purch',
  sm.id
from
  app.stock_movements sm
where
  sm.item_id = '8a000000-0000-4000-8000-000000000001'
  and sm.movement_type = 'purchase'
order by
  sm.id
limit
  1;

insert into
  t8a_ids (label, id)
select
  'm2_open',
  sm.id
from
  app.stock_movements sm
where
  sm.item_id = '8a000000-0000-4000-8000-000000000002'
  and sm.movement_type = 'opening'
order by
  sm.id
limit
  1;

select
  is (
    pg_temp.exec_sqlstate (
      $$insert into app.accounting_runs (cause_id, entry_point, t_change, window_start)
        values (
          '8a000000-0000-4000-8000-000000000201',
          'test_8a',
          '2026-11-15 12:00:00+00',
          '2026-10-11 22:00:00+00'
        )$$
    ),
    'OK',
    '8a constraint: accounting_runs accepts valid durable provenance row'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$update app.accounting_runs set entry_point = 'mutated'$$
    ),
    '55000',
    '8a constraint: accounting_runs is append-only (UPDATE rejected)'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.accounting_piece_keys (
          item_id, origin_kind, movement_id, count_id, count_line_no,
          occurred_at, ord_class, event_position, piece_position, tie_breaker,
          source_kind, source_id, initial_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001', 'movement',
          (select id from t8a_ids where label = 'm1_open'),
          '8a000000-0000-4000-8000-000000000301', 1,
          '2026-11-01 08:00:00+00', 0, 1, 0, 1,
          'opening', 'open-1', 'inventory'
        )$$
    ),
    '23514',
    '8a constraint: accounting_piece_keys rejects movement origin with count columns set'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.accounting_piece_keys (
          item_id, origin_kind, movement_id, count_id, count_line_no,
          occurred_at, ord_class, event_position, piece_position, tie_breaker,
          source_kind, source_id, initial_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001', 'count_anchor',
          null, null, null,
          '2026-11-01 08:00:00+00', 1, 1, 0, 1,
          'count', 'cnt-1', 'count'
        )$$
    ),
    '23514',
    '8a constraint: accounting_piece_keys rejects count_anchor with null count_id/line_no'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.accounting_piece_keys (
          item_id, origin_kind, movement_id, count_id, count_line_no,
          occurred_at, ord_class, event_position, piece_position, tie_breaker,
          source_kind, source_id, initial_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001', 'count_anchor',
          null, '8a000000-0000-4000-8000-000000000399', 1,
          '2026-11-03 08:00:00+00', 1, 10, 0, 1,
          'count', 'cnt-deferred', 'count'
        );
        set constraints app.accounting_piece_keys_count_line_fk immediate$$
    ),
    '23503',
    '8a constraint: accounting_piece_keys count_line FK is deferrable and rejects missing line at commit/immediate'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.accounting_piece_keys (
          item_id, origin_kind, movement_id, count_id, count_line_no,
          occurred_at, ord_class, event_position, piece_position, tie_breaker,
          source_kind, source_id, initial_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001', 'count_anchor',
          null, '8a000000-0000-4000-8000-000000000398', 1,
          '2026-11-03 08:00:00+00', 1, 10, 0, 1,
          'count', 'cnt-deferred-ok', 'count'
        );
        insert into app.stock_counts (id, request_id, frequency, counted_at)
        values (
          '8a000000-0000-4000-8000-000000000398',
          '8a000000-0000-4000-8000-000000000397',
          'daily',
          '2026-11-03 08:00:00+00'
        );
        insert into app.stock_count_lines (
          count_id, line_no, item_id, expected_base_unit,
          counted_qty, expected_qty, delta_qty, delta_value
        ) values (
          '8a000000-0000-4000-8000-000000000398', 1,
          '8a000000-0000-4000-8000-000000000001', 'kg',
          15, 15, 0, 0
        );
        set constraints app.accounting_piece_keys_count_line_fk immediate$$
    ),
    'OK',
    '8a constraint: accounting_piece_keys allows reserving anchor before count line insert when satisfied by commit'
  );

select
  is (
    pg_temp.exec_sqlstate (
      $$with ins as (
          insert into app.accounting_piece_keys (
            item_id, origin_kind, movement_id,
            occurred_at, ord_class, event_position, piece_position, tie_breaker,
            source_kind, source_id, initial_bucket
          ) values
            (
              '8a000000-0000-4000-8000-000000000001', 'movement',
              (select id from t8a_ids where label = 'm1_open'),
              '2026-11-01 08:00:00+00', 0, 1, 0, 1,
              'order', 'ord-8a-1', 'cogs'
            ),
            (
              '8a000000-0000-4000-8000-000000000001', 'movement',
              (select id from t8a_ids where label = 'm1_purch'),
              '2026-11-02 08:00:00+00', 0, 2, 0, 2,
              'purchase', 'purch-8a-1', 'inventory'
            ),
            (
              '8a000000-0000-4000-8000-000000000002', 'movement',
              (select id from t8a_ids where label = 'm2_open'),
              '2026-11-01 09:00:00+00', 0, 3, 0, 3,
              'opening', 'open-8a-2', 'inventory'
            )
          returning id, source_id
        )
        insert into t8a_ids (label, id)
        select
          case source_id
            when 'ord-8a-1' then 'pk1_d'
            when 'purch-8a-1' then 'pk1_i'
            else 'pk2_other'
          end,
          id
        from ins$$
    ),
    'OK',
    '8a constraint: accounting_piece_keys inserts valid movement pieces'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.accounting_piece_keys (
          item_id, origin_kind, movement_id,
          occurred_at, ord_class, event_position, piece_position, tie_breaker,
          source_kind, source_id, initial_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001', 'movement',
          (select id from t8a_ids where label = 'm1_open'),
          '2026-11-01 08:00:00+00', 0, 1, 0, 1,
          'order', 'ord-8a-dup', 'cogs'
        )$$
    ),
    '23505',
    '8a constraint: accounting_piece_keys enforces unique movement_id'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.deficit_settlements (
          item_id, deficit_piece_id, inflow_piece_id,
          settlement_kind, settled_qty, provisional_value, inflow_value,
          required_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001',
          (select id from t8a_ids where label = 'pk1_d'),
          (select id from t8a_ids where label = 'pk2_other'),
          'fifo', 5, 50, 50, 'cogs'
        )$$
    ),
    '23503',
    '8a constraint: deficit_settlements rejects cross-item endpoints'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.deficit_settlements (
          item_id, deficit_piece_id, inflow_piece_id,
          settlement_kind, settled_qty, provisional_value, inflow_value,
          required_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001',
          (select id from t8a_ids where label = 'pk1_i'),
          (select id from t8a_ids where label = 'pk1_d'),
          'fifo', 5, 50, 50, 'cogs'
        )$$
    ),
    '23514',
    '8a constraint: deficit_settlements rejects out-of-economic-order endpoints (D >= I)'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.deficit_settlements (
          item_id, deficit_piece_id, inflow_piece_id,
          settlement_kind, settled_qty, provisional_value, inflow_value,
          required_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001',
          (select id from t8a_ids where label = 'pk1_d'),
          (select id from t8a_ids where label = 'pk1_i'),
          'inactive', 5, 0, 0, null
        )$$
    ),
    '23514',
    '8a constraint: deficit_settlements rejects inactive pair with nonzero qty'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.deficit_settlements (
          item_id, deficit_piece_id, inflow_piece_id,
          settlement_kind, settled_qty, provisional_value, inflow_value,
          required_bucket, carrier_shift_id, carrier_shift_resolved
        ) values (
          '8a000000-0000-4000-8000-000000000001',
          (select id from t8a_ids where label = 'pk1_d'),
          (select id from t8a_ids where label = 'pk1_i'),
          'fifo', 5, 50, 50, 'cogs', 'shift-1', false
        )$$
    ),
    '23514',
    '8a constraint: deficit_settlements rejects non-null carrier_shift_id when unresolved'
  );

select
  is (
    pg_temp.exec_sqlstate (
      $$with ins as (
          insert into app.deficit_settlements (
            item_id, deficit_piece_id, inflow_piece_id,
            settlement_kind, settled_qty, provisional_value, inflow_value,
            required_bucket, event_no, carrier_shift_id, carrier_shift_resolved
          ) values (
            '8a000000-0000-4000-8000-000000000001',
            (select id from t8a_ids where label = 'pk1_d'),
            (select id from t8a_ids where label = 'pk1_i'),
            'fifo', 5, 50, 50, 'cogs', 1, null, true
          )
          returning id
        )
        insert into t8a_ids (label, id)
        select 'stl_1', id from ins$$
    ),
    'OK',
    '8a constraint: deficit_settlements accepts zero-money FIFO cover with pinned NULL carrier shift'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$update app.deficit_settlements
        set carrier_shift_id = 'shift-late'
        where id = (select id from t8a_ids where label = 'stl_1')$$
    ),
    '55000',
    '8a constraint: deficit_settlements pins NULL carrier_shift_id once resolved'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$delete from app.deficit_settlements
        where id = (select id from t8a_ids where label = 'stl_1')$$
    ),
    '55000',
    '8a constraint: deficit_settlements rejects DELETE (retains inactive keys)'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.deficit_settlement_effects (
          settlement_id, bucket, waste_reason, report_class, posted_b, posted_c
        ) values (
          (select id from t8a_ids where label = 'stl_1'), 'cogs', null, null, 0, 0
        )$$
    ),
    '23514',
    '8a constraint: deficit_settlement_effects rejects all-zero sparse row'
  );

select
  is (
    pg_temp.exec_sqlstate (
      $$insert into app.deficit_settlement_effects (
          settlement_id, bucket, waste_reason, report_class, posted_b, posted_c
        ) values (
          (select id from t8a_ids where label = 'stl_1'), 'cogs', null, null, -50, 50
        )$$
    ),
    'OK',
    '8a constraint: deficit_settlement_effects accepts offsetting historical B/C row'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.deficit_settlement_effects (
          settlement_id, bucket, waste_reason, report_class, posted_b, posted_c
        ) values (
          (select id from t8a_ids where label = 'stl_1'), 'cogs', null, null, -10, 0
        )$$
    ),
    '23505',
    '8a constraint: deficit_settlement_effects enforces UNIQUE NULLS NOT DISTINCT on nullable class fields'
  );

select
  is (
    pg_temp.exec_sqlstate (
      $$with ins as (
          insert into app.deficit_settlement_events (
            settlement_id, event_no, run_id, cause_id,
            economic_at, posting_at, operation,
            old_kind, old_qty, old_provisional_value, old_inflow_value,
            new_kind, new_qty, new_provisional_value, new_inflow_value,
            delta_b_total, delta_c_total
          ) values (
            (select id from t8a_ids where label = 'stl_1'),
            1,
            (select id from app.accounting_runs order by id desc limit 1),
            '8a000000-0000-4000-8000-000000000201',
            '2026-11-02 08:00:00+00',
            '2026-11-02 08:00:00+00',
            'create',
            'inactive', 0, 0, 0,
            'fifo', 5, 50, 50,
            0, 0
          )
          returning id
        )
        insert into t8a_ids (label, id)
        select 'ev_1', id from ins$$
    ),
    'OK',
    '8a constraint: deficit_settlement_events accepts zero-money economic change event'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.deficit_settlement_events (
          settlement_id, event_no, run_id, cause_id,
          economic_at, posting_at, operation,
          old_kind, old_qty, old_provisional_value, old_inflow_value,
          new_kind, new_qty, new_provisional_value, new_inflow_value
        ) values (
          (select id from t8a_ids where label = 'stl_1'),
          2,
          (select id from app.accounting_runs order by id desc limit 1),
          '8a000000-0000-4000-8000-000000000201',
          '2026-11-02 08:00:00+00',
          '2026-11-02 08:00:00+00',
          'update',
          'fifo', 5, 50, 50,
          'fifo', 5, 50, 60
        )$$
    ),
    '23505',
    '8a constraint: deficit_settlement_events enforces UNIQUE (settlement_id, run_id)'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$update app.deficit_settlement_events set operation = 'remove'
        where id = (select id from t8a_ids where label = 'ev_1')$$
    ),
    '55000',
    '8a constraint: deficit_settlement_events is append-only'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.dependent_operation_heads (
          operation_kind, item_id, source_kind, source_id,
          economic_at, event_position, piece_position,
          quantity_intent,
          effective_receipt_credit, original_signed_source_credit,
          certified_held_effect, cap_allocation
        ) values (
          'return', '8a000000-0000-4000-8000-000000000001',
          'waste_document', 'w-1',
          '2026-11-05 08:00:00+00', 100, 0,
          6,
          0, -111, -50, 111
        )$$
    ),
    '23514',
    '8a constraint: dependent_operation_heads rejects return where H <> F + K'
  );

select
  is (
    pg_temp.exec_sqlstate (
      $$with ins as (
          insert into app.dependent_operation_heads (
            operation_kind, item_id, source_kind, source_id,
            economic_at, event_position, piece_position,
            pinned_shift_id, pinned_shift_resolved,
            quantity_intent,
            effective_receipt_credit, original_signed_source_credit,
            certified_held_effect, cap_allocation
          ) values (
            'return', '8a000000-0000-4000-8000-000000000001',
            'waste_document', 'w-1',
            '2026-11-05 08:00:00+00', 100, 0,
            null, true,
            6,
            0, -111, 0, 111
          )
          returning id
        )
        insert into t8a_ids (label, id)
        select 'dep_ret', id from ins$$
    ),
    'OK',
    '8a constraint: dependent_operation_heads accepts valid return head with H = F + K (0 = -111 + 111)'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$update app.dependent_operation_heads
        set quantity_intent = 7
        where id = (select id from t8a_ids where label = 'dep_ret')$$
    ),
    '55000',
    '8a constraint: dependent_operation_heads rejects mutating quantity_intent'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.dependent_operation_heads (
          operation_kind, item_id, source_kind, source_id,
          economic_at, event_position, piece_position,
          quantity_intent, retained_qty,
          old_bucket, new_bucket
        ) values (
          'reclassification', '8a000000-0000-4000-8000-000000000001',
          'order', 'ord-r-1',
          '2026-11-05 08:00:00+00', 101, 0,
          5, 5,
          'cogs', 'cogs'
        )$$
    ),
    '23514',
    '8a constraint: dependent_operation_heads rejects reclassification with identical old and new class'
  );

select
  is (
    pg_temp.exec_sqlstate (
      $$insert into app.recognized_class_amounts (
          source_kind, source_id, item_id, bucket, waste_reason, report_class, amount
        ) values (
          'order', 'ord-8a-1', '8a000000-0000-4000-8000-000000000001',
          'cogs', null, null, 100.00
        )$$
    ),
    'OK',
    '8a constraint: recognized_class_amounts accepts valid class amount'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.recognized_class_amounts (
          source_kind, source_id, item_id, bucket, waste_reason, report_class, amount
        ) values (
          'order', 'ord-8a-1', '8a000000-0000-4000-8000-000000000001',
          'cogs', null, null, 50.00
        )$$
    ),
    '23505',
    '8a constraint: recognized_class_amounts enforces UNIQUE NULLS NOT DISTINCT'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.stock_movements (
          batch_id, item_id, movement_type, occurred_at,
          quantity, unit_cost, total_cost,
          closed_bucket, closed_cause_id,
          accounting_run_id, settlement_event_id, settlement_locus,
          dependent_operation_id, dependent_role, dependent_mode,
          posting_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000401',
          '8a000000-0000-4000-8000-000000000001',
          'closed_period', '2026-11-05 08:00:00+00',
          0, 0, 111,
          'cogs', '8a000000-0000-4000-8000-000000000401',
          (select id from app.accounting_runs order by id desc limit 1),
          (select id from t8a_ids where label = 'ev_1'), 'inflow',
          (select id from t8a_ids where label = 'dep_ret'), 'cap_allocation', 'cap_offset',
          'cogs'
        )$$
    ),
    '23514',
    '8a constraint: stock_movements rejects row carrying both settlement_event_id and dependent_operation_id'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.stock_movements (
          batch_id, item_id, movement_type, occurred_at,
          quantity, unit_cost, total_cost,
          closed_bucket, closed_cause_id,
          cover_inflow_movement_id, cover_deficit_movement_id,
          accounting_run_id, dependent_operation_id, dependent_role, dependent_mode,
          posting_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000402',
          '8a000000-0000-4000-8000-000000000001',
          'closed_period', '2026-11-05 08:00:00+00',
          0, 0, 111,
          'cogs', '8a000000-0000-4000-8000-000000000402',
          (select id from t8a_ids where label = 'm1_purch'),
          (select id from t8a_ids where label = 'm1_open'),
          (select id from app.accounting_runs order by id desc limit 1),
          (select id from t8a_ids where label = 'dep_ret'), 'cap_allocation', 'cap_offset',
          'cogs'
        )$$
    ),
    '23514',
    '8a constraint: stock_movements rejects cap_offset row carrying cover pair FKs'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.stock_movements (
          batch_id, item_id, movement_type, occurred_at,
          quantity, unit_cost, total_cost,
          closed_bucket, closed_cause_id,
          accounting_run_id, dependent_operation_id, dependent_role, dependent_mode,
          posting_bucket
        ) values
        (
          '8a000000-0000-4000-8000-000000000403',
          '8a000000-0000-4000-8000-000000000001',
          'closed_period', '2026-11-05 08:00:00+00',
          0, 0, 50,
          'cogs', '8a000000-0000-4000-8000-000000000403',
          (select id from app.accounting_runs order by id desc limit 1),
          (select id from t8a_ids where label = 'dep_ret'), 'cap_allocation', 'cap_offset',
          'cogs'
        ),
        (
          '8a000000-0000-4000-8000-000000000403',
          '8a000000-0000-4000-8000-000000000001',
          'closed_period', '2026-11-05 08:00:00+00',
          0, 0, 61,
          'cogs', '8a000000-0000-4000-8000-000000000403',
          (select id from app.accounting_runs order by id desc limit 1),
          (select id from t8a_ids where label = 'dep_ret'), 'cap_allocation', 'cap_offset',
          'cogs'
        )$$
    ),
    '23505',
    '8a constraint: stock_movements enforces one dependent delta per run, operation, class, role, and mode'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.reversal_settlement_splits (
          reversal_movement_id, line_no, split_kind, quantity, amount, bucket
        ) values (
          (select id from t8a_ids where label = 'm1_open'),
          1, 'base', 10, 100, 'inventory'
        )$$
    ),
    '23514',
    '8a constraint: reversal_settlement_splits rejects non-reversal movement'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.legacy_certification_groups (
          item_id, group_kind, certified_qty, certified_value
        ) values (
          '8a000000-0000-4000-8000-000000000001', 'retired', 0, -50
        )$$
    ),
    '23514',
    '8a constraint: legacy_certification_groups rejects retired group with nonzero certified totals'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$with g as (
          insert into app.legacy_certification_groups (
            item_id, group_kind, certified_qty, certified_value
          ) values (
            '8a000000-0000-4000-8000-000000000001', 'live', 10, 100
          )
          returning id
        )
        insert into app.legacy_certification_members (movement_id, group_id, item_id, member_role)
        select (select id from t8a_ids where label = 'm2_open'), g.id, '8a000000-0000-4000-8000-000000000001', 'target'
        from g$$
    ),
    '23514',
    '8a constraint: legacy_certification_members rejects cross-item movement'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$insert into app.open_deficit_queue (
          piece_id, item_id, occurred_at, ord_class, event_position, piece_position, tie_breaker,
          source_kind, source_id, qty_uncovered, value_uncovered, provisional_unit_cost
        ) values (
          (select id from t8a_ids where label = 'pk1_d'),
          '8a000000-0000-4000-8000-000000000001',
          '2026-11-01 08:00:00+00', 0, 1, 0, 1,
          'order', 'ord-8a-1', 0, 0, 10
        )$$
    ),
    '23514',
    '8a constraint: open_deficit_queue rejects exhausted (qty = 0) entry'
  );

-- ============================================================================
-- Group 4: RLS, grants, SECURITY DEFINER search_path, backup_reader revokes
-- ============================================================================
select
  is (
    (
      select
        count(*)
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        (n.nspname || '.' || c.relname) = any (
          array[
            'app.accounting_runs',
            'app.accounting_piece_keys',
            'app.deficit_settlements',
            'app.deficit_settlement_effects',
            'app.deficit_settlement_events',
            'app.deficit_settlement_event_deltas',
            'app.movement_value_heads',
            'app.dependent_operation_heads',
            'app.source_classification_intervals',
            'app.recognized_class_amounts',
            'app.reversal_settlement_splits',
            'app.legacy_certification_groups',
            'app.legacy_certification_members',
            'app.legacy_certification_splits',
            'app.open_deficit_queue',
            'app.sort_group_items',
            'ledger_scratch.accounting_run_context',
            'ledger_scratch.replay_probe_control',
            'ledger_scratch.replay_probe_pieces'
          ]
        )
        and c.relrowsecurity is true
        and not exists (
          select
            1
          from
            pg_catalog.pg_policy p
          where
            p.polrelid = c.oid
        )
    ),
    19::bigint,
    '8a privilege: all 19 new private tables have RLS enabled and zero API policies'
  );

select
  is (
    (
      select
        count(distinct c.oid)::text || '/' || count(*) filter (
          where
            has_table_privilege(r.rol, c.oid, 'SELECT')
            or has_table_privilege(r.rol, c.oid, 'INSERT')
            or has_table_privilege(r.rol, c.oid, 'UPDATE')
            or has_table_privilege(r.rol, c.oid, 'DELETE')
        )::text
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        cross join unnest(
          array['public', 'anon', 'authenticated', 'service_role']
        ) as r (rol)
      where
        (n.nspname || '.' || c.relname) = any (
          array[
            'app.accounting_runs',
            'app.accounting_piece_keys',
            'app.deficit_settlements',
            'app.deficit_settlement_effects',
            'app.deficit_settlement_events',
            'app.deficit_settlement_event_deltas',
            'app.movement_value_heads',
            'app.dependent_operation_heads',
            'app.source_classification_intervals',
            'app.recognized_class_amounts',
            'app.reversal_settlement_splits',
            'app.legacy_certification_groups',
            'app.legacy_certification_members',
            'app.legacy_certification_splits',
            'app.open_deficit_queue',
            'app.sort_group_items',
            'ledger_scratch.accounting_run_context',
            'ledger_scratch.replay_probe_control',
            'ledger_scratch.replay_probe_pieces'
          ]
        )
    ),
    '19/0',
    '8a privilege: all 19 new private tables revoke privileges from PUBLIC, anon, authenticated, and service_role'
  );

select
  is (
    (
      select
        count(distinct seq.oid)::text || '/' || count(*) filter (
          where
            has_sequence_privilege(r.rol, seq.oid, 'USAGE')
            or has_sequence_privilege(r.rol, seq.oid, 'SELECT')
            or has_sequence_privilege(r.rol, seq.oid, 'UPDATE')
        )::text
      from
        pg_catalog.pg_depend d
        join pg_catalog.pg_class seq on seq.oid = d.objid
        and seq.relkind = 'S'
        join pg_catalog.pg_class tbl on tbl.oid = d.refobjid
        join pg_catalog.pg_namespace n on n.oid = tbl.relnamespace
        cross join unnest(
          array['public', 'anon', 'authenticated', 'service_role']
        ) as r (rol)
      where
        (n.nspname || '.' || tbl.relname) = any (
          array[
            'app.accounting_runs',
            'app.accounting_piece_keys',
            'app.deficit_settlements',
            'app.deficit_settlement_effects',
            'app.deficit_settlement_events',
            'app.dependent_operation_heads',
            'app.source_classification_intervals',
            'app.recognized_class_amounts',
            'app.legacy_certification_groups'
          ]
        )
    ),
    '9/0',
    '8a privilege: all 9 new identity sequences revoke privileges from PUBLIC, anon, authenticated, and service_role'
  );

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'backup_reader') then
    create role backup_reader nologin;
  end if;
end;
$$;

select
  is (
    (
      select
        count(distinct fn.sig) filter (
          where
            pg_catalog.to_regprocedure (fn.sig) is not null
        )::text || '/' || count(*) filter (
          where
            pg_catalog.to_regprocedure (fn.sig) is not null
            and has_function_privilege(
              r.rol,
              pg_catalog.to_regprocedure (fn.sig),
              'EXECUTE'
            )
        )::text
      from
        unnest(
          array[
            'app.is_trusted_fixture_caller()',
            'app.accounting_run_enter(text,timestamptz,boolean,boolean)',
            'app.accounting_run_set_phase(uuid,text)',
            'app.accounting_run_assert(text[],boolean)',
            'app.accounting_run_exit(uuid,boolean)',
            'app.replay_probe_arm(boolean,text,jsonb)',
            'app.replay_probe_clear()',
            'app.replay_probe_is_enabled()',
            'app.replay_probe_active_override()'
          ]
        ) as fn (sig)
        cross join unnest(
          array[
            'public',
            'anon',
            'authenticated',
            'service_role',
            'backup_reader'
          ]
        ) as r (rol)
    ),
    '9/0',
    '8a privilege: all 9 new run-contract and replay-probe helpers exist and revoke EXECUTE from PUBLIC, anon, authenticated, service_role, and backup_reader'
  );

select
  is (
    (
      select
        count(*)::text || '/' || count(*) filter (
          where
            not (
              'search_path=""' = any (coalesce(p.proconfig, '{}'::text[]))
            )
        )::text
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname = any (
          array[
            'is_trusted_fixture_caller',
            'accounting_run_enter',
            'accounting_run_set_phase',
            'accounting_run_assert',
            'accounting_run_exit',
            'replay_probe_arm',
            'replay_probe_clear',
            'replay_probe_is_enabled',
            'replay_probe_active_override',
            'trg_deficit_settlements_guard',
            'trg_dependent_operation_heads_guard',
            'trg_reversal_settlement_splits_shape',
            'trg_legacy_certification_members_item_chk'
          ]
        )
    ),
    '13/0',
    '8a privilege: all 13 new helpers and guards pin search_path = ""'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$set local role authenticated;
        insert into app.deficit_settlements (
          item_id, deficit_piece_id, inflow_piece_id,
          settlement_kind, settled_qty, provisional_value, inflow_value,
          required_bucket
        ) values (
          '8a000000-0000-4000-8000-000000000001',
          (select id from t8a_ids where label = 'pk1_d'),
          (select id from t8a_ids where label = 'pk1_i'),
          'fifo', 1, 10, 10, 'cogs'
        )$$
    ),
    '42501',
    '8a privilege: authenticated cannot insert directly into deficit_settlements'
  );

-- ============================================================================
-- Group 5: Section-3 private run entry/exit/phase/lock/authority checks
-- ============================================================================
select
  is (
    pg_temp.probe_sqlstate (
      $$select app.accounting_run_assert(array['stage'], false)$$
    ),
    '42501',
    '8a run contract: accounting_run_assert rejects missing run authority'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$select set_config('app.accounting_run_phase', 'publish', true);
        select set_config('app.accounting_run_token', gen_random_uuid()::text, true);
        select set_config('app.replay_frozen', '1', true);
        select app.accounting_run_assert(array['publish'], true)$$
    ),
    '42501',
    '8a run contract: forged GUCs convey zero run or historical authority'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$select pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);
        lock table app.pos_sync_runs in share mode;
        lock table app.pos_shifts in share mode;
        insert into ledger_scratch.accounting_run_context (
          backend_pid, xact_id, run_token, entry_point, phase,
          t_change, window_start, historical_authorized
        ) values (
          pg_catalog.pg_backend_pid(),
          ((pg_catalog.pg_current_xact_id()::text::bigint - 1)::text)::xid8,
          gen_random_uuid(),
          'stale_tx',
          'publish',
          '2026-11-15 12:00:00+00',
          '2026-10-11 22:00:00+00',
          false
        );
        select app.accounting_run_assert(array['publish'], false)$$
    ),
    '42501',
    '8a run contract: stale previous-transaction context row conveys no authority'
  );

select
  pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

lock table app.pos_sync_runs in share mode;

lock table app.pos_shifts in share mode;

select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_tok uuid;
          v_durable_before bigint;
          v_durable_after bigint;
          v_code text;
        begin
          select count(*) into v_durable_before from app.accounting_runs;
          v_tok := app.accounting_run_enter('test_lifecycle', null, true, true);
          select count(*) into v_durable_after from app.accounting_runs;
          if v_durable_after <> v_durable_before then
            raise exception 'transient run enter wrote durable accounting_runs';
          end if;

          v_code := pg_temp.probe_sqlstate('select app.accounting_run_assert(array[''publish''], false)');
          if v_code <> '55000' then
            raise exception 'expected 55000 for wrong phase, got %', v_code;
          end if;

          v_code := pg_temp.probe_sqlstate(
            format('select app.accounting_run_set_phase(%L::uuid, ''publish'')', v_tok)
          );
          if v_code <> '55000' then
            raise exception 'expected 55000 for skipped phase, got %', v_code;
          end if;

          v_code := pg_temp.probe_sqlstate(
            format('select app.accounting_run_set_phase(%L::uuid, ''stage'')', gen_random_uuid())
          );
          if v_code <> '42501' then
            raise exception 'expected 42501 for wrong token, got %', v_code;
          end if;

          v_code := pg_temp.probe_sqlstate(
            format('select app.accounting_run_exit(%L::uuid, true)', v_tok)
          );
          if v_code <> '55000' then
            raise exception 'expected 55000 for early exit, got %', v_code;
          end if;

          v_code := pg_temp.probe_sqlstate('select app.accounting_run_assert(array[''authorize''], true)');
          if v_code <> '42501' then
            raise exception 'expected 42501 for missing historical authority, got %', v_code;
          end if;

          perform app.accounting_run_set_phase(v_tok, 'stage');
          perform app.accounting_run_assert(array['stage'], false);
          perform app.accounting_run_set_phase(v_tok, 'materialize');
          perform app.accounting_run_assert(array['materialize'], false);
          perform app.accounting_run_set_phase(v_tok, 'confirm');
          perform app.accounting_run_assert(array['confirm'], false);
          perform app.accounting_run_set_phase(v_tok, 'publish');
          perform app.accounting_run_assert(array['publish'], false);
          perform app.accounting_run_exit(v_tok, true);

          v_code := pg_temp.probe_sqlstate('select app.accounting_run_assert(array[''publish''], false)');
          if v_code <> '42501' then
            raise exception 'expected 42501 after exit, got %', v_code;
          end if;
        end
        $b$
        $$
    ),
    'OK',
    '8a run contract: full enter/phase/assert/exit lifecycle and transient-vs-durable separation hold'
  );

-- ============================================================================
-- Group 6: Privileged replay probe & cut-override contract (Scope Item 3)
-- ============================================================================
select
  app.record_purchase (
    jsonb_build_object(
      'request_id',
      '8a000000-0000-4000-8000-000000000104',
      'purchased_at',
      '2026-11-04T08:00:00Z',
      'supplier',
      '8a supplier',
      'invoice_no',
      '8A-2',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '8a000000-0000-4000-8000-000000000001',
          'quantity',
          '5',
          'unit',
          'kg',
          'amount_paid',
          '100.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  app.replay_execute (
    array['8a000000-0000-4000-8000-000000000001']::uuid[],
    '[]'::jsonb,
    '8a000000-0000-4000-8000-000000000501',
    true
  );

insert into
  t8a_ids (label, id)
select
  'cp_day4',
  cp.id
from
  app.replay_checkpoints cp
where
  cp.item_id = '8a000000-0000-4000-8000-000000000001'
order by
  cp.id desc
limit
  1;

select
  app.record_purchase (
    jsonb_build_object(
      'request_id',
      '8a000000-0000-4000-8000-000000000105',
      'purchased_at',
      '2026-11-06T08:00:00Z',
      'supplier',
      '8a supplier',
      'invoice_no',
      '8A-3',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '8a000000-0000-4000-8000-000000000001',
          'quantity',
          '5',
          'unit',
          'kg',
          'amount_paid',
          '100.00',
          'expected_base_unit',
          'kg',
          'expected_factor',
          '1'
        )
      )
    )
  );

select
  app.replay_execute (
    array['8a000000-0000-4000-8000-000000000001']::uuid[],
    '[]'::jsonb,
    '8a000000-0000-4000-8000-000000000502',
    true
  );

insert into
  t8a_ids (label, id)
select
  'cp_day6',
  cp.id
from
  app.replay_checkpoints cp
where
  cp.item_id = '8a000000-0000-4000-8000-000000000001'
order by
  cp.id desc
limit
  1;

select
  app.post_movements (
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '8a000000-0000-4000-8000-000000000001',
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-11-07T08:00:00Z',
        'quantity',
        2,
        'unit_cost',
        20
      )
    )
  );

insert into
  t8a_ids (label, id)
select
  'm1_day7',
  sm.id
from
  app.stock_movements sm
where
  sm.item_id = '8a000000-0000-4000-8000-000000000001'
order by
  sm.id desc
limit
  1;

-- 6a. Selection mode (override OFF)
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_probe record;
          v_cp6 bigint := (select id from t8a_ids where label = 'cp_day6');
          v_m7 bigint := (select id from t8a_ids where label = 'm1_day7');
        begin
          delete from app.replay_read_probe;
          perform app.replay_probe_arm(true, 'none', '{}'::jsonb);
          perform app.replay_execute(
            array['8a000000-0000-4000-8000-000000000001']::uuid[],
            '[]'::jsonb,
            '8a000000-0000-4000-8000-000000000503',
            true
          );
          select
            p.is_confirming,
            p.override_mode,
            p.selected_cuts,
            p.processed_pieces
          into v_probe
          from app.replay_read_probe p
          order by p.id desc
          limit 1;

          if v_probe.is_confirming is distinct from true then
            raise exception 'expected is_confirming=true, got %', v_probe.is_confirming;
          end if;
          if v_probe.override_mode is distinct from 'none' then
            raise exception 'expected override_mode=none, got %', v_probe.override_mode;
          end if;
          if (v_probe.selected_cuts -> 0 ->> 'checkpoint_id')::bigint is distinct from v_cp6 then
            raise exception 'expected selected cut %, got %', v_cp6, v_probe.selected_cuts;
          end if;
          if pg_catalog.jsonb_array_length(v_probe.processed_pieces) <> 1
             or (v_probe.processed_pieces -> 0 ->> 'movement_id')::bigint is distinct from v_m7 then
            raise exception 'expected processed_pieces=[%], got %', v_m7, v_probe.processed_pieces;
          end if;
        end
        $b$
        $$
    ),
    'OK',
    '8a replay probe: selection mode (override off) records exact production cut and confirming processed pieces'
  );

-- 6b. Forced-full mode
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_probe record;
        begin
          delete from app.replay_read_probe;
          perform app.replay_probe_arm(true, 'forced_full', '{}'::jsonb);
          perform app.replay_execute(
            array['8a000000-0000-4000-8000-000000000001']::uuid[],
            '[]'::jsonb,
            '8a000000-0000-4000-8000-000000000504',
            true
          );
          select
            p.is_confirming,
            p.override_mode,
            p.selected_cuts,
            p.processed_pieces
          into v_probe
          from app.replay_read_probe p
          order by p.id desc
          limit 1;

          if v_probe.override_mode is distinct from 'forced_full' then
            raise exception 'expected override_mode=forced_full, got %', v_probe.override_mode;
          end if;
          if v_probe.selected_cuts -> 0 ->> 'checkpoint_id' is not null then
            raise exception 'expected null checkpoint_id in forced_full, got %', v_probe.selected_cuts;
          end if;
          if pg_catalog.jsonb_array_length(v_probe.processed_pieces) <> 5 then
            raise exception 'expected 5 processed pieces in full walk, got %', pg_catalog.jsonb_array_length(v_probe.processed_pieces);
          end if;
        end
        $b$
        $$
    ),
    'OK',
    '8a replay probe: forced_full bypasses cut selection only and records null cut + full piece sequence'
  );

-- 6c. Forced-cut mode on eligible earlier cut (cp_day4)
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_probe record;
          v_cp4 bigint := (select id from t8a_ids where label = 'cp_day4');
        begin
          delete from app.replay_read_probe;
          perform app.replay_probe_arm(
            true,
            'forced_cut',
            pg_catalog.jsonb_build_object('8a000000-0000-4000-8000-000000000001', v_cp4)
          );
          perform app.replay_execute(
            array['8a000000-0000-4000-8000-000000000001']::uuid[],
            '[]'::jsonb,
            '8a000000-0000-4000-8000-000000000505',
            true
          );
          select
            p.override_mode,
            p.selected_cuts,
            p.processed_pieces
          into v_probe
          from app.replay_read_probe p
          order by p.id desc
          limit 1;

          if v_probe.override_mode is distinct from 'forced_cut' then
            raise exception 'expected override_mode=forced_cut, got %', v_probe.override_mode;
          end if;
          if (v_probe.selected_cuts -> 0 ->> 'checkpoint_id')::bigint is distinct from v_cp4 then
            raise exception 'expected forced cut %, got %', v_cp4, v_probe.selected_cuts;
          end if;
          if pg_catalog.jsonb_array_length(v_probe.processed_pieces) <> 2 then
            raise exception 'expected 2 suffix pieces from cp_day4, got %', pg_catalog.jsonb_array_length(v_probe.processed_pieces);
          end if;
        end
        $b$
        $$
    ),
    'OK',
    '8a replay probe: forced_cut accepts eligible earlier cut and records exact cut and suffix pieces'
  );

-- 6d. Forced-cut rejects an invalidated cut
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_cp4 bigint := (select id from t8a_ids where label = 'cp_day4');
        begin
          insert into app.replay_checkpoint_invalidations (checkpoint_id, reason)
          values (v_cp4, 'test_invalidation');
          perform app.replay_probe_arm(
            true,
            'forced_cut',
            pg_catalog.jsonb_build_object('8a000000-0000-4000-8000-000000000001', v_cp4)
          );
          perform app.replay_execute(
            array['8a000000-0000-4000-8000-000000000001']::uuid[],
            '[]'::jsonb,
            '8a000000-0000-4000-8000-000000000506',
            true
          );
        end
        $b$
        $$
    ),
    '22023',
    '8a replay probe: forced_cut rejects invalidated cut'
  );

-- 6e. Forced-cut rejects a cut at/after pending movement
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_cp6 bigint := (select id from t8a_ids where label = 'cp_day6');
        begin
          perform app.replay_probe_arm(
            true,
            'forced_cut',
            pg_catalog.jsonb_build_object('8a000000-0000-4000-8000-000000000001', v_cp6)
          );
          perform app.replay_execute(
            array['8a000000-0000-4000-8000-000000000001']::uuid[],
            jsonb_build_array(jsonb_build_object(
              'line_key', 1,
              'batch_id', '8a000000-0000-4000-8000-000000000507',
              'item_id', '8a000000-0000-4000-8000-000000000001',
              'movement_type', 'purchase',
              'occurred_at', '2026-11-05T08:00:00Z',
              'quantity', 1,
              'unit_cost', 10,
              'total_cost', 10,
              'is_input_total', true
            )),
            '8a000000-0000-4000-8000-000000000507',
            false
          );
        end
        $b$
        $$
    ),
    '22023',
    '8a replay probe: forced_cut rejects cut at or after pending movement'
  );

-- 6f. Forced-cut rejects sort-incoherent cut pair straddling a sort batch
select
  app.record_opening_stock (
    '2026-11-01T08:00:00Z',
    jsonb_build_array(
      jsonb_build_object(
        'item_id',
        '8a000000-0000-4000-8000-000000000003',
        'quantity',
        '10',
        'unit',
        'kg',
        'unit_cost',
        '10',
        'expected_base_unit',
        'kg',
        'expected_factor',
        '1'
      )
    ),
    '8a000000-0000-4000-8000-000000000601'
  );

select
  app.replay_execute (
    array['8a000000-0000-4000-8000-000000000003']::uuid[],
    '[]'::jsonb,
    '8a000000-0000-4000-8000-000000000602',
    true
  );

insert into
  t8a_ids (label, id)
select
  'cp_mixed_pre_sort',
  cp.id
from
  app.replay_checkpoints cp
where
  cp.item_id = '8a000000-0000-4000-8000-000000000003'
order by
  cp.id desc
limit
  1;

select
  app.record_sort (
    jsonb_build_object(
      'request_id',
      '8a000000-0000-4000-8000-000000000603',
      'mixed_item_id',
      '8a000000-0000-4000-8000-000000000003',
      'occurred_at',
      '2026-11-02T10:00:00Z',
      'qty_taken',
      '5',
      'lines',
      jsonb_build_array(
        jsonb_build_object(
          'item_id',
          '8a000000-0000-4000-8000-000000000004',
          'quantity',
          '5'
        )
      )
    )
  );

select
  app.replay_execute (
    array[
      '8a000000-0000-4000-8000-000000000003',
      '8a000000-0000-4000-8000-000000000004'
    ]::uuid[],
    '[]'::jsonb,
    '8a000000-0000-4000-8000-000000000604',
    true
  );

insert into
  t8a_ids (label, id)
select
  'cp_size_post_sort',
  cp.id
from
  app.replay_checkpoints cp
where
  cp.item_id = '8a000000-0000-4000-8000-000000000004'
order by
  cp.id desc
limit
  1;

select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_cp_mixed bigint := (select id from t8a_ids where label = 'cp_mixed_pre_sort');
          v_cp_size bigint := (select id from t8a_ids where label = 'cp_size_post_sort');
        begin
          perform app.replay_probe_arm(
            true,
            'forced_cut',
            pg_catalog.jsonb_build_object(
              '8a000000-0000-4000-8000-000000000003', v_cp_mixed,
              '8a000000-0000-4000-8000-000000000004', v_cp_size
            )
          );
          perform app.replay_execute(
            array[
              '8a000000-0000-4000-8000-000000000003',
              '8a000000-0000-4000-8000-000000000004'
            ]::uuid[],
            '[]'::jsonb,
            '8a000000-0000-4000-8000-000000000605',
            false
          );
        end
        $b$
        $$
    ),
    '22023',
    '8a replay probe: forced_cut rejects sort-incoherent cut pair straddling a sort batch'
  );

-- 6g. Unauthorized callers cannot arm the probe/override
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        begin
          if pg_catalog.to_regprocedure('app.replay_probe_arm(boolean,text,jsonb)') is null then
            raise exception 'missing replay_probe_arm' using errcode = '42883';
          end if;
          set local role authenticated;
          perform app.replay_probe_arm(true, 'forced_full', '{}'::jsonb);
        end
        $b$
      $$
    ),
    '42501',
    '8a replay probe: authenticated cannot call replay_probe_arm'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        begin
          if pg_catalog.to_regprocedure('app.replay_probe_arm(boolean,text,jsonb)') is null then
            raise exception 'missing replay_probe_arm' using errcode = '42883';
          end if;
          set local role anon;
          perform app.replay_probe_arm(true, 'forced_full', '{}'::jsonb);
        end
        $b$
      $$
    ),
    '42501',
    '8a replay probe: anon cannot call replay_probe_arm'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        begin
          if pg_catalog.to_regprocedure('app.replay_probe_arm(boolean,text,jsonb)') is null then
            raise exception 'missing replay_probe_arm' using errcode = '42883';
          end if;
          set local role service_role;
          perform app.replay_probe_arm(true, 'forced_full', '{}'::jsonb);
        end
        $b$
      $$
    ),
    '42501',
    '8a replay probe: service_role cannot call replay_probe_arm'
  );

select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        begin
          if pg_catalog.to_regprocedure('app.replay_probe_arm(boolean,text,jsonb)') is null then
            raise exception 'missing replay_probe_arm' using errcode = '42883';
          end if;
          set local role backup_reader;
          perform app.replay_probe_arm(true, 'forced_full', '{}'::jsonb);
        end
        $b$
      $$
    ),
    '42501',
    '8a replay probe: backup_reader cannot call replay_probe_arm'
  );

-- 6h-1. Forged GUCs cannot activate cut override
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_mode text;
        begin
          perform set_config('app.replay_probe_override', 'forced_full', true);
          perform set_config('app.replay_forced_full', '1', true);
          perform set_config('app.replay_forced_cut', '1', true);
          select mode into v_mode from app.replay_probe_active_override();
          if v_mode is distinct from 'none' then
            raise exception 'forged GUC activated override: %', v_mode;
          end if;
        end
        $b$
        $$
    ),
    'OK',
    '8a replay probe: forged GUCs cannot activate cut override'
  );

-- 6h-2. Forged app.replay_probe=1 GUC under authenticated role cannot activate probe capture
-- (On baseline this fails because replay_execute checks app.replay_probe GUC without role check.)
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        begin
          delete from app.replay_read_probe;
          set local role authenticated;
          perform set_config('app.replay_probe', '1', true);
          perform app.record_purchase(jsonb_build_object(
            'request_id', '8a000000-0000-4000-8000-000000000701',
            'purchased_at', '2026-11-05T08:00:00Z',
            'supplier', '8a forged',
            'invoice_no', '8A-F1',
            'lines', jsonb_build_array(jsonb_build_object(
              'item_id', '8a000000-0000-4000-8000-000000000001',
              'quantity', '1',
              'unit', 'kg',
              'amount_paid', '10.00',
              'expected_base_unit', 'kg',
              'expected_factor', '1'
            ))
          ));
          reset role;
          if exists (select 1 from app.replay_read_probe) then
            raise exception 'forged app.replay_probe GUC under authenticated wrote a probe row';
          end if;
        end
        $b$
        $$
    ),
    'OK',
    '8a replay probe: forged app.replay_probe GUC under authenticated role cannot activate probe'
  );

-- 6i. Armed probe/override cannot authorize writes, run state, or historical replay
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_code text;
        begin
          perform app.replay_probe_arm(true, 'forced_full', '{}'::jsonb);

          v_code := pg_temp.probe_sqlstate(
            $q$select set_config(
                'request.jwt.claims',
                jsonb_build_object('sub', '8a000000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text,
                true
              );
              select app.assert_ledger_write_allowed()$q$
          );
          if v_code <> '42501' then
            raise exception 'expected 42501 for non-owner ledger write with probe armed, got %', v_code;
          end if;

          v_code := pg_temp.probe_sqlstate('select app.accounting_run_assert(array[''confirm''], false)');
          if v_code <> '42501' then
            raise exception 'expected 42501 for missing run authority with probe armed, got %', v_code;
          end if;

          v_code := pg_temp.probe_sqlstate('select app.accounting_run_assert(array[''confirm''], true)');
          if v_code <> '42501' then
            raise exception 'expected 42501 for missing historical authority with probe armed, got %', v_code;
          end if;
        end
        $b$
        $$
    ),
    'OK',
    '8a replay probe: armed override cannot authorize ledger writes, run state, or historical replay'
  );

-- 6j. Armed probe/override cannot leak from a previous transaction
select
  is (
    pg_temp.probe_sqlstate (
      $$do $b$
        declare
          v_mode text;
          v_enabled boolean;
        begin
          delete from ledger_scratch.replay_probe_control;
          insert into ledger_scratch.replay_probe_control (
            backend_pid, xact_id, probe_enabled, override_mode, forced_cuts
          ) values (
            pg_catalog.pg_backend_pid(),
            ((pg_catalog.pg_current_xact_id()::text::bigint - 1)::text)::xid8,
            true,
            'forced_full',
            '{}'::jsonb
          );
          select mode into v_mode from app.replay_probe_active_override();
          v_enabled := app.replay_probe_is_enabled();
          if v_mode is distinct from 'none' or v_enabled is distinct from false then
            raise exception 'previous transaction probe control leaked: mode=%, enabled=%', v_mode, v_enabled;
          end if;
        end
        $b$
        $$
    ),
    'OK',
    '8a replay probe: previous-transaction control row cannot leak into a later transaction'
  );

select
  *
from
  finish ();

rollback;
