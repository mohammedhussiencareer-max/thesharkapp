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
// extension rows and the cron and net schemas exist. It then removes PUBLIC
// access to schema net so the backup role cannot enter it, and checks the
// owner can still use net. Run as the database owner before secrets and
// before the job. Does not read or write job rows.

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

// Grants explicit use to the owner and to the platform roles the extension
// needs, then removes the PUBLIC grants. Re-running it is safe. The select
// reports reader usage, the reader's SQLSTATE, owner usage, and owner execute.
const NET_ACL_SQL = `
do $net_acl$
declare
  role_name text;
begin
  execute format('grant usage on schema net to %I', current_user);
  execute format('grant execute on all functions in schema net to %I', current_user);
  execute format('grant all privileges on all tables in schema net to %I', current_user);
  execute format('grant all privileges on all sequences in schema net to %I', current_user);
  foreach role_name in array array['postgres', 'supabase_functions_admin', 'supabase_admin']
  loop
    if role_name is distinct from current_user
       and exists (select 1 from pg_catalog.pg_roles where rolname = role_name) then
      execute format('grant usage on schema net to %I', role_name);
      execute format('grant execute on all functions in schema net to %I', role_name);
      execute format('grant all privileges on all tables in schema net to %I', role_name);
      execute format('grant all privileges on all sequences in schema net to %I', role_name);
    end if;
  end loop;
  revoke usage on schema net from public;
  revoke all privileges on all tables in schema net from public;
  revoke all privileges on all sequences in schema net from public;
end
$net_acl$;

create or replace function pg_temp.scheduler_net_reader_state()
returns text
language plpgsql
as $fn$
declare
  state text;
begin
  begin
    perform set_config('role', 'backup_reader', true);
  exception
    when others then
      return 'set-role';
  end;
  begin
    execute 'select 1 from net.http_request_queue limit 1';
    perform set_config('role', 'none', true);
    return 'allowed';
  exception
    when others then
      state := sqlstate;
      perform set_config('role', 'none', true);
      return state;
  end;
end
$fn$;

select
  case when facts.reader_usage then 't' else 'f' end
  || ' ' || pg_temp.scheduler_net_reader_state()
  || ' ' || case when facts.owner_usage then 't' else 'f' end
  || ' ' || case when facts.owner_execute then 't' else 'f' end
from (
  select
    has_schema_privilege('backup_reader', 'net', 'usage') as reader_usage,
    has_schema_privilege(current_user, 'net', 'usage') as owner_usage,
    exists (
      select 1
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'net'
        and p.proname = 'http_post'
        and has_function_privilege(current_user, p.oid, 'execute')
    ) as owner_execute
) as facts;
`;

function assertNetClosed(output) {
  const line =
    String(output ?? '')
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  const [readerUsage, readerState, ownerUsage, ownerExecute] =
    line.split(/\s+/);
  const problems = [];
  if (readerUsage !== 'f') {
    problems.push('backup_reader can use schema net');
  }
  if (readerState !== '42501') {
    problems.push('backup_reader was not refused on net.http_request_queue');
  }
  if (ownerUsage !== 't') {
    problems.push('the database owner has no usage on schema net');
  }
  if (ownerExecute !== 't') {
    problems.push('the database owner cannot execute net.http_post');
  }
  if (problems.length > 0) {
    throw new BackupError(
      'SCHEDULER_NET_ACL',
      `net access is not safe: ${problems.join('; ')}`,
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
  assertNetClosed(ask(NET_ACL_SQL));
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
