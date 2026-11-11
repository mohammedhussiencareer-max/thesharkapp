-- Shift accounting inputs. Synthetic ids and names only.
-- Read models, tracking history, and sales revision facts. No stock posting
-- through the engine, and record_count is not called.
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
    'a7700000-0000-4000-8000-0000000000a1',
    'authenticated',
    'authenticated',
    'owner-77@theshark.test',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a7700000-0000-4000-8000-0000000000a2',
    'authenticated',
    'authenticated',
    'intruder-77@theshark.test',
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
  ('a7700000-0000-4000-8000-0000000000a1');

create function pg_temp.u (p_n integer) returns uuid language sql immutable as $$
  select ('a7700000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;

create function pg_temp.as_user (p_sub text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated')::text,
    true
  );
$$;

create function pg_temp.shift (
  p_id text,
  p_open timestamptz,
  p_open_shift boolean default false
) returns void language plpgsql as $$
begin
  insert into
    app.pos_shifts (id, opened_at, closed_at, is_active, pos_update_time)
  values
    (
      p_id,
      p_open,
      case
        when p_open_shift then null
        else p_open + interval '10 hours'
      end,
      p_open_shift,
      p_open
    );
end;
$$;

create function pg_temp.daily_count (p_id uuid, p_at timestamptz, p_items uuid[]) returns void language plpgsql as $$
declare
  v_item uuid;
  v_n integer := 0;
begin
  insert into
    app.stock_counts (id, request_id, frequency, counted_at)
  values
    (p_id, pg_catalog.gen_random_uuid (), 'daily', p_at);

  foreach v_item in array p_items loop
    v_n := v_n + 1;

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
      (p_id, v_n, v_item, 'kg', 0, 0, 0, 0);
  end loop;
end;
$$;

create function pg_temp.ord (
  p_id text,
  p_shift text,
  p_status text,
  p_at timestamptz,
  p_total numeric
) returns void language sql as $$
  insert into app.pos_orders (
    id, shift_id, status, ordered_at, subtotal, discount, tax, service_tax,
    delivery_fee, total, pos_update_time, content_hash
  ) values (
    p_id, p_shift, p_status, p_at, p_total, 0, 0, 0, 0, p_total, p_at, repeat('ab', 32)
  );
$$;

create function pg_temp.cost_input (
  p_order text,
  p_shift text,
  p_version integer,
  p_status text,
  p_total numeric,
  p_missing boolean
) returns bigint language plpgsql as $$
declare
  v_snap bigint;
  v_at timestamptz;
  v_id bigint;
begin
  select
    o.ordered_at
  into v_at
  from
    app.pos_orders o
  where
    o.id = p_order;

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
      p_order,
      p_version,
      p_shift,
      p_status,
      v_at,
      p_total,
      0,
      0,
      0,
      0,
      p_total,
      v_at,
      repeat('ab', 32),
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
      p_order,
      p_version,
      v_snap,
      p_missing,
      '{}'::bigint[],
      md5(p_order || ':' || p_version::text),
      'sync'
    )
  returning
    id into v_id;

  return v_id;
end;
$$;

create function pg_temp.load () returns void language plpgsql as $$
begin
  drop table if exists pg_temp.status;

  create temp table status as
  select
    st ->> 'shift_id' as shift_id,
    st as body
  from
    app.list_shift_accounting_status (null, null, 100) st;
end;
$$;

create function pg_temp.lbl (p_shift text) returns text language plpgsql stable as $$
begin
  return (
    select
      body ->> 'status_label'
    from
      pg_temp.status
    where
      shift_id = p_shift
  );
end;
$$;

create function pg_temp.bit (p_shift text, p_key text) returns text language plpgsql stable as $$
begin
  return (
    select
      body ->> p_key
    from
      pg_temp.status
    where
      shift_id = p_shift
  );
end;
$$;

create function pg_temp.causes (p_shift text) returns text[] language plpgsql stable as $$
declare
  v_causes text[];
begin
  select
    coalesce(
      array_agg(
        e.value
        order by
          e.value
      ),
      '{}'::text[]
    )
  into v_causes
  from
    pg_temp.status s
    cross join lateral pg_catalog.jsonb_array_elements_text (s.body -> 'causes') as e (value)
  where
    s.shift_id = p_shift;

  return v_causes;
end;
$$;

create function pg_temp.money (p_shift text, p_which text, p_key text) returns text language plpgsql stable as $$
begin
  return (
    select
      body -> p_which ->> p_key
    from
      pg_temp.status
    where
      shift_id = p_shift
  );
end;
$$;

select
  pg_temp.as_user ('a7700000-0000-4000-8000-0000000000a1');

-- ---------------------------------------------------------------------------
-- Scope predicate. legacy_direct is not coverage. No table rows yet.
-- ---------------------------------------------------------------------------
select
  ok (
    not app.sync_coverage_covers_shift (
      true,
      'all',
      null,
      '{}'::text[],
      array['s']::text[],
      true,
      's',
      '2026-06-02 12:00+00'
    ),
    'legacy_direct does not cover a shift'
  );

select
  ok (
    app.sync_coverage_covers_shift (
      true,
      'from',
      '2026-06-01 00:00+00',
      '{}'::text[],
      array['s']::text[],
      false,
      's',
      '2026-06-02 12:00+00'
    ),
    'a from scope that starts before the shift covers it'
  );

select
  ok (
    not app.sync_coverage_covers_shift (
      true,
      'from',
      '2026-06-03 00:00+00',
      '{}'::text[],
      array['s']::text[],
      false,
      's',
      '2026-06-02 12:00+00'
    ),
    'a from scope that starts after the shift does not cover it'
  );

select
  ok (
    not app.sync_coverage_covers_shift (
      true,
      'shift_ids',
      null,
      array['other']::text[],
      array['s']::text[],
      false,
      's',
      '2026-06-02 12:00+00'
    ),
    'shift_ids coverage must name the shift'
  );

select
  is (
    app.count_sync_scope_covered ('2020-01-01 00:00+00'),
    true,
    'a count before every shift has no relevant shift to cover'
  );

-- ---------------------------------------------------------------------------
-- Catalog. D0-D2 daily from April. W1 weekly from 2 Nov, after the June and
-- August shifts, so those months have a vacuous weekly roster.
-- ---------------------------------------------------------------------------
insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    loss_pct,
    active,
    created_at
  )
values
  (
    pg_temp.u (1),
    'p77-d0',
    'seafood',
    'kg',
    'daily',
    0,
    true,
    '2026-04-02 00:00+00'
  ),
  (
    pg_temp.u (2),
    'p77-d1',
    'seafood',
    'kg',
    'daily',
    0,
    true,
    '2026-04-02 00:00+00'
  ),
  (
    pg_temp.u (3),
    'p77-d2',
    'seafood',
    'kg',
    'daily',
    0,
    true,
    '2026-04-02 00:00+00'
  ),
  (
    pg_temp.u (4),
    'p77-week',
    'seafood',
    'kg',
    'weekly',
    0,
    true,
    '2026-11-02 00:00+00'
  );

select
  is (
    (
      select
        count(*)
      from
        app.item_tracking_history
      where
        item_id = pg_temp.u (3)
    ),
    1::bigint,
    'inserting an item writes one tracking row'
  );

select
  is (
    (
      select
        h.known_since
      from
        app.item_tracking_history h
      where
        h.item_id = pg_temp.u (3)
    ),
    '2026-04-02 00:00+00'::timestamptz,
    'a new item is known since its created_at, not the migration clock'
  );

update app.stock_items
set
  name = 'p77-d2-renamed'
where
  id = pg_temp.u (3);

update app.stock_items
set
  active = active
where
  id = pg_temp.u (3);

select
  is (
    (
      select
        count(*)
      from
        app.item_tracking_history
      where
        item_id = pg_temp.u (3)
    ),
    1::bigint,
    'a name change or a same-value flag write does not append history'
  );

-- ---------------------------------------------------------------------------
-- Shifts. Counts sit inside the shift (open + 6h, close + 10h).
-- ---------------------------------------------------------------------------
select
  pg_temp.shift ('p77-buckets', '2026-05-20 12:00+00', false);

select
  pg_temp.shift ('p77-sort', '2026-05-21 12:00+00', false);

select
  pg_temp.shift ('p77-cumul', '2026-05-22 12:00+00', false);

select
  pg_temp.shift ('p77-partial', '2026-06-02 12:00+00', false);

select
  pg_temp.shift ('p77-open', '2026-06-03 12:00+00', true);

select
  pg_temp.shift ('p77-orders', '2026-06-04 12:00+00', false);

select
  pg_temp.shift ('p77-pending', '2026-06-05 12:00+00', false);

select
  pg_temp.shift ('p77-blocked', '2026-06-06 12:00+00', false);

select
  pg_temp.shift ('p77-stale-app', '2026-06-07 12:00+00', false);

select
  pg_temp.shift ('p77-unrev', '2026-06-08 12:00+00', false);

select
  pg_temp.shift ('p77-prep', '2026-06-09 12:00+00', false);

select
  pg_temp.shift ('p77-refund', '2026-06-10 12:00+00', false);

select
  pg_temp.shift ('p77-unrefund', '2026-06-11 12:00+00', false);

select
  pg_temp.shift ('p77-deficit', '2026-06-12 12:00+00', false);

select
  pg_temp.shift ('p77-cost', '2026-06-13 12:00+00', false);

select
  pg_temp.shift ('p77-revenue', '2026-06-14 12:00+00', false);

select
  pg_temp.shift ('p77-final', '2026-08-10 12:00+00', false);

select
  pg_temp.shift ('p77-week-a', '2026-11-02 12:00+00', false);

select
  pg_temp.shift ('p77-week-b', '2026-11-03 12:00+00', false);

select
  pg_temp.shift ('p77-week-c', '2026-11-10 12:00+00', false);

select
  pg_temp.shift ('p77-scope-gap', '2026-12-01 08:00+00', false);

select
  pg_temp.shift ('p77-count-scope', '2026-12-01 12:00+00', false);

select
  pg_temp.shift ('p77-cover', '2026-12-16 12:00+00', false);

-- Inside the one-day freshness budget however old the suite clock is,
-- and after every fixed count so it cannot own one.
select
  pg_temp.shift (
    'p77-stale',
    pg_catalog.clock_timestamp () - interval '2 days',
    false
  );

select
  pg_temp.daily_count (
    pg_temp.u (20),
    '2026-06-02 18:00+00',
    array[pg_temp.u (1), pg_temp.u (2)]
  );

do $$
declare
  v_shift text;
  v_open timestamptz;
  v_n integer := 30;
begin
  for v_shift, v_open in
    select
      *
    from
      (
        values
          ('p77-open', '2026-06-03 12:00+00'::timestamptz),
          ('p77-orders', '2026-06-04 12:00+00'::timestamptz),
          ('p77-pending', '2026-06-05 12:00+00'::timestamptz),
          ('p77-blocked', '2026-06-06 12:00+00'::timestamptz),
          ('p77-stale-app', '2026-06-07 12:00+00'::timestamptz),
          ('p77-unrev', '2026-06-08 12:00+00'::timestamptz),
          ('p77-prep', '2026-06-09 12:00+00'::timestamptz),
          ('p77-refund', '2026-06-10 12:00+00'::timestamptz),
          ('p77-unrefund', '2026-06-11 12:00+00'::timestamptz),
          ('p77-deficit', '2026-06-12 12:00+00'::timestamptz),
          ('p77-cost', '2026-06-13 12:00+00'::timestamptz),
          ('p77-revenue', '2026-06-14 12:00+00'::timestamptz),
          ('p77-final', '2026-08-10 12:00+00'::timestamptz),
          ('p77-count-scope', '2026-12-01 12:00+00'::timestamptz)
      ) as listed (id, opened)
  loop
    perform pg_temp.daily_count (
      pg_temp.u (v_n),
      v_open + interval '6 hours',
      array[pg_temp.u (1), pg_temp.u (2), pg_temp.u (3)]
    );

    v_n := v_n + 1;
  end loop;
end;
$$;

-- stock_counts.frequency is guarded. weekly_count's update is rejected.
-- Insert weekly counts directly.
insert into
  app.stock_counts (id, request_id, frequency, counted_at)
