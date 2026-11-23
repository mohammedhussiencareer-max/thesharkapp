// Local history gate for one component. Synthetic catalog only.
// Historical orders are frozen activation inputs, posted by app.run_accounting_work
// one committed call at a time, and the history ends yesterday. The measured
// calls are top-level statements: a new order today, a selective deficit
// restore, a large-share deficit restore, then record_purchase today covering
// a deficit from 40 days ago. statement_timeout is set on the session before
// each measured statement. 2 seconds is soft and 6 seconds is the hard gate.
// A restore may sequence-scan replay_checkpoint_deficits. The gate is latency,
// a checkpoint cut on every measured call, a frozen prefix that is not walked,
// and shared hit+read pages below SHARED_HIT_READ_LIMIT. The suffix arms of the
// measured order must be index scans on their own.
//
// --resume continues an interrupted history build or pending late fixtures.
// It is supported only before measurement starts. Before enqueueing another
// late order or touching measurement fixtures, a committed measurement
// (selective or large-restore items, the fill item, or a posted late order)
// is refused: run `pnpm db:reset` and rerun.
//
// The sort-traversal case holds the suffix and open deficits fixed while a
// frozen mixed/size sort history grows (35-day, 1-year, 2-year, at least one
// sort per day, all behind certified cuts). The measured call is a backdated
// record_purchase on one item inside that suffix. Its gate is the whole RPC
// shared hit+read pages below SHARED_HIT_READ_LIMIT and 2 seconds. Those
// buffers must stay flat as the frozen sort history grows.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const owner = 'b9e00000-0000-4000-8000-0000000000a1';
// Shared hit + read pages on one restore. Above the last measured restores
// (the 2-year large share was 2136 including dirtied and written) and below
// a sequence scan of a multi-year deficit table.
const SHARED_HIT_READ_LIMIT = 5000;

// Cairo midnight of the run, captured once. History ends yesterday. The
// measured order and the aged-deficit purchase are today.
function openingAt(anchor, days) {
  return `timestamptz '${anchor}' - ${days} * interval '1 day' + interval '7 hours'`;
}

function originAt(anchor, days) {
  return `timestamptz '${anchor}' - ${days} * interval '1 day' + interval '8 hours'`;
}

function countAt(anchor, days) {
  return `timestamptz '${anchor}' - ${days} * interval '1 day' + interval '22 hours'`;
}

function weekAt(anchor, days) {
  return `timestamptz '${anchor}' - ${days} * interval '1 day' + interval '6 days 22 hours'`;
}

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
    agedItem: 'b9e00000-0000-4000-8000-000000000037',
    agedPriceRequest: 'b9e00000-0000-4000-8000-000000000138',
    agedPurchaseRequest: 'b9e00000-0000-4000-8000-000000000139',
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
    agedItem: 'b9e00000-0000-4000-8000-000000000367',
    agedPriceRequest: 'b9e00000-0000-4000-8000-000000000380',
    agedPurchaseRequest: 'b9e00000-0000-4000-8000-000000000381',
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
    agedItem: 'b9e00000-0000-4000-8000-000000000734',
    agedPriceRequest: 'b9e00000-0000-4000-8000-000000000740',
    agedPurchaseRequest: 'b9e00000-0000-4000-8000-000000000741',
  },
];

// Frozen mixed/size sort histories. Suffix (one later purchase) and open
// deficits stay fixed; only the certified sort prefix grows.
const sortHistories = [
  {
    name: '35-day sorts',
    prefix: 's35',
    days: 35,
    mixed: 'b9e00000-0000-4000-8000-00000000a035',
    size: 'b9e00000-0000-4000-8000-00000000a036',
    openingRequest: 'b9e00000-0000-4000-8000-00000000a135',
    activationRequest: 'b9e00000-0000-4000-8000-00000000a235',
    suffixPurchaseRequest: 'b9e00000-0000-4000-8000-00000000a335',
    purchaseRequest: 'b9e00000-0000-4000-8000-00000000a435',
  },
  {
    name: '1-year sorts',
    prefix: 's365',
    days: 365,
    mixed: 'b9e00000-0000-4000-8000-00000000a365',
    size: 'b9e00000-0000-4000-8000-00000000a366',
    openingRequest: 'b9e00000-0000-4000-8000-00000000a375',
    activationRequest: 'b9e00000-0000-4000-8000-00000000a376',
    suffixPurchaseRequest: 'b9e00000-0000-4000-8000-00000000a377',
    purchaseRequest: 'b9e00000-0000-4000-8000-00000000a378',
  },
  {
    name: '2-year sorts',
    prefix: 's730',
    days: 730,
    mixed: 'b9e00000-0000-4000-8000-00000000a730',
    size: 'b9e00000-0000-4000-8000-00000000a731',
    openingRequest: 'b9e00000-0000-4000-8000-00000000a732',
    activationRequest: 'b9e00000-0000-4000-8000-00000000a733',
    suffixPurchaseRequest: 'b9e00000-0000-4000-8000-00000000a734',
    purchaseRequest: 'b9e00000-0000-4000-8000-00000000a735',
  },
];

const SORT_OPENING_QTY = 10000;

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

