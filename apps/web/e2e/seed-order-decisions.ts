import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../src/lib/database.types';
import { assertLocalSupabaseUrl } from './local-guard';

export type SeededOrder = { id: string; number: number };

export type SeededOrders = {
  canceled: SeededOrder;
  partial: SeededOrder;
  stale: SeededOrder;
};

const seededFile = join(import.meta.dirname, '.seeded-orders.json');
const container =
  process.env.E2E_SUPABASE_DB_CONTAINER ?? 'supabase_db_thesharkapp';

const hour = 60 * 60 * 1000;
const minute = 60 * 1000;

/** Runs the fixture in the local database container. Loopback API only. */
function runLocalSql(apiUrl: string): void {
  assertLocalSupabaseUrl(apiUrl);
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGCLIENTENCODING=UTF8',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-1',
      '-q',
      '-f',
      '-',
    ],
    {
      input: readFileSync(
        join(import.meta.dirname, 'seed-order-decisions.sql'),
      ),
      stdio: ['pipe', 'ignore', 'inherit'],
    },
  );
}

type Head = { order_id: string; work_generation: number } | null;
type Work = { status?: string; failed?: number; head?: Head };

async function drain(client: SupabaseClient<Database>): Promise<void> {
  const app = client.schema('app');
  const first = await app.rpc('accounting_next_work');
  if (first.error) throw first.error;
  let head = (first.data as Work).head ?? null;
  for (let step = 0; step < 200; step += 1) {
    if (!head) return;
    const done = await app.rpc('run_accounting_work', {
      p_attempt_id: randomUUID(),
      p_limit: 1,
      p_order_id: head.order_id,
      p_work_generation: head.work_generation,
    });
    if (done.error) throw done.error;
    const body = done.data as Work;
    if ((body.failed ?? 0) > 0) throw new Error('the accounting worker failed');
    if (body.status !== 'processed') return;
    head = body.head ?? null;
  }
  throw new Error('the accounting worker did not drain');
}

type Line = { item: 'a' | 'b'; quantity: string };

function lineJson(orderId: string, index: number, line: Line) {
  return {
    line_id: `${orderId}-l${index}`,
    item_id: `e2e-od-pos-${line.item}`,
    item_name: line.item === 'a' ? 'سمك أ' : 'سمك ب',
    size_name: null,
    quantity: line.quantity,
    weighted_qty: null,
    unit_price: '50.00',
    options: [],
  };
}

/**
 * Switches deductions on locally, then ingests three synthetic orders the way
 * a sync would and lets the worker post them. Activation is test-only: it goes
 * through the local database container because no API role can write it.
 * Each run adds new orders, so a previous run's decisions never interfere.
 * Their ids sort newest first, so they stay on the first page of the queue.
 * Item a costs 50 per kilo and item b costs 20.
 */
export async function seedOrderDecisions(
  client: SupabaseClient<Database>,
  apiUrl: string,
): Promise<SeededOrders> {
  assertLocalSupabaseUrl(apiUrl);
  runLocalSql(apiUrl);

  const key = (1e13 - Date.now()).toString().padStart(14, '0');
  const first = 100000 + (Math.floor(Date.now() / 1000) % 800000);
  const seeded: SeededOrders = {
    canceled: { id: `order-e2e-od-${key}-c`, number: first },
    partial: { id: `order-e2e-od-${key}-p`, number: first + 1 },
    stale: { id: `order-e2e-od-${key}-s`, number: first + 2 },
  };
  const shiftId = `shift-e2e-od-${key}`;
  const ordered = Date.now() - 22 * hour;
  const iso = (offset: number) => new Date(ordered + offset).toISOString();

  const orderJson = (
    order: SeededOrder,
    version: number,
    status: 'complete' | 'canceled',
    lines: Line[],
    total: string,
    updatedAt: number,
  ) => ({
    id: order.id,
    order_number: order.number,
    shift_id: shiftId,
    status,
    order_type: 'e2e-od-hall',
    payment_type: 'cash',
    ordered_at: iso(0),
    subtotal: total,
    discount: '0.00',
    tax: '0.00',
    service_tax: '0.00',
    delivery_fee: '0.00',
    total,
    pos_update_time: iso(updatedAt),
    content_hash: createHash('sha256')
      .update(`${order.id}|${version}`)
      .digest('hex'),
    lines: lines.map((line, index) => lineJson(order.id, index, line)),
  });

  const shift = {
    id: shiftId,
    opened_at: iso(-hour),
    closed_at: iso(hour),
    is_active: false,
    pos_update_time: iso(30 * minute),
    drawer_cash_net: null,
    drawer_credit: null,
    transactions: [
      {
        tx_id: `${shiftId}-refund`,
        order_id: seeded.partial.id,
        tx_type: 3,
        amount: '30.00',
        occurred_at: iso(10 * minute),
      },
    ],
  };

  const partial = orderJson(
    seeded.partial,
    1,
    'complete',
    [
      { item: 'a', quantity: '2' },
      { item: 'b', quantity: '4' },
    ],
    '100.00',
    minute,
  );
  const twoKilos: Line[] = [{ item: 'a', quantity: '2' }];
  const oneKilo: Line[] = [{ item: 'a', quantity: '1' }];

  await ingest(client, shiftId, shift, [
    orderJson(seeded.canceled, 1, 'complete', twoKilos, '100.00', minute),
    partial,
    orderJson(seeded.stale, 1, 'complete', oneKilo, '50.00', minute),
  ]);
  await drain(client);
  // The POS erases the lines of a canceled order, so the cancel has none.
  await ingest(client, shiftId, shift, [
    orderJson(seeded.canceled, 2, 'canceled', [], '100.00', 20 * minute),
    partial,
    orderJson(seeded.stale, 2, 'canceled', [], '50.00', 20 * minute),
  ]);
  await drain(client);

  const queue = await client
    .schema('app')
    .from('order_decision_queue')
    .select('order_id, current_class, needs_decision, basis_status')
    .in('order_id', [seeded.canceled.id, seeded.partial.id, seeded.stale.id]);
  if (queue.error) throw queue.error;
  const expected: Record<string, string> = {
    [seeded.canceled.id]: 'canceled',
    [seeded.partial.id]: 'partial_refund',
    [seeded.stale.id]: 'canceled',
  };
  for (const [id, decisionClass] of Object.entries(expected)) {
    const row = (queue.data ?? []).find((entry) => entry.order_id === id);
    if (
      !row ||
      row.current_class !== decisionClass ||
      row.needs_decision !== true ||
      row.basis_status !== 'ready'
    ) {
      throw new Error(`the order decision fixture is not ready: ${id}`);
    }
  }

  // Another project's worker does not inherit this process's env, and the
  // activation row cannot be removed, so the dormant project runs first.
  writeFileSync(seededFile, `${JSON.stringify(seeded)}\n`);
  return seeded;
}

