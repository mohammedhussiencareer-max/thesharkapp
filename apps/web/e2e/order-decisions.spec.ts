import { randomUUID } from 'node:crypto';
import { type Locator, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';
import { ownerEmail, ownerPassword } from './.test-owner';
import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl, developmentPublicEnv } from './local-guard';
import { seededOrderDecisions } from './seed-order-decisions';

const visible = { timeout: 15_000 };

async function openDecisions(
  page: Page,
  orderNumber: number,
): Promise<Locator> {
  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');
  await page.getByRole('link', { name: 'قرارات الطلبات' }).click();
  await expect(page).toHaveURL('/order-decisions');
  const card = page.getByRole('article', {
    name: `طلب رقم ${orderNumber}`,
    exact: true,
  });
  await expect(card).toBeVisible(visible);
  return card;
}

/** The value next to a term of a differences list. */
function shown(list: Locator, term: string): Locator {
  return list
    .locator('dt', { hasText: term })
    .locator('xpath=following-sibling::dd[1]');
}

/**
 * A parallel spec can hold the single running sync, which leaves the save
 * unknown. The same request is then sent again until the expected result shows.
 */
async function settle(card: Locator, done: Locator): Promise<void> {
  const retry = card.locator('button:enabled', { hasText: 'إعادة المحاولة' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await expect(done.or(retry)).toBeVisible(visible);
    if (await done.isVisible()) return;
    // The button can vanish when the pending retry finishes, so never wait on it.
    await retry.click({ timeout: 2_000 }).catch(() => undefined);
  }
  await expect(done).toBeVisible(visible);
}

async function ownerClient(apiUrl: string) {
  assertLocalSupabaseUrl(apiUrl);
  const owner = createClient<Database>(
    apiUrl,
    developmentPublicEnv().VITE_SUPABASE_ANON_KEY ?? '',
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  const signedIn = await owner.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (signedIn.error) throw signedIn.error;
  return owner;
}

test('owner flips a canceled order to not made and sees the exact differences', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { canceled } = seededOrderDecisions();
  const card = await openDecisions(page, canceled.number);

  await expect(card).toContainText('ملغي — اتعمل (افتراضي من النظام)');
  await expect(card).toContainText(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  const basis = card.getByLabel('أساس التحضير');
  await expect(basis).toContainText('جاهز');
  await expect(basis).toContainText('سمك قرارات أ');
  const current = card.getByLabel('الفروق الحالية');
  await expect(shown(current, 'فرق تكلفة المبيعات')).toHaveText('-100.00 ج.م');
  await expect(shown(current, 'فرق الهالك')).toHaveText('100.00 ج.م');
  await expect(shown(current, 'فرق الربح')).toHaveText('0.00 ج.م');

  await card.getByRole('radio', { name: 'ماتعملش' }).check();
  await expect(card.getByRole('button', { name: 'حفظ القرار' })).toBeDisabled();
  const reason = 'المطبخ ما حضّرش الطلب';
  await card.getByLabel('سبب تغيير القرار').fill(reason);
  await card.getByRole('button', { name: 'حفظ القرار' }).click();

  const result = card.getByLabel('الفروق الناتجة');
  await settle(card, result);
  await expect(shown(result, 'فرق كمية المخزون')).toHaveText('2');
  await expect(shown(result, 'فرق قيمة المخزون')).toHaveText('100.00 ج.م');
  await expect(shown(result, 'فرق تكلفة المبيعات')).toHaveText('0.00 ج.م');
  await expect(shown(result, 'فرق الهالك')).toHaveText('-100.00 ج.م');
  await expect(shown(result, 'فرق الربح')).toHaveText('100.00 ج.م');

  await expect(card).toContainText('ملغي — ماتعملش (قرارك)', visible);
  await expect(card).toContainText(`سبب القرار: ${reason}`);
  await expect(card.getByText('سجل القرارات (2)')).toBeVisible();
  await card.getByText('سجل القرارات (2)').click();
  await expect(card.getByText(`السبب: ${reason}`)).toBeVisible();

  // The decided order leaves the pending list on the next refresh only.
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'تحديث' }).click();
  await expect(card).toHaveCount(0, visible);
  await page.getByRole('button', { name: 'كل الطلبات' }).click();
  await expect(card).toBeVisible(visible);
  await expect(card).toContainText('ملغي — ماتعملش (قرارك)');
});

