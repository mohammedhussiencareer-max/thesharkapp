-- Owner read models for the phase 5 screens. Synthetic ids and names only.
-- No activation writer and no stock posting through the engine.
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
    'a7800000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-78@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a7800000-0000-4000-8000-0000000000a2',
    'authenticated',
    'authenticated',
    'intruder-78@theshark.test',
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
  ('a7800000-0000-4000-8000-0000000000a1');

create function pg_temp.as_user (p_sub text) returns void language sql as $$
  select
    set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', p_sub, 'role', 'authenticated')::text,
      true
    );
$$;

select
  results_eq (
    $$select r.role, p.fn, has_function_privilege(r.role, p.fn, 'execute')
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      cross join unnest(array[
        'app.accounting_processing_summary()',
        'app.opening_activation_review(uuid,integer)',
        'app.order_cost_detail(text)',
        'app.stock_count_derivation_detail(uuid)'
      ]) as p (fn)
      order by 2, 1$$,
    $$values
      ('anon', 'app.accounting_processing_summary()', false),
      ('authenticated', 'app.accounting_processing_summary()', true),
      ('service_role', 'app.accounting_processing_summary()', false),
      ('anon', 'app.opening_activation_review(uuid,integer)', false),
      ('authenticated', 'app.opening_activation_review(uuid,integer)', true),
      ('service_role', 'app.opening_activation_review(uuid,integer)', false),
      ('anon', 'app.order_cost_detail(text)', false),
      ('authenticated', 'app.order_cost_detail(text)', true),
      ('service_role', 'app.order_cost_detail(text)', false),
      ('anon', 'app.stock_count_derivation_detail(uuid)', false),
      ('authenticated', 'app.stock_count_derivation_detail(uuid)', true),
      ('service_role', 'app.stock_count_derivation_detail(uuid)', false)$$,
    'only authenticated may call the screen reads; each checks the owner inside'
  );

select
  results_eq (
    $$select r.role, p.fn, has_function_privilege(r.role, p.fn, 'execute')
      from unnest(array['anon', 'authenticated', 'service_role']) as r (role)
      cross join unnest(array[
        'app.accounting_read_uuid_list(jsonb)',
        'app.accounting_read_loss_versions(jsonb)',
        'app.accounting_read_conversion_versions(jsonb)'
      ]) as p (fn)
      order by 2, 1$$,
    $$values
      ('anon', 'app.accounting_read_conversion_versions(jsonb)', false),
      ('authenticated', 'app.accounting_read_conversion_versions(jsonb)', false),
      ('service_role', 'app.accounting_read_conversion_versions(jsonb)', false),
      ('anon', 'app.accounting_read_loss_versions(jsonb)', false),
      ('authenticated', 'app.accounting_read_loss_versions(jsonb)', false),
      ('service_role', 'app.accounting_read_loss_versions(jsonb)', false),
      ('anon', 'app.accounting_read_uuid_list(jsonb)', false),
      ('authenticated', 'app.accounting_read_uuid_list(jsonb)', false),
      ('service_role', 'app.accounting_read_uuid_list(jsonb)', false)$$,
    'provenance filters are not executable by any API role'
  );

select
  ok (
    (
      select
        bool_and(
          p.prosecdef
          and p.provolatile = 's'
          and p.proconfig = array['search_path=""']
          and p.prosrc !~ 'insert into|update |delete from'
        )
      from
        pg_catalog.pg_proc p
      where
        p.oid in (
          'app.accounting_processing_summary()'::regprocedure,
          'app.opening_activation_review(uuid,integer)'::regprocedure,
          'app.order_cost_detail(text)'::regprocedure,
          'app.stock_count_derivation_detail(uuid)'::regprocedure
        )
    ),
    'screen reads are stable, owner-definer, and contain no writers'
  );

