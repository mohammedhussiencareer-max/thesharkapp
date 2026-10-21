import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from './hash.ts';
import {
  mapOrderDocument,
  mapShiftDocument,
  mapShiftTransaction,
  storedProjection,
} from './mapper.ts';

const NAME_PREFIX = 'projects/thesharkrestaurant/databases/(default)/documents';

const PII = [
  'pii-customer-id',
  'pii-customer-name',
  'pii-employee-id',
  'pii-employee-name',
  '01000000000',
  'pii-address-street',
  '01111111111',
  'pii-delivery-address',
  'pii-line-note',
  'scale-device-test',
  'https://example.invalid/item.png',
  'T-99',
  'pii-order-id-field',
  'pii-option-extra',
  'drawer-should-drop',
  'shift-opening-should-drop',
  '12.34',
];

function str(value: string): { stringValue: string } {
  return { stringValue: value };
}

function int(value: number): { integerValue: string } {
  return { integerValue: String(value) };
}

function dbl(value: number): { doubleValue: number } {
  return { doubleValue: value };
}

function bool(value: boolean): { booleanValue: boolean } {
  return { booleanValue: value };
}

function ts(value: string): { timestampValue: string } {
  return { timestampValue: value };
}

function keysDeep(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      keysDeep(entry, found);
    }
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      keysDeep(child, found);
    }
  }
  return found;
}

