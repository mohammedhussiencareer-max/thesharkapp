import { describe, expect, it } from 'vitest';
import {
  atLeastOneMessage,
  badBalanceMessage,
  duplicateItemMessage,
  phoneMessage,
  quantityNegativeMessage,
  quantityScaleMessage,
  tooManyMessage,
} from '@/counts/errors';
import type { CountItem, CountValues } from '@/counts/types';
import { assessCount } from '@/counts/validation';

function item(patch: Partial<CountItem> = {}): CountItem {
  return {
    id: 'fish',
    name: 'بلطي',
    onHandQty: '10',
    onHandValue: '100.00',
    avgCost: '10.05',
    ...patch,
  };
}

function values(patch: Partial<CountValues> = {}): CountValues {
  return {
    countedAt: '2026-10-22T12:00',
    note: '',
    quantities: { fish: '7' },
    ...patch,
  };
}

describe('assessCount', () => {
  it('accepts Arabic-Indic digits and omits a blank row', () => {
    const result = assessCount(
      values({ quantities: { fish: '٧٫٥', other: '' } }),
      [item(), item({ id: 'other', name: 'جمبري' })],
    );
    expect(result.draft).toMatchObject({
      countedAt: '2026-10-22T09:00:00.000Z',
      note: null,
      lines: [{ itemId: 'fish', countedQty: '7.5' }],
    });
    expect(result.preview?.lines).toHaveLength(1);
  });

  it('keeps the preview when the time is missing and blocks the draft', () => {
    const result = assessCount(values({ countedAt: '' }), [item()]);
    expect(result.preview?.shortageValue).toBe('30.00');
    expect(result.draft).toBeNull();
    expect(result.errors.countedAt).toBeTruthy();
  });

  it('refuses a negative quantity, a fine scale, a phone note, and an empty count', () => {
    expect(
      assessCount(values({ quantities: { fish: '-1' } }), [item()]).errors
        .quantities.fish,
    ).toBe(quantityNegativeMessage);
    expect(
      assessCount(values({ quantities: { fish: '1.1234567' } }), [item()])
        .errors.quantities.fish,
    ).toBe(quantityScaleMessage);
    expect(
      assessCount(values({ note: '01001234567' }), [item()]).errors.note,
    ).toBe(phoneMessage);
    expect(
      assessCount(values({ note: '01001234567' }), [item()]).draft,
    ).toBeNull();
    expect(assessCount(values({ quantities: {} }), [item()]).errors.form).toBe(
      atLeastOneMessage,
    );
  });

  it('refuses a bad balance, a duplicate, and more than 200 lines', () => {
    const bad = assessCount(values(), [item({ onHandQty: '-1' })]);
    expect(bad.errors.form).toBe(badBalanceMessage);
    expect(bad.preview).toBeNull();
    expect(bad.draft).toBeNull();

    const duplicate = assessCount(values(), [item(), item()]);
    expect(duplicate.errors.quantities.fish).toBe(duplicateItemMessage);
    expect(duplicate.draft).toBeNull();

    const many = Array.from({ length: 201 }, (_, index) =>
      item({
        id: `fish-${index}`,
        name: `صنف ${index}`,
      }),
    );
    const quantities = Object.fromEntries(many.map((row) => [row.id, '1']));
    const tooMany = assessCount(values({ quantities }), many);
    expect(tooMany.errors.form).toBe(tooManyMessage);
    expect(tooMany.draft).toBeNull();
  });

  it('allows a surplus and keeps it in the draft', () => {
    const result = assessCount(values({ quantities: { fish: '12' } }), [
      item(),
    ]);
    expect(result.preview?.hasSurplus).toBe(true);
    expect(result.draft?.lines).toEqual([{ itemId: 'fish', countedQty: '12' }]);
  });
});
