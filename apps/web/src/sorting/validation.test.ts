import { describe, expect, it } from 'vitest';
import { missingCairoTimeMessage } from '@/purchases/time';
import {
  atLeastOneSizeMessage,
  notEnoughStockMessage,
  phoneMessage,
  quantityPositiveMessage,
  quantityScaleMessage,
  sizesExceedMessage,
} from '@/sorting/errors';
import type { MixedFish, SortValues } from '@/sorting/types';
import { assessSort } from '@/sorting/validation';

const mixed: MixedFish = {
  id: 'mixed',
  name: 'بوري مخلوط',
  onHandQty: '100',
  avgCost: '51.234567',
  hasUncoveredDeficit: false,
  sizes: [
    { id: 'large', name: 'كبير' },
    { id: 'small', name: 'وسط' },
  ],
};

function values(patch: Partial<SortValues> = {}): SortValues {
  return {
    occurredAt: '2026-07-15T12:00',
    mixedItemId: 'mixed',
    qtyTaken: '100',
    note: '',
    quantities: { large: '60', small: '38' },
    ...patch,
  };
}

describe('assessSort', () => {
  it('accepts Arabic-Indic digits and previews the loss', () => {
    const result = assessSort(
      values({
        qtyTaken: '١٠٠',
        quantities: { large: '٦٠', small: '٣٨' },
      }),
      [mixed],
    );
    expect(result.draft).toMatchObject({
      mixedItemId: 'mixed',
      qtyTaken: '100',
      note: null,
      lines: [
        { itemId: 'large', quantity: '60' },
        { itemId: 'small', quantity: '38' },
      ],
    });
    expect(result.draft?.occurredAt).toBe('2026-07-15T09:00:00.000Z');
    expect(result.preview).toMatchObject({ lossQty: '2', lossValue: '102.47' });
  });

  it('skips a blank size and rejects an explicit zero', () => {
    const blank = assessSort(
      values({ quantities: { large: '6', small: '   ' }, qtyTaken: '10' }),
      [{ ...mixed, onHandQty: '10' }],
    );
    expect(blank.draft?.lines).toEqual([{ itemId: 'large', quantity: '6' }]);
    expect(blank.preview?.lossQty).toBe('4');

    const zero = assessSort(
      values({ quantities: { large: '6', small: '0' }, qtyTaken: '10' }),
      [{ ...mixed, onHandQty: '10' }],
    );
    expect(zero.draft).toBeNull();
    expect(zero.errors.quantities.small).toBe(quantityPositiveMessage);
    expect(zero.preview).toBeNull();
  });

  it('rejects more than 6 decimal places, a phone number, and a missing size', () => {
    const scale = assessSort(values({ qtyTaken: '1.1234567' }), [mixed]);
    expect(scale.errors.qtyTaken).toBe(quantityScaleMessage);
    expect(scale.draft).toBeNull();

    const phone = assessSort(values({ note: '01001234567' }), [mixed]);
    expect(phone.errors.note).toBe(phoneMessage);

    const none = assessSort(values({ quantities: { large: '', small: '' } }), [
      mixed,
    ]);
    expect(none.errors.form).toBe(atLeastOneSizeMessage);
  });

  it('refuses sizes above the taken quantity and a take above the balance', () => {
    const overSizes = assessSort(
      values({ quantities: { large: '70', small: '40' } }),
      [mixed],
    );
    expect(overSizes.blockers.form).toBe(sizesExceedMessage);
    expect(overSizes.draft).toBeNull();
    expect(overSizes.preview?.sizesQty).toBe('110');

    const overStock = assessSort(values({ qtyTaken: '101' }), [mixed]);
    expect(overStock.blockers.qtyTaken).toBe(notEnoughStockMessage);
    expect(overStock.draft).toBeNull();

    const deficit = assessSort(values(), [
      { ...mixed, hasUncoveredDeficit: true },
    ]);
    expect(deficit.errors.qtyTaken).toBe(notEnoughStockMessage);
  });

  it('names a Cairo time that does not exist', () => {
    const result = assessSort(values({ occurredAt: '2027-04-30T00:30' }), [
      mixed,
    ]);
    expect(result.errors.occurredAt).toBe(missingCairoTimeMessage);
    expect(result.draft).toBeNull();
  });
});
