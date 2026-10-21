import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listPurchases,
  listStockChoices,
  recordOpeningStock,
  recordPurchase,
} from '@/purchases/api';
import { backDatedMessage } from '@/purchases/errors';
import type { OpeningDraft, PurchaseDraft } from '@/purchases/types';

const mocks = vi.hoisted(() => ({
  schema: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { schema: mocks.schema },
}));

function query(result: { data: unknown; error: unknown }) {
  const captured: {
    select?: unknown;
    filters: { op: string; column: string; value: unknown }[];
    orders: { column: string; ascending: boolean | undefined }[];
    ranges: { from: number; to: number }[];
    limit?: number;
  } = { filters: [], orders: [], ranges: [] };
  const chain: Record<string, unknown> = {};
  chain.select = (columns?: unknown) => {
    captured.select = columns;
    return chain;
  };
  chain.order = (column: string, options?: { ascending?: boolean }) => {
    captured.orders.push({ column, ascending: options?.ascending });
    return chain;
  };
  for (const op of ['eq', 'gte', 'lt', 'in'] as const) {
    chain[op] = (column: string, value: unknown) => {
      captured.filters.push({ op, column, value });
      return chain;
    };
  }
  chain.limit = (value: number) => {
    captured.limit = value;
    return chain;
  };
  chain.range = (from: number, to: number) => {
    captured.ranges.push({ from, to });
    return chain;
  };
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return { chain, captured };
}

const purchaseDraft: PurchaseDraft = {
  purchasedAt: '2026-07-15T09:00:00.000Z',
  supplier: 'مورد',
  invoiceNo: null,
  note: null,
  lines: [
    {
      itemId: 'oil',
      itemName: 'زيت',
      quantity: '2',
      unit: 'لتر',
      amountPaid: '50.00',
      baseUnit: 'kg',
      baseQuantity: '1.84',
      unitCost: '27.173913',
    },
  ],
};

const openingDraft: OpeningDraft = {
  occurredAt: '2026-01-15T10:00:00.000Z',
  lines: [
    { itemId: 'oil', quantity: '4', unit: 'kg', unitCost: '12.5' },
    { itemId: 'mixed', quantity: '10', unit: 'kg', unitCost: '100' },
  ],
};

