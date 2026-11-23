import { describe, expect, it } from 'vitest';
import { CATALOG_REJECTED_FIELDS } from './catalog-allowlist.ts';
import { isCustomerShapedKey, isPriceShapedKey } from './catalog-refusals.ts';
import {
  assertNoPriceShapedKeys,
  catalogItemContentHash,
  parseCatalog,
  parseCatalogItemDocument,
  parseCatalogOptionGroupDocument,
  posSizeKey,
} from './catalog.ts';
import { parseListResponse } from './firestore-read.ts';
import { mapOrderDocument } from './mapper.ts';
import type { FirestoreRestDocument } from './pos-firestore.ts';

const DOC_ROOT = 'projects/thesharkrestaurant/databases/(default)/documents';

function str(value: string): { stringValue: string } {
  return { stringValue: value };
}

function int(value: number): { integerValue: string } {
  return { integerValue: String(value) };
}

function dbl(value: number): { doubleValue: number } {
  return { doubleValue: value };
}

function arr(values: unknown[]): { arrayValue: { values: unknown[] } } {
  return { arrayValue: { values } };
}

function map(fields: Record<string, unknown>): {
  mapValue: { fields: Record<string, unknown> };
} {
  return { mapValue: { fields } };
}

function itemDoc(
  id: string,
  fields: Record<string, unknown>,
  updateTime = '2026-11-20T10:00:00.123456Z',
): FirestoreRestDocument {
  return {
    name: `${DOC_ROOT}/items/${id}`,
    updateTime,
    fields,
  };
}

function groupDoc(
  id: string,
  fields: Record<string, unknown>,
  updateTime = '2026-11-20T09:00:00Z',
): FirestoreRestDocument {
  return {
    name: `${DOC_ROOT}/optionGroups/${id}`,
    updateTime,
    fields,
  };
}

function collectSchemaKeys(
  value: unknown,
  segments: readonly string[] = [],
  found: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    const next = [...segments, '[]'];
    for (const entry of value) {
      collectSchemaKeys(entry, next, found);
    }
    return found;
  }
  if (value !== null && typeof value === 'object') {
    const keysAreLabels =
      segments.length === 3 &&
      segments[0] === 'items' &&
      segments[1] === '[]' &&
      segments[2] === 'item_option_groups';
    for (const [key, child] of Object.entries(value)) {
      if (!keysAreLabels) {
        found.push(key);
      }
      collectSchemaKeys(
        child,
        [...segments, keysAreLabels ? '<label>' : key],
        found,
      );
    }
  }
  return found;
}

/** Synthetic item fixtures covering the discovered catalog layout and refusals. */
const FIXTURE_TWO_SIZES_WITH_REJECTED = itemDoc('item-syn-two-sizes', {
  name: str('  Synthetic Dish Alpha  '),
  categoryId: str('cat-syn-1'),
  description: str('synthetic-description-drop'),
  imageUrl: str('https://example.invalid/syn-alpha.png'),
  name_lowercase: str('synthetic dish alpha'),
  pluCode: str('90001'),
  pricingType: str('fixed'),
  scaleSizeName: str('syn-scale'),
  weightedUnit: str('kg'),
  sizes: arr([
    map({
      name: str('Large'),
      price: dbl(199.5),
      costPrice: dbl(85.25),
      pricingBaseQuantity: int(1),
      recipe: arr([map({ ingredientId: str('ing-syn-1'), qty: dbl(0.5) })]),
    }),
    map({
      name: str('  Small  '),
      price: dbl(110.0),
      costPrice: dbl(45.0),
      pricingBaseQuantity: int(1),
      recipe: arr([]),
    }),
  ]),
});

const FIXTURE_ITEM_LOCAL_GROUP = itemDoc('item-syn-local-opt', {
  name: str('Synthetic Dish Beta'),
  pricingType: str('fixed'),
  sizes: arr([map({ name: str('Regular'), price: dbl(75) })]),
  options: map({
    'Synthetic Sauce': arr([
      map({
        value: str('Herb'),
        price: dbl(12.5),
        costPrice: dbl(3.0),
        pricingType: str('fixed'),
        pricingBaseQuantity: int(1),
        recipe: arr([]),
      }),
      map({
        value: str('Citrus'),
        price: dbl(15.0),
        costPrice: dbl(4.0),
        pricingType: str('perKg'),
        pricingBaseQuantity: int(1),
        recipe: arr([]),
      }),
    ]),
  }),
});

