// Local history gate for one component. Synthetic catalog only.
// Historical orders are posted by app.run_accounting_work, one committed call
// at a time. The measured call is a top-level statement. statement_timeout is
// set on the session before that statement. The late order is a new order at
// the queue head. 2 seconds is the soft gate and 6 seconds is the hard gate:
// either one fails the run. Checkpoints are published by the confirming walk.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const owner = 'b9e00000-0000-4000-8000-0000000000a1';

const histories = [
  {
    name: '35-day',
    prefix: 'b35',
    days: 35,
    perDay: 100,
    item: 'b9e00000-0000-4000-8000-000000000035',
    weeklyItem: 'b9e00000-0000-4000-8000-000000000036',
    openingRequest: 'b9e00000-0000-4000-8000-000000000135',
    activationRequest: 'b9e00000-0000-4000-8000-000000000235',
  },
  {
    name: '1-year',
    prefix: 'b365',
    days: 365,
    perDay: 100,
    item: 'b9e00000-0000-4000-8000-000000000365',
    weeklyItem: 'b9e00000-0000-4000-8000-000000000366',
    openingRequest: 'b9e00000-0000-4000-8000-000000000375',
    activationRequest: 'b9e00000-0000-4000-8000-000000000376',
  },
  {
    name: '2-year',
    prefix: 'b730',
    days: 730,
    perDay: 100,
    item: 'b9e00000-0000-4000-8000-000000000730',
    weeklyItem: 'b9e00000-0000-4000-8000-000000000731',
    openingRequest: 'b9e00000-0000-4000-8000-000000000732',
    activationRequest: 'b9e00000-0000-4000-8000-000000000733',
  },
];

function dockerText(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || out || `docker exited ${code}`));
    });
  });
}

async function containerName() {
  if (process.env.E2E_SUPABASE_DB_CONTAINER) {
    return process.env.E2E_SUPABASE_DB_CONTAINER;
  }
  const names = await dockerText(['ps', '--format', '{{.Names}}']);
  const lines = names
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const found =
    lines.find((line) => line === 'supabase_db_thesharkapp') ??
    (lines.filter((line) => line.startsWith('supabase_db_')).length === 1
      ? lines.find((line) => line.startsWith('supabase_db_'))
      : undefined);
  if (!found) {
    throw new Error('the local supabase database container is not running');
  }
  return found;
}

let containerNameCached = '';

function claims(local = true) {
  return `select set_config('request.jwt.claims', jsonb_build_object('sub', '${owner}', 'role', 'authenticated')::text, ${local});`;
}

function setupSql() {
  return `
begin;
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  '${owner}',
  'authenticated',
  'authenticated',
  'owner-bench@theshark.test',
  '',
  '2026-01-01 00:00:00+00',
  '', '', '', ''
) on conflict (id) do nothing;
insert into app.owner (user_id) values ('${owner}')
on conflict (user_id) do nothing;
commit;
`;
}

