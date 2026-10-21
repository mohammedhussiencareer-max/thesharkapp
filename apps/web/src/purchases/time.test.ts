import { describe, expect, it } from 'vitest';
import {
  cairoDateStartIso,
  cairoDateTimeLocalToIso,
  cairoNextDateStartIso,
  dateRangeError,
  formatCairoDateTime,
} from '@/purchases/time';

describe('Cairo time', () => {
  it('reads a datetime-local value as Africa/Cairo, including the 2026 offset change', () => {
    expect(cairoDateTimeLocalToIso('2026-01-15T12:00')).toBe(
      '2026-01-15T10:00:00.000Z',
    );
    expect(cairoDateTimeLocalToIso('2026-07-15T12:00')).toBe(
      '2026-07-15T09:00:00.000Z',
    );
    expect(cairoDateTimeLocalToIso('2026-10-21T12:00')).toBe(
      '2026-10-21T09:00:00.000Z',
    );
    expect(cairoDateTimeLocalToIso('2026-10-29T23:30')).toBe(
      '2026-10-29T21:30:00.000Z',
    );
    expect(cairoDateTimeLocalToIso('2026-02-31T12:00')).toBeNull();
    expect(formatCairoDateTime('2026-07-15T09:00:00.000Z')).toBe(
      '2026-07-15 12:00',
    );
  });

  it('turns a date filter into an inclusive Cairo day', () => {
    expect(cairoDateStartIso('2026-01-15')).toBe('2026-01-14T22:00:00.000Z');
    expect(cairoNextDateStartIso('2026-01-15')).toBe(
      '2026-01-15T22:00:00.000Z',
    );
    expect(cairoDateStartIso('2026-07-15')).toBe('2026-07-14T21:00:00.000Z');
    expect(dateRangeError('2026-02-02', '2026-01-01')).toBe(
      'تاريخ البداية لازم يكون قبل تاريخ النهاية',
    );
    expect(dateRangeError('2026-01-01', '2026-01-01')).toBeNull();
    expect(dateRangeError('nope', '')).toBe('تاريخ البداية مش مظبوط');
  });
});
