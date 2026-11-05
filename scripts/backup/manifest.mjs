import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

// Keep the md5 expression identical to the one in sql/manifest.sql. Whitespace
// is ignored so the same SQL hashes the same whether the history stores it as
// one statement (hosted apply_migration) or split by the CLI.
export const MIGRATION_HASH_EXPR =
  "md5(regexp_replace(coalesce(array_to_string(statements, ''), ''), '\\s+', '', 'g'))";

export function readMigrationEntries({ psql = runPsql } = {}) {
  const output = psql({
    sql: `select coalesce(jsonb_agg(jsonb_build_object('version', version, 'name', name, 'hash', ${MIGRATION_HASH_EXPR}) order by version), '[]'::jsonb)::text from supabase_migrations.schema_migrations;`,
    code: 'MIGRATIONS_QUERY_FAILED',
  });
  return parseJson(output, 'MIGRATIONS_QUERY_FAILED');
}

const MIGRATION_HASH = /^[0-9a-f]{32}$/;
const MIGRATION_FILE = /^(\d+)_(.+)\.sql$/;

// Versions are timestamps without leading zeros: shorter is smaller.
function compareVersions(a, b) {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// Migrations are matched by name: hosted versions come from apply_migration
// timestamps and differ from the <version>_<name>.sql file names.
function indexMigrations(entries, label, code) {
  if (!Array.isArray(entries)) {
    throw new BackupError(code, `${label} has no migration entries`);
  }
  const byName = new Map();
  const versions = new Set();
  for (const entry of entries) {
    const { version, name, hash } = entry ?? {};
    if (
      typeof version !== 'string' ||
      version === '' ||
      typeof name !== 'string' ||
      name === '' ||
      !MIGRATION_HASH.test(String(hash))
    ) {
      throw new BackupError(
        code,
        `${label} holds a migration without a version, name and hash`,
      );
    }
    if (byName.has(name) || versions.has(version)) {
      throw new BackupError(
        code,
        `${label} lists a migration name or version twice`,
      );
    }
    byName.set(name, { version, name, hash });
    versions.add(version);
  }
  return byName;
}

// Compares the manifest's migrations with the connected database by name and
// statement hash. A different version id for the same name and statements is
// reported in versionChanges, not as a difference. matched pairs each backup
// version with the version used here, in the order they were applied.
export function checkMigrationEntries(manifest, actual) {
  const expected = indexMigrations(
    manifest?.metadata?.migrationEntries,
    'the manifest',
    'MANIFEST_INVALID',
  );
  const here = indexMigrations(actual, 'this database', 'MIGRATIONS_INVALID');
  const differences = [];
  const matched = [];
  for (const name of [
    ...new Set([...expected.keys(), ...here.keys()]),
  ].sort()) {
    const backup = expected.get(name);
    const local = here.get(name);
    if (!local) {
      differences.push(`${name} is not in this database`);
    } else if (!backup) {
      differences.push(`${name} is not in the backup`);
    } else if (backup.hash !== local.hash) {
      differences.push(`${name} has different statements`);
    } else {
      matched.push({
        name,
        backupVersion: backup.version,
        version: local.version,
      });
    }
  }
  matched.sort((a, b) => compareVersions(a.backupVersion, b.backupVersion));
  for (let i = 1; i < matched.length; i += 1) {
    if (compareVersions(matched[i].version, matched[i - 1].version) <= 0) {
      differences.push(`${matched[i].name} is applied in a different order`);
    }
  }
  const versionChanges = matched
    .filter((m) => m.version !== m.backupVersion)
    .map(
      (m) =>
        `${m.name}: backup version ${m.backupVersion}, this database ${m.version}`,
    );
  return { differences, versionChanges, matched };
}

export function listRepoMigrations(
  dir = join(repoRoot, 'supabase', 'migrations'),
) {
  return readdirSync(dir)
    .map((file) => ({ file, found: MIGRATION_FILE.exec(file) }))
    .filter((entry) => entry.found)
    .map(({ file, found }) => ({ file, version: found[1], name: found[2] }))
    .sort((a, b) => compareVersions(a.version, b.version));
}

// Repository migrations the backup does not have, by name, in apply order.
// A backup migration missing from the repository means the checkout is older
// than the backup, so it is an error rather than an empty list.
export function pendingMigrations(manifest, repoMigrations) {
  const recorded = indexMigrations(
    manifest?.metadata?.migrationEntries,
    'the manifest',
    'MANIFEST_INVALID',
  );
  const repoNames = new Set(repoMigrations.map((m) => m.name));
  const unknown = [...recorded.keys()].filter((name) => !repoNames.has(name));
  if (unknown.length > 0) {
    throw new BackupError(
      'MIGRATIONS_DIFFER',
      `the backup holds migrations this checkout does not have: ${unknown.slice(0, 20).join(', ')}`,
    );
  }
  return repoMigrations.filter((m) => !recorded.has(m.name));
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

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new BackupError('MANIFEST_INVALID', 'the manifest is not valid JSON');
  }
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
      if (!rest[0] || rest[0].startsWith('--')) {
        throw new BackupError(
          'USAGE',
          'usage: manifest.mjs migrations-check <manifest.json> [--repair-versions]',
        );
      }
      const { differences, versionChanges, matched } = checkMigrationEntries(
        readJsonFile(rest[0]),
        readMigrationEntries(),
      );
      if (differences.length > 0) {
        throw new BackupError(
          'MIGRATIONS_DIFFER',
          `${differences.length} migration(s) differ: ${differences.slice(0, 20).join('; ')}`,
        );
      }
      if (rest.includes('--repair-versions')) {
        return matched.map((m) => m.version).join(' ');
      }
      const lines = [
        `migration history matches the backup (${matched.length} migrations, matched by name and statements)`,
      ];
      if (versionChanges.length > 0) {
        lines.push(
          `${versionChanges.length} migration(s) have a different version id than the backup (informational):`,
          ...versionChanges.map((change) => `  ${change}`),
        );
      }
      return lines.join('\n');
    }
    if (command === 'migrations-export') {
      if (!rest[0] || rest[0].startsWith('--')) {
        throw new BackupError(
          'USAGE',
          'usage: manifest.mjs migrations-export <out.json>',
        );
      }
      const migrationEntries = readMigrationEntries();
      writeFileSync(
        rest[0],
        `${JSON.stringify({ metadata: { migrationEntries } }, null, 2)}\n`,
        { mode: 0o600 },
      );
      return `exported ${migrationEntries.length} migrations`;
    }
    if (command === 'migrations-pending') {
      if (!rest[0] || rest[0].startsWith('--')) {
        throw new BackupError(
          'USAGE',
          'usage: manifest.mjs migrations-pending <manifest.json> [migrations dir]',
        );
      }
      return pendingMigrations(
        readJsonFile(rest[0]),
        rest[1] ? listRepoMigrations(rest[1]) : listRepoMigrations(),
      )
        .map((m) => m.file)
        .join('\n');
    }
    throw new BackupError(
      'USAGE',
      'usage: manifest.mjs build <out.json> | drift | migrations-check <manifest.json> | migrations-export <out.json> | migrations-pending <manifest.json>',
    );
  });
}
