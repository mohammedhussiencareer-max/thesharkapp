import { describe, expect, it } from 'vitest';
import {
  cairoDateStartIso,
  cairoDateTimeLocalToIso,
  cairoNextDateStartIso,
  dateRangeError,
  formatCairoDateTime,
  missingCairoTimeMessage,
  parseCairoDateTimeLocal,
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
    // 23:30 occurs twice on the 2026 fall-back day. The earlier instant
    // (daylight saving still in effect) is the one that is stored.
    expect(cairoDateTimeLocalToIso('2026-10-29T23:30')).toBe(
      '2026-10-29T20:30:00.000Z',
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

  it('starts the 2027-04-30 DST day at 01:00 and ends the previous day there', () => {
    expect(cairoDateStartIso('2027-04-29')).toBe('2027-04-28T22:00:00.000Z');
    expect(cairoDateStartIso('2027-04-30')).toBe('2027-04-29T22:00:00.000Z');
    expect(cairoNextDateStartIso('2027-04-29')).toBe(
      '2027-04-29T22:00:00.000Z',
    );
    expect(cairoNextDateStartIso('2027-04-30')).toBe(
      '2027-04-30T21:00:00.000Z',
    );
  });

  it('includes the repeated hour on the autumn fall-back day', () => {
    expect(cairoDateStartIso('2027-10-28')).toBe('2027-10-27T21:00:00.000Z');
    expect(cairoNextDateStartIso('2027-10-28')).toBe(
      '2027-10-28T22:00:00.000Z',
    );
    expect(cairoDateStartIso('2026-10-29')).toBe('2026-10-28T21:00:00.000Z');
    expect(cairoNextDateStartIso('2026-10-29')).toBe(
      '2026-10-29T22:00:00.000Z',
    );
  });

  it('rejects a skipped hour and keeps the earlier repeated hour', () => {
    expect(parseCairoDateTimeLocal('2027-04-30T00:00')).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(parseCairoDateTimeLocal('2027-04-30T00:30')).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(cairoDateTimeLocalToIso('2027-04-30T00:30')).toBeNull();
    expect(cairoDateTimeLocalToIso('2027-04-30T01:00')).toBe(
      '2027-04-29T22:00:00.000Z',
    );
    expect(cairoDateTimeLocalToIso('2027-10-28T23:30')).toBe(
      '2027-10-28T20:30:00.000Z',
    );
    expect(parseCairoDateTimeLocal('2026-02-31T12:00')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(missingCairoTimeMessage).toBe('الوقت ده مش موجود في توقيت القاهرة');
  });
});
