import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const loopback = {
  PGHOST: '127.0.0.1',
  PGUSER: 'postgres',
  PGPASSWORD: 'postgres',
  PGDATABASE: 'postgres',
  PGSSLMODE: 'disable',
};

const CREATE_PG_CRON = 'create extension if not exists "pg_cron";';
const CREATE_PG_NET = 'create extension if not exists "pg_net";';

async function loadScheduler() {
  return import('./ensure-scheduler.mjs');
}

function lines(names) {
  return names.length === 0 ? '' : `${names.join('\n')}\n`;
}

function scriptedQuery(replies) {
  const calls = [];
  let index = 0;
  const query = (call) => {
    calls.push(call);
    const reply = replies[index];
    index += 1;
    if (reply === undefined) {
      throw new Error(`unexpected sql: ${call.sql}`);
    }
    return reply;
  };
  return { query, calls };
}

function assertUntouched(calls) {
  for (const call of calls) {
    assert.equal(typeof call.sql, 'string');
    assert.doesNotMatch(call.sql, /vault/i);
    assert.doesNotMatch(call.sql, /cron\.schedule/i);
    assert.doesNotMatch(call.sql, /cron\.job/i);
  }
}

test('a target without either extension creates both, then verifies', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = scriptedQuery([
    lines([]),
    '',
    '',
    lines(['pg_cron', 'pg_net']),
    lines(['cron', 'net']),
  ]);
  const result = ensureScheduler({ query, env: loopback });
  assert.deepEqual(result.created, ['pg_cron', 'pg_net']);
  assert.equal(calls.length, 5);
  assert.match(calls[0].sql, /pg_catalog\.pg_extension/);
  assert.match(calls[0].sql, /'pg_cron'/);
  assert.match(calls[0].sql, /'pg_net'/);
  assert.equal(calls[1].sql, CREATE_PG_CRON);
  assert.equal(calls[2].sql, CREATE_PG_NET);
  assert.match(calls[3].sql, /pg_catalog\.pg_extension/);
  assert.match(calls[4].sql, /pg_catalog\.pg_namespace/);
  assert.match(calls[4].sql, /'cron'/);
  assert.match(calls[4].sql, /'net'/);
  assert.ok(calls[1].code);
  assertUntouched(calls);
});

test('a target that already has one extension creates only the missing one', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = scriptedQuery([
    lines(['pg_cron']),
    '',
    lines(['pg_cron', 'pg_net']),
    lines(['cron', 'net']),
  ]);
  const result = ensureScheduler({ query, env: loopback });
  assert.deepEqual(result.created, ['pg_net']);
  assert.equal(
    calls.some((call) => call.sql === CREATE_PG_CRON),
    false,
  );
  assert.equal(calls[1].sql, CREATE_PG_NET);
  assert.match(calls[2].sql, /pg_extension/);
  assert.match(calls[3].sql, /pg_namespace/);
  assertUntouched(calls);
});

test('a target with both extensions creates nothing and passes', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = scriptedQuery([
    lines(['pg_cron', 'pg_net']),
    lines(['pg_net', 'pg_cron']),
    lines(['net', 'cron']),
  ]);
  const result = ensureScheduler({ query, env: loopback });
  assert.deepEqual(result.created, []);
  assert.equal(
    calls.some((call) => /create\s+extension/i.test(call.sql)),
    false,
  );
  assert.match(calls[0].sql, /pg_extension/);
  assert.match(calls[1].sql, /pg_extension/);
  assert.match(calls[2].sql, /pg_namespace/);
  assertUntouched(calls);
});

test('a missing schema after create fails', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = scriptedQuery([
    lines([]),
    '',
    '',
    lines(['pg_cron', 'pg_net']),
    lines(['cron']),
  ]);
  assert.throws(() => ensureScheduler({ query, env: loopback }), {
    code: 'SCHEDULER_NOT_READY',
    message: /schema net is missing/,
  });
  assert.equal(calls.length, 5);
  assert.equal(calls[1].sql, CREATE_PG_CRON);
  assert.equal(calls[2].sql, CREATE_PG_NET);
  assert.match(calls[4].sql, /pg_namespace/);
  assert.doesNotMatch(calls.at(-1).sql, /create\s+extension/i);
  assertUntouched(calls);
});

test('a missing pg_extension row after create fails', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = scriptedQuery([
    lines([]),
    '',
    '',
    lines(['pg_cron']),
    lines(['cron', 'net']),
  ]);
  assert.throws(() => ensureScheduler({ query, env: loopback }), {
    code: 'SCHEDULER_NOT_READY',
    message: /pg_extension has no row for pg_net/,
  });
  assert.equal(calls.length, 5);
  assert.equal(calls[1].sql, CREATE_PG_CRON);
  assert.equal(calls[2].sql, CREATE_PG_NET);
  assert.match(calls[3].sql, /pg_extension/);
  assertUntouched(calls);
});

test('installed extensions with a missing schema fail and create nothing', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = scriptedQuery([
    lines(['pg_cron', 'pg_net']),
    lines(['pg_cron', 'pg_net']),
    lines(['cron']),
  ]);
  assert.throws(() => ensureScheduler({ query, env: loopback }), {
    code: 'SCHEDULER_NOT_READY',
    message: /schema net is missing/,
  });
  assert.equal(
    calls.some((call) => /create\s+extension/i.test(call.sql)),
    false,
  );
  assertUntouched(calls);
});

test('an unsafe target is refused before any query', async () => {
  const { ensureScheduler } = await loadScheduler();
  const calls = [];
  const query = (call) => {
    calls.push(call);
    return '';
  };
  const remote = {
    PGHOST: 'aws-0-eu-central-1.pooler.supabase.com',
    PGUSER: 'postgres.example',
    PGPASSWORD: 'synthetic-password',
    PGDATABASE: 'postgres',
  };
  assert.throws(
    () => ensureScheduler({ query, env: remote }),
    (error) => {
      assert.equal(error.code, 'RESTORE_CONFIRM_REQUIRED');
      assert.equal(String(error.message).includes('synthetic-password'), false);
      return true;
    },
  );
  assert.throws(
    () =>
      ensureScheduler({
        query,
        env: {
          ...remote,
          BACKUP_RESTORE_CONFIRM: 'RESTORE-INTO-EMPTY-PROJECT',
          PGSSLMODE: 'disable',
        },
      }),
    { code: 'SSLMODE_WEAK' },
  );
  assert.throws(
    () =>
      ensureScheduler({
        query,
        env: {
          PGHOST: '127.0.0.1',
          PGUSER: 'postgres',
          PGDATABASE: 'postgres',
          PGSSLMODE: 'disable',
        },
      }),
    { code: 'ENV_MISSING', message: /PGPASSWORD/ },
  );
  assert.throws(
    () => ensureScheduler({ query, env: { ...loopback, PGSERVICE: 'prod' } }),
    { code: 'SERVICE_FORBIDDEN' },
  );
  assert.deepEqual(calls, []);
});

test('the scheduler script never mentions vault, cron.schedule, or cron.job', async () => {
  const source = readFileSync(
    new URL('./ensure-scheduler.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /vault/i);
  assert.doesNotMatch(source, /cron\.schedule/);
  assert.doesNotMatch(source, /cron\.job/);
  const { ensureScheduler } = await loadScheduler();
  assert.equal(typeof ensureScheduler, 'function');
});
