import { describe, expect, it } from 'vitest';
import {
  fixedLineTotal,
  moneyFromNumber,
  quantityFromNumber,
} from './decimal.ts';

describe('money rounding', () => {
  it('rounds half away from zero to the piaster', () => {
    expect(moneyFromNumber(1.005)).toBe('1.01');
    expect(moneyFromNumber(1.004)).toBe('1.00');
    expect(moneyFromNumber(-1.005)).toBe('-1.01');
    expect(moneyFromNumber(10)).toBe('10.00');
    expect(moneyFromNumber(0.335)).toBe('0.34');
  });

  it('multiplies fixed lines in decimal before rounding', () => {
    expect(fixedLineTotal('0.335', '3')).toBe('1.01');
    expect(fixedLineTotal('0.1', '3')).toBe('0.30');
    expect(fixedLineTotal('10', '2')).toBe('20.00');
    expect(fixedLineTotal('2', '1.23456789')).toBe('2.47');
    expect(fixedLineTotal('999', '999')).toBe('998001.00');
  });

  it('keeps quantity precision to six places', () => {
    expect(quantityFromNumber(1.23456789)).toBe('1.234568');
    expect(quantityFromNumber(2)).toBe('2');
    expect(quantityFromNumber(1.23)).toBe('1.23');
  });
});
