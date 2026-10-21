import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { expect, test } from '@playwright/test';
import type { Database } from '../src/lib/database.types';
import { ownerEmail, ownerPassword } from './.test-owner';
import { assertLocalSupabaseUrl } from './local-guard';

const localEnv = readFileSync(
  join(import.meta.dirname, '..', '.env.development'),
  'utf8',
);
const envValue = (key: string) =>
  new RegExp(`^${key}=(.+)$`, 'm').exec(localEnv)?.[1]?.trim() ?? '';

test('owner records opening stock and a purchase in a converted unit', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const mixed = `بوري مخلوط ${stamp}`;
  const oil = `زيت ${stamp}`;
  const supplier = `مورد ${stamp}`;
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
  await page.getByLabel('الاسم').fill(oil);
  await page.getByLabel('النوع').selectOption({ label: 'مكونات' });
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: oil, exact: true }),
  ).toBeVisible(visible);

  const oilCard = page.getByRole('article', { name: oil, exact: true });
  await oilCard.getByRole('button', { name: 'التحويلات' }).click();
  await oilCard.getByLabel('اسم الوحدة').fill('لتر');
  await oilCard.getByLabel('المعامل').fill('0.92');
  await oilCard.getByRole('button', { name: 'ضيف التحويل' }).click();
  await expect(oilCard.getByText('1 لتر = 0.92 كيلو')).toBeVisible(visible);

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'الرصيد الافتتاحي' }).click();
  await expect(page).toHaveURL('/opening');
  const mixedRow = page.getByRole('article', { name: mixed, exact: true });
  const oilRow = page.getByRole('article', { name: oil, exact: true });
  await expect(mixedRow).toBeVisible(visible);
  await mixedRow.getByLabel(`كمية ${mixed}`).fill('10');
  await mixedRow.getByLabel(`تكلفة ${mixed}`).fill('100');
  await oilRow.getByLabel(`كمية ${oil}`).fill('4');
  await oilRow.getByLabel(`تكلفة ${oil}`).fill('12.5');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'اتسجل الرصيد الافتتاحي',
    visible,
  );
  await expect(mixedRow).toHaveCount(0, visible);
  await expect(oilRow).toHaveCount(0, visible);

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'المشتريات' }).click();
  await expect(page).toHaveURL('/purchases');
  await page.getByLabel('المورد').fill(supplier);
  await page.getByLabel('الصنف').selectOption({ label: oil });
  await page.getByLabel('الكمية').fill('2');
  await page.getByLabel('الوحدة').selectOption({ label: 'لتر' });
  await page.getByLabel('المبلغ').fill('50');
  await expect(page.getByText('تكلفة كيلو: 27.173913 ج.م')).toBeVisible();
  await page.getByRole('button', { name: 'مراجعة' }).click();
  await expect(
    page.getByText('المشتريات نهائية لحد ما نضيف التعديل'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'اتسجلت المشتريات',
    visible,
  );

  const purchase = page.getByRole('article', { name: supplier, exact: true });
  await expect(purchase).toBeVisible(visible);
  await expect(purchase.getByText('50.00 ج.م')).toBeVisible();
  await purchase.getByRole('button', { name: 'التفاصيل' }).click();
  await expect(purchase.getByText(/لتر/)).toBeVisible();

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'الرصيد الافتتاحي' }).click();
  await expect(
    page
      .getByText('كل الأصناف ليها رصيد افتتاحي')
      .or(page.getByLabel('وقت الرصيد')),
  ).toBeVisible(visible);
  await expect(
    page.getByRole('article', { name: mixed, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: oil, exact: true }),
  ).toHaveCount(0);

  const url = envValue('VITE_SUPABASE_URL') || 'http://127.0.0.1:55421';
  assertLocalSupabaseUrl(url);
  const supabase = createClient<Database>(
    url,
    envValue('VITE_SUPABASE_ANON_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  const signedIn = await supabase.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  expect(signedIn.error).toBeNull();
  const db = supabase.schema('app');
  const item = await db
    .from('stock_items')
    .select('id, base_unit')
    .eq('name', mixed)
    .single();
  expect(item.error).toBeNull();
  const refused = await db.rpc('record_opening_stock', {
    p_occurred_at: new Date().toISOString(),
    p_lines: [
      {
        item_id: item.data?.id ?? '',
        quantity: '1',
        unit: item.data?.base_unit ?? 'kg',
        unit_cost: '10',
      },
    ],
  });
  expect(refused.error?.message ?? '').toContain('item already has movements');
});