function historySql(history) {
  const orders = history.days * history.perDay;
  const openingQty = orders + 1;
  const late = `${history.prefix}-late`;
  const pos = `bench-${history.prefix}`;
  const shift = `${history.prefix}-shift`;
  return `
begin;
set statement_timeout = 0;
set lock_timeout = 0;
${claims()}
insert into app.stock_items (id, name, kind, base_unit, count_frequency)
values ('${history.item}', 'bench ${history.name}', 'seafood', 'kg', 'daily');
select app.set_item_loss(
  md5('loss|${history.prefix}')::uuid,
  '${history.item}',
  0,
  '2020-01-01 00:00:00+00',
  null,
  (select app.schedule_token('loss', '${history.item}', null)),
  'fixture'
);
select app.set_pos_option_policy(
  md5('opt|${pos}')::uuid, '${pos}', '["none"]'::jsonb,
  '2020-01-01 00:00:00+00', null, 'none_expected',
  (select app.pos_base_schedule('${pos}', '["none"]'::jsonb) ->> 'token'),
  'fixture'
);
select app.set_base_packaging(
  md5('bpk|${pos}')::uuid, '${pos}', '["none"]'::jsonb,
  '2020-01-01 00:00:00+00', null, '{"none": true}'::jsonb,
  (select app.packaging_base_schedule('${pos}', '["none"]'::jsonb) ->> 'token'),
  'fixture'
);
select app.set_pos_base_mapping(
  md5('map|${pos}')::uuid, '${pos}', '["none"]'::jsonb,
  '2020-01-01 00:00:00+00', null,
  jsonb_build_object(
    'stock_item_id', '${history.item}',
    'quantity_per_basis', '1',
    'unit', 'kg'
  ),
  (select app.pos_base_schedule('${pos}', '["none"]'::jsonb) ->> 'token'),
  'fixture'
);
select app.set_order_type_packaging(
  md5('ot|${history.prefix}')::uuid, 'hall-${history.prefix}', '2020-01-01 00:00:00+00', null,
  '{"none": true}'::jsonb,
  (select app.packaging_order_type_schedule('hall-${history.prefix}') ->> 'token'),
  'fixture'
);
select app.record_opening_stock(
  '2025-12-31 08:00:00+00',
  jsonb_build_array(jsonb_build_object(
    'item_id', '${history.item}',
    'quantity', '${openingQty}',
    'unit', 'kg',
    'unit_cost', '10',
    'expected_base_unit', 'kg',
    'expected_factor', '1'
  )),
  '${history.openingRequest}'
);
insert into app.inventory_activation (
  stock_started_at, approved_by, request_id, opening_manifest_hash
)
select
  '2025-12-31 08:00:00+00',
  '${owner}',
  '${history.activationRequest}',
  md5('${history.prefix}-manifest')
where not exists (select 1 from app.inventory_activation);
update app.accounting_rederive_spans
set completed_at = pg_catalog.clock_timestamp()
where completed_at is null;
insert into app.pos_shifts (id, opened_at, is_active, pos_update_time)
values ('${shift}', '2025-12-31 08:00:00+00', false, '2025-12-31 08:00:00+00');
insert into app.pos_orders (
  id, shift_id, status, order_type, ordered_at, subtotal, discount, tax,
  service_tax, delivery_fee, total, pos_update_time, content_hash, missing_from_pos
)
select
  '${history.prefix}-' || pg_catalog.lpad(g.n::text, 6, '0'),
  '${shift}',
  'complete',
  'hall-${history.prefix}',
  timestamptz '2026-01-01 08:00:00+00'
    + ((g.n - 1) / ${history.perDay}) * interval '1 day'
    + ((g.n - 1) % ${history.perDay}) * interval '8 minutes',
  0, 0, 0, 0, 0, 0,
  timestamptz '2026-01-01 08:00:00+00'
    + ((g.n - 1) / ${history.perDay}) * interval '1 day'
    + ((g.n - 1) % ${history.perDay}) * interval '8 minutes',
  rpad(md5('${history.prefix}-' || g.n::text), 64, 'a'),
  false
from pg_catalog.generate_series(1, ${orders}) as g (n);
insert into app.pos_order_lines (
  order_id, line_id, item_id, item_name, quantity, options, line_total
)
select o.id, 'l1', '${pos}', 'x', 1, '[]'::jsonb, 0
from app.pos_orders o
where o.id like '${history.prefix}-%'
  and o.id <> '${late}';
select count(app.append_pos_cost_input(o.id, null, 'sync'))
from app.pos_orders o
where o.id like '${history.prefix}-%'
  and o.id <> '${late}';
insert into app.stock_items (id, name, kind, base_unit, count_frequency)
values (
  '${history.weeklyItem}',
  'bench ${history.name} weekly',
  'seafood',
  'kg',
  'weekly'
);
commit;
select '${history.name} catalog committed ${orders}';
`;
}

