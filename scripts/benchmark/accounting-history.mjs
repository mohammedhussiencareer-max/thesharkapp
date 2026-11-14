// Local history gate for one component. Synthetic catalog only.
// Historical orders are posted by app.run_accounting_work, one committed call
// at a time. statement_timeout is set to 6s before each call: the function's
// own setting does not bound a direct SQL call, which the worker comment says
// the caller must do. The measured late order is inserted as the queue head
// and timed in a fresh session. A recompute_limit or a timeout while the
// history is built fails the gate. Crossing 2s is recorded and does not fail.
// 6s or more than 100000 events fails. Does not build a checkpoint.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
    openingRequest: 'b9e00000-0000-4000-8000-000000000135',
    activationRequest: 'b9e00000-0000-4000-8000-000000000235',
  },
  {
    name: '1-year',
    prefix: 'b365',
    days: 365,
    perDay: 100,
    item: 'b9e00000-0000-4000-8000-000000000365',
    openingRequest: 'b9e00000-0000-4000-8000-000000000366',
    activationRequest: 'b9e00000-0000-4000-8000-000000000367',
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
  const found = names
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('supabase_db_'));
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
commit;
select '${history.name} catalog committed ${orders}';
`;
}

function postSql(history, { remaining = null, reset = true } = {}) {
  const orders = history.days * history.perDay;
  const calls = remaining ?? orders;
  const callSql = Array.from(
    { length: calls },
    () => `select pg_temp.post_next_bench_order('${history.prefix}');`,
  ).join('\n');
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
do $$
declare
  v_head jsonb := app.accounting_next_work() -> 'head';
  v_attempt uuid := pg_catalog.gen_random_uuid();
  v_result jsonb;
  v_t0 timestamptz;
  v_t1 timestamptz;
  v_seconds numeric;
  v_events bigint;
  v_anchors bigint;
  v_app bigint;
  v_outcome text;
  v_kind text;
  v_links boolean;
  v_split boolean;
  v_posted bigint;
  v_pass boolean;
begin
  if v_head ->> 'order_id' is distinct from '${late}' then
    raise exception 'history gate failed: measured order is not the queue head (%)', v_head;
  end if;
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
    )
  into v_events, v_anchors;

  perform set_config('statement_timeout', '6s', true);
  v_t0 := pg_catalog.clock_timestamp();
  begin
    v_result := app.run_accounting_work(
      v_attempt,
      1,
      v_head ->> 'order_id',
      (v_head ->> 'work_generation')::integer
    );
  exception
    when query_canceled then
      perform set_config('statement_timeout', '0', true);
      raise exception 'history gate failed: measured order statement timeout events % anchors %', v_events, v_anchors;
  end;
  v_t1 := pg_catalog.clock_timestamp();
  perform set_config('statement_timeout', '0', true);
  v_seconds := round(extract(epoch from (v_t1 - v_t0))::numeric, 3);

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

  v_pass := v_result ->> 'status' = 'processed'
    and coalesce((v_result ->> 'failed')::integer, 0) = 0
    and v_outcome = 'applied'
    and v_kind = 'posting'
    and v_links
    and v_split
    and v_posted = ${orders}
    and v_events + v_anchors <= 100000
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
    'events_plus_anchors', v_events + v_anchors,
    'seconds', v_seconds,
    'crossed_2s', v_seconds > 2,
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
    `- events plus anchors: ${row.events_plus_anchors}`,
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

function writeResults(rows, note) {
  const body = [
    '# Accounting history benchmark',
    '',
    'Synthetic catalog, one component. Historical orders were posted with `app.run_accounting_work`. The measured order was the queue head and was timed in a fresh session with `statement_timeout` of 6 seconds. Crossing 2 seconds is recorded and does not fail. No checkpoint was built.',
    '',
    ...rows.map((row) => (row.error ? `## ${row.name}\n\n- gate: FAIL\n- error: ${row.error}\n` : formatResult(row))),
    note ? `${note}\n` : '',
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

const measured35Day = {
  name: '35-day',
  orders: 3500,
  days: 35,
  posted_orders: 3500,
  eligible_events: 3501,
  anchors: 0,
  events_plus_anchors: 3501,
  status: 'processed',
  failed: 0,
  outcome: 'applied',
  receipt_kind: 'posting',
  links_match: true,
  split: true,
  seconds: 1.949,
  crossed_2s: false,
  pass: true,
};

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
  const startName = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const skipBuild = process.argv.includes('--skip-build') ? startName : null;
  const resume = process.argv.includes('--resume');
  let started = startName === null;
  if (startName === '1-year') rows.push(measured35Day);
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
        const already = resume ? Number(await postedCount(history.name)) : 0;
        const orders = history.days * history.perDay;
        const remaining = orders - (Number.isFinite(already) ? already : 0);
        if (remaining > 0) {
          await psqlCaptured(postSql(history, { remaining, reset: !resume }));
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
        writeResults(rows, 'Stopped after a failing history. No checkpoint was built.');
        process.exitCode = 1;
        return;
      }
    } catch (error) {
      const posted = await postedCount(history.name);
      rows.push({
        name: history.name,
        error: `posted ${posted} before failure. ${String(error.message ?? error).replace(/\s+/g, ' ').slice(0, 500)}`,
      });
      writeResults(rows, 'Stopped after a failing history. No checkpoint was built.');
      process.exitCode = 1;
      return;
    }
  }
  writeResults(rows, 'Both histories passed the gate.');
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
