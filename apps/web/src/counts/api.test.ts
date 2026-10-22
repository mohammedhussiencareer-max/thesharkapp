import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listCounts,
  listDailyItems,
  listPendingCounts,
  recordCount,
  recordStoredCount,
} from '@/counts/api';
import {
  genericCountError,
  insideShiftMessage,
  isPayloadRefusal,
  isUnknownOutcome,
  retrySafeMessage,
} from '@/counts/errors';
import type { CountDraft } from '@/counts/types';
import type { Json } from '@/lib/database.types';

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
    const rpc = vi.fn().mockResolvedValue({
      data: { status: 'posted', count_id: 'saved-count' },
      error: null,
    });
    mocks.schema.mockReturnValue({ rpc });

    await expect(recordCount(draft)).resolves.toEqual({
      status: 'posted',
      countId: 'saved-count',
    });

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

    rpc.mockResolvedValueOnce({
      data: JSON.stringify({ status: 'posted', count_id: 'saved-count' }),
      error: null,
    });
    await expect(recordCount(draft)).resolves.toEqual({
      status: 'posted',
      countId: 'saved-count',
    });
  });

  it('returns waiting_for_sync as a successful result', async () => {
    const stored = {
      request_id: draft.requestId,
      frequency: 'daily',
      counted_at: draft.countedAt,
      note: draft.note,
      lines: [{ item_id: 'tilapia', counted_qty: '7' }],
    };
    const rpc = vi.fn().mockResolvedValue({
      data: { status: 'waiting_for_sync' },
      error: null,
    });
    mocks.schema.mockReturnValue({ rpc });

    await expect(recordCount(draft)).resolves.toEqual({
      status: 'waiting_for_sync',
    });

    rpc.mockResolvedValueOnce({
      data: [{ status: 'waiting_for_sync' }],
      error: null,
    });
    await expect(recordStoredCount(stored)).resolves.toEqual({
      status: 'waiting_for_sync',
    });
    expect(rpc).toHaveBeenLastCalledWith('record_count', { p_count: stored });
  });

  it('keeps an unreadable success retry-safe', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: draft.requestId, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await expect(recordCount(draft)).rejects.toThrow(retrySafeMessage);
    await expect(recordCount(draft)).rejects.toSatisfy((error: unknown) =>
      isUnknownOutcome(error),
    );
  });

  it('maps an inside-shift refusal as a payload refusal and keeps a lost reply retry-safe', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '22023',
        message: 'count time is inside a shift',
      },
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(recordCount(draft)).rejects.toThrow(insideShiftMessage);
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

  it('reads pending counts in prepare order and keeps the stored payload', async () => {
    const payload = {
      request_id: 'd1900000-0000-4000-8000-000000000060',
      frequency: 'daily',
      counted_at: '2026-10-22T10:00:00.000Z',
      note: null,
      lines: [{ item_id: 'tilapia', counted_qty: '7' }],
    };
    const built = query({
      data: [
        {
          request_id: 'd1900000-0000-4000-8000-000000000060',
          prepared_at: '2026-10-22T10:05:00.000Z',
          counted_at: '2026-10-22T10:00:00.000Z',
          item_count: 1,
          payload,
        },
      ],
      error: null,
    });
    const tables: string[] = [];
    mocks.schema.mockReturnValue({
      from: (table: string) => {
        tables.push(table);
        return built.chain;
      },
    });

    const pending = await listPendingCounts();

    expect(tables).toEqual(['stock_count_pending']);
    expect(built.captured.orders).toEqual([
      { column: 'prepared_at', ascending: true },
      { column: 'request_id', ascending: true },
    ]);
    expect(built.captured.ranges).toEqual([{ from: 0, to: 999 }]);
    expect(String(built.captured.select)).toContain('payload');
    expect(pending).toEqual([
      {
        requestId: 'd1900000-0000-4000-8000-000000000060',
        preparedAt: '2026-10-22T10:05:00.000Z',
        countedAt: '2026-10-22T10:00:00.000Z',
        itemCount: 1,
        payload,
      },
    ]);

    const broken = query({
      data: [
        {
          request_id: 'd1900000-0000-4000-8000-000000000060',
          prepared_at: '2026-10-22T10:05:00.000Z',
          counted_at: '2026-10-22T10:00:00.000Z',
          item_count: 1,
          payload: null,
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => broken.chain });
    await expect(listPendingCounts()).rejects.toThrow(genericCountError);
  });

  it('keeps a 14-digit quantity string exact through JSON parse and resend', async () => {
    const wire =
      '{"request_id":"d1900000-0000-4000-8000-000000000080","frequency":"daily","counted_at":"2026-10-22T12:00:00.000Z","note":null,"lines":[{"item_id":"c1900000-0000-4000-8000-000000000009","counted_qty":"12345678901234.123456"}]}';
    const payload = JSON.parse(wire) as Json;
    const built = query({
      data: [
        {
          request_id: 'd1900000-0000-4000-8000-000000000080',
          prepared_at: '2026-10-22T12:05:00.000Z',
          counted_at: '2026-10-22T12:00:00.000Z',
          item_count: 1,
          payload,
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => built.chain });

    const pending = await listPendingCounts();
    const stored = pending[0]?.payload;
    const line = (stored as { lines?: { counted_qty?: unknown }[] } | undefined)
      ?.lines?.[0];
    expect(line?.counted_qty).toBe('12345678901234.123456');
    expect(typeof line?.counted_qty).toBe('string');

    const rpc = vi.fn().mockResolvedValue({
      data: { status: 'waiting_for_sync' },
      error: null,
    });
    mocks.schema.mockReturnValue({ rpc });
    await recordStoredCount(stored ?? null);
    expect(rpc).toHaveBeenCalledWith('record_count', { p_count: payload });
    expect(JSON.stringify(rpc.mock.calls[0]?.[1])).toContain(
      '"counted_qty":"12345678901234.123456"',
    );
  });
});