function dayCountSql(history, dayNumber) {
  const openingQty = history.days * history.perDay + 1;
  const actual = openingQty - dayNumber * history.perDay;
  const daily = `
with inserted as (
  insert into app.stock_counts (id, request_id, frequency, counted_at)
  values (
    pg_catalog.gen_random_uuid(),
    pg_catalog.gen_random_uuid(),
    'daily',
    timestamptz '2026-01-01 22:00:00+00' + ${dayNumber - 1} * interval '1 day'
  )
  returning id
)
insert into app.stock_count_lines (
  count_id, line_no, item_id, expected_base_unit,
  counted_qty, expected_qty, delta_qty, delta_value
)
select
  inserted.id, 1, '${history.item}', 'kg',
  ${actual}, ${actual}, 0, 0
from inserted;`;
  if (dayNumber % 7 !== 0) return daily;
  const week = dayNumber / 7;
  return `${daily}
with inserted as (
  insert into app.stock_counts (id, request_id, frequency, counted_at)
  values (
    pg_catalog.gen_random_uuid(),
    pg_catalog.gen_random_uuid(),
    'weekly',
    timestamptz '2026-01-07 22:00:00+00' + ${week - 1} * interval '7 days'
  )
  returning id
)
insert into app.stock_count_lines (
  count_id, line_no, item_id, expected_base_unit,
  counted_qty, expected_qty, delta_qty, delta_value
)
select
  inserted.id, 1, '${history.weeklyItem}', 'kg', 0, 0, 0, 0
from inserted;`;
}

function postCallSql(history, startAt, count, post) {
  const parts = [];
  let posted = startAt;
  const end = startAt + count;
  while (posted < end) {
    const used = posted % history.perDay;
    const take = Math.min(history.perDay - used, end - posted);
    parts.push(Array.from({ length: take }, () => post).join('\n'));
    posted += take;
    if (posted % history.perDay === 0) {
      parts.push(dayCountSql(history, posted / history.perDay));
    }
  }
  return parts.join('\n');
}

