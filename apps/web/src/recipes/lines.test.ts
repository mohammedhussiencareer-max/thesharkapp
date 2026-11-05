import { describe, expect, it } from 'vitest';
import {
  childUnitChoices,
  itemAllowed,
  itemTarget,
  itemUnitChoices,
  linesFromVersion,
  massChoices,
  metricChoices,
  newLine,
  parseTarget,
  recipeTarget,
  validateBatch,
  validateLines,
  type LineDraft,
} from '@/recipes/lines';
import type {
  BatchOption,
  RecipeVersion,
  StockOption,
  UnitMeta,
} from '@/recipes/types';

const units: UnitMeta[] = [
  { code: 'kg', labelAr: 'كيلو', dimension: 'mass', metricScale: 1000 },
  { code: 'g', labelAr: 'جرام', dimension: 'mass', metricScale: 1 },
  { code: 'liter', labelAr: 'لتر', dimension: 'volume', metricScale: 1000 },
  { code: 'ml', labelAr: 'مللي', dimension: 'volume', metricScale: 1 },
  { code: 'piece', labelAr: 'قطعة', dimension: 'count', metricScale: null },
  { code: 'كيس', labelAr: 'كيس', dimension: 'custom', metricScale: null },
];

function stock(kind: StockOption['kind']): StockOption {
  return { id: kind, name: kind, kind, baseUnit: 'kg', active: true };
}

function draft(overrides: Partial<LineDraft>): LineDraft {
  return {
    key: 'k',
    target: itemTarget('oil'),
    quantity: '1',
    unit: 'kg',
    ...overrides,
  };
}

describe('targets', () => {
  it('round-trips item and recipe targets', () => {
    expect(parseTarget(itemTarget('a'))).toEqual({ kind: 'item', id: 'a' });
    expect(parseTarget(recipeTarget('b'))).toEqual({
      kind: 'recipe',
      id: 'b',
    });
  });

  it('rejects an empty or unknown target', () => {
    expect(parseTarget('')).toBeNull();
    expect(parseTarget('item:')).toBeNull();
    expect(parseTarget('other:1')).toBeNull();
  });
});

describe('itemAllowed', () => {
  it('never offers packaging or mixed fish', () => {
    for (const kind of ['dish', 'cooking', 'batch'] as const) {
      expect(itemAllowed(stock('packaging'), kind)).toBe(false);
      expect(itemAllowed(stock('fish_mixed'), kind)).toBe(false);
    }
  });

  it('keeps marine items out of a cooking recipe only', () => {
    for (const kind of ['seafood', 'fish_size'] as const) {
      expect(itemAllowed(stock(kind), 'cooking')).toBe(false);
      expect(itemAllowed(stock(kind), 'dish')).toBe(true);
      expect(itemAllowed(stock(kind), 'batch')).toBe(true);
    }
    expect(itemAllowed(stock('ingredient'), 'cooking')).toBe(true);
  });
});

describe('unit choices', () => {
  it('lists the units the item can be measured in', () => {
    expect(
      itemUnitChoices('a', [
        { itemId: 'a', unit: 'kg', label: 'كيلو' },
        { itemId: 'b', unit: 'g', label: 'جرام' },
        { itemId: 'a', unit: 'كيس', label: 'كيس' },
      ]),
    ).toEqual([
      { code: 'kg', label: 'كيلو' },
      { code: 'كيس', label: 'كيس' },
    ]);
  });

  it('offers the unit itself plus same-dimension metric units', () => {
    expect(metricChoices('kg', units).map((choice) => choice.code)).toEqual([
      'kg',
      'g',
    ]);
    expect(metricChoices('ml', units).map((choice) => choice.code)).toEqual([
      'ml',
      'liter',
    ]);
  });

  it('offers only the unit for a non-metric unit', () => {
    expect(metricChoices('كيس', units)).toEqual([
      { code: 'كيس', label: 'كيس' },
    ]);
    expect(metricChoices('piece', units)).toEqual([
      { code: 'piece', label: 'قطعة' },
    ]);
  });

  it('lists only metric mass units for a cooking output', () => {
    expect(massChoices(units).map((choice) => choice.code)).toEqual([
      'kg',
      'g',
    ]);
  });
});

