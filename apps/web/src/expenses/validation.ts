import {
  digitCount,
  driverPay,
  parseHours,
  parseMoney,
  type ParseFailure,
} from '@/expenses/amount';
import {
  isMonthlyKind,
  type ExpenseCategory,
  type ExpenseDraft,
  type ExpenseKind,
} from '@/expenses/types';

export const expenseMessages = {
  category: 'اختار التصنيف',
  inactive: 'التصنيف ده متوقف',
  amount: 'اكتب المبلغ',
  amountPositive: 'المبلغ لازم يكون أكبر من صفر',
  amountScale: 'المبلغ لأقرب قرش',
  amountLarge: 'المبلغ أكبر من المسموح',
  month: 'اختار الشهر',
  date: 'اختار التاريخ',
  dateInMonth: 'التاريخ لازم يكون في الشهر المختار',
  dateInvalid: 'التاريخ مش مظبوط',
  hours: 'اكتب عدد الساعات',
  hoursPositive: 'الساعات لازم تكون أكبر من صفر',
  hoursScale: 'الساعات لأقرب جزء من مية',
  hoursLarge: 'الساعات أكبر من المسموح',
  rate: 'اكتب سعر الساعة',
  ratePositive: 'سعر الساعة لازم يكون أكبر من صفر',
  rateScale: 'سعر الساعة لأقرب قرش',
  rateLarge: 'سعر الساعة أكبر من المسموح',
  driverAmount: 'أجر الساعات لازم يكون أكبر من صفر',
  driverLarge: 'أجر الساعات أكبر من المسموح',
  note: 'الملاحظة أطول من 500 حرف',
  label: 'اسم الطيار أطول من 40 حرف',
  phone: 'متسجلش رقم تليفون أو رقم قومي',
  paidOn: 'تاريخ الدفع مش مظبوط',
  categoryName: 'اكتب اسم التصنيف',
  categoryNameLong: 'اسم التصنيف أطول من 80 حرف',
  categoryKind: 'اختار نوع التصنيف',
  voidReason: 'اكتب سبب الإلغاء',
  voidReasonLong: 'سبب الإلغاء أطول من 500 حرف',
} as const;

export type ExpenseFormValues = {
  categoryId: string;
  amount: string;
  date: string;
  hours: string;
  hourlyRate: string;
  driverLabel: string;
  isEstimate: boolean;
  paidOn: string;
  note: string;
};

export type ExpenseFormErrors = Partial<
  Record<keyof ExpenseFormValues | 'month', string>
>;

export type ExpenseValidation =
  { ok: true; draft: ExpenseDraft } | { ok: false; errors: ExpenseFormErrors };

export function emptyExpenseForm(): ExpenseFormValues {
  return {
    categoryId: '',
    amount: '',
    date: '',
    hours: '',
    hourlyRate: '',
    driverLabel: '',
    isEstimate: false,
    paidOn: '',
    note: '',
  };
}

function charLength(value: string): number {
  return [...value].length;
}

function isCalendarDate(iso: string, min: string, max: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  if (!yearText || !monthText || !dayText) return false;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1) return false;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return false;
  return iso >= min && iso <= max;
}

function isMonthInput(value: string): boolean {
  return (
    /^\d{4}-\d{2}$/.test(value) &&
    isCalendarDate(`${value}-01`, '1990-01-01', '2100-12-01')
  );
}

function moneyMessage(reason: ParseFailure, kind: 'amount' | 'rate'): string {
  if (kind === 'rate') {
    if (reason === 'scale') return expenseMessages.rateScale;
    if (reason === 'large') return expenseMessages.rateLarge;
    if (reason === 'zero') return expenseMessages.ratePositive;
    return expenseMessages.rate;
  }
  if (reason === 'scale') return expenseMessages.amountScale;
  if (reason === 'large') return expenseMessages.amountLarge;
  if (reason === 'zero') return expenseMessages.amountPositive;
  return expenseMessages.amount;
}

