import { describe, expect, it } from 'vitest';
import {
  addMoney,
  formatEgpText,
  moneyAbsAtMost,
  toPiasters,
} from '@/lib/money';

describe('money text', () => {
  it('adds decimal strings in piasters', () => {
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(addMoney('10.00', '0.01')).toBe('10.01');
    expect(addMoney('40.00', '-40.00')).toBe('0.00');
  });

  it('formats an exact EGP string', () => {
    expect(formatEgpText('210')).toBe('210.00 ج.م');
    expect(formatEgpText('-1.50')).toBe('-1.50 ج.م');
  });

  it('treats one piaster as the match limit', () => {
    expect(moneyAbsAtMost('0.01', 1n)).toBe(true);
    expect(moneyAbsAtMost('-0.01', 1n)).toBe(true);
    expect(moneyAbsAtMost('0.02', 1n)).toBe(false);
  });

  it('rejects a JSON number and extra fraction digits', () => {
    expect(() => toPiasters('1.005')).toThrow('مبلغ غير صالح');
  });
});
