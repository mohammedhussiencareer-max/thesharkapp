import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNoDrift,
  assertRoleSafe,
  evaluateDrift,
  evaluateRole,
  planRestorePrep,
} from './checks.mjs';

const clean = {
  schemas: [
    '_realtime',
    'app',
    'auth',
    'extensions',
    'graphql',
    'graphql_public',
    'ledger_scratch',
    'public',
    'realtime',
    'storage',
    'supabase_migrations',
    'vault',
  ],
  publicObjects: [],
  extensions: ['btree_gist', 'pg_graphql', 'pgcrypto', 'plpgsql', 'uuid-ossp'],
  storageObjects: 0,
  cronJobs: 0,
  ownerLikeColumns: [
    'app.owner.user_id',
    'app.stock_movements.created_by',
    'app.costing_changes.actor_id',
  ],
  ownerFkMap: ['app.owner.user_id', 'app.costing_changes.actor_id'],
  otherAuthRefs: [],
  missingAuditColumns: [],
};

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

test('a clean Supabase project has no drift, platform schemas included', () => {
  assert.deepEqual(evaluateDrift(clean), []);
  assert.doesNotThrow(() => assertNoDrift(clean));
});

test('every kind of out-of-scope object is named with the fix', () => {
  const drifted = {
    ...clean,
    schemas: [...clean.schemas, 'analytics_app'],
    publicObjects: ['r notes'],
    extensions: [...clean.extensions, 'postgis'],
    storageObjects: 3,
    cronJobs: 2,
    ownerLikeColumns: [...clean.ownerLikeColumns, 'app.reports.reviewed_by'],
    otherAuthRefs: ['app.x.session_id'],
    missingAuditColumns: ['app.gone.created_by'],
  };
  const violations = evaluateDrift(drifted);
  assert.equal(violations.length, 8);
  for (const needle of [
    'schema analytics_app',
    'public: r notes',
    'extension postgis',
    'storage holds 3',
    '2 cron job',
    'app.reports.reviewed_by',
    'app.x.session_id',
    'app.gone.created_by',
  ]) {
    assert.ok(
      violations.some((v) => v.includes(needle)),
      needle,
    );
  }
  try {
    assertNoDrift(drifted);
    assert.fail('expected a drift error');
  } catch (error) {
    assert.equal(error.code, 'DRIFT');
    assert.match(error.message, /update scripts\/backup\/config\.mjs/);
  }
});

test('missing fact arrays are treated as empty', () => {
  assert.deepEqual(evaluateDrift({ storageObjects: 0, cronJobs: 0 }), []);
});

const safeRole = {
  canLogin: true,
  bypassRls: true,
  super: false,
  createRole: false,
  createDb: false,
  replication: false,
  memberships: [],
  writable: [],
  schemaCreate: [],
};

test('the read-only backup role passes', () => {
  assert.deepEqual(evaluateRole(safeRole), []);
  assert.doesNotThrow(() => assertRoleSafe(safeRole));
});

test('each unsafe role attribute is rejected', () => {
  const cases = {
    canLogin: false,
    bypassRls: false,
    super: true,
    createRole: true,
    createDb: true,
    replication: true,
    memberships: ['pg_read_all_data'],
    writable: ['stock_items'],
    schemaCreate: ['app'],
  };
  for (const [key, value] of Object.entries(cases)) {
    const violations = evaluateRole({ ...safeRole, [key]: value });
    assert.equal(violations.length, 1, key);
  }
  assert.equal(
    codeOf(() => assertRoleSafe({ ...safeRole, super: true })),
    'ROLE_UNSAFE',
  );
  assert.equal(
    codeOf(() => assertRoleSafe(null)),
    'ROLE_UNSAFE',
  );
});

const metadata = {
  extensions: [
    { name: 'btree_gist', version: '1.7', schema: 'extensions' },
    { name: 'pgcrypto', version: '1.3', schema: 'extensions' },
    { name: 'plpgsql', version: '1.0', schema: 'pg_catalog' },
  ],
  aclRoles: [
    'anon',
    'authenticated',
    'backup_reader',
    'postgres',
    'service_role',
  ],
};
const platformRoles = ['anon', 'authenticated', 'postgres', 'service_role'];

test('restore prep creates app extensions and placeholder roles only', () => {
  const plan = planRestorePrep({ metadata, existingRoles: platformRoles });
  assert.deepEqual(plan.extensions, ['btree_gist']);
  assert.deepEqual(plan.roles, ['backup_reader']);
  assert.equal(
    plan.sql,
    [
      'create extension if not exists "btree_gist" with schema "extensions";',
      'create role "backup_reader" nologin;',
    ].join('\n'),
  );
});

test('restore prep is a no-op when everything exists', () => {
  const plan = planRestorePrep({
    metadata,
    existingRoles: [...platformRoles, 'backup_reader'],
    existingExtensions: ['btree_gist'],
  });
  assert.equal(plan.sql, '');
});

test('restore prep refuses a missing platform role or unknown extension', () => {
  assert.equal(
    codeOf(() => planRestorePrep({ metadata, existingRoles: ['anon'] })),
    'ROLE_MISSING',
  );
  assert.equal(
    codeOf(() =>
      planRestorePrep({
        metadata: {
          ...metadata,
          extensions: [{ name: 'postgis', schema: 'public' }],
        },
        existingRoles: platformRoles,
      }),
    ),
    'RESTORE_UNKNOWN_EXTENSION',
  );
});

test('restore prep rejects names that are not plain identifiers', () => {
  assert.equal(
    codeOf(() =>
      planRestorePrep({
        metadata: { aclRoles: ['evil"; drop schema app'] },
      }),
    ),
    'BAD_IDENT',
  );
  assert.equal(
    codeOf(() =>
      planRestorePrep({
        metadata: {
          extensions: [{ name: 'btree_gist', schema: 'x"; select' }],
        },
      }),
    ),
    'BAD_IDENT',
  );
});
