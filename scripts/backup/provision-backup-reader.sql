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

-- Migration versions, names and a hash of their statements are saved as
-- metadata (the version, name and statements columns only; the hash is
-- computed, not stored).
do $$
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    grant usage on schema supabase_migrations to backup_reader;
    grant select (version, name, statements) on supabase_migrations.schema_migrations to backup_reader;
  end if;
end
$$;

-- The drift guard counts storage buckets as backup_reader: Storage objects are
-- outside the backup, and an upload needs a bucket. Only the bucket id column
-- is readable (no object rows, no bucket settings). Schema usage is required
-- for that; the role check allows nothing else in storage. If the grant does
-- not take effect the script fails here instead of leaving a role whose
-- backups can never pass the drift guard.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    grant usage on schema storage to backup_reader;
    grant select (id) on storage.buckets to backup_reader;
    if not has_schema_privilege('backup_reader', 'storage', 'usage')
       or not has_column_privilege('backup_reader', 'storage.buckets', 'id', 'select') then
      raise exception 'could not grant backup_reader read access to storage.buckets(id); run this script as the schema owner or a role with grant option';
    end if;
  end if;
end
$$;

-- Nothing else: backup_reader gets no access to the auth, vault, cron or net
-- schemas, and nothing in storage beyond the bucket id column.
