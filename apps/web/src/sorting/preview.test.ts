import { describe, expect, it } from 'vitest';
import {
  divRound,
  moneyWire,
  mulRound,
  parseUserDecimal,
  type Dec,
} from '@/purchases/decimal';
import { previewSort } from '@/sorting/preview';

function dec(text: string) {
  const parsed = parseUserDecimal(text);
  if (!parsed) throw new Error(text);
  return parsed;
}

function wire(value: Dec | null): string {
  if (!value) throw new Error('missing money');
  const text = moneyWire(value);
  if (!text) throw new Error('money');
  return text;
}

function mul(left: Dec, right: Dec): Dec {
  return {
    neg: false,
    int: left.int * right.int,
    scale: left.scale + right.scale,
  };
}

function sameQty(left: Dec, right: Dec): boolean {
  const scale = Math.max(left.scale, right.scale);
  return (
    left.int * 10n ** BigInt(scale - left.scale) ===
    right.int * 10n ** BigInt(scale - right.scale)
  );
}

/** The book value post_sort takes, independent of the preview. */
function takenValue(
  onHandQty: string,
  onHandValue: string,
  qtyTaken: string,
): string {
  const onHand = dec(onHandQty);
  const book = dec(onHandValue);
  const taken = dec(qtyTaken);
  if (sameQty(taken, onHand)) return wire(book);
  return wire(divRound(mul(book, taken), onHand, 2));
}

function sumMoney(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) {
    const parsed = dec(value);
    total += parsed.int * 10n ** BigInt(2 - parsed.scale);
  }
  const text = total.toString().padStart(3, '0');
  return `${text.slice(0, -2).replace(/^0+(?=\d)/, '') || '0'}.${text.slice(-2)}`;
}

describe('previewSort', () => {
  it('rounds the taken value before the loss, so 0.5 kg of 50.06 is 25.00', () => {
    const preview = previewSort({
      qtyTaken: dec('1.001'),
      avgCost: dec('50.01'),
      onHandQty: dec('100'),
      onHandValue: dec('5001.00'),
      lines: [{ itemId: 'large', quantity: dec('0.501') }],
    });
    expect(preview).toMatchObject({
      sizesQty: '0.501',
      lossQty: '0.5',
      lossValue: '25.00',
      costPerKg: '50.01',
      sizesExceed: false,
    });
    expect(preview?.lines).toEqual([
      { itemId: 'large', quantity: '0.501', value: '25.06' },
    ]);
    expect(sumMoney(['25.00', '25.06'])).toBe('50.06');
  });

  it('splits 100 kg into 60 and 38 with a 2 kg loss', () => {
    const even = previewSort({
      qtyTaken: dec('100'),
      avgCost: dec('50'),
      onHandQty: dec('100'),
      onHandValue: dec('5000.00'),
      lines: [
        { itemId: 'large', quantity: dec('60') },
        { itemId: 'small', quantity: dec('38') },
      ],
    });
    expect(even).toMatchObject({
      sizesQty: '98',
      lossQty: '2',
      lossValue: '100.00',
      costPerKg: '50',
      sizesExceed: false,
    });
    expect(even?.lines).toEqual([
      { itemId: 'large', quantity: '60', value: '3000.00' },
      { itemId: 'small', quantity: '38', value: '1900.00' },
    ]);

    const uneven = previewSort({
      qtyTaken: dec('100'),
      avgCost: dec('51.234567'),
      onHandQty: dec('100'),
      onHandValue: dec('5123.46'),
      lines: [
        { itemId: 'large', quantity: dec('60') },
        { itemId: 'small', quantity: dec('38') },
      ],
    });
    expect(uneven).toMatchObject({
      lossQty: '2',
      lossValue: '102.47',
      costPerKg: '51.234567',
    });
    expect(uneven?.lines).toEqual([
      { itemId: 'large', quantity: '60', value: '3074.08' },
      { itemId: 'small', quantity: '38', value: '1946.91' },
    ]);
  });

  it('gives the remainder piaster to the last size', () => {
    const preview = previewSort({
      qtyTaken: dec('3'),
      avgCost: dec('0.333333'),
      onHandQty: dec('3'),
      onHandValue: dec('1.00'),
      lines: [
        { itemId: 'large', quantity: dec('1') },
        { itemId: 'small', quantity: dec('1') },
      ],
    });
    expect(preview).toMatchObject({
      lossQty: '1',
      lossValue: '0.33',
    });
    expect(preview?.lines).toEqual([
      { itemId: 'large', quantity: '1', value: '0.34' },
      { itemId: 'small', quantity: '1', value: '0.33' },
    ]);
    expect(
      sumMoney([
        preview?.lossValue ?? '',
        ...(preview?.lines.map((line) => line.value) ?? []),
      ]),
    ).toBe('1.00');
  });

  it('keeps the size values and the loss equal to the taken value', () => {
    const averages = [
      '1',
      '10',
      '50',
      '50.01',
      '51.234567',
      '0.015',
      '99.999999',
    ];
    for (const avg of averages) {
      const book = wire(mulRound(dec('100'), dec(avg), 2));
      const full = previewSort({
        qtyTaken: dec('100'),
        avgCost: dec(avg),
        onHandQty: dec('100'),
        onHandValue: dec(book),
        lines: [
          { itemId: 'large', quantity: dec('60') },
          { itemId: 'small', quantity: dec('38') },
        ],
      });
      expect(full?.lossValue).toBeTruthy();
      expect(
        sumMoney([
          full?.lossValue ?? '',
          ...(full?.lines.map((line) => line.value) ?? []),
        ]),
      ).toBe(takenValue('100', book, '100'));

      const partial = previewSort({
        qtyTaken: dec('1.001'),
        avgCost: dec(avg),
        onHandQty: dec('100'),
        onHandValue: dec(book),
        lines: [{ itemId: 'large', quantity: dec('0.501') }],
      });
      expect(
        sumMoney([
          partial?.lossValue ?? '',
          ...(partial?.lines.map((line) => line.value) ?? []),
        ]),
      ).toBe(takenValue('100', book, '1.001'));

      const threeBook = mulRound(dec('7'), dec(avg), 2);
      const three = previewSort({
        qtyTaken: dec('7'),
        avgCost: dec(avg),
        onHandQty: dec('7'),
        onHandValue: threeBook,
        lines: [
          { itemId: 'a', quantity: dec('2') },
          { itemId: 'b', quantity: dec('2') },
          { itemId: 'c', quantity: dec('2') },
        ],
      });
      expect(
        sumMoney([
          three?.lossValue ?? '',
          ...(three?.lines.map((line) => line.value) ?? []),
        ]),
      ).toBe(takenValue('7', wire(threeBook), '7'));
    }
  });

  it('keeps a half kilogram when 10 becomes 6 and 3.5', () => {
    const preview = previewSort({
      qtyTaken: dec('10'),
      avgCost: dec('50'),
      onHandQty: dec('10'),
      onHandValue: dec('500'),
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
    expect(preview?.lines).toEqual([
      { itemId: 'large', quantity: '6', value: '300.00' },
      { itemId: 'small', quantity: '3.5', value: '175.00' },
    ]);
  });

  it('refuses a size total above the taken quantity', () => {
    const preview = previewSort({
      qtyTaken: dec('100'),
      avgCost: dec('50'),
      onHandQty: dec('100'),
      onHandValue: dec('5000.00'),
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
