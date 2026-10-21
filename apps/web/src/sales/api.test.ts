import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSalesHome, loadShiftDetail, salesWindowMs } from '@/sales/api';

const mocks = vi.hoisted(() => ({
  schema: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    schema: mocks.schema,
  },
}));

type Captured = {
  select?: string;
  filters: { op: string; column: string; value: unknown }[];
  orders: { column: string; ascending?: boolean }[];
  limit?: number;
};

function query(result: { data: unknown; error: unknown }) {
  const captured: Captured = { filters: [], orders: [] };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = (columns: string) => {
    captured.select = columns;
    return chain;
  };
  chain.eq = (column: string, value: unknown) => {
    captured.filters.push({ op: 'eq', column, value });
    return chain;
  };
  chain.gte = (column: string, value: unknown) => {
    captured.filters.push({ op: 'gte', column, value });
    return chain;
  };
  chain.in = (column: string, value: unknown) => {
    captured.filters.push({ op: 'in', column, value });
    return chain;
  };
  chain.not = (column: string, op: string, value: unknown) => {
    captured.filters.push({ op: `not:${op}`, column, value });
    return chain;
  };
  chain.order = (column: string, options?: { ascending?: boolean }) => {
    captured.orders.push({ column, ascending: options?.ascending });
    return chain;
  };
  chain.limit = (value: number) => {
    captured.limit = value;
    return chain;
  };
  chain.maybeSingle = self;
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return { chain, captured };
}

function install(tables: Record<string, ReturnType<typeof query>>) {
  mocks.schema.mockReturnValue({
    from(name: string) {
      const found = tables[name];
      if (!found) throw new Error(`unexpected table ${name}`);
      return found.chain;
    },
  });
}

const summaryRow = {
  shift_id: 'shift-test-1',
  opened_at: '2026-10-15T09:00:00.000Z',
  closed_at: '2026-10-16T01:00:00.000Z',
  is_active: false,
  orders_complete: 1,
  gross_sales_text: '100.00',
  refunds_text: '25.00',
  net_sales_text: '75.00',
  orders_canceled: 1,
  orders_open: 1,
  orders_missing: 1,
  drawer_total_text: '75.00',
  drawer_difference_text: '0.00',
  unknown_tx: 1,
};

describe('sales api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
  });

  it('maps exact money text for the last 35 days and the latest ok sync', async () => {
    const summaries = query({ data: [summaryRow], error: null });
    const runs = query({
      data: { finished_at: '2026-10-21T11:00:00.000Z' },
      error: null,
    });
    install({ pos_shift_summaries: summaries, pos_sync_runs: runs });

    const now = Date.parse('2026-10-21T12:00:00.000Z');
    const home = await loadSalesHome(now);

    expect(mocks.schema).toHaveBeenCalledWith('app');
    expect(summaries.captured.select).toContain('net_sales::text');
    expect(summaries.captured.select).toContain('drawer_difference::text');
    expect(summaries.captured.filters).toContainEqual({
      op: 'gte',
      column: 'opened_at',
      value: new Date(now - salesWindowMs).toISOString(),
    });
    expect(summaries.captured.orders).toContainEqual({
      column: 'opened_at',
      ascending: false,
    });
    expect(runs.captured.filters).toContainEqual({
      op: 'eq',
      column: 'status',
      value: 'ok',
    });
    expect(home.lastSyncAt).toBe('2026-10-21T11:00:00.000Z');
    expect(home.shifts[0]).toMatchObject({
      shiftId: 'shift-test-1',
      netSales: '75.00',
      refunds: '25.00',
      drawerDifference: '0.00',
      unknownTx: 1,
    });
  });

  it('rejects a JSON number where money text is required', async () => {
    install({
      pos_shift_summaries: query({
        data: [{ ...summaryRow, net_sales_text: 75 }],
        error: null,
      }),
      pos_sync_runs: query({ data: null, error: null }),
    });

    await expect(loadSalesHome()).rejects.toThrow('حصل خطأ. حاول تاني.');
  });

  it('sums type-3 refunds in piasters and keeps option values only', async () => {
    const summaries = query({
      data: {
        ...summaryRow,
        drawer_total_text: null,
        drawer_difference_text: null,
      },
      error: null,
    });
    const orders = query({
      data: [
        {
          id: 'order-test-complete',
          order_number: 4242,
          ordered_at: '2026-10-15T12:00:00.000Z',
          order_type: 'takeaway',
          payment_type: 'cash',
          status: 'complete',
          missing_from_pos: false,
          total_text: '100.00',
        },
      ],
      error: null,
    });
    const lines = query({
      data: [
        {
          order_id: 'order-test-complete',
          line_id: 'line-b',
          item_name: 'سمكة اختبار',
          size_name: 'وسط',
          quantity_text: '1.000000',
          weighted_qty_text: null,
          weighted_unit: null,
          line_total_text: '40.00',
          options: [
            { value: 'مشوي', price: '5.00', description: 'pii-line-option' },
          ],
        },
        {
          order_id: 'order-test-complete',
          line_id: 'line-a',
          item_name: 'أرز',
          size_name: null,
          quantity_text: '2.000000',
          weighted_qty_text: null,
          weighted_unit: null,
          line_total_text: '60.00',
          options: [],
        },
      ],
      error: null,
    });
    const txs = query({
      data: [
        { order_id: 'order-test-complete', amount_text: '10.10' },
        { order_id: 'order-test-complete', amount_text: '0.20' },
        { order_id: null, amount_text: '9.00' },
      ],
      error: null,
    });
    install({
      pos_shift_summaries: summaries,
      pos_orders: orders,
      pos_order_lines: lines,
      pos_shift_transactions: txs,
    });

    const detail = await loadShiftDetail('shift-test-1');

    expect(txs.captured.filters).toContainEqual({
      op: 'eq',
      column: 'tx_type',
      value: 3,
    });
    expect(detail?.summary.drawerDifference).toBeNull();
    expect(detail?.orders[0]?.refunded).toBe('10.30');
    expect(detail?.orders[0]?.lines.map((line) => line.lineId)).toEqual([
      'line-a',
      'line-b',
    ]);
    expect(detail?.orders[0]?.lines[1]?.optionValues).toEqual(['مشوي']);
    expect(JSON.stringify(detail)).not.toContain('pii-line-option');
  });

  it('returns null when the shift summary is absent', async () => {
    install({
      pos_shift_summaries: query({ data: null, error: null }),
      pos_orders: query({ data: [], error: null }),
      pos_shift_transactions: query({ data: [], error: null }),
    });

    await expect(loadShiftDetail('shift-missing')).resolves.toBeNull();
  });
});