values
  (
    pg_temp.u (60),
    pg_temp.u (160),
    'weekly',
    '2026-11-03 18:00+00'
  ),
  (
    pg_temp.u (61),
    pg_temp.u (161),
    'weekly',
    '2026-11-10 18:00+00'
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
    pg_temp.u (60),
    1,
    pg_temp.u (4),
    'kg',
    0,
    0,
    0,
    0
  ),
  (
    pg_temp.u (61),
    1,
    pg_temp.u (4),
    'kg',
    0,
    0,
    0,
    0
  );

-- Opening is after every June order, so those orders stay outside coverage.
insert into
  app.opening_stocks (id, request_id, occurred_at)
values
  (
    pg_temp.u (70),
    pg_temp.u (71),
    '2026-12-15 12:00+00'
  );

select
  pg_temp.ord (
    'p77-o-open-1',
    'p77-orders',
    'active',
    '2026-06-04 13:00+00',
    10
  );

select
  pg_temp.ord (
    'p77-o-open-2',
    'p77-orders',
    'active',
    '2026-06-04 14:00+00',
    12
  );

select
  pg_temp.ord (
    'p77-o-pending',
    'p77-pending',
    'complete',
    '2026-06-05 13:00+00',
    40
  );

select
  pg_temp.ord (
    'p77-o-blocked',
    'p77-blocked',
    'complete',
    '2026-06-06 13:00+00',
    0
  );

select
  pg_temp.ord (
    'p77-o-stale',
    'p77-stale-app',
    'complete',
    '2026-06-07 13:00+00',
    10
  );

select
  pg_temp.ord (
    'p77-o-unrev',
    'p77-unrev',
    'canceled',
    '2026-06-08 13:00+00',
    10
  );

select
  pg_temp.ord (
    'p77-o-prep',
    'p77-prep',
    'complete',
    '2026-06-09 13:00+00',
    10
  );

select
  pg_temp.ord (
    'p77-o-unrefund',
    'p77-unrefund',
    'complete',
    '2026-06-11 13:00+00',
    10
  );

select
  pg_temp.ord (
    'p77-o-cost',
    'p77-cost',
    'complete',
    '2026-06-13 13:00+00',
    10
  );

select
  pg_temp.ord (
    'p77-o-revenue',
    'p77-revenue',
    'complete',
    '2026-06-14 13:00+00',
    130
  );

select
  pg_temp.ord (
    'p77-o-cover',
    'p77-cover',
    'complete',
    '2026-12-16 13:00+00',
    80
  );

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    quantity,
    options,
    line_total
  )
values
  (
    'p77-o-cover',
    'l1',
    'pos-fish',
    1,
    '[]'::jsonb,
    0
  ),
  (
    'p77-o-cover',
    'l2',
    'pos-side',
    2,
    '[]'::jsonb,
    0
  );

select
  pg_temp.cost_input (
    'p77-o-pending',
    'p77-pending',
    1,
    'complete',
    40,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-stale',
    'p77-stale-app',
    1,
    'complete',
    10,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-stale',
    'p77-stale-app',
    2,
    'complete',
    10,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-unrev',
    'p77-unrev',
    1,
    'canceled',
    10,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-unrefund',
    'p77-unrefund',
    1,
    'complete',
    10,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-revenue',
    'p77-revenue',
    1,
    'complete',
    100,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-revenue',
    'p77-revenue',
    2,
    'complete',
    130,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-revenue',
    'p77-revenue',
    3,
    'complete',
    130,
    false
  );

-- The blocked head has no receipt. Its snapshot is what pins the shift.
select
  pg_temp.cost_input (
    'p77-o-blocked',
    'p77-blocked',
    1,
    'complete',
    0,
    false
  );

insert into
  app.order_cost_applications (
    order_id,
    cost_input_id,
    snapshot_id,
    receipt_kind,
    disposition,
    signature,
    work_generation
  )
select
  'p77-o-stale',
  first_input.id,
  first_input.snapshot_id,
  'evaluation',
  'none',
  repeat('a', 32),
  1
from
  app.pos_cost_inputs first_input
where
  first_input.order_id = 'p77-o-stale'
  and first_input.input_revision = 1;

insert into
  app.order_cost_state (
    order_id,
    latest_input_id,
    latest_application_id,
    causes
  )
select
  'p77-o-stale',
  latest.id,
  application.id,
  '[]'::jsonb
from
  app.pos_cost_inputs latest
  join app.order_cost_applications application on application.order_id = latest.order_id
where
  latest.order_id = 'p77-o-stale'
  and latest.input_revision = 2;

insert into
  app.order_disposition_events (
    order_id,
    episode,
    decision,
    class,
    source,
    owner_reviewed,
    cost_input_id,
    refund_signature,
    order_total,
    refund_total
  )
select
  'p77-o-unrev',
  1,
  'made',
  'canceled',
  'system_default',
  false,
  input.id,
  repeat('b', 32),
  10,
  0
from
  app.pos_cost_inputs input
where
  input.order_id = 'p77-o-unrev'
  and input.input_revision = 1;

insert into
  app.order_disposition_state (
    order_id,
    episode,
    is_open,
    event_id,
    class,
    cost_input_id
  )
select
  'p77-o-unrev',
  1,
  true,
  event.id,
  'canceled',
  event.cost_input_id
from
  app.order_disposition_events event
where
  event.order_id = 'p77-o-unrev';

insert into
  app.order_disposition_events (
    order_id,
    episode,
    decision,
    class,
    source,
    owner_reviewed,
    actor,
    reason,
    cost_input_id,
    refund_signature,
    order_total,
    refund_total
  )
select
  'p77-o-unrefund',
  1,
  'made',
  'unresolved_refund',
  'owner',
  true,
  'a7700000-0000-4000-8000-0000000000a1',
  'راجع',
  input.id,
  repeat('c', 32),
  10,
  0
from
  app.pos_cost_inputs input
where
  input.order_id = 'p77-o-unrefund'
  and input.input_revision = 1;

insert into
  app.order_disposition_state (
    order_id,
    episode,
    is_open,
    event_id,
    class,
    cost_input_id
  )
select
  'p77-o-unrefund',
  1,
  true,
  event.id,
  'unresolved_refund',
  event.cost_input_id
from
  app.order_disposition_events event
where
  event.order_id = 'p77-o-unrefund';

insert into
  app.order_cost_state (order_id, causes)
values
  (
    'p77-o-prep',
    '[{"code":"missing_preparation_basis"}]'::jsonb
  ),
  (
    'p77-o-cost',
    '[{"code":"missing_cost_basis"}]'::jsonb
  );

insert into
  app.accounting_work_state (order_id, last_outcome)
values
  ('p77-o-blocked', 'blocked');

update app.accounting_work_events
set
  processed_at = pg_catalog.clock_timestamp ()
where
  order_id in (
    'p77-o-stale',
    'p77-o-unrev',
    'p77-o-unrefund',
    'p77-o-revenue',
    'p77-o-blocked'
  );

-- Refund revisions through the ingest writer. The second call changes only
-- the instant, so the net is zero and a fact is still written. The fourth
-- call repeats the same set.
select
  app.capture_pos_refund_revisions (
    null,
    jsonb_build_array(
      jsonb_build_object(
        'shift_id',
        'p77-refund',
        'before',
        '[]'::jsonb,
        'after',
        jsonb_build_array(
          jsonb_build_object(
            'tx_id',
            'tx-77-1',
            'order_id',
            '',
            'tx_type',
            3,
            'amount',
            '10.00',
            'occurred_at',
            '2026-06-10 13:00:00+00'
          )
        )
      )
    )
  );

select
  app.capture_pos_refund_revisions (
    null,
    jsonb_build_array(
      jsonb_build_object(
        'shift_id',
        'p77-refund',
        'before',
        jsonb_build_array(
          jsonb_build_object(
            'tx_id',
            'tx-77-1',
            'order_id',
            '',
            'tx_type',
            3,
            'amount',
            '10.00',
            'occurred_at',
            '2026-06-10 13:00:00+00'
          )
        ),
        'after',
        jsonb_build_array(
          jsonb_build_object(
            'tx_id',
            'tx-77-1',
            'order_id',
            '',
            'tx_type',
            3,
            'amount',
            '10.00',
            'occurred_at',
            '2026-06-10 14:00:00+00'
          )
        )
      )
    )
  );

select
  app.note_refund_sales_revision (
    (
      select
        min(id)
      from
        app.pos_refund_revisions
      where
        shift_id = 'p77-refund'
    )
  );

select
  app.capture_pos_refund_revisions (
    null,
    jsonb_build_array(
      jsonb_build_object(
        'shift_id',
        'p77-refund',
        'before',
        jsonb_build_array(
          jsonb_build_object(
            'tx_id',
            'tx-77-1',
            'order_id',
            '',
            'tx_type',
            3,
            'amount',
            '10.00',
            'occurred_at',
            '2026-06-10 14:00:00+00'
          )
        ),
        'after',
        jsonb_build_array(
          jsonb_build_object(
            'tx_id',
            'tx-77-1',
            'order_id',
            '',
            'tx_type',
            3,
            'amount',
            '10.00',
            'occurred_at',
            '2026-06-10 14:00:00+00'
          ),
          jsonb_build_object(
            'tx_id',
            'tx-77-drawer',
            'order_id',
            '',
            'tx_type',
            1,
            'amount',
            '5.00',
            'occurred_at',
            '2026-06-10 15:00:00+00'
          )
        )
      )
    )
  );

select
  app.capture_pos_refund_revisions (
    null,
    jsonb_build_array(
      jsonb_build_object(
        'shift_id',
        'p77-refund',
        'before',
        jsonb_build_array(
          jsonb_build_object(
            'tx_id',
            'tx-77-1',
            'order_id',
            '',
            'tx_type',
            3,
            'amount',
            '10.00',
            'occurred_at',
            '2026-06-10 14:00:00+00'
          ),
          jsonb_build_object(
            'tx_id',
            'tx-77-drawer',
            'order_id',
            '',
            'tx_type',
            1,
            'amount',
            '5.00',
            'occurred_at',
            '2026-06-10 15:00:00+00'
          )
        ),
        'after',
        jsonb_build_array(
          jsonb_build_object(
            'tx_id',
            'tx-77-1',
            'order_id',
            '',
            'tx_type',
            3,
            'amount',
            '10.00',
            'occurred_at',
            '2026-06-10 14:00:00+00'
          ),
          jsonb_build_object(
            'tx_id',
            'tx-77-drawer',
            'order_id',
            '',
            'tx_type',
            1,
            'amount',
            '5.00',
            'occurred_at',
            '2026-06-10 15:00:00+00'
          )
        )
      )
    )
  );

-- Coverage. The stale shift and the scope gap are not in the fresh row.
-- A legacy row presents the gap and still does not cover it.
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
select
  770001,
  pg_catalog.clock_timestamp () - interval '1 hour',
  pg_catalog.clock_timestamp (),
  true,
  'all',
  null,
  '{}'::text[],
  coalesce(
    array_agg(
      shift.id
      order by
        shift.id
    ),
    '{}'::text[]
  ),
  true,
  false
from
  app.pos_shifts shift
where
  shift.id like 'p77-%'
  and shift.id not in ('p77-stale', 'p77-scope-gap');

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
    770002,
    pg_catalog.clock_timestamp () - interval '3 days 1 minute',
    pg_catalog.clock_timestamp () - interval '3 days',
    true,
    'shift_ids',
    null,
    array['p77-stale']::text[],
    array['p77-stale']::text[],
    true,
    false
  ),
  (
    770003,
    pg_catalog.clock_timestamp () - interval '1 hour',
    pg_catalog.clock_timestamp (),
    true,
    'all',
    null,
    '{}'::text[],
    array['p77-scope-gap']::text[],
    true,
    true
  );

-- Ledger rows for classification. period_revisions.amount is deliberately
-- not the movement total, and several stored buckets are the wrong one.
create temp table mov (k text primary key, id bigint);

do $$
declare
  v_id bigint;
  v_sale bigint;
  v_waste bigint;
  v_loss bigint;
  v_count bigint;
  v_sort_in bigint;
  v_cumul_sale bigint;
