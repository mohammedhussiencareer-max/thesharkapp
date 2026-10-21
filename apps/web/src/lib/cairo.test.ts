import { describe, expect, it } from 'vitest';
import { formatCairo } from '@/lib/cairo';

describe('formatCairo', () => {
  it('shows Africa/Cairo as a date and a 24-hour time', () => {
    expect(formatCairo('2026-10-15T09:00:00.000Z')).toBe('15/10/2026 12:00');
  });
});
