import { describe, expect, it } from 'vitest';
import { normalizeTimestamp } from './time.ts';

describe('normalizeTimestamp', () => {
  it('pads and truncates to microseconds', () => {
    expect(normalizeTimestamp('2026-10-15T12:00:00Z')).toBe(
      '2026-10-15T12:00:00.000000Z',
    );
    expect(normalizeTimestamp('2026-10-15T12:00:00.123Z')).toBe(
      '2026-10-15T12:00:00.123000Z',
    );
    expect(normalizeTimestamp('2026-10-15T12:00:00.123456789Z')).toBe(
      '2026-10-15T12:00:00.123456Z',
    );
  });

  it('rejects offsets and impossible dates', () => {
    expect(() => normalizeTimestamp('2026-10-15T12:00:00+02:00')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeTimestamp('2026-13-40T00:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeTimestamp('2026-02-30T10:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeTimestamp('2025-02-29T10:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeTimestamp('2026-04-31T10:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(normalizeTimestamp('2024-02-29T10:00:00Z')).toBe(
      '2024-02-29T10:00:00.000000Z',
    );
  });
});
