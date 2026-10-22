import { describe, expect, it } from 'vitest';
import { isPayloadRefusal, isUnknownOutcome } from '@/lib/write-outcome';
import {
  backDatedCountMessage,
  frequencyMessage,
  inactiveItemMessage,
  insideShiftMessage,
  isPayloadRefusal as exportedPayloadRefusal,
  mapCountError,
  openShiftMessage,
  phoneMessage,
  quantityScaleMessage,
  requestIdConflictMessage,
  retrySafeMessage,
  syncCoverageMessage,
  unknownItemMessage,
} from '@/counts/errors';

describe('mapCountError', () => {
  it('translates the stable count refusals', () => {
    expect(
      mapCountError({
        code: '22023',
        message: 'count time is inside a shift',
      }),
    ).toBe(insideShiftMessage);
    expect(
      mapCountError({ code: '22023', message: 'a shift is still open' }),
    ).toBe(openShiftMessage);
    expect(syncCoverageMessage).toBe(
      'لازم مزامنة جديدة تشتغل بعد ما قفلة الوردية تتسجل',
    );
    expect(
      mapCountError({
        code: '22023',
        message: 'sync has not covered this count time',
      }),
    ).toBe('لازم مزامنة جديدة تشتغل بعد ما قفلة الوردية تتسجل');
    expect(
      mapCountError({
        code: '22023',
        message: 'item count frequency does not match',
      }),
    ).toBe(frequencyMessage);
    expect(mapCountError({ code: '22023', message: 'item is inactive' })).toBe(
      inactiveItemMessage,
    );
    expect(
      mapCountError({ code: '22023', message: 'unknown stock item' }),
    ).toBe(unknownItemMessage);
    expect(
      mapCountError({
        code: '22023',
        message: 'counted_qty must have at most 6 decimal places',
      }),
    ).toBe(quantityScaleMessage);
    expect(
      mapCountError({
        code: '22023',
        message: 'request_id already used for a different count',
      }),
    ).toBe(requestIdConflictMessage);
    expect(
      mapCountError({
        code: '22023',
        message: 'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
      }),
    ).toBe(phoneMessage);
  });

  it('keeps a retry safe when the unique key races', () => {
    expect(mapCountError({ code: '23505', message: 'duplicate key' })).toBe(
      retrySafeMessage,
    );
    expect(isUnknownOutcome({ code: '23505', message: 'duplicate key' })).toBe(
      true,
    );
  });

  it('uses the item name, and falls back when the detail is the ledger timestamp', () => {
    expect(
      mapCountError({
        code: 'P0001',
        message: 'back-dated movement not supported yet',
        details: 'بلطي',
      }),
    ).toBe(backDatedCountMessage('بلطي'));
    expect(
      mapCountError({
        code: 'P0001',
        message: 'back-dated movement not supported yet',
        details: 'occurred_at 2026-10-22 is before last_occurred_at',
      }),
    ).toBe(backDatedCountMessage('الصنف'));
    expect(exportedPayloadRefusal({ code: 'P0001', message: 'x' })).toBe(
      isPayloadRefusal({ code: 'P0001', message: 'x' }),
    );
  });
});
