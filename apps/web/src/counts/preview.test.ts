import { describe, expect, it } from 'vitest';
import { parseUserDecimal } from '@/purchases/decimal';
import { previewCount } from '@/counts/preview';

function dec(raw: string) {
  const parsed = parseUserDecimal(raw);
  if (!parsed) throw new Error(`not a decimal: ${raw}`);
  return parsed;
}

const book = {
  itemId: 'fish',
  onHand: dec('10'),
  onHandValue: dec('100.00'),
  avg: dec('10.05'),
};

describe('previewCount', () => {
  it('prices a shortage from the book value, not the average', () => {
    const preview = previewCount([{ ...book, counted: dec('7') }]);
    expect(preview).toMatchObject({
      shortageValue: '30.00',
      surplusValue: '0.00',
      hasSurplus: false,
      lines: [
        {
          itemId: 'fish',
          deltaQty: '-3',
          deltaValue: '-30.00',
          surplus: false,
        },
      ],
    });
  });

  it('takes the whole book value when the count clears the on-hand', () => {
    const preview = previewCount([{ ...book, counted: dec('0') }]);
    expect(preview?.lines[0]).toMatchObject({
      deltaQty: '-10',
      deltaValue: '-100.00',
      surplus: false,
    });
    expect(preview?.shortageValue).toBe('100.00');
  });

  it('prices a surplus at the average and flags it even when the value is zero', () => {
    const surplus = previewCount([{ ...book, counted: dec('12') }]);
    expect(surplus).toMatchObject({
      shortageValue: '0.00',
      surplusValue: '20.10',
      hasSurplus: true,
      lines: [{ deltaQty: '2', deltaValue: '20.10', surplus: true }],
    });

    const free = previewCount([
      {
        itemId: 'empty',
        counted: dec('1'),
        onHand: dec('0'),
        onHandValue: dec('0.00'),
        avg: dec('0'),
      },
    ]);
    expect(free).toMatchObject({
      surplusValue: '0.00',
      hasSurplus: true,
      lines: [{ deltaQty: '1', deltaValue: '0.00', surplus: true }],
    });
  });

  it('shows a zero delta as zero money', () => {
    const preview = previewCount([{ ...book, counted: dec('10') }]);
    expect(preview?.lines[0]).toMatchObject({
      deltaQty: '0',
      deltaValue: '0.00',
      surplus: false,
    });
  });
});
