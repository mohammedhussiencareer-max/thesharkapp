import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The app is owner-only: the auth server must refuse every new signup,
// while email + password sign-in for the existing owner keeps working.
const localEnv = readFileSync(
  join(import.meta.dirname, '..', '.env.development'),
  'utf8',
);
const envValue = (key: string) =>
  new RegExp(`^${key}=(.+)$`, 'm').exec(localEnv)?.[1]?.trim() ?? '';

test('auth server rejects new signups', async ({ request }) => {
  const res = await request.post(
    `${envValue('VITE_SUPABASE_URL')}/auth/v1/signup`,
    {
      headers: { apikey: envValue('VITE_SUPABASE_ANON_KEY') },
      data: { email: 'intruder@theshark.test', password: 'Intruder12345' },
    },
  );
  expect(res.ok()).toBe(false);
  const body = (await res.json()) as { error_code?: string };
  expect(body.error_code).toBe('signup_disabled');
});
