import { describe, expect, it } from 'vitest';
import {
  backDatedSortMessage,
  isUnknownOutcome,
  mapSortError,
  mixedRequiredMessage,
  notEnoughStockMessage,
  phoneMessage,
  quantityScaleMessage,
  requestIdConflictMessage,
  retrySafeMessage,
  sizeNotChildMessage,
  sizesExceedMessage,
} from '@/sorting/errors';

describe('mapSortError', () => {
  it('translates the stable sort failures', () => {
    expect(
      mapSortError({
        code: '22023',
        message: 'not enough stock to sort',
      }),
    ).toBe(notEnoughStockMessage);
    expect(
      mapSortError({
        code: '22023',
        message: 'sum of sizes exceeds quantity taken',
      }),
    ).toBe(sizesExceedMessage);
    expect(
      mapSortError({
        code: '22023',
        message: 'size item is not a child of the mixed item',
      }),
    ).toBe(sizeNotChildMessage);
    expect(
      mapSortError({
        code: '22023',
        message: 'mixed item must be a fish_mixed item in kg',
      }),
    ).toBe(mixedRequiredMessage);
    expect(
      mapSortError({
        code: '22023',
        message: 'qty_taken must have at most 6 decimal places',
      }),
    ).toBe(quantityScaleMessage);
    expect(
      mapSortError({
        code: '22023',
        message: 'quantity must have at most 6 decimal places',
      }),
    ).toBe(quantityScaleMessage);
    expect(
      mapSortError({
        code: '22023',
        message: 'request_id already used for a different sort',
      }),
    ).toBe(requestIdConflictMessage);
    expect(
      mapSortError({
        code: '22023',
        message: 'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
      }),
    ).toBe(phoneMessage);
  });

  it('keeps a retry safe when the unique key races or the reply is lost', () => {
    expect(mapSortError({ code: '23505', message: 'duplicate key' })).toBe(
      retrySafeMessage,
    );
  });

  it('uses the shared back-dated sentence with the fallback item name', () => {
    expect(
      mapSortError({
        code: 'P0001',
        message: 'back-dated movement not supported yet',
        details: 'occurred_at 2026-10-22 is before last_occurred_at 2026-10-22',
      }),
    ).toBe(backDatedSortMessage('الصنف'));
  });
});

describe('isUnknownOutcome', () => {
  it('treats a coded refusal as a known rollback', () => {
    expect(
      isUnknownOutcome({ code: '22023', message: 'not enough stock to sort' }),
    ).toBe(false);
    expect(
      isUnknownOutcome({
        code: 'P0001',
        message: 'back-dated movement not supported yet',
      }),
    ).toBe(false);
    expect(
      isUnknownOutcome({ code: '42501', message: 'permission denied' }),
    ).toBe(false);
    expect(
      isUnknownOutcome({ code: '40001', message: 'could not serialize' }),
    ).toBe(false);
    expect(
      isUnknownOutcome(
        new Error('back-dated', {
          cause: {
            code: 'P0001',
            message: 'back-dated movement not supported yet',
          },
        }),
      ),
    ).toBe(false);
  });

  it('keeps a unique violation unknown because the id may already be stored', () => {
    expect(
      isUnknownOutcome({ code: '23505', message: 'duplicate key value' }),
    ).toBe(true);
    expect(
      isUnknownOutcome(
        new Error('duplicate', {
          cause: { code: '23505', message: 'duplicate key' },
        }),
      ),
    ).toBe(true);
  });

  it('treats a missing code as unknown', () => {
    expect(isUnknownOutcome(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUnknownOutcome(new Error('timeout'))).toBe(true);
    expect(isUnknownOutcome({ message: 'timeout' })).toBe(true);
    expect(isUnknownOutcome({ code: '  ', message: 'empty' })).toBe(true);
    expect(isUnknownOutcome('network down')).toBe(true);
    expect(isUnknownOutcome(null)).toBe(true);
  });
});
