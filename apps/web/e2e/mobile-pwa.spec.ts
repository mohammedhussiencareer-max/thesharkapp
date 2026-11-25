import { createClient } from '@supabase/supabase-js';
import {
  pendingResendMessage,
  waitingForSyncMessage,
} from '../src/counts/errors';
import type { Database } from '../src/lib/database.types';
import { nowCairoDateTimeLocal } from '../src/purchases/time';
import { localServiceRoleKey, ownerEmail, ownerPassword } from './.test-owner';
import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl } from './local-guard';

test.use({
  viewport: { width: 390, height: 844 },
  serviceWorkers: 'block',
});

async function expectNoHorizontalOverflow(page: {
  evaluate: <T>(expression: string) => Promise<T>;
}): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate<{
    scrollWidth: number;
    innerWidth: number;
  }>(
    '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
  );
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
}

async function coverCountTime(apiUrl: string): Promise<void> {
  assertLocalSupabaseUrl(apiUrl);
  const client = createClient<Database>(apiUrl, localServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const app = client.schema('app');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const started = await app.rpc('start_pos_sync_run', { p_mode: 'full' });
    if (started.error || typeof started.data !== 'number') {
      const message = started.error?.message ?? '';
      if (message.includes('another POS sync is running') && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      throw started.error ?? new Error('mobile e2e did not open a sync run');
    }

    const runId = started.data;
    try {
      const [shifts, transactions, orders, lines] = await Promise.all([
        app
          .from('pos_shifts')
          .select(
            'id, opened_at, closed_at, is_active, pos_update_time, drawer_cash_net, drawer_credit',
          )
          .limit(1000),
        app
          .from('pos_shift_transactions')
          .select('shift_id, tx_id, order_id, tx_type, amount, occurred_at')
          .limit(1000),
        app
          .from('pos_orders')
          .select(
            'id, order_number, shift_id, status, order_type, payment_type, ordered_at, subtotal, discount, tax, service_tax, delivery_fee, total, financial_revision, last_financial_operation_key, pos_update_time, content_hash',
          )
          .limit(1000),
        app
          .from('pos_order_lines')
          .select(
            'order_id, line_id, item_id, item_name, size_name, quantity, weighted_qty, weighted_unit, unit_price, price_per_kg, options, line_total',
          )
          .limit(1000),
      ]);
      if (shifts.error) throw shifts.error;
      if (transactions.error) throw transactions.error;
      if (orders.error) throw orders.error;
      if (lines.error) throw lines.error;

      const txsByShift = new Map<
        string,
        NonNullable<typeof transactions.data>
      >();
      for (const tx of transactions.data ?? []) {
        const rows = txsByShift.get(tx.shift_id) ?? [];
        rows.push(tx);
        txsByShift.set(tx.shift_id, rows);
      }
      const linesByOrder = new Map<string, NonNullable<typeof lines.data>>();
      for (const line of lines.data ?? []) {
        const rows = linesByOrder.get(line.order_id) ?? [];
        rows.push(line);
        linesByOrder.set(line.order_id, rows);
      }

      const ingested = await app.rpc('ingest_pos_batch', {
        p_run_id: runId,
        p_shifts: (shifts.data ?? []).map((shift) => ({
          id: shift.id,
          opened_at: shift.opened_at,
          closed_at: shift.closed_at,
          is_active: shift.is_active,
          pos_update_time: shift.pos_update_time,
          drawer_cash_net: shift.drawer_cash_net,
          drawer_credit: shift.drawer_credit,
          transactions: (txsByShift.get(shift.id) ?? []).map((tx) => ({
            tx_id: tx.tx_id,
            order_id: tx.order_id,
            tx_type: tx.tx_type,
            amount: tx.amount,
            occurred_at: tx.occurred_at,
          })),
        })),
        p_orders: (orders.data ?? []).map((order) => ({
          id: order.id,
          order_number: order.order_number,
          shift_id: order.shift_id,
          status: order.status,
          order_type: order.order_type,
          payment_type: order.payment_type,
          ordered_at: order.ordered_at,
          subtotal: order.subtotal,
          discount: order.discount,
          tax: order.tax,
          service_tax: order.service_tax,
          delivery_fee: order.delivery_fee,
          total: order.total,
          financial_revision: order.financial_revision,
          last_financial_operation_key: order.last_financial_operation_key,
          pos_update_time: order.pos_update_time,
          content_hash: order.content_hash,
          lines: (linesByOrder.get(order.id) ?? []).map((line) => ({
            line_id: line.line_id,
            item_id: line.item_id,
            item_name: line.item_name,
            size_name: line.size_name,
            quantity: line.quantity,
            weighted_qty: line.weighted_qty,
            weighted_unit: line.weighted_unit,
            unit_price: line.unit_price,
            price_per_kg: line.price_per_kg,
            options: line.options,
            line_total: line.line_total,
          })),
        })),
        p_scope: { all: true },
      });
      if (ingested.error) throw ingested.error;

      const finished = await app.rpc('finish_pos_sync_run', {
        p_run_id: runId,
        p_status: 'ok',
        p_counts: {
          orders: orders.data?.length ?? 0,
          shifts: shifts.data?.length ?? 0,
        },
        p_error: '',
      });
      if (finished.error) throw finished.error;
      return;
    } catch (error) {
      await app.rpc('finish_pos_sync_run', {
        p_run_id: runId,
        p_status: 'failed',
        p_counts: {},
        p_error: 'mobile e2e count coverage failed',
      });
      throw error;
    }
  }
}

test('owner logs in at 390px viewport in Arabic RTL without horizontal overflow', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expectNoHorizontalOverflow(page);

  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'The Shark' })).toBeVisible();
  await expect(page.getByText(ownerEmail)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('daily count retries the exact request id and payload across a reload at 390px', async ({
  page,
  supabaseUrl,
}) => {
  test.setTimeout(90_000);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `جمبري موبايل ${stamp}`;
  const visible = { timeout: 15_000 };

  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'الأصناف' }).click();
  await page.getByRole('button', { name: 'ضيف صنف' }).click();
  await page.getByLabel('الاسم').fill(name);
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(
    visible,
  );

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'الرصيد الافتتاحي' }).click();
  const opened = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await page.getByLabel('وقت الرصيد').fill(nowCairoDateTimeLocal(opened));
  const row = page.getByRole('article', { name, exact: true });
  await expect(row).toBeVisible(visible);
  await row.getByLabel(`كمية ${name}`).fill('10');
  await row.getByLabel(`تكلفة ${name}`).fill('50');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    'اتسجل الرصيد الافتتاحي',
    visible,
  );

  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await page.getByRole('link', { name: 'الجرد اليومي' }).click();
  await expect(page).toHaveURL('/counts');
  await expectNoHorizontalOverflow(page);

  const counted = new Date(Date.now() - 2 * 60 * 1000);
  await page.getByLabel('وقت الجرد').fill(nowCairoDateTimeLocal(counted));
  await expect(page.getByLabel(`الكمية المعدودة ${name}`)).toBeVisible(visible);
  await page.getByLabel(`الكمية المعدودة ${name}`).fill('7');
  await page.getByLabel('ملاحظة').fill(stamp);

  // Drop the first write reply to simulate a lost connection, then reload.
  // Match ONLY the exact loopback RPC URL and never continue non-loopback hosts.
  assertLocalSupabaseUrl(supabaseUrl);
  const recordCountUrl = new URL(
    '/rest/v1/rpc/record_count',
    supabaseUrl,
  ).toString();
  const sentBodies: string[] = [];
  let dropNext = true;
  await page.route(recordCountUrl, async (route) => {
    const requestUrl = route.request().url();
    try {
      assertLocalSupabaseUrl(requestUrl);
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    const body = route.request().postData() ?? '';
    sentBodies.push(body);
    if (dropNext) {
      dropNext = false;
      const upstream = await route.fetch({ maxRedirects: 0 });
      expect(upstream.ok()).toBe(true);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByText(pendingResendMessage)).toBeVisible(visible);
  expect(sentBodies).toHaveLength(1);

  await page.reload();
  await expect(page.getByText(pendingResendMessage)).toBeVisible(visible);
  // Reload must not post automatically.
  expect(sentBodies).toHaveLength(1);
  await expect(page.getByLabel(`الكمية المعدودة ${name}`)).toHaveValue('7');
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.getByText(waitingForSyncMessage)).toBeVisible(visible);
  expect(sentBodies).toHaveLength(2);
  expect(sentBodies[1]).toBe(sentBodies[0]);

  await page.unroute(recordCountUrl);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await coverCountTime(supabaseUrl);
    const response = page.waitForResponse(
      (candidate) => candidate.url() === recordCountUrl,
    );
    await page.getByRole('button', { name: 'سجّل الجرد' }).click();
    const body = (await (await response).json()) as { status?: string };
    if (body.status !== 'waiting_for_sync') break;
  }
  await expect(page.getByRole('status')).toHaveText('اتسجل الجرد', visible);
  const saved = page.getByRole('article', { name: stamp, exact: true });
  await expect(saved).toBeVisible(visible);
  await expect(saved.getByText('عجز 150.00 ج.م')).toBeVisible();

  assertLocalSupabaseUrl(supabaseUrl);
  const verifyClient = createClient<Database>(
    supabaseUrl,
    localServiceRoleKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  const { data: storedCounts, error: verifyError } = await verifyClient
    .schema('app')
    .from('stock_counts')
    .select('id, note')
    .eq('note', stamp);
  expect(verifyError).toBeNull();
  expect(storedCounts).toHaveLength(1);
});

test('mapping list renders and filters cleanly at 390px without horizontal overflow', async ({
  page,
}) => {
  const visible = { timeout: 20_000 };
  await page.goto('/login');
  await page.getByLabel('البريد').fill(ownerEmail);
  await page.getByLabel('كلمة السر').fill(ownerPassword);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('link', { name: 'ربط الكاشير' }).click();
  await expect(page).toHaveURL('/mapping');
  await expect(
    page.getByRole('heading', { name: 'ربط الكاشير', exact: true }),
  ).toBeVisible(visible);
  await expect(page.getByText(/المغطى /)).toBeVisible(visible);
  await expectNoHorizontalOverflow(page);

  const filter = page.getByLabel('غير المربوط بس');
  await expect(filter).toBeVisible();
  await filter.check();
  await expect(filter).toBeChecked();
  await expectNoHorizontalOverflow(page);
});