select
  ok (
    not exists (
      select
        1
      from
        pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where
        n.nspname = 'app'
        and p.proname in (
          'activate_inventory',
          'record_inventory_activation'
        )
    ),
    'this migration does not add an activation writer'
  );

select
  throws_ok (
    $$select app.accounting_processing_summary()$$,
    '42501',
    'insufficient_privilege',
    'a session without an owner claim is refused'
  );

select
  pg_temp.as_user ('a7800000-0000-4000-8000-0000000000a2');

select
  throws_ok (
    $$select app.order_cost_detail('o-cost')$$,
    '42501',
    'insufficient_privilege',
    'a signed-in user who is not the owner is refused'
  );

select
  pg_temp.as_user ('a7800000-0000-4000-8000-0000000000a1');

select
  is (
    app.accounting_processing_summary () ->> 'activated',
    'false',
    'an empty activation table is not activated'
  );

select
  is (
    app.accounting_processing_summary () ->> 'pending_count',
    '0',
    'pending starts at zero'
  );

select
  is (
    app.accounting_processing_summary () -> 'coverage',
    'null'::jsonb,
    'coverage is absent until a successful finish'
  );

select
  throws_ok (
    $$select app.opening_activation_review(null, 0)$$,
    '22023',
    'limit is out of range',
    'a limit outside 1..200 is refused'
  );

select
  throws_ok (
    $$select app.order_cost_detail(' ')$$,
    '22023',
    'order id is required',
    'a blank order id is refused'
  );

select
  throws_ok (
    $$select app.stock_count_derivation_detail(null)$$,
    '22023',
    'count id is required',
    'a null count id is refused'
  );

create function pg_temp.seed () returns void language plpgsql as $$
declare
  v_item_1 uuid := 'a7800000-0000-4000-8000-000000000001';
  v_item_2 uuid := 'a7800000-0000-4000-8000-000000000002';
  v_version uuid := 'a7800000-0000-4000-8000-0000000000aa';
  v_pend_snap bigint;
  v_pend_input bigint;
  v_snap bigint;
  v_input bigint;
  v_sale bigint;
  v_rev bigint;
  v_comp bigint;
  v_app bigint;
  v_at timestamptz := '2026-01-02 12:00:00+00';
