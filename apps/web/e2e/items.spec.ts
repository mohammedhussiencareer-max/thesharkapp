import { expect, test } from './fixtures';
import { ownerEmail, ownerPassword } from './.test-owner';

test('owner manages the item catalog', async ({ page }) => {
  test.setTimeout(90_000);
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
  await page.getByLabel('نسبة الفاقد').fill('5');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  const mixedCard = page.getByRole('article', { name: mixed, exact: true });
  await expect(
    page.getByRole('heading', { name: mixed, exact: true }),
  ).toBeVisible(visible);
  await expect(mixedCard.getByText('فاقد 5%')).toBeVisible(visible);

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

  const unitCode = `u${stamp.replace(/[^a-z0-9]/gi, '')}`.slice(0, 20);
  const unitName = `صندوق${stamp.replace(/[^a-z0-9]/gi, '').slice(0, 6)}`;
  const oilCard = page.getByRole('article', { name: oil, exact: true });
  await oilCard.getByRole('button', { name: 'التحويلات' }).click();
  await expect(oilCard.getByText('1 جرام = 0.001 كيلو تلقائي')).toBeVisible(
    visible,
  );
  const addForm = oilCard.getByRole('form', { name: 'إضافة تحويل' });
  await expect(addForm.getByLabel('الوحدة')).toBeEnabled(visible);
  await addForm.getByLabel('الوحدة').selectOption({ label: 'وحدة جديدة' });
  await addForm.getByLabel('كود الوحدة').fill(unitCode);
  await addForm.getByLabel('اسم الوحدة').fill(unitName);
  await addForm.getByLabel('المعامل').fill('12');
  await addForm.getByLabel('وقت السريان').selectOption({ label: 'الآن' });
  await addForm.getByRole('button', { name: 'ضيف التحويل' }).click();
  await expect(oilCard.getByText(`1 ${unitName} = 12 كيلو`)).toBeVisible(
    visible,
  );

  const conversion = oilCard.getByRole('form', { name: `تحويل ${unitName}` });
  await conversion
    .getByLabel('وقت السريان')
    .selectOption({ label: 'وقت محدد' });
  await conversion.getByLabel('الوقت').fill('2020-01-15T10:00');
  await conversion.getByLabel('سبب التغيير').fill('تصحيح المعامل');
  await conversion.getByLabel(`معامل ${unitCode}`).fill('10');
  await conversion.getByRole('button', { name: 'حفظ المعامل' }).click();
  await expect(oilCard.getByText(/10(\.0+)? من/)).toBeVisible(visible);
  await expect(oilCard.getByText(`1 ${unitName} = 12 كيلو`)).toBeVisible(
    visible,
  );

  await oilCard.getByRole('button', { name: 'تعديل' }).click();
  await page.getByLabel('السعر الافتتاحي المعتمد للوحدة').fill('25');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'تعديل الصنف' })).toHaveCount(
    0,
    visible,
  );
  await oilCard.getByRole('button', { name: 'تعديل' }).click();
  await expect(page.getByLabel('السعر الافتتاحي المعتمد للوحدة')).toHaveValue(
    /25/,
    visible,
  );
  await page.getByRole('button', { name: 'إلغاء' }).click();

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
