import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from './hash.ts';
import type { StoredOrder } from './types.ts';

function sample(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'order-test-1',
    order_number: 7,
    shift_id: 'shift-test-1',
    status: 'complete',
    order_type: 'takeaway',
    payment_type: 'cash',
    ordered_at: '2026-10-15T12:00:00.000000Z',
    subtotal: '10.00',
    discount: '0.00',
    tax: '0.00',
    service_tax: '0.00',
    delivery_fee: '0.00',
    total: '10.00',
    financial_revision: 1,
    last_financial_operation_key: 'op-test-1',
    lines: [
      {
        line_id: 'line-b',
        item_id: 'item-test-1',
        item_name: 'بوري',
        size_name: null,
        quantity: '1',
        weighted_qty: null,
        weighted_unit: null,
        unit_price: '10.00',
        price_per_kg: null,
        options: [],
        line_total: '10.00',
      },
      {
        line_id: 'line-a',
        item_id: 'item-test-2',
        item_name: null,
        size_name: 'كبير',
        quantity: '2',
        weighted_qty: null,
        weighted_unit: null,
        unit_price: '3.00',
        price_per_kg: null,
        options: [
          {
            value: 'مشوي',
            price: '1.00',
            pricingType: 'perKg',
            pricingBaseQuantity: '1',
          },
        ],
        line_total: '6.00',
      },
    ],
    ...overrides,
  };
}

describe('contentHash', () => {
  it('uses stable key order and line id order', () => {
    const first = contentHash(sample());
    const reversed = contentHash(
      sample({
        lines: [...sample().lines].reverse(),
      }),
    );
    expect(reversed).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: null })).toBe('{"a":null,"b":1}');
  });

  it('changes when the stored total changes', () => {
    expect(contentHash(sample({ total: '11.00' }))).not.toBe(
      contentHash(sample()),
    );
  });
});
