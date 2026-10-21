import { describe, expect, it } from 'vitest';
import {
  backDatedMessage,
  genericPurchaseError,
  mapPurchaseError,
  permissionMessage,
} from '@/purchases/errors';

describe('mapPurchaseError', () => {
  it('names the item on a back-dated ledger error', () => {
    expect(
      mapPurchaseError({
        code: 'P0001',
        message: 'back-dated movement not supported yet',
        details: 'زيت',
      }),
    ).toBe(backDatedMessage('زيت'));
    expect(backDatedMessage('زيت')).toBe(
      'مينفعش تسجّل حركة لـ زيت بتاريخ أقدم من آخر حركة ليه — التعديل بأثر رجعي جاي في مرحلة لاحقة',
    );
  });

  it('maps permission, validation, and unknown failures', () => {
    expect(
      mapPurchaseError({ code: '42501', message: 'permission denied' }),
    ).toBe(permissionMessage);
    expect(
      mapPurchaseError({
        code: '22023',
        message: 'item already has movements: جمبري',
      }),
    ).toBe('مينفعش تسجّل رصيد افتتاحي لـ جمبري — الصنف عليه حركات قبل كده');
    expect(
      mapPurchaseError({
        code: '22023',
        message: 'duplicate opening item: زيت',
      }),
    ).toBe('الصنف زيت متكرر في الرصيد الافتتاحي');
    expect(
      mapPurchaseError({
        code: '22023',
        message: 'unknown unit "دلو" for item زيت',
      }),
    ).toBe('الوحدة دلو مش معرّفة للصنف زيت');
    expect(
      mapPurchaseError({
        code: '22023',
        message: 'amount_paid must be in piasters',
      }),
    ).toBe('المبلغ لأقرب قرش');
    expect(mapPurchaseError({ code: '22023', message: 'something new' })).toBe(
      'البيانات مش مظبوطة',
    );
    expect(mapPurchaseError({ message: 'boom' })).toBe(genericPurchaseError);
    expect(mapPurchaseError(null)).toBe(genericPurchaseError);
  });
});