function postSql(
  history,
  { remaining = null, reset = true, already = 0 } = {},
) {
  const orders = history.days * history.perDay;
  const calls = remaining ?? orders;
  const post = `select pg_temp.post_next_bench_order('${history.prefix}');`;
  // A count is written after the day it closes. Inserting every future count
  // first would put the checkpoint cut on the last anchor, and every later
  // order would fall behind that cut, so the walk could not resume.
  const startAt = reset ? 0 : already;
  const callSql = postCallSql(history, startAt, calls, post);
  const progressSql = reset
    ? `insert into public.bench_build_progress (history, posted, started_at, updated_at)
values ('${history.name}', 0, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())
on conflict (history) do update
set posted = 0,
  started_at = excluded.started_at,
  updated_at = excluded.updated_at;`
    : `insert into public.bench_build_progress (history, posted, started_at, updated_at)
values ('${history.name}', 0, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())
on conflict (history) do nothing;`;
  return `
set statement_timeout = 0;
set lock_timeout = 0;
${claims(false)}
create table if not exists public.bench_build_progress (
  history text primary key,
  posted integer not null,
  started_at timestamptz not null,
  updated_at timestamptz not null
);
${progressSql}
create function pg_temp.post_next_bench_order(p_prefix text) returns void
language plpgsql as $$
declare
  h jsonb;
  v jsonb;
  n integer;
  v_started timestamptz;
begin
  h := app.accounting_next_work() -> 'head';
  if h is null or (h ->> 'order_id') is null then
    raise exception 'history gate failed: queue empty before the history was posted';
  end if;
  if (h ->> 'order_id') not like p_prefix || '-%'
    or (h ->> 'order_id') = p_prefix || '-late' then
    raise exception 'history gate failed: unexpected queue head %', h;
  end if;
  v := app.run_accounting_work(
    pg_catalog.gen_random_uuid(),
    1,
    h ->> 'order_id',
    (h ->> 'work_generation')::integer
  );
  if v ->> 'status' is distinct from 'processed'
    or coalesce((v ->> 'failed')::integer, 0) > 0
    or coalesce((v ->> 'applied')::integer, 0) <> 1 then
    raise exception 'history gate failed: worker returned %', v;
  end if;
  update public.bench_build_progress progress
  set posted = progress.posted + 1,
    updated_at = pg_catalog.clock_timestamp()
  where progress.history = '${history.name}'
  returning progress.posted, progress.started_at into n, v_started;
  if n % 500 = 0 then
    raise notice 'built % % elapsed %', '${history.name}', n, pg_catalog.clock_timestamp() - v_started;
  end if;
end
$$;
set statement_timeout = '6s';
${callSql}
set statement_timeout = 0;
do $$
begin
  if (
    select posted
    from public.bench_build_progress
    where history = '${history.name}'
  ) <> ${orders} then
    raise exception 'history gate failed: applied % of % orders',
      (select posted from public.bench_build_progress where history = '${history.name}'),
      ${orders};
  end if;
  if exists (
    select 1
    from app.pos_orders o
    where o.id like '${history.prefix}-%'
      and o.id <> '${history.prefix}-late'
      and not exists (
        select 1
        from app.order_cost_state s
        join app.order_cost_applications a on a.id = s.owner_application_id
        where s.order_id = o.id
          and a.receipt_kind = 'posting'
          and exists (
            select 1
            from app.order_cost_movement_links l
            join app.stock_movements m on m.id = l.movement_id
            where l.application_id = a.id
              and m.batch_id = a.posting_batch
          )
      )
  ) then
    raise exception 'history gate failed: an order has no posting receipt and movements';
  end if;
end
$$;
select 'history ${history.name} posted ${orders}';
`;
}

function lateSql(history) {
  const late = `${history.prefix}-late`;
  const shift = `${history.prefix}-shift`;
  const pos = `bench-${history.prefix}`;
  return `
begin;
set statement_timeout = 0;
set lock_timeout = 0;
${claims()}
insert into app.pos_orders (
  id, shift_id, status, order_type, ordered_at, subtotal, discount, tax,
  service_tax, delivery_fee, total, pos_update_time, content_hash, missing_from_pos
) values (
  '${late}',
  '${shift}',
  'complete',
  'hall-${history.prefix}',
  timestamptz '2026-01-01 08:00:00+00' + ${history.days} * interval '1 day',
  0, 0, 0, 0, 0, 0,
  timestamptz '2026-01-01 08:00:00+00' + ${history.days} * interval '1 day',
  rpad(md5('${late}'), 64, 'a'),
  false
);
insert into app.pos_order_lines (
  order_id, line_id, item_id, item_name, quantity, options, line_total
) values (
  '${late}', 'l1', '${pos}', 'x', 2, '[]'::jsonb, 0
);
select app.append_pos_cost_input('${late}', null, 'sync');
commit;
select '${history.name} late order queued';
`;
}

