import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner sorts mixed fish into sizes and sees the loss', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const mixed = `بوري مخلوط ${stamp}`;
  const large = `بوري كبير ${stamp}`;
  const small = `بوري وسط ${stamp}`;
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'الأصناف' }).click();
  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(mixed);
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: mixed, exact: true }),
  ).toBeVisible(visible);

  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(large);
  await page.getByLabel('النوع').selectOption({ label: 'حجم سمك' });
  await page.getByLabel('السمك المخلوط').selectOption({ label: mixed });
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: large, exact: true }),
  ).toBeVisible(visible);

  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(small);
  await page.getByLabel('النوع').selectOption({ label: 'حجم سمك' });
  await page.getByLabel('السمك المخلوط').selectOption({ label: mixed });
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: small, exact: true }),
  ).toBeVisible(visible);

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'الرصيد الافتتاحي' }).click();
  const mixedRow = page.getByRole('article', { name: mixed, exact: true });
  await expect(mixedRow).toBeVisible(visible);
  await mixedRow.getByLabel(`كمية ${mixed}`).fill('10');
  await mixedRow.getByLabel(`تكلفة ${mixed}`).fill('50');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'اتسجل الرصيد الافتتاحي',
    visible,
  );

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'الفرز' }).click();
  await expect(page).toHaveURL('/sorting');
  await expect(
    page.getByRole('heading', { name: 'الفرز', exact: true }),
  ).toBeVisible();
  await page.getByLabel('السمك المخلوط').selectOption({ label: mixed });
  await expect(page.getByText(/الرصيد 10 كيلو/)).toBeVisible(visible);
  await page.getByLabel('كمية المخلوط').fill('10');
  await page.getByLabel(`كمية ${large}`).fill('6');
  await page.getByLabel(`كمية ${small}`).fill('3.5');
  await expect(
    page.getByRole('region', { name: 'معاينة الفرز' }),
  ).toContainText('الفاقد 0.5 كيلو');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('اتسجل الفرز', visible);

  const row = page.getByRole('article', { name: mixed, exact: true });
  await expect(row).toBeVisible(visible);
  await expect(row.getByText('الفاقد 0.5 كيلو')).toBeVisible();
  await expect(row.getByText(`${large}: 6 كيلو`)).toBeVisible();
  await expect(row.getByText(`${small}: 3.5 كيلو`)).toBeVisible();
});
