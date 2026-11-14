// Two real sessions against the local database. No session-level advisory lock
// is used as a stand-in. Each holder sleeps inside the open transaction so the
// waiter has to block on the real function's lock. Synthetic ids only.

import { spawn } from 'node:child_process';

const owner = 'c9e00000-0000-4000-8000-0000000000a1';
const itemA = 'c9e00000-0000-4000-8000-000000000001';
const itemB = 'c9e00000-0000-4000-8000-000000000002';
const itemC = 'c9e00000-0000-4000-8000-000000000003';
const holdMs = 1.2;
const minWaitMs = 700;

function claims() {
  return `select set_config('request.jwt.claims', jsonb_build_object('sub', '${owner}', 'role', 'authenticated')::text, true);`;
}

function dockerText(args, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => {
      const text = `${out}\n${err}`.trim();
      if (code === 0) resolve(text);
      else reject(new Error(text.slice(0, 1500)));
    });
    if (sql !== undefined) child.stdin.end(sql);
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
  if (!found)
    throw new Error('the local supabase database container is not running');
  return found;
}

let container = '';

function psql(sql) {
  const started = Date.now();
  return dockerText(
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
      '-A',
      '-t',
    ],
    sql,
  ).then(
    (out) => ({ ok: true, out, ms: Date.now() - started }),
    (error) => ({ ok: false, out: error.message, ms: Date.now() - started }),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function race(holderSql, waiterSql) {
  const holder = psql(holderSql);
  await sleep(300);
  const waiter = await psql(waiterSql);
  return { holder: await holder, waiter };
}

async function raceTwo(holderSql, waiterSql, secondSql, thirdSql) {
  const holder = psql(holderSql);
  await sleep(300);
  const waiter = psql(waiterSql);
  const second = psql(secondSql);
  const third = thirdSql ? psql(thirdSql) : null;
  return {
    holder: await holder,
    waiter: await waiter,
    second: await second,
    third: third ? await third : null,
  };
}

function line(result) {
  const state = result.ok ? 'ok' : 'error';
  return `${state} ${result.ms}ms ${result.out.replace(/\s+/g, ' ').slice(0, 400)}`;
}

const report = [];

function add(
  name,
  holder,
  waiter,
  note,
  expectHolder,
  expectWaiter,
  requireBlock = true,
) {
  const blocked = waiter.ms >= minWaitMs;
  const holderExpected = Array.isArray(expectHolder)
    ? expectHolder
    : [expectHolder];
  const holderOk =
    expectHolder == null
      ? holder.ok
      : holderExpected.some((part) => holder.out.includes(part));
  const expected = Array.isArray(expectWaiter) ? expectWaiter : [expectWaiter];
  const waiterOk =
    expectWaiter == null
      ? waiter.ok
      : expected.some((part) => waiter.out.includes(part));
  report.push({
    name,
    blocked: requireBlock ? blocked : true,
    holderOk,
    waiterOk,
    note,
    holder: line(holder),
    waiter: line(waiter),
  });
  process.stdout.write(
    `\n${name}\n  blocked: ${blocked}\n  block required: ${requireBlock}\n  holder outcome: ${holderOk}\n  waiter outcome: ${waiterOk}\n  ${note}\n  holder: ${line(holder)}\n  waiter: ${line(waiter)}\n`,
  );
}

async function execOk(sql) {
  const result = await psql(sql);
  if (!result.ok) throw new Error(result.out);
  return result.out;
}

function shiftJson(stamp) {
  return JSON.stringify({
    id: 'race-shift',
    opened_at: '2026-08-02T08:00:00Z',
    closed_at: '2026-08-02T20:00:00Z',
    is_active: false,
    pos_update_time: stamp,
    transactions: [],
  }).replaceAll("'", "''");
}

function movementSql(type, at) {
  const cost = type === 'purchase' ? `, 'unit_cost', 10` : '';
  return `select app.post_movements(jsonb_build_array(jsonb_build_object(
    'item_id', '${itemA}',
    'movement_type', '${type}',
    'occurred_at', '${at}',
    'quantity', 1${cost}
  )));`;
}

function countPayload(requestId, qty, countedAt) {
  return `jsonb_build_object(
    'request_id', '${requestId}',
    'frequency', 'daily',
    'counted_at', '${countedAt}',
    'lines', jsonb_build_array(jsonb_build_object(
      'item_id', '${itemA}',
      'counted_qty', '${qty}',
      'expected_base_unit', 'kg'
    ))
  )`;
}

function workerSql(orderId, generation, sleep) {
  const args =
    orderId === null
      ? 'gen_random_uuid(), 1'
      : `gen_random_uuid(), 1, '${orderId}', ${generation}`;
  return `
\\set VERBOSITY verbose
begin;
${claims()}
select app.run_accounting_work(${args});
${sleep ? `select pg_sleep(${holdMs});` : ''}
commit;
`;
}

function lossSql(requestId, pct, at, sleep) {
  return `
\\set VERBOSITY verbose
begin;
${claims()}
select app.set_item_loss(
  '${requestId}'::uuid,
  '${itemA}'::uuid,
  ${pct},
  '${at}'::timestamptz,
  null,
  (select app.schedule_token('loss', '${itemA}'::uuid, null)),
  'fixture'
);
${sleep ? `select pg_sleep(${holdMs});` : ''}
commit;
`;
}

async function head() {
  const line = (
    await execOk(`
begin;
${claims()}
select coalesce(app.accounting_next_work() -> 'head' ->> 'order_id', '')
  || '|' ||
  coalesce(app.accounting_next_work() -> 'head' ->> 'work_generation', '');
commit;
`)
  )
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.includes('|'));
  if (!line) throw new Error('the worker queue has no head');
  const [orderId, generation] = line.split('|');
  return { orderId, generation };
}