function measureSql(history) {
  const late = `${history.prefix}-late`;
  const orders = history.days * history.perDay;
  return `
begin;
set statement_timeout = 0;
set lock_timeout = 0;
${claims()}
create temp table bench_head on commit drop as
select
  app.accounting_next_work() -> 'head' as head,
  pg_catalog.gen_random_uuid() as attempt;
do $$
begin
  if (select head ->> 'order_id' from bench_head) is distinct from '${late}' then
    raise exception 'history gate failed: measured order is not the queue head (%)',
      (select head from bench_head);
  end if;
end
$$;
set statement_timeout = '6s';
create temp table bench_timed on commit drop as
select
  pg_catalog.clock_timestamp() as t0,
  app.run_accounting_work(
    (select attempt from bench_head),
    1,
    (select head ->> 'order_id' from bench_head),
    (select (head ->> 'work_generation')::integer from bench_head)
  ) as result,
  pg_catalog.clock_timestamp() as t1;
set statement_timeout = 0;
do $$
declare
  v_head jsonb := (select head from bench_head);
  v_attempt uuid := (select attempt from bench_head);
  v_result jsonb := (select result from bench_timed);
  v_seconds numeric := round(
    extract(epoch from ((select t1 from bench_timed) - (select t0 from bench_timed)))::numeric,
    3
  );
  v_events bigint;
  v_anchors bigint;
  v_weekly bigint;
  v_app bigint;
  v_outcome text;
  v_kind text;
  v_links boolean;
  v_split boolean;
  v_posted bigint;
  v_pass boolean;
  v_queue_1 numeric;
  v_queue_50000 numeric;
  v_suffix_rows bigint;
  v_suffix_index boolean;
  v_deficit_rows bigint;
  v_t0 timestamptz;
  v_plan json;
begin
  select
    (
      select count(*)
      from app.stock_movements sm
      where sm.item_id = '${history.item}'
        and sm.movement_type <> 'cost_adjustment'
        and sm.reverses_movement_id is null
        and sm.movement_type not in ('sale_reversal', 'waste_reversal')
        and not exists (
          select 1 from app.stock_movements rev
          where rev.reverses_movement_id = sm.id
        )
        and not exists (
          select 1 from app.stock_count_lines linked
          where linked.movement_id = sm.id
        )
        and not exists (
          select 1 from app.stock_count_postings posting
          where posting.movement_id = sm.id
        )
    ),
    (
      select count(*)
      from app.stock_count_anchors anchor
      where anchor.item_id = '${history.item}'
    ),
    (
      select count(*)
      from app.stock_count_anchors anchor
      where anchor.item_id = '${history.weeklyItem}'
    )
  into v_events, v_anchors, v_weekly;

  select completion.outcome, application.id, application.receipt_kind
  into v_outcome, v_app, v_kind
  from app.accounting_work_completions completion
  left join app.order_cost_applications application
    on application.id = completion.application_id
  where completion.attempt_id = v_attempt;

  with req as (
    select
      (elem.value ->> 'stock_item_id')::uuid as item_id,
      sum((elem.value ->> 'quantity')::numeric) as quantity
    from app.order_cost_applications application
    cross join lateral pg_catalog.jsonb_array_elements(application.requirements) as elem (value)
    where application.id = v_app
    group by 1
    having sum((elem.value ->> 'quantity')::numeric) <> 0
  ),
  linked as (
    select
      link.item_id,
      sum(movement.quantity) as quantity,
      bool_or(movement.batch_id is distinct from application.posting_batch) as foreign_batch
    from app.order_cost_movement_links link
    join app.stock_movements movement on movement.id = link.movement_id
    join app.order_cost_applications application on application.id = link.application_id
    where link.application_id = v_app
    group by link.item_id
  )
  select
    coalesce(
      bool_and(
        req.item_id is not null
        and linked.item_id is not null
        and req.quantity = -linked.quantity
        and not coalesce(linked.foreign_batch, true)
      ),
      false
    )
    and count(*) > 0
  into v_links
  from req
  full join linked using (item_id);

  select
    coalesce(bool_or(movement.is_provisional), false)
      and coalesce(bool_or(not movement.is_provisional), false)
  into v_split
  from app.order_cost_movement_links link
  join app.stock_movements movement on movement.id = link.movement_id
  where link.application_id = v_app;

  select count(*)
  into v_posted
  from app.pos_orders o
  where o.id like '${history.prefix}-%'
    and o.id <> '${late}'
    and exists (
      select 1
      from app.order_cost_state s
      join app.order_cost_applications a on a.id = s.owner_application_id
      where s.order_id = o.id
        and a.receipt_kind = 'posting'
        and exists (
          select 1 from app.order_cost_movement_links l
          where l.application_id = a.id
        )
    );

  v_t0 := pg_catalog.clock_timestamp();
  perform order_id from app.accounting_pending_orders(1);
  v_queue_1 := round(extract(epoch from pg_catalog.clock_timestamp() - v_t0) * 1000, 3);

  insert into app.accounting_work_queue (
    order_id, occurrence_at, has_new, eff_generation, eligible
  )
  select
    'bench-q-' || g.n::text,
    pg_catalog.clock_timestamp(),
    true,
    1,
    true
  from pg_catalog.generate_series(1, 50000) as g (n);
  v_t0 := pg_catalog.clock_timestamp();
  perform order_id from app.accounting_pending_orders(1);
  v_queue_50000 := round(extract(epoch from pg_catalog.clock_timestamp() - v_t0) * 1000, 3);
  delete from app.accounting_work_queue queue
  where queue.order_id like 'bench-q-%';

  execute
    'explain (analyze, format json) '
    || 'select sm.id from app.stock_movements sm '
    || 'where sm.item_id = ''${history.item}'' '
    || 'and sm.occurred_at > coalesce((select max(c.cut_occurred_at) from app.replay_checkpoints c where c.item_id = ''${history.item}''), ''-infinity''::timestamptz) '
    || 'union '
    || 'select sm.id from app.stock_movements sm '
    || 'where sm.item_id = ''${history.item}'' '
    || 'and sm.id > coalesce((select max(c.max_movement_id) from app.replay_checkpoints c where c.item_id = ''${history.item}''), 0)'
  into v_plan;
  v_suffix_index := v_plan::text ilike '%Index Scan%'
    or v_plan::text ilike '%Index Only Scan%'
    or v_plan::text ilike '%Bitmap%';
  v_suffix_rows := substring(v_plan::text from '"Actual Rows": ([0-9]+)')::bigint;

  execute
    'explain (analyze, format json) '
    || 'select deficit.* from app.replay_checkpoint_deficits deficit '
    || 'where deficit.checkpoint_id = (select c.id from app.replay_checkpoints c where c.item_id = ''${history.item}'' order by c.cut_occurred_at desc limit 1)'
  into v_plan;
  v_deficit_rows := coalesce(substring(v_plan::text from '"Actual Rows": ([0-9]+)')::bigint, 0);

  v_pass := v_result ->> 'status' = 'processed'
    and coalesce((v_result ->> 'failed')::integer, 0) = 0
    and v_outcome = 'applied'
    and v_kind = 'posting'
    and v_links
    and v_split
    and v_posted = ${orders}
    and v_events + v_anchors <= 100000
    and v_seconds <= 2
    and v_seconds <= 6;

  raise notice 'MEASURE %', pg_catalog.jsonb_build_object(
    'name', '${history.name}',
    'orders', ${orders},
    'days', ${history.days},
    'status', v_result ->> 'status',
    'failed', coalesce((v_result ->> 'failed')::integer, 0),
    'outcome', v_outcome,
    'receipt_kind', v_kind,
    'links_match', v_links,
    'split', v_split,
    'posted_orders', v_posted,
    'eligible_events', v_events,
    'anchors', v_anchors,
    'weekly_anchors', v_weekly,
    'events_plus_anchors', v_events + v_anchors,
    'seconds', v_seconds,
    'crossed_2s', v_seconds > 2,
    'queue_depth_1_ms', v_queue_1,
    'queue_depth_50000_ms', v_queue_50000,
    'suffix_index', v_suffix_index,
    'suffix_rows', v_suffix_rows,
    'deficit_rows', v_deficit_rows,
    'pass', v_pass
  );
end;
$$;
commit;
`;
}