function hoursMessage(reason: ParseFailure): string {
  if (reason === 'scale') return expenseMessages.hoursScale;
  if (reason === 'large') return expenseMessages.hoursLarge;
  if (reason === 'zero') return expenseMessages.hoursPositive;
  return expenseMessages.hours;
}

export function validateExpenseForm(
  values: ExpenseFormValues,
  input: { categories: readonly ExpenseCategory[]; month: string },
): ExpenseValidation {
  const errors: ExpenseFormErrors = {};
  const category = input.categories.find((row) => row.id === values.categoryId);
  if (!category) errors.categoryId = expenseMessages.category;
  else if (!category.active) errors.categoryId = expenseMessages.inactive;

  const monthOk = isMonthInput(input.month);
  if (!monthOk) errors.month = expenseMessages.month;

  let amount: string | null = null;
  let periodMonth: string | null = null;
  let expenseDate: string | null = null;
  let hours: string | null = null;
  let hourlyRate: string | null = null;
  let driverLabel: string | null = null;
  const kind: ExpenseKind | null = category?.kind ?? null;

  if (kind && isMonthlyKind(kind)) {
    if (monthOk) periodMonth = `${input.month}-01`;
  } else if (kind === 'daily' || kind === 'driver_hours') {
    if (values.date.trim() === '') errors.date = expenseMessages.date;
    else if (
      !isCalendarDate(values.date, '1990-01-01', '2100-12-31') ||
      !monthOk ||
      !values.date.startsWith(`${input.month}-`)
    ) {
      errors.date = values.date.startsWith(`${input.month}-`)
        ? expenseMessages.dateInvalid
        : expenseMessages.dateInMonth;
    } else {
      expenseDate = values.date;
    }
  }

  if (kind === 'driver_hours') {
    const parsedHours = parseHours(values.hours);
    const parsedRate = parseMoney(values.hourlyRate);
    if (!parsedHours.ok) errors.hours = hoursMessage(parsedHours.reason);
    else hours = parsedHours.value;
    if (!parsedRate.ok)
      errors.hourlyRate = moneyMessage(parsedRate.reason, 'rate');
    else hourlyRate = parsedRate.value;
    if (parsedHours.ok && parsedRate.ok) {
      const pay = driverPay(parsedHours.value, parsedRate.value);
      if (!pay.ok) {
        errors.amount =
          pay.reason === 'large'
            ? expenseMessages.driverLarge
            : expenseMessages.driverAmount;
      } else {
        amount = pay.value;
      }
    }
    const label = values.driverLabel.trim();
    if (charLength(label) > 40) errors.driverLabel = expenseMessages.label;
    else if (digitCount(label) >= 8) errors.driverLabel = expenseMessages.phone;
    else if (label !== '') driverLabel = label;
  } else if (kind) {
    const parsed = parseMoney(values.amount);
    if (!parsed.ok) errors.amount = moneyMessage(parsed.reason, 'amount');
    else amount = parsed.value;
  }

  const note = values.note.trim();
  if (charLength(note) > 500) errors.note = expenseMessages.note;

  let paidOn: string | null = null;
  if (values.paidOn.trim() !== '') {
    if (!isCalendarDate(values.paidOn, '1990-01-01', '2100-12-31')) {
      errors.paidOn = expenseMessages.paidOn;
    } else {
      paidOn = values.paidOn;
    }
  }

  if (Object.keys(errors).length > 0 || !category || !kind) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    draft: {
      categoryId: category.id,
      amount,
      periodMonth,
      expenseDate,
      paidOn,
      isEstimate: values.isEstimate,
      note: note === '' ? null : note,
      hours,
      hourlyRate,
      driverLabel,
    },
  };
}

export function validateCategoryName(value: string): string | null {
  const text = value.trim();
  if (text.length === 0) return expenseMessages.categoryName;
  if (charLength(text) > 80) return expenseMessages.categoryNameLong;
  return null;
}

export function validateVoidReason(value: string): string | null {
  const text = value.trim();
  if (text.length === 0) return expenseMessages.voidReason;
  if (charLength(text) > 500) return expenseMessages.voidReasonLong;
  return null;
}
