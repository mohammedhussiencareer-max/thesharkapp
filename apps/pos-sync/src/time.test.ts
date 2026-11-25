import { describe, expect, it } from 'vitest';
import { normalizeCatalogTimestamp, normalizeTimestamp } from './time.ts';

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

  it('rejects offsets and dates Date.parse rejects', () => {
    expect(() => normalizeTimestamp('2026-10-15T12:00:00+02:00')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeTimestamp('2026-13-40T00:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeTimestamp('2026-10-15T24:00:01Z')).toThrow(
      /invalid timestamp/,
    );
  });

  it('keeps 24:00:00 for order and shift timestamps', () => {
    expect(normalizeTimestamp('2026-10-15T24:00:00Z')).toBe(
      '2026-10-15T24:00:00.000000Z',
    );
  });

  it('keeps legacy calendar text that Date.parse accepts', () => {
    expect(normalizeTimestamp('2026-02-30T10:00:00Z')).toBe(
      '2026-02-30T10:00:00.000000Z',
    );
    expect(normalizeTimestamp('2025-02-29T10:00:00Z')).toBe(
      '2025-02-29T10:00:00.000000Z',
    );
    expect(normalizeTimestamp('2026-04-31T10:00:00Z')).toBe(
      '2026-04-31T10:00:00.000000Z',
    );
    expect(normalizeTimestamp('0000-01-01T00:00:00Z')).toBe(
      '0000-01-01T00:00:00.000000Z',
    );
    expect(normalizeTimestamp('0001-01-01T00:00:00Z')).toBe(
      '0001-01-01T00:00:00.000000Z',
    );
    expect(normalizeTimestamp('2024-02-29T10:00:00Z')).toBe(
      '2024-02-29T10:00:00.000000Z',
    );
  });
});

describe('normalizeCatalogTimestamp', () => {
  it('pads and truncates to microseconds', () => {
    expect(normalizeCatalogTimestamp('2026-10-15T12:00:00Z')).toBe(
      '2026-10-15T12:00:00.000000Z',
    );
    expect(normalizeCatalogTimestamp('2026-10-15T12:00:00.123Z')).toBe(
      '2026-10-15T12:00:00.123000Z',
    );
    expect(normalizeCatalogTimestamp('2026-10-15T12:00:00.123456789Z')).toBe(
      '2026-10-15T12:00:00.123456Z',
    );
  });

  it('rejects offsets, impossible dates, year 0000, and 24:00:00', () => {
    expect(() =>
      normalizeCatalogTimestamp('2026-10-15T12:00:00+02:00'),
    ).toThrow(/invalid timestamp/);
    expect(() => normalizeCatalogTimestamp('2026-13-40T00:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeCatalogTimestamp('2026-02-30T10:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeCatalogTimestamp('2025-02-29T10:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeCatalogTimestamp('2026-04-31T10:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeCatalogTimestamp('0000-01-01T00:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(() => normalizeCatalogTimestamp('2026-10-15T24:00:00Z')).toThrow(
      /invalid timestamp/,
    );
    expect(normalizeCatalogTimestamp('0001-01-01T00:00:00Z')).toBe(
      '0001-01-01T00:00:00.000000Z',
    );
    expect(normalizeCatalogTimestamp('2024-02-29T10:00:00Z')).toBe(
      '2024-02-29T10:00:00.000000Z',
    );
  });
});
