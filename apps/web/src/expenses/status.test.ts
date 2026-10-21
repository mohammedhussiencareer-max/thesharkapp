import { describe, expect, it } from 'vitest';
import { entryStatusLabel, markSuperseded } from '@/expenses/status';
import type { ExpenseLine } from '@/expenses/types';

function line(
  patch: Partial<ExpenseLine> & Pick<ExpenseLine, 'id'>,
): ExpenseLine {
  return {
    categoryId: 'gas',
    categoryName: 'غاز',
    categoryKind: 'daily',
    amount: '40.00',
    periodMonth: null,
    expenseDate: '2030-04-03',
    paidOn: null,
    isEstimate: true,
    note: null,
    hours: null,
    hourlyRate: null,
    driverLabel: null,
    createdAt: '2030-04-03T10:00:00.000Z',
    voided: false,
    voidReason: null,
    superseded: false,
    ...patch,
  };
}

describe('estimate supersession', () => {
  it('stops an estimate while a live actual shares its category and period', () => {
    const [actual, estimate] = markSuperseded([
      line({ id: 'actual', amount: '55.00', isEstimate: false }),
      line({ id: 'estimate' }),
    ]);
    expect(actual?.superseded).toBe(false);
    expect(estimate?.superseded).toBe(true);
    expect(entryStatusLabel(estimate ?? line({ id: 'missing' }))).toBe(
      'التقدير اتلغى بالفاتورة',
    );
  });

  it('counts the estimate again after the actual is voided', () => {
    const [estimate] = markSuperseded([
      line({ id: 'estimate' }),
      line({
        id: 'actual',
        amount: '55.00',
        isEstimate: false,
        voided: true,
        voidReason: 'غلط',
      }),
    ]);
    expect(estimate?.superseded).toBe(false);
    expect(entryStatusLabel(estimate ?? line({ id: 'missing' }))).toBe('تقدير');
  });

  it('does not let one date supersede another', () => {
    const [otherDay] = markSuperseded([
      line({ id: 'other', expenseDate: '2030-04-04' }),
      line({
        id: 'actual',
        expenseDate: '2030-04-03',
        isEstimate: false,
      }),
    ]);
    expect(otherDay?.superseded).toBe(false);
  });
});
