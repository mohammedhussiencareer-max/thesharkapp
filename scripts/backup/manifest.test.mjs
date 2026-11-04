import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildManifest, loadSql, readDriftFacts } from './manifest.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';

const cleanFacts = {
  schemas: ['app', 'auth', 'extensions', 'ledger_scratch', 'public'],
  publicObjects: [],
  extensions: ['btree_gist', 'plpgsql'],
  storageObjects: 0,
  cronJobs: 0,
  ownerLikeColumns: ['app.owner.user_id'],
  ownerFkMap: ['app.owner.user_id'],
  otherAuthRefs: [],
  missingAuditColumns: [],
};

function fakePsql({ facts = cleanFacts, owner = OWNER } = {}) {
  const calls = [];
  const psql = (call) => {
    calls.push(call);
    if (call.sql.includes('storage_objects')) {
      return `${JSON.stringify(facts)}\n`;
    }
    return `${JSON.stringify({
      db: { ownerUuid: owner, serverVersionNum: 170004, migrations: ['1'] },
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
    'snapshot',
    'migrations',
    'tables_q',
    'has_migrations',
    'has_storage',
    'can_storage',
    'storage_objects',
    'has_cron',
    'can_cron',
    'cron_jobs',
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
  assert.match(calls[0].sql, /storage_objects/);
  for (const call of calls) {
    assert.equal(call.vars.snapshot, '00000004-0000002A-1');
    assert.ok(JSON.parse(call.vars.audit_cols).length > 0);
  }
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
