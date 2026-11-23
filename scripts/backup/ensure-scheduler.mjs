import { statSync } from 'node:fs';
import { delimiter as pathDelimiter } from 'node:path';
import {
  BackupError,
  checkRestoreTarget,
  classifyTarget,
  isMain,
  runCli,
} from './config.mjs';
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

const VERIFIED_TLS = new Set(['verify-full', 'verify-ca']);

function clientDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// One copy of the connection settings. Remote runs need the confirm phrase and
// an explicit verified TLS mode: an unset PGSSLMODE is not verify-full here,
// because the client would otherwise use its own default. The copy is what
// every query receives, including the client directory on PATH.
function connectionEnv(env) {
  const connection = { ...env };
  checkRestoreTarget(connection);
  if (
    !classifyTarget(connection).allLoopback &&
    !VERIFIED_TLS.has(connection.PGSSLMODE)
  ) {
    throw new BackupError(
      'SSLMODE_WEAK',
      'a non-loopback host requires PGSSLMODE=verify-full or verify-ca',
    );
  }
  const bin = connection.BACKUP_PG_BIN;
  if (typeof bin === 'string' && bin !== '' && clientDirectory(bin)) {
    const pathKey =
      Object.keys(connection).find((name) => name.toLowerCase() === 'path') ??
      'PATH';
    const current = connection[pathKey] ?? '';
    connection[pathKey] = current ? `${bin}${pathDelimiter}${current}` : bin;
  }
  return connection;
}

export function ensureScheduler({ query = runPsql, env = process.env } = {}) {
  const connection = connectionEnv(env);
  const ask = (sql) => query({ sql, code: QUERY_CODE, env: connection });
  const installed = readNames(ask(EXTENSIONS_SQL));
  const created = [];
  for (const name of SCHEDULER_EXTENSIONS) {
    if (!installed.includes(name)) {
      ask(CREATE_SQL[name]);
      created.push(name);
    }
  }
  const extensions = readNames(ask(EXTENSIONS_SQL));
  const schemas = readNames(ask(SCHEMAS_SQL));
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
