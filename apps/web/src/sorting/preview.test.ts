import { describe, expect, it } from 'vitest';
import { parseUserDecimal } from '@/purchases/decimal';
import { previewSort } from '@/sorting/preview';

function dec(text: string) {
  const parsed = parseUserDecimal(text);
  if (!parsed) throw new Error(text);
  return parsed;
}

describe('previewSort', () => {
  it('splits 100 kg into 60 and 38 with a 2 kg loss at an uneven average', () => {
    const preview = previewSort({
      qtyTaken: dec('100'),
      avgCost: dec('51.234567'),
      lines: [
        { itemId: 'large', quantity: dec('60') },
        { itemId: 'small', quantity: dec('38') },
      ],
    });
    expect(preview).toMatchObject({
      sizesQty: '98',
      lossQty: '2',
      lossValue: '102.47',
      costPerKg: '51.234567',
      sizesExceed: false,
    });
    expect(preview?.lines).toEqual([
      { itemId: 'large', quantity: '60', value: '3074.07' },
      { itemId: 'small', quantity: '38', value: '1946.91' },
    ]);
  });

  it('keeps a half kilogram when 10 becomes 6 and 3.5', () => {
    const preview = previewSort({
      qtyTaken: dec('10'),
      avgCost: dec('50'),
      lines: [
        { itemId: 'large', quantity: dec('6') },
        { itemId: 'small', quantity: dec('3.5') },
      ],
    });
    expect(preview).toMatchObject({
      sizesQty: '9.5',
      lossQty: '0.5',
      lossValue: '25.00',
      costPerKg: '50',
      sizesExceed: false,
    });
  });

  it('refuses a size total above the taken quantity', () => {
    const preview = previewSort({
      qtyTaken: dec('100'),
      avgCost: dec('50'),
      lines: [
        { itemId: 'large', quantity: dec('70') },
        { itemId: 'small', quantity: dec('40') },
      ],
    });
    expect(preview).toMatchObject({
      sizesQty: '110',
      lossQty: null,
      lossValue: null,
      sizesExceed: true,
    });
  });
});