function setupSql(anchor) {
  const agedSales = histories
    .map(
      (history) => `
insert into app.stock_items (id, name, kind, base_unit, count_frequency)
values ('${history.agedItem}', 'bench ${history.name} aged', 'seafood', 'kg', 'daily')
on conflict (id) do nothing;
do $$
begin
  if not exists (
    select 1
    from app.item_opening_prices price
    where price.item_id = '${history.agedItem}'
      and price.superseded_change_id is null
  ) then
    perform app.set_item_opening_price(
      '${history.agedPriceRequest}',
      '${history.agedItem}',
      10,
      null,
      null,
      'kg|seafood||'
    );
  end if;
  if not exists (
    select 1
    from app.stock_movements movement
    where movement.item_id = '${history.agedItem}'
      and movement.movement_type = 'sale'
  ) then
    -- The public purchase and movement posters close a pre-window effect.
    -- This fixture still needs the deficit on its own day, so it uses the
    -- engine outflow, and only when that sale is not already posted.
    perform app.post_engine_outflows(jsonb_build_array(jsonb_build_object(
      'item_id', '${history.agedItem}',
      'movement_type', 'sale',
      'occurred_at', timestamptz '${anchor}' - interval '40 days',
      'quantity', 1
    )));
  end if;
end
$$;`,
    )
    .join('\n');
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
insert into app.owner (user_id)
select '${owner}'
where not exists (
  select 1 from app.owner owner_row where owner_row.user_id = '${owner}'
);
${claims()}
${agedSales}
commit;
`;
}

function historySql(history, anchor) {
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
  ${openingAt(anchor, history.days)},
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
  timestamptz '${anchor}' - interval '800 days',
  '${owner}',
  '${history.activationRequest}',
  md5('${history.prefix}-manifest')
where not exists (select 1 from app.inventory_activation);
update app.accounting_rederive_spans
set completed_at = pg_catalog.clock_timestamp()
where completed_at is null;
insert into app.pos_shifts (id, opened_at, is_active, pos_update_time)
values (
  '${shift}',
  ${openingAt(anchor, history.days)},
  false,
  ${openingAt(anchor, history.days)}
);
insert into app.pos_orders (
  id, shift_id, status, order_type, ordered_at, subtotal, discount, tax,
  service_tax, delivery_fee, total, pos_update_time, content_hash, missing_from_pos
)
select
  '${history.prefix}-' || pg_catalog.lpad(g.n::text, 6, '0'),
  '${shift}',
  'complete',
  'hall-${history.prefix}',
  ${originAt(anchor, history.days)}
    + ((g.n - 1) / ${history.perDay}) * interval '1 day'
    + ((g.n - 1) % ${history.perDay}) * interval '8 minutes',
  0, 0, 0, 0, 0, 0,
  ${originAt(anchor, history.days)}
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
  and o.id not like '${late}%';
select count(app.append_pos_cost_input(o.id, null, 'sync'))
from app.pos_orders o
where o.id like '${history.prefix}-%'
  and o.id not like '${late}%';
insert into app.activation_history_input (
  order_id, bound_at, cost_input_id, ordered_at
)
select distinct on (orders.id)
  orders.id,
  pg_catalog.clock_timestamp(),
  input.id,
  orders.ordered_at
from app.pos_orders orders
join app.pos_cost_inputs input on input.order_id = orders.id
where orders.id like '${history.prefix}-%'
  and orders.id not like '${late}%'
order by orders.id, input.input_revision desc
on conflict (order_id) do nothing;
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

function dayCountSql(history, dayNumber, anchor) {
  const openingQty = history.days * history.perDay + 1;
  const actual = openingQty - dayNumber * history.perDay;
  const daily = `
with inserted as (
  insert into app.stock_counts (id, request_id, frequency, counted_at)
  values (
    pg_catalog.gen_random_uuid(),
    pg_catalog.gen_random_uuid(),
    'daily',
    ${countAt(anchor, history.days)} + ${dayNumber - 1} * interval '1 day'
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
    ${weekAt(anchor, history.days)} + ${week - 1} * interval '7 days'
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

function postCallSql(history, startAt, count, _post, anchor) {
  const openingQty = history.days * history.perDay + 1;
  return `
create function pg_temp.post_day_count(p_day integer) returns void
language plpgsql as $count$
declare
  v_count uuid;
  v_actual numeric;
begin
  v_actual := ${openingQty} - p_day * ${history.perDay};
  insert into app.stock_counts (id, request_id, frequency, counted_at)
  values (
    pg_catalog.gen_random_uuid(),
    pg_catalog.gen_random_uuid(),
    'daily',
    ${countAt(anchor, history.days)} + (p_day - 1) * interval '1 day'
  )
  returning id into v_count;
  insert into app.stock_count_lines (
    count_id, line_no, item_id, expected_base_unit,
    counted_qty, expected_qty, delta_qty, delta_value
  )
  values (v_count, 1, '${history.item}', 'kg', v_actual, v_actual, 0, 0);
  if p_day % 7 = 0 then
    insert into app.stock_counts (id, request_id, frequency, counted_at)
    values (
      pg_catalog.gen_random_uuid(),
      pg_catalog.gen_random_uuid(),
      'weekly',
      ${weekAt(anchor, history.days)} + (p_day / 7 - 1) * interval '7 days'
    )
    returning id into v_count;
    insert into app.stock_count_lines (
      count_id, line_no, item_id, expected_base_unit,
      counted_qty, expected_qty, delta_qty, delta_value
    )
    values (v_count, 1, '${history.weeklyItem}', 'kg', 0, 0, 0, 0);
  end if;
end
$count$;
create procedure pg_temp.post_bench_chunk()
language plpgsql as $chunk$
declare
  i integer;
  n integer := ${startAt};
begin
  for i in 1..${count} loop
    perform pg_temp.post_next_bench_order('${history.prefix}');
    n := n + 1;
    commit;
    if n % ${history.perDay} = 0 then
      perform pg_temp.post_day_count(n / ${history.perDay});
      commit;
    end if;
  end loop;
end
$chunk$;
call pg_temp.post_bench_chunk();
`;
}

function postSql(
  history,
  anchor,
  { remaining = null, reset = true, already = 0 } = {},
) {
  const orders = history.days * history.perDay;
  const calls = remaining ?? orders;
  const post = `select pg_temp.post_next_bench_order('${history.prefix}');`;
  // A count is written after the day it closes. Inserting every future count
  // first would put the checkpoint cut on the last anchor, and every later
  // order would fall behind that cut, so the walk could not resume.
  // One DO loop posts the chunk so the docker stdin pipe stays small.
  const startAt = reset ? 0 : already;
  const callSql = postCallSql(history, startAt, calls, post, anchor);
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
    or (h ->> 'order_id') like p_prefix || '-late%' then
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
set statement_timeout = 0;
${callSql}
do $$
begin
  if (
    select posted
    from public.bench_build_progress
    where history = '${history.name}'
  ) <> ${startAt + calls} then
    raise exception 'history gate failed: applied % of % orders',
      (select posted from public.bench_build_progress where history = '${history.name}'),
      ${startAt + calls};
  end if;
  if ${startAt + calls} = ${orders}
    and exists (
    select 1
    from app.pos_orders o
    where o.id like '${history.prefix}-%'
      and o.id not like '${history.prefix}-late%'
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
select 'history ${history.name} posted ${startAt + calls}';
`;
}

function lateSql(history, anchor) {
  const late = `${history.prefix}-late`;
  const shift = `${history.prefix}-shift`;
  const pos = `bench-${history.prefix}`;
  return `
begin;
set statement_timeout = 0;
set lock_timeout = 0;
${claims()}
create temp table late_pick (id text) on commit drop;
insert into late_pick (id)
select o.id
from app.pos_orders o
where (o.id = '${late}' or o.id like '${late}-%')
  and exists (
    select 1 from app.pos_cost_inputs input where input.order_id = o.id
  )
  and not exists (
    select 1
    from app.pos_cost_inputs input
    join app.order_cost_applications application
      on application.cost_input_id = input.id
    where input.order_id = o.id
      and application.receipt_kind = 'posting'
  )
order by o.id
limit 1;
insert into late_pick (id)
select case
  when exists (
    select 1 from app.pos_orders o where o.id = '${late}'
  ) then '${late}-' || (
    select count(*) + 1
    from app.pos_orders o
    where o.id = '${late}' or o.id like '${late}-%'
  )::text
  else '${late}'
end
where not exists (select 1 from late_pick);
insert into app.pos_orders (
  id, shift_id, status, order_type, ordered_at, subtotal, discount, tax,
  service_tax, delivery_fee, total, pos_update_time, content_hash, missing_from_pos
)
select
  pick.id,
  '${shift}',
  'complete',
  'hall-${history.prefix}',
  timestamptz '${anchor}' + interval '10 hours',
  0, 0, 0, 0, 0, 0,
  timestamptz '${anchor}' + interval '10 hours',
  rpad(md5(pick.id), 64, 'a'),
  false
from late_pick pick
where not exists (
  select 1 from app.pos_orders o where o.id = pick.id
);
insert into app.pos_order_lines (
  order_id, line_id, item_id, item_name, quantity, options, line_total
)
select pick.id, 'l1', '${pos}', 'x', 2, '[]'::jsonb, 0
from late_pick pick
where not exists (
  select 1 from app.pos_order_lines line where line.order_id = pick.id
);
select app.append_pos_cost_input(pick.id, null, 'sync')
from late_pick pick
where not exists (
  select 1 from app.pos_cost_inputs input where input.order_id = pick.id
);
commit;
select '${history.name} late order queued';
`;
}

function measurementFixturesCommittedSql(history) {
  const late = `${history.prefix}-late`;
  return `
select exists (
  select 1
  from app.stock_items item
  where item.id in (
    md5('bench-sel-${history.prefix}')::uuid,
    md5('bench-large-${history.prefix}')::uuid,
    md5('bench-fill-${history.prefix}')::uuid
  )
)
or exists (
  select 1
  from app.pos_orders o
  where (o.id = '${late}' or o.id like '${late}-%')
    and exists (
      select 1
      from app.pos_cost_inputs input
      join app.order_cost_applications application
        on application.cost_input_id = input.id
      where input.order_id = o.id
        and application.receipt_kind = 'posting'
    )
) as started;
`;
}

function resumeGuardSql(history) {
  const late = `${history.prefix}-late`;
  return `
do $$
begin
  if exists (
    select 1
    from app.stock_items item
    where item.id in (
      md5('bench-sel-${history.prefix}')::uuid,
      md5('bench-large-${history.prefix}')::uuid,
      md5('bench-fill-${history.prefix}')::uuid
    )
  )
  or exists (
    select 1
    from app.pos_orders o
    where (o.id = '${late}' or o.id like '${late}-%')
      and exists (
        select 1
        from app.pos_cost_inputs input
        join app.order_cost_applications application
          on application.cost_input_id = input.id
        where input.order_id = o.id
          and application.receipt_kind = 'posting'
      )
  ) then
    raise exception '--resume is supported only before measurement starts. A committed measurement needs pnpm db:reset and a rerun.';
  end if;
end
$$;
`;
}

function sortAt(anchor, days, dayIndex) {
  return `timestamptz '${anchor}' - ${days} * interval '1 day' + interval '12 hours' + ${dayIndex} * interval '1 day'`;
}

function sortBuildSql(history, anchor) {
  return `
begin;
set statement_timeout = 0;
set lock_timeout = 0;
${claims()}
-- Pin before any ledger write. note_change_instant locks t_change on the
-- first write; a later pin cannot move the restatement window.
select set_config(
  'app.test_clock',
  (${openingAt(anchor, history.days)})::text,
  true
);
insert into app.stock_items (id, name, kind, base_unit, count_frequency, parent_item_id)
values
  ('${history.mixed}', 'bench ${history.name} mixed', 'fish_mixed', 'kg', 'daily', null),
  ('${history.size}', 'bench ${history.name} size', 'fish_size', 'kg', 'daily', '${history.mixed}');
select app.set_item_loss(
  md5('loss|${history.prefix}')::uuid,
  '${history.mixed}',
  0,
  '2020-01-01 00:00:00+00',
  null,
  (select app.schedule_token('loss', '${history.mixed}', null)),
  'fixture'
);
select app.set_item_opening_price(
  md5('price-mixed|${history.prefix}')::uuid,
  '${history.mixed}',
  10,
  null,
  null,
  'kg|fish_mixed||'
);
select app.set_item_opening_price(
  md5('price-size|${history.prefix}')::uuid,
  '${history.size}',
  10,
  null,
  null,
  'kg|fish_size|${history.mixed}|'
);
insert into app.inventory_activation (
  stock_started_at, approved_by, request_id, opening_manifest_hash
)
select
  timestamptz '${anchor}' - interval '800 days',
  '${owner}',
  '${history.activationRequest}',
  md5('${history.prefix}-manifest')
where not exists (select 1 from app.inventory_activation);
update app.accounting_rederive_spans
set completed_at = pg_catalog.clock_timestamp()
where completed_at is null;
select app.record_opening_stock(
  ${openingAt(anchor, history.days)},
  jsonb_build_array(jsonb_build_object(
    'item_id', '${history.mixed}',
    'quantity', '${SORT_OPENING_QTY}',
    'unit', 'kg',
    'unit_cost', '10',
    'expected_base_unit', 'kg',
    'expected_factor', '1'
  )),
  '${history.openingRequest}'
);
do $$
declare
  d integer;
  v_at timestamptz;
begin
  for d in 0..${history.days - 1} loop
    v_at := ${sortAt(anchor, history.days, 0)} + d * interval '1 day';
    perform app.post_sort(
      '${history.mixed}',
      v_at,
      1,
      jsonb_build_array(jsonb_build_object(
        'item_id', '${history.size}',
        'quantity', 1
      )),
      null
    );
    if (d + 1) % 100 = 0 then
      raise notice 'built ${history.name} sorts %', d + 1;
    end if;
  end loop;
end
$$;
commit;
begin;
set statement_timeout = 0;
set lock_timeout = 0;
${claims()}
select app.replay_execute(
  array['${history.mixed}', '${history.size}']::uuid[],
  '[]'::jsonb,
  pg_catalog.gen_random_uuid(),
  true
);
select app.record_purchase(pg_catalog.jsonb_build_object(
  'purchased_at', to_char(
    (timestamptz '${anchor}' + interval '14 hours') at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ),
  'request_id', '${history.suffixPurchaseRequest}',
  'lines', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'item_id', '${history.mixed}',
    'quantity', '1',
    'unit', 'kg',
    'amount_paid', '10.00',
    'expected_base_unit', 'kg',
    'expected_factor', '1'
  ))
));
commit;
select '${history.name} frozen sorts committed ${history.days}';
`;
}

function sortMeasureSql(history, anchor) {
  return `
begin;
set statement_timeout = 0;
set lock_timeout = 0;
${claims()}
do $$
declare
  v_plan text := '';
  v_rec record;
  v_t0 timestamptz;
  v_t1 timestamptz;
  v_buffers bigint;
  v_seconds numeric;
  v_resumed boolean;
  v_sorts bigint;
  v_suffix bigint;
  v_deficits bigint;
  v_pass boolean;
  v_cut timestamptz;
  v_last_sort timestamptz;
begin
  select count(*)
  into v_sorts
  from app.stock_movements movement
  where movement.item_id = '${history.mixed}'
    and movement.movement_type = 'sort_out';

  select max(movement.occurred_at)
  into v_last_sort
  from app.stock_movements movement
  where movement.item_id = '${history.mixed}'
    and movement.movement_type = 'sort_out';

  select count(*)
  into v_suffix
  from app.stock_movements movement
  where movement.item_id = '${history.mixed}'
    and movement.occurred_at > v_last_sort
    and movement.movement_type <> 'cost_adjustment';

  select count(*)
  into v_deficits
  from app.replay_checkpoint_deficits;

  select checkpoint.cut_occurred_at
  into v_cut
  from app.replay_checkpoints checkpoint
  where checkpoint.item_id = '${history.mixed}'
    and not exists (
      select 1
      from app.replay_checkpoint_invalidations invalidation
      where invalidation.checkpoint_id = checkpoint.id
    )
    and checkpoint.cut_occurred_at < timestamptz '${anchor}' + interval '13 hours'
  order by checkpoint.cut_occurred_at desc, checkpoint.id desc
  limit 1;

  perform set_config('statement_timeout', '6s', true);
  v_t0 := pg_catalog.clock_timestamp();
  for v_rec in
    execute $ex$
      explain (analyze, buffers)
      select app.record_purchase(pg_catalog.jsonb_build_object(
        'purchased_at', to_char(
          (timestamptz '${anchor}' + interval '13 hours') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ),
        'request_id', '${history.purchaseRequest}',
        'lines', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'item_id', '${history.mixed}',
          'quantity', '1',
          'unit', 'kg',
          'amount_paid', '10.00',
          'expected_base_unit', 'kg',
          'expected_factor', '1'
        ))
      ))
    $ex$
  loop
    v_plan := v_plan || v_rec."QUERY PLAN" || chr(10);
  end loop;
  v_t1 := pg_catalog.clock_timestamp();
  perform set_config('statement_timeout', '0', true);

  v_buffers := app.replay_plan_shared_buffers(v_plan);
  v_seconds := round(extract(epoch from (v_t1 - v_t0))::numeric, 3);
  v_resumed := v_cut is not null
    and v_last_sort is not null
    and v_cut >= v_last_sort
    and v_sorts = ${history.days};

  v_pass := v_resumed
    and coalesce(v_buffers, 0) > 0
    and coalesce(v_buffers, 0) < ${SHARED_HIT_READ_LIMIT}
    and v_seconds <= 2
    and v_seconds <= 6
    and v_sorts = ${history.days};

  raise notice 'MEASURE %', pg_catalog.jsonb_build_object(
    'kind', 'sort-traversal',
    'name', '${history.name}',
    'days', ${history.days},
    'sorts', v_sorts,
    'suffix_movements', v_suffix,
    'open_deficits', v_deficits,
    'resumed', v_resumed,
    'buffer_limit', ${SHARED_HIT_READ_LIMIT},
    'buffers', coalesce(v_buffers, 0),
    'seconds', v_seconds,
    'crossed_2s', v_seconds > 2,
    'pass', v_pass
  );
end
$$;
commit;
`;
}

function measureSql(history, anchor) {
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
  if (select head ->> 'order_id' from bench_head) not like '${late}%' then
    raise exception 'history gate failed: measured order is not the queue head (%)',
      (select head from bench_head);
  end if;
end
$$;
delete from app.replay_read_probe;
select set_config('app.replay_probe', '1', true);
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
create temp table bench_fresh (payload jsonb) on commit drop;
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
  v_batch integer;
  v_queue_1 numeric;
  v_queue_50000 numeric;
  v_suffix_rows bigint;
  v_suffix_index boolean;
  v_deficit_rows bigint;
  v_time_arm_rows bigint;
  v_id_arm_rows bigint;
  v_time_arm_index boolean;
  v_id_arm_index boolean;
  v_replay_ms numeric;
  v_prefix_rows bigint;
  v_buffers bigint;
  v_detail jsonb;
  v_resumed boolean;
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
    and o.id not like '${late}%'
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

  select
    probe.time_arm_rows,
    probe.id_arm_rows,
    probe.time_arm_index,
    probe.id_arm_index,
    probe.replay_ms,
    probe.prefix_rows,
    probe.deficit_buffers,
    probe.resume_detail
  into
    v_time_arm_rows,
    v_id_arm_rows,
    v_time_arm_index,
    v_id_arm_index,
    v_replay_ms,
    v_prefix_rows,
    v_buffers,
    v_detail
  from
    app.replay_read_probe probe
  order by
    probe.id desc
  limit
    1;

  v_suffix_rows := coalesce(v_time_arm_rows, 0) + coalesce(v_id_arm_rows, 0);
  v_suffix_index := coalesce(v_time_arm_index, false)
    and coalesce(v_id_arm_index, false);
  select
    coalesce(
      bool_and(elem -> 'checkpoint_id' is distinct from 'null'::jsonb)
        and count(*) > 0,
      false
    )
  into v_resumed
  from pg_catalog.jsonb_array_elements(coalesce(v_detail, '[]'::jsonb)) as detail (elem);

  -- This probe belongs to the timed order. Later restores record their own.
  v_pass := v_result ->> 'status' = 'processed'
    and coalesce((v_result ->> 'failed')::integer, 0) = 0
    and v_outcome = 'applied'
    and v_kind = 'posting'
    and v_links
    and v_split
    and v_posted = ${orders}
    and v_events + v_anchors <= 100000
    and v_seconds <= 2
    and v_seconds <= 6
    and coalesce(v_prefix_rows, 0) = 0
    and v_suffix_index
    and v_resumed
    and coalesce(v_buffers, 0) > 0
    and coalesce(v_buffers, 0) < ${SHARED_HIT_READ_LIMIT};

  insert into bench_fresh (payload)
  values (pg_catalog.jsonb_build_object(
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
    'time_arm_rows', v_time_arm_rows,
    'id_arm_rows', v_id_arm_rows,
    'time_arm_index', v_time_arm_index,
    'id_arm_index', v_id_arm_index,
    'replay_ms', v_replay_ms,
    'prefix_rows', coalesce(v_prefix_rows, 0),
    'buffers', coalesce(v_buffers, 0),
    'resumed', v_resumed,
    'buffer_limit', ${SHARED_HIT_READ_LIMIT},
    'fresh_pass', v_pass
  ));
end;
$$;
select set_config('app.replay_probe', '', true);
set statement_timeout = 0;
do $$
declare
  v_existing bigint;
  v_need integer;
  v_left integer;
  v_item uuid := md5('bench-fill-${history.prefix}')::uuid;
begin
  v_existing := (select count(*) from app.replay_checkpoint_deficits);
  v_need := greatest(v_existing, 200)::integer;
  if v_existing < v_need then
    insert into app.stock_items (id, name, kind, base_unit, count_frequency)
    values (v_item, 'bench fill ${history.prefix}', 'seafood', 'kg', 'daily')
    on conflict (id) do nothing;
    perform app.set_item_opening_price(
      md5('bench-fill-price-${history.prefix}')::uuid,
      v_item,
      10,
      null,
      null,
      'kg|seafood||'
    );
    v_left := v_need - v_existing::integer;
    -- One confirming post publishes one checkpoint. Batches would copy the
    -- growing deficit list on every batch and the newest checkpoint would
    -- be a small share of the table.
    perform app.post_engine_outflows((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'item_id', v_item,
        'movement_type', 'sale',
        'occurred_at', timestamptz '${anchor}' + interval '14 hours',
        'quantity', 1
      ))
      from pg_catalog.generate_series(1, v_left) as g (n)
    ));
  end if;
end;
$$;
do $$
declare
  v_item uuid := md5('bench-sel-${history.prefix}')::uuid;
begin
  insert into app.stock_items (id, name, kind, base_unit, count_frequency)
  values (v_item, 'bench sel ${history.prefix}', 'seafood', 'kg', 'daily');
  perform app.set_item_opening_price(
    md5('bench-sel-price-${history.prefix}')::uuid,
    v_item, 10, null, null, 'kg|seafood||'
  );
  perform app.post_engine_outflows(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'item_id', v_item,
      'movement_type', 'sale',
      'occurred_at', timestamptz '${anchor}' + interval '14 hours',
      'quantity', 1
    )
  ));
  perform app.replay_execute(
    array[v_item], '[]'::jsonb, pg_catalog.gen_random_uuid(), true
  );
end;
$$;
delete from app.replay_read_probe;
select set_config('app.replay_probe', '1', true);
select set_config('app.bench_t0', pg_catalog.clock_timestamp()::text, true);
set statement_timeout = '6s';
select app.replay_execute(
  array[md5('bench-sel-${history.prefix}')::uuid],
  '[]'::jsonb,
  pg_catalog.gen_random_uuid(),
  true
);
set statement_timeout = 0;
select set_config('app.bench_t1', pg_catalog.clock_timestamp()::text, true);
create temp table bench_sel on commit drop as
select
  pg_catalog.current_setting('app.bench_t0')::timestamptz as t0,
  pg_catalog.current_setting('app.bench_t1')::timestamptz as t1,
  probe.prefix_rows,
  probe.deficit_rows,
  probe.deficit_buffers,
  probe.deficit_plan,
  probe.resume_detail
from app.replay_read_probe probe
order by probe.id desc
limit 1;
select set_config('app.replay_probe', '', true);
do $$
declare
  v_item uuid := md5('bench-large-${history.prefix}')::uuid;
  v_need integer;
  v_left integer;
begin
  v_need := greatest((select count(*) from app.replay_checkpoint_deficits), 200)::integer;
  insert into app.stock_items (id, name, kind, base_unit, count_frequency)
  values (v_item, 'bench large ${history.prefix}', 'seafood', 'kg', 'daily');
  perform app.set_item_opening_price(
    md5('bench-large-price-${history.prefix}')::uuid,
    v_item, 10, null, null, 'kg|seafood||'
  );
  v_left := v_need;
  perform app.post_engine_outflows((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'item_id', v_item,
      'movement_type', 'sale',
      'occurred_at', timestamptz '${anchor}' + interval '16 hours',
      'quantity', 1
    ))
    from pg_catalog.generate_series(1, v_left) as g (n)
  ));
end;
$$;
create temp table bench_large_size on commit drop as
select count(*)::bigint as table_rows from app.replay_checkpoint_deficits;
delete from app.replay_read_probe;
select set_config('app.replay_probe', '1', true);
select set_config('app.bench_t0', pg_catalog.clock_timestamp()::text, true);
set statement_timeout = '6s';
select app.replay_execute(
  array[md5('bench-large-${history.prefix}')::uuid],
  '[]'::jsonb,
  pg_catalog.gen_random_uuid(),
  true
);
set statement_timeout = 0;
select set_config('app.bench_t1', pg_catalog.clock_timestamp()::text, true);
create temp table bench_large on commit drop as
select
  pg_catalog.current_setting('app.bench_t0')::timestamptz as t0,
  pg_catalog.current_setting('app.bench_t1')::timestamptz as t1,
  probe.prefix_rows,
  probe.deficit_rows,
  probe.deficit_buffers,
  probe.deficit_plan,
  probe.resume_detail,
  (select table_rows from bench_large_size) as table_rows
from app.replay_read_probe probe
order by probe.id desc
limit 1;
select set_config('app.replay_probe', '', true);
select app.replay_execute(
  array['${history.agedItem}']::uuid[],
  '[]'::jsonb,
  pg_catalog.gen_random_uuid(),
  true
);
delete from app.replay_read_probe;
select set_config('app.replay_probe', '1', true);
set statement_timeout = '6s';
create temp table bench_aged on commit drop as
select
  pg_catalog.clock_timestamp() as t0,
  app.record_purchase(pg_catalog.jsonb_build_object(
    'purchased_at', to_char(
      (timestamptz '${anchor}' + interval '15 hours') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"Z"'
    ),
    'request_id', '${history.agedPurchaseRequest}',
    'lines', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'item_id', '${history.agedItem}',
      'quantity', '1',
      'unit', 'kg',
      'amount_paid', '10.00',
      'expected_base_unit', 'kg',
      'expected_factor', '1'
    ))
  )) as batch,
  pg_catalog.clock_timestamp() as t1;
set statement_timeout = 0;
do $$
declare
  v_fresh jsonb := (select payload from bench_fresh);
  v_seconds numeric := round(
    extract(epoch from ((select t1 from bench_aged) - (select t0 from bench_aged)))::numeric,
    3
  );
  v_sel_seconds numeric := round(
    extract(epoch from ((select t1 from bench_sel) - (select t0 from bench_sel)))::numeric,
    3
  );
  v_large_seconds numeric := round(
    extract(epoch from ((select t1 from bench_large) - (select t0 from bench_large)))::numeric,
    3
  );
  v_prefix bigint;
  v_rows bigint;
  v_buffers bigint;
  v_plan text;
  v_sel_prefix bigint;
  v_sel_rows bigint;
  v_sel_buffers bigint;
  v_sel_plan text;
  v_sel_detail jsonb;
  v_sel_resumed boolean;
  v_large_prefix bigint;
  v_large_rows bigint;
  v_large_buffers bigint;
  v_large_plan text;
  v_large_detail jsonb;
  v_large_resumed boolean;
  v_large_table bigint;
  v_detail jsonb;
  v_resumed boolean;
  v_covered boolean;
  v_suffix_ok boolean;
  v_pass boolean;
begin
  select
    probe.prefix_rows,
    probe.deficit_rows,
    probe.deficit_buffers,
    probe.deficit_plan,
    probe.resume_detail
  into v_prefix, v_rows, v_buffers, v_plan, v_detail
  from app.replay_read_probe probe
  order by probe.id desc
  limit 1;

  select prefix_rows, deficit_rows, deficit_buffers, deficit_plan, resume_detail
  into v_sel_prefix, v_sel_rows, v_sel_buffers, v_sel_plan, v_sel_detail
  from bench_sel;

  select prefix_rows, deficit_rows, deficit_buffers, deficit_plan, resume_detail, table_rows
  into v_large_prefix, v_large_rows, v_large_buffers, v_large_plan, v_large_detail, v_large_table
  from bench_large;

  select
    coalesce(
      bool_and(elem -> 'checkpoint_id' is distinct from 'null'::jsonb)
        and count(*) > 0,
      false
    )
  into v_resumed
  from pg_catalog.jsonb_array_elements(coalesce(v_detail, '[]'::jsonb)) as detail (elem);

  select
    coalesce(
      bool_and(elem -> 'checkpoint_id' is distinct from 'null'::jsonb)
        and count(*) > 0,
      false
    )
  into v_sel_resumed
  from pg_catalog.jsonb_array_elements(coalesce(v_sel_detail, '[]'::jsonb)) as detail (elem);

  select
    coalesce(
      bool_and(elem -> 'checkpoint_id' is distinct from 'null'::jsonb)
        and count(*) > 0,
      false
    )
  into v_large_resumed
  from pg_catalog.jsonb_array_elements(coalesce(v_large_detail, '[]'::jsonb)) as detail (elem);

  select coalesce(sum(deficit.qty_uncovered), 0) = 0
  into v_covered
  from app.provisional_deficits deficit
  where deficit.item_id = '${history.agedItem}';

  v_suffix_ok := coalesce((v_fresh ->> 'suffix_index')::boolean, false);

  v_pass := coalesce((v_fresh ->> 'fresh_pass')::boolean, false)
    and v_suffix_ok
    and coalesce((v_fresh ->> 'resumed')::boolean, false)
    and coalesce((v_fresh ->> 'buffers')::bigint, 0) > 0
    and coalesce((v_fresh ->> 'buffers')::bigint, 0) < ${SHARED_HIT_READ_LIMIT}
    and v_sel_seconds <= 6
    and coalesce(v_sel_prefix, 1) = 0
    and v_sel_resumed
    and coalesce(v_sel_buffers, 0) > 0
    and coalesce(v_sel_buffers, 0) < ${SHARED_HIT_READ_LIMIT}
    and coalesce(v_sel_rows, 0) between 1 and 5
    and v_large_seconds <= 6
    and coalesce(v_large_prefix, 1) = 0
    and v_large_resumed
    and coalesce(v_large_buffers, 0) > 0
    and coalesce(v_large_buffers, 0) < ${SHARED_HIT_READ_LIMIT}
    and coalesce(v_large_rows, 0) >= 200
    and coalesce(v_large_table, 0) > 0
    and v_large_rows::numeric >= 0.4 * v_large_table
    and v_large_rows::numeric <= 0.7 * v_large_table
    and v_seconds <= 6
    and coalesce(v_prefix, 1) = 0
    and v_resumed
    and coalesce(v_buffers, 0) > 0
    and coalesce(v_buffers, 0) < ${SHARED_HIT_READ_LIMIT}
    and coalesce(v_covered, false);

  raise notice 'MEASURE %', v_fresh || pg_catalog.jsonb_build_object(
    'selective_seconds', v_sel_seconds,
    'selective_crossed_2s', v_sel_seconds > 2,
    'selective_prefix_rows', v_sel_prefix,
    'selective_deficit_rows', v_sel_rows,
    'selective_buffers', v_sel_buffers,
    'selective_resumed', v_sel_resumed,
    'large_seconds', v_large_seconds,
    'large_crossed_2s', v_large_seconds > 2,
    'large_prefix_rows', v_large_prefix,
    'large_deficit_rows', v_large_rows,
    'large_buffers', v_large_buffers,
    'large_resumed', v_large_resumed,
    'large_table_rows', v_large_table,
    'aged_seconds', v_seconds,
    'aged_crossed_2s', v_seconds > 2,
    'aged_prefix_rows', v_prefix,
    'aged_deficit_rows', v_rows,
    'aged_buffers', v_buffers,
    'aged_resumed', v_resumed,
    'buffer_limit', ${SHARED_HIT_READ_LIMIT},
    'aged_covered', coalesce(v_covered, false),
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

function formatSortResult(row) {
  return [
    `## ${row.name}`,
    '',
    `- days: ${row.days}`,
    `- frozen sorts: ${row.sorts}`,
    `- suffix movements: ${row.suffix_movements}`,
    `- open deficits: ${row.open_deficits}`,
    `- resumed from checkpoint: ${row.resumed}`,
    `- shared hit+read limit: ${row.buffer_limit ?? SHARED_HIT_READ_LIMIT}`,
    `- rpc buffers: ${row.buffers}`,
    `- rpc seconds: ${row.seconds}`,
    `- crossed 2s: ${row.crossed_2s}`,
    `- gate: ${row.pass ? 'PASS' : 'FAIL'}`,
    '',
  ].join('\n');
}

