import { sampleNames, sampleWorkbook } from '../src/test/sample-workbook';
import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner imports a workbook and sees the recipes with a ready preview', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const suffix = ` اختبار ${stamp}`;
  const names = sampleNames(suffix);
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.goto('/recipes');
  await page.getByRole('link', { name: 'استيراد الوصفات' }).click();
  await expect(page).toHaveURL('/recipes/import');

  await page.getByLabel('ملف الوصفات (xlsx)').setInputFiles({
    name: 'recipes.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(sampleWorkbook({ suffix, fullLosses: true })),
  });
  await expect(page.getByRole('region', { name: 'ملخص الملف' })).toBeVisible(
    visible,
  );
  await expect(
    page.getByRole('listitem', { name: `وصفة ${names.dish}` }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem', { name: `مكوّن ${names.fish}` }),
  ).toBeVisible();
  await expect(page.getByText(/987|123\.45|555|777|321/)).toHaveCount(0);

  await page.getByRole('button', { name: 'احفظ الاستيراد' }).click();
  await expect(page.getByText('راجع الملاحظات الحمرا قبل الحفظ')).toBeVisible();

  await page.getByRole('button', { name: 'أكّد كل المقترحات' }).click();
  for (const button of await page
    .getByRole('button', { name: /^أكّد (?!كل)/ })
    .all()) {
    if (await button.isEnabled()) await button.click();
  }
  const losses = page.getByRole('checkbox', { name: /^اعتمد فاقد/ });
  await expect(losses).toHaveCount(5);
  for (const box of await losses.all()) await box.check();
  await page.getByLabel('وقت السريان').selectOption({ label: 'الآن' });
  await page.getByRole('button', { name: 'احفظ الاستيراد' }).click();
  await expect(
    page.getByRole('region', { name: 'نتيجة الاستيراد' }),
  ).toBeVisible(visible);
  await expect(page.getByText('الاستيراد اتحفظ')).toBeVisible();

  await page.getByRole('link', { name: 'شوف الوصفات' }).click();
  await expect(page).toHaveURL('/recipes');
  const list = page.getByRole('list', { name: 'الوصفات' });
  for (const name of [names.dish, names.sauce, names.rice]) {
    const row = list.getByRole('listitem').filter({
      has: page.getByRole('link', { name, exact: true }),
    });
    await expect(row).toBeVisible(visible);
    await expect(row).toContainText('النسخة: متحددة');
  }

  await list.getByRole('link', { name: names.dish, exact: true }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/, visible);
  const requirements = page.getByRole('list', { name: 'المكونات المطلوبة' });
  await expect(requirements).toBeVisible(visible);
  for (const name of [names.fish, names.salt, names.oil, names.tomato]) {
    await expect(requirements).toContainText(name);
  }
  await expect(page.getByText(/جنيه|EGP/)).toHaveCount(0);
});
