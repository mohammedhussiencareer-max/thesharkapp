import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';
import { localServiceRoleKey, ownerEmail, ownerPassword } from './.test-owner';
import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl, developmentPublicEnv } from './local-guard';

/**
 * One synthetic complete order on a shift that opened just now, plus an
 * opening when the local database has none. Service role writes the POS
 * rows. The owner writes the opening. Re-running uses new ids.
 */
async function seedMappingOrder(
  apiUrl: string,
  stamp: string,
  itemName: string,
): Promise<void> {
  assertLocalSupabaseUrl(apiUrl);
  const env = developmentPublicEnv();
  const owner = createClient<Database>(
    apiUrl,
    env.VITE_SUPABASE_ANON_KEY ?? '',
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  const signedIn = await owner.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (signedIn.error) throw signedIn.error;
  const existing = await owner
    .schema('app')
    .from('opening_stocks')
    .select('id')
    .limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data ?? []).length === 0) {
    const created = await owner.schema('app').rpc('create_stock_item', {
      p_request_id: randomUUID(),
      p_name: `افتتاح ربط ${stamp}`,
      p_kind: 'ingredient',
      p_base_unit: 'kg',
      p_count_frequency: 'weekly',
      p_parent_item_id: null as unknown as string,
      p_loss_pct: null as unknown as number,
      p_active: true,
    });
    if (created.error || typeof created.data !== 'string') {
      throw created.error ?? new Error('mapping seed did not create an item');
    }
    const opened = await owner.schema('app').rpc('record_opening_stock', {
      p_occurred_at: '2020-01-01T00:00:00.000Z',
      p_lines: [
        {
          item_id: created.data,
          quantity: '1',
          unit: 'kg',
          unit_cost: '1',
          expected_base_unit: 'kg',
          expected_factor: '1',
        },
      ],
      p_request_id: randomUUID(),
    });
    if (opened.error) throw opened.error;
  }
  await owner.auth.signOut();

  const service = createClient<Database>(apiUrl, localServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const now = new Date();
  const ordered = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  const stampIso = now.toISOString();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const started = await service.schema('app').rpc('start_pos_sync_run', {
      p_mode: 'recent',
    });
    if (started.error || typeof started.data !== 'number') {
      const message = started.error?.message ?? '';
      if (message.includes('another POS sync is running') && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      throw started.error ?? new Error('mapping seed did not open a sync run');
    }
    const runId = started.data;
    try {
      const ingested = await service.schema('app').rpc('ingest_pos_batch', {
        p_run_id: runId,
        p_shifts: [
          {
            id: `shift-e2e-map-${stamp}`,
            opened_at: stampIso,
            closed_at: stampIso,
            is_active: false,
            pos_update_time: stampIso,
            drawer_cash_net: '0.00',
            drawer_credit: '0.00',
            transactions: [],
          },
        ],
        p_orders: [
          {
            id: `order-e2e-map-${stamp}`,
            order_number: 9101,
            shift_id: `shift-e2e-map-${stamp}`,
            status: 'complete',
            order_type: 'takeaway',
            payment_type: 'cash',
            ordered_at: ordered,
            subtotal: '0.00',
            discount: '0.00',
            tax: '0.00',
            service_tax: '0.00',
            delivery_fee: '0.00',
            total: '0.00',
            pos_update_time: stampIso,
            content_hash: randomBytes(32).toString('hex'),
            lines: [
              {
                line_id: `line-e2e-map-${stamp}`,
                item_id: `item-e2e-map-${stamp}`,
                item_name: itemName,
                size_name: null,
                quantity: '1',
                weighted_qty: null,
                unit_price: '0.00',
                options: [],
              },
            ],
          },
        ],
        p_scope: { shift_ids: [`shift-e2e-map-${stamp}`] },
      });
      if (ingested.error) throw ingested.error;
      const finished = await service.schema('app').rpc('finish_pos_sync_run', {
        p_run_id: runId,
        p_status: 'ok',
        p_counts: { orders: 1 },
        p_error: '',
      });
      if (finished.error) throw finished.error;
      return;
    } catch (error) {
      await service.schema('app').rpc('finish_pos_sync_run', {
        p_run_id: runId,
        p_status: 'failed',
        p_counts: {},
        p_error: 'e2e mapping seed failed',
      });
      throw error;
    }
  }
}

function coveredCount(text: string | null): {
  covered: number;
  eligible: number;
} {
  const match = /المغطى (\d+) من (\d+)/.exec(text ?? '');
  if (!match) throw new Error(`coverage text was ${text ?? ''}`);
  return { covered: Number(match[1]), eligible: Number(match[2]) };
}

test('owner maps a cashier subject and coverage counts it', async ({
  page,
  supabaseUrl,
}) => {
  test.setTimeout(120_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sold = `صنف كاشير ${stamp}`;
  const salt = `ملح كاشير ${stamp}`;
  const visible = { timeout: 20_000 };
  await seedMappingOrder(supabaseUrl, stamp, sold);

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'الأصناف' }).click();
  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(salt);
  await page.getByLabel('النوع').selectOption({ label: 'مكونات' });
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: salt, exact: true }),
  ).toBeVisible(visible);

  await page.goto('/');
  await page.getByRole('link', { name: 'ربط الكاشير' }).click();
  await expect(page).toHaveURL('/mapping');
  await expect(
    page.getByRole('heading', { name: 'ربط الكاشير', exact: true }),
  ).toBeVisible(visible);

  const subject = page.getByRole('button', { name: new RegExp(sold) });
  await expect(subject).toContainText('ناقص', visible);
  const before = coveredCount(await page.getByText(/المغطى /).textContent());

  await subject.click();
  const mapping = page.getByRole('form', { name: 'ربط الصنف' });
  await expect(mapping).toBeVisible(visible);
  await mapping.getByLabel('نوع الربط').selectOption({ label: 'صنف مخزون' });
  await mapping.getByLabel('الصنف').selectOption({ label: salt });
  await mapping.getByLabel('الكمية').fill('1');
  await mapping.getByLabel('الوحدة').selectOption({ label: 'كيلو' });
  await mapping.getByLabel('وقت السريان').selectOption({ label: 'الآن' });
  await mapping.getByRole('button', { name: 'احفظ الربط' }).click();
  await expect(page.getByText('الربط اتحفظ')).toBeVisible(visible);

  const policy = page.getByRole('form', { name: 'سياسة الاختيارات' });
  await policy.getByLabel('السياسة').selectOption({ label: 'من غير اختيار' });
  await policy.getByLabel('وقت السريان').selectOption({ label: 'الآن' });
  await policy.getByRole('button', { name: 'احفظ السياسة' }).click();
  await expect(page.getByText('السياسة اتحفظت')).toBeVisible(visible);
  await expect(subject).toContainText('جاهز', visible);

  await expect
    .poll(async () =>
      coveredCount(await page.getByText(/المغطى /).textContent()),
    )
    .toEqual({ covered: before.covered + 1, eligible: before.eligible });
  await expect(page.getByText(/جنيه|EGP|ج\.م/)).toHaveCount(0);
});
