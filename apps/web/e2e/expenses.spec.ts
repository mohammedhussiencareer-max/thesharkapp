import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

async function voidOpenExpenses(page: Page): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    const buttons = page.getByRole('button', { name: 'إلغاء المصروف' });
    const before = await buttons.count();
    if (before === 0) return;
    await buttons.first().click();
    await page.getByLabel('سبب الإلغاء').fill('تنظيف اختبار');
    await page.getByRole('button', { name: 'تأكيد الإلغاء' }).click();
    await expect(buttons).toHaveCount(before - 1, { timeout: 15_000 });
  }
  throw new Error('leftover expenses');
}

test('owner records expenses and sees the daily allocation', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'المصاريف' }).click();
  await expect(page).toHaveURL('/expenses');
  await expect(
    page.getByRole('heading', { name: 'المصاريف', exact: true }),
  ).toBeVisible();

  await page.getByLabel('الشهر').fill('2030-04');
  const table = page.getByRole('table', { name: 'توزيع الشهر' });
  await expect(table).toBeVisible(visible);
  await voidOpenExpenses(page);

  const form = page.getByRole('form', { name: 'مصروف جديد' });

  await form.getByLabel('التصنيف').selectOption({ label: 'إيجار' });
  await form.getByLabel('المبلغ').fill('1000');
  const estimate = form.getByRole('checkbox', { name: 'تقدير' });
  if (await estimate.isChecked()) await estimate.uncheck();
  await form.getByRole('button', { name: 'حفظ المصروف' }).click();
  await expect(table.getByRole('cell', { name: '33.34 ج.م' })).toHaveCount(
    20,
    visible,
  );
  await expect(table.getByRole('cell', { name: '33.33 ج.م' })).toHaveCount(40);
  await expect(table.getByRole('row', { name: 'إجمالي الشهر' })).toContainText(
    '1000.00',
  );

  await form.getByLabel('التصنيف').selectOption({ label: 'أجر طيارين' });
  await form.getByLabel('التاريخ').fill('2030-04-15');
  await form.getByLabel('الساعات').fill('5.5');
  await form.getByLabel('سعر الساعة').fill('30');
  await form.getByLabel('اسم الطيار').fill('طيار اختبار');
  await expect(form.getByLabel('المبلغ')).toContainText('165.00');
  await form.getByRole('button', { name: 'حفظ المصروف' }).click();
  await expect(table.getByRole('row', { name: /15\/04\/2030/ })).toContainText(
    '165.00',
    visible,
  );

  await form.getByLabel('التصنيف').selectOption({ label: 'غاز' });
  await form.getByLabel('التاريخ').fill('2030-04-03');
  await form.getByLabel('المبلغ').fill('40');
  await form.getByRole('checkbox', { name: 'تقدير' }).check();
  await form.getByRole('button', { name: 'حفظ المصروف' }).click();
  const estimateRow = page.getByRole('article', { name: /40\.00/ });
  await expect(estimateRow.getByText('تقدير', { exact: true })).toBeVisible(
    visible,
  );

  await form.getByLabel('التصنيف').selectOption({ label: 'غاز' });
  await form.getByLabel('التاريخ').fill('2030-04-03');
  await form.getByLabel('المبلغ').fill('55');
  await form.getByRole('checkbox', { name: 'تقدير' }).uncheck();
  await form.getByRole('button', { name: 'حفظ المصروف' }).click();
  await expect(page.getByText('التقدير اتلغى بالفاتورة')).toBeVisible(visible);
  const third = table.getByRole('row', { name: /03\/04\/2030/ });
  await expect(third).toContainText('55.00');
  await expect(third).not.toContainText('95.00');
});
