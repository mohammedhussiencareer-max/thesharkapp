import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmedRefusalError, genericCatalogError } from '@/items/errors';
import {
  loadQueuePage,
  loadQueueRow,
  loadUnlinkedRefunds,
  queuePageSize,
  resultOf,
  rowOf,
  setOrderDisposition,
} from '@/order-decisions/api';
import {
  OrderChangedError,
  orderChangedServerMessage,
} from '@/order-decisions/errors';
import { rawRow } from '@/order-decisions/test-fixtures';
import type { DecisionWrite } from '@/order-decisions/types';

const mocks = vi.hoisted(() => ({ schema: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: { schema: mocks.schema },
}));

function query(result: { data: unknown; error: unknown }) {
  const captured: {
    table?: string;
    select?: string;
    filters: { op: string; column: string; value: unknown }[];
    orders: string[];
    limits: number[];
    ors: string[];
  } = { filters: [], orders: [], limits: [], ors: [] };
  const chain: Record<string, unknown> = {};
  chain.select = (columns: string) => {
    captured.select = columns;
    return chain;
  };
  chain.order = (column: string) => {
    captured.orders.push(column);
    return chain;
  };
  for (const op of ['eq', 'gt'] as const) {
    chain[op] = (column: string, value: unknown) => {
      captured.filters.push({ op, column, value });
      return chain;
    };
  }
  chain.or = (filter: string) => {
    captured.ors.push(filter);
    return chain;
  };
  chain.limit = (count: number) => {
    captured.limits.push(count);
    return chain;
  };
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  const from = vi.fn((table: string) => {
    captured.table = table;
    return chain;
  });
  mocks.schema.mockReturnValue({ from });
  return captured;
}

const write: DecisionWrite = {
  requestId: 'd1900000-0000-4000-8000-000000000001',
  orderId: 'order-1',
  decision: 'not_made',
  token: 'token-1',
  reason: 'اتلغى قبل التحضير',
  returned: null,
};

const okResult = {
  status: 'ok',
  order_id: 'order-1',
  event_id: 12,
  decision: 'not_made',
  class: 'canceled',
  outcome: 'posted',
  reason: 'not_made',
  differences: {
    stock_quantity: '0',
    stock_value: '0.00',
    cogs: '0.00',
    waste: '0.00',
    profit: '0.00',
  },
};