begin
  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (180), pg_temp.u (1), 'sale', '2026-05-20 15:00+00', -1, 80, -80, 'p77-buckets')
  returning id into v_sale;
  insert into mov values ('sale', v_sale);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id, reverses_movement_id)
  values (pg_temp.u (181), pg_temp.u (1), 'sale_reversal', '2026-05-20 15:00+00', 1, 80, 80, 'p77-buckets', v_sale)
  returning id into v_id;
  insert into mov values ('sale_reversal', v_id);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (182), pg_temp.u (1), 'waste', '2026-05-20 15:00+00', -1, 30, -30, 'p77-buckets')
  returning id into v_waste;
  insert into mov values ('waste', v_waste);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id, reverses_movement_id)
  values (pg_temp.u (183), pg_temp.u (1), 'waste_reversal', '2026-05-20 15:00+00', 1, 30, 30, 'p77-buckets', v_waste)
  returning id into v_id;
  insert into mov values ('waste_reversal', v_id);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (184), pg_temp.u (1), 'sort_loss', '2026-05-20 15:00+00', -1, 5, -5, 'p77-buckets')
  returning id into v_loss;
  insert into mov values ('sort_loss', v_loss);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (185), pg_temp.u (1), 'count_adjustment', '2026-05-20 15:00+00', -1, 40, -40, 'p77-buckets')
  returning id into v_count;
  insert into mov values ('count_adjustment', v_count);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (186), pg_temp.u (1), 'count_compensation', '2026-05-20 15:00+00', 2, 15, 15, 'p77-buckets')
  returning id into v_id;
  insert into mov values ('count_compensation', v_id);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values
    (pg_temp.u (187), pg_temp.u (1), 'sort_out', '2026-05-20 15:00+00', -1, 10, -10, 'p77-buckets'),
    (pg_temp.u (188), pg_temp.u (1), 'opening', '2026-05-20 15:00+00', 1, 10, 10, 'p77-buckets'),
    (pg_temp.u (189), pg_temp.u (1), 'purchase', '2026-05-20 15:00+00', 1, 10, 10, 'p77-buckets');

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (190), pg_temp.u (1), 'sort_in', '2026-05-20 15:00+00', 1, 10, 10, 'p77-buckets')
  returning id into v_sort_in;
  insert into mov values ('sort_in', v_sort_in);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id, adjusts_movement_id)
  values
    (pg_temp.u (191), pg_temp.u (1), 'cost_adjustment', '2026-05-20 15:00+00', 0, 0, -7, 'p77-buckets', v_waste),
    (pg_temp.u (192), pg_temp.u (1), 'cost_adjustment', '2026-05-20 15:00+00', 0, 0, 4, 'p77-buckets', v_sale),
    (pg_temp.u (193), pg_temp.u (1), 'cost_adjustment', '2026-05-20 15:00+00', 0, 0, -2, 'p77-buckets', v_count),
    (pg_temp.u (194), pg_temp.u (1), 'cost_adjustment', '2026-05-20 15:00+00', 0, 0, -3, 'p77-buckets', v_loss),
    (pg_temp.u (195), pg_temp.u (1), 'cost_adjustment', '2026-05-20 15:00+00', 0, 0, -9, 'p77-buckets', v_sort_in);

  insert into mov (k, id)
  select 'cost_waste', id from app.stock_movements where batch_id = pg_temp.u (191)
  union all
  select 'cost_sale', id from app.stock_movements where batch_id = pg_temp.u (192)
  union all
  select 'cost_count', id from app.stock_movements where batch_id = pg_temp.u (193)
  union all
  select 'cost_loss', id from app.stock_movements where batch_id = pg_temp.u (194)
  union all
  select 'cost_sort', id from app.stock_movements where batch_id = pg_temp.u (195)
  union all
  select 'sort_out', id from app.stock_movements where batch_id = pg_temp.u (187)
  union all
  select 'opening', id from app.stock_movements where batch_id = pg_temp.u (188)
  union all
  select 'purchase', id from app.stock_movements where batch_id = pg_temp.u (189);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (196), pg_temp.u (1), 'sale', '2026-05-22 15:00+00', -1, 100, -100, 'p77-cumul')
  returning id into v_cumul_sale;
  insert into mov values ('cumul_sale', v_cumul_sale);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (197), pg_temp.u (1), 'count_adjustment', '2026-05-22 16:00+00', -1, 40, -40, 'p77-cumul')
  returning id into v_id;
  insert into mov values ('cumul_count', v_id);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values
    (pg_temp.u (198), pg_temp.u (1), 'sort_out', '2026-05-21 15:00+00', -1, 10, -10, 'p77-sort'),
    (pg_temp.u (199), pg_temp.u (1), 'sort_in', '2026-05-21 15:00+00', 1, 10, 10, 'p77-sort');

  insert into mov (k, id)
  select 'sort_only_out', id from app.stock_movements where batch_id = pg_temp.u (198)
  union all
  select 'sort_only_in', id from app.stock_movements where batch_id = pg_temp.u (199);

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (200), pg_temp.u (1), 'sale', '2026-06-12 15:00+00', -1, 10, -10, 'p77-deficit')
  returning id into v_id;
  insert into mov values ('deficit', v_id);
end;
$$;

insert into
  app.provisional_deficits (
    movement_id,
    item_id,
    qty_uncovered,
    provisional_unit_cost,
    value_uncovered
  )
select
  mov.id,
  pg_temp.u (1),
  1.25,
  10,
  12.50
from
  mov
where
  mov.k = 'deficit';

insert into
  app.period_revisions (
    source_movement_id,
    shift_id,
    bucket,
    amount,
    item_id,
    cause_batch_id,
    created_at
  )
select
  mov.id,
  case mov.k
    when 'cumul_sale' then 'p77-cumul'
    when 'cumul_count' then 'p77-cumul'
    when 'sort_only_out' then 'p77-sort'
    when 'sort_only_in' then 'p77-sort'
    else 'p77-buckets'
  end,
  case mov.k
    when 'cost_waste' then 'count'
    when 'sale' then 'waste'
    when 'sort_only_out' then 'cogs'
    when 'sort_only_in' then 'cogs'
    when 'sort_out' then 'cogs'
    when 'sort_in' then 'cogs'
    when 'opening' then 'cogs'
    when 'purchase' then 'cogs'
    when 'cost_sort' then 'cogs'
    else 'cogs'
  end,
  999.99,
  pg_temp.u (1),
  case mov.k
    when 'sale' then pg_temp.u (80)
    when 'sale_reversal' then pg_temp.u (81)
    when 'waste' then pg_temp.u (82)
    when 'waste_reversal' then pg_temp.u (83)
    when 'sort_loss' then pg_temp.u (84)
    when 'count_adjustment' then pg_temp.u (85)
    when 'count_compensation' then pg_temp.u (86)
    when 'cost_waste' then pg_temp.u (87)
    when 'cost_sale' then pg_temp.u (88)
    when 'cost_count' then pg_temp.u (89)
    when 'cost_loss' then pg_temp.u (90)
    when 'sort_out' then pg_temp.u (91)
    when 'sort_in' then pg_temp.u (91)
    when 'opening' then pg_temp.u (92)
    when 'purchase' then pg_temp.u (93)
    when 'cost_sort' then pg_temp.u (94)
    when 'cumul_sale' then pg_temp.u (95)
    when 'cumul_count' then pg_temp.u (96)
    else pg_temp.u (97)
  end,
  case mov.k
    when 'cumul_count' then '2026-05-22 14:00+00'::timestamptz
    when 'cumul_sale' then '2026-05-22 13:00+00'::timestamptz
    else '2026-05-20 13:00+00'::timestamptz + (
      (
        row_number() over (
          order by
            mov.k
        )
      )::text || ' minutes'
    )::interval
  end
from
  mov
where
  mov.k <> 'deficit';

-- ---------------------------------------------------------------------------
-- Roster and weekly interval, before any later catalog edit.
-- ---------------------------------------------------------------------------
select
  is (
    (
      select
        covered
      from
        app.shift_count_coverage
      where
        shift_id = 'p77-partial'
        and item_id = pg_temp.u (3)
    ),
    false,
    'a daily item omitted from the count is not covered'
  );

select
  is (
    (
      select
        count(*)
      from
        app.shift_count_coverage
      where
        shift_id = 'p77-partial'
        and item_id in (pg_temp.u (1), pg_temp.u (2))
        and covered
        and anchor_count_id = pg_temp.u (20)
    ),
    2::bigint,
    'the submitted daily lines cover only those items'
  );

select
  is (
    (
      select
        count_frequency
      from
        app.item_roster_as_of ('2026-06-02 12:00+00')
      where
        item_id = pg_temp.u (3)
    ),
    'daily',
    'the June roster still requires the daily item'
  );

select
  is (
    (
      select
        owning_shift_id
      from
        app.shift_count_coverage
      where
        shift_id = 'p77-week-a'
        and item_id = pg_temp.u (4)
    ),
    'p77-week-b',
    'weekly settlement belongs to the last shift before the anchor'
  );

select
  is (
    (
      select
        interval_start
      from
        app.shift_count_coverage
      where
        shift_id = 'p77-week-a'
        and item_id = pg_temp.u (4)
    ),
    null::timestamptz,
    'the first weekly anchor has no previous bound'
  );

select
  is (
    (
      select
        interval_end
      from
        app.shift_count_coverage
      where
        shift_id = 'p77-week-b'
        and item_id = pg_temp.u (4)
    ),
    '2026-11-03 18:00+00'::timestamptz,
    'the covered interval ends at the anchor'
  );

select
  is (
    (
      select
        interval_start
      from
        app.shift_count_coverage
      where
        shift_id = 'p77-week-c'
        and item_id = pg_temp.u (4)
    ),
    '2026-11-03 18:00+00'::timestamptz,
    'the next weekly interval starts at the previous anchor'
  );

select
  is (
    (
      select
        owning_shift_id
      from
        app.shift_count_coverage
      where
        shift_id = 'p77-week-c'
        and item_id = pg_temp.u (4)
    ),
    'p77-week-c',
    'the later weekly anchor is owned by the shift it follows'
  );

select
  is (
    (
      select
        sync_scope_covered
      from
        app.shift_count_coverage
      where
        shift_id = 'p77-week-c'
        and item_id = pg_temp.u (4)
    ),
    true,
    'the weekly anchor is scope-covered when every relevant shift is'
  );

select
  is (
    app.count_sync_scope_covered ('2026-12-01 09:00+00'),
    false,
    'a count whose relevant shifts include the gap is not scope-covered'
  );

select
  pg_temp.load ();

select
  is (
    pg_temp.lbl ('p77-partial'),
    'تقديري',
    'a partial daily roster is تقديري'
  );

select
  is (
    pg_temp.causes ('p77-partial'),
    '{}'::text[],
    'partial coverage is not a blocker'
  );

select
  is (
    pg_temp.bit ('p77-partial', 'daily_required'),
    '3',
    'three daily items are required'
  );

select
  is (
    pg_temp.bit ('p77-partial', 'daily_covered'),
    '2',
    'two of the three daily items are covered'
  );

select
  is (
    pg_temp.bit ('p77-partial', 'daily_due'),
    'true',
    'the missing daily item is due'
  );

select
  is (
    pg_temp.bit ('p77-partial', 'weekly_required'),
    '0',
    'June has no weekly item yet'
  );

select
  is (
    pg_temp.bit ('p77-partial', 'revised'),
    'false',
    'the partial shift has no revision'
  );

select
  is (
    pg_temp.lbl ('p77-week-b'),
    'تقديري',
    'weekly coverage does not close an open daily roster'
  );

select
  is (
    pg_temp.lbl ('p77-open'),
    'ناقص',
    'an open shift is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-open'),
    array['shift_open']::text[],
    'the open shift has only that cause'
  );

select
  is (
    pg_temp.bit ('p77-open', 'shift_open'),
    'true',
    'the open flag is set'
  );

select
  is (
    pg_temp.lbl ('p77-orders'),
    'ناقص',
    'open orders are ناقص'
  );

select
  is (
    pg_temp.causes ('p77-orders'),
    array['open_orders']::text[],
    'open orders are their own cause'
  );

select
  is (
    pg_temp.bit ('p77-orders', 'open_order_count'),
    '2',
    'both active orders are counted'
  );

select
  is (
    pg_temp.lbl ('p77-pending'),
    'ناقص',
    'a pending application is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-pending'),
    array['pending_applications']::text[],
    'the pending shift has only that cause'
  );

