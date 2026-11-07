import { describe, expect, it } from 'vitest';
import { packagingScheduleOf } from '@/packaging/api';
import { canonicalOrderTypeKey } from '@/packaging/format';

const schedule = {
  subject_id: null,
  token: 'abc',
  empty_token: 'abc',
  versions: [
    {
      id: 'version-1',
      effective_from: '2030-01-01T00:00:00.000Z',
      effective_to: null,
      decision: 'lines',
      lines: [
        {
          stock_item_id: 'item-1',
          quantity: '2',
          unit_code: 'piece',
          capacity_kg: null,
        },
      ],
    },
  ],
};

describe('packaging schedule text', () => {
  it('keeps a quantity as decimal text', () => {
    expect(packagingScheduleOf(schedule).versions[0]?.lines[0]?.quantity).toBe(
      '2',
    );
  });

  it('refuses a JSON number quantity', () => {
    const version = schedule.versions[0];
    const line = version?.lines[0];
    if (!version || !line) throw new Error('fixture');
    expect(() =>
      packagingScheduleOf({
        ...schedule,
        versions: [{ ...version, lines: [{ ...line, quantity: 2 }] }],
      }),
    ).toThrow();
  });

  it('canonicalizes an order type key without depending on spaces', () => {
    expect(canonicalOrderTypeKey(['type', 'hall'])).toBe(
      canonicalOrderTypeKey(['type', 'hall']),
    );
    expect(canonicalOrderTypeKey(['none'])).toBe('["none"]');
    expect(canonicalOrderTypeKey(['type', 'hall'])).toBe('["type","hall"]');
  });
});
