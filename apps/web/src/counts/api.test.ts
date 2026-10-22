import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listCounts, listDailyItems, recordCount } from '@/counts/api';
import {
  isPayloadRefusal,
  isUnknownOutcome,
  retrySafeMessage,
  syncCoverageMessage,
} from '@/counts/errors';
import type { CountDraft } from '@/counts/types';

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

const draft: CountDraft = {
  requestId: 'd1900000-0000-4000-8000-000000000001',
  countedAt: '2026-10-22T10:00:00.000Z',
  note: 'جرد الصباح',
  lines: [
    { itemId: 'tilapia', countedQty: '7.000000' },
    { itemId: 'shrimp', countedQty: '6' },
  ],
};

describe('counts api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
  });

  it('sends exact quantity strings, daily frequency, and the request id', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: draft.requestId, error: null });
    mocks.schema.mockReturnValue({ rpc });

    await recordCount(draft);

    expect(mocks.schema).toHaveBeenCalledWith('app');
    expect(rpc).toHaveBeenCalledWith('record_count', {
      p_count: {
        request_id: 'd1900000-0000-4000-8000-000000000001',
        frequency: 'daily',
        counted_at: '2026-10-22T10:00:00.000Z',
        note: 'جرد الصباح',
        lines: [
          { item_id: 'tilapia', counted_qty: '7.000000' },
          { item_id: 'shrimp', counted_qty: '6' },
        ],
      },
    });
  });

  it('maps a sync refusal as a payload refusal and keeps a lost reply retry-safe', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '22023',
        message: 'sync has not covered this count time',
      },
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(recordCount(draft)).rejects.toThrow(syncCoverageMessage);
    await expect(recordCount(draft)).rejects.toSatisfy((error: unknown) =>
      isPayloadRefusal(error),
    );

    rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(recordCount(draft)).rejects.toThrow(retrySafeMessage);
    await expect(recordCount(draft)).rejects.toSatisfy((error: unknown) =>
      isUnknownOutcome(error),
    );

    rpc.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    });
    await expect(recordCount(draft)).rejects.toThrow(retrySafeMessage);
    await expect(recordCount(draft)).rejects.toSatisfy((error: unknown) =>
      isUnknownOutcome(error),
    );
  });

  it('pages items by id, then keeps active daily items in Arabic name order', async () => {
    const built = query({
      data: [
        {
          id: 'shrimp',
          name: 'جمبري',
          active: true,
          count_frequency: 'daily',
          item_balances: {
            on_hand_qty_text: '4',
            on_hand_value_text: '100.00',
            avg_cost_text: '25',
          },
        },
        {
          id: 'spice',
          name: 'توابل',
          active: true,
          count_frequency: 'weekly',
          item_balances: null,
        },
        {
          id: 'stopped',
          name: 'موقوف',
          active: false,
          count_frequency: 'daily',
          item_balances: null,
        },
        {
          id: 'tilapia',
          name: 'بلطي',
          active: true,
          count_frequency: 'daily',
          item_balances: {
            on_hand_qty_text: '10',
            on_hand_value_text: '100.00',
            avg_cost_text: '10.05',
          },
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => built.chain });

    const items = await listDailyItems();

    expect(built.captured.orders).toEqual([{ column: 'id', ascending: true }]);
    expect(String(built.captured.select)).toContain('on_hand_qty::text');
    expect(items.map((row) => row.name)).toEqual(['بلطي', 'جمبري']);
    expect(items[0]).toMatchObject({
      id: 'tilapia',
      onHandQty: '10',
      onHandValue: '100.00',
      avgCost: '10.05',
    });
  });

  it('pages history by insert order and shows the newest count first', async () => {
    const built = query({
      data: [
        {
          id: 'older',
          counted_at: '2026-10-22T08:00:00.000Z',
          frequency: 'daily',
          created_at: '2026-10-22T08:01:00.000Z',
          note: null,
          item_count: 1,
          shortage_value_text: '10.00',
          surplus_value_text: '0.00',
          has_surplus: false,
        },
        {
          id: 'newer',
          counted_at: '2026-10-22T10:00:00.000Z',
          frequency: 'weekly',
          created_at: '2026-10-22T10:01:00.000Z',
          note: 'صباح',
          item_count: 3,
          shortage_value_text: '240.00',
          surplus_value_text: '50.00',
          has_surplus: true,
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => built.chain });

    const counts = await listCounts();

    expect(built.captured.orders).toEqual([
      { column: 'created_at', ascending: true },
      { column: 'id', ascending: true },
    ]);
    expect(String(built.captured.select)).toContain('shortage_value::text');
    expect(counts.map((row) => row.id)).toEqual(['newer', 'older']);
    expect(counts[0]).toMatchObject({
      frequency: 'weekly',
      shortageValue: '240.00',
      surplusValue: '50.00',
      hasSurplus: true,
      note: 'صباح',
    });
  });
});
