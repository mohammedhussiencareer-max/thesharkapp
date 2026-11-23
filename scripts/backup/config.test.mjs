import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertMajors,
  BackupError,
  checkDumpTarget,
  checkRestoreTarget,
  clientMajor,
  diagnosticsAllowed,
  FORBIDDEN_EXTENSIONS,
  FORBIDDEN_USAGE_SCHEMAS,
  formatError,
  isLoopbackAddress,
  parseDbPort,
  parsePinnedMajor,
  PLATFORM_EXTENSIONS,
  repoRoot,
  RESTORE_CONFIRM,
  serverMajor,
} from './config.mjs';
import { sanitizeStderr } from './sanitize.mjs';

const remote = {
  PGHOST: 'aws-0-eu-central-1.pooler.supabase.com',
  PGUSER: 'backup_reader.abcdefghijklmnop',
  PGPASSWORD: 'x',
  PGDATABASE: 'postgres',
};
const local = {
  PGHOST: '127.0.0.1',
  PGUSER: 'postgres',
  PGPASSWORD: 'postgres',
  PGDATABASE: 'postgres',
  PGSSLMODE: 'disable',
};

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BackupError);
    return error.code;
  }
  return null;
}

test('parsePinnedMajor reads major_version from [db] only', () => {
  const toml = [
    '[api]',
    'major_version = 99',
    '[db]',
    'port = 55422 # comment',
    'major_version = 17',
    '[db.pooler]',
    'major_version = 15',
  ].join('\n');
  assert.equal(parsePinnedMajor(toml), 17);
  assert.equal(parseDbPort(toml), 55422);
});

test('parsePinnedMajor rejects a missing or non-numeric value', () => {
  assert.equal(
    codeOf(() => parsePinnedMajor('[db]\nport = 1')),
    'CONFIG',
  );
  assert.equal(
    codeOf(() => parsePinnedMajor('[db]\nmajor_version = "17"')),
    'CONFIG',
  );
  assert.equal(
    codeOf(() => parsePinnedMajor('major_version = 17')),
    'CONFIG',
  );
});

test('the repository config.toml pins PostgreSQL 17', () => {
  const toml = readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8');
  assert.equal(parsePinnedMajor(toml), 17);
  assert.ok(parseDbPort(toml) > 0);
});

test('serverMajor and clientMajor', () => {
  assert.equal(serverMajor('170006'), 17);
  assert.equal(serverMajor(180001), 18);
  assert.equal(
    codeOf(() => serverMajor('abc')),
    'CONFIG',
  );
  assert.equal(
    codeOf(() => serverMajor('90600')),
    'CONFIG',
  );
  assert.equal(clientMajor('pg_dump (PostgreSQL) 17.6 (Debian 17.6-1)'), 17);
  assert.equal(clientMajor('psql (PostgreSQL) 18beta1'), 18);
  assert.equal(
    codeOf(() => clientMajor('something else')),
    'CONFIG',
  );
});

test('assertMajors names the mismatch', () => {
  const ok = { pg_dump: 'pg_dump (PostgreSQL) 17.5' };
  assert.doesNotThrow(() =>
    assertMajors({ pinned: 17, serverNum: '170005', clientVersions: ok }),
  );
  assert.equal(
    codeOf(() => assertMajors({ pinned: 17, serverNum: '180000' })),
    'MAJOR_MISMATCH',
  );
  assert.equal(
    codeOf(() =>
      assertMajors({
        pinned: 17,
        serverNum: '170005',
        clientVersions: { pg_dump: 'pg_dump (PostgreSQL) 16.4' },
      }),
    ),
    'CLIENT_MAJOR_MISMATCH',
  );
});

test('isLoopbackAddress', () => {
  for (const host of [
    '',
    'localhost',
    'LOCALHOST.',
    '127.0.0.1',
    '127.1',
    '127.255.255.254',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '0.0.0.0',
    '/var/run/postgresql',
  ]) {
    assert.equal(isLoopbackAddress(host), true, host);
  }
  for (const host of [
    'db.example.com',
    '127.0.0.1.evil.com',
    'localhost.evil.com',
    '128.0.0.1',
    '127.0.0.256',
    '10.0.0.1',
    '::2',
    '::ffff:10.0.0.1',
    'aws-0-eu-central-1.pooler.supabase.com',
  ]) {
    assert.equal(isLoopbackAddress(host), false, host);
  }
});

