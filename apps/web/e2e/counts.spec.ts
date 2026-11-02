import { createClient } from '@supabase/supabase-js';
import { waitingForSyncMessage } from '../src/counts/errors';
import type { Database } from '../src/lib/database.types';
import { nowCairoDateTimeLocal } from '../src/purchases/time';
import { localServiceRoleKey, ownerEmail, ownerPassword } from './.test-owner';
import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl } from './local-guard';

/**
 * The owner counts, then submits. The first save stores the count and waits.
 * This spec then starts and finishes an ok run, and presses سجّل الجرد again.
 * That run's started_at is the database clock of the start, so it is after
 * the submit and after the seeded shift's close stamp. The count time is two
 * minutes ago, after the seeded close and after the opening. The seeded shift
 * closed about 20 hours ago. No open shift is seeded. A parallel spec can
 * hold the single running sync; this retries that collision. Coverage uses
 * the same service-role start/finish path as the sales seed.
 */
async function coverCountTime(apiUrl: string): Promise<void> {
  assertLocalSupabaseUrl(apiUrl);
  const client = createClient<Database>(apiUrl, localServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const started = await client.schema('app').rpc('start_pos_sync_run', {
      p_mode: 'recent',
    });
    if (started.error || typeof started.data !== 'number') {
      const message = started.error?.message ?? '';
      if (message.includes('another POS sync is running') && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      throw started.error ?? new Error('count seed did not open a sync run');
    }

    const runId = started.data;
    const finished = await client.schema('app').rpc('finish_pos_sync_run', {
      p_run_id: runId,
      p_status: 'ok',
      p_counts: {},
      p_error: '',
    });
    if (!finished.error) return;
    await client.schema('app').rpc('finish_pos_sync_run', {
      p_run_id: runId,
      p_status: 'failed',
      p_counts: {},
      p_error: 'e2e count coverage failed',
    });
    throw finished.error;
  }
}

test('owner counts a daily item short and sees the shortage', async ({
  page,
  supabaseUrl,
}) => {
  test.setTimeout(90_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `جمبري جرد ${stamp}`;
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'الأصناف' }).click();
  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(name);
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(
    visible,
  );

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'الرصيد الافتتاحي' }).click();
  const opened = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await page.getByLabel('وقت الرصيد').fill(nowCairoDateTimeLocal(opened));
  const row = page.getByRole('article', { name, exact: true });
  await expect(row).toBeVisible(visible);
  await row.getByLabel(`كمية ${name}`).fill('10');
  await row.getByLabel(`تكلفة ${name}`).fill('50');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'اتسجل الرصيد الافتتاحي',
    visible,
  );

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'الجرد اليومي' }).click();
  await expect(page).toHaveURL('/counts');
  await expect(
    page.getByRole('heading', { name: 'الجرد اليومي', exact: true }),
  ).toBeVisible();
  const counted = new Date(Date.now() - 2 * 60 * 1000);
  await page.getByLabel('وقت الجرد').fill(nowCairoDateTimeLocal(counted));
  await expect(page.getByLabel(`الكمية المعدودة ${name}`)).toBeVisible(visible);
  await page.getByLabel(`الكمية المعدودة ${name}`).fill('7');
  await page.getByLabel('ملاحظة').fill(stamp);

  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByText(waitingForSyncMessage)).toBeVisible(visible);

  await coverCountTime(supabaseUrl);

  await page.getByRole('button', { name: 'سجّل الجرد' }).click();
  await expect(page.getByRole('status')).toHaveText('اتسجل الجرد', visible);
  const saved = page.getByRole('article', { name: stamp, exact: true });
  await expect(saved).toBeVisible(visible);
  await expect(saved.getByText('عجز 150.00 ج.م')).toBeVisible();
});