async function orderFacts(orderId) {
  const row = (
    await execOk(`
select
  (select count(*) from app.accounting_work_events e
    where e.order_id = '${orderId}' and e.processed_at is null)::text
  || '|' ||
  (select count(*) from app.order_cost_state s
    join app.order_cost_applications a on a.id = s.owner_application_id
    where s.order_id = '${orderId}' and a.receipt_kind = 'posting')::text
  || '|' ||
  (select coalesce(failed_at::text, '') from app.accounting_work_state
    where order_id = '${orderId}');
`)
  ).trim();
  const [openEvents, receipts, failedAt] = row.split('|');
  return { openEvents, receipts, failedAt };
}

async function drain() {
  await execOk(`
begin;
${claims()}
do $drain$
declare
  h jsonb;
  v jsonb;
  n integer := 0;
begin
  loop
    h := app.accounting_next_work() -> 'head';
    exit when h is null or coalesce(h ->> 'order_id', '') = '';
    v := app.run_accounting_work(
      gen_random_uuid(),
      1,
      h ->> 'order_id',
      (h ->> 'work_generation')::integer
    );
    n := n + 1;
    if coalesce((v ->> 'failed')::integer, 0) > 0 then
      raise exception 'worker failed %', v;
    end if;
    exit when v ->> 'status' is distinct from 'processed' or n >= 40;
  end loop;
end
$drain$;
commit;
`);
}

async function checkLedger(
  tag,
  orderId,
  requireReceipt = true,
  settle = false,
) {
  const row = (
    await execOk(`
select
  (select on_hand_qty from app.item_balances where item_id = '${itemA}')::text
  || '|' ||
  (select coalesce(sum(quantity), 0) from app.stock_movements where item_id = '${itemA}')::text;
`)
  ).trim();
  const [onHand, summed] = row.split('|');
  const order = orderId ? await orderFacts(orderId) : null;
  process.stdout.write(
    `\n${tag} ledger on_hand=${onHand} movements=${summed}${
      order
        ? ` open_events=${order.openEvents} posting_receipts=${order.receipts} failed=${order.failedAt || 'no'}`
        : ''
    }\n`,
  );
  if (onHand !== summed) {
    throw new Error(`${tag}: balance ${onHand} != movements ${summed}`);
  }
  if (order && order.failedAt) {
    throw new Error(`${tag}: ${orderId} failed at ${order.failedAt}`);
  }
  if (order && settle && order.openEvents !== '0') {
    throw new Error(
      `${tag}: ${orderId} still has ${order.openEvents} open events`,
    );
  }
  if (order && requireReceipt && order.receipts === '0') {
    throw new Error(`${tag}: ${orderId} has no posting receipt`);
  }
}