test('dump refuses loopback unless BACKUP_ALLOW_LOOPBACK=1', () => {
  assert.equal(
    codeOf(() => checkDumpTarget(local)),
    'LOOPBACK_REFUSED',
  );
  assert.equal(
    codeOf(() => checkDumpTarget({ ...local, PGHOST: '' })),
    'ENV_MISSING',
  );
  assert.equal(
    codeOf(() =>
      checkDumpTarget({ ...local, PGHOST: 'localhost,db.example.com' }),
    ),
    'LOOPBACK_REFUSED',
  );
  assert.equal(
    codeOf(() =>
      checkDumpTarget({
        ...remote,
        PGHOSTADDR: '127.0.0.1',
        PGSSLMODE: 'verify-full',
      }),
    ),
    'LOOPBACK_REFUSED',
  );
  const allowed = checkDumpTarget({ ...local, BACKUP_ALLOW_LOOPBACK: '1' });
  assert.deepEqual(allowed, { loopback: true, enforceRole: false });
  const forced = checkDumpTarget({
    ...local,
    BACKUP_ALLOW_LOOPBACK: '1',
    BACKUP_FORCE_ROLE_CHECK: '1',
  });
  assert.equal(forced.enforceRole, true);
  // A reader dump always runs the role check, even through a loopback tunnel
  // with local-test mode on; the hosted pooler user is backup_reader.<ref>.
  for (const PGUSER of ['backup_reader', 'backup_reader.abcdefghijklmnop']) {
    const reader = checkDumpTarget({
      ...local,
      PGUSER,
      BACKUP_ALLOW_LOOPBACK: '1',
    });
    assert.equal(reader.enforceRole, true, PGUSER);
  }
});

test('dump to a remote host needs verified TLS and enforces the role check', () => {
  assert.deepEqual(checkDumpTarget(remote), {
    loopback: false,
    enforceRole: true,
  });
  assert.equal(
    codeOf(() => checkDumpTarget({ ...remote, PGSSLMODE: 'require' })),
    'SSLMODE_WEAK',
  );
  assert.equal(
    codeOf(() => checkDumpTarget({ ...remote, PGSSLMODE: 'disable' })),
    'SSLMODE_WEAK',
  );
  assert.doesNotThrow(() =>
    checkDumpTarget({ ...remote, PGSSLMODE: 'verify-ca' }),
  );
});

test('mixed loopback and remote target lists enforce the role check and verified TLS', () => {
  for (const mixed of [
    {
      ...local,
      PGHOST: '127.0.0.1,aws-0-eu-central-1.pooler.supabase.com',
      PGSSLMODE: 'verify-full',
      BACKUP_ALLOW_LOOPBACK: '1',
    },
    {
      ...local,
      PGHOST: '127.0.0.1',
      PGHOSTADDR: '203.0.113.10',
      PGSSLMODE: 'verify-full',
      BACKUP_ALLOW_LOOPBACK: '1',
    },
    {
      ...remote,
      PGHOSTADDR: '127.0.0.1',
      PGSSLMODE: 'verify-full',
      BACKUP_ALLOW_LOOPBACK: '1',
    },
    {
      ...local,
      PGHOST: 'localhost,db.example.com',
      PGHOSTADDR: '127.0.0.1,203.0.113.10',
      PGSSLMODE: 'verify-ca',
      BACKUP_ALLOW_LOOPBACK: '1',
    },
  ]) {
    assert.deepEqual(
      checkDumpTarget(mixed),
      { loopback: false, enforceRole: true },
      JSON.stringify({ PGHOST: mixed.PGHOST, PGHOSTADDR: mixed.PGHOSTADDR }),
    );
  }
  assert.equal(
    codeOf(() =>
      checkDumpTarget({
        ...local,
        PGHOST: '127.0.0.1,db.example.com',
        PGSSLMODE: 'disable',
        BACKUP_ALLOW_LOOPBACK: '1',
      }),
    ),
    'SSLMODE_WEAK',
  );
  assert.deepEqual(
    checkDumpTarget({
      ...local,
      PGHOST: '127.0.0.1,localhost',
      PGHOSTADDR: '127.0.0.1,::1',
      BACKUP_ALLOW_LOOPBACK: '1',
    }),
    { loopback: true, enforceRole: false },
  );
});

