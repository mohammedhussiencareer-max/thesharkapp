import { BackupError, checkRestoreTarget, isMain, runCli } from './config.mjs';
import { runPsql } from './psql.mjs';

// Creates pg_cron and pg_net when they are missing, then checks that both
// extension rows and the cron and net schemas exist. Run as the database
// owner before secrets and before the job. Does not read or write job rows.

const QUERY_CODE = 'SCHEDULER_QUERY_FAILED';

const EXTENSIONS_SQL =
  "select extname from pg_catalog.pg_extension where extname in ('pg_cron', 'pg_net') order by 1;";

const SCHEMAS_SQL =
  "select nspname from pg_catalog.pg_namespace where nspname in ('cron', 'net') order by 1;";

const CREATE_SQL = {
  pg_cron: 'create extension if not exists "pg_cron";',
  pg_net: 'create extension if not exists "pg_net";',
};

const SCHEDULER_EXTENSIONS = ['pg_cron', 'pg_net'];
const SCHEDULER_SCHEMAS = ['cron', 'net'];

function readNames(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertReady({ extensions, schemas }) {
  const problems = [];
  for (const name of SCHEDULER_EXTENSIONS) {
    if (!extensions.includes(name)) {
      problems.push(`pg_extension has no row for ${name}`);
    }
  }
  for (const name of SCHEDULER_SCHEMAS) {
    if (!schemas.includes(name)) {
      problems.push(`schema ${name} is missing`);
    }
  }
  if (problems.length > 0) {
    throw new BackupError(
      'SCHEDULER_NOT_READY',
      `scheduler extensions are not ready: ${problems.join('; ')}`,
    );
  }
}

export function ensureScheduler({ query = runPsql, env = process.env } = {}) {
  checkRestoreTarget(env);
  const installed = readNames(query({ sql: EXTENSIONS_SQL, code: QUERY_CODE }));
  const created = [];
  for (const name of SCHEDULER_EXTENSIONS) {
    if (!installed.includes(name)) {
      query({ sql: CREATE_SQL[name], code: QUERY_CODE });
      created.push(name);
    }
  }
  const extensions = readNames(
    query({ sql: EXTENSIONS_SQL, code: QUERY_CODE }),
  );
  const schemas = readNames(query({ sql: SCHEMAS_SQL, code: QUERY_CODE }));
  assertReady({ extensions, schemas });
  return { created };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const result = ensureScheduler();
    if (result.created.length === 0) {
      return 'scheduler ready: pg_cron and pg_net already present';
    }
    return `scheduler ready: created ${result.created.join(', ')}`;
  });
}
