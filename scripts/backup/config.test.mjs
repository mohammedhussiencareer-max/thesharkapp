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
  formatError,
  isLoopbackAddress,
  parseDbPort,
  parsePinnedMajor,
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
  assert.equal(formatError(error), 'backup: error [X]: plain message');
  assert.equal(
    formatError(new Error('boom')),
    'backup: error [INTERNAL]: boom',
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