async function main() {
  container = await containerName();
  await execOk(`
\\set VERBOSITY verbose
begin;
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000', '${owner}',
  'authenticated', 'authenticated', 'owner-race@theshark.test', '',
  '2026-01-01 00:00:00+00', '', '', '', ''
) on conflict (id) do nothing;
insert into app.owner (user_id) values ('${owner}') on conflict (user_id) do nothing;
create or replace function app.accounting_scaling_ready() returns boolean
language sql stable security definer set search_path = '' as $$ select true; $$;
${claims()}
insert into app.stock_items (id, name, kind, base_unit, count_frequency)
values ('${itemA}', 'race fish a', 'seafood', 'kg', 'daily');
select app.record_opening_stock(
  '2026-08-01 08:00:00+00',
  jsonb_build_array(jsonb_build_object(
    'item_id', '${itemA}', 'quantity', '20', 'unit', 'kg',
    'unit_cost', '10', 'expected_base_unit', 'kg', 'expected_factor', '1'
  )),
  'c9e00000-0000-4000-8000-000000000101'
);
commit;
`);
  const tokenA = (await execOk(`select app.opening_manifest_token();`)).trim();

  const insertHolds = await race(
    `
\\set VERBOSITY verbose
begin;
insert into app.stock_items (id, name, kind, base_unit, count_frequency)
values ('${itemB}', 'race fish b', 'seafood', 'kg', 'daily');
select pg_sleep(${holdMs});
commit;
`,
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.activate_inventory(
  'c9e00000-0000-4000-8000-000000000011',
  '${tokenA}',
  '{}'::uuid[]
);
commit;
`,
  );
  add(
    'catalog insert holds, activate waits',
    insertHolds.holder,
    insertHolds.waiter,
    'activate should wait, then refuse the stale token with 40001',
    null,
    'opening manifest changed',
  );

  await execOk(`
begin;
${claims()}
select app.record_opening_stock(
  '2026-08-01 09:00:00+00',
  jsonb_build_array(jsonb_build_object(
    'item_id', '${itemB}', 'quantity', '5', 'unit', 'kg',
    'unit_cost', '10', 'expected_base_unit', 'kg', 'expected_factor', '1'
  )),
  'c9e00000-0000-4000-8000-000000000102'
);
commit;
`);
  const tokenAB = (await execOk(`select app.opening_manifest_token();`)).trim();

  const activateHolds = await raceTwo(
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.activate_inventory(
  'c9e00000-0000-4000-8000-000000000012',
  '${tokenAB}',
  '{}'::uuid[]
);
select pg_sleep(${holdMs});
commit;
`,
    `
\\set VERBOSITY verbose
begin;
insert into app.stock_items (id, name, kind, base_unit, count_frequency)
values ('${itemC}', 'race fish c', 'seafood', 'kg', 'daily');
commit;
`,
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`,
    `
\\set VERBOSITY verbose
begin;
${claims()}
${movementSql('sale', '2026-08-02 08:00:00+00')}
commit;
`,
  );
  add(
    'activate holds, catalog insert waits',
    activateHolds.holder,
    activateHolds.waiter,
    'the insert should wait, then commit after activation',
    '"activated": true',
    null,
  );
  add(
    'activate holds, sync start waits',
    activateHolds.holder,
    activateHolds.second,
    'the sync should wait for SHARE on pos_sync_runs, then finish',
    '"activated": true',
    null,
  );
  add(
    'activate holds, sale waits',
    activateHolds.holder,
    activateHolds.third,
    'the sale waits for the ledger lock, then activation commits and the sale is refused',
    '"activated": true',
    'disallowed movement_type in post_movements: sale',
  );

  const purchaseHolds = await race(
    `
\\set VERBOSITY verbose
begin;
${claims()}
${movementSql('purchase', '2026-08-02 09:00:00+00')}
select pg_sleep(${holdMs});
commit;
`,
    `
\\set VERBOSITY verbose
begin;
${claims()}
${movementSql('sale', '2026-08-02 10:00:00+00')}
commit;
`,
  );
  add(
    'purchase holds, sale waits',
    purchaseHolds.holder,
    purchaseHolds.waiter,
    'the sale waits on another ledger write after activation has committed, then is refused',
    null,
    'disallowed movement_type in post_movements: sale',
  );
  const sales = (
    await execOk(
      `select count(*) from app.stock_movements where item_id = '${itemA}' and movement_type = 'sale';`,
    )
  ).trim();
  if (sales !== '0') throw new Error(`a public sale was stored: ${sales}`);

  const tokenNow = (
    await execOk(`select app.opening_manifest_token();`)
  ).trim();

  const syncHolds = await race(
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select pg_sleep(${holdMs});
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`,
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.activate_inventory(
  'c9e00000-0000-4000-8000-000000000014',
  '${tokenNow}',
  '{}'::uuid[]
);
commit;
`,
  );
  add(
    'sync holds, activate waits',
    syncHolds.holder,
    syncHolds.waiter,
    'activate should wait on SHARE, then refuse because inventory is already activated',
    null,
    'inventory is already activated',
  );

  await execOk(`
begin;
${claims()}
insert into app.pos_shifts (id, opened_at, closed_at, is_active, pos_update_time)
values (
  'race-shift',
  '2026-08-02 08:00:00+00',
  '2026-08-02 20:00:00+00',
  false,
  '2026-08-02 20:00:00+00'
);
select app.record_count(${countPayload('c9e00000-0000-4000-8000-000000000021', '19', '2026-08-03T10:00:00Z')});
commit;
`);
  await execOk(`
\\set VERBOSITY verbose
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array('${shiftJson('2026-08-02T21:00:00Z')}'::jsonb),
  '[]'::jsonb,
  '{"shift_ids":["race-shift"]}'::jsonb
);
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`);

  const countHolds = await race(
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.record_count(${countPayload('c9e00000-0000-4000-8000-000000000021', '19', '2026-08-03T10:00:00Z')});
select pg_sleep(${holdMs});
commit;
`,
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array('${shiftJson('2026-08-02T22:00:00Z')}'::jsonb),
  '[]'::jsonb,
  '{"shift_ids":["race-shift"]}'::jsonb
);
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`,
  );
  add(
    'record_count posting holds, ingest waits',
    countHolds.holder,
    countHolds.waiter,
    'the posting call holds SHARE on pos_shifts; ingest should wait, then finish',
    '"status": "posted"',
    '"shifts_upserted": 1',
  );

  await execOk(`