function parseMeasure(stderr) {
  const match = stderr.match(/MEASURE (\{.*\})/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function formatResult(row) {
  const lines = [
    `## ${row.name}`,
    '',
    `- orders: ${row.orders}`,
    `- days: ${row.days}`,
    `- posted historical orders with a posting receipt and movements: ${row.posted_orders}`,
    `- eligible replay rows before the measured call: ${row.eligible_events}`,
    `- stock_count_anchors: ${row.anchors}`,
    `- weekly anchors: ${row.weekly_anchors}`,
    `- events plus anchors: ${row.events_plus_anchors}`,
    `- queue depth 1 ms: ${row.queue_depth_1_ms}`,
    `- queue depth 50000 ms: ${row.queue_depth_50000_ms}`,
    `- suffix index range: ${row.suffix_index}`,
    `- suffix rows: ${row.suffix_rows}`,
    `- deficit restore rows: ${row.deficit_rows}`,
    `- measured status: ${row.status}`,
    `- failed: ${row.failed}`,
    `- completion outcome: ${row.outcome}`,
    `- receipt_kind: ${row.receipt_kind}`,
    `- per-item movement links match negated requirements: ${row.links_match}`,
    `- split normal and provisional: ${row.split}`,
    `- wall clock seconds: ${row.seconds}`,
    `- crossed 2s: ${row.crossed_2s}`,
    `- gate: ${row.pass ? 'PASS' : 'FAIL'}`,
    '',
  ];
  return lines.join('\n');
}

function existingResultRows() {
  const path = join(here, 'RESULTS.md');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const parts = text.split(/^## /m).slice(1);
  return parts
    .map((part) => {
      const name = part.slice(0, part.indexOf('\n')).trim();
      const body = part.slice(part.indexOf('\n') + 1).trim();
      if (!name || body.startsWith('gate: FAIL')) return null;
      const value = (label) => {
        const match = body.match(new RegExp(`^- ${label}: (.+)$`, 'm'));
        return match ? match[1].trim() : null;
      };
      const seconds = Number(value('wall clock seconds'));
      if (!Number.isFinite(seconds)) return null;
      return {
        name,
        orders: Number(value('orders')),
        days: Number(value('days')),
        posted_orders: Number(
          value(
            'posted historical orders with a posting receipt and movements',
          ),
        ),
        eligible_events: Number(
          value('eligible replay rows before the measured call'),
        ),
        anchors: Number(value('stock_count_anchors')),
        weekly_anchors: Number(value('weekly anchors')),
        events_plus_anchors: Number(value('events plus anchors')),
        queue_depth_1_ms: Number(value('queue depth 1 ms')),
        queue_depth_50000_ms: Number(value('queue depth 50000 ms')),
        suffix_index: value('suffix index range') === 'true',
        suffix_rows: Number(value('suffix rows')),
        deficit_rows: Number(value('deficit restore rows')),
        status: value('measured status'),
        failed: Number(value('failed')),
        outcome: value('completion outcome'),
        receipt_kind: value('receipt_kind'),
        links_match:
          value('per-item movement links match negated requirements') ===
          'true',
        split: value('split normal and provisional') === 'true',
        seconds,
        crossed_2s: value('crossed 2s') === 'true',
        pass: value('gate') === 'PASS',
      };
    })
    .filter(Boolean);
}

function writeResults(rows, note) {
  const byName = new Map(existingResultRows().map((row) => [row.name, row]));
  for (const row of rows) byName.set(row.name, row);
  const order = ['35-day', '1-year', '2-year'];
  const merged = [
    ...order.filter((name) => byName.has(name)).map((name) => byName.get(name)),
    ...[...byName.values()].filter((row) => !order.includes(row.name)),
  ];
  const passed = ['35-day', '1-year', '2-year'].every(
    (name) => byName.get(name)?.pass === true,
  );
  const closing =
    note ??
    (passed ? 'The 35-day, 1-year, and 2-year histories passed the gate.' : '');
  const body = [
    '# Accounting history benchmark',
    '',
    'Synthetic catalog. Historical orders were posted with `app.run_accounting_work`. The measured order is a new queue head, timed by a top-level statement after the session statement timeout is set to 6 seconds. The soft gate is 2 seconds and the hard gate is 6 seconds. Daily fish counts and weekly counts are anchors. Checkpoints are published by the confirming walk.',
    '',
    ...merged.map((row) =>
      row.error
        ? `## ${row.name}\n\n- gate: FAIL\n- error: ${row.error}\n`
        : formatResult(row),
    ),
    closing ? `${closing}\n` : '',
  ].join('\n');
  writeFileSync(join(here, 'RESULTS.md'), body);
}

function psqlCaptured(sql) {
  const container = containerNameCached;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGCLIENTENCODING=UTF8',
        container,
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-X',
        '-q',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      err += text;
      process.stderr.write(text);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error((err || out).trim().slice(0, 2000)));
    });
    child.stdin.end(sql);
  });
}

