import type { ExpenseKind } from '@/expenses/types';

export const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

export const kindLabels: Record<ExpenseKind, string> = {
  fixed_monthly: 'ثابت شهري',
  daily: 'يومي',
  driver_hours: 'أجر طيارين',
  interest: 'فوائد',
  depreciation: 'إهلاك',
};
