import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner reviews dormant deductions, activation, and order cost', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'المبيعات' }).click();
  await expect(page).toHaveURL('/sales');
  const panel = page.getByRole('region', { name: 'معالجة الخصم' });
  await expect(panel).toBeVisible(visible);
  await expect(panel.getByText('مستني')).toBeVisible(visible);
  const run = panel.getByRole('button', { name: 'شغّل الخصم' });
  await run.click();
  await expect(run).toBeEnabled(visible);
  await expect(page.getByText('الخصم لسه ما اتفعّلش')).toBeVisible(visible);
  await expect(page.getByText(/permission denied|SQLSTATE|ERROR:/)).toHaveCount(
    0,
  );

  const shift = page.getByRole('link', { name: /^وردية / }).first();
  await shift.click();
  const status = page.getByRole('region', { name: 'حالة الوردية' });
  await expect(status).toBeVisible(visible);
  await expect(
    status.getByText(/ناقص|تقديري|السمك مقفول|مقفول نهائي/),
  ).toBeVisible(visible);
  const order = page.getByRole('row').filter({ hasText: '9001' });
  await order.getByRole('link', { name: 'تكلفة الطلب' }).click();
  await expect(
    page
      .getByRole('heading', { name: 'تكلفة الطلب' })
      .or(page.getByText('لسه مفيش تكلفة محفوظة')),
  ).toBeVisible(visible);

  await page.getByRole('link', { name: 'المبيعات' }).click();
  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'تفعيل المخزون' }).click();
  await expect(page).toHaveURL('/activation');
  await expect(
    page.getByRole('heading', { name: 'مراجعة التفعيل' }),
  ).toBeVisible(visible);
  await expect(page.getByRole('button', { name: 'تفعيل الخصم' })).toHaveCount(
    0,
  );
});