begin
  insert into
    app.stock_items (id, name, kind, base_unit, count_frequency)
  values
    (v_item_1, 'سمك قراءة', 'seafood', 'kg', 'daily'),
    (v_item_2, 'جمبري قراءة', 'seafood', 'kg', 'daily');

  insert into
    app.opening_stocks (id, request_id, occurred_at)
  values
    (
      'a7800000-0000-4000-8000-000000000010',
      'a7800000-0000-4000-8000-000000000011',
      '2026-01-01 08:00:00+00'
    );

  insert into
    app.opening_stock_lines (opening_id, line_no, item_id, quantity, unit, unit_cost)
  values
    (
      'a7800000-0000-4000-8000-000000000010',
      1,
      v_item_1,
      4.5,
      'kg',
      10.5
    );

  insert into
    app.pos_shifts (id, opened_at, closed_at, is_active, pos_update_time)
  values
    (
      'shift-read',
      '2026-01-01 00:00:00+00',
      null,
      false,
      '2026-01-01 00:00:00+00'
    );

  insert into
    app.pos_sync_coverage (
      run_id,
      started_at,
      finished_at,
      orders_scope_applied,
      scope_kind,
      scope_from,
      scope_shift_ids,
      presented_shift_ids,
      transactions_covered,
      legacy_direct
    )
  values
    (
      7801,
      '2026-01-03 00:00:00+00',
      '2026-01-03 01:00:00+00',
      true,
      'shift_ids',
      null,
      array['shift-a'],
      array['shift-a'],
      true,
      false
    );

  insert into
    app.pos_order_snapshots (
      order_id,
      version,
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
      lines,
      origin
    )
  values
    (
      'o-pend',
      1,
      'shift-read',
      'complete',
      '2026-01-01 10:00:00+00',
      10.00,
      0,
      0,
      0,
      0,
      10.00,
      '2026-01-01 10:00:00+00',
      repeat('ab', 32),
      '[]'::jsonb,
      'sync'
    )
  returning
    id into v_pend_snap;

  insert into
    app.pos_cost_inputs (
      order_id,
      input_revision,
      snapshot_id,
      missing_from_pos,
      refund_revision_ids,
      digest,
      origin
    )
  values
    (
      'o-pend',
      1,
      v_pend_snap,
      false,
      '{}'::bigint[],
      md5('o-pend'),
      'sync'
    )
  returning
    id into v_pend_input;

  insert into
    app.pos_order_snapshots (
      order_id,
      version,
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
      lines,
      origin
    )
  values
    (
      'o-cost',
      3,
      'shift-cost',
      'complete',
      '2026-02-01 00:00:00+00',
      10.00,
      0,
      0,
      0,
      0,
      10.00,
      '2026-02-01 00:00:00+00',
      repeat('cd', 32),
      '[]'::jsonb,
      'sync'
    )
  returning
    id into v_snap;

  insert into
    app.pos_cost_inputs (
      order_id,
      input_revision,
      snapshot_id,
      missing_from_pos,
      refund_revision_ids,
      digest,
      origin
    )
  values
    (
      'o-cost',
      2,
      v_snap,
      false,
      '{}'::bigint[],
      md5('o-cost'),
      'sync'
    )
  returning
    id into v_input;

  insert into
    app.accounting_work_state (
      order_id,
      work_generation,
      attempts,
      failed_at,
      last_outcome,
      last_reason,
      last_error_code
    )
  values
    (
      'o-block',
      1,
      0,
      null,
      'blocked',
      'missing_cost_basis',
      null
    ),
    (
      'o-fail',
      1,
      5,
      '2026-01-04 00:00:00+00',
      null,
      'RAWLEAK sentence',
      'XX000'
    ),
    (
      'o-both',
      2,
      5,
      '2026-01-05 00:00:00+00',
      null,
      'not a code',
      null
    );

  insert into
    app.accounting_work_attempts (
      order_id,
      work_generation,
      attempt_id,
      kind,
      sqlstate,
      reason
    )
  values
    (
      'o-fail',
      1,
      'a7800000-0000-4000-8000-0000000000f1',
      'escaped',
      '57014',
      'escaped'
    );

  insert into
    app.accounting_work_events (
      order_id,
      cause,
      source_key,
      cost_input_id,
      work_generation,
      processed_at
    )
  values
    ('o-pend', 'pos_input', 'read:pend', v_pend_input, null, null),
    (
      'o-block',
      'pos_input',
      'read:block',
      null,
      1,
      '2026-01-04 00:00:00+00'
    ),
    ('o-fail', 'pos_input', 'read:fail', null, 1, null),
    ('o-both', 'pos_input', 'read:both', null, null, null);

  insert into
    app.stock_movements (
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      shift_id
    )
  values
    (
      'a7800000-0000-4000-8000-000000000020',
      v_item_2,
      'sale',
      '2026-01-02 09:00:00+00',
      -1,
      10.5,
      -10.50,
      'shift-read'
    );

  insert into
    app.stock_movements (
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      shift_id
    )
  values
    (
      'a7800000-0000-4000-8000-000000000021',
      v_item_1,
      'sale',
      v_at,
      -2.5,
      10.5,
      -26.25,
      'shift-cost'
    )
  returning
    id into v_sale;

  insert into
    app.stock_movements (
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      adjusts_movement_id,
      shift_id
    )
  values
    (
      'a7800000-0000-4000-8000-000000000022',
      v_item_1,
      'cost_adjustment',
      v_at,
      0,
      0,
      -1.50,
      v_sale,
      'shift-cost'
    );

  insert into
    app.stock_movements (
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      reverses_movement_id,
      shift_id
    )
  values
    (
      'a7800000-0000-4000-8000-000000000023',
      v_item_1,
      'sale_reversal',
      v_at,
      2.5,
      10.5,
      27.75,
      v_sale,
      'shift-cost'
    )
  returning
    id into v_rev;

  insert into
    app.order_cost_applications (
      order_id,
      cost_input_id,
      snapshot_id,
      receipt_kind,
      disposition,
      occurred_at,
      shift_id,
      signature,
      requirements,
      provenance,
      reversal_movement_ids,
      work_generation
    )
  values
    (
      'o-cost',
      v_input,
      v_snap,
      'posting',
      'sale',
      v_at,
      'shift-cost',
      md5('o-cost-read'),
      jsonb_build_array(
        jsonb_build_object(
          'stock_item_id',
          v_item_1::text,
          'base_unit',
          'kg',
          'quantity',
          to_jsonb('4.5'::text)
        )
      ),
      jsonb_build_object(
        'mapping_versions',
        jsonb_build_array(v_version::text),
        'recipe_versions',
        '[]'::jsonb,
        'packaging_versions',
        '[]'::jsonb,
        'loss_versions',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            v_item_1::text,
            'version_id',
            v_version::text,
            'loss_pct',
            '0.1',
            'note',
            'SECRETPATH'
          )
        ),
        'conversion_versions',
        jsonb_build_array(
          jsonb_build_object(
            'item_id',
            v_item_1::text,
            'unit_code',
            'kg',
            'version_id',
            v_version::text,
            'factor_to_base',
            '1'
          )
        ),
        'paths',
        jsonb_build_array('SECRETPATH')
      ),
      array[v_rev],
      1
    )
  returning
    id into v_app;

  insert into
    app.order_cost_movement_links (movement_id, application_id, order_id, item_id)
  values
    (v_sale, v_app, 'o-cost', v_item_1);

  insert into
    app.order_cost_state (
      order_id,
      latest_input_id,
      latest_application_id,
      owner_application_id,
      disposition,
      signature,
      causes
    )
  values
    (
      'o-cost',
      v_input,
      v_app,
      v_app,
      'sale',
      md5('o-cost-read'),
      '[{"code":"missing_cost_basis","detail":"CAUSEDETAIL"}]'::jsonb
    );

  insert into
    app.stock_counts (id, request_id, frequency, counted_at, note)
  values
    (
      'a7800000-0000-4000-8000-000000000030',
      'a7800000-0000-4000-8000-000000000031',
      'daily',
      '2026-01-02 00:00:00+00',
      'جرد قراءة'
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
      delta_value
    )
  values
    (
      'a7800000-0000-4000-8000-000000000030',
      1,
      v_item_1,
      'kg',
      8,
      8,
      0,
      0
    );

  insert into
    app.stock_count_derivations (
      count_id,
      line_no,
      expected_qty,
      required_qty,
      required_value,
      cause_batch_id
    )
  values
    (
      'a7800000-0000-4000-8000-000000000030',
      1,
      6,
      2,
      21.50,
      'a7800000-0000-4000-8000-000000000032'
    );

  insert into
    app.stock_movements (
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      shift_id
    )
  values
    (
      'a7800000-0000-4000-8000-000000000024',
      v_item_1,
      'count_compensation',
      '2026-01-02 00:00:00+00',
      2,
      10.75,
      21.50,
      'shift-read'
    )
  returning
    id into v_comp;

  insert into
    app.stock_count_postings (movement_id, count_id, line_no, posting_role)
  values
    (
      v_comp,
      'a7800000-0000-4000-8000-000000000030',
      1,
      'compensation'
    );

  insert into
    app.stock_movements (
      batch_id,
      item_id,
      movement_type,
      occurred_at,
      quantity,
      unit_cost,
      total_cost,
      adjusts_movement_id,
      shift_id
    )
  values
    (
      'a7800000-0000-4000-8000-000000000025',
      v_item_1,
      'cost_adjustment',
      '2026-01-02 00:00:00+00',
      0,
      0,
      0.50,
      v_comp,
      'shift-read'
    );
