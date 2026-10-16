-- Single application owner and the RLS helper every future table will use.
revoke all on schema app
from
  public,
  anon;

grant usage on schema app to authenticated,
service_role;

create table app.owner (
  id boolean primary key default true check (id),
  user_id uuid not null unique references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

comment on table app.owner is 'The single application owner. The service role manages the row; authenticated users may only read their own.';

alter table app.owner enable row level security;

create policy owner_select_own on app.owner for
select
  to authenticated using (
    (
      select
        auth.uid ()
    ) = user_id
  );

revoke all on table app.owner
from
  public,
  anon,
  authenticated;

grant
select
  on table app.owner to authenticated;

grant
select
,
  insert,
update,
delete on table app.owner to service_role;

create function app.is_owner () returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    exists (
      select
        1
      from
        app.owner
      where
        user_id = (select auth.uid ())
    );
$$;

comment on function app.is_owner () is 'True only when auth.uid() is the stored owner. False for anon and every other user.';

revoke
execute on function app.is_owner ()
from
  public,
  anon;

grant
execute on function app.is_owner () to authenticated;
