-- Read-only role for the scheduled backup. Run once as the project's postgres
-- role (SQL editor or psql); safe to run again. It sets NO password: connect
-- with psql and run \password backup_reader (see docs/BACKUP.md).
-- Run it again after a restore into a new project.
-- Not a migration: it must never be applied by the app's migration tooling.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'backup_reader') then
    create role backup_reader login bypassrls nosuperuser nocreatedb nocreaterole noreplication noinherit;
  end if;
end
$$;

-- SUPERUSER and REPLICATION are left out: only a superuser may name them in
-- ALTER ROLE, and the role is created without them. The dump checks both.
alter role backup_reader login bypassrls nocreatedb nocreaterole noinherit;

alter role backup_reader
set
  default_transaction_read_only = on;

alter role backup_reader
set
  statement_timeout = 0;

alter role backup_reader
set
  idle_in_transaction_session_timeout = 0;

-- The dump covers schema app (data) and ledger_scratch (structure only).
-- pg_dump locks every table it dumps, which needs SELECT on it.
grant usage on schema app to backup_reader;

grant usage on schema ledger_scratch to backup_reader;

grant
select
  on all tables in schema app to backup_reader;

grant
select
  on all tables in schema ledger_scratch to backup_reader;

grant
select
  on all sequences in schema app to backup_reader;

grant
select
  on all sequences in schema ledger_scratch to backup_reader;

-- Tables and sequences added by later migrations (created by postgres).
alter default privileges for role postgres in schema app
grant
select
  on tables to backup_reader;

alter default privileges for role postgres in schema app
grant
select
  on sequences to backup_reader;

alter default privileges for role postgres in schema ledger_scratch
grant
select
  on tables to backup_reader;

alter default privileges for role postgres in schema ledger_scratch
grant
select
  on sequences to backup_reader;

-- Migration versions are saved as metadata (the version column only).
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    grant usage on schema supabase_migrations to backup_reader;
    grant select (version) on supabase_migrations.schema_migrations to backup_reader;
  end if;
end
$$;

-- The drift guard counts storage objects and cron jobs (one column each, no content).
do $$
begin
  if to_regclass('storage.objects') is not null then
    grant usage on schema storage to backup_reader;
    grant select (id) on storage.objects to backup_reader;
  end if;
  if to_regclass('cron.job') is not null then
    grant usage on schema cron to backup_reader;
    grant select (jobid) on cron.job to backup_reader;
  end if;
end
$$;
