import { describe, expect, it } from 'vitest';
import {
  cairoDateIso,
  formatCairo,
  formatIsoDate,
  formatMonth,
  monthEndIso,
} from '@/lib/cairo';

describe('formatCairo', () => {
  it('shows Africa/Cairo as a date and a 24-hour time', () => {
    expect(formatCairo('2026-10-15T09:00:00.000Z')).toBe('15/10/2026 12:00');
  });
});

describe('Cairo calendar dates', () => {
  it('keeps the Cairo date across midnight UTC', () => {
    expect(cairoDateIso(new Date('2026-10-15T09:00:00.000Z'))).toBe(
      '2026-10-15',
    );
    expect(cairoDateIso(new Date('2026-10-15T22:30:00.000Z'))).toBe(
      '2026-10-16',
    );
  });

  it('formats a date-only string without shifting the day', () => {
    expect(formatIsoDate('2030-04-03')).toBe('03/04/2030');
  });

  it('names the month in Arabic', () => {
    expect(formatMonth('2030-04-01')).toBe('أبريل 2030');
  });

  it('uses the real length of the month, including a leap February', () => {
    expect(monthEndIso('2030-04-01')).toBe('2030-04-30');
    expect(monthEndIso('2026-01-01')).toBe('2026-01-31');
    expect(monthEndIso('2026-02-01')).toBe('2026-02-28');
    expect(monthEndIso('2024-02-01')).toBe('2024-02-29');
  });
});
