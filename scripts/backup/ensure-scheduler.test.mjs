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

const remoteReady = {
  PGHOST: 'aws-0-eu-central-1.pooler.supabase.com',
  PGUSER: 'postgres.example',
  PGPASSWORD: 'synthetic-password',
  PGDATABASE: 'postgres',
  PGSSLMODE: 'verify-full',
  BACKUP_RESTORE_CONFIRM: 'RESTORE-INTO-EMPTY-PROJECT',
  BACKUP_ALLOW_LOOPBACK: '1',
  BACKUP_SCHEDULER_CREATE: '1',
};

async function loadScheduler() {
  return import('./ensure-scheduler.mjs');
}

function lines(names) {
  return names.length === 0 ? '' : `${names.join('\n')}\n`;
}

function isCreate(call) {
  return /create\s+extension/i.test(call.sql);
}

function isPrivilegeChange(call) {
  return /\b(grant|revoke)\b/i.test(call.sql);
}

// Answers both the old lock script and the checker. A revoke statement is
// treated as a successful privilege change so the previous lock can return
// success while a read of effective privileges still reports reader access.
function database({ extensions, problems = '' }) {
  const calls = [];
  const installed = [...extensions];
  const query = (call) => {
    calls.push(call);
    const sql = call.sql;
    if (sql === CREATE_PG_CRON) {
      if (!installed.includes('pg_cron')) installed.push('pg_cron');
      return '';
    }
    if (sql === CREATE_PG_NET) {
      if (!installed.includes('pg_net')) installed.push('pg_net');
      return '';
    }
    if (/^select extname from pg_catalog\.pg_extension/i.test(sql.trim())) {
      return lines([...installed].sort());
    }
    if (/^select nspname from pg_catalog\.pg_namespace/i.test(sql.trim())) {
      const schemas = [];
      if (installed.includes('pg_cron')) schemas.push('cron');
      if (installed.includes('pg_net')) schemas.push('net');
      return lines(schemas);
    }
    if (/has_schema_privilege/i.test(sql)) {
      return problems === '' ? '' : `${problems}\n`;
    }
    return '';
  };
  return { query, calls };
}

const WRITE_SQL =
  /\b(alter|comment|create|delete|drop|grant|insert|revoke|truncate|update)\b/i;

test('p2: the checker never issues a write statement in any env', async () => {
  const { ensureScheduler } = await loadScheduler();
  const envs = [
    loopback,
    { ...loopback, BACKUP_ALLOW_LOOPBACK: '1' },
    { ...loopback, BACKUP_ALLOW_LOOPBACK: '1', BACKUP_SCHEDULER_CREATE: '1' },
    {
      ...loopback,
      PGHOST: '127.0.0.1',
      PGPORT: '15432',
      BACKUP_ALLOW_LOOPBACK: '1',
      BACKUP_SCHEDULER_CREATE: '1',
    },
    remoteReady,
  ];
  const writes = [];
  for (const env of envs) {
    const { query, calls } = database({ extensions: [] });
    try {
      ensureScheduler({ query, env });
    } catch {
      // A refused connection is acceptable. A write is not.
    }
    for (const call of calls) {
      if (WRITE_SQL.test(call.sql)) {
        writes.push(`${env.PGHOST}:${env.PGPORT ?? ''}: ${call.sql}`);
      }
    }
  }
  assert.deepEqual(writes, []);
  const source = readFileSync(
    new URL('./ensure-scheduler.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /create\s+extension/i);
  assert.doesNotMatch(source, /BACKUP_SCHEDULER_CREATE/);
});

test('p2: cron or vault usage while pg_net is absent is not a reason to remove pg_net', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query } = database({
    extensions: [],
    problems: 'backup_reader can use schema vault',
  });
  let thrown = null;
  try {
    ensureScheduler({ query, env: loopback });
  } catch (error) {
    thrown = error;
  }
  const runbook = readFileSync(
    new URL('../../docs/RESTORE-RUNBOOK.md', import.meta.url),
    'utf8',
  );
  const arabic = runbook.slice(
    runbook.indexOf('## 10.'),
    runbook.indexOf('## تمرين الاستعادة'),
  );
  const backup = readFileSync(
    new URL('../../docs/BACKUP.md', import.meta.url),
    'utf8',
  );
  const section = backup.slice(
    backup.indexOf('### Scheduler after the app is usable'),
    backup.indexOf('\n## CI proof'),
  );
  assert.deepEqual(
    {
      code: thrown ? thrown.code : null,
      mentionsVault: Boolean(thrown && /schema vault/.test(thrown.message)),
      runbookNamesRoleCode: arabic.includes('SCHEDULER_ROLE_UNSAFE'),
      runbookRemovesPgNetForAnyUnsafe: arabic.includes(
        'لو طلع `SCHEDULER_NET_UNSAFE`، وقف واشيل `pg_net`',
      ),
      backupNamesRoleCode: section.includes('SCHEDULER_ROLE_UNSAFE'),
    },
    {
      code: 'SCHEDULER_ROLE_UNSAFE',
      mentionsVault: true,
      runbookNamesRoleCode: true,
      runbookRemovesPgNetForAnyUnsafe: false,
      backupNamesRoleCode: true,
    },
  );
});

