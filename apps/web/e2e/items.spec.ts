import { expect, test } from '@playwright/test';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner manages the item catalog', async ({ page }) => {
  test.setTimeout(60_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const mixed = `بوري مخلوط ${stamp}`;
  const size = `بوري كبير ${stamp}`;
  const oil = `زيت اختبار ${stamp}`;
  const renamed = `بوري مخلوط معدل ${stamp}`;
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'الأصناف' }).click();
  await expect(page).toHaveURL('/items');
  await expect(
    page.getByRole('heading', { name: 'الأصناف', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(mixed);
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: mixed, exact: true }),
  ).toBeVisible(visible);

  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(size);
  await page.getByLabel('النوع').selectOption({ label: 'حجم سمك' });
  await page.getByLabel('السمك المخلوط').selectOption({ label: mixed });
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: size, exact: true }),
  ).toBeVisible(visible);

  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(oil);
  await page.getByLabel('النوع').selectOption({ label: 'مكونات' });
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: oil, exact: true }),
  ).toBeVisible(visible);

  const oilCard = page.getByRole('article', { name: oil, exact: true });
  await oilCard.getByRole('button', { name: 'التحويلات' }).click();
  await expect(oilCard.getByText('مفيش تحويلات للصنف ده')).toBeVisible(visible);
  await oilCard.getByLabel('اسم الوحدة').fill('لتر');
  await oilCard.getByLabel('المعامل').fill('0.92');
  await oilCard.getByRole('button', { name: 'ضيف التحويل' }).click();
  await expect(oilCard.getByText('1 لتر = 0.92 كيلو')).toBeVisible(visible);

  const mixedCard = page.getByRole('article', { name: mixed, exact: true });
  await mixedCard.getByRole('button', { name: 'تعديل' }).click();
  await page.getByLabel('الاسم').fill(renamed);
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: renamed, exact: true }),
  ).toBeVisible(visible);

  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(renamed);
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByText('الاسم ده موجود قبل كده')).toBeVisible(visible);
});