describe('order decisions api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
  });

  describe('rowOf', () => {
    it('keeps money and quantities as the exact text the server sent', () => {
      const row = rowOf(
        rawRow({
          current_class: 'partial_refund',
          refund_total: '45.50',
          refunds: [
            {
              shift_id: 's1',
              tx_id: 't1',
              amount: '45.50',
              occurred_at: '2030-06-01T11:00:00+00:00',
            },
          ],
          returned: [{ stock_item_id: 'item-a', returned: '0.500000' }],
        }),
      );
      expect(row.orderTotal).toBe('180.00');
      expect(row.refundTotal).toBe('45.50');
      expect(row.basisItems[0]?.quantity).toBe('1.500000');
      expect(row.returned).toEqual([
        { stockItemId: 'item-a', returned: '0.500000' },
      ]);
      expect(row.refunds[0]?.amount).toBe('45.50');
    });

    it('accepts an order that no longer has a class', () => {
      expect(rowOf(rawRow({ current_class: null })).currentClass).toBeNull();
    });

    it('refuses a JSON number for money', () => {
      expect(() => rowOf(rawRow({ order_total: 180 }))).toThrow(
        genericCatalogError,
      );
      expect(() =>
        rowOf(rawRow({ differences: { ...okResult.differences, cogs: 0.1 } })),
      ).toThrow(genericCatalogError);
    });

    it('refuses values outside the known sets', () => {
      expect(() => rowOf(rawRow({ current_class: 'free' }))).toThrow(
        genericCatalogError,
      );
      expect(() => rowOf(rawRow({ review_reason: 'because' }))).toThrow(
        genericCatalogError,
      );
      expect(() => rowOf(rawRow({ decision: 'maybe' }))).toThrow(
        genericCatalogError,
      );
      expect(() => rowOf(rawRow({ needs_decision: 'yes' }))).toThrow(
        genericCatalogError,
      );
      expect(() => rowOf(null)).toThrow(genericCatalogError);
    });
  });

  describe('loadQueuePage', () => {
    it('pages by order id and asks only for rows that need a decision', async () => {
      const captured = query({
        data: [rawRow({ order_id: 'order-1' })],
        error: null,
      });
      const page = await loadQueuePage('pending', 'order-0');
      expect(captured.table).toBe('order_decision_queue');
      expect(captured.filters).toEqual([
        { op: 'eq', column: 'needs_decision', value: true },
        { op: 'gt', column: 'order_id', value: 'order-0' },
      ]);
      expect(captured.orders).toEqual(['order_id']);
      expect(captured.limits).toEqual([queuePageSize]);
      expect(page.next).toBeNull();
      expect(page.rows.map((row) => row.orderId)).toEqual(['order-1']);
    });

    it('does not filter the all view and returns the last id of a full page', async () => {
      const data = [
        rawRow({ order_id: 'order-1' }),
        rawRow({ order_id: 'order-2' }),
      ];
      const captured = query({ data, error: null });
      const page = await loadQueuePage('all', null, 2);
      expect(captured.filters).toEqual([]);
      expect(captured.limits).toEqual([2]);
      expect(page.next).toBe('order-2');
    });

    it('fails with the generic message and no raw server text', async () => {
      query({ data: null, error: { code: 'XX000', message: 'raw detail' } });
      await expect(loadQueuePage('all', null)).rejects.toThrow(
        genericCatalogError,
      );
    });
  });

  describe('loadQueueRow', () => {
    it('returns one row, or null once the episode closed', async () => {
      const captured = query({ data: [rawRow()], error: null });
      await expect(loadQueueRow('order-1')).resolves.toMatchObject({
        orderId: 'order-1',
      });
      expect(captured.filters).toEqual([
        { op: 'eq', column: 'order_id', value: 'order-1' },
      ]);
      query({ data: [], error: null });
      await expect(loadQueueRow('order-1')).resolves.toBeNull();
    });
  });

  describe('loadUnlinkedRefunds', () => {
    it('reads every page by shift id and transaction id', async () => {
      const captured = query({
        data: [
          {
            shift_id: 's1',
            tx_id: 't1',
            amount: '12.00',
            occurred_at: '2030-06-01T11:00:00+00:00',
          },
        ],
        error: null,
      });
      await expect(loadUnlinkedRefunds()).resolves.toEqual([
        {
          shiftId: 's1',
          txId: 't1',
          amount: '12.00',
          occurredAt: '2030-06-01T11:00:00+00:00',
        },
      ]);
      expect(captured.table).toBe('unlinked_refunds');
      expect(captured.orders).toEqual(['shift_id', 'tx_id']);
    });
  });

  describe('setOrderDisposition', () => {
    it('sends the request id, the token and a null reason for no returns', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: okResult, error: null });
      mocks.schema.mockReturnValue({ rpc });
      const result = await setOrderDisposition({ ...write, reason: null });
      expect(mocks.schema).toHaveBeenCalledWith('app');
      expect(rpc).toHaveBeenCalledWith('set_order_disposition', {
        p_request_id: write.requestId,
        p_order_id: 'order-1',
        p_decision: 'not_made',
        p_token: 'token-1',
        p_reason: null,
        p_returned: null,
      });
      expect(result).toMatchObject({
        status: 'ok',
        eventId: 12,
        decisionClass: 'canceled',
      });
    });

    it('sends the cumulative returned quantities as decimal text', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: okResult, error: null });
      mocks.schema.mockReturnValue({ rpc });
      await setOrderDisposition({
        ...write,
        returned: [
          { stockItemId: 'item-a', returned: '0.5' },
          { stockItemId: 'item-b', returned: '0.000001' },
        ],
      });
      expect(rpc).toHaveBeenCalledWith(
        'set_order_disposition',
        expect.objectContaining({
          p_reason: 'اتلغى قبل التحضير',
          p_returned: [
            { stock_item_id: 'item-a', returned: '0.5' },
            { stock_item_id: 'item-b', returned: '0.000001' },
          ],
        }),
      );
    });

    it('treats an empty list as "no quantities returned", not "unchanged"', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: okResult, error: null });
      mocks.schema.mockReturnValue({ rpc });
      await setOrderDisposition({ ...write, returned: [] });
      expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_returned: [] });
    });

    it('turns the stale-token refusal into a known stale write', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { code: '40001', message: orderChangedServerMessage },
      });
      mocks.schema.mockReturnValue({ rpc });
      await expect(setOrderDisposition(write)).rejects.toBeInstanceOf(
        OrderChangedError,
      );
    });

    it('keeps a bare serialization failure unknown', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { code: '40001', message: 'could not serialize access' },
      });
      mocks.schema.mockReturnValue({ rpc });
      const failure = await setOrderDisposition(write).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(OrderChangedError);
      expect(failure).not.toBeInstanceOf(ConfirmedRefusalError);
      expect((failure as { code?: string }).code).toBe('40001');
    });

    it('confirms a payload refusal and leaves a running sync unknown', async () => {
      const rpc = vi
        .fn()
        .mockResolvedValueOnce({
          data: null,
          error: {
            code: 'P0001',
            message: 'a reason is required to change a decision',
          },
        })
        .mockResolvedValueOnce({
          data: null,
          error: { code: '55P03', message: 'a POS sync is running' },
        });
      mocks.schema.mockReturnValue({ rpc });
      await expect(setOrderDisposition(write)).rejects.toBeInstanceOf(
        ConfirmedRefusalError,
      );
      const running = await setOrderDisposition(write).catch(
        (error: unknown) => error,
      );
      expect(running).not.toBeInstanceOf(ConfirmedRefusalError);
      expect((running as { code?: string }).code).toBeUndefined();
    });

    it('reports an order the discount switch has not reached', async () => {
      const rpc = vi
        .fn()
        .mockResolvedValue({ data: { status: 'not_activated' }, error: null });
      mocks.schema.mockReturnValue({ rpc });
      await expect(setOrderDisposition(write)).resolves.toEqual({
        status: 'not_activated',
      });
    });
  });

  describe('resultOf', () => {
    it('refuses a result it does not understand', () => {
      expect(() => resultOf({ status: 'maybe' })).toThrow(genericCatalogError);
      expect(() => resultOf({ ...okResult, class: 'free' })).toThrow(
        genericCatalogError,
      );
    });
  });
});