const FIXTURE_SHARED_AND_LOCAL = itemDoc('item-syn-shared-opt', {
  name: str('Synthetic Dish Gamma'),
  sizes: arr([map({ name: str('Portion'), price: dbl(140) })]),
  options: map({
    'Synthetic Prep': arr([
      map({
        value: str('Baked'),
        price: dbl(20),
        costPrice: dbl(5),
        pricingType: str('fixed'),
        pricingBaseQuantity: int(1),
        recipe: arr([]),
      }),
    ]),
    'Synthetic Addon': arr([
      map({
        value: str('Extra Lemon'),
        price: dbl(5),
        costPrice: dbl(1),
      }),
    ]),
  }),
  sharedOptionGroupIds: map({
    'Synthetic Prep': str('group-syn-prep'),
  }),
});

const FIXTURE_NO_SIZES = itemDoc('item-syn-no-sizes', {
  name: str('Synthetic Dish Delta'),
  sizes: { arrayValue: {} },
  pricingType: str('fixed'),
});

const FIXTURE_MISSING_SIZES = itemDoc('item-syn-missing-sizes', {
  name: str('Synthetic Dish Epsilon'),
});

const FIXTURE_SHARED_GROUP = groupDoc('group-syn-prep', {
  name: str('Synthetic Prep'),
  values: arr([
    map({
      value: str('Roasted'),
      price: dbl(25),
      costPrice: dbl(6),
      pricingType: str('fixed'),
      pricingBaseQuantity: int(1),
      recipe: arr([]),
    }),
    map({
      value: str('Baked'),
      price: dbl(20),
      costPrice: dbl(5),
      pricingType: str('perKg'),
      pricingBaseQuantity: int(1),
      recipe: arr([]),
    }),
  ]),
});

const FIXTURE_CUSTOMER_TOP_LEVEL = itemDoc('item-syn-cust-top', {
  name: str('Synthetic Dish Should Reject'),
  customerName: str('syn-person-never-keep'),
  sizes: arr([map({ name: str('Regular') })]),
});

const FIXTURE_CUSTOMER_NESTED = itemDoc('item-syn-cust-nested', {
  name: str('Synthetic Dish Nested Reject'),
  sizes: arr([
    map({
      name: str('Regular'),
      recipe: arr([map({ customerPhone: str('01000000000') })]),
    }),
  ]),
});

const FIXTURE_MALFORMED_NAME_KIND = itemDoc('item-syn-bad-kind', {
  name: {
    referenceValue:
      'projects/thesharkrestaurant/databases/(default)/documents/other/x',
  },
  sizes: arr([map({ name: str('Regular') })]),
});

const FIXTURE_MALFORMED_SIZE_KIND = itemDoc('item-syn-bad-size', {
  name: str('Synthetic Dish Bad Size'),
  sizes: arr([map({ name: int(42) })]),
});

const FIXTURE_MALFORMED_OPTION_VALUE = itemDoc('item-syn-bad-opt', {
  name: str('Synthetic Dish Bad Opt'),
  options: map({
    'Synthetic Sauce': arr([map({ value: { booleanValue: true } })]),
  }),
});

const FIXTURE_MALFORMED_SHARED_ID = itemDoc('item-syn-bad-shared-id', {
  name: str('Synthetic Dish Bad Shared Id'),
  sharedOptionGroupIds: map({
    'Synthetic Prep': str('../customers'),
  }),
});

const ALL_SAFE_ITEM_FIXTURES = [
  FIXTURE_TWO_SIZES_WITH_REJECTED,
  FIXTURE_ITEM_LOCAL_GROUP,
  FIXTURE_SHARED_AND_LOCAL,
  FIXTURE_NO_SIZES,
  FIXTURE_MISSING_SIZES,
  FIXTURE_CUSTOMER_TOP_LEVEL,
  FIXTURE_CUSTOMER_NESTED,
  FIXTURE_MALFORMED_NAME_KIND,
  FIXTURE_MALFORMED_SIZE_KIND,
  FIXTURE_MALFORMED_OPTION_VALUE,
  FIXTURE_MALFORMED_SHARED_ID,
];

