import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNoDrift,
  assertRoleSafe,
  evaluateDrift,
  evaluateRole,
  planRestorePrep,
} from './checks.mjs';
import { FORBIDDEN_USAGE_SCHEMAS, OWNER_FK_COLUMNS } from './config.mjs';

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
  outOfScopeObjects: [],
  extensions: ['btree_gist', 'pg_graphql', 'pgcrypto', 'plpgsql', 'uuid-ossp'],
  storageBuckets: 0,
  ownerLikeColumns: [
    'app.owner.user_id',
    'app.stock_movements.created_by',
    'app.costing_changes.actor_id',
  ],
  ownerFkMap: [...OWNER_FK_COLUMNS],
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
    outOfScopeObjects: ['public.table notes'],
    extensions: [...clean.extensions, 'postgis'],
    storageBuckets: 3,
    ownerLikeColumns: [...clean.ownerLikeColumns, 'app.reports.reviewed_by'],
    otherAuthRefs: ['app.x.session_id'],
    missingAuditColumns: ['app.gone.created_by'],
  };
  const violations = evaluateDrift(drifted);
  assert.equal(violations.length, 7);
  for (const needle of [
    'schema analytics_app',
    'scope: public.table notes',
    'extension postgis',
    'storage holds 3 bucket',
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
  assert.deepEqual(evaluateDrift({ storageBuckets: 0 }), []);
});

test('application objects in a platform schema are named, whatever the schema', () => {
  const found = [
    'extensions.table business_records',
    'auth.view customer_view',
    'storage.function export_rows',
    'realtime.sequence orders_seq',
    'vault.matview totals',
  ];
  const violations = evaluateDrift({ ...clean, outOfScopeObjects: found });
  assert.equal(violations.length, found.length);
  for (const object of found) {
    assert.ok(
      violations.some((v) => v.includes(object)),
      object,
    );
  }
  assert.equal(
    codeOf(() =>
      assertNoDrift({
        ...clean,
        outOfScopeObjects: ['extensions.table business_records'],
      }),
    ),
    'DRIFT',
  );
});

test('pg_cron and pg_net fail the guard with their own message', () => {
  for (const extension of ['pg_cron', 'pg_net']) {
    const violations = evaluateDrift({
      ...clean,
      extensions: [...clean.extensions, extension],
    });
    assert.equal(violations.length, 1, extension);
    assert.match(
      violations[0],
      new RegExp(`extension ${extension} is installed`),
    );
  }
});

test('storage buckets fail the guard, and so does a count that is unavailable', () => {
  assert.deepEqual(evaluateDrift({ ...clean, storageBuckets: 0 }), []);
  const violations = evaluateDrift({ ...clean, storageBuckets: 1 });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /storage holds 1 bucket/);
  for (const unavailable of [-1, undefined, null, NaN, '0', 1.5]) {
    const found = evaluateDrift({ ...clean, storageBuckets: unavailable });
    assert.equal(found.length, 1, String(unavailable));
    assert.match(found[0], /storage bucket count is unavailable/);
  }
  assert.equal(
    codeOf(() => assertNoDrift({ ...clean, storageBuckets: -1 })),
    'DRIFT',
  );
});

test('owner foreign keys must be on the maintained allowlist', () => {
  const unknown = evaluateDrift({
    ...clean,
    ownerFkMap: [...clean.ownerFkMap, 'app.stock_items.supplier_user'],
    ownerLikeColumns: [
      ...clean.ownerLikeColumns,
      'app.stock_items.supplier_user',
    ],
  });
  assert.equal(unknown.length, 1);
  assert.match(
    unknown[0],
    /app\.stock_items\.supplier_user references auth\.users but is not in the owner column allowlist/,
  );
  const fkAsAudit = evaluateDrift({
    ...clean,
    ownerFkMap: [...clean.ownerFkMap, 'app.purchases.created_by'],
  });
  assert.deepEqual(fkAsAudit, []);
});

test('an owner-like column is rejected unless the allowlist names it', () => {
  const violations = evaluateDrift({
    ...clean,
    ownerLikeColumns: [...clean.ownerLikeColumns, 'app.reports.approved_by'],
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /app\.reports\.approved_by looks like an owner/);
});

test('an allowlisted owner FK that no longer references auth.users is named', () => {
  const violations = evaluateDrift({
    ...clean,
    ownerFkMap: clean.ownerFkMap.filter(
      (ref) => ref !== 'app.item_opening_prices.approved_by',
    ),
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /app\.item_opening_prices\.approved_by does not/);
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
  sequenceWrite: [],
  executable: [],
  storageAccess: [],
  schemaCreate: [],
  forbiddenUsage: [],
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
    sequenceWrite: ['app.stock_items_seq'],
    executable: ['app.rename_expense_category(p_id uuid, p_name text)'],
    storageAccess: ['objects'],
    schemaCreate: ['app'],
    forbiddenUsage: ['vault'],
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

test('every forbidden platform schema is named when the role can enter it', () => {
  assert.deepEqual(
    [...FORBIDDEN_USAGE_SCHEMAS],
    ['auth', 'cron', 'net', 'vault'],
  );
  for (const schema of FORBIDDEN_USAGE_SCHEMAS) {
    const violations = evaluateRole({ ...safeRole, forbiddenUsage: [schema] });
    assert.equal(violations.length, 1, schema);
    assert.ok(violations[0].includes(schema), schema);
  }
});

test('column writes, sequence use and extra storage access are named', () => {
  const column = evaluateRole({ ...safeRole, writable: ['stock_items'] });
  assert.match(column[0], /write to app tables or columns: stock_items/);
  const sequence = evaluateRole({
    ...safeRole,
    sequenceWrite: ['app.a_seq', 'ledger_scratch.b_seq'],
  });
  assert.match(sequence[0], /sequences: app\.a_seq, ledger_scratch\.b_seq/);
  const storage = evaluateRole({
    ...safeRole,
    storageAccess: ['buckets.name', 'objects'],
  });
  assert.match(
    storage[0],
    /storage beyond buckets\(id\): buckets\.name, objects/,
  );
});

test('an executable application function is named and the list is capped', () => {
  const one = evaluateRole({
    ...safeRole,
    executable: ['app.rename_expense_category(p_id uuid, p_name text)'],
  });
  assert.equal(one.length, 1);
  assert.match(
    one[0],
    /execute application functions: app\.rename_expense_category\(p_id uuid, p_name text\)$/,
  );
  const many = evaluateRole({
    ...safeRole,
    executable: Array.from({ length: 25 }, (_, i) => `app.f${i}()`),
  });
  assert.equal(many.length, 1);
  assert.match(many[0], /app\.f9\(\) \(and 15 more\)$/);
  assert.doesNotMatch(many[0], /app\.f10\(\)/);
  assert.equal(
    codeOf(() =>
      assertRoleSafe({ ...safeRole, executable: ['public.definer()'] }),
    ),
    'ROLE_UNSAFE',
  );
});

test('a role check that omits a fact fails closed', () => {
  for (const key of [
    'memberships',
    'writable',
    'sequenceWrite',
    'executable',
    'storageAccess',
    'schemaCreate',
    'forbiddenUsage',
  ]) {
    const { [key]: omitted, ...rest } = safeRole;
    assert.equal(omitted.length, 0);
    const violations = evaluateRole(rest);
    assert.equal(violations.length, 1, key);
    assert.match(violations[0], new RegExp(`did not report ${key}`));
  }
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