function firstInteger(text) {
  const match = String(text).match(/\d+/);
  return match ? Number(match[0]) : Number.NaN;
}

async function postedReceipts(history) {
  const result = await psqlCaptured(
    `select count(*)::text
     from app.order_cost_state s
     join app.order_cost_applications a on a.id = s.owner_application_id
     where s.order_id like '${history.prefix}-%'
       and s.order_id <> '${history.prefix}-late'
       and a.receipt_kind = 'posting';`,
  );
  return firstInteger(result.out);
}

async function postedCount(historyName) {
  try {
    const result = await psqlCaptured(
      `select coalesce((select posted::text from public.bench_build_progress where history = '${historyName}'), 'none');`,
    );
    return result.out.trim();
  } catch {
    return 'unknown';
  }
}

async function run() {
  containerNameCached = await containerName();
  const rows = [];
  const startName =
    process.argv[2] && !process.argv[2].startsWith('--')
      ? process.argv[2]
      : null;
  const skipBuild = process.argv.includes('--skip-build') ? startName : null;
  const resume = process.argv.includes('--resume');
  let started = startName === null;
  await psqlCaptured(setupSql());
  for (const history of histories) {
    if (!started) {
      if (history.name !== startName) continue;
      started = true;
    }
    process.stderr.write(`\nbuilding ${history.name}\n`);
    try {
      if (history.name !== skipBuild) {
        if (!resume) await psqlCaptured(historySql(history));
        const already = resume ? await postedReceipts(history) : 0;
        const orders = history.days * history.perDay;
        const remaining = orders - (Number.isFinite(already) ? already : 0);
        process.stderr.write(
          `resume=${resume} already=${already} remaining=${remaining}\n`,
        );
        if (remaining > 0) {
          await psqlCaptured(
            postSql(history, {
              remaining,
              reset: !resume,
              already: resume ? already : 0,
            }),
          );
        }
        await psqlCaptured(lateSql(history));
      }
      const measured = await psqlCaptured(measureSql(history));
      const row = parseMeasure(measured.err);
      if (!row) {
        throw new Error('the measured session did not report a result');
      }
      rows.push(row);
      writeResults(rows);
      if (!row.pass) {
        writeResults(
          rows,
          'Stopped after a failing history. No checkpoint was built.',
        );
        process.exitCode = 1;
        return;
      }
    } catch (error) {
      const posted = await postedCount(history.name);
      rows.push({
        name: history.name,
        error: `posted ${posted} before failure. ${String(
          error.message ?? error,
        )
          .replace(/\s+/g, ' ')
          .slice(0, 500)}`,
      });
      writeResults(
        rows,
        'Stopped after a failing history. No checkpoint was built.',
      );
      process.exitCode = 1;
      return;
    }
  }
  writeResults(
    rows,
    'The 35-day, 1-year, and 2-year histories passed the gate.',
  );
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