test('new behaviour: pg_net absent passes and creates nothing', async () => {
  const { ensureScheduler, formatSchedulerReport } = await loadScheduler();
  const { query, calls } = database({ extensions: [] });
  const result = ensureScheduler({ query, env: loopback });
  assert.equal(Object.hasOwn(result, 'created'), false);
  assert.equal(calls.some(isCreate), false);
  assert.equal(result.pgCron, false);
  assert.equal(result.pgNet, false);
  assert.equal(
    formatSchedulerReport(result),
    'scheduler check: pg_cron absent, pg_net absent',
  );
  assert.equal(calls.some(isPrivilegeChange), false);
});

test('new behaviour: pg_net with reader access fails closed', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = database({
    extensions: ['pg_cron', 'pg_net'],
    problems: [
      'backup_reader can use schema net',
      'backup_reader can select net.http_request_queue',
    ].join('\n'),
  });
  let thrown = null;
  try {
    ensureScheduler({ query, env: loopback });
  } catch (error) {
    thrown = error;
  }
  assert.deepEqual(
    {
      code: thrown ? thrown.code : null,
      mentionsNet: Boolean(thrown && /schema net/.test(thrown.message)),
      mentionsSelect: Boolean(
        thrown && /can select net\.http_request_queue/.test(thrown.message),
      ),
      revoke: calls.some((call) => /\brevoke\b/i.test(call.sql)),
      grant: calls.some((call) => /\bgrant\b/i.test(call.sql)),
      create: calls.filter(isCreate).map((call) => call.sql),
    },
    {
      code: 'SCHEDULER_NET_UNSAFE',
      mentionsNet: true,
      mentionsSelect: true,
      revoke: false,
      grant: false,
      create: [],
    },
  );
  assert.equal(String(thrown.message).includes('synthetic-password'), false);
});

test('new behaviour: cron or vault usage fails closed without creating extensions', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = database({
    extensions: [],
    problems: 'backup_reader can use schema vault',
  });
  let thrown = null;
  try {
    ensureScheduler({ query, env: loopback });
  } catch (error) {
    thrown = error;
  }
  assert.deepEqual(
    {
      code: thrown ? thrown.code : null,
      mentionsVault: Boolean(thrown && /schema vault/.test(thrown.message)),
      create: calls.filter(isCreate).map((call) => call.sql),
    },
    {
      code: 'SCHEDULER_ROLE_UNSAFE',
      mentionsVault: true,
      create: [],
    },
  );
});

test('new behaviour: a remote target is only read', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = database({ extensions: [] });
  const result = ensureScheduler({ query, env: remoteReady });
  assert.equal(result.pgNet, false);
  assert.equal(calls.filter(isCreate).length, 0);
  assert.equal(calls.some(isPrivilegeChange), false);
  assert.ok(calls.every((call) => /^\s*select\b/i.test(call.sql)));
});

test('confirmed net exposure keeps SCHEDULER_NET_UNSAFE and still names cron or vault', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = database({
    extensions: ['pg_net'],
    problems: [
      'backup_reader can use schema vault',
      'backup_reader can select net.http_request_queue',
    ].join('\n'),
  });
  assert.throws(
    () => ensureScheduler({ query, env: loopback }),
    (error) => {
      assert.equal(error.code, 'SCHEDULER_NET_UNSAFE');
      assert.match(error.message, /schema vault/);
      assert.match(error.message, /net\.http_request_queue/);
      return true;
    },
  );
  assert.equal(calls.some(isCreate), false);
});

