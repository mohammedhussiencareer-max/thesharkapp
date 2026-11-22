import { describe, expect, it } from 'vitest';
import {
  CATALOG_ITEM_FIELDS,
  CATALOG_OPTION_GROUP_FIELDS,
  CATALOG_REJECTED_FIELDS,
  isCustomerShapedPath,
  isPriceShapedPath,
} from './catalog-allowlist.ts';

const allowed = [...CATALOG_ITEM_FIELDS, ...CATALOG_OPTION_GROUP_FIELDS];

describe('catalog allowlist', () => {
  it('allows no price-shaped or customer-shaped field', () => {
    for (const path of allowed) {
      expect(isPriceShapedPath(path), path).toBe(false);
      expect(isCustomerShapedPath(path), path).toBe(false);
    }
  });

  it('never allows a rejected field', () => {
    for (const path of CATALOG_REJECTED_FIELDS) {
      expect(allowed as readonly string[]).not.toContain(path);
    }
  });

  it('flags every discovered price and cost field as price-shaped', () => {
    const money = CATALOG_REJECTED_FIELDS.filter((path) =>
      /price|cost|pricing/i.test(path),
    );
    expect(money.length).toBeGreaterThan(0);
    for (const path of money) {
      expect(isPriceShapedPath(path), path).toBe(true);
    }
  });

  it('detects price and customer keys at any depth', () => {
    expect(isPriceShapedPath('options.<label>[].price')).toBe(true);
    expect(isPriceShapedPath('sizes[].costPrice')).toBe(true);
    expect(isPriceShapedPath('sizes[].name')).toBe(false);
    expect(isCustomerShapedPath('meta.customerPhone')).toBe(true);
    expect(isCustomerShapedPath('sizes[].name')).toBe(false);
  });
});
