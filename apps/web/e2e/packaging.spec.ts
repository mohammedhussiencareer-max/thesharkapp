import { randomBytes, randomUUID } from 'node:crypto';
import { type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';
import { localServiceRoleKey, ownerEmail, ownerPassword } from './.test-owner';
import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl, developmentPublicEnv } from './local-guard';

/**
 * One synthetic complete order on a shift that opened just now, with a unique
 * order type. Service role writes the POS rows. The owner writes an opening
 * when the local database has none.
 */
async function seedPackagingOrder(
  apiUrl: string,
  stamp: string,
  itemName: string,
  orderType: string,
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
      p_name: `افتتاح تغليف ${stamp}`,
      p_kind: 'ingredient',
      p_base_unit: 'kg',
      p_count_frequency: 'weekly',
      p_parent_item_id: null as unknown as string,
      p_loss_pct: null as unknown as number,
      p_active: true,
    });
    if (created.error || typeof created.data !== 'string') {
      throw created.error ?? new Error('packaging seed did not create an item');
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
  // A day the other specs do not use, so today's line coverage stays theirs.
  const stampIso = '2030-06-15T10:00:00.000Z';
  const ordered = '2030-06-15T10:02:00.000Z';
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
      throw (
        started.error ?? new Error('packaging seed did not open a sync run')
      );
    }
    const runId = started.data;
    try {
      const ingested = await service.schema('app').rpc('ingest_pos_batch', {
        p_run_id: runId,
        p_shifts: [
          {
            id: `shift-e2e-pack-${stamp}`,
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
            id: `order-e2e-pack-${stamp}`,
            order_number: 9103,
            shift_id: `shift-e2e-pack-${stamp}`,
            status: 'complete',
            order_type: orderType,
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
                line_id: `line-e2e-pack-${stamp}`,
                item_id: `item-e2e-pack-${stamp}`,
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
        p_scope: { shift_ids: [`shift-e2e-pack-${stamp}`] },
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
        p_error: 'e2e packaging seed failed',
      });
      throw error;
    }
  }
}

function orderCoverage(text: string | null): {
  ready: number;
  eligible: number;
} {
  const match = /تغطية الطلبات (\d+) من (\d+)/.exec(text ?? '');
  if (!match) throw new Error(`order coverage was ${text ?? ''}`);
  return { ready: Number(match[1]), eligible: Number(match[2]) };
}

function unreviewedCount(text: string | null): number {
  const match = /تغليف مش متراجع (\d+)/.exec(text ?? '');
  if (!match) throw new Error(`cause text was ${text ?? ''}`);
  return Number(match[1]);
}

/**
 * Show one Cairo day. The end date moves first, then the start, and the
 * summary has to match the coverage response for that day before we read it.
 */
async function showDay(page: Page, day: string): Promise<void> {
  const to = page.getByLabel('إلى تاريخ');
  const from = page.getByLabel('من تاريخ');
  // A re-render during fill can drop the end date and leave start after end,
  // which never requests coverage. Confirm the end date before moving the start.
  await expect(async () => {
    if ((await to.inputValue()) !== day) await to.fill(day);
    await expect(to).toHaveValue(day);
  }).toPass({ timeout: 20_000 });
  const loaded = page.waitForResponse(
    (response) => {
      if (!response.url().includes('pos_mapping_coverage') || !response.ok()) {
        return false;
      }
      try {
        const body = JSON.parse(response.request().postData() ?? '') as {
          p_from?: string;
        };
        return (
          typeof body.p_from === 'string' && body.p_from.startsWith('2030-')
        );
      } catch {
        return false;
      }
    },
    { timeout: 20_000 },
  );
  await expect(async () => {
    if ((await from.inputValue()) !== day) await from.fill(day);
    await expect(from).toHaveValue(day);
  }).toPass({ timeout: 20_000 });
  const response = await loaded;
  const payload = (await response.json()) as {
    orders?: { ready?: number; eligible?: number; coverage?: number | null };
  };
  const orders = payload.orders;
  const summary =
    orders === undefined ||
    orders.eligible === 0 ||
    orders.coverage === null ||
    orders.ready === undefined ||
    orders.eligible === undefined
      ? 'تغطية الطلبات —'
      : `تغطية الطلبات ${orders.ready} من ${orders.eligible}`;
  await expect(page.getByText(summary, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
}

test('owner approves packaging and order coverage counts the order', async ({
  page,
  supabaseUrl,
}) => {
  test.setTimeout(180_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sold = `صنف تغليف ${stamp}`;
  const salt = `ملح تغليف ${stamp}`;
  const orderType = `نوع ${stamp}`;
  const visible = { timeout: 20_000 };
  await seedPackagingOrder(supabaseUrl, stamp, sold, orderType);

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
  const subject = page.getByRole('button', { name: new RegExp(sold) });
  await expect(subject).toContainText('ناقص', visible);
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
  await showDay(page, '2030-06-15');

  const beforeReady = orderCoverage(
    await page.getByText(/تغطية الطلبات /).textContent(),
  );
  const beforeUnreviewed = unreviewedCount(
    await page.getByText(/تغليف مش متراجع/).textContent(),
  );

  const itemPack = page.getByRole('form', { name: 'تغليف الصنف' });
  await itemPack.getByLabel('القرار').selectOption({ label: 'مفيش تغليف' });
  await itemPack.getByLabel('وقت السريان').selectOption({ label: 'الآن' });
  await itemPack.getByRole('button', { name: 'احفظ التغليف' }).click();
  await expect(page.getByText('التغليف اتحفظ')).toBeVisible(visible);

  await page.getByRole('link', { name: 'التغليف' }).click();
  await expect(page).toHaveURL('/packaging');
  await page.getByRole('button', { name: new RegExp(orderType) }).click();
  const typePack = page.getByRole('form', { name: 'تغليف نوع الطلب' });
  await expect(typePack).toBeVisible(visible);
  await typePack.getByLabel('القرار').selectOption({ label: 'مفيش تغليف' });
  await typePack.getByLabel('وقت السريان').selectOption({ label: 'الآن' });
  await typePack.getByRole('button', { name: 'احفظ التغليف' }).click();
  await expect(page.getByText('التغليف اتحفظ')).toBeVisible(visible);
  await expect(page.getByText(/جنيه|EGP|ج\.م/)).toHaveCount(0);

  await page.getByRole('link', { name: 'ربط الكاشير' }).click();
  await expect(page).toHaveURL('/mapping');
  await showDay(page, '2030-06-15');
  await expect
    .poll(async () => {
      const ready = orderCoverage(
        await page.getByText(/تغطية الطلبات /).textContent(),
      );
      return {
        ...ready,
        unreviewed: unreviewedCount(
          await page.getByText(/تغليف مش متراجع/).textContent(),
        ),
      };
    })
    .toEqual({
      ready: beforeReady.ready + 1,
      eligible: beforeReady.eligible,
      unreviewed: beforeUnreviewed - 1,
    });
});
