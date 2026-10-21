import { describe, expect, it } from 'vitest';
import { formatLineQty } from '@/sales/format';

describe('formatLineQty', () => {
  it('shows a fixed quantity or a weight with its unit', () => {
    expect(
      formatLineQty({
        quantity: '2.000000',
        weightedQty: null,
        weightedUnit: null,
      }),
    ).toBe('2');
    expect(
      formatLineQty({
        quantity: '1.000000',
        weightedQty: '1.250000',
        weightedUnit: 'كيلو',
      }),
    ).toBe('1.25 كيلو');
  });
});
