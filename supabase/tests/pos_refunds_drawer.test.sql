begin;

select
  plan (49);

-- Synthetic ids only. No POS documents and no customer data.
delete from app.owner;

delete from auth.identities
where
  user_id in (
    'a15e0001-0000-4000-8000-000000000015',
    'a15e0002-0000-4000-8000-000000000015'
  );

delete from auth.users
where
  id in (
    'a15e0001-0000-4000-8000-000000000015',
    'a15e0002-0000-4000-8000-000000000015'
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
    'a15e0001-0000-4000-8000-000000000015',
    'authenticated',
    'authenticated',
    'owner-refund@theshark.test',
    '',
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a15e0002-0000-4000-8000-000000000015',
    'authenticated',
    'authenticated',
    'intruder-refund@theshark.test',
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
  ('a15e0001-0000-4000-8000-000000000015');

create temp table refund_ledger as
select
  (
    select
      count(*)
    from
      app.stock_movements
  ) as movements,
  (
    select
      count(*)
    from
      app.item_balances
  ) as balances,
  (
    select
      count(*)
    from
      app.provisional_deficits
  ) as deficits;

create temp table refund_json (k text primary key, v jsonb);

grant all on refund_json to authenticated,
service_role;

create function pg_temp.refund_tx (
  p_id text,
  p_type int,
  p_amount text,
  p_order text default null
) returns jsonb language sql as $$
  select
    jsonb_build_object(
      'tx_id',
      p_id,
      'tx_type',
      p_type,
      'amount',
      p_amount,
      'order_id',
      p_order,
      'occurred_at',
      '2026-10-15T15:00:00Z',
      'description',
      'pii-tx-description'
    );
$$;

create function pg_temp.refund_shift (
  p_id text,
  p_updated timestamptz,
  p_cash text,
  p_credit text,
  p_txs jsonb
) returns jsonb language sql as $$
  select
    jsonb_build_object(
      'id',
      p_id,
      'opened_at',
      '2026-10-15T09:00:00Z',
      'closed_at',
      '2026-10-16T01:00:00Z',
      'is_active',
      false,
      'pos_update_time',
      p_updated,
      'drawer_cash_net',
      p_cash,
      'drawer_credit',
      p_credit,
      'transactions',
      p_txs,
      'description',
      'pii-should-drop'
    );
$$;

select
  has_table (
    'app',
    'pos_shift_transactions',
    'app.pos_shift_transactions exists'
  );

select
  has_view (
    'app',
    'pos_shift_summaries',
    'app.pos_shift_summaries exists'
  );

set
  local role anon;

select
  throws_ok (
    'select * from app.pos_shift_transactions',
    '42501'::char(5),
    null::text,
    'anon cannot select pos_shift_transactions'
  );

select
  throws_ok (
    'select * from app.pos_shift_summaries',
    '42501'::char(5),
    null::text,
    'anon cannot select pos_shift_summaries'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a15e0002-0000-4000-8000-000000000015',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  throws_ok (
    $$insert into app.pos_shift_transactions (
        shift_id, tx_id, tx_type, amount, occurred_at
      ) values ('shift-x', 'tx-x', 3, 1, now())$$,
    '42501'::char(5),
    null::text,
    'non-owner cannot insert pos_shift_transactions'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a15e0001-0000-4000-8000-000000000015',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  throws_ok (
    $$insert into app.pos_shift_transactions (
        shift_id, tx_id, tx_type, amount, occurred_at
      ) values ('shift-x', 'tx-x', 3, 1, now())$$,
    '42501'::char(5),
    null::text,
    'owner cannot insert pos_shift_transactions directly'
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
    $$insert into app.pos_shift_transactions (
        shift_id, tx_id, tx_type, amount, occurred_at
      ) values ('shift-x', 'tx-x', 3, 1, now())$$,
    '42501'::char(5),
    null::text,
    'service_role cannot insert pos_shift_transactions directly'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a15e0001-0000-4000-8000-000000000015',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

insert into
  refund_json (k, v)
select
  'run',
  to_jsonb(app.start_pos_sync_run ('recent'));

insert into
  refund_json (k, v)
select
  'first',
  app.ingest_pos_batch (
    (refund_json.v #>> '{}')::bigint,
    jsonb_build_array(
      pg_temp.refund_shift (
        'shift-refund-1',
        '2026-10-15T18:00:00Z',
        '50.00',
        '25.00',
        jsonb_build_array(
          pg_temp.refund_tx ('tx-pay', 0, '100', 'order-refund-complete'),
          pg_temp.refund_tx ('tx-reverse', 2, '1.00', null),
          pg_temp.refund_tx ('tx-refund', 3, '25.00', 'order-refund-complete'),
          pg_temp.refund_tx ('tx-unknown', 9, '3.50', null)
        )
      ),
      pg_temp.refund_shift (
        'shift-replace-1',
        '2026-10-15T18:00:00Z',
        '1.00',
        '2.00',
        jsonb_build_array(
          pg_temp.refund_tx ('tx-old-a', 0, '4.00', null),
          pg_temp.refund_tx ('tx-old-b', 3, '5.00', null)
        )
      ),
      jsonb_build_object(
        'id',
        'shift-nodrawer-1',
        'opened_at',
        '2026-10-14T09:00:00Z',
        'closed_at',
        null,
        'is_active',
        false,
        'pos_update_time',
        '2026-10-14T18:00:00Z',
        'transactions',
        '[]'::jsonb
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'id',
        'order-refund-complete',
        'order_number',
        4242,
        'shift_id',
        'shift-refund-1',
        'status',
        'complete',
        'order_type',
        'takeaway',
        'payment_type',
        'cash',
        'ordered_at',
        '2026-10-15T12:00:00Z',
        'subtotal',
        '100.00',
        'discount',
        '0',
        'tax',
        '0',
        'service_tax',
        '0',
        'delivery_fee',
        '0',
        'total',
        '100.00',
        'pos_update_time',
        '2026-10-15T12:00:00Z',
        'content_hash',
        repeat('ab', 32),
        'lines',
        '[]'::jsonb
      ),
      jsonb_build_object(
        'id',
        'order-refund-canceled',
        'shift_id',
        'shift-refund-1',
        'status',
        'canceled',
        'ordered_at',
        '2026-10-15T12:10:00Z',
        'subtotal',
        '40',
        'discount',
        '0',
        'tax',
        '0',
        'service_tax',
        '0',
        'delivery_fee',
        '0',
        'total',
        '40.00',
        'pos_update_time',
        '2026-10-15T12:10:00Z',
        'content_hash',
        repeat('cd', 32),
        'lines',
        '[]'::jsonb
      ),
      jsonb_build_object(
        'id',
        'order-refund-open',
        'shift_id',
        'shift-refund-1',
        'status',
        'active',
        'ordered_at',
        '2026-10-15T12:20:00Z',
        'subtotal',
        '30',
        'discount',
        '0',
        'tax',
        '0',
        'service_tax',
        '0',
        'delivery_fee',
        '0',
        'total',
        '30.00',
        'pos_update_time',
        '2026-10-15T12:20:00Z',
        'content_hash',
        repeat('ef', 32),
        'lines',
        '[]'::jsonb
      ),
      jsonb_build_object(
        'id',
        'order-refund-missing',
        'shift_id',
        'shift-refund-1',
        'status',
        'complete',
        'ordered_at',
        '2026-10-15T12:30:00Z',
        'subtotal',
        '999',
        'discount',
        '0',
        'tax',
        '0',
        'service_tax',
        '0',
        'delivery_fee',
        '0',
        'total',
        '999.00',
        'pos_update_time',
        '2026-10-15T12:30:00Z',
        'content_hash',
        repeat('12', 32),
        'lines',
        '[]'::jsonb
      )
    ),
    null
  )
from
  refund_json
where
  k = 'run';

select
  is (
    (
      select
        (v ->> 'transactions')::int
      from
        refund_json
      where
        k = 'first'
    ),
    6,
    'first batch counts every presented transaction'
  );

select
  is (
    (
      select
        drawer_cash_net
      from
        app.pos_shifts
      where
        id = 'shift-refund-1'
    ),
    50.00::numeric,
    'drawer cash is stored'
  );

select
  is (
    (
      select
        drawer_credit
      from
        app.pos_shifts
      where
        id = 'shift-refund-1'
    ),
    25.00::numeric,
    'drawer credit is stored'
  );

select
  is (
    (
      select
        amount
      from
        app.pos_shift_transactions
      where
        shift_id = 'shift-refund-1'
        and tx_id = 'tx-refund'
    ),
    25.00::numeric,
    'type 3 amount is stored'
  );

select
  is (
    (
      select
        order_id
      from
        app.pos_shift_transactions
      where
        shift_id = 'shift-refund-1'
        and tx_id = 'tx-refund'
    ),
    'order-refund-complete',
    'refund keeps its order id'
  );

select
  is (
    (
      select
        order_id
      from
        app.pos_shift_transactions
      where
        shift_id = 'shift-refund-1'
        and tx_id = 'tx-reverse'
    ),
    null,
    'a non-order transaction stores a null order id'
  );

insert into
  refund_json (k, v)
select
  'second',
  app.ingest_pos_batch (
    (refund_json.v #>> '{}')::bigint,
    jsonb_build_array(
      pg_temp.refund_shift (
        'shift-replace-1',
        '2026-10-15T19:00:00Z',
        '8.00',
        '9.00',
        jsonb_build_array(pg_temp.refund_tx ('tx-new-a', 3, '6.00', null))
      )
    ),
    '[]'::jsonb,
    null
  )
from
  refund_json
where
  k = 'run';

select
  is (
    (
      select
        (v ->> 'transactions')::int
      from
        refund_json
      where
        k = 'second'
    ),
    1,
    'replacement counts the presented set'
  );

select
  is_empty (
    $$select tx_id from app.pos_shift_transactions
      where shift_id = 'shift-replace-1' and tx_id in ('tx-old-a', 'tx-old-b')$$,
    'a second presentation removes transactions that are gone'
  );

select
  is (
    (
      select
        tx_id
      from
        app.pos_shift_transactions
      where
        shift_id = 'shift-replace-1'
    ),
    'tx-new-a',
    'a second presentation keeps the new transaction'
  );

select
  is (
    (
      select
        drawer_cash_net
      from
        app.pos_shifts
      where
        id = 'shift-replace-1'
    ),
    8.00::numeric,
    'a newer shift document updates the drawer'
  );

insert into
  refund_json (k, v)
select
  'third',
  app.ingest_pos_batch (
    (refund_json.v #>> '{}')::bigint,
    jsonb_build_array(
      pg_temp.refund_shift (
        'shift-replace-1',
        '2026-10-15T17:00:00Z',
        '100.00',
        '100.00',
        jsonb_build_array(pg_temp.refund_tx ('tx-stale-a', 0, '7', null))
      )
    ),
    '[]'::jsonb,
    null
  )
from
  refund_json
where
  k = 'run';

select
  is (
    (
      select
        (v ->> 'shifts_skipped')::int
      from
        refund_json
      where
        k = 'third'
    ),
    1,
    'an older shift document does not rewrite the shift row'
  );

select
  is (
    (
      select
        drawer_cash_net
      from
        app.pos_shifts
      where
        id = 'shift-replace-1'
    ),
    8.00::numeric,
    'a skipped shift keeps the stored drawer'
  );

select
  is (
    (
      select
        pos_update_time
      from
        app.pos_shifts
      where
        id = 'shift-replace-1'
    ),
    '2026-10-15T19:00:00Z'::timestamptz,
    'a skipped shift keeps its update time'
  );

select
  is (
    (
      select
        tx_id
      from
        app.pos_shift_transactions
      where
        shift_id = 'shift-replace-1'
    ),
    'tx-stale-a',
    'transactions are still replaced when the shift row is skipped'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(%L::jsonb), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      ),
      jsonb_build_object(
        'id',
        'shift-bad-1',
        'opened_at',
        '2026-10-15T09:00:00Z',
        'closed_at',
        null,
        'is_active',
        false,
        'pos_update_time',
        '2026-10-15T18:00:00Z'
      )::text
    ),
    '22023'::char(5),
    'transactions must be a jsonb array',
    'a shift without transactions is rejected'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(%L::jsonb), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      ),
      jsonb_build_object(
        'id',
        'shift-bad-1',
        'opened_at',
        '2026-10-15T09:00:00Z',
        'closed_at',
        null,
        'is_active',
        false,
        'pos_update_time',
        '2026-10-15T18:00:00Z',
        'transactions',
        1
      )::text
    ),
    '22023'::char(5),
    'transactions must be a jsonb array',
    'transactions must be an array'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'transactions', jsonb_build_array(1)
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'each transaction must be a jsonb object',
    'each transaction must be an object'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'transactions', jsonb_build_array(jsonb_build_object(
            'tx_id', '  ',
            'tx_type', 3,
            'amount', '1.00',
            'occurred_at', '2026-10-15T15:00:00Z'
          ))
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'tx_id is required',
    'a blank tx_id is rejected'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'transactions', jsonb_build_array(
            pg_temp.refund_tx('tx-dup', 3, '1.00', null),
            pg_temp.refund_tx('tx-dup', 0, '2.00', null)
          )
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'duplicate tx_id',
    'a duplicate tx_id in one shift is rejected'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'transactions', jsonb_build_array(jsonb_build_object(
            'tx_id', 'tx-bad',
            'tx_type', 1.5,
            'amount', '1.00',
            'occurred_at', '2026-10-15T15:00:00Z'
          ))
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'tx_type must be an integer',
    'a fractional tx_type is rejected'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'transactions', jsonb_build_array(jsonb_build_object(
            'tx_id', 'tx-bad',
            'tx_type', 3,
            'amount', 'not-money',
            'occurred_at', '2026-10-15T15:00:00Z'
          ))
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'amount must be a finite number',
    'a bad amount is rejected'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'transactions', jsonb_build_array(jsonb_build_object(
            'tx_id', 'tx-bad',
            'tx_type', 3,
            'amount', '1.00',
            'occurred_at', 'not-a-time'
          ))
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'occurred_at must be a finite timestamp',
    'a bad timestamp is rejected'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'drawer_cash_net', 'nope',
          'transactions', '[]'::jsonb
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'drawer_cash_net must be a finite number or null',
    'a bad drawer cash total is rejected'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'drawer_credit', true,
          'transactions', '[]'::jsonb
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'drawer_credit must be a finite number or null',
    'a bad drawer credit total is rejected'
  );

select
  throws_ok (
    format(
      $q$select app.ingest_pos_batch(%s, jsonb_build_array(jsonb_build_object(
          'id', 'shift-bad-1',
          'opened_at', '2026-10-15T09:00:00Z',
          'closed_at', null,
          'is_active', false,
          'pos_update_time', '2026-10-15T18:00:00Z',
          'transactions', jsonb_build_array(jsonb_build_object(
            'tx_id', 'tx-bad',
            'tx_type', 3,
            'amount', '1.00',
            'order_id', 5,
            'occurred_at', '2026-10-15T15:00:00Z'
          ))
        )), '[]'::jsonb, null)$q$,
      (
        select
          v #>> '{}'
        from
          refund_json
        where
          k = 'run'
      )
    ),
    '22023'::char(5),
    'order_id must be a string or null',
    'a numeric order_id is rejected'
  );

select
  app.finish_pos_sync_run (
    (
      select
        (v #>> '{}')::bigint
      from
        refund_json
      where
        k = 'run'
    ),
    'ok',
    '{"read":4}'::jsonb,
    null
  );

reset role;

update app.pos_orders
set
  missing_from_pos = true
where
  id = 'order-refund-missing';

set
  local role authenticated;

select
  is (
    (
      select
        gross_sales
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    100.00::numeric,
    'gross sales ignore missing, canceled, and open orders'
  );

select
  is (
    (
      select
        refunds
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    25.00::numeric,
    'refunds are the type 3 sum'
  );

select
  is (
    (
      select
        net_sales
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    75.00::numeric,
    'net sales are gross minus the refund'
  );

select
  is (
    (
      select
        drawer_total
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    75.00::numeric,
    'drawer total is cash plus credit'
  );

select
  is (
    (
      select
        drawer_difference
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    0.00::numeric,
    'a matching drawer has a zero difference'
  );

select
  is (
    (
      select
        orders_complete
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    1,
    'complete orders exclude the missing one'
  );

select
  is (
    (
      select
        orders_canceled
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    1,
    'canceled orders are counted'
  );

select
  is (
    (
      select
        orders_open
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    1,
    'open orders are counted'
  );

select
  is (
    (
      select
        orders_missing
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    1,
    'missing orders are counted on their own'
  );

select
  is (
    (
      select
        unknown_tx
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-refund-1'
    ),
    1,
    'a type outside 0, 2, and 3 is counted'
  );

select
  is (
    (
      select
        drawer_total
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-nodrawer-1'
    ),
    null::numeric,
    'a missing drawer total stays null'
  );

select
  is (
    (
      select
        drawer_difference
      from
        app.pos_shift_summaries
      where
        shift_id = 'shift-nodrawer-1'
    ),
    null::numeric,
    'a missing drawer has no difference'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'a15e0002-0000-4000-8000-000000000015',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  is_empty (
    'select shift_id, tx_id from app.pos_shift_transactions',
    'non-owner sees no shift transactions'
  );

select
  is_empty (
    'select shift_id from app.pos_shift_summaries',
    'non-owner sees no shift summaries'
  );

reset role;

select
  is (
    (
      select
        movements
      from
        refund_ledger
    ),
    (
      select
        count(*)
      from
        app.stock_movements
    ),
    'ingest does not write stock movements'
  );

select
  is (
    (
      select
        balances
      from
        refund_ledger
    ),
    (
      select
        count(*)
      from
        app.item_balances
    ),
    'ingest does not write item balances'
  );

select
  is (
    (
      select
        deficits
      from
        refund_ledger
    ),
    (
      select
        count(*)
      from
        app.provisional_deficits
    ),
    'ingest does not write provisional deficits'
  );

select
  finish ();

rollback;
