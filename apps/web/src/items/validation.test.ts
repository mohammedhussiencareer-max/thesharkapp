import { describe, expect, it } from 'vitest';
import {
  lossPercentToFraction,
  parseLossPercent,
  validateConversion,
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

  it('rejects a percent whose fraction needs more than 5 decimals', () => {
    expect(parseLossPercent('12.3456')).toBeNull();
    const result = validateItemForm(values({ lossPercent: '12.3456' }), {
      items: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.lossPercent).toBe(
        'نسبة الفاقد مينفعش تتخزن أدق من خمس خانات عشرية',
      );
    }
    expect(parseLossPercent('12.345')).toBe(12.345);
    expect(lossPercentToFraction(12.345)).toBe(0.12345);
  });
});

describe('validateConversion', () => {
  it('rejects factors outside numeric(18,9)', () => {
    expect(validateConversion('كيس', '1234567890', 'kg')).toEqual({
      ok: false,
      error: 'معامل التحويل مينفعش يبقى فيه أكتر من 9 أرقام قبل العلامة',
    });
    expect(validateConversion('كيس', '1.1234567891', 'kg')).toEqual({
      ok: false,
      error: 'معامل التحويل مينفعش يبقى فيه أكتر من 9 أرقام بعد العلامة',
    });
    expect(validateConversion('كيس', '0', 'kg')).toEqual({
      ok: false,
      error: 'معامل التحويل لازم يكون رقم أكبر من صفر',
    });
    const accepted = validateConversion('كيس', '123456789.123456789', 'kg');
    expect(accepted).toEqual({
      ok: true,
      unit: 'كيس',
      factor: Number('123456789.123456789'),
    });
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