/**
 * One mapped complete order, left pending. The activate project has already
 * drained the queue, so processing can expect this order alone.
 */
export async function seedPendingAccountingOrder(
  client: SupabaseClient<Database>,
  apiUrl: string,
): Promise<string> {
  assertLocalSupabaseUrl(apiUrl);
  const key = (1e13 - Date.now()).toString().padStart(14, '0');
  const orderId = `order-e2e-run-${key}`;
  const shiftId = `shift-e2e-run-${key}`;
  const ordered = Date.now() - 2 * hour;
  const iso = (offset: number) => new Date(ordered + offset).toISOString();
  await ingest(
    client,
    shiftId,
    {
      id: shiftId,
      opened_at: iso(-hour),
      closed_at: iso(hour),
      is_active: false,
      pos_update_time: iso(minute),
      drawer_cash_net: null,
      drawer_credit: null,
      transactions: [],
    },
    [
      {
        id: orderId,
        order_number: 700000 + (Math.floor(Date.now() / 1000) % 100000),
        shift_id: shiftId,
        status: 'complete',
        order_type: 'e2e-od-hall',
        payment_type: 'cash',
        ordered_at: iso(0),
        subtotal: '50.00',
        discount: '0.00',
        tax: '0.00',
        service_tax: '0.00',
        delivery_fee: '0.00',
        total: '50.00',
        pos_update_time: iso(minute),
        content_hash: createHash('sha256').update(orderId).digest('hex'),
        lines: [lineJson(orderId, 0, { item: 'a', quantity: '1' })],
      },
    ],
    0,
  );
  return orderId;
}

async function ingest(
  client: SupabaseClient<Database>,
  shiftId: string,
  shift: Json,
  orders: Json[],
  transactionCount = 1,
): Promise<void> {
  const app = client.schema('app');
  const started = await app.rpc('start_pos_sync_run', { p_mode: 'recent' });
  if (started.error || typeof started.data !== 'number') {
    throw (
      started.error ?? new Error('order decision seed did not open a sync run')
    );
  }
  const runId = started.data;
  try {
    const ingested = await app.rpc('ingest_pos_batch', {
      p_run_id: runId,
      p_shifts: [shift],
      p_orders: orders,
      p_scope: { shift_ids: [shiftId] },
    });
    if (ingested.error) throw ingested.error;
    const finished = await app.rpc('finish_pos_sync_run', {
      p_run_id: runId,
      p_status: 'ok',
      p_counts: { orders: orders.length, transactions: transactionCount },
      p_error: '',
    });
    if (finished.error) throw finished.error;
  } catch (error) {
    await app.rpc('finish_pos_sync_run', {
      p_run_id: runId,
      p_status: 'failed',
      p_counts: {},
      p_error: 'e2e order decision seed failed',
    });
    throw error;
  }
}

/** The orders the activate project recorded for this run. */
export function seededOrderDecisions(): SeededOrders {
  if (!existsSync(seededFile)) {
    throw new Error(
      'the activate project did not record the order decision fixture',
    );
  }
  return JSON.parse(readFileSync(seededFile, 'utf8')) as SeededOrders;
}