describe('posSizeKey parity with app.pos_size_key', () => {
  it('matches supabase/migrations/20261106000000_pos_mapping.sql:418', () => {
    expect(posSizeKey(null)).toEqual(['none']);
    expect(posSizeKey(undefined)).toEqual(['none']);
    expect(posSizeKey('')).toEqual(['none']);
    expect(posSizeKey('   ')).toEqual(['none']);
    expect(posSizeKey('صغير')).toEqual(['name', 'صغير']);
    expect(posSizeKey('  صغير  ')).toEqual(['name', 'صغير']);
    expect(posSizeKey('none')).toEqual(['name', 'none']);
    expect(posSizeKey('  none  ')).toEqual(['name', 'none']);
    expect(posSizeKey('small  size')).toEqual(['name', 'small  size']);
    // PostgreSQL btrim(text) strips ASCII space (' ') only, not tabs.
    expect(posSizeKey('\t')).toEqual(['name', '\t']);
  });

  it('matches order mapper normalization + app.pos_size_key across whitespace inputs', () => {
    const inputs = [
      '',
      '   ',
      '\t',
      '\tRegular\t',
      '\r\n  صغير \t',
      '  صغير  ',
      'none',
      '  none  ',
      'small  size',
    ];
    for (const rawSize of inputs) {
      const order = mapOrderDocument({
        name: `${DOC_ROOT}/orders/order-syn-size-parity`,
        updateTime: '2026-11-20T10:00:00Z',
        fields: {
          status: str('complete'),
          shiftId: str('shift-syn-1'),
          timestamp: { timestampValue: '2026-11-20T10:00:00Z' },
          subtotalAmount: dbl(10),
          discountAmount: dbl(0),
          taxTotalAmount: dbl(0),
          serviceTaxAmount: dbl(0),
          totalAmount: dbl(10),
          items: arr([
            map({
              orderItemId: str('line-1'),
              itemId: str('item-syn-size-parity'),
              name: str('Synthetic Dish'),
              quantity: int(1),
              price: dbl(10),
              selectedSize: map({ name: str(rawSize) }),
            }),
          ]),
        },
      });
      const catalog = parseCatalogItemDocument(
        itemDoc('item-syn-size-parity', {
          name: str('Synthetic Dish'),
          sizes: arr([map({ name: str(rawSize) })]),
        }),
      );
      expect(catalog.outcome).toBe('accepted');
      if (catalog.outcome !== 'accepted') {
        throw new Error('expected accepted');
      }
      const orderSizeName = order.lines[0]?.size_name ?? null;
      expect(catalog.item.sizes[0]?.size_name, JSON.stringify(rawSize)).toBe(
        orderSizeName,
      );
      expect(catalog.item.sizes[0]?.size_key, JSON.stringify(rawSize)).toEqual(
        posSizeKey(orderSizeName),
      );
    }
  });
});