begin;
${claims()}
select app.record_count(${countPayload('c9e00000-0000-4000-8000-000000000022', '18', '2026-08-04T10:00:00Z')});
commit;
`);
  await execOk(`
\\set VERBOSITY verbose
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array('${shiftJson('2026-08-02T23:00:00Z')}'::jsonb),
  '[]'::jsonb,
  '{"shift_ids":["race-shift"]}'::jsonb
);
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`);

  const ingestHolds = await race(
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array('${shiftJson('2026-08-02T23:30:00Z')}'::jsonb),
  '[]'::jsonb,
  '{"shift_ids":["race-shift"]}'::jsonb
);
select pg_sleep(${holdMs});
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`,
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.record_count(${countPayload('c9e00000-0000-4000-8000-000000000022', '18', '2026-08-04T10:00:00Z')});
commit;
`,
  );
  add(
    'ingest holds, record_count posting waits',
    ingestHolds.holder,
    ingestHolds.waiter,
    'record_count should wait on SHARE, then post the non-zero count',
    '"shifts_upserted": 1',
    '"status": "posted"',
  );

  await execOk(`
begin;
${claims()}
select app.set_item_loss(
  'c9e00000-0000-4000-8000-000000000201'::uuid,
  '${itemA}'::uuid,
  0,
  '2020-01-01 00:00:00+00',
  null,
  (select app.schedule_token('loss', '${itemA}'::uuid, null)),
  'fixture'
);
select app.set_pos_option_policy(
  md5('opt|race-pos')::uuid, 'race-pos', '["none"]'::jsonb,
  '2020-01-01 00:00:00+00', null, 'none_expected',
  (select app.pos_base_schedule('race-pos', '["none"]'::jsonb) ->> 'token'),
  'fixture'
);
select app.set_base_packaging(
  md5('bpk|race-pos')::uuid, 'race-pos', '["none"]'::jsonb,
  '2020-01-01 00:00:00+00', null, '{"none": true}'::jsonb,
  (select app.packaging_base_schedule('race-pos', '["none"]'::jsonb) ->> 'token'),
  'fixture'
);
select app.set_pos_base_mapping(
  md5('map|race-pos')::uuid, 'race-pos', '["none"]'::jsonb,
  '2020-01-01 00:00:00+00', null,
  jsonb_build_object('stock_item_id', '${itemA}', 'quantity_per_basis', '1', 'unit', 'kg'),
  (select app.pos_base_schedule('race-pos', '["none"]'::jsonb) ->> 'token'),
  'fixture'
);
select app.set_order_type_packaging(
  md5('ot|race')::uuid, 'hall-race', '2020-01-01 00:00:00+00', null,
  '{"none": true}'::jsonb,
  (select app.packaging_order_type_schedule('hall-race') ->> 'token'),
  'fixture'
);
update app.accounting_rederive_spans
set completed_at = pg_catalog.clock_timestamp()
where completed_at is null;
insert into app.pos_shifts (id, opened_at, closed_at, is_active, pos_update_time)
values (
  'race-w-shift',
  '2026-08-10 08:00:00+00',
  '2026-08-10 20:00:00+00',
  false,
  '2026-08-10 20:00:00+00'
);
insert into app.pos_orders (
  id, shift_id, status, order_type, ordered_at, subtotal, discount, tax,
  service_tax, delivery_fee, total, pos_update_time, content_hash, missing_from_pos
) values
  ('race-w1', 'race-w-shift', 'complete', 'hall-race', '2026-08-10 10:00:00+00', 0, 0, 0, 0, 0, 0, '2026-08-10 10:00:00+00', rpad(md5('race-w1'), 64, 'a'), false),
  ('race-w2', 'race-w-shift', 'complete', 'hall-race', '2026-08-10 11:00:00+00', 0, 0, 0, 0, 0, 0, '2026-08-10 11:00:00+00', rpad(md5('race-w2'), 64, 'a'), false),
  ('race-d1', 'race-w-shift', 'canceled', 'hall-race', '2026-08-10 12:00:00+00', 0, 0, 0, 0, 0, 0, '2026-08-10 12:00:00+00', rpad(md5('race-d1'), 64, 'c'), false);