describe('mapOrderDocument', () => {
  it('keeps accounting fields and drops synthetic PII', () => {
    const order = mapOrderDocument({
      name: `${NAME_PREFIX}/orders/order-test-1`,
      updateTime: '2026-10-15T14:00:00.123456789Z',
      fields: {
        orderId: str('pii-order-id-field'),
        orderNumber: int(1001),
        status: str('complete'),
        orderType: str('delivery'),
        paymentType: str('cash'),
        shiftId: str('shift-test-1'),
        shiftOpeningTime: ts('shift-opening-should-drop'),
        timestamp: ts('2026-10-15T12:00:00Z'),
        subtotalAmount: dbl(10.005),
        discountAmount: dbl(0.335),
        taxTotalAmount: dbl(1.004),
        serviceTaxAmount: dbl(2.005),
        totalAmount: dbl(16.005),
        deliveryFeeCharged: bool(true),
        customerId: str('pii-customer-id'),
        customerName: str('pii-customer-name'),
        employeeId: str('pii-employee-id'),
        employeeName: str('pii-employee-name'),
        phone: str('01000000000'),
        address: str('pii-address-street'),
        tableNumbers: { arrayValue: { values: [str('T-99')] } },
        deliveryDetails: {
          mapValue: {
            fields: {
              deliveryFee: dbl(1.005),
              phone: str('01111111111'),
              address: str('pii-delivery-address'),
            },
          },
        },
        financialRevision: int(3),
        lastFinancialOperationKey: str('op-test-1'),
        items: {
          arrayValue: {
            values: [
              {
                mapValue: {
                  fields: {
                    orderItemId: str('line-fixed'),
                    itemId: str('item-test-1'),
                    name: str('بوري'),
                    note: str('pii-line-note'),
                    itemImageUrl: str('https://example.invalid/item.png'),
                    scaleDeviceId: str('scale-device-test'),
                    costPrice: dbl(12.34),
                    size: str('صغير'),
                    selectedSize: {
                      mapValue: { fields: { name: str('كبير') } },
                    },
                    quantity: int(3),
                    weightedQuantity: int(0),
                    price: dbl(0.335),
                    selectedOptions: {
                      arrayValue: {
                        values: [
                          {
                            mapValue: {
                              fields: {
                                value: str('مشوي'),
                                price: dbl(1.005),
                                pricingType: str('perKg'),
                                pricingBaseQuantity: int(1),
                                note: str('pii-option-extra'),
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
              {
                mapValue: {
                  fields: {
                    orderItemId: str('line-weighted'),
                    itemId: str('item-test-2'),
                    name: str('جمبري'),
                    quantity: int(1),
                    weightedQuantity: dbl(1.25),
                    weightedUnit: str('kg'),
                    price: dbl(10.005),
                    scalePricePerKg: int(8),
                  },
                },
              },
            ],
          },
        },
      },
    });

    const encoded = JSON.stringify(order);
    for (const secret of PII) {
      expect(encoded).not.toContain(secret);
    }
    const keys = keysDeep(order);
    for (const key of [
      'customerId',
      'customerName',
      'employeeId',
      'employeeName',
      'deliveryDetails',
      'note',
      'itemImageUrl',
      'tableNumbers',
      'orderId',
      'shiftOpeningTime',
      'phone',
      'address',
      'scaleDeviceId',
      'costPrice',
    ]) {
      expect(keys).not.toContain(key);
    }

    expect(order.id).toBe('order-test-1');
    expect(order.order_number).toBe(1001);
    expect(order.financial_revision).toBe(3);
    expect(order.pos_update_time).toBe('2026-10-15T14:00:00.123456Z');
    expect(order.ordered_at).toBe('2026-10-15T12:00:00.000000Z');
    expect(order.subtotal).toBe('10.01');
    expect(order.discount).toBe('0.34');
    expect(order.tax).toBe('1.00');
    expect(order.service_tax).toBe('2.01');
    expect(order.delivery_fee).toBe('1.01');
    expect(order.total).toBe('16.01');
    expect(order.lines[0]?.unit_price).toBe('0.335');
    expect(order.lines[0]?.size_name).toBe('كبير');
    expect(order.lines[0]?.options[0]?.value).toBe('مشوي');
    expect(order.lines[1]?.weighted_qty).toBe('1.25');
    expect(order.lines[1]?.weighted_unit).toBe('kg');

    const stored = storedProjection(order);
    expect(stored.lines[0]?.unit_price).toBe('0.34');
    expect(stored.lines[0]?.line_total).toBe('1.01');
    expect(stored.lines[0]?.quantity).toBe('3');
    expect(stored.lines[0]?.weighted_qty).toBeNull();
    expect(stored.lines[0]?.options[0]?.price).toBe('1.01');
    expect(stored.lines[1]?.line_total).toBe('10.01');
    expect(stored.lines[1]?.price_per_kg).toBe('8.00');
    expect(stored.lines[1]?.weighted_qty).toBe('1.25');
    expect(order.content_hash).toBe(contentHash(stored));
    expect(order.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not echo a rejected status', () => {
    expect(() =>
      mapOrderDocument({
        name: `${NAME_PREFIX}/orders/order-test-1`,
        updateTime: '2026-10-15T12:00:00Z',
        fields: {
          status: str('pii-status'),
          shiftId: str('shift-test-1'),
          timestamp: ts('2026-10-15T12:00:00Z'),
          subtotalAmount: int(1),
          discountAmount: int(0),
          taxTotalAmount: int(0),
          serviceTaxAmount: int(0),
          totalAmount: int(1),
        },
      }),
    ).toThrow(/unexpected status/);
  });
});

describe('mapShiftDocument', () => {
  it('keeps open and close times and drops drawer fields', () => {
    const shift = mapShiftDocument({
      name: `${NAME_PREFIX}/custody_shifts/shift-test-1`,
      updateTime: '2026-10-15T18:00:00Z',
      fields: {
        id: str('shift-test-1'),
        opening_time: ts('2026-10-15T09:00:00Z'),
        closingTime: { nullValue: null },
        isActive: bool(true),
        drawerCash: str('drawer-should-drop'),
      },
    });
    expect(shift).toEqual({
      id: 'shift-test-1',
      opened_at: '2026-10-15T09:00:00.000000Z',
      closed_at: null,
      is_active: true,
      pos_update_time: '2026-10-15T18:00:00.000000Z',
      drawer_cash_net: null,
      drawer_credit: null,
      transactions: [],
    });
    expect(JSON.stringify(shift)).not.toContain('drawer-should-drop');
  });

  it('keeps drawer totals as exact money and ignores every other drawer field', () => {
    const shift = mapShiftDocument({
      name: `${NAME_PREFIX}/custody_shifts/shift-test-1`,
      updateTime: '2026-10-15T18:00:00Z',
      fields: {
        opening_time: ts('2026-10-15T09:00:00Z'),
        isActive: bool(false),
        cash_payments_net: dbl(100.5),
        credit_payments: int(20),
        difference: dbl(-12.34),
        expected_drawer_money: int(1),
        opening_amount: int(2),
        closing_amount: int(3),
        cash_drop: int(4),
        total_pay_ins: int(5),
        total_pay_outs: int(6),
        drawer_open_count: int(7),
      },
    });
    expect(shift.drawer_cash_net).toBe('100.50');
    expect(shift.drawer_credit).toBe('20.00');
    expect(JSON.stringify(shift)).not.toContain('difference');
    expect(JSON.stringify(shift)).not.toContain('-12.34');
  });

  it('rejects a shift id that does not match the document', () => {
    expect(() =>
      mapShiftDocument({
        name: `${NAME_PREFIX}/custody_shifts/shift-test-1`,
        updateTime: '2026-10-15T18:00:00Z',
        fields: {
          id: str('shift-test-other'),
          opening_time: ts('2026-10-15T09:00:00Z'),
          isActive: bool(true),
        },
      }),
    ).toThrow(/does not match/);
  });
});

const TX_SENTINEL = 'pii-tx-description 01000000000';

function txDocument(
  shiftId: string,
  txId: string,
  fields: Record<string, unknown>,
) {
  return {
    name: `${NAME_PREFIX}/custody_shifts/${shiftId}/transactions/${txId}`,
    fields,
  };
}

describe('mapShiftTransaction', () => {
  it('keeps types 0, 2 and 3 and ignores a PII-looking description', () => {
    const order = mapOrderDocument({
      name: `${NAME_PREFIX}/orders/order-test-1`,
      updateTime: '2026-10-15T12:00:00Z',
      fields: {
        status: str('complete'),
        shiftId: str('shift-test-1'),
        timestamp: ts('2026-10-15T12:00:00Z'),
        subtotalAmount: int(10),
        discountAmount: int(0),
        taxTotalAmount: int(0),
        serviceTaxAmount: int(0),
        totalAmount: int(10),
      },
    });
    const hashBefore = order.content_hash;
    const rows = [0, 2, 3].map((type) =>
      mapShiftTransaction(
        'shift-test-1',
        txDocument('shift-test-1', `tx-${type}`, {
          type: int(type),
          amount: type === 0 ? int(15) : dbl(12.5),
          timestamp: ts('2026-10-15T15:04:05Z'),
          description: str(TX_SENTINEL),
          operationKey: str('op-should-drop'),
          id: str('field-id-should-drop'),
          ...(type === 2 ? {} : { orderId: str('order-test-1') }),
        }),
      ),
    );
    expect(rows[0]).toEqual({
      tx_id: 'tx-0',
      order_id: 'order-test-1',
      tx_type: 0,
      amount: '15.00',
      occurred_at: '2026-10-15T15:04:05.000000Z',
    });
    expect(rows[1]?.order_id).toBeNull();
    expect(rows[1]?.amount).toBe('12.50');
    expect(rows[2]?.tx_type).toBe(3);
    const encoded = JSON.stringify(rows);
    expect(encoded).not.toContain(TX_SENTINEL);
    expect(encoded).not.toContain('01000000000');
    expect(encoded).not.toContain('op-should-drop');
    expect(keysDeep(rows)).not.toContain('description');
    expect(order.content_hash).toBe(hashBefore);
    expect(canonicalJson(storedProjection(order))).not.toContain(TX_SENTINEL);
    expect(canonicalJson({ transactions: rows })).not.toContain(TX_SENTINEL);
  });

  it('rejects a bad type, amount, or timestamp', () => {
    expect(() =>
      mapShiftTransaction(
        'shift-test-1',
        txDocument('shift-test-1', 'tx-bad', {
          type: dbl(1.5),
          amount: int(1),
          timestamp: ts('2026-10-15T15:00:00Z'),
        }),
      ),
    ).toThrow(/unexpected type/);
    expect(() =>
      mapShiftTransaction(
        'shift-test-1',
        txDocument('shift-test-1', 'tx-bad', {
          type: str('refund'),
          amount: int(1),
          timestamp: ts('2026-10-15T15:00:00Z'),
        }),
      ),
    ).toThrow(/unexpected type/);
    expect(() =>
      mapShiftTransaction(
        'shift-test-1',
        txDocument('shift-test-1', 'tx-bad', {
          type: int(3),
          amount: str('12.50'),
          timestamp: ts('2026-10-15T15:00:00Z'),
        }),
      ),
    ).toThrow(/unexpected amount/);
    expect(() =>
      mapShiftTransaction(
        'shift-test-1',
        txDocument('shift-test-1', 'tx-bad', {
          type: int(3),
          amount: int(1),
          timestamp: str('not-a-time'),
        }),
      ),
    ).toThrow(/timestamp/);
  });

  it('rejects a transaction whose parent shift does not match', () => {
    expect(() =>
      mapShiftTransaction(
        'shift-test-1',
        txDocument('shift-test-other', 'tx-a', {
          type: int(3),
          amount: int(1),
          timestamp: ts('2026-10-15T15:00:00Z'),
        }),
      ),
    ).toThrow(/invalid response/);
  });
});
