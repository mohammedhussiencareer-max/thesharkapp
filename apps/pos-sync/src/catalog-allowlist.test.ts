import { describe, expect, it } from 'vitest';
import {
  CATALOG_ITEM_FIELDS,
  CATALOG_OPTION_GROUP_FIELDS,
  CATALOG_REJECTED_FIELDS,
} from './catalog-allowlist.ts';

describe('catalog allowlist', () => {
  it('pins the discovered item and option-group allowlists', () => {
    expect([...CATALOG_ITEM_FIELDS]).toEqual([
      'name',
      'sizes[].name',
      'options.<label>[].value',
      'sharedOptionGroupIds.<label>',
    ]);
    expect([...CATALOG_OPTION_GROUP_FIELDS]).toEqual([
      'name',
      'values[].value',
    ]);
  });

  it('never allows a rejected field', () => {
    const allowed: readonly string[] = [
      ...CATALOG_ITEM_FIELDS,
      ...CATALOG_OPTION_GROUP_FIELDS,
    ];
    for (const path of CATALOG_REJECTED_FIELDS) {
      expect(allowed).not.toContain(path);
    }
  });

  it('rejects every discovered price, cost and pricing field', () => {
    for (const parent of ['sizes[]', 'options.<label>[]', 'values[]']) {
      for (const leaf of ['price', 'costPrice', 'pricingBaseQuantity']) {
        expect(CATALOG_REJECTED_FIELDS as readonly string[]).toContain(
          `${parent}.${leaf}`,
        );
      }
    }
    for (const path of [
      'pricingType',
      'options.<label>[].pricingType',
      'values[].pricingType',
    ]) {
      expect(CATALOG_REJECTED_FIELDS as readonly string[]).toContain(path);
    }
  });
});
