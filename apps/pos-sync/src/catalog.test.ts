import { describe, expect, it } from 'vitest';
import {
  CATALOG_ITEM_FIELDS,
  CATALOG_OPTION_GROUP_FIELDS,
  CATALOG_REJECTED_FIELDS,
} from './catalog-allowlist.ts';
import {
  MAX_CATALOG_WALK_DEPTH,
  isCustomerShapedKey,
  isPriceShapedKey,
} from './catalog-refusals.ts';
import {
  assertNoPriceShapedKeys,
  catalogItemContentHash,
  parseCatalog,
  parseCatalogItemDocument,
  parseCatalogOptionGroupDocument,
  posSizeKey,
  projectAllowedItemFields,
  projectAllowedOptionGroupFields,
  resolveCatalogFieldSelectors,
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

  it('keeps option-group labels that differ only by surrounding whitespace', () => {
    const result = parseCatalogItemDocument(
      itemDoc('item-syn-ws-labels', {
        name: str('Synthetic Dish Whitespace Labels'),
        options: map({
          ' Sauce': arr([map({ value: str('  Herb  ') })]),
          'Sauce ': arr([map({ value: str('Citrus') })]),
          '  Sauce  ': arr([map({ value: str('Sharp') })]),
          '   ': arr([map({ value: str('Plain') })]),
        }),
        sharedOptionGroupIds: map({
          ' Sauce': str('group-syn-left'),
          'Sauce ': str('group-syn-right'),
          '   ': str('group-syn-space'),
        }),
      }),
    );
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(result.item.item_option_groups).toEqual({
      '   ': ['Plain'],
      '  Sauce  ': ['Sharp'],
      ' Sauce': ['Herb'],
      'Sauce ': ['Citrus'],
    });
    expect(result.item.shared_option_group_ids).toEqual([
      'group-syn-left',
      'group-syn-right',
      'group-syn-space',
    ]);
  });

  it('rejects an empty option-group label without trimming stored labels', () => {
    expect(
      parseCatalogItemDocument(
        itemDoc('item-syn-empty-label', {
          name: str('Synthetic Dish Empty Label'),
          options: map({
            '': arr([map({ value: str('Herb') })]),
          }),
        }),
      ),
    ).toEqual({
      outcome: 'rejected',
      pos_item_id: 'item-syn-empty-label',
    });
    expect(
      parseCatalogItemDocument(
        itemDoc('item-syn-empty-shared', {
          name: str('Synthetic Dish Empty Shared'),
          sharedOptionGroupIds: map({
            '': str('group-syn-empty'),
          }),
        }),
      ),
    ).toEqual({
      outcome: 'rejected',
      pos_item_id: 'item-syn-empty-shared',
    });
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

  it('preserves constructor, prototype, and __proto__ option-group labels through projection and hashing', () => {
    const optionsFields = Object.create(null) as Record<string, unknown>;
    optionsFields['constructor'] = arr([map({ value: str('Alpha') })]);
    optionsFields['prototype'] = arr([map({ value: str('Beta') })]);
    optionsFields['__proto__'] = arr([map({ value: str('Gamma') })]);

    const sharedFields = Object.create(null) as Record<string, unknown>;
    sharedFields['constructor'] = str('group-syn-ctor');
    sharedFields['prototype'] = str('group-syn-proto');
    sharedFields['__proto__'] = str('group-syn-dunder');

    const doc = itemDoc('item-syn-proto-labels', {
      name: str('Synthetic Dish Proto Labels'),
      options: { mapValue: { fields: optionsFields } },
      sharedOptionGroupIds: { mapValue: { fields: sharedFields } },
    });

    const payload = parseCatalog([doc], []);
    expect(payload.presence).toEqual([
      { pos_item_id: 'item-syn-proto-labels', outcome: 'accepted' },
    ]);
    expect(payload.items).toHaveLength(1);
    const item = payload.items[0];
    if (item === undefined) {
      throw new Error('expected accepted item');
    }
    expect(Object.getPrototypeOf(item.item_option_groups)).toBeNull();
    expect(Object.keys(item.item_option_groups)).toEqual([
      '__proto__',
      'constructor',
      'prototype',
    ]);
    expect(item.item_option_groups['constructor']).toEqual(['Alpha']);
    expect(item.item_option_groups['prototype']).toEqual(['Beta']);
    expect(item.item_option_groups['__proto__']).toEqual(['Gamma']);
    expect(item.shared_option_group_ids).toEqual([
      'group-syn-ctor',
      'group-syn-dunder',
      'group-syn-proto',
    ]);

    // Changing the __proto__ label's value changes the content hash.
    const changedOptions = Object.create(null) as Record<string, unknown>;
    changedOptions['constructor'] = arr([map({ value: str('Alpha') })]);
    changedOptions['prototype'] = arr([map({ value: str('Beta') })]);
    changedOptions['__proto__'] = arr([map({ value: str('Delta') })]);
    const changed = parseCatalogItemDocument(
      itemDoc('item-syn-proto-labels', {
        name: str('Synthetic Dish Proto Labels'),
        options: { mapValue: { fields: changedOptions } },
        sharedOptionGroupIds: { mapValue: { fields: sharedFields } },
      }),
    );
    expect(changed.outcome).toBe('accepted');
    if (changed.outcome !== 'accepted') {
      throw new Error('expected accepted');
    }
    expect(changed.item.content_hash).not.toBe(item.content_hash);
  });

  it('derives selectors from catalog-allowlist.ts and reads exactly CATALOG_ITEM_FIELDS and CATALOG_OPTION_GROUP_FIELDS', () => {
    expect(() =>
      resolveCatalogFieldSelectors(
        [...CATALOG_ITEM_FIELDS, 'extraField'],
        CATALOG_OPTION_GROUP_FIELDS,
      ),
    ).toThrow(/allowlist/i);
    expect(() =>
      resolveCatalogFieldSelectors(['name'], CATALOG_OPTION_GROUP_FIELDS),
    ).toThrow(/allowlist/i);
    expect(() =>
      resolveCatalogFieldSelectors(CATALOG_ITEM_FIELDS, [
        ...CATALOG_OPTION_GROUP_FIELDS,
        'extraGroupField',
      ]),
    ).toThrow(/allowlist/i);

    function traceFields(
      target: Record<string, unknown>,
      prefix: string,
      recorded: Set<string>,
      isLabelMap = false,
    ): Record<string, unknown> {
      return new Proxy(target, {
        get(obj, prop, receiver) {
          if (typeof prop === 'string') {
            const segment = isLabelMap ? '<label>' : prop;
            const path = prefix === '' ? segment : `${prefix}.${segment}`;
            recorded.add(path);
          }
          return Reflect.get(obj, prop, receiver) as unknown;
        },
        ownKeys(obj) {
          if (!isLabelMap) {
            throw new Error(`unexpected key iteration at ${prefix || 'root'}`);
          }
          return Reflect.ownKeys(obj);
        },
      });
    }

    const itemReads = new Set<string>();
    const itemFields = traceFields(
      {
        name: str('Synthetic Contract Item'),
        categoryId: str('cat-drop'),
        description: str('desc-drop'),
        imageUrl: str('https://example.invalid/drop.png'),
        name_lowercase: str('synthetic contract item'),
        pluCode: str('12345'),
        pricingType: str('fixed'),
        scaleSizeName: str('scale-drop'),
        weightedUnit: str('kg'),
        sizes: arr([
          {
            mapValue: {
              fields: traceFields(
                {
                  name: str('Large'),
                  price: dbl(99),
                  costPrice: dbl(40),
                  pricingBaseQuantity: int(1),
                  recipe: arr([]),
                },
                'sizes[]',
                itemReads,
              ),
            },
          },
        ]),
        options: {
          mapValue: {
            fields: traceFields(
              {
                'Synthetic Prep': arr([
                  {
                    mapValue: {
                      fields: traceFields(
                        {
                          value: str('Baked'),
                          price: dbl(15),
                          costPrice: dbl(5),
                          pricingBaseQuantity: int(1),
                          pricingType: str('fixed'),
                          recipe: arr([]),
                        },
                        'options.<label>[]',
                        itemReads,
                      ),
                    },
                  },
                ]),
              },
              'options',
              itemReads,
              true,
            ),
          },
        },
        sharedOptionGroupIds: {
          mapValue: {
            fields: traceFields(
              { 'Synthetic Prep': str('group-syn-prep') },
              'sharedOptionGroupIds',
              itemReads,
              true,
            ),
          },
        },
      },
      '',
      itemReads,
    );

    projectAllowedItemFields(itemFields);
    // Container keys (`sizes`, `options`, `sharedOptionGroupIds`) are read to reach leaf allowlist paths.
    const itemLeafReads = [...itemReads]
      .filter(
        (path) =>
          ![
            'sizes',
            'options',
            'sharedOptionGroupIds',
            'options.<label>',
          ].includes(path),
      )
      .sort();
    expect(itemLeafReads).toEqual([...CATALOG_ITEM_FIELDS].sort());

    const groupReads = new Set<string>();
    const groupFields = traceFields(
      {
        name: str('Synthetic Contract Group'),
        pricingType: str('fixed'),
        values: arr([
          {
            mapValue: {
              fields: traceFields(
                {
                  value: str('Roasted'),
                  price: dbl(20),
                  costPrice: dbl(6),
                  pricingBaseQuantity: int(1),
                  pricingType: str('fixed'),
                  recipe: arr([]),
                },
                'values[]',
                groupReads,
              ),
            },
          },
        ]),
      },
      '',
      groupReads,
    );
    projectAllowedOptionGroupFields(groupFields);
    const groupLeafReads = [...groupReads]
      .filter((path) => path !== 'values')
      .sort();
    expect(groupLeafReads).toEqual([...CATALOG_OPTION_GROUP_FIELDS].sort());

    // Whole-pipeline scalar read contract (reader + customer-key scan + parser):
    // wrap every scalar leaf value wrapper in a getter trap and prove only
    // allowlisted paths' scalar values are ever read.
    function traceScalar<K extends string, V>(
      kind: K,
      value: V,
      path: string,
      recorded: Set<string>,
    ): Record<K, V> {
      const wrapper = {} as Record<K, V>;
      Object.defineProperty(wrapper, kind, {
        enumerable: true,
        get() {
          recorded.add(path);
          return value;
        },
      });
      return wrapper;
    }

    const pipelineItemScalarReads = new Set<string>();
    const rawItemDoc = {
      name: `${DOC_ROOT}/items/item-syn-pipeline-contract`,
      updateTime: '2026-11-20T10:00:00Z',
      fields: {
        name: traceScalar(
          'stringValue',
          'Synthetic Pipeline Item',
          'name',
          pipelineItemScalarReads,
        ),
        categoryId: traceScalar(
          'stringValue',
          'cat-drop',
          'categoryId',
          pipelineItemScalarReads,
        ),
        syntheticLocation: traceScalar(
          'geoPointValue',
          { latitude: 0, longitude: 0 },
          'syntheticLocation',
          pipelineItemScalarReads,
        ),
        description: traceScalar(
          'stringValue',
          'desc-drop',
          'description',
          pipelineItemScalarReads,
        ),
        imageUrl: traceScalar(
          'stringValue',
          'https://example.invalid/drop.png',
          'imageUrl',
          pipelineItemScalarReads,
        ),
        name_lowercase: traceScalar(
          'stringValue',
          'synthetic pipeline item',
          'name_lowercase',
          pipelineItemScalarReads,
        ),
        pluCode: traceScalar(
          'stringValue',
          '90009',
          'pluCode',
          pipelineItemScalarReads,
        ),
        pricingType: traceScalar(
          'stringValue',
          'fixed',
          'pricingType',
          pipelineItemScalarReads,
        ),
        scaleSizeName: traceScalar(
          'stringValue',
          'scale-drop',
          'scaleSizeName',
          pipelineItemScalarReads,
        ),
        weightedUnit: traceScalar(
          'stringValue',
          'kg',
          'weightedUnit',
          pipelineItemScalarReads,
        ),
        sizes: arr([
          map({
            name: traceScalar(
              'stringValue',
              'Large',
              'sizes[].name',
              pipelineItemScalarReads,
            ),
            price: traceScalar(
              'doubleValue',
              199.5,
              'sizes[].price',
              pipelineItemScalarReads,
            ),
            costPrice: traceScalar(
              'doubleValue',
              85.25,
              'sizes[].costPrice',
              pipelineItemScalarReads,
            ),
            pricingBaseQuantity: traceScalar(
              'integerValue',
              '1',
              'sizes[].pricingBaseQuantity',
              pipelineItemScalarReads,
            ),
            recipe: arr([
              map({
                ingredientId: traceScalar(
                  'stringValue',
                  'ing-syn-1',
                  'sizes[].recipe[].ingredientId',
                  pipelineItemScalarReads,
                ),
                qty: traceScalar(
                  'doubleValue',
                  0.5,
                  'sizes[].recipe[].qty',
                  pipelineItemScalarReads,
                ),
              }),
            ]),
          }),
        ]),
        options: map({
          'Synthetic Prep': arr([
            map({
              value: traceScalar(
                'stringValue',
                'Baked',
                'options.<label>[].value',
                pipelineItemScalarReads,
              ),
              price: traceScalar(
                'doubleValue',
                20,
                'options.<label>[].price',
                pipelineItemScalarReads,
              ),
              costPrice: traceScalar(
                'doubleValue',
                5,
                'options.<label>[].costPrice',
                pipelineItemScalarReads,
              ),
              pricingBaseQuantity: traceScalar(
                'integerValue',
                '1',
                'options.<label>[].pricingBaseQuantity',
                pipelineItemScalarReads,
              ),
              pricingType: traceScalar(
                'stringValue',
                'fixed',
                'options.<label>[].pricingType',
                pipelineItemScalarReads,
              ),
              recipe: arr([
                map({
                  ingredientId: traceScalar(
                    'stringValue',
                    'ing-syn-2',
                    'options.<label>[].recipe[].ingredientId',
                    pipelineItemScalarReads,
                  ),
                }),
              ]),
            }),
          ]),
        }),
        sharedOptionGroupIds: map({
          'Synthetic Prep': traceScalar(
            'stringValue',
            'group-syn-pipeline',
            'sharedOptionGroupIds.<label>',
            pipelineItemScalarReads,
          ),
        }),
      },
    };

    const pipelineGroupScalarReads = new Set<string>();
    const rawGroupDoc = {
      name: `${DOC_ROOT}/optionGroups/group-syn-pipeline`,
      updateTime: '2026-11-20T09:00:00Z',
      fields: {
        name: traceScalar(
          'stringValue',
          'Synthetic Prep',
          'name',
          pipelineGroupScalarReads,
        ),
        values: arr([
          map({
            value: traceScalar(
              'stringValue',
              'Baked',
              'values[].value',
              pipelineGroupScalarReads,
            ),
            price: traceScalar(
              'doubleValue',
              20,
              'values[].price',
              pipelineGroupScalarReads,
            ),
            costPrice: traceScalar(
              'doubleValue',
              5,
              'values[].costPrice',
              pipelineGroupScalarReads,
            ),
            pricingBaseQuantity: traceScalar(
              'integerValue',
              '1',
              'values[].pricingBaseQuantity',
              pipelineGroupScalarReads,
            ),
            pricingType: traceScalar(
              'stringValue',
              'fixed',
              'values[].pricingType',
              pipelineGroupScalarReads,
            ),
            recipe: arr([
              map({
                ingredientId: traceScalar(
                  'stringValue',
                  'ing-syn-3',
                  'values[].recipe[].ingredientId',
                  pipelineGroupScalarReads,
                ),
              }),
            ]),
          }),
        ]),
      },
    };

    const itemPage = parseListResponse({ documents: [rawItemDoc] }, 'items');
    const groupPage = parseListResponse(
      { documents: [rawGroupDoc] },
      'optionGroups',
    );
    const pipelinePayload = parseCatalog(
      itemPage.documents,
      groupPage.documents,
    );
    expect(pipelinePayload.items).toHaveLength(1);
    expect(pipelinePayload.option_groups).toHaveLength(1);
    expect([...pipelineItemScalarReads].sort()).toEqual(
      [...CATALOG_ITEM_FIELDS].sort(),
    );
    expect([...pipelineGroupScalarReads].sort()).toEqual(
      [...CATALOG_OPTION_GROUP_FIELDS].sort(),
    );
  });

  it('does not read price, cost, or recipe scalar payloads under dynamic labels', () => {
    const marker = 'synthetic-unread-catalog-leaf';
    const reads: string[] = [];
    const protectedScalar = (field: string) => ({
      get stringValue() {
        reads.push(field);
        throw new Error(marker);
      },
    });
    const item = itemDoc('item-syn-unread-leaves', {
      name: str('Synthetic Catalog Item'),
      options: map({
        'Guest Specials': arr([
          map({
            value: str('Synthetic Add-on'),
            price: protectedScalar('price'),
            costPrice: protectedScalar('costPrice'),
            recipe: arr([map({ ingredientId: protectedScalar('recipe') })]),
          }),
        ]),
      }),
    });
    const result = parseCatalog([item], []);
    expect(result.items[0]?.item_option_groups).toEqual({
      'Guest Specials': ['Synthetic Add-on'],
    });
    expect(reads).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('rejects mixed scalar wrappers by their keys with an ID-only rejection without opening scalar payloads', () => {
    const marker = 'synthetic-mixed-scalar-marker';
    const reads: string[] = [];
    const mixedWithTrap = (field: string) => ({
      extraWrapperKey: null,
      get stringValue() {
        reads.push(field);
        throw new Error(marker);
      },
    });
    const itemWithConcealedCustomer = itemDoc('item-syn-mixed-customer', {
      name: str('Synthetic Concealed Customer'),
      options: map({
        'Guest Specials': arr([
          map({
            value: str('Synthetic Add-on'),
            price: {
              extraWrapperKey: null,
              stringValue: { customerName: 'syn-concealed-customer' },
            },
          }),
        ]),
      }),
    });
    const itemWithTrappedMixed = itemDoc('item-syn-mixed-trap', {
      name: str('Synthetic Trapped Mixed'),
      options: map({
        'Guest Specials': arr([
          map({
            value: str('Synthetic Add-on'),
            price: mixedWithTrap('price'),
          }),
        ]),
      }),
    });
    const groupWithConcealedCustomer = groupDoc('group-syn-mixed-customer', {
      name: str('Synthetic Mixed Group'),
      values: arr([
        map({
          value: str('Baked'),
          price: {
            extraWrapperKey: null,
            stringValue: { customerPhone: '01000000000' },
          },
        }),
      ]),
    });

    const itemPage = parseListResponse(
      { documents: [itemWithConcealedCustomer, itemWithTrappedMixed] },
      'items',
    );
    expect(itemPage.documents).toEqual([
      { name: itemWithConcealedCustomer.name, rejected: true },
      { name: itemWithTrappedMixed.name, rejected: true },
    ]);
    const groupPage = parseListResponse(
      { documents: [groupWithConcealedCustomer] },
      'optionGroups',
    );
    expect(groupPage.documents).toEqual([
      { name: groupWithConcealedCustomer.name, rejected: true },
    ]);

    const directPayload = parseCatalog(
      [itemWithConcealedCustomer, itemWithTrappedMixed],
      [groupWithConcealedCustomer],
    );
    expect(directPayload.items).toEqual([]);
    expect(directPayload.option_groups).toEqual([]);
    expect(directPayload.presence).toEqual([
      { pos_item_id: 'item-syn-mixed-customer', outcome: 'rejected' },
      { pos_item_id: 'item-syn-mixed-trap', outcome: 'rejected' },
    ]);
    expect(directPayload.option_group_presence).toEqual([
      { group_id: 'group-syn-mixed-customer', outcome: 'rejected' },
    ]);
    expect(reads).toEqual([]);
    expect(JSON.stringify({ itemPage, groupPage, directPayload })).not.toMatch(
      /syn-concealed-customer|01000000000|synthetic-mixed-scalar-marker/,
    );
  });

  it('rejects a dual-scalar wrapper in its own fixture with an ID-only rejection and zero getter calls', () => {
    const marker = 'synthetic-dual-scalar-marker';
    const reads: string[] = [];
    const dualScalarTrap = (label: string) => ({
      get integerValue() {
        reads.push(`${label}:integerValue`);
        throw new Error(marker);
      },
      get stringValue() {
        reads.push(`${label}:stringValue`);
        throw new Error(marker);
      },
    });
    const itemWithDualScalar = itemDoc('item-syn-dual-scalar-trap', {
      name: str('Synthetic Dual Scalar Item'),
      options: map({
        'Guest Specials': arr([
          map({
            value: str('Synthetic Add-on'),
            costPrice: dualScalarTrap('item'),
          }),
        ]),
      }),
    });
    const groupWithDualScalar = groupDoc('group-syn-dual-scalar-trap', {
      name: str('Synthetic Dual Scalar Group'),
      values: arr([
        map({
          value: str('Baked'),
          price: dualScalarTrap('group'),
        }),
      ]),
    });

    const itemPage = parseListResponse(
      { documents: [itemWithDualScalar] },
      'items',
    );
    expect(itemPage.documents).toEqual([
      { name: itemWithDualScalar.name, rejected: true },
    ]);
    const groupPage = parseListResponse(
      { documents: [groupWithDualScalar] },
      'optionGroups',
    );
    expect(groupPage.documents).toEqual([
      { name: groupWithDualScalar.name, rejected: true },
    ]);

    const directPayload = parseCatalog(
      [itemWithDualScalar],
      [groupWithDualScalar],
    );
    expect(directPayload.items).toEqual([]);
    expect(directPayload.option_groups).toEqual([]);
    expect(directPayload.presence).toEqual([
      { pos_item_id: 'item-syn-dual-scalar-trap', outcome: 'rejected' },
    ]);
    expect(directPayload.option_group_presence).toEqual([
      { group_id: 'group-syn-dual-scalar-trap', outcome: 'rejected' },
    ]);
    expect(reads).toEqual([]);
    expect(
      JSON.stringify({ itemPage, groupPage, directPayload }),
    ).not.toContain(marker);
  });

  it('rejects malformed map and array wrappers by their keys with an ID-only rejection and zero scalar reads', () => {
    const marker = 'synthetic-malformed-container-marker';
    const reads: string[] = [];
    const trappedScalar = (label: string) => ({
      get stringValue() {
        reads.push(label);
        throw new Error(marker);
      },
    });

    const malformedCases: Array<[string, Record<string, unknown>]> = [
      [
        'mixed-map',
        {
          extraWrapperKey: null,
          mapValue: {
            fields: { internalCode: trappedScalar('mixed-map') },
          },
        },
      ],
      [
        'mixed-array',
        {
          extraWrapperKey: null,
          arrayValue: {
            values: [
              {
                mapValue: {
                  fields: { internalCode: trappedScalar('mixed-array') },
                },
              },
            ],
          },
        },
      ],
      [
        'dual-container',
        {
          mapValue: { fields: { a: trappedScalar('dual-map') } },
          arrayValue: { values: [trappedScalar('dual-array')] },
        },
      ],
      [
        'map-extra-key',
        {
          mapValue: {
            extraMapKey: trappedScalar('map-extra-key'),
            fields: { internalCode: trappedScalar('map-extra-fields') },
          },
        },
      ],
      [
        'array-extra-key',
        {
          arrayValue: {
            extraArrKey: trappedScalar('array-extra-key'),
            values: [trappedScalar('array-extra-values')],
          },
        },
      ],
      [
        'bad-map-fields',
        {
          mapValue: {
            fields: [trappedScalar('bad-map-fields')],
          },
        },
      ],
      [
        'bad-array-values',
        {
          arrayValue: {
            values: { unexpected: trappedScalar('bad-array-values') },
          },
        },
      ],
    ];

    const itemDocs = malformedCases.map(([slug, malformed]) =>
      itemDoc(`item-syn-${slug}`, {
        name: str(`Synthetic ${slug} Item`),
        options: map({
          extras: arr([
            map({
              value: str('Synthetic Option'),
              costPrice: malformed,
            }),
          ]),
        }),
      }),
    );
    const groupDocs = malformedCases.map(([slug, malformed]) =>
      groupDoc(`group-syn-${slug}`, {
        name: str(`Synthetic ${slug} Group`),
        values: arr([
          map({
            value: str('Synthetic Value'),
            costPrice: malformed,
          }),
        ]),
      }),
    );

    const itemPage = parseListResponse({ documents: itemDocs }, 'items');
    expect(itemPage.documents).toEqual(
      itemDocs.map((doc) => ({ name: doc.name, rejected: true })),
    );
    const groupPage = parseListResponse(
      { documents: groupDocs },
      'optionGroups',
    );
    expect(groupPage.documents).toEqual(
      groupDocs.map((doc) => ({ name: doc.name, rejected: true })),
    );

    const directPayload = parseCatalog(itemDocs, groupDocs);
    expect(directPayload.items).toEqual([]);
    expect(directPayload.option_groups).toEqual([]);
    expect(directPayload.presence).toEqual(
      malformedCases
        .map(([slug]) => ({
          pos_item_id: `item-syn-${slug}`,
          outcome: 'rejected' as const,
        }))
        .sort((left, right) =>
          left.pos_item_id.localeCompare(right.pos_item_id),
        ),
    );
    expect(directPayload.option_group_presence).toEqual(
      malformedCases
        .map(([slug]) => ({
          group_id: `group-syn-${slug}`,
          outcome: 'rejected' as const,
        }))
        .sort((left, right) => left.group_id.localeCompare(right.group_id)),
    );
    expect(reads).toEqual([]);
    expect(
      JSON.stringify({ itemPage, groupPage, directPayload }),
    ).not.toContain(marker);
  });

  it('reports catalog allowlist drift without echoing the input selector', () => {
    expect(() =>
      resolveCatalogFieldSelectors(
        [...CATALOG_ITEM_FIELDS, 'SyntheticMarker7f3a'],
        CATALOG_OPTION_GROUP_FIELDS,
      ),
    ).toThrow(/^Catalog allowlist mismatch: unexpected item path$/);
  });

  it('accepts 15 and 20 nested Firestore maps during customer-key scan and rejects beyond the walk cap', () => {
    function nestedMap(levels: number): unknown {
      let current: unknown = str('leaf');
      for (let level = 0; level < levels; level += 1) {
        current = map({ next: current });
      }
      return current;
    }

    for (const levels of [15, 20]) {
      const id = `item-syn-nested-${levels}`;
      const page = parseListResponse(
        {
          documents: [
            itemDoc(id, {
              name: str(`Synthetic Nested ${levels}`),
              meta: nestedMap(levels),
            }),
          ],
        },
        'items',
      );
      const payload = parseCatalog(page.documents, []);
      expect(payload.presence, `levels=${levels}`).toEqual([
        { pos_item_id: id, outcome: 'accepted' },
      ]);
      expect(payload.items).toHaveLength(1);
    }

    const tooDeepId = 'item-syn-nested-too-deep';
    const tooDeepPage = parseListResponse(
      {
        documents: [
          itemDoc(tooDeepId, {
            name: str('Synthetic Too Deep'),
            meta: nestedMap(MAX_CATALOG_WALK_DEPTH + 1),
          }),
        ],
      },
      'items',
    );
    const tooDeepPayload = parseCatalog(tooDeepPage.documents, []);
    expect(tooDeepPayload.items).toEqual([]);
    expect(tooDeepPayload.presence).toEqual([
      { pos_item_id: tooDeepId, outcome: 'rejected' },
    ]);
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
      {
        items: { '[]': { item_option_groups: { price: 10 } } },
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
    const rawPage = parseListResponse(
      {
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
      },
      'items',
    );
    const rawGroupPage = parseListResponse(
      {
        documents: [
          {
            name: `${DOC_ROOT}/optionGroups/group-syn-raw-extra`,
            updateTime: '2026-11-20T09:00:00Z',
            fields: { name: str('Synthetic Group Extra') },
            contactMeta: { phone: '01111111111' },
          },
        ],
      },
      'optionGroups',
    );
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

  it('rejects impossible updateTime calendar dates and Unicode control characters in catalog ids while keeping order id compatibility', () => {
    for (const badTime of [
      '2026-02-30T10:00:00Z',
      '2025-02-29T10:00:00Z',
      '2026-04-31T10:00:00Z',
      '0000-01-01T00:00:00Z',
      '2026-10-15T24:00:00Z',
    ]) {
      expect(
        parseCatalogItemDocument(
          itemDoc(
            'item-syn-bad-time',
            { name: str('Synthetic Dish Bad Time') },
            badTime,
          ),
        ),
        badTime,
      ).toEqual({
        outcome: 'rejected',
        pos_item_id: 'item-syn-bad-time',
      });
      expect(
        parseCatalogOptionGroupDocument(
          groupDoc(
            'group-syn-bad-time',
            { name: str('Synthetic Group Bad Time') },
            badTime,
          ),
        ),
        badTime,
      ).toEqual({
        outcome: 'rejected',
        group_id: 'group-syn-bad-time',
      });
    }

    // Order path compatibility: a non-NUL control character in an order id still parses.
    const order = mapOrderDocument({
      name: `${DOC_ROOT}/orders/order\u0001compat`,
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
      },
    });
    expect(order.id).toBe('order\u0001compat');

    // Catalog ids reject C0, DEL, and C1 Unicode control characters (\p{Cc}).
    for (const control of ['\u0000', '\u0001', '\u007f', '\u0085']) {
      expect(() =>
        parseCatalog(
          [
            {
              name: `${DOC_ROOT}/items/item-syn${control}ctrl`,
              updateTime: '2026-11-20T10:00:00Z',
              fields: { name: str('Control Doc Id') },
            },
          ],
          [],
        ),
      ).toThrow();

      expect(
        parseCatalogItemDocument(
          itemDoc('item-syn-ctrl-shared', {
            name: str('Control Shared Group Id'),
            sharedOptionGroupIds: map({
              'Synthetic Prep': str(`group-syn${control}ctrl`),
            }),
          }),
        ),
      ).toEqual({
        outcome: 'rejected',
        pos_item_id: 'item-syn-ctrl-shared',
      });
    }
  });

  it('rejects catalog documents whose stored strings or labels contain U+0000', () => {
    const nulCases: Array<[string, FirestoreRestDocument]> = [
      [
        'item-syn-nul-name',
        itemDoc('item-syn-nul-name', { name: str('Dish\u0000Bad') }),
      ],
      [
        'item-syn-nul-size',
        itemDoc('item-syn-nul-size', {
          name: str('Dish'),
          sizes: arr([map({ name: str('Small\u0000X') })]),
        }),
      ],
      [
        'item-syn-nul-opt-label',
        itemDoc('item-syn-nul-opt-label', {
          name: str('Dish'),
          options: map({
            'Sauce\u0000Bad': arr([map({ value: str('Herb') })]),
          }),
        }),
      ],
      [
        'item-syn-nul-opt-val',
        itemDoc('item-syn-nul-opt-val', {
          name: str('Dish'),
          options: map({
            Sauce: arr([map({ value: str('Herb\u0000Bad') })]),
          }),
        }),
      ],
      [
        'item-syn-nul-shared-label',
        itemDoc('item-syn-nul-shared-label', {
          name: str('Dish'),
          sharedOptionGroupIds: map({
            'Prep\u0000Bad': str('group-syn-prep'),
          }),
        }),
      ],
    ];
    for (const [id, doc] of nulCases) {
      expect(parseCatalogItemDocument(doc), id).toEqual({
        outcome: 'rejected',
        pos_item_id: id,
      });
    }

    for (const [id, doc] of [
      [
        'group-syn-nul-name',
        groupDoc('group-syn-nul-name', { name: str('Group\u0000Bad') }),
      ],
      [
        'group-syn-nul-val',
        groupDoc('group-syn-nul-val', {
          name: str('Group'),
          values: arr([map({ value: str('Val\u0000Bad') })]),
        }),
      ],
    ] as const) {
      expect(parseCatalogOptionGroupDocument(doc), id).toEqual({
        outcome: 'rejected',
        group_id: id,
      });
    }
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