test('parseProjectId reads top-level project_id from config.toml', async () => {
  const mod = await import('./config.mjs');
  assert.equal(typeof mod.parseProjectId, 'function');
  assert.equal(
    mod.parseProjectId('project_id = "thesharkapp" # comment\n[db]\nport = 1'),
    'thesharkapp',
  );
  assert.equal(
    codeOf(() => mod.parseProjectId('[db]\nproject_id = "wrong"\n')),
    'CONFIG',
  );
  assert.equal(
    codeOf(() => mod.parseProjectId('project_id = "bad id!"\n')),
    'CONFIG',
  );
  const toml = readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8');
  assert.equal(mod.parseProjectId(toml), 'thesharkapp');
});

test('connection env is required and PGSERVICE is forbidden', () => {
  for (const key of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
    const env = { ...remote };
    delete env[key];
    assert.equal(
      codeOf(() => checkDumpTarget(env)),
      'ENV_MISSING',
      key,
    );
    assert.equal(
      codeOf(() => checkRestoreTarget(env)),
      'ENV_MISSING',
      key,
    );
  }
  assert.equal(
    codeOf(() => checkDumpTarget({ ...remote, PGSERVICE: 'prod' })),
    'SERVICE_FORBIDDEN',
  );
  assert.equal(
    codeOf(() => checkRestoreTarget({ ...local, PGSERVICE: 'prod' })),
    'SERVICE_FORBIDDEN',
  );
});

test('restore into a remote host needs the exact confirmation', () => {
  assert.deepEqual(checkRestoreTarget(local), { loopback: true });
  assert.equal(
    codeOf(() => checkRestoreTarget(remote)),
    'RESTORE_CONFIRM_REQUIRED',
  );
  assert.equal(
    codeOf(() =>
      checkRestoreTarget({ ...remote, BACKUP_RESTORE_CONFIRM: 'yes' }),
    ),
    'RESTORE_CONFIRM_REQUIRED',
  );
  assert.deepEqual(
    checkRestoreTarget({ ...remote, BACKUP_RESTORE_CONFIRM: RESTORE_CONFIRM }),
    { loopback: false },
  );
  assert.equal(
    codeOf(() =>
      checkRestoreTarget({
        ...remote,
        BACKUP_RESTORE_CONFIRM: RESTORE_CONFIRM,
        PGSSLMODE: 'prefer',
      }),
    ),
    'SSLMODE_WEAK',
  );
  assert.equal(
    codeOf(() => checkRestoreTarget({ ...local, PGHOSTADDR: '203.0.113.10' })),
    'RESTORE_CONFIRM_REQUIRED',
  );
});

test('formatError never includes the connection values', () => {
  const error = new BackupError('X', 'plain message');
  assert.equal(formatError(error, {}), 'backup: error [X]: plain message');
  assert.equal(
    formatError(new Error('boom'), {}),
    'backup: error [INTERNAL]: an internal error occurred',
  );
});

test('an error message is always one line, so no line can pose as a second error', () => {
  const error = new BackupError(
    'X',
    'first\nbackup: error [FAKE]: PRIVATE-DATA\r\nlast\u2028end\u001b[31m',
  );
  const out = formatError(error, {});
  assert.ok(!/[\r\n\u2028\u001b]/.test(out), JSON.stringify(out));
  assert.ok(out.startsWith('backup: error [X]: first '));
});

test('diagnostics stay off when any effective host is remote', () => {
  const base = {
    BACKUP_SYNTHETIC_DIAGNOSTICS: '1',
    BACKUP_ALLOW_LOOPBACK: '1',
    PGHOST: '127.0.0.1',
  };
  assert.equal(
    diagnosticsAllowed({ ...base, PGHOSTADDR: '203.0.113.10' }),
    false,
  );
  assert.equal(
    formatError(new Error('PRIVATE-SERVER-TEXT'), {
      ...base,
      PGHOSTADDR: '203.0.113.10',
    }),
    'backup: error [INTERNAL]: an internal error occurred',
  );
  assert.equal(diagnosticsAllowed({ ...base, PGSERVICE: 'prod' }), false);
  assert.equal(
    diagnosticsAllowed({
      ...base,
      PGDATABASE: 'postgresql://backup_reader@db.example.com/postgres',
    }),
    false,
  );
  assert.equal(diagnosticsAllowed(base), true);
});

test('diagnostics stay off when a URI lists 127.0.0.1:5432 and then a remote host', () => {
  const base = {
    BACKUP_SYNTHETIC_DIAGNOSTICS: '1',
    BACKUP_ALLOW_LOOPBACK: '1',
    PGHOST: '127.0.0.1',
  };
  assert.equal(
    diagnosticsAllowed({
      ...base,
      PGDATABASE: 'postgresql://127.0.0.1:5432,db.example.com/postgres',
    }),
    false,
  );
  assert.equal(
    diagnosticsAllowed({
      ...base,
      PGDATABASE: 'host=127.0.0.1:5432,db.example.com dbname=postgres',
    }),
    false,
  );
});

