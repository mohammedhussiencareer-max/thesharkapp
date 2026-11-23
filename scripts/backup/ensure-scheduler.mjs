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
// access to schema net. The connected owner, and postgres when that role
// exists, keep usage on net and execute on each net.http_post identity.
// A security definer identity runs as its owner, so that is enough. An
// invoker also keeps insert and select on the queue and usage on its
// sequences. Privilege functions check the reader inside that same
// transaction; cron and vault are schema usage only, and net also checks
// table select. A held privilege rolls the transaction back. Run as the
// database owner before secrets and before the job. Does not read or write
// job rows and does not call net.http_post.

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

// One transaction. New grants are usage on schema net and execute on each
// net.http_post identity (name plus argument types), and only for the
// connected owner and for postgres when that role exists. Existing grants on
// other roles are not changed. A call to net.http_post is not used: it inserts
// a queue row for the background worker, and this lock has to commit on
// success, so the insert cannot be rolled back in the same transaction.
// has_schema_privilege and has_function_privilege prove the owner can use the
// looked-up signature. The reader is not assumed. If any checked privilege is
// held, psql rolls the transaction back and the problem lines become
// SCHEDULER_NET_ACL. The real reader login denial stays in the CI round trip.
const NET_ACL_SQL = `
begin;
create temp table scheduler_acl_problem (problem text) on commit drop;
do $net_acl$
declare
  func regprocedure;
  func_definer boolean;
  role_name text;
  seq_name text;
begin
  foreach role_name in array array[current_user::text, 'postgres']
  loop
    if role_name is distinct from current_user::text
       and not exists (
         select 1 from pg_catalog.pg_roles where rolname = role_name
       ) then
      continue;
    end if;
    execute format('grant usage on schema net to %I', role_name);
    -- A security definer http_post (pg_proc.prosecdef) runs as the function
    -- owner, who keeps the right to insert into the queue. Schema usage and
    -- execute are enough for that caller. An invoker runs as the job owner,
    -- so that role also needs insert and select on the queue table and usage
    -- on the queue sequences.
    for func, func_definer in
      select p.oid::regprocedure, p.prosecdef
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'net'
        and p.proname = 'http_post'
        and p.prokind = 'f'
        and pg_get_function_identity_arguments(p.oid) is not null
    loop
      execute format('grant execute on function %s to %I', func, role_name);
      if not func_definer then
        execute format(
          'grant insert, select on table net.http_request_queue to %I',
          role_name
        );
        for seq_name in
          select pg_get_serial_sequence('net.http_request_queue', a.attname)
          from pg_catalog.pg_attribute as a
          where a.attrelid = 'net.http_request_queue'::regclass
            and a.attnum > 0
            and not a.attisdropped
            and pg_get_serial_sequence('net.http_request_queue', a.attname) is not null
        loop
          execute format('grant usage on sequence %s to %I', seq_name, role_name);
        end loop;
      end if;
    end loop;
  end loop;
  revoke usage on schema net from public;
  revoke all privileges on all tables in schema net from public;
  revoke all privileges on all sequences in schema net from public;

  -- cron and vault follow the backup role guard: schema usage only. A public
  -- select on one of their tables is unreachable without that usage, so it
  -- must not roll this lock back. net still checks table select.
  insert into pg_temp.scheduler_acl_problem (problem)
  select 'backup_reader can use schema ' || n.nspname
  from pg_catalog.pg_namespace as n
  where n.nspname in ('net', 'cron', 'vault')
    and (
      has_schema_privilege('backup_reader', n.oid, 'USAGE')
      or (
        n.nspname = 'net'
        and has_schema_privilege('backup_reader', 'net', 'USAGE')
      )
    );
  insert into pg_temp.scheduler_acl_problem (problem)
  select 'backup_reader can select ' || n.nspname || '.' || c.relname
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'net'
    and c.relkind in ('r', 'p', 'v', 'm')
    and has_table_privilege('backup_reader', c.oid, 'SELECT');
  if not has_schema_privilege(current_user, 'net', 'USAGE') then
    insert into pg_temp.scheduler_acl_problem (problem)
    values ('the database owner has no usage on schema net');
  elsif exists (
    select 1 from pg_catalog.pg_roles where rolname = 'postgres'
  ) then
    if not has_schema_privilege('postgres', 'net', 'USAGE') then
      insert into pg_temp.scheduler_acl_problem (problem)
      values ('the database owner has no usage on schema net');
    end if;
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'net'
      and p.proname = 'http_post'
      and p.prokind = 'f'
  ) then
    insert into pg_temp.scheduler_acl_problem (problem)
    values ('the database owner cannot execute net.http_post');
  elsif exists (
    select 1
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'net'
      and p.proname = 'http_post'
      and p.prokind = 'f'
      and not has_function_privilege(current_user, p.oid, 'EXECUTE')
  ) then
    insert into pg_temp.scheduler_acl_problem (problem)
    values ('the database owner cannot execute net.http_post');
  elsif exists (
    select 1 from pg_catalog.pg_roles where rolname = 'postgres'
  ) then
    if exists (
      select 1
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
      where n.nspname = 'net'
        and p.proname = 'http_post'
        and p.prokind = 'f'
        and not has_function_privilege('postgres', p.oid, 'EXECUTE')
    ) then
      insert into pg_temp.scheduler_acl_problem (problem)
      values ('the database owner cannot execute net.http_post');
    end if;
  end if;
  if exists (
    select 1
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'net'
      and p.proname = 'http_post'
      and p.prokind = 'f'
      and not p.prosecdef
  ) then
    if not has_table_privilege(current_user, 'net.http_request_queue'::regclass, 'INSERT')
       or not has_table_privilege(current_user, 'net.http_request_queue'::regclass, 'SELECT')
       or exists (
         select 1
         from pg_catalog.pg_attribute as a
         where a.attrelid = 'net.http_request_queue'::regclass
           and a.attnum > 0
           and not a.attisdropped
           and pg_get_serial_sequence('net.http_request_queue', a.attname) is not null
           and not has_sequence_privilege(
             current_user,
             pg_get_serial_sequence('net.http_request_queue', a.attname)::regclass,
             'USAGE'
           )
       )
    then
      insert into pg_temp.scheduler_acl_problem (problem)
      values ('the database owner cannot write the net.http_post queue');
    elsif exists (
      select 1 from pg_catalog.pg_roles where rolname = 'postgres'
    ) then
      if not has_table_privilege('postgres', 'net.http_request_queue'::regclass, 'INSERT')
         or not has_table_privilege('postgres', 'net.http_request_queue'::regclass, 'SELECT')
         or exists (
           select 1
           from pg_catalog.pg_attribute as a
           where a.attrelid = 'net.http_request_queue'::regclass
             and a.attnum > 0
             and not a.attisdropped
             and pg_get_serial_sequence('net.http_request_queue', a.attname) is not null
             and not has_sequence_privilege(
               'postgres',
               pg_get_serial_sequence('net.http_request_queue', a.attname)::regclass,
               'USAGE'
             )
         )
      then
        insert into pg_temp.scheduler_acl_problem (problem)
        values ('the database owner cannot write the net.http_post queue');
      end if;
    end if;
  end if;
end
$net_acl$;
select problem from pg_temp.scheduler_acl_problem order by 1;
select case when count(*) > 0 then 'true' else 'false' end as acl_failed
from pg_temp.scheduler_acl_problem
\\gset
\\if :acl_failed
rollback;
\\else
commit;
\\endif
`;

function assertNetClosed(output) {
  const problems = String(output ?? '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part !== '' &&
        !/^(?:begin|commit|rollback|do)$/i.test(part) &&
        !/^(?:create table|grant|revoke|insert \d+ \d+)$/i.test(part),
    );
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