select
  is (
    pg_temp.bit ('p77-pending', 'pending_applications'),
    '1',
    'one order is still pending'
  );

select
  is (
    pg_temp.lbl ('p77-blocked'),
    'ناقص',
    'a blocked application is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-blocked'),
    array['blocked_applications']::text[],
    'the blocked shift has only that cause'
  );

select
  is (
    pg_temp.lbl ('p77-stale-app'),
    'ناقص',
    'a stale application is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-stale-app'),
    array['stale_applications']::text[],
    'the stale application shift has only that cause'
  );

select
  is (
    pg_temp.lbl ('p77-unrev'),
    'ناقص',
    'an unreviewed decision is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-unrev'),
    array['unreviewed_decisions']::text[],
    'the unreviewed shift has only that cause'
  );

select
  is (
    pg_temp.lbl ('p77-prep'),
    'ناقص',
    'missing preparation is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-prep'),
    array['unresolved_preparation']::text[],
    'missing preparation is its own cause'
  );

select
  is (
    pg_temp.lbl ('p77-refund'),
    'ناقص',
    'an unlinked refund is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-refund'),
    array['unresolved_refund_attribution']::text[],
    'the unlinked refund is its own cause'
  );

select
  is (
    pg_temp.bit ('p77-refund', 'revised'),
    'true',
    'the refund facts raise the badge'
  );

select
  is (
    pg_temp.lbl ('p77-unrefund'),
    'ناقص',
    'an unresolved refund class is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-unrefund'),
    array['unresolved_refund_attribution']::text[],
    'a reviewed unresolved class is still a refund cause and not an unreviewed one'
  );

select
  is (
    pg_temp.lbl ('p77-deficit'),
    'ناقص',
    'a provisional deficit is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-deficit'),
    array['provisional_deficits']::text[],
    'the deficit shift has only that cause'
  );

select
  is (
    pg_temp.bit ('p77-deficit', 'provisional_deficit_qty'),
    '1.25',
    'deficit quantity is decimal text'
  );

select
  is (
    pg_temp.lbl ('p77-cost'),
    'ناقص',
    'a missing cost basis is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-cost'),
    array['missing_cost_basis']::text[],
    'missing cost basis is its own cause'
  );

select
  is (
    pg_temp.lbl ('p77-cover'),
    'ناقص',
    'incomplete order coverage is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-cover'),
    array['order_coverage_incomplete']::text[],
    'order coverage is its own cause'
  );

select
  is (
    pg_temp.bit ('p77-cover', 'completed_orders_denominator'),
    '1',
    'the order after the opening is the denominator'
  );

select
  is (
    pg_temp.bit ('p77-cover', 'completed_orders_covered'),
    '0',
    'the unmapped order is not covered'
  );

select
  is (
    pg_temp.bit ('p77-cover', 'completed_lines_denominator'),
    '2',
    'both positive lines are the line denominator'
  );

select
  is (
    pg_temp.bit ('p77-cover', 'completed_lines_covered'),
    '0',
    'neither line is covered'
  );

select
  is (
    pg_temp.bit ('p77-partial', 'completed_orders_denominator'),
    '0',
    'no opening yet means a zero denominator'
  );

select
  is (
    pg_temp.lbl ('p77-scope-gap'),
    'ناقص',
    'a shift outside sync scope is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-scope-gap'),
    array['sync_scope_not_covered']::text[],
    'legacy coverage is not sync scope'
  );

select
  is (
    pg_temp.bit ('p77-scope-gap', 'sync_scope_covered'),
    'false',
    'the gap is not scope-covered'
  );

select
  is (
    pg_temp.bit ('p77-scope-gap', 'sync_due'),
    'true',
    'an uncovered shift is due'
  );

select
  is (
    pg_temp.lbl ('p77-stale'),
    'ناقص',
    'stale sync is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-stale'),
    array['sync_stale']::text[],
    'staleness is its own cause'
  );

select
  is (
    pg_temp.bit ('p77-stale', 'sync_scope_covered'),
    'true',
    'the stale shift was covered once'
  );

select
  is (
    pg_temp.bit ('p77-stale', 'sync_fresh'),
    'false',
    'coverage older than the budget is not fresh'
  );

select
  is (
    pg_temp.lbl ('p77-count-scope'),
    'ناقص',
    'a count whose shifts are outside scope is ناقص'
  );

select
  is (
    pg_temp.causes ('p77-count-scope'),
    array['count_sync_scope_not_covered']::text[],
    'count scope is a cause even when the shift itself is covered'
  );

select
  is (
    pg_temp.bit ('p77-count-scope', 'sync_scope_covered'),
    'true',
    'the count shift itself is in scope'
  );

select
  is (
    pg_temp.bit ('p77-count-scope', 'count_sync_scope_covered'),
    'false',
    'the count relevant shifts are not all covered'
  );

select
  is (
    pg_temp.lbl ('p77-final'),
    'السمك مقفول',
    'daily coverage without the month confirmation is السمك مقفول'
  );

select
  is (
    pg_temp.causes ('p77-final'),
    '{}'::text[],
    'the fish-closed shift has no blocker'
  );

select
  is (
    pg_temp.bit ('p77-final', 'expenses_confirmed'),
    'false',
    'August expenses are not confirmed yet'
  );

select
  is (
    pg_temp.bit ('p77-final', 'expense_month'),
    '2026-08-01',
    'the expense month is the Cairo month'
  );

select
  is (
    pg_temp.bit ('p77-final', 'weekly_due'),
    'false',
    'August has no weekly requirement'
  );

select
  is (
    pg_temp.bit ('p77-final', 'daily_due'),
    'false',
    'the August daily roster is covered'
  );

select
  is (
    pg_temp.bit ('p77-final', 'revised'),
    'false',
    'the fish-closed shift is not revised yet'
  );

select
  is (
    pg_temp.lbl ('p77-final'),
    'السمك مقفول',
    'fish closed is not final'
  );

select
  is (
    (
      select
        count(*)
      from
        app.sales_revision_facts
      where
        shift_id = 'p77-refund'
    ),
    2::bigint,
    'two type-3 revisions write two facts and the repeat writes none'
  );

select
  is (
    (
      select
        count(*)
      from
        app.pos_refund_revisions
      where
        shift_id = 'p77-refund'
    ),
    3::bigint,
    'the drawer row is a revision and the repeated ingest is not'
  );

select
  is_empty (
    $$select 1 from app.sales_revision_facts fact
      join app.pos_refund_revisions revision on revision.id = fact.source_revision_id
      where revision.tx_type = 1$$,
    'a drawer revision that was never a refund writes no sales fact'
  );

select
  ok (
    exists (
      select
        1
      from
        app.sales_revision_facts fact
      where
        fact.shift_id = 'p77-refund'
        and fact.source_kind = 'refund'
        and fact.net_sales_difference = 0
    ),
    'a zero net refund revision still writes a fact'
  );

select
  is (
    (
      select
        sum(net_sales_difference)
      from
        app.sales_revision_facts
      where
        shift_id = 'p77-refund'
    ),
    -10::numeric,
    'the refund reduces sales by the amount that appeared'
  );

select
  is (
    (
      select
        count(*)
      from
        app.sales_revision_facts fact
        join app.pos_cost_inputs input on input.id = fact.source_revision_id
      where
        fact.source_kind = 'order_total'
        and input.order_id = 'p77-o-revenue'
    ),
    1::bigint,
    'only the changed total writes a fact; the repeat of 130 does not'
  );

select
  is (
    (
      select
        fact.net_sales_difference::text
      from
        app.sales_revision_facts fact
        join app.pos_cost_inputs input on input.id = fact.source_revision_id
      where
        fact.source_kind = 'order_total'
        and input.order_id = 'p77-o-revenue'
    ),
    '30.00',
    'the revenue revision is the new total minus the old one'
  );

select
  is (
    (
      select
        input.input_revision
      from
        app.sales_revision_facts fact
        join app.pos_cost_inputs input on input.id = fact.source_revision_id
      where
        fact.source_kind = 'order_total'
        and fact.order_id = 'p77-o-revenue'
    ),
    2,
    'the order total fact is keyed by the second cost input'
  );

select
  is (
    pg_temp.lbl ('p77-revenue'),
    'السمك مقفول',
    'a revenue-only revision does not change the label'
  );

select
  is (
    pg_temp.bit ('p77-revenue', 'revised'),
    'true',
    'a revenue-only revision raises the badge'
  );

select
  is (
    pg_temp.money (
      'p77-revenue',
      'latest_difference',
      'net_sales_difference'
    ),
    '30.00',
    'latest sales difference is the revenue revision'
  );

select
  is (
    pg_temp.money (
      'p77-revenue',
      'latest_difference',
      'cogs_difference'
    ),
    '0.00',
    'a revenue revision has no COGS difference'
  );

select
  is (
    pg_temp.money (
      'p77-revenue',
      'latest_difference',
      'profit_difference'
    ),
    '30.00',
    'revenue goes straight to profit'
  );

select
  is (
    (
      select
        cogs_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (80)::text
    ),
    '80.00',
    'sale is COGS and the stored period amount is ignored'
  );

select
  is (
    (
      select
        waste_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (80)::text
    ),
    '0.00',
    'a sale does not land in waste even when the stored bucket says waste'
  );

select
  is (
    (
      select
        cogs_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (81)::text
    ),
    '-80.00',
    'sale_reversal is COGS of the opposite sign'
  );

select
  is (
    (
      select
        waste_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (82)::text
    ),
    '30.00',
    'waste is the waste bucket'
  );

select
  is (
    (
      select
        waste_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (83)::text
    ),
    '-30.00',
    'waste_reversal is waste of the opposite sign'
  );

select
  is (
    (
      select
        waste_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (84)::text
    ),
    '5.00',
    'sort_loss is waste'
  );

select
  is (
    (
      select
        count_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (85)::text
    ),
    '40.00',
    'count_adjustment is the count bucket'
  );

select
  is (
    (
      select
        count_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (86)::text
    ),
    '-15.00',
    'count_compensation is the count bucket'
  );

select
  is (
    (
      select
        waste_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (87)::text
    ),
    '7.00',
    'a cost adjustment inherits the waste target'
  );

select
  is (
    (
      select
        count_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (87)::text
    ),
    '0.00',
    'the inherited waste adjustment is not count even though the stored bucket is count'
  );

select
  is (
    (
      select
        cogs_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (88)::text
    ),
    '-4.00',
    'a cost adjustment inherits the sale target'
  );

select
  is (
    (
      select
        count_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (89)::text
    ),
    '2.00',
    'a cost adjustment inherits the count target'
  );

select
  is (
    (
      select
        waste_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (90)::text
    ),
    '3.00',
    'a cost adjustment inherits sort_loss as waste'
  );

select
  is_empty (
    $$select 1 from app.accounting_revision_differences where cause_id = '$$ || pg_temp.u (91)::text || $$'$$,
    'a sorting transfer cause is excluded'
  );

select
  is_empty (
    $$select 1 from app.accounting_revision_differences where cause_id in ('$$ || pg_temp.u (92)::text || $$', '$$ || pg_temp.u (93)::text || $$', '$$ || pg_temp.u (94)::text || $$')$$,
    'opening, purchase and a sort-transfer adjustment are excluded'
  );

select
  is (
    pg_temp.bit ('p77-sort', 'revised'),
    'false',
    'sorting alone does not raise the badge'
  );

select
  is (
    pg_temp.lbl ('p77-sort'),
    'تقديري',
    'sorting does not close the shift'
  );

select
  is (
    (
      select
        is_latest
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (96)::text
    ),
    true,
    'the later cause is the latest on its shift'
  );

select
  is (
    (
      select
        is_latest
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (95)::text
    ),
    false,
    'the earlier cause is not the latest'
  );

select
  is (
    (
      select
        cumulative_cogs_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (96)::text
    ),
    '100.00',
    'the cumulative COGS keeps the earlier cause'
  );

select
  is (
    (
      select
        cogs_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (96)::text
    ),
    '0.00',
    'the latest cause itself has no COGS'
  );

select
  is (
    (
      select
        cumulative_count_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (96)::text
    ),
    '40.00',
    'the cumulative count is the later cause'
  );

