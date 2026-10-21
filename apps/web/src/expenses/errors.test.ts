import { describe, expect, it } from 'vitest';
import { mapExpenseError, retrySafeMessage } from '@/expenses/errors';
import { genericCatalogError } from '@/items/errors';

describe('mapExpenseError', () => {
  it('maps the database messages the form can hit', () => {
    expect(
      mapExpenseError({ message: 'amount must be greater than zero' }),
    ).toBe('المبلغ لازم يكون أكبر من صفر');
    expect(
      mapExpenseError({
        message: 'driver amount must be greater than zero',
      }),
    ).toBe('أجر الساعات لازم يكون أكبر من صفر');
    expect(
      mapExpenseError({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "expense_categories_name_lower_idx"',
      }),
    ).toBe('الاسم ده موجود قبل كده');
    expect(
      mapExpenseError({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "expense_entries_voids_id_key"',
      }),
    ).toBe('المصروف ده اتلغى قبل كده');
    expect(
      mapExpenseError({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "expense_entries_request_id_key"',
      }),
    ).toBe(retrySafeMessage);
    expect(
      mapExpenseError({
        message: 'request_id already used for a different expense',
      }),
    ).toBe(
      'الحفظ اللي فات ممكن يكون اتسجل قبل التعديل. راجع مصاريف الشهر قبل ما تسجّل تاني',
    );
    expect(
      mapExpenseError({
        message: 'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
      }),
    ).toBe('مينفعش تكتب أرقام تليفونات أو أرقام قومية');
  });

  it('hides an unknown failure', () => {
    expect(mapExpenseError({ message: 'connection reset' })).toBe(
      genericCatalogError,
    );
    expect(mapExpenseError(null)).toBe(genericCatalogError);
  });
});
