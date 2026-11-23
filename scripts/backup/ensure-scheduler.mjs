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

// Reports whether pg_cron and pg_net are installed. Fails closed when pg_net
// is installed and backup_reader has effective USAGE on schema net or SELECT
// on any net table, or when that role has USAGE on schema cron or vault.
// Does not read job rows or request rows.
// A missing extension is created only for a loopback target when
// BACKUP_ALLOW_LOOPBACK=1 and BACKUP_SCHEDULER_CREATE=1 are both set.
// A remote host never receives a create statement.

const QUERY_CODE = 'SCHEDULER_QUERY_FAILED';

const EXTENSIONS_SQL =
  "select extname from pg_catalog.pg_extension where extname in ('pg_cron', 'pg_net') order by 1;";

const CREATE_SQL = {
  pg_cron: 'create extension if not exists "pg_cron";',
  pg_net: 'create extension if not exists "pg_net";',
};

const SCHEDULER_EXTENSIONS = ['pg_cron', 'pg_net'];

const PRIVILEGE_SQL = `
select problem
from (
  select 'pg_net is installed and backup_reader does not exist'::text as problem
  where exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pg_net'
  )
    and not exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = 'backup_reader'
    )
  union all
  select 'backup_reader can use schema ' || n.nspname
  from pg_catalog.pg_namespace as n
  where exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = 'backup_reader'
    )
    and n.nspname in ('cron', 'vault')
    and has_schema_privilege('backup_reader', n.oid, 'USAGE')
  union all
  select 'backup_reader can use schema net'
  from pg_catalog.pg_namespace as n
  where exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = 'backup_reader'
    )
    and exists (
      select 1
      from pg_catalog.pg_extension
      where extname = 'pg_net'
    )
    and n.nspname = 'net'
    and has_schema_privilege('backup_reader', n.oid, 'USAGE')
  union all
  select 'backup_reader can select ' || n.nspname || '.' || c.relname
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
  where exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = 'backup_reader'
    )
    and exists (
      select 1
      from pg_catalog.pg_extension
      where extname = 'pg_net'
    )
    and n.nspname = 'net'
    and c.relkind in ('r', 'p', 'v', 'm')
    and has_table_privilege('backup_reader', c.oid, 'SELECT')
) as found
order by 1;
`;

function readNames(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertReaderLockedOut(output) {
  const problems = readNames(output).sort();
  if (problems.length > 0) {
    throw new BackupError(
      'SCHEDULER_NET_UNSAFE',
      `backup_reader can reach scheduler data: ${problems.join('; ')}`,
    );
  }
}

function creationAllowed(env) {
  return (
    env.BACKUP_SCHEDULER_CREATE === '1' &&
    env.BACKUP_ALLOW_LOOPBACK === '1' &&
    classifyTarget(env).allLoopback
  );
}

function creationRefusalMessage(env) {
  if (!classifyTarget(env).allLoopback) {
    return 'a remote host cannot create pg_cron or pg_net';
  }
  return 'creating pg_cron or pg_net needs BACKUP_ALLOW_LOOPBACK=1 on a loopback target';
}

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
    !new Set(['verify-full', 'verify-ca']).has(connection.PGSSLMODE)
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

export function formatSchedulerReport(result) {
  const created =
    result.created.length > 0 ? `created ${result.created.join(', ')}; ` : '';
  const cron = result.pgCron ? 'present' : 'absent';
  const net = result.pgNet ? 'present' : 'absent';
  return `scheduler check: ${created}pg_cron ${cron}, pg_net ${net}`;
}

export function ensureScheduler({ query = runPsql, env = process.env } = {}) {
  const connection = connectionEnv(env);
  if (env.BACKUP_SCHEDULER_CREATE === '1' && !creationAllowed(env)) {
    throw new BackupError(
      'SCHEDULER_CREATE_REFUSED',
      creationRefusalMessage(env),
    );
  }
  const ask = (sql) => query({ sql, code: QUERY_CODE, env: connection });
  let extensions = readNames(ask(EXTENSIONS_SQL));
  const created = [];
  if (creationAllowed(env)) {
    for (const name of SCHEDULER_EXTENSIONS) {
      if (!extensions.includes(name)) {
        ask(CREATE_SQL[name]);
        created.push(name);
      }
    }
    if (created.length > 0) {
      extensions = readNames(ask(EXTENSIONS_SQL));
    }
  }
  assertReaderLockedOut(ask(PRIVILEGE_SQL));
  return {
    created,
    pgCron: extensions.includes('pg_cron'),
    pgNet: extensions.includes('pg_net'),
  };
}

if (isMain(import.meta.url)) {
  runCli(() => formatSchedulerReport(ensureScheduler()));
}
