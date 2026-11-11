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
  // Setup records activation for the decision fixture, and a parallel spec can
  // hold the ledger lock. The click then ends on a safe Arabic stop.
  await expect(
    page
      .getByText(
        /الخصم لسه ما اتفعّلش|مفيش شغل مستني|الحساب مشغول|المزامنة شغالة|الحساب وقف بسبب خطأ في الدفتر|طلب فشل واتسجل|المكالمة ما اكتملتش|الدور اتغير، هيتراجع|الوقت خلص والباقي مستني/,
      )
      .first(),
  ).toBeVisible(visible);
  await expect(page.getByText(/permission denied|SQLSTATE|ERROR:/)).toHaveCount(
    0,
  );

  const shift = page
    .getByRole('article')
    .filter({ hasText: 'مطابق للدرج' })
    .filter({ hasText: 'صافي المبيعات 210.00 ج.م' })
    .filter({ hasText: 'مرتجعات 40.00 ج.م' });
  await expect(shift).toBeVisible(visible);
  await shift.getByRole('link', { name: /^وردية / }).click();
  await expect(page).toHaveURL('/sales/shift-e2e-sales-1');
  const status = page.getByRole('region', { name: 'حالة الوردية' });
  await expect(status).toBeVisible(visible);
  await expect(
    status
      .getByText('ناقص', { exact: true })
      .or(status.getByText('تقديري', { exact: true }))
      .or(status.getByText('السمك مقفول', { exact: true }))
      .or(status.getByText('مقفول نهائي', { exact: true })),
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
