export const expenseKinds = [
  'fixed_monthly',
  'daily',
  'driver_hours',
  'interest',
  'depreciation',
] as const;

export type ExpenseKind = (typeof expenseKinds)[number];

export function isExpenseKind(value: unknown): value is ExpenseKind {
  return expenseKinds.some((kind) => kind === value);
}

export function isMonthlyKind(kind: ExpenseKind): boolean {
  return (
    kind === 'fixed_monthly' || kind === 'interest' || kind === 'depreciation'
  );
}

export type ExpenseCategory = {
  id: string;
  name: string;
  kind: ExpenseKind;
  active: boolean;
};

export type ExpenseLine = {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryKind: ExpenseKind;
  amount: string;
  periodMonth: string | null;
  expenseDate: string | null;
  paidOn: string | null;
  isEstimate: boolean;
  note: string | null;
  hours: string | null;
  hourlyRate: string | null;
  driverLabel: string | null;
  createdAt: string;
  voided: boolean;
  voidReason: string | null;
  superseded: boolean;
};

export type AllocationDay = {
  date: string;
  fixedShare: string;
  dailyTotal: string;
  driverTotal: string;
  interest: string;
  depreciation: string;
  total: string;
};

export type ExpenseMonth = {
  monthStart: string;
  categories: ExpenseCategory[];
  entries: ExpenseLine[];
  days: AllocationDay[];
  complete: boolean;
  confirmedAt: string | null;
};

export type ExpenseDraft = {
  requestId: string;
  categoryId: string;
  amount: string | null;
  periodMonth: string | null;
  expenseDate: string | null;
  paidOn: string | null;
  isEstimate: boolean;
  note: string | null;
  hours: string | null;
  hourlyRate: string | null;
  driverLabel: string | null;
};
