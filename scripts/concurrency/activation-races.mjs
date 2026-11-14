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

async function raceTwo(holderSql, waiterSql, secondSql) {
  const holder = psql(holderSql);
  await sleep(300);
  const waiter = psql(waiterSql);
  const second = psql(secondSql);
  return { holder: await holder, waiter: await waiter, second: await second };
}

function line(result) {
  const state = result.ok ? 'ok' : 'error';
  return `${state} ${result.ms}ms ${result.out.replace(/\s+/g, ' ').slice(0, 400)}`;
}

const report = [];

function add(name, holder, waiter, note, expectHolder, expectWaiter) {
  const blocked = waiter.ms >= minWaitMs;
  const holderOk =
    expectHolder == null ? holder.ok : holder.out.includes(expectHolder);
  const waiterOk =
    expectWaiter == null ? waiter.ok : waiter.out.includes(expectWaiter);
  report.push({
    name,
    blocked,
    holderOk,
    waiterOk,
    note,
    holder: line(holder),
    waiter: line(waiter),
  });
  process.stdout.write(
    `\n${name}\n  blocked: ${blocked}\n  holder outcome: ${holderOk}\n  waiter outcome: ${waiterOk}\n  ${note}\n  holder: ${line(holder)}\n  waiter: ${line(waiter)}\n`,
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

  const failed = report.filter(
    (row) => !row.blocked || !row.holderOk || !row.waiterOk,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