end;
$$;

select
  pg_temp.seed ();

select
  pg_temp.as_user ('a7800000-0000-4000-8000-0000000000a1');

select
  is (
    app.accounting_processing_summary () ->> 'pending_count',
    '3',
    'an unclaimed event is pending, including one on a parked order and the cost input recorded for the detail fixture'
  );

select
  is (
    app.accounting_processing_summary () ->> 'blocked_count',
    '1',
    'a blocked order that is not parked is counted once'
  );

select
  is (
    app.accounting_processing_summary () ->> 'failed_count',
    '2',
    'every parked order is failed, even when a new event is pending'
  );

select
  is (
    app.accounting_processing_summary () ->> 'processed_event_count',
    '1',
    'processed events are the progress numerator'
  );

select
  is (
    app.accounting_processing_summary () ->> 'open_event_count',
    '5',
    'open events stay visible while work remains, including the event each cost input appends'
  );

select
  is (
    app.accounting_processing_summary () -> 'coverage' ->> 'run_id',
    '7801',
    'the latest successful coverage is the one that finished last'
  );

select
  is (
    app.accounting_processing_summary () -> 'coverage' ->> 'scope_kind',
    'shift_ids',
    'coverage keeps the scope kind'
  );

select
  is (
    app.accounting_processing_summary () -> 'coverage' ->> 'finished_at',
    app.costing_timestamptz_text ('2026-01-03 01:00:00+00'::timestamptz),
    'coverage time is UTC text'
  );