function formatResult(row) {
  if (row.kind === 'sort-traversal') return formatSortResult(row);
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
    ...(row.time_arm_rows == null
      ? []
      : [
          `- time arm rows: ${row.time_arm_rows}`,
          `- id arm rows: ${row.id_arm_rows}`,
          `- time arm index: ${row.time_arm_index}`,
          `- id arm index: ${row.id_arm_index}`,
          `- confirming replay ms: ${row.replay_ms}`,
        ]),
    `- prefix rows: ${row.prefix_rows}`,
    `- resumed from checkpoint: ${row.resumed}`,
    `- shared hit+read limit: ${row.buffer_limit ?? SHARED_HIT_READ_LIMIT}`,
    `- fresh buffers: ${row.buffers}`,
    `- selective restore seconds: ${row.selective_seconds}`,
    `- selective restore crossed 2s: ${row.selective_crossed_2s}`,
    `- selective prefix rows: ${row.selective_prefix_rows}`,
    `- selective deficit rows: ${row.selective_deficit_rows}`,
    `- selective buffers: ${row.selective_buffers}`,
    `- selective resumed: ${row.selective_resumed}`,
    `- large-share restore seconds: ${row.large_seconds}`,
    `- large-share restore crossed 2s: ${row.large_crossed_2s}`,
    `- large-share prefix rows: ${row.large_prefix_rows}`,
    `- large-share deficit rows: ${row.large_deficit_rows}`,
    `- large-share buffers: ${row.large_buffers}`,
    `- large-share resumed: ${row.large_resumed}`,
    `- large-share table rows: ${row.large_table_rows}`,
    `- measured status: ${row.status}`,
    `- failed: ${row.failed}`,
    `- completion outcome: ${row.outcome}`,
    `- receipt_kind: ${row.receipt_kind}`,
    `- per-item movement links match negated requirements: ${row.links_match}`,
    `- split normal and provisional: ${row.split}`,
    `- wall clock seconds: ${row.seconds}`,
    `- crossed 2s: ${row.crossed_2s}`,
    `- aged cover seconds: ${row.aged_seconds}`,
    `- aged cover crossed 2s: ${row.aged_crossed_2s}`,
    `- aged prefix rows: ${row.aged_prefix_rows}`,
    `- aged deficit rows: ${row.aged_deficit_rows}`,
    `- aged buffers: ${row.aged_buffers}`,
    `- aged resumed: ${row.aged_resumed}`,
    `- aged deficit covered: ${row.aged_covered}`,
    `- gate: ${row.pass ? 'PASS' : 'FAIL'}`,
    '',
  ];
  return lines.join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        const match = body.match(
          new RegExp(`^- ${escapeRegExp(label)}: (.+)$`, 'm'),
        );
        return match ? match[1].trim() : null;
      };
      const maybeNumber = (label) => {
        const raw = value(label);
        if (raw == null) return undefined;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      if (value('rpc buffers') != null && value('frozen sorts') != null) {
        const seconds = Number(value('rpc seconds'));
        if (!Number.isFinite(seconds)) return null;
        return {
          kind: 'sort-traversal',
          name,
          days: Number(value('days')),
          sorts: Number(value('frozen sorts')),
          suffix_movements: Number(value('suffix movements')),
          open_deficits: Number(value('open deficits')),
          resumed: value('resumed from checkpoint') === 'true',
          buffer_limit: maybeNumber('shared hit+read limit'),
          buffers: Number(value('rpc buffers')),
          seconds,
          crossed_2s: value('crossed 2s') === 'true',
          pass: value('gate') === 'PASS',
        };
      }
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
        time_arm_rows: value('time arm rows')
          ? Number(value('time arm rows'))
          : undefined,
        id_arm_rows: value('id arm rows')
          ? Number(value('id arm rows'))
          : undefined,
        time_arm_index:
          value('time arm index') == null
            ? undefined
            : value('time arm index') === 'true',
        id_arm_index:
          value('id arm index') == null
            ? undefined
            : value('id arm index') === 'true',
        replay_ms: value('confirming replay ms')
          ? Number(value('confirming replay ms'))
          : undefined,
        deficit_rows: Number(value('deficit restore rows')),
        restore_index:
          value('deficit restore index') == null
            ? undefined
            : value('deficit restore index') === 'true',
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
        prefix_rows: Number(value('prefix rows')),
        resumed: value('resumed from checkpoint') === 'true',
        buffer_limit: maybeNumber('shared hit+read limit'),
        buffers: Number(value('fresh buffers')),
        selective_seconds: Number(value('selective restore seconds')),
        selective_crossed_2s: value('selective restore crossed 2s') === 'true',
        selective_prefix_rows: Number(value('selective prefix rows')),
        selective_deficit_rows: Number(value('selective deficit rows')),
        selective_buffers: Number(value('selective buffers')),
        selective_resumed: value('selective resumed') === 'true',
        large_seconds: Number(value('large-share restore seconds')),
        large_crossed_2s: value('large-share restore crossed 2s') === 'true',
        large_prefix_rows: Number(value('large-share prefix rows')),
        large_deficit_rows: Number(value('large-share deficit rows')),
        large_buffers: Number(value('large-share buffers')),
        large_resumed: value('large-share resumed') === 'true',
        large_table_rows: Number(value('large-share table rows')),
        aged_seconds: Number(value('aged cover seconds')),
        aged_crossed_2s: value('aged cover crossed 2s') === 'true',
        aged_prefix_rows: Number(value('aged prefix rows')),
        aged_deficit_rows: Number(value('aged deficit rows')),
        aged_buffers: Number(value('aged buffers')),
        aged_resumed: value('aged resumed') === 'true',
        aged_covered: value('aged deficit covered') === 'true',
        pass: value('gate') === 'PASS',
      };
    })
    .filter(Boolean);
}

