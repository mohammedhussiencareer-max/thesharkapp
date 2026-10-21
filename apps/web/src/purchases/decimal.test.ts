import { describe, expect, it } from 'vitest';
import {
  divRound,
  formatDec,
  formatMoneyText,
  moneyWire,
  mulRound,
  parseUserDecimal,
  toWesternDigits,
} from '@/purchases/decimal';

describe('purchase decimals', () => {
  it('converts Arabic-Indic and Eastern Arabic-Indic digits', () => {
    expect(toWesternDigits('٥٠٫٢٥')).toBe('50.25');
    expect(toWesternDigits('۵۰')).toBe('50');
    expect(parseUserDecimal(' ٢٫٥ ')).toEqual({
      neg: false,
      int: 25n,
      scale: 1,
    });
    expect(parseUserDecimal('2,50')).toEqual({
      neg: false,
      int: 250n,
      scale: 2,
    });
    expect(parseUserDecimal('2,5.0')).toBeNull();
    expect(parseUserDecimal('-1')).toMatchObject({ neg: true, int: 1n });
  });

  it('rounds half away from zero the way PostgreSQL numeric does', () => {
    const quantity = parseUserDecimal('2');
    const factor = parseUserDecimal('0.92');
    const amount = parseUserDecimal('50');
    expect(quantity && factor && amount).toBeTruthy();
    if (!quantity || !factor || !amount) return;
    const base = mulRound(quantity, factor, 6);
    expect(formatDec(base)).toBe('1.84');
    const cost = divRound(amount, base, 6);
    expect(cost && formatDec(cost)).toBe('27.173913');
  });

  it('writes money as an exact two-decimal string', () => {
    const amount = parseUserDecimal('50');
    const piasters = parseUserDecimal('10.5');
    const tooFine = parseUserDecimal('10.005');
    expect(amount && moneyWire(amount)).toBe('50.00');
    expect(piasters && moneyWire(piasters)).toBe('10.50');
    expect(tooFine && moneyWire(tooFine)).toBeNull();
    const negative = parseUserDecimal('-1');
    expect(negative && moneyWire(negative)).toBeNull();
    expect(formatMoneyText('50.00')).toBe('50.00 ج.م');
    expect(formatMoneyText('27.173913')).toBe('27.173913 ج.م');
  });
});
