import { describe, expect, it } from 'vitest';
import { mapCatalogError } from '@/items/errors';

describe('mapCatalogError', () => {
  it('maps a duplicate item name', () => {
    expect(
      mapCatalogError({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "stock_items_name_key"',
      }),
    ).toBe('الاسم ده موجود قبل كده');
  });

  it('maps a duplicate conversion unit', () => {
    expect(
      mapCatalogError({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "item_unit_conversions_pkey"',
      }),
    ).toBe('الوحدة دي موجودة قبل كده');
  });

  it('maps a frozen base unit to the Arabic reason', () => {
    expect(
      mapCatalogError({
        code: '23514',
        message: 'cannot change base_unit of an item that has movements',
      }),
    ).toBe('مينفعش تغيّر وحدة صنف عليه حركات');
  });

  it('maps a conversion that uses the base unit', () => {
    expect(
      mapCatalogError({
        code: '23514',
        message: 'cannot store a conversion for the item base unit',
      }),
    ).toBe('مينفعش التحويل يبقى بنفس الوحدة الأساسية');
  });

  it('maps a base unit change while conversions exist', () => {
    expect(
      mapCatalogError({
        code: '23514',
        details: 'cannot change base_unit while the item has unit conversions',
      }),
    ).toBe('امسح التحويلات الأول قبل ما تغيّر الوحدة');
  });

  it('says a check violation is not allowed when the reason is unknown', () => {
    expect(
      mapCatalogError({
        code: '23514',
        message: 'new row violates check constraint "something_else"',
      }),
    ).toBe('التغيير ده مش مسموح');
  });

  it('uses a generic retry message for anything else', () => {
    expect(
      mapCatalogError({ code: '42501', message: 'permission denied' }),
    ).toBe('حصل خطأ. حاول تاني.');
    expect(mapCatalogError(null)).toBe('حصل خطأ. حاول تاني.');
  });
});
