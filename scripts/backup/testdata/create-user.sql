-- Synthetic auth user for the backup round trip. Variables: uid, email.
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
:'uid',
    'authenticated',
    'authenticated',
:'email',
    '',
    '2026-01-01 00:00:00+00',
    '',
    '',
    '',
    ''
  );