describe('batch child units', () => {
  const child: BatchOption = {
    id: 'sauce',
    name: 'صلصة',
    active: true,
    versions: [
      {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2026-06-01T00:00:00.000Z',
        unit: 'liter',
      },
      {
        effectiveFrom: '2026-06-01T00:00:00.000Z',
        effectiveTo: null,
        unit: 'kg',
      },
    ],
  };

  it('uses the batch unit in force at the chosen instant', () => {
    expect(
      childUnitChoices(
        child,
        Date.parse('2026-03-01T00:00:00.000Z'),
        units,
      ).map((choice) => choice.code),
    ).toEqual(['liter', 'ml']);
    expect(
      childUnitChoices(
        child,
        Date.parse('2026-07-01T00:00:00.000Z'),
        units,
      ).map((choice) => choice.code),
    ).toEqual(['kg', 'g']);
  });

  it('falls back to the latest version inside a gap', () => {
    const gapped: BatchOption = {
      ...child,
      versions: [
        {
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: '2026-02-01T00:00:00.000Z',
          unit: 'liter',
        },
      ],
    };
    expect(
      childUnitChoices(
        gapped,
        Date.parse('2026-05-01T00:00:00.000Z'),
        units,
      ).map((choice) => choice.code),
    ).toEqual(['liter', 'ml']);
  });

  it('offers nothing for an unknown child or one without a version', () => {
    expect(childUnitChoices(undefined, 0, units)).toEqual([]);
    expect(childUnitChoices({ ...child, versions: [] }, 0, units)).toEqual([]);
  });
});

describe('linesFromVersion', () => {
  it('turns saved lines into drafts with distinct keys', () => {
    const version: RecipeVersion = {
      id: 'v1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      batchQty: null,
      batchUnit: null,
      lines: [
        {
          id: 'l1',
          stockItemId: 'oil',
          childRecipeId: null,
          quantity: '0.25',
          unit: 'liter',
        },
        {
          id: 'l2',
          stockItemId: null,
          childRecipeId: 'sauce',
          quantity: '2',
          unit: 'kg',
        },
      ],
    };
    const drafts = linesFromVersion(version);
    expect(drafts.map((line) => line.target)).toEqual([
      'item:oil',
      'recipe:sauce',
    ]);
    expect(drafts.map((line) => line.quantity)).toEqual(['0.25', '2']);
    expect(new Set(drafts.map((line) => line.key)).size).toBe(2);
    expect(linesFromVersion(null)).toEqual([]);
  });

  it('starts a new line empty', () => {
    expect(newLine()).toMatchObject({ target: '', quantity: '', unit: '' });
    expect(newLine().key).not.toBe(newLine().key);
  });
});

describe('validateLines', () => {
  it('asks for at least one ingredient', () => {
    expect(validateLines([])).toEqual({
      ok: false,
      error: 'ضيف مكوّن واحد على الأقل أو وقّف الوصفة من الوقت ده',
    });
  });

  it('builds wire lines with normalized decimal text', () => {
    expect(
      validateLines([
        draft({ quantity: ' 0,250 ' }),
        draft({ target: recipeTarget('sauce'), quantity: '3', unit: 'g' }),
      ]),
    ).toEqual({
      ok: true,
      lines: [
        { stock_item_id: 'oil', quantity: '0.25', unit: 'kg' },
        { child_recipe_id: 'sauce', quantity: '3', unit: 'g' },
      ],
    });
  });

  it('keeps full precision', () => {
    const result = validateLines([draft({ quantity: '0.123456789012' })]);
    expect(result).toMatchObject({
      ok: true,
      lines: [{ quantity: '0.123456789012' }],
    });
  });

  it('names the failing row for a missing target, quantity or unit', () => {
    expect(validateLines([draft({}), draft({ target: '' })])).toEqual({
      ok: false,
      error: 'سطر 2: اختار الصنف أو التحضيرة',
    });
    expect(validateLines([draft({ quantity: '' })])).toEqual({
      ok: false,
      error: 'سطر 1: الكمية لازم تكون رقم أكبر من صفر',
    });
    expect(validateLines([draft({ unit: '' })])).toEqual({
      ok: false,
      error: 'سطر 1: اختار الوحدة',
    });
  });

  it.each(['0', '0.000', '-1', '1e3', 'abc', '1.', '.5'])(
    'rejects the quantity %s',
    (quantity) => {
      expect(validateLines([draft({ quantity })])).toMatchObject({
        ok: false,
        error: 'سطر 1: الكمية لازم تكون رقم أكبر من صفر',
      });
    },
  );
});

describe('validateBatch', () => {
  it('accepts a positive quantity with a unit', () => {
    expect(validateBatch('2,5', 'kg')).toEqual({
      ok: true,
      batchQty: '2.5',
      batchUnit: 'kg',
    });
  });

  it('rejects zero, junk, and a missing unit', () => {
    expect(validateBatch('0', 'kg')).toMatchObject({ ok: false });
    expect(validateBatch('x', 'kg')).toMatchObject({ ok: false });
    expect(validateBatch('', 'kg')).toMatchObject({ ok: false });
    expect(validateBatch('1', '')).toEqual({
      ok: false,
      error: 'اختار وحدة التحضيرة',
    });
  });
});
