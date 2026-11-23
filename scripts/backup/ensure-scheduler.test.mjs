import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
    'f 42501 t t\n',
  ]);
  const result = ensureScheduler({ query, env: loopback });
  assert.deepEqual(result.created, ['pg_cron', 'pg_net']);
  assert.equal(calls.length, 6);
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
    'f 42501 t t\n',
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
    'f 42501 t t\n',
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

test('the validated connection env is the env used for every query', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'pgbin-'));
  const untouchedPath = join(tmpdir(), 'not-pg');
  try {
    const { ensureScheduler } = await loadScheduler();
    const env = {
      PGHOST: 'aws-0-eu-central-1.pooler.supabase.com',
      PGUSER: 'postgres.example',
      PGPASSWORD: 'synthetic-password',
      PGDATABASE: 'postgres',
      PGSSLMODE: 'verify-full',
      BACKUP_RESTORE_CONFIRM: 'RESTORE-INTO-EMPTY-PROJECT',
      BACKUP_PG_BIN: bin,
      PATH: untouchedPath,
      BACKUP_ENV_MARK: 'scheduler-connection',
    };
    const { query, calls } = scriptedQuery([
      lines(['pg_cron', 'pg_net']),
      lines(['pg_cron', 'pg_net']),
      lines(['cron', 'net']),
      'f 42501 t t\n',
    ]);
    ensureScheduler({ query, env });
    assert.ok(calls.length >= 3);
    for (const call of calls) {
      assert.equal(call.env, calls[0].env);
      assert.equal(call.env.BACKUP_ENV_MARK, 'scheduler-connection');
      assert.equal(call.env.PGSSLMODE, 'verify-full');
      assert.equal(call.env.PGPASSWORD, 'synthetic-password');
      assert.equal(call.env.PATH.split(delimiter)[0], bin);
    }
    assert.equal(env.PATH, untouchedPath);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('unset PGSSLMODE on a remote host is refused', async () => {
  const { ensureScheduler } = await loadScheduler();
  const calls = [];
  assert.throws(
    () =>
      ensureScheduler({
        query: (call) => {
          calls.push(call);
          return '';
        },
        env: {
          PGHOST: 'aws-0-eu-central-1.pooler.supabase.com',
          PGUSER: 'postgres.example',
          PGPASSWORD: 'synthetic-password',
          PGDATABASE: 'postgres',
          BACKUP_RESTORE_CONFIRM: 'RESTORE-INTO-EMPTY-PROJECT',
        },
      }),
    { code: 'SSLMODE_WEAK' },
  );
  assert.equal(calls.length, 0);
});

test('the CI round trip installs the scheduler on the real stack', () => {
  const sh = readFileSync(
    new URL('./ci-roundtrip.sh', import.meta.url),
    'utf8',
  );
  assert.match(sh, /node "\$here\/ensure-scheduler\.mjs"/);
  assert.doesNotMatch(sh, /42501\|3F000\|42P01/);
  assert.match(sh, /expect_denied "cron\.job" 42501 /);
  assert.match(sh, /expect_denied "vault\.secrets" 42501 /);
  assert.match(sh, /to_regclass\('cron\.job'\)/);
  assert.match(sh, /to_regclass\('net\.http_request_queue'\)/);
  assert.match(sh, /to_regclass\('vault\.secrets'\)/);
  assert.match(sh, /pg_restore -l/);
  assert.match(sh, /scheduler_secret_and_job/);
  assert.doesNotMatch(sh, /cron\.schedule/);
  assert.match(sh, /expect_denied "net\.http_request_queue" 42501 /);
  const blocked = sh.indexOf('if scheduler_secret_and_job; then');
  const install = sh.indexOf('node "$here/ensure-scheduler.mjs"');
  const opened = sh.indexOf(
    'scheduler_secret_and_job || fail SCHEDULER_GATE',
    install,
  );
  assert.ok(blocked !== -1 && blocked < install);
  assert.ok(opened > install);
});

test('restore docs run the scheduler from current main, in order', () => {
  const backup = readFileSync(
    new URL('../../docs/BACKUP.md', import.meta.url),
    'utf8',
  );
  const schedulerAt = backup.indexOf('### Scheduler after the app is usable');
  const ciAt = backup.indexOf('\n## CI proof');
  assert.ok(schedulerAt !== -1 && ciAt > schedulerAt);
  const section = backup.slice(schedulerAt, ciAt);
  let at = -1;
  for (const marker of [
    'Confirm the installed app is reading the restored data',
    'checkout of current `main`',
    'ensure-scheduler.mjs',
    'BACKUP_PG_BIN',
    'defines the job name and the function path',
    'Redeploy the Edge Function',
    'function secrets and the Vault secrets',
    'Schedule the job',
    '* * * * *',
  ]) {
    const next = section.indexOf(marker, at + 1);
    assert.ok(next > at, marker);
    at = next;
  }
  assert.equal(backup.includes('install the scheduler extensions'), false);
  const runbook = readFileSync(
    new URL('../../docs/RESTORE-RUNBOOK.md', import.meta.url),
    'utf8',
  );
  const arabic = runbook.slice(runbook.indexOf('## 10.'));
  at = -1;
  for (const marker of [
    'checkout لـ `main` الحالي',
    'BACKUP_PG_BIN',
    'ensure-scheduler.mjs',
    'اسم الوظيفة ومسار الدالة',
    'انشر دالة الـ Edge',
    'أسرار Vault',
    '* * * * *',
  ]) {
    const next = arabic.indexOf(marker, at + 1);
    assert.ok(next > at, marker);
    at = next;
  }
});

function replyingQuery({ firstExtensions, checks = 'f 42501 t t' }) {
  let extensionReads = 0;
  const calls = [];
  const query = (call) => {
    calls.push(call);
    if (/revoke usage on schema net from public/i.test(call.sql)) {
      return `${checks}\n`;
    }
    if (/pg_catalog\.pg_extension/.test(call.sql)) {
      extensionReads += 1;
      return lines(
        extensionReads === 1 ? firstExtensions : ['pg_cron', 'pg_net'],
      );
    }
    if (/pg_catalog\.pg_namespace/.test(call.sql)) {
      return lines(['cron', 'net']);
    }
    return '';
  };
  return { query, calls };
}

function assertNetLock(calls) {
  const acl = calls.filter((call) =>
    /revoke usage on schema net from public/i.test(call.sql),
  );
  assert.equal(acl.length, 1);
  const sql = acl[0].sql;
  assert.ok(
    sql.search(/grant usage on schema net/i) <
      sql.search(/revoke usage on schema net from public/i),
  );
  assert.match(sql, /grant execute on all functions in schema net/i);
  assert.match(sql, /grant all privileges on all tables in schema net/i);
  assert.match(sql, /grant all privileges on all sequences in schema net/i);
  assert.match(sql, /'postgres'/);
  assert.match(sql, /'supabase_functions_admin'/);
  assert.match(sql, /'supabase_admin'/);
  assert.match(
    sql,
    /revoke all privileges on all tables in schema net from public/i,
  );
  assert.match(
    sql,
    /revoke all privileges on all sequences in schema net from public/i,
  );
  assert.doesNotMatch(sql, /revoke\s+[\s\S]*from\s+current_user/i);
  assert.doesNotMatch(sql, /revoke\s+[\s\S]*from\s+postgres/i);
  assert.match(sql, /net\.http_request_queue/);
  assert.match(sql, /http_post/);
  assert.match(sql, /has_schema_privilege\('backup_reader', 'net', 'usage'\)/);
  assertUntouched(calls);
}

test('a fresh install locks net after creating both extensions', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = replyingQuery({ firstExtensions: [] });
  const result = ensureScheduler({ query, env: loopback });
  assert.deepEqual(result.created, ['pg_cron', 'pg_net']);
  const revokeAt = calls.findIndex((call) =>
    /revoke usage on schema net from public/i.test(call.sql),
  );
  const createdNetAt = calls.findIndex((call) => call.sql === CREATE_PG_NET);
  const schemaAt = calls.findIndex((call) => /pg_namespace/.test(call.sql));
  assert.ok(
    createdNetAt !== -1 && schemaAt > createdNetAt && revokeAt > schemaAt,
  );
  assertNetLock(calls);
});