describe('parseCatalog fixtures', () => {
  it('parses two-size item and drops every rejected field', () => {
    const result = parseCatalogItemDocument(FIXTURE_TWO_SIZES_WITH_REJECTED);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(result.item.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.item).toEqual({
      pos_item_id: 'item-syn-two-sizes',
      name: 'Synthetic Dish Alpha',
      update_time: '2026-11-20T10:00:00.123456Z',
      content_hash: result.item.content_hash,
      sizes: [
        { size_name: 'Large', size_key: ['name', 'Large'] },
        { size_name: 'Small', size_key: ['name', 'Small'] },
      ],
      item_option_groups: {},
      shared_option_group_ids: [],
    });
    const serialized = JSON.stringify(result.item);
    for (const leaked of [
      'cat-syn-1',
      'synthetic-description-drop',
      'syn-alpha.png',
      '90001',
      'syn-scale',
      '199.5',
      '85.25',
      'ing-syn-1',
      'fixed',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    for (const rejected of CATALOG_REJECTED_FIELDS) {
      const leaf = rejected.replace(/\[\]/g, '').split('.').pop() ?? rejected;
      expect(collectSchemaKeys(result.item)).not.toContain(leaf);
    }
  });

  it('parses item-local option groups and drops option prices and recipes', () => {
    const result = parseCatalogItemDocument(FIXTURE_ITEM_LOCAL_GROUP);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(result.item.item_option_groups).toEqual({
      'Synthetic Sauce': ['Citrus', 'Herb'],
    });
    expect(result.item.shared_option_group_ids).toEqual([]);
  });

  it('preserves inline shared option copies in item scope alongside global optionGroups and shared_option_group_ids', () => {
    const payload = parseCatalog(
      [FIXTURE_SHARED_AND_LOCAL],
      [FIXTURE_SHARED_GROUP],
    );
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.item_option_groups).toEqual({
      'Synthetic Addon': ['Extra Lemon'],
      'Synthetic Prep': ['Baked'],
    });
    expect(payload.items[0]?.shared_option_group_ids).toEqual([
      'group-syn-prep',
    ]);
    expect(payload.option_groups).toEqual([
      {
        group_id: 'group-syn-prep',
        name: 'Synthetic Prep',
        values: ['Baked', 'Roasted'],
      },
    ]);
    expect(payload.presence).toEqual([
      { pos_item_id: 'item-syn-shared-opt', outcome: 'accepted' },
    ]);
    expect(payload.option_group_presence).toEqual([
      { group_id: 'group-syn-prep', outcome: 'accepted' },
    ]);

    // Adding an item-only inline value inside a shared group changes the item content hash.
    const withExtraInline = parseCatalogItemDocument(
      itemDoc('item-syn-shared-opt', {
        name: str('Synthetic Dish Gamma'),
        sizes: arr([map({ name: str('Portion'), price: dbl(140) })]),
        options: map({
          'Synthetic Prep': arr([
            map({ value: str('Baked'), price: dbl(20) }),
            map({ value: str('Smoked'), price: dbl(25) }),
          ]),
          'Synthetic Addon': arr([
            map({ value: str('Extra Lemon'), price: dbl(5) }),
          ]),
        }),
        sharedOptionGroupIds: map({
          'Synthetic Prep': str('group-syn-prep'),
        }),
      }),
    );
    expect(withExtraInline.outcome).toBe('accepted');
    if (withExtraInline.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(withExtraInline.item.content_hash).not.toBe(
      payload.items[0]?.content_hash,
    );
  });

  it('maps empty or missing sizes to a single ["none"] size key', () => {
    for (const doc of [
      FIXTURE_NO_SIZES,
      FIXTURE_MISSING_SIZES,
      itemDoc('item-syn-blank-sizes', {
        name: str('Synthetic Dish Blank Sizes'),
        sizes: arr([map({ name: str('') }), map({ name: str('   ') })]),
      }),
    ]) {
      const result = parseCatalogItemDocument(doc);
      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted') {
        throw new Error('expected accepted');
      }
      expect(result.item.sizes).toEqual([
        { size_name: null, size_key: ['none'] },
      ]);
    }
  });

  it('ignores unknown Firestore value kinds on unallowed fields', () => {
    const doc = itemDoc('item-syn-ignored-kind', {
      name: str('Synthetic Dish Ignored Kind'),
      description: {
        referenceValue:
          'projects/thesharkrestaurant/databases/(default)/documents/other/ref-1',
      },
      recipe: { geoPointValue: { latitude: 0, longitude: 0 } },
    });
    const result = parseCatalogItemDocument(doc);
    expect(result.outcome).toBe('accepted');
  });

  it('refuses duplicate item or option group ids', () => {
    expect(() =>
      parseCatalog([FIXTURE_NO_SIZES, FIXTURE_NO_SIZES], []),
    ).toThrow(/duplicate catalog item id/);
    expect(() =>
      parseCatalog([], [FIXTURE_SHARED_GROUP, FIXTURE_SHARED_GROUP]),
    ).toThrow(/duplicate catalog option group id/);
  });
});

describe('refusals', () => {
  it('rejects any document with a customer-shaped key and keeps only its id', () => {
    const payload = parseCatalog(
      [
        FIXTURE_TWO_SIZES_WITH_REJECTED,
        FIXTURE_CUSTOMER_TOP_LEVEL,
        FIXTURE_CUSTOMER_NESTED,
      ],
      [
        groupDoc('group-syn-cust', {
          name: str('Should Reject Group'),
          employeeEmail: str('syn-staff@example.invalid'),
          values: arr([map({ value: str('Keep Nothing') })]),
        }),
      ],
    );
    expect(payload.items.map((item) => item.pos_item_id)).toEqual([
      'item-syn-two-sizes',
    ]);
    expect(payload.presence).toEqual([
      { pos_item_id: 'item-syn-cust-nested', outcome: 'rejected' },
      { pos_item_id: 'item-syn-cust-top', outcome: 'rejected' },
      { pos_item_id: 'item-syn-two-sizes', outcome: 'accepted' },
    ]);
    expect(payload.option_groups).toEqual([]);
    expect(payload.option_group_presence).toEqual([
      { group_id: 'group-syn-cust', outcome: 'rejected' },
    ]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('syn-person-never-keep');
    expect(serialized).not.toContain('01000000000');
    expect(serialized).not.toContain('Should Reject');
    expect(serialized).not.toContain('Keep Nothing');
  });

  it('rejects documents with unknown value kinds or malformed allowed shapes', () => {
    for (const [doc, expectedId] of [
      [FIXTURE_MALFORMED_NAME_KIND, 'item-syn-bad-kind'],
      [FIXTURE_MALFORMED_SIZE_KIND, 'item-syn-bad-size'],
      [FIXTURE_MALFORMED_OPTION_VALUE, 'item-syn-bad-opt'],
      [FIXTURE_MALFORMED_SHARED_ID, 'item-syn-bad-shared-id'],
      [
        {
          name: `${DOC_ROOT}/items/item-syn-no-time`,
          fields: { name: str('Missing Update Time') },
        },
        'item-syn-no-time',
      ],
    ] as const) {
      expect(parseCatalogItemDocument(doc)).toEqual({
        outcome: 'rejected',
        pos_item_id: expectedId,
      });
    }

    expect(
      parseCatalogOptionGroupDocument(
        groupDoc('group-syn-bad-val', {
          name: str('Bad Group'),
          values: arr([map({ value: { bytesValue: 'AAAA' } })]),
        }),
      ),
    ).toEqual({
      outcome: 'rejected',
      group_id: 'group-syn-bad-val',
    });
  });

  it('refuses unsafe document ids by throwing before emitting any presence row', () => {
    const unsafeDocs: FirestoreRestDocument[] = [
      {
        name: `${DOC_ROOT}/items/../customers`,
        updateTime: '2026-11-20T10:00:00Z',
        fields: { name: str('Traversal') },
      },
      {
        name: `${DOC_ROOT}/items/bad id`,
        updateTime: '2026-11-20T10:00:00Z',
        fields: { name: str('Space Id') },
      },
      {
        name: `${DOC_ROOT}/customers/cust-1`,
        updateTime: '2026-11-20T10:00:00Z',
        fields: { name: str('Wrong Collection') },
      },
    ];
    for (const doc of unsafeDocs) {
      expect(() => parseCatalog([doc], [])).toThrow();
    }
    expect(() =>
      parseCatalog(
        [],
        [
          {
            name: `${DOC_ROOT}/optionGroups/bad%2Fid`,
            updateTime: '2026-11-20T10:00:00Z',
            fields: { name: str('Bad Group Id') },
          },
        ],
      ),
    ).toThrow();
  });

  it('asserts no price-shaped key exists in any output across all fixtures and throws on forged price keys', () => {
    const payload = parseCatalog(ALL_SAFE_ITEM_FIXTURES, [
      FIXTURE_SHARED_GROUP,
    ]);
    const schemaKeys = collectSchemaKeys(payload);
    expect(schemaKeys.length).toBeGreaterThan(0);
    for (const key of schemaKeys) {
      expect(isPriceShapedKey(key), key).toBe(false);
      expect(isCustomerShapedKey(key), key).toBe(false);
    }

    expect(() => assertNoPriceShapedKeys({ items: [{ price: 10 }] })).toThrow(
      /price-shaped/,
    );
    expect(() =>
      assertNoPriceShapedKeys({
        items: [{ sizes: [{ costPrice: 5 }] }],
      }),
    ).toThrow(/price-shaped/);
    expect(() =>
      assertNoPriceShapedKeys({
        option_groups: [{ pricingType: 'fixed' }],
      }),
    ).toThrow(/price-shaped/);
    for (const forged of [
      { items: [{ 'extraPrice.details': 1 }] },
      { items: [{ deliveryFee: 10 }] },
      { items: [{ serviceCharge: 5 }] },
      { items: [{ discount: 2 }] },
      { items: [{ tax: 14 }] },
      { items: [{ tip: 3 }] },
      {
        items: [{ item_option_groups: { 'Price Specials': [{ fee: 1 }] } }],
      },
    ]) {
      expect(
        () => assertNoPriceShapedKeys(forged),
        JSON.stringify(forged),
      ).toThrow(/price-shaped/);
    }
  });

  it('accepts dynamic labels containing guest or price words while rejecting schema keys', () => {
    const labeledItem = itemDoc('item-syn-data-labels', {
      name: str('Synthetic Dish Labels'),
      options: map({
        'Guest Favorites': arr([
          map({ value: str('Mild'), price: dbl(10), fee: dbl(2) }),
        ]),
        'Price Specials': arr([
          map({ value: str('Combo'), costPrice: dbl(5), discount: dbl(1) }),
        ]),
      }),
      sharedOptionGroupIds: map({
        'Guest Favorites': str('group-syn-guest'),
        'Price Specials': str('group-syn-special'),
      }),
    });
    const payload = parseCatalog([labeledItem], []);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.item_option_groups).toEqual({
      'Guest Favorites': ['Mild'],
      'Price Specials': ['Combo'],
    });
    expect(payload.items[0]?.shared_option_group_ids).toEqual([
      'group-syn-guest',
      'group-syn-special',
    ]);

    for (const [id, fields] of [
      [
        'item-syn-recipient',
        { name: str('X'), recipientName: str('syn-recipient') },
      ],
      ['item-syn-contact', { name: str('X'), contactInfo: str('syn-contact') }],
      [
        'item-syn-guest-schema',
        {
          name: str('X'),
          options: map({
            'Guest Favorites': arr([
              map({ value: str('Mild'), guestNote: str('syn-guest') }),
            ]),
          }),
        },
      ],
      [
        'item-syn-dotted-customer',
        { name: str('X'), 'recipient.details': str('syn-dotted') },
      ],
    ] as const) {
      expect(parseCatalogItemDocument(itemDoc(id, fields))).toEqual({
        outcome: 'rejected',
        pos_item_id: id,
      });
    }
  });

  it('rejects catalog documents carrying customer-shaped keys in extra raw document properties', () => {
    const rawPage = parseListResponse({
      documents: [
        {
          name: `${DOC_ROOT}/items/item-syn-raw-extra`,
          updateTime: '2026-11-20T10:00:00Z',
          fields: { name: str('Synthetic Dish Extra Prop') },
          customerMeta: { phone: '01000000000' },
        },
        {
          name: `${DOC_ROOT}/items/item-syn-raw-nested-recipient`,
          updateTime: '2026-11-20T10:00:00Z',
          fields: { name: str('Synthetic Dish Nested Extra') },
          annotations: { recipientName: 'syn-person' },
        },
      ],
    });
    const rawGroupPage = parseListResponse({
      documents: [
        {
          name: `${DOC_ROOT}/optionGroups/group-syn-raw-extra`,
          updateTime: '2026-11-20T09:00:00Z',
          fields: { name: str('Synthetic Group Extra') },
          contactMeta: { phone: '01111111111' },
        },
      ],
    });
    const payload = parseCatalog(rawPage.documents, rawGroupPage.documents);
    expect(payload.items).toEqual([]);
    expect(payload.presence).toEqual([
      { pos_item_id: 'item-syn-raw-extra', outcome: 'rejected' },
      { pos_item_id: 'item-syn-raw-nested-recipient', outcome: 'rejected' },
    ]);
    expect(payload.option_groups).toEqual([]);
    expect(payload.option_group_presence).toEqual([
      { group_id: 'group-syn-raw-extra', outcome: 'rejected' },
    ]);
    expect(JSON.stringify(rawPage)).not.toContain('01000000000');
    expect(JSON.stringify(rawPage)).not.toContain('syn-person');
    expect(JSON.stringify(rawGroupPage)).not.toContain('01111111111');
  });

  it('rejects impossible updateTime calendar dates and NUL bytes in ids', () => {
    expect(
      parseCatalogItemDocument(
        itemDoc(
          'item-syn-feb30',
          { name: str('Synthetic Dish Feb 30') },
          '2026-02-30T10:00:00Z',
        ),
      ),
    ).toEqual({
      outcome: 'rejected',
      pos_item_id: 'item-syn-feb30',
    });

    expect(() =>
      parseCatalog(
        [
          {
            name: `${DOC_ROOT}/items/item-syn\0nul`,
            updateTime: '2026-11-20T10:00:00Z',
            fields: { name: str('NUL Doc Id') },
          },
        ],
        [],
      ),
    ).toThrow();

    expect(
      parseCatalogItemDocument(
        itemDoc('item-syn-nul-shared', {
          name: str('NUL Shared Group Id'),
          sharedOptionGroupIds: map({
            'Synthetic Prep': str('group-syn\0nul'),
          }),
        }),
      ),
    ).toEqual({
      outcome: 'rejected',
      pos_item_id: 'item-syn-nul-shared',
    });
  });
});

describe('content hash stability', () => {
  it('is stable under key order, array order, updateTime, and rejected field changes', () => {
    const first = parseCatalogItemDocument(FIXTURE_SHARED_AND_LOCAL);
    const reordered = parseCatalogItemDocument(
      itemDoc(
        'item-syn-shared-opt',
        {
          sharedOptionGroupIds: map({
            'Synthetic Prep': str('group-syn-prep'),
          }),
          pricingType: str('weighted'),
          imageUrl: str('https://example.invalid/changed.png'),
          options: map({
            'Synthetic Addon': arr([
              map({ value: str('Extra Lemon'), price: dbl(999) }),
            ]),
            'Synthetic Prep': arr([
              map({ value: str('Baked'), costPrice: dbl(888) }),
            ]),
          }),
          sizes: arr([map({ name: str('Portion'), price: dbl(777) })]),
          name: str('Synthetic Dish Gamma'),
        },
        '2026-11-22T15:30:00Z',
      ),
    );
    expect(first.outcome).toBe('accepted');
    expect(reordered.outcome).toBe('accepted');
    if (first.outcome !== 'accepted' || reordered.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(reordered.item.content_hash).toBe(first.item.content_hash);

    const directHashA = catalogItemContentHash({
      pos_item_id: 'item-syn-h',
      name: 'Dish H',
      sizes: [
        { size_name: 'Small', size_key: ['name', 'Small'] },
        { size_name: 'Large', size_key: ['name', 'Large'] },
      ],
      item_option_groups: {
        B: ['y', 'x'],
        A: ['2', '1'],
      },
      shared_option_group_ids: ['g-2', 'g-1'],
    });
    const directHashB = catalogItemContentHash({
      pos_item_id: 'item-syn-h',
      name: 'Dish H',
      sizes: [
        { size_name: 'Large', size_key: ['name', 'Large'] },
        { size_name: 'Small', size_key: ['name', 'Small'] },
      ],
      item_option_groups: {
        A: ['1', '2'],
        B: ['x', 'y'],
      },
      shared_option_group_ids: ['g-1', 'g-2'],
    });
    expect(directHashA).toBe(directHashB);
    expect(directHashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any stored field changes', () => {
    const base = catalogItemContentHash({
      pos_item_id: 'item-syn-h',
      name: 'Dish H',
      sizes: [{ size_name: 'Small', size_key: ['name', 'Small'] }],
      item_option_groups: { Sauce: ['Herb'] },
      shared_option_group_ids: ['g-1'],
    });
    expect(
      catalogItemContentHash({
        pos_item_id: 'item-syn-h',
        name: 'Dish H Renamed',
        sizes: [{ size_name: 'Small', size_key: ['name', 'Small'] }],
        item_option_groups: { Sauce: ['Herb'] },
        shared_option_group_ids: ['g-1'],
      }),
    ).not.toBe(base);
    expect(
      catalogItemContentHash({
        pos_item_id: 'item-syn-h',
        name: 'Dish H',
        sizes: [{ size_name: 'Large', size_key: ['name', 'Large'] }],
        item_option_groups: { Sauce: ['Herb'] },
        shared_option_group_ids: ['g-1'],
      }),
    ).not.toBe(base);
    expect(
      catalogItemContentHash({
        pos_item_id: 'item-syn-h',
        name: 'Dish H',
        sizes: [{ size_name: 'Small', size_key: ['name', 'Small'] }],
        item_option_groups: { Sauce: ['Citrus'] },
        shared_option_group_ids: ['g-1'],
      }),
    ).not.toBe(base);
    expect(
      catalogItemContentHash({
        pos_item_id: 'item-syn-h',
        name: 'Dish H',
        sizes: [{ size_name: 'Small', size_key: ['name', 'Small'] }],
        item_option_groups: { Sauce: ['Herb'] },
        shared_option_group_ids: ['g-2'],
      }),
    ).not.toBe(base);
  });
});
