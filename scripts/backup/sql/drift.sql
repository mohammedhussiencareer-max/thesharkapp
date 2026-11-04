\ir session.sql
-- backup_reader cannot read storage.buckets (-1 = not checked). A role that can,
-- such as postgres in CI or the manual production check, gets the real count.
select exists (
  select 1
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'buckets' and c.relkind in ('r', 'p')
    and has_schema_privilege(n.oid, 'usage') and has_table_privilege(c.oid, 'select')
) as can_buckets \gset
\if :can_buckets
select count(*)::text as storage_buckets from storage.buckets \gset
\else
\set storage_buckets -1
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
other_objects as (
  select n.nspname::text as sch,
    (case c.relkind
      when 'v' then 'view' when 'm' then 'matview'
      when 'f' then 'foreign table' when 'S' then 'sequence' else 'table'
    end)::text as kind,
    c.relname::text as name,
    pg_catalog.pg_get_userbyid(c.relowner)::text as owner
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'app', 'ledger_scratch')
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
  select n.nspname::text, 'function', p.proname::text, pg_catalog.pg_get_userbyid(p.proowner)::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'app', 'ledger_scratch')
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
    )
  union all
  select n.nspname::text, 'type', t.typname::text, pg_catalog.pg_get_userbyid(t.typowner)::text
  from pg_catalog.pg_type t
  join pg_catalog.pg_namespace n on n.oid = t.typnamespace
  where n.nspname !~ '^pg_' and n.nspname not in ('information_schema', 'app', 'ledger_scratch')
    and t.typtype in ('e', 'd')
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_type'::regclass and d.objid = t.oid and d.deptype = 'e'
    )
),
out_of_scope as (
  select distinct (o.sch || '.' || o.kind || ' ' || o.name)::text as ref
  from other_objects o
  where o.sch = 'public'
    or (
      o.owner not in (select jsonb_array_elements_text(:'platform_owners'::jsonb))
      and (o.sch || '.' || o.name) not in (select jsonb_array_elements_text(:'platform_objects'::jsonb))
    )
)
select jsonb_build_object(
  'schemas', (
    select coalesce(jsonb_agg(nspname order by nspname), '[]'::jsonb)
    from pg_catalog.pg_namespace
    where nspname !~ '^pg_' and nspname <> 'information_schema'
  ),
  'outOfScopeObjects', (
    select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb)
    from (select ref from out_of_scope order by ref limit 200) limited
  ),
  'extensions', (select coalesce(jsonb_agg(extname order by extname), '[]'::jsonb) from pg_catalog.pg_extension),
  'storageBuckets', :'storage_buckets'::bigint,
  'ownerLikeColumns', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from owner_like),
  'ownerFkMap', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from owner_fk),
  'otherAuthRefs', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from other_auth),
  'missingAuditColumns', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from audit_missing)
)::text;
rollback;
