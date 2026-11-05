import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkRole,
  checkTargetEmpty,
  majorArgs,
  prepareRestore,
  readServerVersionNum,
} from './guard.mjs';

const safeRole = {
  canLogin: true,
  bypassRls: true,
  super: false,
  createRole: false,
  createDb: false,
  replication: false,
  memberships: [],
  writable: [],
  sequenceWrite: [],
  storageAccess: [],
  schemaCreate: [],
  forbiddenUsage: [],
};

test('the role check asks about the forbidden platform schemas', () => {
  const calls = [];
  const psql = (call) => {
    calls.push(call);
    return `${JSON.stringify(safeRole)}\n`;
  };
  checkRole(psql);
  assert.deepEqual(JSON.parse(calls[0].vars.forbidden_usage), [
    'auth',
    'cron',
    'net',
    'vault',
  ]);
  assert.throws(
    () =>
      checkRole(() =>
        JSON.stringify({ ...safeRole, forbiddenUsage: ['cron'] }),
      ),
    { code: 'ROLE_UNSAFE', message: /platform schemas: cron/ },
  );
});

test('server version is read from the first output line', () => {
  assert.equal(
    readServerVersionNum(() => '170004\n'),
    '170004',
  );
});

test('a safe backup role passes the role check', () => {
  assert.doesNotThrow(() => checkRole(() => `${JSON.stringify(safeRole)}\n`));
});

test('a writable or superuser role fails the role check', () => {
  const bad = { ...safeRole, super: true, writable: ['stock_items'] };
  assert.throws(() => checkRole(() => JSON.stringify(bad)), {
    code: 'ROLE_UNSAFE',
    message: /SUPERUSER.*stock_items/,
  });
  assert.throws(() => checkRole(() => 'not json'), {
    code: 'ROLE_QUERY_FAILED',
  });
});

test('an empty target passes and a populated one is refused', () => {
  assert.doesNotThrow(() => checkTargetEmpty(() => ''));
  assert.throws(() => checkTargetEmpty(() => 'app\nledger_scratch\n'), {
    code: 'TARGET_NOT_EMPTY',
    message: /app, ledger_scratch/,
  });
});

test('restore prep creates missing extensions and placeholder roles only', () => {
  const calls = [];
  const psql = (call) => {
    calls.push(call);
    if (call.sql.includes('pg_roles')) {
      return 'anon\nauthenticated\npostgres\nservice_role\n';
    }
    if (call.sql.includes('pg_extension')) {
      return 'plpgsql\n';
    }
    return '';
  };
  const plan = prepareRestore({
    metadata: {
      extensions: [{ name: 'btree_gist', schema: 'extensions' }],
      aclRoles: ['anon', 'backup_reader', 'postgres'],
    },
    psql,
  });
  assert.deepEqual(plan.extensions, ['btree_gist']);
  assert.deepEqual(plan.roles, ['backup_reader']);
  const run = calls.at(-1);
  assert.equal(run.singleTransaction, true);
  assert.match(run.sql, /create extension if not exists "btree_gist"/);
  assert.match(run.sql, /create role "backup_reader" nologin/);
});

test('restore prep runs nothing when the target is ready', () => {
  const calls = [];
  prepareRestore({
    metadata: { extensions: [], aclRoles: [] },
    psql: (call) => {
      calls.push(call);
      return '';
    },
  });
  assert.equal(calls.length, 2);
});

test('client version arguments split on the first equals sign', () => {
  assert.deepEqual(
    majorArgs(['170004', 'pg_dump=pg_dump (PostgreSQL) 17.2', 'psql=a=b']),
    {
      serverNum: '170004',
      clientVersions: { pg_dump: 'pg_dump (PostgreSQL) 17.2', psql: 'a=b' },
    },
  );
  assert.throws(() => majorArgs(['170004', 'nonsense']), { code: 'USAGE' });
});
