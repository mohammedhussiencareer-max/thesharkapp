// Two real sessions. The holder sleeps inside the open transaction.
// Synthetic ids only. No session-level advisory lock is used as a stand-in
// for the ledger lock: the monotonic race goes through post_movements.

import { spawn } from 'node:child_process';

const owner = 'd9e00000-0000-4000-8000-0000000000a1';
const item = 'd9e00000-0000-4000-8000-000000000001';
const holdMs = 2.5;
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

function purchase(at) {
  return `app.post_movements(jsonb_build_array(jsonb_build_object(
    'item_id', '${item}',
    'movement_type', 'purchase',
    'occurred_at', '${at}',
    'quantity', 1,
    'unit_cost', 10
  )))`;
}

async function race(holderSql, waiterSql, delayMs = 300) {
  const holder = psql(holderSql);
  await sleep(delayMs);
  const waiter = await psql(waiterSql);
  return { holder: await holder, waiter };
}

function idOf(result, label) {
  const match = result.out.match(new RegExp(`${label}=(\\d+)`));
  return match ? Number(match[1]) : null;
}

async function main() {
  container = await containerName();
  const setup = await psql(`
begin;
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, confirmation_token, recovery_token,
  email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000', '${owner}',
  'authenticated', 'authenticated', 'owner-checkpoint-race@theshark.test', '',
  '2026-01-01 00:00:00+00', '', '', '', ''
) on conflict (id) do nothing;
insert into app.owner (user_id) values ('${owner}')
on conflict (id) do update set user_id = excluded.user_id;
${claims()}
insert into app.stock_items (id, name, kind, base_unit, count_frequency)
values ('${item}', 'checkpoint race fish', 'seafood', 'kg', 'daily')
on conflict (id) do nothing;
commit;
`);
  if (!setup.ok) throw new Error(setup.out);

  const monotonic = await race(
    `
begin;
${claims()}
create temp table held_batch on commit drop as
select ${purchase('2026-10-21 11:00:00+00')} as batch;
select pg_sleep(${holdMs});
select 'holder_id=' || sm.id::text
from app.stock_movements sm
join held_batch on held_batch.batch = sm.batch_id;
commit;
`,
    `
begin;
${claims()}
create temp table waited_batch on commit drop as
select ${purchase('2026-10-21 12:00:00+00')} as batch;
select 'waiter_id=' || sm.id::text
from app.stock_movements sm
join waited_batch on waited_batch.batch = sm.batch_id;
commit;
`,
    800,
  );

  const holderId = idOf(monotonic.holder, 'holder_id');
  const waiterId = idOf(monotonic.waiter, 'waiter_id');
  const monotonicOk =
    monotonic.holder.ok &&
    monotonic.waiter.ok &&
    holderId !== null &&
    waiterId !== null &&
    waiterId > holderId &&
    monotonic.waiter.ms >= minWaitMs;
  process.stdout.write(
    `\nmonotonic ids\n  blocked: ${monotonic.waiter.ms >= minWaitMs}\n  holder id: ${holderId}\n  waiter id: ${waiterId}\n  pass: ${monotonicOk}\n  holder: ${monotonic.holder.out.replace(/\s+/g, ' ').slice(0, 400)}\n  waiter: ${monotonic.waiter.out.replace(/\s+/g, ' ').slice(0, 400)}\n`,
  );

  const purchaseWaits = await race(
    `
begin;
lock table app.pos_sync_runs in row exclusive mode;
lock table app.pos_shifts in share mode;
select pg_sleep(${holdMs});
select 'ingest_holding';
commit;
`,
    `
begin;
${claims()}
select ${purchase('2026-10-22 08:00:00+00')};
select 'purchase_committed';
commit;
`,
  );
  const purchaseOk =
    purchaseWaits.holder.ok &&
    purchaseWaits.waiter.ok &&
    purchaseWaits.waiter.out.includes('purchase_committed') &&
    !purchaseWaits.waiter.out.includes('deadlock') &&
    purchaseWaits.waiter.ms >= minWaitMs;
  process.stdout.write(
    `\npurchase waits for ingest row exclusive\n  blocked: ${purchaseWaits.waiter.ms >= minWaitMs}\n  pass: ${purchaseOk}\n  waiter: ${purchaseWaits.waiter.out.replace(/\s+/g, ' ').slice(0, 300)}\n`,
  );

  const installWaits = await race(
    `
begin;
lock table app.pos_sync_runs in share mode;
select pg_sleep(${holdMs});
select 'share_holding';
commit;
`,
    `
begin;
select pg_catalog.pg_advisory_xact_lock(7342750000000000001::bigint);
lock table app.pos_sync_runs in exclusive mode;
lock table app.pos_shifts in share mode;
select 'install_locks_acquired';
commit;
`,
  );
  const installOk =
    installWaits.holder.ok &&
    installWaits.waiter.ok &&
    installWaits.waiter.out.includes('install_locks_acquired') &&
    !installWaits.waiter.out.includes('deadlock') &&
    installWaits.waiter.ms >= minWaitMs;
  process.stdout.write(
    `\ninstall exclusive waits for a share holder\n  blocked: ${installWaits.waiter.ms >= minWaitMs}\n  pass: ${installOk}\n  waiter: ${installWaits.waiter.out.replace(/\s+/g, ' ').slice(0, 300)}\n`,
  );

  const shift = JSON.stringify({
    id: 'c-pause-shift',
    opened_at: '2026-10-23T08:00:00Z',
    closed_at: '2026-10-23T20:00:00Z',
    is_active: false,
    pos_update_time: '2026-10-23T20:00:00Z',
    transactions: [],
  }).replaceAll("'", "''");
  const pauseRace = await race(
    `
begin;
${claims()}
select set_config('app.ingest_pause_after_shifts', '1', true);
select app.start_pos_sync_run('recent') as run_id \\gset
select app.ingest_pos_batch(
  :run_id,
  jsonb_build_array('${shift}'::jsonb),
  '[]'::jsonb,
  '{"shift_ids":["c-pause-shift"]}'::jsonb
);
select app.finish_pos_sync_run(:run_id, 'ok', '{}'::jsonb, '');
select 'ingest_committed';
commit;
`,
    `
begin;
${claims()}
select ${purchase('2026-10-23 09:00:00+00')};
select 'purchase_committed';
commit;
`,
    800,
  );
  const pauseOk =
    pauseRace.holder.ok &&
    pauseRace.waiter.ok &&
    pauseRace.holder.out.includes('ingest_committed') &&
    pauseRace.waiter.out.includes('purchase_committed') &&
    !pauseRace.holder.out.includes('deadlock') &&
    !pauseRace.waiter.out.includes('deadlock') &&
    pauseRace.waiter.ms >= minWaitMs;
  process.stdout.write(
    `\ningest paused after the shifts upsert, purchase waits\n  blocked: ${pauseRace.waiter.ms >= minWaitMs}\n  pass: ${pauseOk}\n  holder: ${pauseRace.holder.out.replace(/\s+/g, ' ').slice(0, 300)}\n  waiter: ${pauseRace.waiter.out.replace(/\s+/g, ' ').slice(0, 300)}\n`,
  );

  if (!monotonicOk || !purchaseOk || !installOk || !pauseOk) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