function writeResults(rows, note) {
  const byName = new Map(existingResultRows().map((row) => [row.name, row]));
  for (const row of rows) byName.set(row.name, row);
  const order = [
    '35-day',
    '1-year',
    '2-year',
    '35-day sorts',
    '1-year sorts',
    '2-year sorts',
  ];
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
    'Synthetic catalog. Each history ends yesterday: past orders are frozen activation inputs and post on their own day. The measured order is a new order today, timed by a top-level statement after the session statement timeout is set to 6 seconds. Its probe is read before any later restore. A selective restore and a large-share restore are timed on their own, and each keeps the plan and buffers of the restore insert that ran inside that call. Every measured call must resume from a checkpoint. A sequence scan of about half the deficit table is accepted. The restore gate is latency (2 seconds soft, 6 seconds hard), shared hit plus read pages below 5000, and a frozen prefix that is not walked. The measured order suffix arms must be index scans on their own. The aged cover is record_purchase, the production purchase RPC. Daily fish counts and weekly counts are anchors. Checkpoints are published by the confirming walk. --resume is supported only before measurement starts; a committed measurement needs `pnpm db:reset` and a rerun. The sort-traversal case holds suffix and open deficits fixed while a frozen mixed/size sort history grows (35-day, 1-year, 2-year, at least one sort per day). Its gate is the whole RPC shared hit plus read pages below 5000 and 2 seconds, and those buffers must stay flat as the frozen history grows.',
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
    child.on('error', (error) => {
      reject(error);
    });
    child.stdin.on('error', (error) => {
      reject(
        new Error(
          `docker stdin ${error.code ?? error.message}: ${(err || out).trim().slice(0, 500)}`,
        ),
      );
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
       and s.order_id not like '${history.prefix}-late%'
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

async function catalogReady(history) {
  try {
    const result = await psqlCaptured(
      `select count(*)::text from app.stock_items where id = '${history.item}';`,
    );
    return firstInteger(result.out) > 0;
  } catch {
    return false;
  }
}

async function sortCatalogReady(history) {
  try {
    const result = await psqlCaptured(
      `select count(*)::text from app.stock_items where id = '${history.mixed}';`,
    );
    return firstInteger(result.out) > 0;
  } catch {
    return false;
  }
}

async function sortMeasured(history) {
  try {
    const result = await psqlCaptured(
      `select count(*)::text from app.purchases where request_id = '${history.purchaseRequest}';`,
    );
    return firstInteger(result.out) > 0;
  } catch {
    return false;
  }
}

function sortBuffersNote(rows) {
  const names = ['35-day sorts', '1-year sorts', '2-year sorts'];
  const sorts = names
    .map((name) => rows.find((row) => row.name === name))
    .filter(Boolean);
  if (sorts.length === 0) return '';
  const numbers = sorts
    .map((row) => `${row.name} ${row.buffers} buffers / ${row.seconds}s`)
    .join('; ');
  if (sorts.length < 2) {
    return `Sort-traversal RPC: ${numbers}.`;
  }
  const first = sorts[0].buffers;
  const grew = sorts.some(
    (row) =>
      Number.isFinite(row.buffers) &&
      Number.isFinite(first) &&
      row.buffers > first + 50 &&
      row.buffers > first * 1.25,
  );
  return grew
    ? `Sort-traversal RPC buffers grew with frozen history: ${numbers}. Production was not changed.`
    : `Sort-traversal RPC buffers stayed flat: ${numbers}.`;
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
  const sortOnly = process.argv.includes('--sort-only');
  let started = startName === null;
  const anchorResult = await psqlCaptured(
    `select to_char((date_trunc('day', pg_catalog.clock_timestamp() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI:SSOF');`,
  );
  const anchorMatch = anchorResult.out.match(
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}/,
  );
  if (!anchorMatch) {
    throw new Error(`no cairo anchor in ${anchorResult.out}`);
  }
  const anchor = anchorMatch[0];
  process.stderr.write(`cairo day ${anchor}\n`);
  await psqlCaptured(setupSql(anchor));
  let sortFailed = false;
  for (const history of sortHistories) {
    process.stderr.write(`\nbuilding ${history.name}\n`);
    try {
      const haveCatalog = await sortCatalogReady(history);
      if (!haveCatalog) await psqlCaptured(sortBuildSql(history, anchor));
      if (await sortMeasured(history)) {
        process.stderr.write(`skip ${history.name}: already measured\n`);
        continue;
      }
      const measured = await psqlCaptured(sortMeasureSql(history, anchor));
      const row = parseMeasure(measured.err);
      if (!row) {
        throw new Error('the sort session did not report a result');
      }
      rows.push(row);
      writeResults(rows);
      process.stderr.write(
        `${history.name} buffers=${row.buffers} seconds=${row.seconds} resumed=${row.resumed} pass=${row.pass}\n`,
      );
      if (!row.pass) sortFailed = true;
    } catch (error) {
      sortFailed = true;
      rows.push({
        name: history.name,
        kind: 'sort-traversal',
        error: String(error.message ?? error)
          .replace(/\s+/g, ' ')
          .slice(0, 500),
      });
      writeResults(rows);
      process.stderr.write(`${history.name} failed: ${error.message}\n`);
    }
  }
  if (sortOnly) {
    const sortNote = sortBuffersNote(rows);
    writeResults(
      rows,
      [
        '--resume is supported only before measurement starts. A committed measurement needs pnpm db:reset and a rerun.',
        sortNote,
      ]
        .filter(Boolean)
        .join(' '),
    );
    if (sortFailed) process.exitCode = 1;
    return;
  }
  for (const history of histories) {
    if (!started) {
      if (history.name !== startName) continue;
      started = true;
    }
    process.stderr.write(`\nbuilding ${history.name}\n`);
    try {
      if (history.name !== skipBuild) {
        const haveCatalog = resume && (await catalogReady(history));
        if (!haveCatalog) await psqlCaptured(historySql(history, anchor));
        const already = haveCatalog ? await postedReceipts(history) : 0;
        const orders = history.days * history.perDay;
        const remaining = orders - (Number.isFinite(already) ? already : 0);
        process.stderr.write(
          `resume=${resume} already=${already} remaining=${remaining}\n`,
        );
        if (remaining > 0) {
          // One CALL posts the remaining orders and commits each one.
          // A 36,500-statement stdin pipe has killed Docker Desktop.
          await psqlCaptured(
            postSql(history, anchor, {
              remaining,
              reset: !haveCatalog,
              already: Number.isFinite(already) ? already : 0,
            }),
          );
        }
        if (resume) await psqlCaptured(resumeGuardSql(history));
        await psqlCaptured(lateSql(history, anchor));
      }
      const measured = await psqlCaptured(measureSql(history, anchor));
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
  const sortNote = sortBuffersNote(rows);
  const closing = [
    'The 35-day, 1-year, and 2-year histories passed the gate.',
    '--resume is supported only before measurement starts. A committed measurement needs pnpm db:reset and a rerun.',
    sortNote,
  ]
    .filter(Boolean)
    .join(' ');
  writeResults(rows, closing);
  if (sortFailed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  setupSql,
  histories,
  lateSql,
  resumeGuardSql,
  measurementFixturesCommittedSql,
};
