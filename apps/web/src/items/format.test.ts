import { describe, expect, it } from 'vitest';
import { formatEgp, formatQty } from '@/items/format';

describe('formatEgp', () => {
  it('lets Intl round values that a piaster Math.round mishandles', () => {
    expect(formatEgp(1.005)).toBe('1.01 ج.م');
    expect(formatEgp(2.675)).toBe('2.68 ج.م');
    expect(formatEgp(1.015)).toBe('1.02 ج.م');
    expect(formatEgp(0)).toBe('0.00 ج.م');
    expect(formatEgp(-0)).toBe('0.00 ج.م');
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
