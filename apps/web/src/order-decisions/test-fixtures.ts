import type { Differences, QueueRow } from '@/order-decisions/types';

export const zeroDifferences: Differences = {
  stockQuantity: '0',
  stockValue: '0.00',
  cogs: '0.00',
  waste: '0.00',
  profit: '0.00',
};

/** Synthetic queue row: a canceled order whose default sale was never reviewed. */
export function queueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    orderId: 'order-1',
    episode: 1,
    currentClass: 'canceled',
    decidedClass: 'canceled',
    reviewReason: null,
    token: 'token-1',
    needsDecision: true,
    eventId: 11,
    decision: 'made',
    source: 'system_default',
    ownerReviewed: false,
    decisionReason: null,
    decidedAt: '2030-06-01T10:00:00.000Z',
    orderNumber: 41,
    orderedAt: '2030-06-01T09:30:00.000Z',
    orderStatus: 'canceled',
    missingFromPos: false,
    orderTotal: '180.00',
    decidedOrderTotal: '180.00',
    refundTotal: null,
    decidedRefundTotal: '0.00',
    basisStatus: 'ready',
    basisItems: [
      {
        stockItemId: 'item-a',
        name: 'سمك تجريبي',
        baseUnit: 'kg',
        quantity: '1.5',
      },
      {
        stockItemId: 'item-b',
        name: 'أرز تجريبي',
        baseUnit: 'kg',
        quantity: '0.25',
      },
    ],
    refunds: [],
    returned: [],
    differences: zeroDifferences,
    history: [],
    ...overrides,
  };
}

/** The same row in the shape PostgREST returns it. */
export function rawRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    order_id: 'order-1',
    episode: 1,
    current_class: 'canceled',
    decided_class: 'canceled',
    review_reason: null,
    token: 'token-1',
    needs_decision: true,
    event_id: 11,
    decision: 'made',
    source: 'system_default',
    owner_reviewed: false,
    decision_reason: null,
    decided_at: '2030-06-01T10:00:00+00:00',
    order_number: 41,
    ordered_at: '2030-06-01T09:30:00+00:00',
    order_status: 'canceled',
    missing_from_pos: false,
    order_total: '180.00',
    decided_order_total: '180.00',
    refund_total: null,
    decided_refund_total: '0.00',
    basis_status: 'ready',
    basis_items: [
      {
        stock_item_id: 'item-a',
        name: 'سمك تجريبي',
        base_unit: 'kg',
        quantity: '1.500000',
      },
    ],
    refunds: [],
    returned: [],
    differences: {
      stock_quantity: '0',
      stock_value: '0.00',
      cogs: '0.00',
      waste: '0.00',
      profit: '0.00',
    },
    history: [],
    ...overrides,
  };
}