select
  is (
    (
      select
        cumulative_profit_difference
      from
        app.accounting_revision_differences
      where
        cause_id = pg_temp.u (96)::text
    ),
    '-140.00',
    'cumulative profit subtracts both buckets'
  );

select
  is (
    pg_temp.money (
      'p77-cumul',
      'latest_difference',
      'count_difference'
    ),
    '40.00',
    'the status latest vector is the newest cause'
  );

select
  is (
    pg_temp.money (
      'p77-cumul',
      'latest_difference',
      'profit_difference'
    ),
    '-40.00',
    'the latest profit is the count cause alone'
  );

select
  is (
    pg_temp.money (
      'p77-cumul',
      'cumulative_difference',
      'cogs_difference'
    ),
    '100.00',
    'the status cumulative vector keeps the earlier COGS'
  );

select
  is (
    pg_temp.money (
      'p77-cumul',
      'cumulative_difference',
      'profit_difference'
    ),
    '-140.00',
    'the status cumulative profit matches the view'
  );

select
  is (
    pg_temp.bit ('p77-cumul', 'revised'),
    'true',
    'the cumulative shift is revised'
  );

select
  is (
    pg_temp.lbl ('p77-cumul'),
    'تقديري',
    'a revision does not close an uncovered roster'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_revision_differences diff
      where
        diff.profit_difference::numeric is distinct from (
          diff.net_sales_difference::numeric - diff.cogs_difference::numeric - diff.waste_difference::numeric - diff.count_difference::numeric
        )
        or diff.cumulative_profit_difference::numeric is distinct from (
          diff.cumulative_net_sales_difference::numeric - diff.cumulative_cogs_difference::numeric - diff.cumulative_waste_difference::numeric - diff.cumulative_count_difference::numeric
        )
    ),
    0::bigint,
    'profit equals net sales minus COGS, waste and count on every row'
  );

-- Month confirmation is the last gate. A zero-profit revision keeps final
-- and still raises the badge.
insert into
  app.month_expense_status (month, complete, confirmed_at, confirmed_by)
values
  (
    '2026-08-01',
    true,
    pg_catalog.clock_timestamp (),
    'a7700000-0000-4000-8000-0000000000a1'
  );

select
  pg_temp.load ();

select
  is (
    pg_temp.lbl ('p77-final'),
    'مقفول نهائي',
    'confirmed expenses close a fully covered shift'
  );

select
  is (
    pg_temp.bit ('p77-final', 'expenses_confirmed'),
    'true',
    'August is confirmed'
  );

select
  is (
    pg_temp.bit ('p77-final', 'revised'),
    'false',
    'confirmation is not a revision'
  );

select
  is (
    pg_temp.lbl ('p77-revenue'),
    'السمك مقفول',
    'confirming August does not confirm June'
  );

select
  is (
    pg_temp.lbl ('p77-open'),
    'ناقص',
    'an open shift stays ناقص after another month is confirmed'
  );

do $$
declare
  v_waste bigint;
  v_sale bigint;
  v_reversal bigint;
begin
  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (210), pg_temp.u (1), 'waste', '2026-08-10 15:00+00', -1, 200, -200, 'p77-final')
  returning id into v_waste;

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id)
  values (pg_temp.u (211), pg_temp.u (1), 'sale', '2026-08-10 15:00+00', -1, 200, -200, 'p77-final')
  returning id into v_sale;

  insert into app.stock_movements (batch_id, item_id, movement_type, occurred_at, quantity, unit_cost, total_cost, shift_id, reverses_movement_id)
  values (pg_temp.u (212), pg_temp.u (1), 'waste_reversal', '2026-08-10 15:00+00', 1, 200, 200, 'p77-final', v_waste)
  returning id into v_reversal;

  insert into app.period_revisions (source_movement_id, shift_id, bucket, amount, item_id, cause_batch_id, created_at)
  values
    (v_sale, 'p77-final', 'count', 1, pg_temp.u (1), pg_temp.u (97), '2026-08-10 16:00+00'),
    (v_reversal, 'p77-final', 'count', 2, pg_temp.u (1), pg_temp.u (97), '2026-08-10 16:00+00');
end;
$$;

select
  pg_temp.load ();

select
  is (
    pg_temp.lbl ('p77-final'),
    'مقفول نهائي',
    'a zero profit revision does not reopen the shift'
  );

select
  is (
    pg_temp.bit ('p77-final', 'revised'),
    'true',
    'a zero profit revision still raises the badge'
  );

select
  is (
    pg_temp.money (
      'p77-final',
      'latest_difference',
      'cogs_difference'
    ),
    '200.00',
    'the zero-net cause still moves COGS'
  );

select
  is (
    pg_temp.money (
      'p77-final',
      'latest_difference',
      'waste_difference'
    ),
    '-200.00',
    'the zero-net cause still moves waste'
  );

select
  is (
    pg_temp.money (
      'p77-final',
      'latest_difference',
      'profit_difference'
    ),
    '0.00',
    'the two buckets net to zero profit'
  );

select
  is (
    pg_temp.money (
      'p77-final',
      'latest_difference',
      'count_difference'
    ),
    '0.00',
    'the stored count bucket is not used'
  );

-- ---------------------------------------------------------------------------
-- Catalog edits after the shift do not rewrite its roster.
-- ---------------------------------------------------------------------------
update app.stock_items
set
  active = false
where
  id = pg_temp.u (3);

select
  pg_temp.shift (
    'p77-after',
    pg_catalog.clock_timestamp () + interval '1 hour',
    false
  );

select
  ok (
    exists (
      select
        1
      from
        app.item_roster_as_of ('2026-06-02 12:00+00') roster
      where
        roster.item_id = pg_temp.u (3)
        and roster.count_frequency = 'daily'
    ),
    'deactivating an item after June does not remove it from the June roster'
  );

select
  ok (
    not exists (
      select
        1
      from
        app.item_roster_as_of (
          (
            select
              opened_at
            from
              app.pos_shifts
            where
              id = 'p77-after'
          )
        ) roster
      where
        roster.item_id = pg_temp.u (3)
    ),
    'the shift opened after the deactivation does not require the item'
  );

insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    loss_pct,
    active,
    created_at
  )
values
  (
    pg_temp.u (5),
    'p77-freq',
    'seafood',
    'kg',
    'daily',
    0,
    true,
    pg_catalog.clock_timestamp () - interval '10 days'
  );

select
  pg_temp.shift (
    'p77-freq',
    pg_catalog.clock_timestamp () - interval '9 days',
    false
  );

update app.stock_items
set
  count_frequency = 'weekly'
where
  id = pg_temp.u (5);

select
  pg_temp.shift (
    'p77-freq-after',
    pg_catalog.clock_timestamp () + interval '2 hours',
    false
  );

select
  is (
    (
      select
        roster.count_frequency
      from
        app.item_roster_as_of (
          (
            select
              opened_at
            from
              app.pos_shifts
            where
              id = 'p77-freq'
          )
        ) roster
      where
        roster.item_id = pg_temp.u (5)
    ),
    'daily',
    'the earlier shift keeps the daily frequency'
  );

select
  is (
    (
      select
        roster.count_frequency
      from
        app.item_roster_as_of (
          (
            select
              opened_at
            from
              app.pos_shifts
            where
              id = 'p77-freq-after'
          )
        ) roster
      where
        roster.item_id = pg_temp.u (5)
    ),
    'weekly',
    'the later shift sees the weekly frequency'
  );

select
  is (
    (
      select
        tgenabled::text
      from
        pg_catalog.pg_trigger
      where
        tgname = 'trg_stock_items_tracking_history'
    ),
    'A',
    'the tracking trigger fires even in replica mode'
  );

-- The test role cannot set session_replication_role. tgenabled = 'A' is the
-- catalog proof that replica mode does not skip this trigger. A direct
-- catalog update in this session still has to go through it.
update app.stock_items
set
  active = true
where
  id = pg_temp.u (3);

select
  is (
    (
      select
        count(*)
      from
        app.item_tracking_history
      where
        item_id = pg_temp.u (3)
    ),
    3::bigint,
    'a direct catalog update still appends a tracking row'
  );

select
  throws_ok (
    $$update app.item_tracking_history set active = false where item_id = 'a7700000-0000-4000-8000-000000000003'$$,
    '55000',
    'app.item_tracking_history is append-only; UPDATE is not allowed',
    'tracking history rejects a direct update'
  );

select
  throws_ok (
    $$delete from app.sales_revision_facts$$,
    '55000',
    'app.sales_revision_facts is append-only; DELETE is not allowed',
    'sales revision facts reject a delete'
  );

select
  is (
    (
      select
        row ->> 'shift_id'
      from
        app.list_shift_accounting_status ('2026-05-20 12:00+00', 'p77-buckets', 1) row
    ),
    'p77-sort',
    'the keyset page is the next shift'
  );

select
  throws_ok (
    $$select * from app.list_shift_accounting_status('2026-06-01 00:00+00', null, 10)$$,
    '22023',
    'shift page cursor is incomplete',
    'a cursor needs both parts'
  );

select
  throws_ok (
    $$select * from app.list_shift_accounting_status(null, null, 0)$$,
    '22023',
    'shift page limit is out of range',
    'a page limit below 1 is rejected'
  );

select
  throws_ok (
    $$select * from app.list_shift_accounting_status(null, null, 101)$$,
    '22023',
    'shift page limit is out of range',
    'a page limit above 100 is rejected'
  );

select
  throws_ok (
    $$select * from app.list_shift_accounting_status('infinity', 'p77-buckets', 10)$$,
    '22023',
    'shift page cursor is incomplete',
    'a non-finite cursor is rejected'
  );

-- ---------------------------------------------------------------------------
-- Review round 1. Each case is read back from the status function or the
-- revision view, not from a fixture that skips the path under test.
-- ---------------------------------------------------------------------------
create function pg_temp.one (p_id text) returns jsonb language plpgsql as $$
declare
  v_open timestamptz;
  v_body jsonb;
begin
  select
    shift.opened_at
  into v_open
  from
    app.pos_shifts shift
  where
    shift.id = p_id;

  select
    row
  into v_body
  from
    app.list_shift_accounting_status (v_open - interval '1 second', '', 20) row
  where
    row ->> 'shift_id' = p_id;

  return v_body;
end;
$$;

create function pg_temp.one_causes (p_id text) returns text[] language plpgsql as $$
declare
  v_causes text[];
begin
  select
    coalesce(
      pg_catalog.array_agg(
        e.value
        order by
          e.value
      ),
      '{}'::text[]
    )
  into v_causes
  from
    pg_catalog.jsonb_array_elements_text(pg_temp.one (p_id) -> 'causes') as e (value);

  return v_causes;
end;
$$;

create function pg_temp.seal (p_id text, p_open timestamptz) returns void language plpgsql as $$
declare
  v_run bigint;
begin
  insert into
    app.pos_shifts (id, opened_at, closed_at, is_active, pos_update_time)
  values
    (p_id, p_open, p_open + interval '10 hours', false, p_open);

  perform pg_temp.daily_count (
    pg_catalog.gen_random_uuid (),
    p_open + interval '6 hours',
    array[pg_temp.u (1), pg_temp.u (2), pg_temp.u (3)]
  );

  select
    coalesce(max(coverage.run_id), 772000) + 1
  into v_run
  from
    app.pos_sync_coverage coverage;

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
      v_run,
      pg_catalog.clock_timestamp () - interval '1 minute',
      pg_catalog.clock_timestamp (),
      true,
      'shift_ids',
      null,
      array[p_id]::text[],
      array[p_id]::text[],
      true,
      false
    );
end;
$$;

create function pg_temp.account (p_order text) returns jsonb language plpgsql as $$
declare
  v_result jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock (7342750000000000001::bigint);

  insert into
    app.order_cost_state (order_id)
  values
    (p_order)
  on conflict (order_id) do nothing;

  insert into
    app.accounting_work_state (order_id)
  values
    (p_order)
  on conflict (order_id) do nothing;

  v_result := app.process_order_accounting (p_order, pg_catalog.gen_random_uuid (), 1);

  update app.accounting_work_state
  set
    last_outcome = v_result ->> 'outcome',
    last_reason = v_result ->> 'reason',
    failed_at = null,
    work_generation = greatest (work_generation, 1)
  where
    order_id = p_order;

  update app.accounting_work_events
  set
    work_generation = 1,
    processed_at = pg_catalog.clock_timestamp ()
  where
    order_id = p_order
    and processed_at is null;

  return v_result;
