import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MIGRATION_HASH_EXPR,
  buildManifest,
  checkMigrationEntries,
  listRepoMigrations,
  loadSql,
  pendingMigrations,
  readDriftFacts,
  readMigrationEntries,
} from './manifest.mjs';
import { OWNER_FK_COLUMNS } from './config.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';

const cleanFacts = {
  schemas: ['app', 'auth', 'extensions', 'ledger_scratch', 'public'],
  outOfScopeObjects: [],
  extensions: ['btree_gist', 'plpgsql'],
  storageBuckets: 0,
  ownerLikeColumns: ['app.owner.user_id'],
  ownerFkMap: [...OWNER_FK_COLUMNS],
  otherAuthRefs: [],
  missingAuditColumns: [],
};

function fakePsql({ facts = cleanFacts, owner = OWNER } = {}) {
  const calls = [];
  const psql = (call) => {
    calls.push(call);
    if (call.sql.includes('storage_buckets')) {
      return `${JSON.stringify(facts)}\n`;
    }
    return `${JSON.stringify({
      db: {
        ownerUuid: owner,
        serverVersionNum: 170004,
        migrations: ['1'],
        migrationEntries: [
          { version: '1', name: 'init', hash: 'a'.repeat(32) },
        ],
      },
      tables: { 'app.owner': { rows: 1, hash: 'h' } },
      sequences: {},
      fingerprint: {},
    })}\n`;
  };
  return { psql, calls };
}

const options = (psql, extra = {}) => ({
  psql,
  env: { BACKUP_APP_COMMIT: 'abcdef1234567' },
  clientVersions: { pg_dump: 'pg_dump (PostgreSQL) 17.2' },
  now: () => new Date('2026-11-04T02:17:00Z'),
  ...extra,
});

test('loadSql inlines the session prologue and leaves no include', () => {
  for (const name of ['manifest.sql', 'drift.sql']) {
    const sql = loadSql(name);
    assert.doesNotMatch(sql, /^\\ir/m);
    assert.match(sql, /begin isolation level repeatable read read only/);
    assert.match(sql, /set transaction snapshot/);
  }
});