test('an existing install with public grants locks net without creating extensions', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = replyingQuery({
    firstExtensions: ['pg_cron', 'pg_net'],
  });
  const result = ensureScheduler({ query, env: loopback });
  assert.deepEqual(result.created, []);
  assert.equal(
    calls.some((call) => /create\s+extension/i.test(call.sql)),
    false,
  );
  assertNetLock(calls);
});

test('a second run locks net again and creates nothing', async () => {
  const { ensureScheduler } = await loadScheduler();
  const first = replyingQuery({ firstExtensions: ['pg_cron', 'pg_net'] });
  const second = replyingQuery({ firstExtensions: ['pg_cron', 'pg_net'] });
  assert.deepEqual(
    ensureScheduler({ query: first.query, env: loopback }).created,
    [],
  );
  assert.deepEqual(
    ensureScheduler({ query: second.query, env: loopback }).created,
    [],
  );
  assertNetLock(first.calls);
  assertNetLock(second.calls);
});

test('a missing owner privilege on net fails after the lock', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = replyingQuery({
    firstExtensions: ['pg_cron', 'pg_net'],
    checks: 'f 42501 f t',
  });
  assert.throws(() => ensureScheduler({ query, env: loopback }), {
    code: 'SCHEDULER_NET_ACL',
    message: /database owner has no usage on schema net/,
  });
  assertNetLock(calls);
});

test('the CI round trip proves a reader dump after the scheduler lock', () => {
  const sh = readFileSync(
    new URL('./ci-roundtrip.sh', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(sh, /ROLE_UNSAFE/);
  assert.match(sh, /expect_denied "net\.http_request_queue" 42501 /);
  const install = sh.indexOf('node "$here/ensure-scheduler.mjs"');
  const dump = sh.indexOf('"$archives/scheduler"', install);
  assert.ok(install !== -1 && dump > install);
});

test('restore docs say the scheduler removes public access to net', () => {
  const backup = readFileSync(
    new URL('../../docs/BACKUP.md', import.meta.url),
    'utf8',
  );
  const section = backup.slice(
    backup.indexOf('### Scheduler after the app is usable'),
    backup.indexOf('\n## CI proof'),
  );
  assert.match(section, /revokes PUBLIC access to schema net/);
  assert.match(section, /reinstalled/);
  assert.match(section, /role check stays the tripwire/);
  const runbook = readFileSync(
    new URL('../../docs/RESTORE-RUNBOOK.md', import.meta.url),
    'utf8',
  );
  const arabic = runbook.slice(runbook.indexOf('## 10.'));
  assert.match(arabic, /PUBLIC/);
  assert.match(arabic, /لو الامتداد اتثبّت تاني/);
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