test('pg_net present without reader access passes and creates nothing', async () => {
  const { ensureScheduler, formatSchedulerReport } = await loadScheduler();
  const { query, calls } = database({ extensions: ['pg_net'] });
  const result = ensureScheduler({ query, env: loopback });
  assert.equal(Object.hasOwn(result, 'created'), false);
  assert.equal(result.pgCron, false);
  assert.equal(result.pgNet, true);
  assert.equal(
    formatSchedulerReport(result),
    'scheduler check: pg_cron absent, pg_net present',
  );
  assert.equal(calls.some(isCreate), false);
  assert.equal(calls.some(isPrivilegeChange), false);
});

test('a select on a net table fails closed when usage is not reported', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query, calls } = database({
    extensions: ['pg_net'],
    problems: 'backup_reader can select net._http_response',
  });
  assert.throws(() => ensureScheduler({ query, env: loopback }), {
    code: 'SCHEDULER_NET_UNSAFE',
    message: /net\._http_response/,
  });
  assert.equal(calls.some(isCreate), false);
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
    const { query, calls } = database({ extensions: [] });
    const result = ensureScheduler({ query, env });
    assert.equal(result.pgNet, false);
    assert.equal(calls.some(isCreate), false);
    assert.ok(calls.length >= 2);
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

test('a loopback name with a remote hostaddr is still only read', async () => {
  const { ensureScheduler } = await loadScheduler();
  const calls = [];
  const result = ensureScheduler({
    query: (call) => {
      calls.push(call);
      return '';
    },
    env: {
      ...remoteReady,
      PGHOST: '127.0.0.1',
      PGHOSTADDR: '203.0.113.10',
    },
  });
  assert.equal(result.pgNet, false);
  assert.equal(calls.filter(isCreate).length, 0);
  assert.ok(calls.every((call) => /^\s*select\b/i.test(call.sql)));
});