end;
$$;

insert into
  app.month_expense_status (month, complete, confirmed_at, confirmed_by)
values
  (
    '2026-09-01',
    true,
    pg_catalog.clock_timestamp (),
    'a7700000-0000-4000-8000-0000000000a1'
  ),
  (
    '2026-04-01',
    true,
    pg_catalog.clock_timestamp (),
    'a7700000-0000-4000-8000-0000000000a1'
  );

-- Finding 5. A move is two facts. An unchanged total still moves.
select
  pg_temp.shift ('p77-xfer-a', '2026-09-05 12:00+00', false);

select
  pg_temp.shift ('p77-xfer-b', '2026-09-06 12:00+00', false);

select
  pg_temp.ord (
    'p77-o-xfer-eq',
    'p77-xfer-a',
    'complete',
    '2026-09-05 13:00+00',
    100
  );

select
  pg_temp.cost_input (
    'p77-o-xfer-eq',
    'p77-xfer-a',
    1,
    'complete',
    100,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-xfer-eq',
    'p77-xfer-b',
    2,
    'complete',
    100,
    false
  );

update app.pos_orders
set
  shift_id = 'p77-xfer-b'
where
  id = 'p77-o-xfer-eq';

select
  pg_temp.ord (
    'p77-o-xfer-up',
    'p77-xfer-a',
    'complete',
    '2026-09-05 14:00+00',
    100
  );

select
  pg_temp.cost_input (
    'p77-o-xfer-up',
    'p77-xfer-a',
    1,
    'complete',
    100,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-xfer-up',
    'p77-xfer-b',
    2,
    'complete',
    130,
    false
  );

select
  pg_temp.ord (
    'p77-o-xfer-same',
    'p77-xfer-a',
    'complete',
    '2026-09-05 15:00+00',
    50
  );

select
  pg_temp.cost_input (
    'p77-o-xfer-same',
    'p77-xfer-a',
    1,
    'complete',
    50,
    false
  );

select
  pg_temp.cost_input (
    'p77-o-xfer-same',
    'p77-xfer-a',
    2,
    'complete',
    50,
    false
  );

select
  results_eq (
    $$select shift_id, net_sales_difference::text
      from app.sales_revision_facts
      where order_id = 'p77-o-xfer-eq'
      order by shift_id$$,
    $$values ('p77-xfer-a', '-100.00'), ('p77-xfer-b', '100.00')$$,
    'moving a completed 100.00 order records both shift legs'
  );

select
  results_eq (
    $$select shift_id, net_sales_difference::text
      from app.sales_revision_facts
      where order_id = 'p77-o-xfer-up'
      order by shift_id$$,
    $$values ('p77-xfer-a', '-100.00'), ('p77-xfer-b', '130.00')$$,
    'a move that also changes the total is not a single +30 on the new shift'
  );

select
  is (
    (
      select
        count(*)
      from
        app.sales_revision_facts
      where
        order_id = 'p77-o-xfer-same'
    ),
    0::bigint,
    'the same shift and the same total still write nothing'
  );

select
  lives_ok (
    $$select app.note_order_total_sales_revision(input.id)
      from app.pos_cost_inputs input
      where input.order_id = 'p77-o-xfer-up' and input.input_revision = 2$$,
    'replaying a two-leg sales fact is allowed'
  );

select
  is (
    (
      select
        count(*)
      from
        app.sales_revision_facts
      where
        order_id = 'p77-o-xfer-up'
    ),
    2::bigint,
    'the idempotency key keeps both shift facts and does not add a third'
  );

-- Finding 8. Materialize the refund last. Source time still wins.
select
  pg_temp.shift ('p77-chrono', '2026-09-07 12:00+00', false);

select
  pg_temp.ord (
    'p77-o-chrono',
    'p77-chrono',
    'complete',
    '2026-09-07 13:00+00',
    100
  );

select
  pg_temp.cost_input (
    'p77-o-chrono',
    'p77-chrono',
    1,
    'complete',
    100,
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
    'p77-o-chrono',
    2,
    'p77-chrono',
    'complete',
    '2026-09-07 13:00+00',
    130,
    0,
    0,
    0,
    0,
    130,
    '2026-09-07 16:00+00',
    repeat('cd', 32),
    '[]'::jsonb,
    'sync'
  );

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
select
  'p77-o-chrono',
  2,
  snap.id,
  false,
  '{}'::bigint[],
  md5('p77-o-chrono:2'),
  'sync'
from
  app.pos_order_snapshots snap
where
  snap.order_id = 'p77-o-chrono'
  and snap.version = 2;

do $$
declare
  v_sale bigint;
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
      shift_id
    )
  values
    (
      pg_temp.u (310),
      pg_temp.u (1),
      'sale',
      '2026-09-07 14:00+00',
      -1,
      40,
      -40,
      'p77-chrono'
    )
  returning
    id into v_sale;

  insert into
    app.period_revisions (
      source_movement_id,
      shift_id,
      bucket,
      amount,
      item_id,
      cause_batch_id,
      created_at
    )
  values
    (
      v_sale,
      'p77-chrono',
      'cogs',
      -40,
      pg_temp.u (1),
      pg_temp.u (311),
      '2026-09-07 14:00+00'
    );
end;
$$;

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
    'p77-chrono',
    'tx-77-chrono',
    'p77-o-chrono',
    3,
    10,
    '2026-09-07 10:00+00',
    true,
    'sync'
  );

select
  is (
    (
      select
        cause_kind
      from
        app.accounting_revision_differences
      where
        shift_id = 'p77-chrono'
        and is_latest
    ),
    'order_total',
    'the newer order revision stays latest when an older refund is materialized after it'
  );

select
  results_eq (
    $$select cause_kind
      from app.accounting_revision_differences
      where shift_id = 'p77-chrono'
      order by source_at, cause_kind, cause_id$$,
    $$values ('refund'), ('ledger'), ('order_total')$$,
    'interleaved historical sources stay in source order'
  );

select
  ok (
    (
      select
        fact.recorded_at
      from
        app.sales_revision_facts fact
      where
        fact.order_id = 'p77-o-chrono'
        and fact.source_kind = 'refund'
    ) > (
      select
        fact.recorded_at
      from
        app.sales_revision_facts fact
      where
        fact.order_id = 'p77-o-chrono'
        and fact.source_kind = 'order_total'
    ),
    'the refund fact was materialized after the order fact'
  );

-- Finding 7. Pinned settlement, not the last shift that had opened.
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
    'p77-own-a',
    '2026-05-01 08:00+00',
    '2026-05-01 20:00+00',
    false,
    '2026-05-01 08:00+00'
  ),
  (
    'p77-own-b',
    '2026-05-01 10:00+00',
    '2026-05-01 18:00+00',
    false,
    '2026-05-01 10:00+00'
  );

select
  pg_temp.daily_count (
    pg_temp.u (320),
    '2026-05-01 21:00+00',
    array[pg_temp.u (1)]
  );

select
  is (
    (
      select
        anchor.shift_id
      from
        app.stock_count_anchors anchor
      where
        anchor.count_id = pg_temp.u (320)
    ),
    'p77-own-a',
    'the count after both shifts pins settlement to the last closed shift'
  );

select
  is (
    (
      select
        coverage.owning_shift_id
      from
        app.shift_count_coverage coverage
      where
        coverage.shift_id = 'p77-own-a'
        and coverage.item_id = pg_temp.u (1)
    ),
    'p77-own-a',
    'reported ownership is the pinned settlement shift'
  );

select
  is (
    (
      select
        coverage.interval_owning_shift_id
      from
        app.shift_count_coverage coverage
      where
        coverage.shift_id = 'p77-own-a'
        and coverage.item_id = pg_temp.u (1)
    ),
    'p77-own-b',
    'the last shift that had opened is a separate field'
  );

-- Finding 4. The live application keeps the original shift blocked.
select
  pg_temp.seal ('p77-move-a', '2026-09-01 12:00+00');

select
  pg_temp.seal ('p77-move-b', '2026-09-02 12:00+00');

select
  pg_temp.ord (
    'p77-o-move',
    'p77-move-a',
    'complete',
    '2026-09-01 13:00+00',
    80
  );

select
  pg_temp.cost_input (
    'p77-o-move',
    'p77-move-a',
    1,
    'complete',
    80,
    false
  );

update app.accounting_work_events
set
  work_generation = 1,
  processed_at = pg_catalog.clock_timestamp ()
where
  order_id = 'p77-o-move';

insert into
  app.order_cost_applications (
    order_id,
    cost_input_id,
    snapshot_id,
    receipt_kind,
    disposition,
    occurred_at,
    shift_id,
    requirements,
    signature,
    work_generation
  )
select
  'p77-o-move',
  input.id,
  input.snapshot_id,
  'posting',
  'sale',
  '2026-09-01 13:00+00',
  'p77-move-a',
  '[]'::jsonb,
  md5('p77-o-move-sale'),
  1
from
  app.pos_cost_inputs input
where
  input.order_id = 'p77-o-move'
  and input.input_revision = 1;

insert into
  app.order_cost_state (
    order_id,
    latest_input_id,
    latest_application_id,
    owner_application_id,
    disposition,
    signature
  )
select
  'p77-o-move',
  input.id,
  application.id,
  application.id,
  'sale',
  md5('p77-o-move-sale')
from
  app.pos_cost_inputs input
  join app.order_cost_applications application on application.order_id = input.order_id
where
  input.order_id = 'p77-o-move'
  and input.input_revision = 1;

select
  pg_temp.cost_input (
    'p77-o-move',
    'p77-move-b',
    2,
    'complete',
    80,
    false
  );

update app.pos_orders
set
  shift_id = 'p77-move-b'
where
  id = 'p77-o-move';

update app.order_cost_state
set
  latest_input_id = (
    select
      input.id
    from
      app.pos_cost_inputs input
    where
      input.order_id = 'p77-o-move'
      and input.input_revision = 2
  )
where
  order_id = 'p77-o-move';

select
  ok (
    'pending_applications' = any (pg_temp.one_causes ('p77-move-b')),
    'the shift on the latest snapshot still sees the unsettled event'
  );

select
  ok (
    'pending_applications' = any (pg_temp.one_causes ('p77-move-a'))
    and 'stale_applications' = any (pg_temp.one_causes ('p77-move-a')),
    'the original shift keeps the live application and the stale receipt'
  );

select
  is (
    pg_temp.one ('p77-move-a') ->> 'status_label',
    'ناقص',
    'moving the order does not leave the original shift final'
  );

-- Finding 3. An unfinished span is pending before any span event exists,
-- including orders past the first 100 after the cursor advances.
select
  pg_temp.seal ('p77-span-before', '2026-09-10 12:00+00');

select
  pg_temp.ord (
    'p77-span-o-before',
    'p77-span-before',
    'complete',
    '2026-09-10 13:00+00',
    10
  );

select
  pg_temp.cost_input (
    'p77-span-o-before',
    'p77-span-before',
    1,
    'complete',
    10,
    false
  );

update app.accounting_work_events
set
  work_generation = 1,
  processed_at = pg_catalog.clock_timestamp ()
where
  order_id = 'p77-span-o-before';

insert into
  app.costing_changes (request_id, kind, payload, result)
values
  (
    pg_temp.u (330),
    'owner',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into
  app.accounting_rederive_spans (
    family,
    version_id,
    cause,
    change_id,
    effective_from,
    effective_to
  )
values
  (
    'pos_map',
    pg_temp.u (331),
    'insert',
    (
      select
        change.id
      from
        app.costing_changes change
      where
        change.request_id = pg_temp.u (330)
    ),
    '2026-09-10 00:00+00',
    '2026-09-13 00:00+00'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events event
      where
        event.cause = 'config_span'
    ),
    0::bigint,
    'the span has not been expanded into work events'
  );

select
  ok (
    'pending_applications' = any (pg_temp.one_causes ('p77-span-before')),
    'an unexpanded span blocks the shift before any event exists'
  );

select
  pg_temp.seal ('p77-span-held', '2026-09-11 12:00+00');

select
  pg_temp.seal ('p77-span-rest', '2026-09-12 12:00+00');

select
  pg_temp.seal ('p77-span-out', '2026-09-14 12:00+00');