test('the SQL files only use variables the builder provides', () => {
  const provided = new Set([
    'audit_cols',
    'platform_ext',
    'platform_owners',
    'platform_objects',
    'snapshot',
    'migrations',
    'migration_entries',
    'tables_q',
    'has_migrations',
    'has_buckets',
    'can_buckets',
    'storage_buckets',
  ]);
  for (const name of ['manifest.sql', 'drift.sql', 'session.sql']) {
    const text = readFileSync(
      new URL(`./sql/${name}`, import.meta.url),
      'utf8',
    );
    const used = [...text.matchAll(/(?<![:\w]):(?:'|\{\?)?([a-z_]+)/g)].map(
      (m) => m[1],
    );
    for (const variable of used) {
      assert.ok(provided.has(variable), `${name} uses :${variable}`);
    }
  }
});

test('the manifest merges metadata and runs drift first', () => {
  const { psql, calls } = fakePsql();
  const manifest = buildManifest(
    options(psql, { snapshot: '00000004-0000002A-1' }),
  );
  assert.equal(manifest.format, 1);
  assert.equal(manifest.createdAt, '2026-11-04T02:17:00.000Z');
  assert.equal(manifest.metadata.ownerUuid, OWNER);
  assert.equal(manifest.metadata.appCommit, 'abcdef1234567');
  assert.equal(manifest.metadata.pinnedMajor, 17);
  assert.ok(
    manifest.metadata.ownerAuditColumns.includes(
      'app.stock_movements.created_by',
    ),
  );
  assert.deepEqual(Object.keys(manifest.tables), ['app.owner']);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /storage_buckets/);
  assert.deepEqual(manifest.metadata.migrationEntries, [
    { version: '1', name: 'init', hash: 'a'.repeat(32) },
  ]);
  for (const call of calls) {
    assert.equal(call.vars.snapshot, '00000004-0000002A-1');
    assert.ok(JSON.parse(call.vars.audit_cols).length > 0);
    assert.ok(JSON.parse(call.vars.platform_owners).includes('supabase_admin'));
    assert.ok(!JSON.parse(call.vars.platform_owners).includes('postgres'));
    assert.ok(JSON.parse(call.vars.platform_objects).length > 0);
  }
});

test('the drift query reads application objects from every non-dumped schema', () => {
  const sql = loadSql('drift.sql');
  assert.doesNotMatch(sql, /n\.nspname = 'public'/);
  assert.match(sql, /not in \('information_schema', 'app', 'ledger_scratch'\)/);
  assert.match(sql, /deptype = 'e'/);
  assert.match(sql, /'outOfScopeObjects'/);
  assert.doesNotMatch(sql, /\bcron\b|storage\.objects|cron\.job/);
});

test('the dump never reads storage objects or cron jobs', () => {
  for (const name of ['drift.sql', 'manifest.sql', 'role-check.sql']) {
    const text = readFileSync(
      new URL(`./sql/${name}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(text, /storage\.objects|cron\.job/, name);
  }
});

test('the manifest SQL serialises bigint values as decimal strings', () => {
  const sql = loadSql('manifest.sql');
  assert.match(sql, /'lastValue', last_value::text/);
  for (const column of [
    'seqstart',
    'seqincrement',
    'seqmin',
    'seqmax',
    'seqcache',
  ]) {
    assert.match(sql, new RegExp(`ps\\.${column}::text`), column);
  }
  assert.doesNotMatch(sql, /'lastValue', last_value\)/);
});

test('migration hashes use one expression in the manifest SQL and the check', () => {
  assert.ok(loadSql('manifest.sql').includes(MIGRATION_HASH_EXPR));
  const calls = [];
  const entries = readMigrationEntries({
    psql: (call) => {
      calls.push(call);
      return `${JSON.stringify([entry('1', 'init', 'a')])}\n`;
    },
  });
  assert.deepEqual(entries, [entry('1', 'init', 'a')]);
  assert.ok(calls[0].sql.includes(MIGRATION_HASH_EXPR));
  assert.match(calls[0].sql, /'name', name/);
});

function entry(version, name, fill) {
  return { version, name, hash: fill.repeat(32) };
}

const backup = {
  metadata: {
    migrationEntries: [
      entry('1', 'init', 'a'),
      entry('2', 'costing', 'b'),
      entry('3', 'reports', 'c'),
    ],
  },
};

test('identical migrations under different version ids match by name and hash', () => {
  const result = checkMigrationEntries(backup, [
    entry('20261101000000', 'init', 'a'),
    entry('20261102000000', 'costing', 'b'),
    entry('20261103000000', 'reports', 'c'),
  ]);
  assert.deepEqual(result.differences, []);
  assert.equal(result.versionChanges.length, 3);
  assert.match(
    result.versionChanges[0],
    /init: backup version 1, this database 20261101000000/,
  );
  assert.deepEqual(
    result.matched.map((m) => m.version),
    ['20261101000000', '20261102000000', '20261103000000'],
  );
  const same = checkMigrationEntries(backup, backup.metadata.migrationEntries);
  assert.deepEqual(same.differences, []);
  assert.deepEqual(same.versionChanges, []);
});

test('a changed, missing or extra migration is named, whatever its version id', () => {
  const result = checkMigrationEntries(backup, [
    entry('11', 'init', 'a'),
    entry('12', 'costing', 'e'),
    entry('14', 'extra', 'd'),
  ]);
  assert.deepEqual(result.differences, [
    'costing has different statements',
    'extra is not in the backup',
    'reports is not in this database',
  ]);
  const sameVersionOtherName = checkMigrationEntries(backup, [
    entry('1', 'init', 'a'),
    entry('2', 'renamed', 'b'),
    entry('3', 'reports', 'c'),
  ]);
  assert.deepEqual(sameVersionOtherName.differences, [
    'costing is not in this database',
    'renamed is not in the backup',
  ]);
});

test('migrations applied in a different order are a difference', () => {
  const result = checkMigrationEntries(backup, [
    entry('12', 'init', 'a'),
    entry('11', 'costing', 'b'),
    entry('13', 'reports', 'c'),
  ]);
  assert.deepEqual(result.differences, [
    'costing is applied in a different order',
  ]);
  const numeric = checkMigrationEntries(
    {
      metadata: {
        migrationEntries: [entry('9', 'a', 'a'), entry('10', 'b', 'b')],
      },
    },
    [entry('9', 'a', 'a'), entry('10', 'b', 'b')],
  );
  assert.deepEqual(numeric.differences, []);
});

test('manifests and databases without usable migration entries are rejected', () => {
  for (const bad of [
    {},
    { metadata: {} },
    { metadata: { migrationHashes: { 1: 'a'.repeat(32) } } },
    { metadata: { migrationEntries: {} } },
    {
      metadata: { migrationEntries: [{ version: '1', hash: 'a'.repeat(32) }] },
    },
    {
      metadata: {
        migrationEntries: [{ version: '1', name: null, hash: 'a'.repeat(32) }],
      },
    },
    {
      metadata: {
        migrationEntries: [{ version: '1', name: 'x', hash: 'short' }],
      },
    },
    {
      metadata: {
        migrationEntries: [entry('1', 'x', 'a'), entry('2', 'x', 'a')],
      },
    },
    {
      metadata: {
        migrationEntries: [entry('1', 'x', 'a'), entry('1', 'y', 'a')],
      },
    },
  ]) {
    assert.throws(() => checkMigrationEntries(bad, []), {
      code: 'MANIFEST_INVALID',
    });
  }
  assert.throws(
    () =>
      checkMigrationEntries(backup, [
        { version: '1', name: null, hash: 'a'.repeat(32) },
      ]),
    { code: 'MIGRATIONS_INVALID' },
  );
});

test('pending migrations are the repository files whose names the backup lacks', () => {
  const repo = [
    { file: '1_init.sql', version: '1', name: 'init' },
    { file: '2_costing.sql', version: '2', name: 'costing' },
    { file: '4_new_thing.sql', version: '4', name: 'new_thing' },
    { file: '5_newer.sql', version: '5', name: 'newer' },
  ];
  const manifest = {
    metadata: {
      migrationEntries: [
        entry('900', 'init', 'a'),
        entry('901', 'costing', 'b'),
      ],
    },
  };
  assert.deepEqual(
    pendingMigrations(manifest, repo).map((m) => m.file),
    ['4_new_thing.sql', '5_newer.sql'],
  );
  assert.deepEqual(pendingMigrations(manifest, repo.slice(0, 2)), []);
  assert.throws(() => pendingMigrations(manifest, repo.slice(0, 1)), {
    code: 'MIGRATIONS_DIFFER',
    message: /costing/,
  });
});

test('every migration file in the repository is listed by version and name', () => {
  const files = listRepoMigrations();
  assert.ok(files.length > 0);
  for (const { file, version, name } of files) {
    assert.equal(file, `${version}_${name}.sql`);
  }
  assert.deepEqual(
    files.map((f) => f.version),
    [...files.map((f) => f.version)].sort(),
  );
});

test('drift stops the manifest before the main query', () => {
  const { psql, calls } = fakePsql({
    facts: { ...cleanFacts, schemas: [...cleanFacts.schemas, 'rogue'] },
  });
  assert.throws(() => buildManifest(options(psql)), {
    code: 'DRIFT',
    message: /schema rogue.*scripts\/backup/,
  });
  assert.equal(calls.length, 1);
});

test('the restore side can skip the drift guard', () => {
  const { psql, calls } = fakePsql({
    facts: { ...cleanFacts, schemas: ['rogue'] },
  });
  buildManifest(options(psql, { skipDrift: true }));
  assert.equal(calls.length, 1);
});

test('an empty owner table refuses the backup', () => {
  const { psql } = fakePsql({ owner: null });
  assert.throws(() => buildManifest(options(psql)), { code: 'NO_OWNER' });
});

test('a malformed snapshot id is rejected before psql runs', () => {
  const { psql, calls } = fakePsql();
  assert.throws(() => readDriftFacts({ psql, snapshot: "1'; drop" }), {
    code: 'BAD_SNAPSHOT',
  });
  assert.equal(calls.length, 0);
});

test('empty psql output is an error, not a manifest', () => {
  assert.throws(() => buildManifest(options(() => '', { skipDrift: true })), {
    code: 'MANIFEST_QUERY_FAILED',
  });
});