test('owner records cumulative returned quantities for a partial refund', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { partial } = seededOrderDecisions();
  const card = await openDecisions(page, partial.number);

  await expect(card).toContainText('مرتجع جزئي — اتعمل (افتراضي من النظام)');
  await expect(card.getByLabel('المرتجعات')).toContainText('30.00 ج.م');
  const basis = card.getByLabel('أساس التحضير');
  await expect(basis).toContainText('سمك قرارات أ');
  await expect(basis).toContainText('سمك قرارات ب');
  await expect(card.getByLabel('المرتجع من سمك قرارات أ')).toHaveCount(0);

  await card.getByRole('radio', { name: 'ماتعملش' }).check();
  const returnedA = card.getByLabel('المرتجع من سمك قرارات أ');
  await expect(returnedA).toBeVisible();
  await card.getByLabel('سبب تغيير القرار').fill('الزبون رجّع كيلو');

  await returnedA.fill('2.5');
  await expect(card.getByText('الكمية المرتجعة أكبر من المحضّر')).toBeVisible();
  await expect(card.getByRole('button', { name: 'حفظ القرار' })).toBeDisabled();
  await returnedA.fill('1');
  await expect(card.getByRole('button', { name: 'حفظ القرار' })).toBeEnabled();
  await card.getByRole('button', { name: 'حفظ القرار' }).click();

  const first = card.getByLabel('الفروق الناتجة');
  await settle(card, first);
  await expect(shown(first, 'فرق كمية المخزون')).toHaveText('1');
  await expect(shown(first, 'فرق قيمة المخزون')).toHaveText('50.00 ج.م');
  await expect(shown(first, 'فرق تكلفة المبيعات')).toHaveText('-50.00 ج.م');
  await expect(shown(first, 'فرق الهالك')).toHaveText('0.00 ج.م');
  await expect(shown(first, 'فرق الربح')).toHaveText('50.00 ج.م');
  await expect(card).toContainText('مرتجع جزئي — ماتعملش (قرارك)', visible);

  // The stored quantity is the starting point, and a new total replaces it, so
  // the change caused by this decision is only the extra half kilo.
  await expect(returnedA).toHaveValue('1', visible);
  await returnedA.fill('1.5');
  await card.getByRole('button', { name: 'تأكيد القرار' }).click();
  const second = card.getByLabel('الفروق الناتجة');
  await settle(card, second);
  await expect(shown(second, 'فرق كمية المخزون')).toHaveText('0.5');
  await expect(shown(second, 'فرق قيمة المخزون')).toHaveText('25.00 ج.م');
  await expect(shown(second, 'فرق تكلفة المبيعات')).toHaveText('-25.00 ج.م');
  await expect(shown(second, 'فرق الهالك')).toHaveText('0.00 ج.م');
  await expect(shown(second, 'فرق الربح')).toHaveText('25.00 ج.م');
  await expect(card.getByText('سجل القرارات (3)')).toBeVisible(visible);
});

test('a decision made elsewhere makes the open page refuse and reload', async ({
  page,
  supabaseUrl,
}) => {
  test.setTimeout(90_000);
  const { stale } = seededOrderDecisions();
  const card = await openDecisions(page, stale.number);
  await expect(card).toContainText('ملغي — اتعمل (افتراضي من النظام)');

  const owner = await ownerClient(supabaseUrl);
  const app = owner.schema('app');
  const queued = await app
    .from('order_decision_queue')
    .select('token')
    .eq('order_id', stale.id)
    .single();
  if (queued.error) throw queued.error;
  const token = queued.data.token;
  if (!token) throw new Error('the seeded order has no decision token');
  for (let attempt = 0; ; attempt += 1) {
    const competing = await app.rpc('set_order_disposition', {
      p_request_id: randomUUID(),
      p_order_id: stale.id,
      p_decision: 'not_made',
      p_token: token,
      p_reason: 'قرار من جهاز تاني',
      p_returned: null,
    });
    if (!competing.error) break;
    if (attempt >= 5 || !competing.error.message.includes('sync is running')) {
      throw competing.error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await owner.auth.signOut();

  await card.getByRole('radio', { name: 'ماتعملش' }).check();
  await card.getByLabel('سبب تغيير القرار').fill('قراري أنا');
  await card.getByRole('button', { name: 'حفظ القرار' }).click();

  const refusal = card
    .getByRole('alert')
    .filter({ hasText: 'الطلب اتغيّر من ساعة ما فتحته' });
  await settle(card, refusal);
  await expect(card).toContainText('ملغي — ماتعملش (قرارك)', visible);
  await expect(card).toContainText('سبب القرار: قرار من جهاز تاني');
  await expect(card.getByText('سجل القرارات (2)')).toBeVisible();
  await expect(card.getByRole('radio', { name: 'ماتعملش' })).toBeChecked();
  await expect(card.getByLabel('الفروق الناتجة')).toHaveCount(0);
});