do $$
declare
  v_i integer;
  v_id text;
  v_shift text;
  v_at timestamptz;
begin
  for v_i in 1..101 loop
    v_id := 'p77-span-o-' || lpad(v_i::text, 3, '0');
    v_shift := case
      when v_i = 101 then 'p77-span-rest'
      else 'p77-span-held'
    end;
    v_at := '2026-09-11 00:00+00'::timestamptz + (v_i || ' minutes')::interval;

    perform pg_temp.ord (v_id, v_shift, 'complete', v_at, 10);
    perform pg_temp.cost_input (v_id, v_shift, 1, 'complete', 10, false);
  end loop;

  perform pg_temp.ord (
    'p77-span-o-out',
    'p77-span-out',
    'complete',
    '2026-09-14 13:00+00',
    10
  );

  perform pg_temp.cost_input (
    'p77-span-o-out',
    'p77-span-out',
    1,
    'complete',
    10,
    false
  );

  update app.accounting_work_events
  set
    work_generation = 1,
    processed_at = pg_catalog.clock_timestamp ()
  where
    order_id like 'p77-span-o-%'
    and processed_at is null;

  update app.accounting_rederive_spans
  set
    cursor_ordered_at = '2026-09-11 00:00+00'::timestamptz + interval '100 minutes',
    cursor_order_id = 'p77-span-o-100'
  where
    version_id = pg_temp.u (331);
end;
$$;

select
  is (
    pg_temp.one ('p77-span-held') ->> 'pending_applications',
    '0',
    'orders at or before the span cursor are not still pending'
  );

select
  ok (
    (
      pg_temp.one ('p77-span-rest') ->> 'pending_applications'
    )::integer >= 1,
    'the order after the first 100 candidates stays pending while the span is open'
  );

select
  is (
    pg_temp.one ('p77-span-out') ->> 'pending_applications',
    '0',
    'an order outside the span interval is not a remaining candidate'
  );

select
  is (
    pg_temp.one ('p77-span-before') ->> 'pending_applications',
    '0',
    'a candidate behind the cursor is not pending once the cursor has passed it'
  );

