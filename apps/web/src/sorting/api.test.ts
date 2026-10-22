import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listMixedFish, listSorts, recordSort } from '@/sorting/api';
import { notEnoughStockMessage, retrySafeMessage } from '@/sorting/errors';
import type { SortDraft } from '@/sorting/types';

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

const draft: SortDraft = {
  requestId: 'd1800000-0000-4000-8000-000000000001',
  mixedItemId: 'mixed',
  occurredAt: '2026-07-15T09:00:00.000Z',
  qtyTaken: '100',
  note: null,
  lines: [
    { itemId: 'large', quantity: '60' },
    { itemId: 'small', quantity: '38' },
  ],
};

describe('sorting api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
  });

  it('sends exact quantity strings and the request id', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: draft.requestId, error: null });
    mocks.schema.mockReturnValue({ rpc });

    await recordSort(draft);

    expect(mocks.schema).toHaveBeenCalledWith('app');
    expect(rpc).toHaveBeenCalledWith('record_sort', {
      p_sort: {
        request_id: 'd1800000-0000-4000-8000-000000000001',
        mixed_item_id: 'mixed',
        occurred_at: '2026-07-15T09:00:00.000Z',
        qty_taken: '100',
        note: null,
        lines: [
          { item_id: 'large', quantity: '60' },
          { item_id: 'small', quantity: '38' },
        ],
      },
    });
  });

  it('keeps the same request retry-safe when the save fails', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(recordSort(draft)).rejects.toThrow(retrySafeMessage);

    rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'not enough stock to sort' },
    });
    await expect(recordSort(draft)).rejects.toThrow(notEnoughStockMessage);
  });

  it('pages the catalog by id and keeps only active kilogram fish', async () => {
    const items = query({
      data: [
        {
          id: 'size-b',
          name: 'وسط',
          kind: 'fish_size',
          base_unit: 'kg',
          parent_item_id: 'mixed',
          active: true,
          item_balances: null,
        },
        {
          id: 'inactive',
          name: 'قديم',
          kind: 'fish_mixed',
          base_unit: 'kg',
          parent_item_id: null,
          active: false,
          item_balances: null,
        },
        {
          id: 'mixed',
          name: 'بوري',
          kind: 'fish_mixed',
          base_unit: 'kg',
          parent_item_id: null,
          active: true,
          item_balances: {
            on_hand_qty_text: '100.000000',
            on_hand_value_text: '5123.46',
            avg_cost_text: '51.234567',
            has_uncovered_deficit: false,
          },
        },
        {
          id: 'oil',
          name: 'زيت',
          kind: 'ingredient',
          base_unit: 'kg',
          parent_item_id: null,
          active: true,
          item_balances: null,
        },
        {
          id: 'size-a',
          name: 'كبير',
          kind: 'fish_size',
          base_unit: 'kg',
          parent_item_id: 'mixed',
          active: true,
          item_balances: null,
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({
      from: () => items.chain,
    });

    const rows = await listMixedFish();
    expect(rows).toEqual([
      {
        id: 'mixed',
        name: 'بوري',
        onHandQty: '100.000000',
        onHandValue: '5123.46',
        avgCost: '51.234567',
        hasUncoveredDeficit: false,
        sizes: [
          { id: 'size-a', name: 'كبير' },
          { id: 'size-b', name: 'وسط' },
        ],
      },
    ]);
    expect(items.captured.orders).toEqual([{ column: 'id', ascending: true }]);
    expect(items.captured.filters).toEqual([]);
    expect(items.captured.ranges).toEqual([{ from: 0, to: 999 }]);
    expect(String(items.captured.select)).toContain('on_hand_qty::text');
    expect(String(items.captured.select)).toContain('on_hand_value::text');
    expect(String(items.captured.select)).toContain('avg_cost::text');
  });

  it('pages history by insert time and returns exact movement figures', async () => {
    const history = query({
      data: [
        {
          id: 'early',
          mixed_item_id: 'mixed',
          mixed_item_name: 'بوري',
          occurred_at: '2026-07-14T09:00:00.000Z',
          created_at: '2026-07-14T09:01:00.000Z',
          note: null,
          qty_taken_text: '10.000000',
          sizes_qty_text: '9.500000',
          loss_qty_text: '0.500000',
          loss_value_text: '25.00',
          cost_per_kg_text: '50.000000',
        },
        {
          id: 'later',
          mixed_item_id: 'mixed',
          mixed_item_name: 'بوري',
          occurred_at: '2026-07-15T09:00:00.000Z',
          created_at: '2026-07-15T09:01:00.000Z',
          note: 'فاقد',
          qty_taken_text: '100.000000',
          sizes_qty_text: '98.000000',
          loss_qty_text: '2.000000',
          loss_value_text: '100.00',
          cost_per_kg_text: '50.000000',
        },
      ],
      error: null,
    });
    const lines = query({
      data: [
        {
          batch_id: 'later',
          line_no: 2,
          size_item_id: 'small',
          quantity_text: '38.000000',
          stock_items: { name: 'وسط' },
        },
        {
          batch_id: 'later',
          line_no: 1,
          size_item_id: 'large',
          quantity_text: '60.000000',
          stock_items: [{ name: 'كبير' }],
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({
      from: (table: string) =>
        table === 'sort_batch_lines' ? lines.chain : history.chain,
    });

    const rows = await listSorts({
      from: '2026-07-14T21:00:00.000Z',
      toExclusive: '2026-07-15T21:00:00.000Z',
    });
    expect(rows.map((row) => row.id)).toEqual(['later', 'early']);
    expect(rows[0]).toMatchObject({
      qtyTaken: '100.000000',
      sizesQty: '98.000000',
      lossQty: '2.000000',
      lossValue: '100.00',
      costPerKg: '50.000000',
      note: 'فاقد',
    });
    expect(rows[0]?.lines.map((line) => line.lineNo)).toEqual([1, 2]);
    expect(rows[0]?.lines[0]).toMatchObject({
      itemName: 'كبير',
      quantity: '60.000000',
    });
    expect(history.captured.orders).toEqual([
      { column: 'created_at', ascending: true },
      { column: 'id', ascending: true },
    ]);
    expect(history.captured.filters).toEqual([
      { op: 'gte', column: 'occurred_at', value: '2026-07-14T21:00:00.000Z' },
      { op: 'lt', column: 'occurred_at', value: '2026-07-15T21:00:00.000Z' },
    ]);
    expect(lines.captured.orders).toEqual([
      { column: 'batch_id', ascending: true },
      { column: 'line_no', ascending: true },
    ]);
    expect(String(history.captured.select)).toContain('qty_taken::text');
    expect(String(lines.captured.select)).toContain('quantity::text');
  });
});
