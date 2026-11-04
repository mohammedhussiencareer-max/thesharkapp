import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoDrift } from './checks.mjs';
import {
  BackupError,
  OWNER_AUDIT_COLUMNS,
  PLATFORM_EXTENSIONS,
  PLATFORM_OBJECT_OWNERS,
  PLATFORM_POSTGRES_OBJECTS,
  SCOPE_SCHEMAS,
  isMain,
  readPinnedMajor,
  repoRoot,
  runCli,
} from './config.mjs';
import { runPsql } from './psql.mjs';

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), 'sql');
const SNAPSHOT = /^[0-9A-Fa-f]{1,16}(-[0-9A-Fa-f]{1,16}){1,2}$/;

export function loadSql(name, dir = sqlDir) {
  const text = readFileSync(join(dir, name), 'utf8');
  return text.replace(/^\\ir[ \t]+(\S+)[ \t]*$/gm, (_, include) =>
    loadSql(include, dir),
  );
}

function lastLine(output, code) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new BackupError(code, 'psql returned no output');
  }
  return lines[lines.length - 1];
}

function parseJson(output, code) {
  try {
    return JSON.parse(lastLine(output, code));
  } catch (error) {
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError(code, 'psql output is not valid JSON');
  }
}

function queryVars(snapshot) {
  const vars = {
    audit_cols: JSON.stringify(OWNER_AUDIT_COLUMNS),
    platform_ext: JSON.stringify(PLATFORM_EXTENSIONS),
    platform_owners: JSON.stringify(PLATFORM_OBJECT_OWNERS),
    platform_objects: JSON.stringify(PLATFORM_POSTGRES_OBJECTS),
  };
  if (snapshot !== undefined && snapshot !== null && snapshot !== '') {
    if (!SNAPSHOT.test(snapshot)) {
      throw new BackupError('BAD_SNAPSHOT', 'the snapshot id is malformed');
    }
    vars.snapshot = snapshot;
  }
  return vars;
}

export function readDriftFacts({ psql = runPsql, snapshot } = {}) {
  const output = psql({
    sql: loadSql('drift.sql'),
    vars: queryVars(snapshot),
    code: 'DRIFT_QUERY_FAILED',
  });
  return parseJson(output, 'DRIFT_QUERY_FAILED');
}

// Keep the md5 expression identical to the one in sql/manifest.sql.
export const MIGRATION_HASH_EXPR =
  "md5(coalesce(array_to_string(statements, E'\\n'), ''))";

export function readMigrationHashes({ psql = runPsql } = {}) {
  const output = psql({
    sql: `select coalesce(jsonb_object_agg(version, ${MIGRATION_HASH_EXPR}), '{}'::jsonb)::text from supabase_migrations.schema_migrations;`,
    code: 'MIGRATIONS_QUERY_FAILED',
  });
  return parseJson(output, 'MIGRATIONS_QUERY_FAILED');
}

export function checkMigrationHashes(manifest, actual) {
  const expected = manifest?.metadata?.migrationHashes;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new BackupError(
      'MANIFEST_INVALID',
      'the manifest has no migration hashes',
    );
  }
  const differences = [];
  for (const version of [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort()) {
    if (!(version in actual)) {
      differences.push(`${version} is not in this database`);
    } else if (!(version in expected)) {
      differences.push(`${version} is not in the backup`);
    } else if (expected[version] !== actual[version]) {
      differences.push(`${version} has different statements`);
    }
  }
  return differences;
}

function toolVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return 'unavailable';
  }
  return result.stdout.trim().slice(0, 120);
}

function appCommit(env) {
  const candidate =
    env.BACKUP_APP_COMMIT ||
    spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).stdout?.trim();
  return /^[0-9a-f]{7,40}$/i.test(candidate ?? '') ? candidate : 'unknown';
}

export function buildManifest({
  psql = runPsql,
  snapshot,
  skipDrift = false,
  env = process.env,
  clientVersions,
  now = () => new Date(),
} = {}) {
  if (!skipDrift) {
    assertNoDrift(readDriftFacts({ psql, snapshot }));
  }
  const output = psql({
    sql: loadSql('manifest.sql'),
    vars: queryVars(snapshot),
    code: 'MANIFEST_QUERY_FAILED',
  });
  const parsed = parseJson(output, 'MANIFEST_QUERY_FAILED');
  if (!parsed.db?.ownerUuid) {
    throw new BackupError(
      'NO_OWNER',
      'app.owner is empty; refusing to take a backup without an owner',
    );
  }
  let pinnedMajor = null;
  try {
    pinnedMajor = readPinnedMajor(env);
  } catch {
    pinnedMajor = null;
  }
  return {
    format: 1,
    createdAt: now().toISOString(),
    metadata: {
      ...parsed.db,
      ownerAuditColumns: [...OWNER_AUDIT_COLUMNS],
      appCommit: appCommit(env),
      pinnedMajor,
      clientVersions: clientVersions ?? {
        pg_dump: toolVersion('pg_dump'),
        psql: toolVersion('psql'),
        node: process.version,
      },
      scope: { dumped: SCOPE_SCHEMAS[0], structureOnly: SCOPE_SCHEMAS[1] },
    },
    tables: parsed.tables,
    sequences: parsed.sequences,
    fingerprint: parsed.fingerprint,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const [command, ...rest] = process.argv.slice(2);
    const snapshot = option(rest, '--snapshot');
    if (command === 'build') {
      const out = rest[0];
      if (!out || out.startsWith('--')) {
        throw new BackupError(
          'USAGE',
          'usage: manifest.mjs build <out.json> [--snapshot ID] [--skip-drift]',
        );
      }
      const manifest = buildManifest({
        snapshot,
        skipDrift: rest.includes('--skip-drift'),
      });
      writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      return `manifest: ${Object.keys(manifest.tables).length} tables, ${
        Object.keys(manifest.fingerprint).length
      } fingerprinted objects`;
    }
    if (command === 'drift') {
      assertNoDrift(readDriftFacts({ snapshot }));
      return 'drift guard: no application objects outside the backup scope';
    }
    if (command === 'migrations-check') {
      if (!rest[0]) {
        throw new BackupError(
          'USAGE',
          'usage: manifest.mjs migrations-check <manifest.json>',
        );
      }
      const manifest = JSON.parse(readFileSync(rest[0], 'utf8'));
      const differences = checkMigrationHashes(manifest, readMigrationHashes());
      if (differences.length > 0) {
        throw new BackupError(
          'MIGRATIONS_DIFFER',
          `${differences.length} migration(s) differ: ${differences.slice(0, 20).join('; ')}`,
        );
      }
      return `migration history matches the backup (${
        Object.keys(manifest.metadata.migrationHashes).length
      } versions)`;
    }
    throw new BackupError(
      'USAGE',
      'usage: manifest.mjs build <out.json> | drift | migrations-check <manifest.json>',
    );
  });
}
