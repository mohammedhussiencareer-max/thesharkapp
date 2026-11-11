import { describe, expect, it } from 'vitest';
import { genericCatalogError, StaleWriteError } from '@/items/errors';
import {
  mapDecisionError,
  OrderChangedError,
  orderChangedMessage,
} from '@/order-decisions/errors';

describe('order decision errors', () => {
  it('is a known stale write with the 40001 code', () => {
    const error = new OrderChangedError();
    expect(error).toBeInstanceOf(StaleWriteError);
    expect(error.code).toBe('40001');
    expect(error.message).toBe(orderChangedMessage);
  });

  it('maps the server refusals to Arabic', () => {
    expect(mapDecisionError({ code: '42501', message: 'x' })).toContain(
      'المالك',
    );
    expect(
      mapDecisionError({
        code: 'P0001',
        message: 'a reason is required to change a decision',
      }),
    ).toBe('اكتب سبب تغيير القرار');
    expect(
      mapDecisionError({
        code: '22023',
        message: 'returned quantities must be listed items',
      }),
    ).toContain('الكمية المرتجعة');
    expect(
      mapDecisionError({
        code: '22023',
        message:
          'the retained returned quantities no longer fit the preparation basis; clear them or choose the decision they apply to',
      }),
    ).toContain('المحفوظة');
    expect(
      mapDecisionError({
        code: '22023',
        message:
          'the retained returned quantities need a preparation basis; clear them or choose the decision they apply to',
      }),
    ).toContain('المحفوظة');
    expect(
      mapDecisionError({ code: '55P03', hint: 'a POS sync is running' }),
    ).toContain('مزامنة');
  });

  it('never shows raw server text', () => {
    expect(mapDecisionError({ code: 'XX000', message: 'secret detail' })).toBe(
      genericCatalogError,
    );
    expect(mapDecisionError({})).toBe(genericCatalogError);
  });
});
