import { describe, expect, it } from 'vitest';
import { formatEgp, formatQty, formatStoredFactor } from '@/items/format';

describe('formatEgp', () => {
  it('lets Intl round values that a piaster Math.round mishandles', () => {
    expect(formatEgp(1.005)).toBe('1.01 ج.م');
    expect(formatEgp(2.675)).toBe('2.68 ج.م');
    expect(formatEgp(1.015)).toBe('1.02 ج.م');
    expect(formatEgp(0)).toBe('0.00 ج.م');
    expect(formatEgp(-0)).toBe('0.00 ج.م');
  });
});

describe('formatStoredFactor', () => {
  it('trims trailing zeros and keeps every significant digit', () => {
    expect(formatStoredFactor('0.007500000')).toBe('0.0075');
    expect(formatStoredFactor('0.0001')).toBe('0.0001');
    expect(formatStoredFactor('25.000000000')).toBe('25');
    expect(formatStoredFactor('12345678.123456789')).toBe('12345678.123456789');
  });
});

describe('formatQty', () => {
  it('lets Intl round the third decimal', () => {
    expect(formatQty(0.5005)).toBe('0.501');
    expect(formatQty(1.5)).toBe('1.5');
    expect(formatQty(0)).toBe('0');
    expect(formatQty(-0)).toBe('0');
  });
});
