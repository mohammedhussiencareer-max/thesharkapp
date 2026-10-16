import { describe, expect, it } from 'vitest';
import {
  lossPercentToFraction,
  parseLossPercent,
  validateItemForm,
  type ItemFormValues,
} from '@/items/validation';

const mixed = {
  id: 'mixed',
  kind: 'fish_mixed' as const,
  parentItemId: null,
};

function values(overrides: Partial<ItemFormValues> = {}): ItemFormValues {
  return {
    name: 'جمبري',
    kind: 'seafood',
    baseUnit: 'kg',
    countFrequency: 'weekly',
    lossPercent: '0',
    parentItemId: '',
    active: true,
    ...overrides,
  };
}

describe('loss percent', () => {
  it('stores 12.5% as the fraction 0.125', () => {
    expect(parseLossPercent('12.5')).toBe(12.5);
    expect(lossPercentToFraction(12.5)).toBe(0.125);
  });

  it('stores 99.999% inside the database fraction limit', () => {
    expect(lossPercentToFraction(99.999)).toBe(0.99999);
  });

  it('accepts a comma decimal and rejects 100', () => {
    expect(parseLossPercent('12,5')).toBe(12.5);
    expect(parseLossPercent('100')).toBeNull();
    expect(parseLossPercent('')).toBeNull();
  });
});

describe('validateItemForm', () => {
  it('requires a fish_mixed parent for a fish size', () => {
    const missing = validateItemForm(
      values({ kind: 'fish_size', countFrequency: 'daily', name: 'كبير' }),
      { items: [mixed] },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.parentItemId).toBe('اختار السمك المخلوط');
    }

    const saved = validateItemForm(
      values({
        kind: 'fish_size',
        countFrequency: 'daily',
        name: 'كبير',
        parentItemId: 'mixed',
        lossPercent: '12.5',
      }),
      { items: [mixed] },
    );
    expect(saved).toEqual({
      ok: true,
      draft: {
        name: 'كبير',
        kind: 'fish_size',
        baseUnit: 'kg',
        countFrequency: 'daily',
        lossPct: 0.125,
        parentItemId: 'mixed',
        active: true,
      },
    });
  });
});