describe('purchases api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
  });

  it('reads active items and exact conversion text in one request', async () => {
    const items = query({
      data: [
        {
          id: 'oil',
          name: 'زيت',
          kind: 'ingredient',
          base_unit: 'kg',
          parent_item_id: null,
          active: true,
          item_balances: null,
          item_unit_conversions: [{ unit: 'لتر', factor_text: '0.920000' }],
        },
        {
          id: 'mixed',
          name: 'بوري',
          kind: 'fish_mixed',
          base_unit: 'kg',
          parent_item_id: null,
          active: true,
          item_balances: [{ item_id: 'mixed' }],
          item_unit_conversions: [],
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({
      from: () => items.chain,
    });

    // Paged by id, then sorted by Arabic name: بوري before زيت.
    await expect(listStockChoices()).resolves.toEqual([
      {
        id: 'mixed',
        name: 'بوري',
        kind: 'fish_mixed',
        baseUnit: 'kg',
        parentItemId: null,
        active: true,
        hasMovements: true,
        conversions: [],
      },
      {
        id: 'oil',
        name: 'زيت',
        kind: 'ingredient',
        baseUnit: 'kg',
        parentItemId: null,
        active: true,
        hasMovements: false,
        conversions: [{ unit: 'لتر', factorToBase: '0.920000' }],
      },
    ]);
    expect(items.captured.select).toBe(
      'id, name, kind, base_unit, parent_item_id, active, item_balances(item_id), item_unit_conversions(unit, factor_text:factor_to_base::text)',
    );
    expect(items.captured.filters).toEqual([
      { op: 'eq', column: 'active', value: true },
    ]);
    expect(items.captured.orders).toEqual([{ column: 'id', ascending: true }]);
    expect(items.captured.ranges).toEqual([{ from: 0, to: 999 }]);
  });

  it('lists purchases newest first with exact money text', async () => {
    const purchases = query({
      data: [
        {
          id: 'p1',
          purchased_at: '2026-07-15T09:00:00.000Z',
          supplier: 'مورد',
          invoice_no: null,
          note: null,
          total_paid_text: '50.00',
          created_at: '2026-07-15T09:01:00.000Z',
        },
      ],
      error: null,
    });
    const lines = query({
      data: [
        {
          purchase_id: 'p1',
          line_no: 2,
          item_id: 'mixed',
          quantity_text: '1.000000',
          unit: 'kg',
          base_quantity_text: '1.000000',
          amount_paid_text: '10.00',
          stock_items: [{ name: 'بوري', base_unit: 'kg' }],
        },
        {
          purchase_id: 'p1',
          line_no: 1,
          item_id: 'oil',
          quantity_text: '2.000000',
          unit: 'لتر',
          base_quantity_text: '1.840000',
          amount_paid_text: '40.00',
          stock_items: { name: 'زيت', base_unit: 'kg' },
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({
      from: (table: string) =>
        table === 'purchase_lines' ? lines.chain : purchases.chain,
    });

    const rows = await listPurchases({
      from: '2026-07-14T21:00:00.000Z',
      toExclusive: '2026-07-15T21:00:00.000Z',
    });
    expect(rows[0]?.totalPaid).toBe('50.00');
    expect(rows[0]?.lines.map((line) => line.lineNo)).toEqual([1, 2]);
    expect(rows[0]?.lines[0]).toMatchObject({
      quantity: '2.000000',
      unit: 'لتر',
      baseQuantity: '1.840000',
      amountPaid: '40.00',
    });
    expect(purchases.captured.orders).toEqual([
      { column: 'created_at', ascending: true },
      { column: 'id', ascending: true },
    ]);
    expect(purchases.captured.filters).toEqual([
      { op: 'gte', column: 'purchased_at', value: '2026-07-14T21:00:00.000Z' },
      { op: 'lt', column: 'purchased_at', value: '2026-07-15T21:00:00.000Z' },
    ]);
    expect(purchases.captured.ranges).toEqual([{ from: 0, to: 999 }]);
    expect(lines.captured.orders).toEqual([
      { column: 'purchase_id', ascending: true },
      { column: 'line_no', ascending: true },
    ]);
    expect(lines.captured.filters).toEqual([
      { op: 'in', column: 'purchase_id', value: ['p1'] },
    ]);
    expect(lines.captured.ranges).toEqual([{ from: 0, to: 999 }]);
    expect(String(purchases.captured.select)).toContain('total_paid::text');
    expect(String(lines.captured.select)).toContain('quantity::text');
  });

  it('shows the newest purchase first whatever order the pages came in', async () => {
    const row = (id: string, purchasedAt: string, createdAt: string) => ({
      id,
      purchased_at: purchasedAt,
      supplier: null,
      invoice_no: null,
      note: null,
      total_paid_text: '1.00',
      created_at: createdAt,
    });
    // Pages arrive in insert order; a late-entered purchase happened earlier.
    const purchases = query({
      data: [
        row(
          'p-early-entry',
          '2026-07-15T09:00:00.000Z',
          '2026-07-15T09:01:00.000Z',
        ),
        row(
          'p-late-entry',
          '2026-07-14T08:00:00.000Z',
          '2026-07-16T10:00:00.000Z',
        ),
        row('p-newest', '2026-07-16T12:00:00.000Z', '2026-07-16T12:01:00.000Z'),
      ],
      error: null,
    });
    const lines = query({ data: [], error: null });
    mocks.schema.mockReturnValue({
      from: (table: string) =>
        table === 'purchase_lines' ? lines.chain : purchases.chain,
    });

    const listed = await listPurchases();
    expect(listed.map((purchase) => purchase.id)).toEqual([
      'p-newest',
      'p-early-entry',
      'p-late-entry',
    ]);
  });

  it('sends purchase and opening numbers as exact strings', async () => {
    const calls: { name: string; args: unknown }[] = [];
    mocks.schema.mockReturnValue({
      rpc: (name: string, args: unknown) => {
        calls.push({ name, args });
        return Promise.resolve({ data: 'batch', error: null });
      },
    });

    await recordPurchase(purchaseDraft);
    await recordOpeningStock(openingDraft);

    expect(calls[0]).toEqual({
      name: 'record_purchase',
      args: {
        p_purchase: {
          purchased_at: '2026-07-15T09:00:00.000Z',
          supplier: 'مورد',
          invoice_no: null,
          note: null,
          lines: [
            {
              item_id: 'oil',
              quantity: '2',
              unit: 'لتر',
              amount_paid: '50.00',
            },
          ],
        },
      },
    });
    expect(JSON.stringify(calls[0]?.args)).toContain('"quantity":"2"');
    expect(JSON.stringify(calls[0]?.args)).toContain('"amount_paid":"50.00"');
    expect(JSON.stringify(calls[0]?.args)).not.toContain('unit_cost');
    expect(calls[1]).toEqual({
      name: 'record_opening_stock',
      args: {
        p_occurred_at: '2026-01-15T10:00:00.000Z',
        p_lines: [
          { item_id: 'oil', quantity: '4', unit: 'kg', unit_cost: '12.5' },
          { item_id: 'mixed', quantity: '10', unit: 'kg', unit_cost: '100' },
        ],
      },
    });
    expect(JSON.stringify(calls[1]?.args)).toContain('"unit_cost":"12.5"');
  });

  it('maps a back-dated ledger error to the Arabic item message', async () => {
    mocks.schema.mockReturnValue({
      rpc: () =>
        Promise.resolve({
          data: null,
          error: {
            code: 'P0001',
            message: 'back-dated movement not supported yet',
            details: 'زيت',
          },
        }),
    });

    await expect(recordPurchase(purchaseDraft)).rejects.toThrow(
      backDatedMessage('زيت'),
    );
  });
});
