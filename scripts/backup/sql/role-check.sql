begin read only;

select
  jsonb_build_object(
    'canLogin',
    r.rolcanlogin,
    'bypassRls',
    r.rolbypassrls,
    'super',
    r.rolsuper,
    'createRole',
    r.rolcreaterole,
    'createDb',
    r.rolcreatedb,
    'replication',
    r.rolreplication,
    'memberships',
    (
      select
        coalesce(
          jsonb_agg(
            g.rolname
            order by
              g.rolname
          ),
          '[]'::jsonb
        )
      from
        pg_catalog.pg_auth_members m
        join pg_catalog.pg_roles g on g.oid = m.roleid
      where
        m.member = r.oid
    ),
    'writable',
    (
      select
        coalesce(
          jsonb_agg(
            c.relname
            order by
              c.relname
          ),
          '[]'::jsonb
        )
      from
        pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where
        n.nspname in ('app', 'ledger_scratch')
        and c.relkind in ('r', 'p')
        and (
          has_table_privilege(r.oid, c.oid, 'INSERT')
          or has_table_privilege(r.oid, c.oid, 'UPDATE')
          or has_table_privilege(r.oid, c.oid, 'DELETE')
          or has_table_privilege(r.oid, c.oid, 'TRUNCATE')
        )
    ),
    'schemaCreate',
    (
      select
        coalesce(
          jsonb_agg(
            n.nspname
            order by
              n.nspname
          ),
          '[]'::jsonb
        )
      from
        pg_catalog.pg_namespace n
      where
        n.nspname in ('app', 'ledger_scratch')
        and has_schema_privilege(r.oid, n.oid, 'CREATE')
    ),
    'forbiddenUsage',
    (
      select
        coalesce(
          jsonb_agg(
            n.nspname
            order by
              n.nspname
          ),
          '[]'::jsonb
        )
      from
        pg_catalog.pg_namespace n
      where
        n.nspname in (
          select
            jsonb_array_elements_text(:'forbidden_usage'::jsonb)
        )
        and has_schema_privilege(r.oid, n.oid, 'USAGE')
    )
  )::text
from
  pg_catalog.pg_roles r
where
  r.rolname = current_user;

rollback;