-- Finding 9. Lines are covered on their own. The order stays atomic.
create function pg_temp.policies (p_pos text) returns void language plpgsql as $$
begin
  perform app.set_pos_option_policy (
    md5('opt|' || p_pos)::uuid,
    p_pos,
    '["none"]'::jsonb,
    '2026-01-01T00:00:00Z',
    null,
    'none_expected',
    (
      select
        app.pos_base_schedule (p_pos, '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );

  perform app.set_base_packaging (
    md5('bpk|' || p_pos)::uuid,
    p_pos,
    '["none"]'::jsonb,
    '2026-01-01T00:00:00Z',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_base_schedule (p_pos, '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
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
  perform app.set_pos_base_mapping (
    md5('map|' || p_pos || '|' || p_from::text)::uuid,
    p_pos,
    '["none"]'::jsonb,
    p_from,
    null,
    pg_catalog.jsonb_build_object(
      'stock_item_id',
      p_item,
      'quantity_per_basis',
      p_qty,
      'unit',
      'kg'
    ),
    (
      select
        app.pos_base_schedule (p_pos, '["none"]'::jsonb) ->> 'token'
    ),
    'fixture'
  );
end;
$$;

create function pg_temp.type_ok (p_type text) returns void language plpgsql as $$
begin
  perform app.set_order_type_packaging (
    md5('ot|' || p_type)::uuid,
    p_type,
    '2026-01-01T00:00:00Z',
    null,
    '{"none": true}'::jsonb,
    (
      select
        app.packaging_order_type_schedule (p_type) ->> 'token'
    ),
    'fixture'
  );
end;
$$;

select
  app.set_item_loss (
    md5('loss|p77-u1')::uuid,
    pg_temp.u (1),
    0,
    '2026-01-01 00:00+00',
    null,
    (
      select
        app.schedule_token ('loss', pg_temp.u (1), null)
    ),
    'fixture'
  );

select
  pg_temp.policies ('pos-ready');

select
  pg_temp.map_stock (
    'pos-ready',
    pg_temp.u (1),
    '1',
    '2026-01-01 00:00+00'
  );

select
  pg_temp.shift ('p77-lines', '2026-12-20 12:00+00', false);

select
  pg_temp.ord (
    'p77-o-mix',
    'p77-lines',
    'complete',
    '2026-12-20 13:00+00',
    20
  );

select
  pg_temp.ord (
    'p77-o-pack',
    'p77-lines',
    'complete',
    '2026-12-20 14:00+00',
    20
  );

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    options,
    line_total
  )
values
  (
    'p77-o-mix',
    'l1',
    'pos-ready',
    'x',
    1,
    '[]'::jsonb,
    0
  ),
  (
    'p77-o-mix',
    'l2',
    'pos-gap',
    'x',
    1,
    '[]'::jsonb,
    0
  ),
  (
    'p77-o-pack',
    'l1',
    'pos-ready',
    'x',
    1,
    '[]'::jsonb,
    0
  );

select
  is (
    pg_temp.one ('p77-lines') ->> 'completed_orders_covered',
    '0',
    'neither order is ready: one line is unmapped and order packaging is unresolved'
  );

select
  is (
    pg_temp.one ('p77-lines') ->> 'completed_orders_denominator',
    '2',
    'both complete orders are in the order denominator'
  );

select
  is (
    pg_temp.one ('p77-lines') ->> 'completed_lines_covered',
    '2',
    'the mapped lines are covered without the unmapped line or the order packaging'
  );

select
  is (
    pg_temp.one ('p77-lines') ->> 'completed_lines_denominator',
    '3',
    'every positive line stays in the line denominator'
  );

select
  ok (
    'order_coverage_incomplete' = any (pg_temp.one_causes ('p77-lines')),
    'order readiness stays atomic when some lines are already covered'
  );

-- Findings 2 and 6 go through the coordinator. The sealed control is judged
-- before the pre-migration item exists, because that item blocks every earlier shift.
select
  pg_temp.seal ('p77-seal', '2026-09-16 12:00+00');

select
  pg_temp.seal ('p77-inc', '2026-09-15 12:00+00');

select
  pg_temp.seal ('p77-reclass', '2026-09-21 12:00+00');

insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    loss_pct,
    active,
    created_at
  )
values
  (
    pg_temp.u (8),
    'p77-reclass-fish',
    'seafood',
    'kg',
    'daily',
    0,
    true,
    '2026-09-20 00:00+00'
  );

select
  pg_temp.daily_count (
    pg_temp.u (340),
    '2026-09-21 18:00+00',
    array[pg_temp.u (8)]
  );

select
  app.set_item_loss (
    md5('loss|p77-u8')::uuid,
    pg_temp.u (8),
    0,
    '2026-09-01 00:00+00',
    null,
    (
      select
        app.schedule_token ('loss', pg_temp.u (8), null)
    ),
    'fixture'
  );

select
  app.post_movements (
    pg_catalog.jsonb_build_array (
      pg_catalog.jsonb_build_object (
        'item_id',
        pg_temp.u (8),
        'movement_type',
        'purchase',
        'occurred_at',
        '2026-09-20 08:00+00',
        'quantity',
        100,
        'unit_cost',
        50
      )
    )
  );

select
  pg_temp.policies ('pos-reclass');

select
  pg_temp.policies ('pos-inc');

select
  pg_temp.map_stock (
    'pos-reclass',
    pg_temp.u (8),
    '1',
    '2026-09-20 00:00+00'
  );

select
  pg_temp.type_ok ('hall');

-- These dated writes open rederive spans. Close them so they are not pending
-- work for the shifts under test. The span case already asserted the open one.
update app.accounting_rederive_spans
set
  completed_at = pg_catalog.clock_timestamp ()
where
  completed_at is null;

insert into
  app.inventory_activation (
    stock_started_at,
    approved_by,
    request_id,
    opening_manifest_hash
  )
values
  (
    '2026-09-01 00:00+00',
    'a7700000-0000-4000-8000-0000000000a1',
    pg_temp.u (341),
    repeat('a', 32)
  );

select
  pg_temp.ord (
    'p77-o-reclass',
    'p77-reclass',
    'complete',
    '2026-09-21 13:00+00',
    100
  );

update app.pos_orders
set
  order_type = 'hall'
where
  id = 'p77-o-reclass';

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    options,
    line_total
  )
values
  (
    'p77-o-reclass',
    'l1',
    'pos-reclass',
    'x',
    2,
    '[]'::jsonb,
    100
  );

select
  app.capture_pos_order_snapshot ('p77-o-reclass', null, 'sync');

select
  app.append_pos_cost_input ('p77-o-reclass', null, 'sync');

select
  is (
    pg_temp.account ('p77-o-reclass') ->> 'outcome',
    'applied',
    'the mapped order posts a sale before it is reclassified'
  );

update app.pos_orders
set
  status = 'canceled',
  version = version + 1,
  pos_update_time = '2026-09-21 15:00+00',
  content_hash = repeat('aa', 32)
where
  id = 'p77-o-reclass';

delete from app.pos_order_lines
where
  order_id = 'p77-o-reclass';

select
  app.capture_pos_order_snapshot ('p77-o-reclass', null, 'sync');

select
  app.append_pos_cost_input ('p77-o-reclass', null, 'sync');

select
  is (
    pg_temp.account ('p77-o-reclass') ->> 'outcome',
    'applied',
    'the cancellation posts prepared waste in its own batch'
  );

select
  is (
    (
      select
        count(distinct application.retire_batch) + count(distinct application.posting_batch)
      from
        app.order_cost_applications application
      where
        application.order_id = 'p77-o-reclass'
        and application.disposition = 'prepared_waste'
        and application.retire_batch is not null
        and application.posting_batch is not null
    ),
    2::bigint,
    'the coordinator retires the sale and posts the waste as two batches'
  );

select
  results_eq (
    $$select
        diff.cogs_difference,
        diff.waste_difference,
        diff.profit_difference
      from
        app.accounting_revision_differences diff
      where
        diff.shift_id = 'p77-reclass'
        and diff.cause_kind = 'application'
        and diff.cogs_difference <> '0.00'
        and diff.waste_difference <> '0.00'$$,
    $$values ('-100.00', '100.00', '0.00')$$,
    'reclassifying the 100.00 sale into waste is one zero-profit vector'
  );

select
  ok (
    not exists (
      select
        1
      from
        app.order_cost_applications application
        join app.accounting_revision_differences diff on diff.cause_id in (
          application.retire_batch::text,
          application.posting_batch::text
        )
      where
        application.order_id = 'p77-o-reclass'
        and (
          application.retire_batch is not null
          or application.posting_batch is not null
        )
    ),
    'neither batch id is its own revision cause'
  );

-- Finding 2. A reviewed cancel with a preparation snapshot and no mapping.
select
  pg_temp.ord (
    'p77-o-inc',
    'p77-inc',
    'complete',
    '2026-09-15 13:00+00',
    40
  );

update app.pos_orders
set
  order_type = 'hall'
where
  id = 'p77-o-inc';

insert into
  app.pos_order_lines (
    order_id,
    line_id,
    item_id,
    item_name,
    quantity,
    options,
    line_total
  )
values
  (
    'p77-o-inc',
    'l1',
    'pos-inc',
    'x',
    1,
    '[]'::jsonb,
    40
  );

select
  app.capture_pos_order_snapshot ('p77-o-inc', null, 'sync');

select
  app.append_pos_cost_input ('p77-o-inc', null, 'sync');

update app.pos_orders
set
  status = 'canceled',
  version = version + 1,
  pos_update_time = '2026-09-15 15:00+00',
  content_hash = repeat('bb', 32)
where
  id = 'p77-o-inc';

select
  app.capture_pos_order_snapshot ('p77-o-inc', null, 'sync');

select
  app.append_pos_cost_input ('p77-o-inc', null, 'sync');

select
  is (
    pg_temp.account ('p77-o-inc') ->> 'outcome',
    'incomplete',
    'the first cancellation pass finishes incomplete instead of blocking'
  );

select
  is (
    (
      app.set_order_disposition (
        pg_catalog.gen_random_uuid (),
        'p77-o-inc',
        'made',
        (
          select
            queue.token
          from
            app.order_decision_queue queue
          where
            queue.order_id = 'p77-o-inc'
        ),
        null,
        null
      ) ->> 'outcome'
    ),
    'incomplete',
    'the owner review applies the same incomplete cancellation'
  );

select
  is (
    pg_temp.account ('p77-o-inc') ->> 'outcome',
    'incomplete',
    'a second pass stays incomplete after the decision is reviewed'
  );

select
  is (
    (
      select
        state.disposition
      from
        app.order_cost_state state
      where
        state.order_id = 'p77-o-inc'
    ),
    'incomplete',
    'the latest application disposition stays incomplete'
  );

select
  is (
    (
      select
        state.last_outcome
      from
        app.accounting_work_state state
      where
        state.order_id = 'p77-o-inc'
    ),
    'incomplete',
    'the coordinator recorded the incomplete outcome'
  );

select
  is (
    (
      select
        count(*)
      from
        app.accounting_work_events event
      where
        event.order_id = 'p77-o-inc'
        and event.processed_at is null
    ),
    0::bigint,
    'the incomplete order has no pending work event'
  );

select
  diag (pg_temp.one_causes ('p77-inc')::text);

select
  ok (
    pg_temp.one_causes ('p77-inc') @> array['incomplete_application', 'unmapped_base']::text[],
    'incomplete cancellation accounting blocks the shift with the mapping cause'
  );

select
  ok (
    not (
      pg_temp.one_causes ('p77-inc') && array[
        'pending_applications',
        'unreviewed_decisions',
        'unresolved_preparation',
        'order_coverage_incomplete'
      ]::text[]
    ),
    'the incomplete receipt is not hidden by pending, decision, preparation, or order coverage'
  );

select
  is (
    pg_temp.one ('p77-inc') ->> 'status_label',
    'ناقص',
    'unknown waste cost keeps the shift unclosed'
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
select
  coalesce(max(coverage.run_id), 772000) + 1,
  pg_catalog.clock_timestamp () - interval '1 minute',
  pg_catalog.clock_timestamp (),
  true,
  'shift_ids',
  null,
  array[
    'p77-own-a',
    'p77-own-b',
    'p77-xfer-a',
    'p77-xfer-b',
    'p77-chrono'
  ]::text[],
  array[
    'p77-own-a',
    'p77-own-b',
    'p77-xfer-a',
    'p77-xfer-b',
    'p77-chrono'
  ]::text[],
  true,
  false
from
  app.pos_sync_coverage coverage;

select
  is (
    pg_temp.one ('p77-seal') ->> 'status_label',
    'مقفول نهائي',
    'a sealed shift with no unknown tracking is final'
  );

-- Finding 1. The backfill clock stays honest, and a shift that opened earlier is blocked.
do $$
begin
  execute 'alter table app.stock_items disable trigger trg_stock_items_tracking_history';

  insert into
    app.stock_items (
      id,
      name,
      kind,
      base_unit,
      count_frequency,
      loss_pct,
      active,
      created_at
    )
  values
    (
      pg_temp.u (9),
      'p77-hist-fish',
      'seafood',
      'kg',
      'daily',
      0,
      true,
      '2020-01-01 00:00+00'
    );

  insert into
    app.item_tracking_history (item_id, active, count_frequency, known_since, basis)
  values
    (
      pg_temp.u (9),
      true,
      'daily',
      '2026-05-01 00:00+00',
      'backfill'
    );

  execute 'alter table app.stock_items enable always trigger trg_stock_items_tracking_history';
exception
  when others then
    execute 'alter table app.stock_items enable always trigger trg_stock_items_tracking_history';

    raise;
end;
$$;

select
  pg_temp.seal ('p77-hist', '2026-04-01 12:00+00');

select
  pg_temp.seal ('p77-hist-later', '2026-05-02 12:00+00');

select
  is (
    pg_temp.one ('p77-hist') ->> 'status_label',
    'ناقص',
    'a shift opened before the item was known cannot close final'
  );

select
  ok (
    'tracking_unknown' = any (pg_temp.one_causes ('p77-hist')),
    'unknown historical tracking is its own blocker'
  );

select
  is (
    pg_temp.one ('p77-hist') ->> 'daily_required',
    '0',
    'the backfill does not invent a roster row before it was known'
  );

select
  is (
    (
      select
        history.basis
      from
        app.item_tracking_history history
      where
        history.item_id = pg_temp.u (1)
      order by
        history.known_since,
        history.id
      limit
        1
    ),
    'observed',
    'an item inserted after the migration is observed, not backfilled'
  );

select
  ok (
    not (
      'tracking_unknown' = any (pg_temp.one_causes ('p77-hist-later'))
    ),
    'a shift opened after the backfill clock is not unknown tracking'
  );

-- Finding 10. One year of counts, one page. Budget is 2000 ms.
insert into
  app.stock_items (
    id,
    name,
    kind,
    base_unit,
    count_frequency,
    loss_pct,
    active,
    created_at
  )
values
  (
    pg_temp.u (6),
    'p77-year-daily',
    'seafood',
    'kg',
    'daily',
    0,
    true,
    '2024-01-01 00:00+00'
  ),
  (
    pg_temp.u (7),
    'p77-year-weekly',
    'seafood',
    'kg',
    'weekly',
    0,
    true,
    '2024-01-01 00:00+00'
  );

insert into
  app.pos_shifts (
    id,
    opened_at,
    closed_at,
    is_active,
    pos_update_time
  )
select
  'p77-y-' || pg_catalog.to_char (day, 'YYYYMMDD'),
  day + time '12:00',
  day + time '22:00',
  false,
  day + time '12:00'
from
  pg_catalog.generate_series (
    '2024-01-02'::date,
    '2024-01-02'::date + 364,
    interval '1 day'
  ) as day;

with
  daily as (
    insert into
      app.stock_counts (id, request_id, frequency, counted_at)
    select
      pg_catalog.gen_random_uuid (),
      pg_catalog.gen_random_uuid (),
      'daily',
      shift.opened_at + interval '6 hours'
    from
      app.pos_shifts shift
    where
      shift.id like 'p77-y-%'
    returning
      id
  )
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
select
  daily.id,
  1,
  pg_temp.u (6),
  'kg',
  0,
  0,
  0,
  0
from
  daily;

with
  weekly as (
    insert into
      app.stock_counts (id, request_id, frequency, counted_at)
    select
      pg_catalog.gen_random_uuid (),
      pg_catalog.gen_random_uuid (),
      'weekly',
      shift.opened_at + interval '6 hours'
    from
      app.pos_shifts shift
    where
      shift.id like 'p77-y-%'
      and (shift.opened_at::date - date '2024-01-02') % 7 = 0
    returning
      id
  )
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
select
  weekly.id,
  1,
  pg_temp.u (7),
  'kg',
  0,
  0,
  0,
  0
from
  weekly;

create temp table p77_bench (ms numeric);

do $$
declare
  v_start timestamptz;
  v_ms numeric;
  v_rows integer;
begin
  v_start := pg_catalog.clock_timestamp ();

  select
    count(*)
  into v_rows
  from
    app.list_shift_accounting_status (null, null, 50);

  v_ms := 1000 * pg_catalog.date_part(
    'epoch',
    pg_catalog.clock_timestamp () - v_start
  );

  insert into
    p77_bench (ms)
  values
    (v_ms);

  raise notice 'annual shift status page: % ms (budget 2000), rows %', pg_catalog.round(v_ms, 1), v_rows;
end;
$$;

select
  diag ('annual shift status page ms: ' || ms::text)
from
  p77_bench;

select
  ok (
    (
      select
        ms <= 2000
      from
        p77_bench
    ),
    'annual status page of 50 shifts over a year of counts finishes within 2000 ms'
  );

select
  ok (
    not has_table_privilege(
      'authenticated',
      'app.item_tracking_history',
      'INSERT'
    ),
    'authenticated has no insert on tracking history'
  );

select
  ok (
    not has_table_privilege(
      'authenticated',
      'app.item_tracking_history',
      'UPDATE'
    ),
    'authenticated has no update on tracking history'
  );

select
  ok (
    not has_table_privilege(
      'authenticated',
      'app.item_tracking_history',
      'DELETE'
    ),
    'authenticated has no delete on tracking history'
  );

select
  ok (
    not has_table_privilege(
      'service_role',
      'app.sales_revision_facts',
      'INSERT'
    ),
    'service_role has no insert on sales facts'
  );

select
  ok (
    has_table_privilege(
      'service_role',
      'app.sales_revision_facts',
      'SELECT'
    ),
    'service_role can select sales facts'
  );

select
  ok (
    has_function_privilege(
      'authenticated',
      'app.list_shift_accounting_status(timestamptz, text, integer)',
      'EXECUTE'
    ),
    'authenticated can execute the status read'
  );

select
  ok (
    not has_function_privilege(
      'anon',
      'app.list_shift_accounting_status(timestamptz, text, integer)',
      'EXECUTE'
    ),
    'anon cannot execute the status read'
  );

select
  ok (
    not has_function_privilege(
      'service_role',
      'app.list_shift_accounting_status(timestamptz, text, integer)',
      'EXECUTE'
    ),
    'service_role cannot execute the status read'
  );

select
  ok (
    not has_function_privilege(
      'authenticated',
      'app.note_order_total_sales_revision(bigint)',
      'EXECUTE'
    ),
    'authenticated cannot execute the sales writer'
  );

select
  ok (
    not has_function_privilege(
      'authenticated',
      'app.note_refund_sales_revision(bigint)',
      'EXECUTE'
    ),
    'authenticated cannot execute the refund writer'
  );

select
  ok (
    (
      select
        c.relrowsecurity
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname = 'app'
        and c.relname = 'item_tracking_history'
    ),
    'tracking history has RLS'
  );

select
  ok (
    (
      select
        c.relrowsecurity
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname = 'app'
        and c.relname = 'sales_revision_facts'
    ),
    'sales revision facts have RLS'
  );

set
  local role authenticated;

select
  throws_ok (
    $$insert into app.item_tracking_history (item_id, active, count_frequency, known_since)
      values ('a7700000-0000-4000-8000-000000000001', true, 'daily', now())$$,
    '42501',
    'permission denied for table item_tracking_history',
    'an owner session cannot insert tracking history directly'
  );

select
  throws_ok (
    $$insert into app.sales_revision_facts (source_kind, source_revision_id, shift_id, net_sales_difference)
      values ('refund', 1, 'p77-refund', 0)$$,
    '42501',
    'permission denied for table sales_revision_facts',
    'an owner session cannot insert a sales fact directly'
  );

reset role;

select
  pg_temp.as_user ('a7700000-0000-4000-8000-0000000000a2');

set
  local role authenticated;

select
  throws_ok (
    $$select * from app.list_shift_accounting_status()$$,
    '42501',
    'insufficient_privilege',
    'a non-owner cannot read shift status'
  );

select
  is_empty (
    $$select 1 from app.shift_count_coverage limit 1$$,
    'a non-owner select on the coverage view sees no rows'
  );

reset role;

select
  pg_temp.as_user ('a7700000-0000-4000-8000-0000000000a1');

set
  local role authenticated;

select
  ok (
    (
      select
        count(*)
      from
        app.list_shift_accounting_status (null, null, 1)
    ) = 1,
    'the owner can read one status page'
  );

update app.stock_items
set
  active = false
where
  id = pg_temp.u (5);

reset role;

select
  is (
    (
      select
        count(*)
      from
        app.item_tracking_history
      where
        item_id = pg_temp.u (5)
    ),
    3::bigint,
    'an owner catalog update still appends history'
  );

set
  local role service_role;

select
  throws_ok (
    $$select * from app.list_shift_accounting_status()$$,
    '42501',
    'permission denied for function list_shift_accounting_status',
    'service_role cannot read shift status'
  );

select
  ok (
    (
      select
        count(*)
      from
        app.item_tracking_history
    ) > 0,
    'service_role can select tracking history'
  );

reset role;

set
  local role anon;

select
  throws_ok (
    $$select * from app.list_shift_accounting_status()$$,
    '42501',
    'permission denied for schema app',
    'anon cannot read shift status'
  );

select
  throws_ok (
    $$select * from app.item_tracking_history$$,
    '42501',
    'permission denied for schema app',
    'anon cannot select tracking history'
  );

reset role;

select
  *
from
  finish ();

rollback;