test('the privilege query gates net on pg_net and still checks cron and vault', async () => {
  const source = readFileSync(
    new URL('./ensure-scheduler.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('const PRIVILEGE_SQL');
  const end = source.indexOf('function readNames');
  assert.ok(start !== -1 && end > start);
  const sql = source.slice(start, end);
  const parts = sql.split(/union all/i);
  assert.equal(parts.length, 4);
  assert.match(parts[0], /backup_reader does not exist/);
  assert.match(parts[0], /extname = 'pg_net'/);
  assert.match(parts[1], /nspname in \('cron', 'vault'\)/);
  assert.doesNotMatch(parts[1], /pg_net/);
  assert.match(parts[1], /has_schema_privilege\(\s*'backup_reader'/);
  assert.match(parts[2], /extname = 'pg_net'/);
  assert.match(parts[2], /nspname = 'net'/);
  assert.match(parts[2], /'USAGE'/);
  assert.match(parts[3], /extname = 'pg_net'/);
  assert.match(parts[3], /has_table_privilege\(\s*'backup_reader'/);
  assert.match(parts[3], /'SELECT'/);
  assert.doesNotMatch(sql, /\b(grant|revoke)\b/i);
  assert.doesNotMatch(sql, /http_post/i);
  assert.doesNotMatch(sql, /from\s+net\./i);
});

test('the scheduler script does not change privileges or read job rows', () => {
  const source = readFileSync(
    new URL('./ensure-scheduler.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /\bgrant\b/i);
  assert.doesNotMatch(source, /\brevoke\b/i);
  assert.doesNotMatch(source, /http_post/i);
  assert.doesNotMatch(source, /http_request_queue/i);
  assert.doesNotMatch(source, /cron\.schedule/);
  assert.doesNotMatch(source, /cron\.job/);
  assert.doesNotMatch(source, /vault\.secrets/i);
  assert.doesNotMatch(source, /from\s+vault\b/i);
  assert.doesNotMatch(source, /set_config\(\s*'role'/i);
  assert.doesNotMatch(source, /SCHEDULER_NET_ACL/);
  assert.doesNotMatch(source, /SCHEDULER_NOT_READY/);
  assert.match(source, /SCHEDULER_NET_UNSAFE/);
  assert.match(source, /SCHEDULER_ROLE_UNSAFE/);
  assert.doesNotMatch(source, /SCHEDULER_CREATE_REFUSED/);
  assert.doesNotMatch(source, /BACKUP_SCHEDULER_CREATE/);
  assert.doesNotMatch(source, /create\s+extension/i);
  assert.doesNotMatch(source, /with schema/i);
});

test('the CI round trip proves a guarded backup, then fails closed after pg_net', () => {
  const sh = readFileSync(
    new URL('./ci-roundtrip.sh', import.meta.url),
    'utf8',
  );
  const dumpAt = sh.indexOf('"$archives/without-net"');
  const createAt = sh.indexOf('create extension if not exists "pg_net"');
  const checkerAt = sh.indexOf('[SCHEDULER_NET_UNSAFE]');
  const roleAt = sh.indexOf(
    '"[ROLE_UNSAFE]: role can enter platform schemas: net"',
  );
  const vaultAt = sh.indexOf('expect_denied "vault.secrets" 42501 ');
  const cronAt = sh.indexOf('expect_denied "cron.job" 42501 ');
  assert.ok(dumpAt !== -1 && createAt > dumpAt);
  assert.ok(checkerAt > createAt);
  assert.ok(roleAt > checkerAt);
  assert.ok(vaultAt !== -1 && vaultAt < createAt);
  assert.ok(cronAt > createAt);
  assert.match(sh, /BACKUP_FORCE_ROLE_CHECK=1/);
  assert.match(sh, /extname = 'pg_net'/);
  assert.match(sh, /pg_net absent/);
  assert.match(sh, /pg_restore -l/);
  assert.match(sh, /create extension if not exists "pg_cron"/);
  assert.doesNotMatch(sh, /BACKUP_SCHEDULER_CREATE/);
  assert.doesNotMatch(sh, /expect_denied "net\.http_request_queue"/);
  assert.doesNotMatch(sh, /http_post/);
  assert.doesNotMatch(sh, /cron\.schedule/);
  assert.doesNotMatch(sh, /scheduler_secret_and_job/);
  assert.doesNotMatch(sh, /42501\|3F000\|42P01/);
});

test('restore docs defer scheduler activation and do not install pg_net', () => {
  const backup = readFileSync(
    new URL('../../docs/BACKUP.md', import.meta.url),
    'utf8',
  );
  const schedulerAt = backup.indexOf('### Scheduler after the app is usable');
  const ciAt = backup.indexOf('\n## CI proof');
  assert.ok(schedulerAt !== -1 && ciAt > schedulerAt);
  const section = backup.slice(schedulerAt, ciAt);
  for (const marker of [
    'must not be installed',
    'fails closed',
    'P7-9',
    'verified Supabase ACL fix',
    'one-minute trigger',
    'decision pending',
    'ensure-scheduler.mjs',
    'read statements',
    'named privilege',
    'SCHEDULER_NET_UNSAFE',
    'SCHEDULER_ROLE_UNSAFE',
  ]) {
    assert.ok(section.includes(marker), marker);
  }
  assert.equal(section.includes('scheduler ready'), false);
  assert.equal(section.includes('CREATE EXTENSION'), false);
  assert.equal(section.includes('BACKUP_SCHEDULER_CREATE'), false);
  assert.match(backup, /SCHEDULER_NET_UNSAFE/);
  assert.equal(backup.includes('SCHEDULER_NET_ACL'), false);
  assert.equal(backup.includes('SCHEDULER_NOT_READY'), false);
  assert.equal(backup.includes('SCHEDULER_CREATE_REFUSED'), false);
  assert.equal(backup.includes('BACKUP_SCHEDULER_CREATE'), false);
  const runbook = readFileSync(
    new URL('../../docs/RESTORE-RUNBOOK.md', import.meta.url),
    'utf8',
  );
  const arabic = runbook.slice(
    runbook.indexOf('## 10.'),
    runbook.indexOf('## تمرين الاستعادة'),
  );
  for (const marker of [
    'متثبّتش `pg_net`',
    'P7-9',
    'SCHEDULER_NET_UNSAFE',
    'SCHEDULER_ROLE_UNSAFE',
    'ensure-scheduler.mjs',
    'دقيقة',
    'متشيلش `pg_net`',
  ]) {
    assert.ok(arabic.includes(marker), marker);
  }
  assert.equal(arabic.includes('CREATE EXTENSION'), false);
  assert.equal(arabic.includes('scheduler ready'), false);
});

test('p2: post-pg_net dump assertion names net and verifies no archive was produced', () => {
  const sh = readFileSync(
    new URL('./ci-roundtrip.sh', import.meta.url),
    'utf8',
  );
  const start = sh.indexOf('expect_fail "reader dump after pg_net"');
  const end = sh.indexOf('step "stack B: empty project"');
  assert.ok(start !== -1 && end > start);
  const block = sh.slice(start, end);
  assert.doesNotMatch(
    block,
    /expect_fail "reader dump after pg_net" "\[ROLE_UNSAFE\]"/,
  );
  assert.match(
    block,
    /expect_fail "reader dump after pg_net" "\[ROLE_UNSAFE\]: role can enter platform schemas: net"/,
  );
  assert.match(block, /"\$archives\/after-net"/);
  assert.match(block, /ls -A "\$archives\/after-net"/);
});

test('p2: ci-roundtrip binds disposable extension install to the started stack container', () => {
  const sh = readFileSync(
    new URL('./ci-roundtrip.sh', import.meta.url),
    'utf8',
  );
  const unsetAt = sh.indexOf('BACKUP_CONFIG_TOML');
  const setupAt = sh.indexOf('setup_pg_path');
  const portAt = sh.indexOf('PGPORT=$(guard db-port)');
  assert.ok(unsetAt !== -1 && unsetAt < setupAt && unsetAt < portAt);
  assert.match(sh, /unset[^\n]*\bBACKUP_CONFIG_TOML\b/);
  const installStart = sh.indexOf(
    'step "stack A: disposable stack installs pg_net',
  );
  const checkStart = sh.indexOf('local scheduler_rc=0');
  assert.ok(installStart !== -1 && checkStart > installStart);
  const installBlock = sh.slice(installStart, checkStart);
  assert.match(installBlock, /stack_db_container/);
  assert.match(
    installBlock,
    /docker exec[^\n]*\n[^\n]*psql[^\n]*\n[^\n]*create extension if not exists "pg_cron";/,
  );
  assert.match(
    installBlock,
    /docker exec[^\n]*\n[^\n]*psql[^\n]*\n[^\n]*create extension if not exists "pg_net";/,
  );
  assert.match(sh, /docker inspect/);
  assert.match(sh, /docker port/);
});

test('p2: docs state the P7-0 backup workflow pin rollout order before any hosted pg_cron/pg_net install', () => {
  const backup = readFileSync(
    new URL('../../docs/BACKUP.md', import.meta.url),
    'utf8',
  );
  const section = backup.slice(
    backup.indexOf('### Scheduler after the app is usable'),
    backup.indexOf('\n## CI proof'),
  );
  assert.match(section, /pin[^\n]*P7-0/i);
  assert.match(section, /older pin[^\n]*DRIFT|older pinned[^\n]*DRIFT/i);
  const runbook = readFileSync(
    new URL('../../docs/RESTORE-RUNBOOK.md', import.meta.url),
    'utf8',
  );
  const arabic = runbook.slice(
    runbook.indexOf('## 10.'),
    runbook.indexOf('## تمرين الاستعادة'),
  );
  assert.match(arabic, /P7-0/);
  assert.match(arabic, /DRIFT/);
});

test('p3: SCHEDULER_NET_UNSAFE docs and message distinguish missing backup_reader from proven net exposure', async () => {
  const { ensureScheduler } = await loadScheduler();
  const { query } = database({
    extensions: ['pg_net'],
    problems: 'pg_net is installed and backup_reader does not exist',
  });
  let thrown = null;
  try {
    ensureScheduler({ query, env: loopback });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown);
  assert.equal(thrown.code, 'SCHEDULER_NET_UNSAFE');
  assert.match(thrown.message, /backup_reader does not exist/);
  assert.doesNotMatch(thrown.message, /exposes request data to backup_reader/);

  const backup = readFileSync(
    new URL('../../docs/BACKUP.md', import.meta.url),
    'utf8',
  );
  const section = backup.slice(
    backup.indexOf('### Scheduler after the app is usable'),
    backup.indexOf('\n## CI proof'),
  );
  const reportBlock = section.slice(section.indexOf('Success prints'));
  assert.match(reportBlock, /backup_reader`? does not exist/);

  const runbook = readFileSync(
    new URL('../../docs/RESTORE-RUNBOOK.md', import.meta.url),
    'utf8',
  );
  const arabic = runbook.slice(
    runbook.indexOf('## 10.'),
    runbook.indexOf('## تمرين الاستعادة'),
  );
  const bullet = arabic.slice(
    arabic.indexOf('- لو الكود `SCHEDULER_NET_UNSAFE`'),
  );
  assert.match(bullet, /backup_reader/);
  assert.match(bullet, /provision-backup-reader\.sql/);
});
