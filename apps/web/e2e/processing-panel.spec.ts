import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';
import { localServiceRoleKey, ownerEmail, ownerPassword } from './.test-owner';
import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl } from './local-guard';
import { seedPendingAccountingOrder } from './seed-order-decisions';

function pendingOf(text: string): number {
  const match = text.match(/مستني\s+(\d+)/);
  if (!match || match[1] === undefined) {
    throw new Error(`pending count was not shown: ${text}`);
  }
  return Number(match[1]);
}

function processedOf(text: string): number {
  const match = text.match(/اتعالج\s+(\d+)\s+من\s+\d+/);
  if (!match || match[1] === undefined) {
    throw new Error(`processed count was not shown: ${text}`);
  }
  return Number(match[1]);
}

test('owner runs one seeded order until the queue is empty', async ({
  page,
  supabaseUrl,
}) => {
  test.setTimeout(90_000);
  const visible = { timeout: 15_000 };
  assertLocalSupabaseUrl(supabaseUrl);
  const client = createClient<Database>(supabaseUrl, localServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const orderId = await seedPendingAccountingOrder(client, supabaseUrl);

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');
  await page.getByRole('link', { name: 'المبيعات' }).click();
  await expect(page).toHaveURL('/sales');

  const panel = page.getByRole('region', { name: 'معالجة الخصم' });
  await expect(panel).toBeVisible(visible);
  const pending = panel.locator('p').filter({ hasText: /^مستني/ });
  const progress = panel.locator('p').filter({ hasText: /^اتعالج/ });
  const pendingBefore = pendingOf((await pending.textContent()) ?? '');
  const processedBefore = processedOf((await progress.textContent()) ?? '');
  expect(pendingBefore).toBeGreaterThan(0);

  const run = panel.getByRole('button', { name: 'شغّل الخصم' });
  const done = panel.locator('p').filter({ hasText: /^مفيش شغل مستني$/ });
  const transient = panel
    .locator('p')
    .filter({ hasText: /^الحساب مشغول$/ })
    .or(panel.locator('p').filter({ hasText: /^المزامنة شغالة$/ }));
  let settled = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(run).toBeEnabled(visible);
    await run.click();
    await expect(done.or(transient)).toBeVisible(visible);
    if (await done.isVisible()) {
      settled = true;
      break;
    }
  }
  expect(settled).toBe(true);
  await expect(panel.getByText('الحساب وقف بسبب خطأ في الدفتر')).toHaveCount(0);
  await expect(panel.getByText('طلب فشل واتسجل. الباقي مستني')).toHaveCount(0);
  await expect(panel.getByText('المكالمة ما اكتملتش')).toHaveCount(0);
  await expect(pending).toHaveText(/مستني\s+0/, visible);
  await expect
    .poll(
      async () => processedOf((await progress.textContent()) ?? ''),
      visible,
    )
    .toBeGreaterThan(processedBefore);

  const stored = await client
    .schema('app')
    .from('accounting_work_events')
    .select('processed_at')
    .eq('order_id', orderId);
  if (stored.error) throw stored.error;
  expect(stored.data.length).toBeGreaterThan(0);
  expect(stored.data.every((row) => row.processed_at !== null)).toBe(true);
});
