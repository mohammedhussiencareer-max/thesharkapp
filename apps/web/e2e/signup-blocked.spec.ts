import { expect, test } from './fixtures';
import { developmentPublicEnv } from './local-guard';

// The app is owner-only: the auth server must refuse every new signup,
// while email + password sign-in for the existing owner keeps working.
test('auth server rejects new signups', async ({ request, supabaseUrl }) => {
  const env = developmentPublicEnv();
  const res = await request.post(`${supabaseUrl}/auth/v1/signup`, {
    headers: { apikey: env.VITE_SUPABASE_ANON_KEY ?? '' },
    data: { email: 'intruder@theshark.test', password: 'Intruder12345' },
  });
  expect(res.ok()).toBe(false);
  const body = (await res.json()) as { error_code?: string };
  expect(body.error_code).toBe('signup_disabled');
});
