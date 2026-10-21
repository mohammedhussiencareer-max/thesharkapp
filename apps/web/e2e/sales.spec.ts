import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner reviews a shift with a refund and a matching drawer', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'المبيعات' }).click();
  await expect(page).toHaveURL('/sales');
  await expect(
    page.getByRole('heading', { name: 'المبيعات', exact: true }),
  ).toBeVisible(visible);
  await expect(page.getByText(/آخر مزامنة/)).toBeVisible(visible);
  const shift = page
    .getByRole('article')
    .filter({ hasText: 'مطابق للدرج' })
    .filter({ hasText: 'صافي المبيعات 210.00 ج.م' })
    .filter({ hasText: 'مرتجعات 40.00 ج.م' });
  await expect(shift).toBeVisible(visible);

  await shift.getByRole('link', { name: /^وردية / }).click();
  await expect(page).toHaveURL('/sales/shift-e2e-sales-1');
  await expect(page.getByText('صافي المبيعات 210.00 ج.م')).toBeVisible(visible);
  const order = page.getByRole('row').filter({ hasText: '9001' });
  await expect(order).toBeVisible(visible);
  await expect(order.getByRole('cell', { name: '250.00 ج.م' })).toBeVisible();
  await expect(order.getByRole('cell', { name: '40.00 ج.م' })).toBeVisible();

  await page.getByRole('button', { name: 'السطور' }).click();
  await expect(page.getByText('سمكة اختبار')).toBeVisible(visible);
  await expect(page.getByText('وسط')).toBeVisible(visible);
  await expect(page.getByText('مشوي')).toBeVisible(visible);
  // The order total cell and the expanded line total.
  await expect(page.getByText('250.00 ج.م', { exact: true })).toHaveCount(2);
});
