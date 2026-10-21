import { describe, expect, it } from 'vitest';
import type { ExpenseCategory } from '@/expenses/types';
import {
  emptyExpenseForm,
  validateExpenseForm,
  type ExpenseFormValues,
} from '@/expenses/validation';

const categories: ExpenseCategory[] = [
  { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
  { id: 'gas', name: 'غاز', kind: 'daily', active: true },
  { id: 'driver', name: 'أجر طيارين', kind: 'driver_hours', active: true },
  { id: 'interest', name: 'فوائد', kind: 'interest', active: true },
  { id: 'depr', name: 'إهلاك', kind: 'depreciation', active: true },
  { id: 'off', name: 'قديم', kind: 'daily', active: false },
];

function values(patch: Partial<ExpenseFormValues> = {}): ExpenseFormValues {
  return { ...emptyExpenseForm(), ...patch };
}

function validate(patch: Partial<ExpenseFormValues>, month = '2030-04') {
  return validateExpenseForm(values(patch), { categories, month });
}

describe('validateExpenseForm', () => {
  it('requires a category before any amount', () => {
    const result = validate({ amount: '10' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.categoryId).toBe('اختار التصنيف');
  });

  it('rejects an inactive category', () => {
    const result = validate({
      categoryId: 'off',
      amount: '10',
      date: '2030-04-02',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.categoryId).toBe('التصنيف ده متوقف');
  });

  it('posts a fixed monthly amount on the first of the chosen month', () => {
    const result = validate({
      categoryId: 'rent',
      amount: '١٠٠٠',
      isEstimate: true,
      note: '  تقدير إيجار  ',
      paidOn: '2030-04-20',
    });
    expect(result).toEqual({
      ok: true,
      draft: {
        categoryId: 'rent',
        amount: '1000.00',
        periodMonth: '2030-04-01',
        expenseDate: null,
        paidOn: '2030-04-20',
        isEstimate: true,
        note: 'تقدير إيجار',
        hours: null,
        hourlyRate: null,
        driverLabel: null,
      },
    });
  });

  it('rejects a third decimal and a missing amount for monthly kinds', () => {
    const missing = validate({ categoryId: 'interest' });
    const scale = validate({ categoryId: 'depr', amount: '1.005' });
    expect(missing.ok).toBe(false);
    expect(scale.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.amount).toBe('اكتب المبلغ');
    if (!scale.ok) expect(scale.errors.amount).toBe('المبلغ لأقرب قرش');
  });

  it('keeps a daily expense on a date inside the month', () => {
    const outside = validate({
      categoryId: 'gas',
      amount: '7.5',
      date: '2030-05-01',
    });
    const invalid = validate({
      categoryId: 'gas',
      amount: '7.5',
      date: '2030-04-31',
    });
    const ok = validate({
      categoryId: 'gas',
      amount: '7.5',
      date: '2030-04-03',
    });
    expect(outside.ok).toBe(false);
    expect(invalid.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.errors.date).toBe('التاريخ لازم يكون في الشهر المختار');
    }
    if (!invalid.ok) expect(invalid.errors.date).toBe('التاريخ مش مظبوط');
    expect(ok).toMatchObject({
      ok: true,
      draft: { amount: '7.50', expenseDate: '2030-04-03', periodMonth: null },
    });
  });

  it('computes driver pay and rejects a phone-like label', () => {
    const phone = validate({
      categoryId: 'driver',
      date: '2030-04-15',
      hours: '5.5',
      hourlyRate: '30',
      driverLabel: '01001234567',
    });
    const pay = validate({
      categoryId: 'driver',
      date: '2030-04-15',
      hours: '5.5',
      hourlyRate: '30',
      driverLabel: '  طيار اختبار  ',
    });
    expect(phone.ok).toBe(false);
    if (!phone.ok) {
      expect(phone.errors.driverLabel).toBe('متسجلش رقم تليفون أو رقم قومي');
    }
    expect(pay).toMatchObject({
      ok: true,
      draft: {
        amount: '165.00',
        hours: '5.50',
        hourlyRate: '30.00',
        expenseDate: '2030-04-15',
        periodMonth: null,
        driverLabel: 'طيار اختبار',
      },
    });
  });

  it('rejects a note longer than 500 characters', () => {
    const result = validate({
      categoryId: 'rent',
      amount: '10',
      note: 'م'.repeat(501),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.note).toBe('الملاحظة أطول من 500 حرف');
  });
});
