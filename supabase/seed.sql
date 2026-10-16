-- Synthetic local-only data. Never run this seed against a hosted project.
-- The password is also the local default in apps/web/e2e/.test-owner.ts.
-- Column list matches the auth schema shipped with Supabase CLI 2.121.0
-- (GoTrue v2.197.0, Postgres 17.11.0.004). is_anonymous is omitted: that
-- column is added with default false when the auth migration has applied.
insert into
  auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change,
    email_change_token_current,
    email_change_confirm_status,
    phone_change,
    phone_change_token,
    reauthentication_token,
    is_sso_user
  )
values
  (
    '00000000-0000-0000-0000-000000000000',
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'authenticated',
    'authenticated',
    'owner@theshark.test',
    extensions.crypt ('LocalOwner1234', extensions.gen_salt ('bf', 10)),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    '',
    '',
    0,
    '',
    '',
    '',
    false
  );

insert into
  auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  )
values
  (
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
    jsonb_build_object(
      'sub',
      'b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f',
      'email',
      'owner@theshark.test'
    ),
    'email',
    now(),
    now(),
    now()
  );

insert into
  app.owner (user_id)
values
  ('b7e2c4a0-5f31-4d8e-9c6a-1a2b3c4d5e6f');