test('diagnostics stay off when a URI has a remote hostaddr parameter', () => {
  assert.equal(
    diagnosticsAllowed({
      BACKUP_SYNTHETIC_DIAGNOSTICS: '1',
      BACKUP_ALLOW_LOOPBACK: '1',
      PGHOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://127.0.0.1/postgres?hostaddr=203.0.113.10',
    }),
    false,
  );
});

test('diagnostics stay off when PGDATABASE is service=fixture', () => {
  const base = {
    BACKUP_SYNTHETIC_DIAGNOSTICS: '1',
    BACKUP_ALLOW_LOOPBACK: '1',
    PGHOST: '127.0.0.1',
  };
  assert.deepEqual(
    {
      service: diagnosticsAllowed({ ...base, PGDATABASE: 'service=fixture' }),
      url: diagnosticsAllowed({ ...base, DATABASE_URL: 'service=fixture' }),
      scheme: diagnosticsAllowed({
        ...base,
        DATABASE_URL: 'socket://127.0.0.1/postgres',
      }),
      name: diagnosticsAllowed({ ...base, PGDATABASE: 'postgres' }),
    },
    { service: false, url: false, scheme: false, name: true },
  );
});

test('internal error text is printed only for the synthetic loopback round trip', () => {
  const synthetic = {
    BACKUP_SYNTHETIC_DIAGNOSTICS: '1',
    BACKUP_ALLOW_LOOPBACK: '1',
    PGHOST: '127.0.0.1',
  };
  assert.equal(diagnosticsAllowed(synthetic), true);
  assert.equal(
    formatError(new Error('boom'), synthetic),
    'backup: error [INTERNAL]: boom',
  );
  for (const change of [
    { BACKUP_SYNTHETIC_DIAGNOSTICS: undefined },
    { BACKUP_SYNTHETIC_DIAGNOSTICS: '0' },
    { BACKUP_ALLOW_LOOPBACK: undefined },
    { PGHOST: 'db.example.com' },
    { PGHOST: undefined },
    { BACKUP_PRINT_STDERR: '1', BACKUP_SYNTHETIC_DIAGNOSTICS: undefined },
  ]) {
    const env = { ...synthetic, ...change };
    assert.equal(diagnosticsAllowed(env), false, JSON.stringify(change));
    assert.equal(
      formatError(new Error('PRIVATE-DATA'), env),
      'backup: error [INTERNAL]: an internal error occurred',
    );
  }
});

test('pg_cron and pg_net stay platform extensions and are not forbidden', () => {
  // Kept after ensure-scheduler stopped installing extensions.
  assert.equal(FORBIDDEN_EXTENSIONS.includes('pg_cron'), false);
  assert.equal(FORBIDDEN_EXTENSIONS.includes('pg_net'), false);
  assert.equal(PLATFORM_EXTENSIONS.includes('pg_cron'), true);
  assert.equal(PLATFORM_EXTENSIONS.includes('pg_net'), true);
  assert.deepEqual(
    [...FORBIDDEN_USAGE_SCHEMAS],
    ['auth', 'cron', 'net', 'vault'],
  );
});

test('sanitizeStderr keeps only error lines and masks hosts and values', () => {
  const text = [
    'pg_dump: error: connection to server at "db.secret.example.com" (1.2.3.4), port 5432 failed: FATAL:  password authentication failed',
    'DETAIL:  Key (id)=(abc) already exists.',
    'ERROR:  duplicate key value violates unique constraint "k"',
    'CONTEXT:  COPY t, line 3: "customer data"',
    'Query was: select 1',
    'psql: error: Key (name)=(Ahmed) is not present',
  ].join('\n');
  const out = sanitizeStderr(text);
  assert.ok(out.includes('<host>'));
  assert.ok(!out.includes('secret.example.com'));
  assert.ok(!out.includes('1.2.3.4'));
  assert.ok(!out.includes('customer data'));
  assert.ok(!out.includes('Ahmed'));
  assert.ok(!out.includes('abc'));
  assert.ok(!out.includes('CONTEXT'));
  assert.ok(!out.includes('select 1'));
  assert.ok(out.includes('DETAIL:  Key (<redacted>)=(<redacted>) already'));
  assert.ok(out.includes('ERROR:  duplicate key'));
});
