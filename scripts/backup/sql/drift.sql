\ir session.sql
select exists (
  select 1
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects'
    and has_schema_privilege(n.oid, 'usage') and has_any_column_privilege(c.oid, 'select')
) as can_storage \gset
\if :can_storage
select count(*)::text as storage_objects from storage.objects \gset
\else
select coalesce((select n_live_tup from pg_catalog.pg_stat_user_tables where schemaname = 'storage' and relname = 'objects'), 0)::text as storage_objects \gset
\endif
select exists (
  select 1
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'cron' and c.relname = 'job'
    and has_schema_privilege(n.oid, 'usage') and has_any_column_privilege(c.oid, 'select')
) as can_cron \gset
\if :can_cron
select count(*)::text as cron_jobs from cron.job \gset
\else
select coalesce((select n_live_tup from pg_catalog.pg_stat_user_tables where schemaname = 'cron' and relname = 'job'), 0)::text as cron_jobs \gset
\endif
with auth_users as (
  select c.oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'auth' and c.relname = 'users'
),
owner_fk as (
  select (n.nspname || '.' || c.relname || '.' || a.attname)::text as ref
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_class c on c.oid = k.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
  where k.contype = 'f' and k.confrelid in (select oid from auth_users) and n.nspname = 'app'
),
other_auth as (
  select (n.nspname || '.' || c.relname || '.' || a.attname)::text as ref
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_class c on c.oid = k.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_class t on t.oid = k.confrelid
  join pg_catalog.pg_namespace tn on tn.oid = t.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
  where k.contype = 'f' and tn.nspname = 'auth' and k.confrelid not in (select oid from auth_users)
    and n.nspname in ('app', 'ledger_scratch')
),
owner_like as (
  select (n.nspname || '.' || c.relname || '.' || a.attname)::text as ref
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
    and a.atttypid = 'uuid'::regtype
    and a.attname ~ '(_by|^actor_id|^owner_id|(^|_)user_id)$'
),
audit_missing as (
  select x as ref
  from jsonb_array_elements_text(:'audit_cols'::jsonb) x
  where not exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where a.attnum > 0 and not a.attisdropped and a.atttypid = 'uuid'::regtype
      and (n.nspname || '.' || c.relname || '.' || a.attname) = x
  )
),
public_objects as (
  select ('relation ' || c.relname)::text as ref
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (
      c.relkind in ('r', 'p', 'v', 'm', 'f')
      or (c.relkind = 'S' and not exists (
        select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i')
      ))
    )
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
    )
  union all
  select ('function ' || p.proname)::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    )
  union all
  select ('type ' || t.typname)::text
  from pg_catalog.pg_type t
  join pg_catalog.pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typtype in ('e', 'd')
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_type'::regclass and d.objid = t.oid and d.deptype = 'e'
    )
)
select jsonb_build_object(
  'schemas', (
    select coalesce(jsonb_agg(nspname order by nspname), '[]'::jsonb)
    from pg_catalog.pg_namespace
    where nspname !~ '^pg_' and nspname <> 'information_schema'
  ),
  'publicObjects', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from public_objects),
  'extensions', (select coalesce(jsonb_agg(extname order by extname), '[]'::jsonb) from pg_catalog.pg_extension),
  'storageObjects', :'storage_objects'::bigint,
  'cronJobs', :'cron_jobs'::bigint,
  'ownerLikeColumns', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from owner_like),
  'ownerFkMap', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from owner_fk),
  'otherAuthRefs', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from other_auth),
  'missingAuditColumns', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from audit_missing)
)::text;
rollback;
