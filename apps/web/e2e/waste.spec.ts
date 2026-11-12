import { randomUUID } from 'node:crypto';
import { type Locator, type Page } from '@playwright/test';
import { ownerEmail, ownerPassword } from './.test-owner';
import { expect, test } from './fixtures';

const visible = { timeout: 15_000 };

async function openWaste(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');
  await page.getByRole('link', { name: 'الهالك', exact: true }).click();
  await expect(page).toHaveURL('/waste');
  await expect(page.getByRole('form', { name: 'تسجيل هالك جديد' })).toBeVisible(
    visible,
  );
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
async function settle(scope: Locator, done: Locator): Promise<void> {
  const retry = scope.locator('button:enabled', { hasText: 'إعادة المحاولة' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await expect(done.or(retry)).toBeVisible(visible);
    if (await done.isVisible()) return;
    // The button can vanish when the pending retry finishes, so never wait on it.
    await retry.click({ timeout: 2_000 }).catch(() => undefined);
  }
  await expect(done).toBeVisible(visible);
}

test('owner records waste in grams, corrects it, then voids it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openWaste(page);
  const tag = `e2e-${randomUUID().slice(0, 8)}`;

  const record = page.getByRole('region', { name: 'تسجيل هالك', exact: true });
  const form = record.getByRole('form', { name: 'تسجيل هالك جديد' });
  await form.getByLabel('السبب').selectOption('spoilage');
  await form.getByLabel('الشرح').fill(tag);
  const line = form.getByRole('group', { name: 'سطر 1', exact: true });
  await line.getByLabel(/^الصنف/).selectOption({ label: 'سمك قرارات أ' });
  await line.getByLabel('الكمية').fill('500');
  await line.getByLabel('الوحدة').selectOption('g');
  await expect(line).toContainText('بالوحدة الأساسية: 0.5 كيلو');
  const submit = form.getByRole('button', { name: 'سجّل الهالك' });
  await expect(submit).toBeEnabled(visible);
  await submit.click();

  const saved = record.getByLabel('الفروق الناتجة');
  await settle(record, saved);
  await expect(record.getByRole('status')).toContainText('اتسجل الهالك');
  await expect(shown(saved, 'فرق كمية المخزون')).toHaveText('-0.5');
  await expect(shown(saved, 'فرق قيمة المخزون')).toHaveText('-25.00 ج.م');
  await expect(shown(saved, 'فرق تكلفة المبيعات')).toHaveText('0.00 ج.م');
  await expect(shown(saved, 'فرق الهالك')).toHaveText('25.00 ج.م');
  await expect(shown(saved, 'فرق الربح')).toHaveText('-25.00 ج.م');
  await expect(record.getByLabel('السطور المسجلة')).toContainText('= 0.5 كيلو');
  // The form starts again, so a second record cannot reuse the first one's values.
  await expect(line.getByLabel('الكمية')).toHaveValue('');

  const history = page.getByRole('region', { name: 'سجل الهالك', exact: true });
  const tagged = history.getByRole('article').filter({ hasText: tag });
  const original = tagged.first();
  await expect(original).toBeVisible(visible);
  await expect(original).toContainText('تسجيل — الحالي');
  await expect(original).toContainText('تالف');
  await expect(original).toContainText(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
  await expect(original).toContainText('500 جرام = 0.5 كيلو');
  await expect(original).toContainText('تحويل قياسي');
  await expect(original).toContainText('قيمة الهالك: 25.00 ج.م');
  const originalLabel = await original.getAttribute('aria-label');
  if (!originalLabel) throw new Error('the entry has no label');
  const originalCard = history.getByRole('article', {
    name: originalLabel,
    exact: true,
  });

  await originalCard
    .getByRole('button', { name: 'تصحيح', exact: true })
    .click();
  const correction = originalCard.getByRole('form');
  const correctedLine = correction.getByRole('group', {
    name: 'سطر 1',
    exact: true,
  });
  await expect(correctedLine.getByLabel('الكمية')).toHaveValue('500');
  await expect(correctedLine.getByLabel('الوحدة')).toHaveValue('g');
  await correctedLine.getByLabel('الوحدة').selectOption('kg');
  await correctedLine.getByLabel('الكمية').fill('1');
  const save = correction.getByRole('button', { name: 'حفظ التصحيح' });
  await expect(save).toBeEnabled(visible);
  await save.click();

  const corrected = originalCard.getByLabel('الفروق الناتجة');
  await settle(originalCard, corrected);
  await expect(originalCard.getByRole('status')).toContainText('اتصحّح الهالك');
  await expect(shown(corrected, 'فرق كمية المخزون')).toHaveText('-0.5');
  await expect(shown(corrected, 'فرق قيمة المخزون')).toHaveText('-25.00 ج.م');
  await expect(shown(corrected, 'فرق تكلفة المبيعات')).toHaveText('0.00 ج.م');
  await expect(shown(corrected, 'فرق الهالك')).toHaveText('25.00 ج.م');
  await expect(shown(corrected, 'فرق الربح')).toHaveText('-25.00 ج.م');

  // The original stays on record, marked as replaced, with nothing left to change.
  await expect(tagged).toHaveCount(2, visible);
  await expect(originalCard).toContainText('اتصحّح');
  await expect(originalCard).toContainText('اتصحّح بالسجل رقم');
  await expect(originalCard).toContainText('500 جرام = 0.5 كيلو');
  await expect(
    originalCard.getByRole('button', { name: 'إلغاء السجل' }),
  ).toHaveCount(0);
  const current = tagged.first();
  await expect(current).toContainText('تصحيح — الحالي');
  await expect(current).toContainText('قيمة الهالك: 50.00 ج.م');
  const currentLabel = await current.getAttribute('aria-label');
  if (!currentLabel) throw new Error('the correction has no label');
  const currentCard = history.getByRole('article', {
    name: currentLabel,
    exact: true,
  });

  await currentCard.getByRole('button', { name: 'إلغاء السجل' }).click();
  await currentCard.getByRole('button', { name: 'تأكيد الإلغاء' }).click();
  const voided = currentCard.getByLabel('الفروق الناتجة');
  await settle(currentCard, voided);
  await expect(currentCard.getByRole('status')).toContainText('اتلغى');
  await expect(shown(voided, 'فرق كمية المخزون')).toHaveText('1');
  await expect(shown(voided, 'فرق قيمة المخزون')).toHaveText('50.00 ج.م');
  await expect(shown(voided, 'فرق تكلفة المبيعات')).toHaveText('0.00 ج.م');
  await expect(shown(voided, 'فرق الهالك')).toHaveText('-50.00 ج.م');
  await expect(shown(voided, 'فرق الربح')).toHaveText('50.00 ج.م');

  await expect(tagged).toHaveCount(3, visible);
  await expect(tagged.first()).toContainText('إلغاء — ملغي');
  await expect(
    history.getByRole('article', { name: currentLabel, exact: true }),
  ).toContainText('اتصحّح');
});

test('the reason other needs an explanation before anything is sent', async ({
  page,
}) => {
  await openWaste(page);
  const form = page.getByRole('form', { name: 'تسجيل هالك جديد' });
  await form.getByLabel('السبب').selectOption('other');
  const line = form.getByRole('group', { name: 'سطر 1', exact: true });
  await line.getByLabel(/^الصنف/).selectOption({ label: 'سمك قرارات ب' });
  await line.getByLabel('الكمية').fill('1');
  const submit = form.getByRole('button', { name: 'سجّل الهالك' });
  await expect(submit).toBeEnabled(visible);
  await submit.click();
  await expect(form.getByRole('alert')).toContainText('اكتب شرح');
  await expect(page.getByRole('status')).toHaveCount(0);
});
