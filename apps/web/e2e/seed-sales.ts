import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/database.types';
import { assertLocalSupabaseUrl } from './local-guard';

const shiftId = 'shift-e2e-sales-1';
const orderId = 'order-e2e-sales-1';

/**
 * Inserts one synthetic shift with a full refund and a matching drawer.
 * Service role, loopback only. Re-running replaces the same rows.
 */
export async function seedSales(
  client: SupabaseClient<Database>,
  apiUrl: string,
): Promise<void> {
  assertLocalSupabaseUrl(apiUrl);

  const opened = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const closed = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const updated = new Date().toISOString();
  const ordered = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();

  const started = await client.schema('app').rpc('start_pos_sync_run', {
    p_mode: 'recent',
  });
  if (started.error || typeof started.data !== 'number') {
    throw started.error ?? new Error('sales seed did not open a sync run');
  }
  const runId = started.data;

  try {
    const ingested = await client.schema('app').rpc('ingest_pos_batch', {
      p_run_id: runId,
      p_shifts: [
        {
          id: shiftId,
          opened_at: opened,
          closed_at: closed,
          is_active: false,
          pos_update_time: updated,
          drawer_cash_net: '160.00',
          drawer_credit: '50.00',
          transactions: [
            {
              tx_id: 'tx-e2e-refund-1',
              order_id: orderId,
              tx_type: 3,
              amount: '40.00',
              occurred_at: ordered,
            },
          ],
        },
      ],
      p_orders: [
        {
          id: orderId,
          order_number: 9001,
          shift_id: shiftId,
          status: 'complete',
          order_type: 'takeaway',
          payment_type: 'cash',
          ordered_at: ordered,
          subtotal: '250.00',
          discount: '0.00',
          tax: '0.00',
          service_tax: '0.00',
          delivery_fee: '0.00',
          total: '250.00',
          pos_update_time: updated,
          content_hash: 'ab'.repeat(32),
          lines: [
            {
              line_id: 'line-e2e-sales-1',
              item_id: 'item-e2e-fish',
              item_name: 'سمكة اختبار',
              size_name: 'وسط',
              quantity: '2',
              weighted_qty: null,
              unit_price: '125.00',
              options: [
                {
                  value: 'مشوي',
                  price: null,
                  pricingType: null,
                  pricingBaseQuantity: null,
                },
              ],
            },
          ],
        },
      ],
      p_scope: { shift_ids: [shiftId] },
    });
    if (ingested.error) throw ingested.error;

    const finished = await client.schema('app').rpc('finish_pos_sync_run', {
      p_run_id: runId,
      p_status: 'ok',
      p_counts: { orders: 1, transactions: 1 },
      p_error: '',
    });
    if (finished.error) throw finished.error;
  } catch (error) {
    await client.schema('app').rpc('finish_pos_sync_run', {
      p_run_id: runId,
      p_status: 'failed',
      p_counts: {},
      p_error: 'e2e sales seed failed',
    });
    throw error;
  }
}
