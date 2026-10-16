import { describe, expect, it } from 'vitest';
import { planIngestCalls, scopeForMode, window35From } from './scope.ts';
import type { PosOrderIngest, PosShiftIngest } from './types.ts';

function order(id: string): PosOrderIngest {
  return {
    id,
    order_number: 1,
    shift_id: 'shift-test-1',
    status: 'complete',
    order_type: null,
    payment_type: null,
    ordered_at: '2026-10-15T12:00:00.000000Z',
    subtotal: '1.00',
    discount: '0.00',
    tax: '0.00',
    service_tax: '0.00',
    delivery_fee: '0.00',
    total: '1.00',
    financial_revision: null,
    last_financial_operation_key: null,
    pos_update_time: '2026-10-15T12:00:00.000000Z',
    content_hash: 'ab'.repeat(32),
    lines: [],
  };
}

const shift: PosShiftIngest = {
  id: 'shift-test-1',
  opened_at: '2026-10-15T09:00:00.000000Z',
  closed_at: null,
  is_active: true,
  pos_update_time: '2026-10-15T18:00:00.000000Z',
};

describe('scopeForMode', () => {
  it('builds the three read scopes', () => {
    expect(
      scopeForMode('recent', { shiftIds: ['s1', 's2'], from: 'x' }),
    ).toEqual({
      shift_ids: ['s1', 's2'],
    });
    expect(
      scopeForMode('window35', {
        shiftIds: [],
        from: '2026-09-11T00:00:00.000Z',
      }),
    ).toEqual({
      from: '2026-09-11T00:00:00.000Z',
    });
    expect(scopeForMode('full', { shiftIds: [], from: 'x' })).toEqual({
      all: true,
    });
  });

  it('subtracts 35 exact days', () => {
    expect(window35From(new Date('2026-10-16T00:00:00.000Z'))).toBe(
      '2026-09-11T00:00:00.000Z',
    );
  });
});

describe('planIngestCalls', () => {
  it('sends the scope only with the last chunk and shifts only with the first', () => {
    const orders = Array.from({ length: 201 }, (_, index) =>
      order(`order-${index}`),
    );
    const calls = planIngestCalls({
      shifts: [shift],
      orders,
      scope: { shift_ids: ['shift-test-1'] },
      batchSize: 200,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.shifts).toEqual([shift]);
    expect(calls[0]?.orders).toHaveLength(200);
    expect(calls[0]?.scope).toBeNull();
    expect(calls[1]?.shifts).toEqual([]);
    expect(calls[1]?.orders).toHaveLength(1);
    expect(calls[1]?.scope).toEqual({ shift_ids: ['shift-test-1'] });
  });

  it('still sends the scope when there are no orders', () => {
    const calls = planIngestCalls({
      shifts: [shift],
      orders: [],
      scope: { all: true },
    });
    expect(calls).toEqual([
      { shifts: [shift], orders: [], scope: { all: true } },
    ]);
  });
});