select
  ok (
    app.accounting_processing_summary ()::text not like '%RAWLEAK%',
    'a raw failure sentence is not returned'
  );

select
  is (
    (
      select
        parked ->> 'reason'
      from
        jsonb_array_elements(app.accounting_processing_summary () -> 'parked') parked
      where
        parked ->> 'order_id' = 'o-fail'
    ),
    'escaped',
    'the parked reason is the allow-listed attempt reason'
  );

select
  is (
    (
      select
        parked ->> 'sqlstate'
      from
        jsonb_array_elements(app.accounting_processing_summary () -> 'parked') parked
      where
        parked ->> 'order_id' = 'o-fail'
    ),
    '57014',
    'the parked SQLSTATE comes from the attempt, not the raw state code'
  );

select
  is (
    app.order_cost_detail ('o-missing') ->> 'found',
    'false',
    'an unknown order is found false'
  );

select
  is (
    app.order_cost_detail ('o-cost') ->> 'found',
    'true',
    'an order with an application is found'
  );

select
  is (
    app.order_cost_detail ('o-cost') #>> '{state,disposition}',
    'sale',
    'the head disposition is the saved one'
  );

select
  is (
    app.order_cost_detail ('o-cost') #>> '{input,snapshot_version}',
    '3',
    'the applied snapshot version is text'
  );

select
  is (
    app.order_cost_detail ('o-cost') #>> '{applications,0,lines,0,quantity}',
    '4.5',
    'a saved quantity stays decimal text'
  );

select
  is (
    app.order_cost_detail ('o-cost') #>> '{applications,0,reversals,0,total_cost}',
    '27.75',
    'a reversal value is the stored decimal text'
  );

select
  is (
    app.order_cost_detail ('o-cost') #>> '{applications,0,adjustments,0,total_cost}',
    '-1.5',
    'a cost adjustment value is decimal text'
  );

select
  is (
    app.order_cost_detail ('o-cost') #>> '{state,causes,0}',
    'missing_cost_basis',
    'a cause keeps its code'
  );

select
  ok (
    app.order_cost_detail ('o-cost')::text not like '%SECRETPATH%'
    and app.order_cost_detail ('o-cost')::text not like '%CAUSEDETAIL%',
    'provenance paths and cause details are not returned'
  );

