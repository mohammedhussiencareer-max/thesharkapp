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

// Read-only report of whether pg_cron and pg_net are installed. Fails closed
// when pg_net is installed and backup_reader has effective USAGE on schema net
// or SELECT on any net table, or when that role has USAGE on schema cron or
// vault. Does not read job rows or request rows. Every statement is a select.
// A loopback address is not proof of a local database (a port forward can
// present 127.0.0.1 while the server is hosted), so this command never
// creates an extension.

const QUERY_CODE = 'SCHEDULER_QUERY_FAILED';

const EXTENSIONS_SQL =
  "select extname from pg_catalog.pg_extension where extname in ('pg_cron', 'pg_net') order by 1;";

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

function isNetProblem(line) {
  return (
    line.startsWith('pg_net is installed') ||
    line.includes('schema net') ||
    line.startsWith('backup_reader can select net.')
  );
}

function assertReaderLockedOut(output) {
  const problems = readNames(output).sort();
  const net = problems.filter(isNetProblem);
  const role = problems.filter((line) => !isNetProblem(line));
  if (net.length > 0) {
    const missingReaderOnly = net.every((line) =>
      line.startsWith('pg_net is installed and backup_reader does not exist'),
    );
    const prefix = missingReaderOnly
      ? 'cannot verify pg_net isolation'
      : 'pg_net exposes request data to backup_reader';
    const extra =
      role.length > 0
        ? `; backup_reader can enter cron or vault: ${role.join('; ')}`
        : '';
    throw new BackupError(
      'SCHEDULER_NET_UNSAFE',
      `${prefix}: ${net.join('; ')}${extra}`,
    );
  }
  if (role.length > 0) {
    throw new BackupError(
      'SCHEDULER_ROLE_UNSAFE',
      `backup_reader can enter cron or vault: ${role.join('; ')}`,
    );
  }
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
  const cron = result.pgCron ? 'present' : 'absent';
  const net = result.pgNet ? 'present' : 'absent';
  return `scheduler check: pg_cron ${cron}, pg_net ${net}`;
}

export function ensureScheduler({ query = runPsql, env = process.env } = {}) {
  const connection = connectionEnv(env);
  const ask = (sql) => query({ sql, code: QUERY_CODE, env: connection });
  const extensions = readNames(ask(EXTENSIONS_SQL));
  assertReaderLockedOut(ask(PRIVILEGE_SQL));
  return {
    pgCron: extensions.includes('pg_cron'),
    pgNet: extensions.includes('pg_net'),
  };
}

if (isMain(import.meta.url)) {
  runCli(() => formatSchedulerReport(ensureScheduler()));
}
