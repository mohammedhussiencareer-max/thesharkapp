import { describe, expect, it } from 'vitest';
import { decodeFirestoreValue, splitDocumentName } from './decode.ts';

describe('decodeFirestoreValue', () => {
  it('decodes the REST value types', () => {
    expect(decodeFirestoreValue({ stringValue: 'complete' })).toBe('complete');
    expect(decodeFirestoreValue({ integerValue: '42' })).toBe(42);
    expect(decodeFirestoreValue({ doubleValue: 1.5 })).toBe(1.5);
    expect(decodeFirestoreValue({ booleanValue: true })).toBe(true);
    expect(
      decodeFirestoreValue({ timestampValue: '2026-10-15T12:00:00Z' }),
    ).toBe('2026-10-15T12:00:00Z');
    expect(decodeFirestoreValue({ nullValue: null })).toBeNull();
    expect(
      decodeFirestoreValue({
        mapValue: { fields: { deliveryFee: { doubleValue: 12.5 } } },
      }),
    ).toEqual({ deliveryFee: 12.5 });
    expect(
      decodeFirestoreValue({
        arrayValue: { values: [{ integerValue: '1' }, { nullValue: null }] },
      }),
    ).toEqual([1, null]);
    expect(decodeFirestoreValue({ arrayValue: {} })).toEqual([]);
    expect(decodeFirestoreValue({ mapValue: {} })).toEqual({});
  });

  it('rejects unsupported and malformed values', () => {
    expect(() => decodeFirestoreValue({ referenceValue: 'x' })).toThrow(
      /unsupported/,
    );
    expect(() => decodeFirestoreValue({ integerValue: 12 })).toThrow(/integer/);
    expect(() => decodeFirestoreValue({ doubleValue: Number.NaN })).toThrow(
      /double/,
    );
    expect(() =>
      decodeFirestoreValue({ stringValue: 'a', integerValue: '1' }),
    ).toThrow(/invalid Firestore value/);
    expect(() => decodeFirestoreValue(null)).toThrow(/invalid Firestore value/);
  });
});

describe('splitDocumentName', () => {
  it('reads an order id from the document name', () => {
    expect(
      splitDocumentName(
        'projects/thesharkrestaurant/databases/(default)/documents/orders/order-test-1',
      ),
    ).toEqual({ collection: 'orders', id: 'order-test-1' });
  });

  it('rejects other projects and subcollections', () => {
    expect(() =>
      splitDocumentName(
        'projects/other/databases/(default)/documents/orders/a',
      ),
    ).toThrow(/invalid/);
    expect(() =>
      splitDocumentName(
        'projects/thesharkrestaurant/databases/(default)/documents/orders/a/items/b',
      ),
    ).toThrow(/invalid/);
    expect(() =>
      splitDocumentName(
        'projects/thesharkrestaurant/databases/(default)/documents/customers/a',
      ),
    ).toThrow(/invalid/);
  });
});
