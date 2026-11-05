import { describe, expect, it } from 'vitest';
import { coverageText, quantityError, sortBases } from '@/mapping/format';
import type { Coverage, ObservedBase } from '@/mapping/types';

function base(
  name: string,
  status: ObservedBase['mapStatus'],
  size = '["none"]',
): ObservedBase {
  return {
    posItemId: name,
    sizeKey: ['none'],
    sizeKeyText: size,
    itemName: name,
    saleCount: 1,
    lastOrderedAt: '2030-06-01T08:00:00.000Z',
    latestOrderId: 'order',
    latestLineId: 'line',
    mapStatus: status,
  };
}

function coverage(partial: Partial<Coverage>): Coverage {
  return {
    stockStart: null,
    eligibleLines: 0,
    coveredLines: 0,
    readyLines: 0,
    incompleteLines: 0,
    exceptionLines: 0,
    coverage: null,
    causes: { canceled: 0, open: 0, missing: 0, beforeStockStart: 0 },
    ...partial,
  };
}

describe('mapping list order and coverage', () => {
  it('puts unmapped subjects ahead of exceptions and ready rows', () => {
    const ordered = sortBases([
      base('جاهز', 'ready'),
      base('ناقص', 'incomplete'),
      base('استثناء', 'exception'),
    ]);
    expect(ordered.map((row) => row.itemName)).toEqual([
      'ناقص',
      'استثناء',
      'جاهز',
    ]);
  });

  it('shows an em dash when no line is eligible', () => {
    expect(coverageText(coverage({}))).toBe('—');
    expect(
      coverageText(
        coverage({
          eligibleLines: 4,
          coveredLines: 3,
          coverage: 0.75,
        }),
      ),
    ).toBe('3 من 4');
  });

  it('rejects a zero quantity and keeps a precise positive decimal', () => {
    expect(quantityError('0')).toBe('الكمية لازم تكون أكبر من صفر');
    expect(quantityError('1.000000000000000001')).toBeNull();
    expect(quantityError('1e2')).toBe('الكمية مش مظبوطة');
  });
});
