import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';
import { localServiceRoleKey, ownerEmail, ownerPassword } from './.test-owner';
import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl } from './local-guard';
import {
  prepareOrderDecisionCatalog,
  seedOrderDecisions,
} from './seed-order-decisions';

/**
 * The owner records activation from the screen, then the decision fixture is
 * ingested. The seeded order ids are written for the ledger project, because
 * that worker does not inherit this process's environment.
 */
test('the owner activates deductions and the decision fixture drains', async ({
  page,
  supabaseUrl,
}) => {
  test.setTimeout(120_000);
  assertLocalSupabaseUrl(supabaseUrl);
  prepareOrderDecisionCatalog(supabaseUrl);

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');
  await page.goto('/activation');
  await expect(
    page.getByRole('heading', { name: 'مراجعة التفعيل' }),
  ).toBeVisible();
  const activate = page.getByRole('button', { name: 'تفعيل الخصم' });
  await expect(activate).toBeEnabled();
  await activate.click();
  await expect(page.getByText('التفعيل اتسجل')).toBeVisible();

  const client = createClient<Database>(supabaseUrl, localServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  await seedOrderDecisions(client, supabaseUrl);
});