select
  is (
    app.order_cost_detail ('o-cost') #>> '{applications,0,provenance,loss_versions,0,loss_pct}',
    '0.1',
    'a loss percent stays decimal text'
  );

select
  is (
    (
      select
        item #>> '{observation,explicit_zero}'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'roster'
        ) item
      where
        item ->> 'item_id' = 'a7800000-0000-4000-8000-000000000001'
    ),
    'false',
    'a stored opening is not an explicit zero'
  );

select
  is (
    (
      select
        item #>> '{observation,quantity}'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'roster'
        ) item
      where
        item ->> 'item_id' = 'a7800000-0000-4000-8000-000000000001'
    ),
    '4.5',
    'the opening quantity is decimal text'
  );

select
  is (
    (
      select
        item ->> 'missing'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'roster'
        ) item
      where
        item ->> 'item_id' = 'a7800000-0000-4000-8000-000000000002'
    ),
    'true',
    'an item with no opening line is missing'
  );

select
  is (
    (
      select
        item -> 'observation'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'roster'
        ) item
      where
        item ->> 'item_id' = 'a7800000-0000-4000-8000-000000000002'
    ),
    'null'::jsonb,
    'a missing observation is null rather than a guessed zero'
  );

select
  is (
    app.opening_activation_review (null, 100) ->> 'can_activate',
    'false',
    'gaps keep activation impossible'
  );

select
  is (
    (
      select
        item ->> 'count'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'checklist'
        ) item
      where
        item ->> 'code' = 'unreceipted_outflows'
    ),
    '1',
    'a sale with no receipt is the one unreceipted outflow'
  );

select
  is (
    (
      select
        item ->> 'ready'
      from
        jsonb_array_elements(
          app.opening_activation_review (null, 100) -> 'checklist'
        ) item
      where
        item ->> 'code' = 'empty_roster'
    ),
    'true',
    'a catalog with items is not an empty roster'
  );

select
  is (
    app.stock_count_derivation_detail ('a7800000-0000-4000-8000-000000000099') ->> 'found',
    'false',
    'an unknown count is found false'
  );

select
  is (
    app.stock_count_derivation_detail ('a7800000-0000-4000-8000-000000000030') ->> 'waiting_for_sync',
    'true',
    'a shift opened before the count and absent from coverage is waiting'
  );

select
  is (
    app.stock_count_derivation_detail ('a7800000-0000-4000-8000-000000000030') ->> 'waiting_for_processing',
    'true',
    'a pending order at or before the count is waiting'
  );

select
  is (
    app.stock_count_derivation_detail ('a7800000-0000-4000-8000-000000000030') #>> '{lines,0,original_expected_qty}',
    '8',
    'the original expected quantity stays text'
  );

select
  is (
    app.stock_count_derivation_detail ('a7800000-0000-4000-8000-000000000030') #>> '{lines,0,latest_required_qty}',
    '2',
    'the latest required quantity is the derivation'
  );

select
  is (
    app.stock_count_derivation_detail ('a7800000-0000-4000-8000-000000000030') #>> '{lines,0,compensator_qty}',
    '2',
    'compensation quantity is decimal text'
  );

select
  is (
    app.stock_count_derivation_detail ('a7800000-0000-4000-8000-000000000030') #>> '{lines,0,derived_surplus}',
    'true',
    'a positive latest requirement is a derived surplus'
  );

select
  ok (
    exists (
      select
        1
      from
        jsonb_array_elements(
          app.stock_count_derivation_detail ('a7800000-0000-4000-8000-000000000030') #> '{lines,0,postings}'
        ) posted
      where
        posted ->> 'role' = 'adjustment'
        and posted ->> 'total_cost' = '0.5'
    ),
    'a value adjustment on the settlement is listed'
  );

select
  finish ();

rollback;
