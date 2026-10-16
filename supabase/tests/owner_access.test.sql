begin;

select
  plan (12);

delete from app.owner;

delete from auth.identities
where
  user_id in (
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70'
  );

delete from auth.users
where
  id in (
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70'
  );

insert into
  auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change
  )
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'authenticated',
    'authenticated',
    'owner@theshark.test',
    '',
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70',
    'authenticated',
    'authenticated',
    'intruder@theshark.test',
    '',
    now(),
    '',
    '',
    '',
    ''
  );

set
  local role service_role;

select
  lives_ok (
    $$insert into app.owner (user_id)
      values ('b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f')$$,
    'service role can insert the owner row'
  );

select
  throws_ok (
    $$insert into app.owner (user_id)
      values ('c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70')$$,
    '23505'::char(5),
    null::text,
    'only one owner row is allowed'
  );

reset role;

select
  throws_ok (
    $$insert into app.owner (id, user_id)
      values (false, 'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70')$$,
    '23514'::char(5),
    null::text,
    'owner id must be true'
  );

set
  local role anon;

select
  throws_ok (
    'select * from app.owner',
    '42501'::char(5),
    null::text,
    'anon cannot select app.owner'
  );

select
  throws_ok (
    $$insert into app.owner (user_id)
      values ('c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70')$$,
    '42501'::char(5),
    null::text,
    'anon cannot insert app.owner'
  );

select
  throws_ok (
    'select app.is_owner()',
    '42501'::char(5),
    null::text,
    'anon cannot execute app.is_owner()'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  is (
    app.is_owner (),
    false,
    'is_owner() is false for another authenticated user'
  );

select
  is_empty (
    'select user_id from app.owner',
    'non-owner sees zero rows'
  );

select
  throws_ok (
    $$insert into app.owner (user_id)
      values ('c4e8a1b2-6d70-4f11-8a22-2b3c4d5e6f70')$$,
    '42501'::char(5),
    'permission denied for table owner',
    'authenticated cannot insert app.owner'
  );

reset role;

select
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
      'role',
      'authenticated'
    )::text,
    true
  );

set
  local role authenticated;

select
  is (
    app.is_owner (),
    true,
    'is_owner() is true for the owner'
  );

select
  results_eq (
    'select user_id from app.owner',
    array['b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f'::uuid],
    'owner can select their row'
  );

reset role;

select
  set_config('request.jwt.claims', '{"role":"anon"}', true);

select
  is (
    app.is_owner (),
    false,
    'is_owner() is false for anon'
  );

select
  *
from
  finish ();

rollback;
