\ir session.sql
select to_regclass('supabase_migrations.schema_migrations') is not null as has_migrations \gset
\if :has_migrations
select coalesce(jsonb_agg(version order by version), '[]'::jsonb)::text as migrations from supabase_migrations.schema_migrations \gset
\else
\set migrations '[]'
\endif
with auth_users as (
  select c.oid
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'auth' and c.relname = 'users'
),
owner_cols as (
  select n.nspname::text as sch, c.relname::text as tbl, a.attname::text as col
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_class c on c.oid = k.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
  where k.contype = 'f' and k.confrelid in (select oid from auth_users) and n.nspname = 'app'
  union
  select r.sch, r.tbl, a.attname::text
  from (
    select split_part(x, '.', 1) as sch, split_part(x, '.', 2) as tbl, split_part(x, '.', 3) as col
    from jsonb_array_elements_text(:'audit_cols'::jsonb) x
  ) r
  join pg_catalog.pg_namespace n on n.nspname = r.sch
  join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = r.tbl
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = r.col and not a.attisdropped
),
tbls as (
  select n.nspname::text as sch, c.relname::text as tbl
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind in ('r', 'p')
)
select coalesce(
  string_agg(s.q, E'\nunion all\n' order by s.t),
  'select null::text as t, null::bigint as n, null::text as h where false'
) as tables_q
from (
  select
    t.sch || '.' || t.tbl as t,
    format(
      $q$select %L as t, count(*)::bigint as n, md5(coalesce(string_agg(bk_hash.h, '' order by bk_hash.h), '')) as h from (select md5((to_jsonb(bk_row) || %s)::text) as h from %I.%I bk_row left join (select user_id as owner_id from app.owner) bk_own on true) bk_hash$q$,
      t.sch || '.' || t.tbl,
      coalesce(
        (
          select string_agg(
            format(
              'jsonb_build_object(%L, case when bk_row.%I = bk_own.owner_id then %L else bk_row.%I::text end)',
              oc.col, oc.col, 'OWNER', oc.col
            ),
            ' || ' order by oc.col
          )
          from owner_cols oc
          where oc.sch = t.sch and oc.tbl = t.tbl
        ),
        'jsonb_build_object()'
      ),
      t.sch,
      t.tbl
    ) as q
  from tbls t
) s \gset
with scope as (
  select oid, nspname from pg_catalog.pg_namespace where nspname in ('app', 'ledger_scratch')
),
rel as (
  select c.oid, s.nspname::text as sch, c.relname::text as relname, c.relkind, c.relowner, c.relacl,
    c.relrowsecurity, c.relforcerowsecurity, c.reloptions, c.relpersistence, c.relispartition
  from pg_catalog.pg_class c
  join scope s on s.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
auth_users as (
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
all_acls as (
  select relacl as a from rel
  union all
  select att.attacl from pg_catalog.pg_attribute att join rel r on r.oid = att.attrelid where att.attacl is not null
  union all
  select p.proacl from pg_catalog.pg_proc p join scope s on s.oid = p.pronamespace
  union all
  select nspacl from pg_catalog.pg_namespace where nspname in ('app', 'ledger_scratch')
  union all
  select t.typacl from pg_catalog.pg_type t join scope s on s.oid = t.typnamespace
  union all
  select d.defaclacl from pg_catalog.pg_default_acl d join scope s on s.oid = d.defaclnamespace
),
acl_roles as (
  select x.grantee as o from all_acls aa, lateral aclexplode(aa.a) x
  union
  select x.grantor from all_acls aa, lateral aclexplode(aa.a) x
  union
  select relowner from rel
  union
  select p.proowner from pg_catalog.pg_proc p join scope s on s.oid = p.pronamespace
  union
  select nspowner from pg_catalog.pg_namespace where nspname in ('app', 'ledger_scratch')
  union
  select d.defaclrole from pg_catalog.pg_default_acl d join scope s on s.oid = d.defaclnamespace
),
fp (key, attrs) as (
  select 'schema ' || n.nspname,
    jsonb_build_object(
      'owner', pg_catalog.pg_get_userbyid(n.nspowner),
      'acl', (select jsonb_agg(a::text order by a::text) from unnest(n.nspacl) a)
    )
  from pg_catalog.pg_namespace n
  where n.nspname in ('app', 'ledger_scratch')
  union all
  select
    (case r.relkind
      when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
      when 'm' then 'matview' when 'S' then 'sequence' else 'foreign table'
    end) || ' ' || r.sch || '.' || r.relname,
    jsonb_build_object(
      'relkind', r.relkind::text,
      'owner', pg_catalog.pg_get_userbyid(r.relowner),
      'acl', (select jsonb_agg(a::text order by a::text) from unnest(r.relacl) a),
      'rls', r.relrowsecurity,
      'forceRls', r.relforcerowsecurity,
      'options', to_jsonb(r.reloptions),
      'persistence', r.relpersistence::text,
      'partition', r.relispartition,
      'def', case when r.relkind in ('v', 'm') then md5(pg_catalog.pg_get_viewdef(r.oid, true)) end,
      'seq', case when ps.seqrelid is not null then jsonb_build_object(
        'type', pg_catalog.format_type(ps.seqtypid, null),
        'start', ps.seqstart, 'increment', ps.seqincrement,
        'min', ps.seqmin, 'max', ps.seqmax, 'cache', ps.seqcache, 'cycle', ps.seqcycle
      ) end
    )
  from rel r
  left join pg_catalog.pg_sequence ps on ps.seqrelid = r.oid
  union all
  select 'column ' || r.sch || '.' || r.relname || '.' || a.attname,
    jsonb_build_object(
      'pos', row_number() over (partition by r.oid order by a.attnum),
      'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'notNull', a.attnotnull,
      'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid),
      'identity', a.attidentity::text,
      'generated', a.attgenerated::text,
      'acl', (select jsonb_agg(x::text order by x::text) from unnest(a.attacl) x)
    )
  from rel r
  join pg_catalog.pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where r.relkind in ('r', 'p', 'v', 'm', 'f')
  union all
  select 'constraint ' || r.sch || '.' || r.relname || '.' || k.conname,
    jsonb_build_object(
      'type', k.contype::text,
      'def', pg_catalog.pg_get_constraintdef(k.oid, true),
      'validated', k.convalidated,
      'deferrable', k.condeferrable,
      'deferred', k.condeferred
    )
  from pg_catalog.pg_constraint k
  join rel r on r.oid = k.conrelid
  union all
  select 'index ' || r.sch || '.' || r.relname || '.' || ic.relname,
    jsonb_build_object(
      'def', pg_catalog.pg_get_indexdef(i.indexrelid, 0, true),
      'unique', i.indisunique,
      'primary', i.indisprimary,
      'valid', i.indisvalid
    )
  from pg_catalog.pg_index i
  join rel r on r.oid = i.indrelid
  join pg_catalog.pg_class ic on ic.oid = i.indexrelid
  union all
  select 'trigger ' || r.sch || '.' || r.relname || '.' || t.tgname,
    jsonb_build_object(
      'def', pg_catalog.pg_get_triggerdef(t.oid, true),
      'enabled', t.tgenabled::text
    )
  from pg_catalog.pg_trigger t
  join rel r on r.oid = t.tgrelid
  where not t.tgisinternal
  union all
  select 'policy ' || r.sch || '.' || r.relname || '.' || p.polname,
    jsonb_build_object(
      'cmd', p.polcmd::text,
      'permissive', p.polpermissive,
      'roles', (
        select jsonb_agg(rn order by rn)
        from (
          select case when ro = 0 then 'public' else pg_catalog.pg_get_userbyid(ro) end as rn
          from unnest(p.polroles) ro
        ) q
      ),
      'using', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
      'check', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
    )
  from pg_catalog.pg_policy p
  join rel r on r.oid = p.polrelid
  union all
  select 'function ' || s.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
    jsonb_build_object(
      'kind', p.prokind::text,
      'owner', pg_catalog.pg_get_userbyid(p.proowner),
      'acl', (select jsonb_agg(a::text order by a::text) from unnest(p.proacl) a),
      'secdef', p.prosecdef,
      'config', (select jsonb_agg(c order by c) from unnest(p.proconfig) c),
      'volatility', p.provolatile::text,
      'strict', p.proisstrict,
      'parallel', p.proparallel::text,
      'leakproof', p.proleakproof,
      'lang', l.lanname,
      'returns', pg_catalog.pg_get_function_result(p.oid),
      'cost', p.procost,
      'rows', p.prorows,
      'def', case when p.prokind = 'a' then null else md5(pg_catalog.pg_get_functiondef(p.oid)) end
    )
  from pg_catalog.pg_proc p
  join scope s on s.oid = p.pronamespace
  join pg_catalog.pg_language l on l.oid = p.prolang
  where not exists (
    select 1 from pg_catalog.pg_depend d
    where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
  )
  union all
  select 'type ' || s.nspname || '.' || t.typname,
    jsonb_build_object(
      'kind', t.typtype::text,
      'owner', pg_catalog.pg_get_userbyid(t.typowner),
      'acl', (select jsonb_agg(a::text order by a::text) from unnest(t.typacl) a),
      'labels', case when t.typtype = 'e' then (
        select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_catalog.pg_enum e where e.enumtypid = t.oid
      ) end,
      'base', case when t.typtype = 'd' then pg_catalog.format_type(t.typbasetype, t.typtypmod) end,
      'notNull', t.typnotnull,
      'default', t.typdefault,
      'checks', (
        select jsonb_agg(pg_catalog.pg_get_constraintdef(k.oid, true) order by k.conname)
        from pg_catalog.pg_constraint k where k.contypid = t.oid
      )
    )
  from pg_catalog.pg_type t
  join scope s on s.oid = t.typnamespace
  where t.typtype in ('e', 'd')
  union all
  select 'extension ' || e.extname,
    jsonb_build_object('schema', n.nspname)
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname not in (select jsonb_array_elements_text(:'platform_ext'::jsonb))
  union all
  select 'defacl ' || pg_catalog.pg_get_userbyid(d.defaclrole) || ' ' || s.nspname || ' ' || d.defaclobjtype::text,
    jsonb_build_object(
      'acl', (select jsonb_agg(a::text order by a::text) from unnest(d.defaclacl) a)
    )
  from pg_catalog.pg_default_acl d
  join scope s on s.oid = d.defaclnamespace
)
select jsonb_build_object(
  'db', jsonb_build_object(
    'serverVersion', current_setting('server_version'),
    'serverVersionNum', current_setting('server_version_num')::int,
    'dbSizeBytes', pg_catalog.pg_database_size(current_database()),
    'extensions', (
      select coalesce(jsonb_agg(jsonb_build_object('name', e.extname, 'version', e.extversion, 'schema', n.nspname) order by e.extname), '[]'::jsonb)
      from pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid = e.extnamespace
    ),
    'ownerUuid', (select user_id from app.owner),
    'ownerFkMap', (select coalesce(jsonb_agg(ref order by ref), '[]'::jsonb) from owner_fk),
    'aclRoles', (
      select coalesce(jsonb_agg(rolname order by rolname), '[]'::jsonb)
      from pg_catalog.pg_roles
      where oid in (select o from acl_roles)
    ),
    'migrations', :'migrations'::jsonb
  ),
  'tables', (
    select coalesce(jsonb_object_agg(tq.t, jsonb_build_object('rows', tq.n, 'hash', tq.h)), '{}'::jsonb)
    from (:tables_q) tq
  ),
  'sequences', (
    select coalesce(jsonb_object_agg(schemaname || '.' || sequencename, jsonb_build_object('lastValue', last_value)), '{}'::jsonb)
    from pg_catalog.pg_sequences
    where schemaname = 'app'
  ),
  'fingerprint', (select coalesce(jsonb_object_agg(key, attrs), '{}'::jsonb) from fp)
)::text;
rollback;
