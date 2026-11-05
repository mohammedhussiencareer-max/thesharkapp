import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner builds a batch recipe and a dish that uses it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const tomato = `طماطم اختبار ${stamp}`;
  const oil = `زيت اختبار ${stamp}`;
  const sauce = `صلصة اختبار ${stamp}`;
  const dish = `طبق اختبار ${stamp}`;
  const renamed = `طبق اختبار معدل ${stamp}`;
  const visible = { timeout: 15_000 };
  // More digits than a JSON number keeps: a lossy reload would rewrite it as 1.
  const exactQuantity = '1.000000000000000001';

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'الأصناف' }).click();
  await expect(page).toHaveURL('/items');
  for (const { name, loss } of [
    { name: tomato, loss: '20' },
    { name: oil, loss: '50' },
  ]) {
    await page.getByRole('button', { name: 'ضيف صنف' }).click();
    await page.getByLabel('الاسم').fill(name);
    await page.getByLabel('النوع').selectOption({ label: 'مكونات' });
    await page.getByLabel('نسبة الفاقد').fill(loss);
    await page.getByRole('button', { name: 'حفظ', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(
      visible,
    );
  }

  await page.goto('/');
  await page.getByRole('link', { name: 'الوصفات' }).click();
  await expect(page).toHaveURL('/recipes');
  await expect(
    page.getByRole('heading', { name: 'الوصفات', exact: true }),
  ).toBeVisible();

  await page.getByLabel('اسم الوصفة الجديدة').fill(sauce);
  await page.getByLabel('نوع الوصفة الجديدة').selectOption({ label: 'تحضيرة' });
  await page.getByRole('button', { name: 'ضيف وصفة' }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/, visible);
  await expect(
    page.getByRole('heading', { name: sauce, exact: true, level: 1 }),
  ).toBeVisible(visible);
  await expect(page.getByRole('form', { name: 'نسخة الوصفة' })).toBeVisible(
    visible,
  );

  await page.getByLabel('كمية التحضيرة', { exact: true }).fill('2');
  // A label that wraps a select includes its option text, so exact never matches it.
  await page.getByLabel('وحدة التحضيرة').selectOption({ label: 'كيلو' });
  await page.getByRole('button', { name: 'ضيف مكوّن' }).click();
  await page.getByLabel('المكوّن 1').selectOption({ label: tomato });
  await page.getByLabel('الكمية 1', { exact: true }).fill('1.6');
  await expect(page.getByLabel('الوحدة 1')).toHaveValue('kg');
  await page.getByLabel('وقت السريان').selectOption({ label: 'الآن' });
  await page.getByRole('button', { name: 'احفظ النسخة' }).click();
  await expect(page.getByText('نسخة الوصفة اتحفظت')).toBeVisible(visible);
  await expect(
    page.getByRole('region', { name: 'سجل النسخ' }).getByRole('listitem'),
  ).toHaveCount(1, visible);
  await expect(
    page.getByRole('list', { name: 'المكونات المطلوبة' }),
  ).toContainText(new RegExp(`${tomato}: 2(\\.0+)? كيلو`), visible);

  await page.getByRole('link', { name: 'الوصفات', exact: true }).click();
  await expect(page).toHaveURL('/recipes');
  await page.getByLabel('اسم الوصفة الجديدة').fill(dish);
  await page.getByLabel('نوع الوصفة الجديدة').selectOption({ label: 'طبق' });
  await page.getByRole('button', { name: 'ضيف وصفة' }).click();
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/, visible);
  await expect(
    page.getByRole('heading', { name: dish, exact: true, level: 1 }),
  ).toBeVisible(visible);
  await expect(page.getByRole('form', { name: 'نسخة الوصفة' })).toBeVisible(
    visible,
  );

  await page.getByRole('button', { name: 'ضيف مكوّن' }).click();
  await page.getByLabel('المكوّن 1').selectOption({ label: sauce });
  await page.getByLabel('الكمية 1', { exact: true }).fill(exactQuantity);
  await expect(page.getByLabel('الوحدة 1')).toHaveValue('kg');
  await page.getByRole('button', { name: 'ضيف مكوّن' }).click();
  await page.getByLabel('المكوّن 2').selectOption({ label: oil });
  await page.getByLabel('الكمية 2', { exact: true }).fill('50');
  await page.getByLabel('الوحدة 2').selectOption({ label: 'جرام' });
  await page.getByLabel('وقت السريان').selectOption({ label: 'الآن' });
  await page.getByRole('button', { name: 'احفظ النسخة' }).click();
  await expect(page.getByText('نسخة الوصفة اتحفظت')).toBeVisible(visible);

  const requirements = page.getByRole('list', { name: 'المكونات المطلوبة' });
  await expect(requirements).toBeVisible(visible);
  await expect(requirements).toContainText(
    new RegExp(`${tomato}: 1(\\.0+)? كيلو`),
  );
  await expect(requirements).toContainText(
    new RegExp(`${oil}: 0\\.1(0+)? كيلو`),
  );
  await expect(page.getByText(/جنيه|EGP/)).toHaveCount(0);
  await expect(page.getByLabel('الكمية 1', { exact: true })).toHaveValue(
    exactQuantity,
  );

  await page.getByLabel('الكمية 2', { exact: true }).fill('60');
  await page.getByRole('button', { name: 'احفظ النسخة' }).click();
  await expect(requirements).toContainText(
    new RegExp(`${oil}: 0\\.12(0+)? كيلو`),
    visible,
  );
  await page.reload();
  await expect(page.getByLabel('الكمية 1', { exact: true })).toHaveValue(
    exactQuantity,
    visible,
  );
  await expect(page.getByLabel('الكمية 2', { exact: true })).toHaveValue('60');

  await page.getByLabel('اسم الوصفة', { exact: true }).fill(renamed);
  await page.getByRole('button', { name: 'احفظ البيانات' }).click();
  await expect(page.getByText('الوصفة اتحفظت', { exact: true })).toBeVisible(
    visible,
  );
  await expect(
    page.getByRole('heading', { name: renamed, exact: true, level: 1 }),
  ).toBeVisible(visible);

  await page.getByRole('link', { name: 'الوصفات', exact: true }).click();
  await expect(page).toHaveURL('/recipes');
  await expect(
    page.getByRole('link', { name: renamed, exact: true }),
  ).toBeVisible(visible);
  await expect(
    page.getByRole('link', { name: sauce, exact: true }),
  ).toBeVisible();
});