insert into app.pos_order_lines (
  order_id, line_id, item_id, item_name, quantity, options, line_total
) values
  ('race-w1', 'l1', 'race-pos', 'x', 1, '[]'::jsonb, 0),
  ('race-w2', 'l1', 'race-pos', 'x', 1, '[]'::jsonb, 0),
  ('race-d1', 'l1', 'race-pos', 'x', 1, '[]'::jsonb, 0);
select app.append_pos_cost_input('race-w1', null, 'sync');
select app.append_pos_cost_input('race-w2', null, 'sync');
select app.append_pos_cost_input('race-d1', null, 'sync');
commit;
`);

  const firstHead = await head();
  if (firstHead.orderId !== 'race-w1') {
    throw new Error(`expected race-w1 at the head, got ${firstHead.orderId}`);
  }
  const workerHoldsIngest = await race(
    workerSql(firstHead.orderId, firstHead.generation, true),
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array('${JSON.stringify({
    id: 'race-w-shift',
    opened_at: '2026-08-10T08:00:00Z',
    closed_at: '2026-08-10T20:00:00Z',
    is_active: false,
    pos_update_time: '2026-08-10T21:00:00Z',
    transactions: [],
  }).replaceAll("'", "''")}'::jsonb),
  '[]'::jsonb,
  '{"shift_ids":["race-w-shift"]}'::jsonb
);
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`,
  );
  add(
    'worker holds, ingest waits',
    workerHoldsIngest.holder,
    workerHoldsIngest.waiter,
    'ingest waits for the worker lock, then finishes',
    '"status": "processed"',
    '"shifts_upserted": 1',
  );
  await checkLedger('worker holds, ingest waits', 'race-w1');

  const secondHead = await head();
  if (!secondHead.orderId || !secondHead.generation) {
    throw new Error(
      `the reverse worker race has no queued order: ${secondHead.orderId}`,
    );
  }
  const ingestHoldsWorker = await race(
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array('${JSON.stringify({
    id: 'race-w-shift',
    opened_at: '2026-08-10T08:00:00Z',
    closed_at: '2026-08-10T20:00:00Z',
    is_active: false,
    pos_update_time: '2026-08-10T22:00:00Z',
    transactions: [],
  }).replaceAll("'", "''")}'::jsonb),
  '[]'::jsonb,
  '{"shift_ids":["race-w-shift"]}'::jsonb
);
select pg_sleep(${holdMs});
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`,
    workerSql(secondHead.orderId, secondHead.generation, false),
  );
  add(
    'ingest holds, worker waits',
    ingestHoldsWorker.holder,
    ingestHoldsWorker.waiter,
    'the worker does not wait out the lock; it returns busy or sync_running',
    '"shifts_upserted": 1',
    ['"status": "busy"', '"status": "sync_running"'],
    false,
  );
  if (!ingestHoldsWorker.waiter.ok) {
    await execOk(workerSql(secondHead.orderId, secondHead.generation, false));
  }
  await checkLedger('ingest holds, worker waits', secondHead.orderId);

  await execOk(`
begin;
${claims()}
select app.record_count(${countPayload('c9e00000-0000-4000-8000-000000000023', '16', '2026-08-11T10:00:00Z')});
commit;
`);
  await execOk(`
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array(
    '${shiftJson('2026-08-11T11:00:00Z')}'::jsonb,
    '${JSON.stringify({
      id: 'race-w-shift',
      opened_at: '2026-08-10T08:00:00Z',
      closed_at: '2026-08-10T20:00:00Z',
      is_active: false,
      pos_update_time: '2026-08-11T11:00:00Z',
      transactions: [],
    }).replaceAll("'", "''")}'::jsonb
  ),
  '[]'::jsonb,
  '{"shift_ids":["race-shift","race-w-shift"]}'::jsonb
);
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`);
  const workerHoldsCount = await race(
    workerSql(null, null, true),
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.record_count(${countPayload('c9e00000-0000-4000-8000-000000000023', '16', '2026-08-11T10:00:00Z')});
commit;
`,
  );
  add(
    'worker holds, record_count posting waits',
    workerHoldsCount.holder,
    workerHoldsCount.waiter,
    'the posting count waits for the worker lock, then posts',
    ['"status": "processed"', '"status": "empty"'],
    '"status": "posted"',
  );
  await checkLedger('worker holds, record_count posting waits');

  await execOk(`
begin;
${claims()}
select app.record_count(${countPayload('c9e00000-0000-4000-8000-000000000024', '15', '2026-08-12T10:00:00Z')});
commit;
`);
  await execOk(`
begin;
${claims()}
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array(
    '${shiftJson('2026-08-12T11:00:00Z')}'::jsonb,
    '${JSON.stringify({
      id: 'race-w-shift',
      opened_at: '2026-08-10T08:00:00Z',
      closed_at: '2026-08-10T20:00:00Z',
      is_active: false,
      pos_update_time: '2026-08-12T11:00:00Z',
      transactions: [],
    }).replaceAll("'", "''")}'::jsonb
  ),
  '[]'::jsonb,
  '{"shift_ids":["race-shift","race-w-shift"]}'::jsonb
);
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
commit;
`);
  const countHoldsWorker = await race(
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.record_count(${countPayload('c9e00000-0000-4000-8000-000000000024', '15', '2026-08-12T10:00:00Z')});
select pg_sleep(${holdMs});
commit;
`,
    workerSql(null, null, false),
  );
  add(
    'record_count posting holds, worker waits',
    countHoldsWorker.holder,
    countHoldsWorker.waiter,
    'the worker returns busy while the count holds the ledger lock',
    '"status": "posted"',
    ['"status": "busy"', '"status": "sync_running"'],
    false,
  );
  await checkLedger('record_count posting holds, worker waits');

  const lossHoldsWorker = await race(
    lossSql(
      'c9e00000-0000-4000-8000-000000000202',
      '0.01',
      '2026-08-06 00:00:00+00',
      true,
    ),
    workerSql(null, null, false),
  );
  add(
    'dated loss holds, worker waits',
    lossHoldsWorker.holder,
    lossHoldsWorker.waiter,
    'the dated loss opens a rederive span and the worker returns busy',
    null,
    ['"status": "busy"', '"status": "sync_running"'],
    false,
  );
  await execOk(workerSql(null, null, false));
  await checkLedger('dated loss holds, worker waits');

  const workerHoldsLoss = await race(
    workerSql(null, null, true),
    lossSql(
      'c9e00000-0000-4000-8000-000000000203',
      '0',
      '2026-08-07 00:00:00+00',
      false,
    ),
  );
  add(
    'worker holds, dated loss waits',
    workerHoldsLoss.holder,
    workerHoldsLoss.waiter,
    'the dated loss waits for the worker lock, then opens its span',
    ['"status": "processed"', '"status": "empty"'],
    null,
  );
  await execOk(workerSql(null, null, false));
  await checkLedger('worker holds, dated loss waits');

  await drain();
  await checkLedger('queue drained before decisions', 'race-w1', true, true);
  await checkLedger('queue drained before decisions', 'race-w2', true, true);
  const decision = (
    await execOk(`
select coalesce(token, '') || '|' || is_open::text
from app.order_disposition_state
where order_id = 'race-d1';
`)
  ).trim();
  const [decisionToken, decisionOpen] = decision.split('|');
  if (decisionOpen !== 'true' || !decisionToken) {
    throw new Error(`race-d1 is not an open decision: ${decision}`);
  }
  const dispositionHolds = await race(
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.set_order_disposition(
  'c9e00000-0000-4000-8000-000000000301'::uuid,
  'race-d1',
  'not_made',
  '${decisionToken}',
  'race decision',
  null
);
select pg_sleep(${holdMs});
commit;
`,
    workerSql(null, null, false),
  );
  add(
    'disposition holds, worker waits',
    dispositionHolds.holder,
    dispositionHolds.waiter,
    'the decision holds the ledger lock and the worker returns busy',
    null,
    ['"status": "busy"', '"status": "sync_running"'],
    false,
  );
  await checkLedger('disposition holds, worker waits', 'race-d1', false);

  const nextDecision = (
    await execOk(`
select coalesce(token, '') || '|' || is_open::text
from app.order_disposition_state
where order_id = 'race-d1';
`)
  ).trim();
  const [nextToken, nextOpen] = nextDecision.split('|');
  if (nextOpen !== 'true' || !nextToken) {
    throw new Error(
      `race-d1 closed before the reverse decision race: ${nextDecision}`,
    );
  }
  const workerHoldsDisposition = await race(
    workerSql(null, null, true),
    `
\\set VERBOSITY verbose
begin;
${claims()}
select app.set_order_disposition(
  'c9e00000-0000-4000-8000-000000000302'::uuid,
  'race-d1',
  'made',
  '${nextToken}',
  'race decision',
  null
);
commit;
`,
  );
  add(
    'worker holds, disposition waits',
    workerHoldsDisposition.holder,
    workerHoldsDisposition.waiter,
    'the decision waits for the worker lock, then records',
    ['"status": "processed"', '"status": "empty"'],
    null,
  );
  await checkLedger('worker holds, disposition waits', 'race-d1');

  const failed = report.filter(
    (row) => !row.blocked || !row.holderOk || !row.waiterOk,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
