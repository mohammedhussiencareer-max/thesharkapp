import { useId, useState, type FormEvent } from 'react';
import { driverPay } from '@/expenses/amount';
import { fieldClass, kindLabels } from '@/expenses/labels';
import {
  isMonthlyKind,
  type ExpenseCategory,
  type ExpenseDraft,
} from '@/expenses/types';
import {
  emptyExpenseForm,
  validateExpenseForm,
  type ExpenseFormErrors,
  type ExpenseFormValues,
} from '@/expenses/validation';
import { monthEndIso } from '@/lib/cairo';
import { formatEgpText } from '@/lib/money';
import { primaryButton } from '@/lib/page-style';

export function ExpenseForm({
  categories,
  month,
  disabled,
  serverError,
  onMonthChange,
  onSubmit,
}: {
  categories: readonly ExpenseCategory[];
  month: string;
  disabled: boolean;
  serverError: string | null;
  onMonthChange: (month: string) => void;
  onSubmit: (draft: ExpenseDraft) => void;
}) {
  const amountErrorId = useId();
  const headingId = useId();
  const [requestId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<ExpenseFormValues>(emptyExpenseForm);
  const [errors, setErrors] = useState<ExpenseFormErrors>({});
  const category =
    categories.find((row) => row.id === values.categoryId) ?? null;
  const kind = category?.kind ?? null;
  const monthly = kind !== null && isMonthlyKind(kind);
  const dated = kind === 'daily' || kind === 'driver_hours';
  const driver = kind === 'driver_hours';
  const pay = driver ? driverPay(values.hours, values.hourlyRate) : null;
  const monthEnd = /^\d{4}-\d{2}$/.test(month)
    ? monthEndIso(`${month}-01`)
    : undefined;

  function change(patch: Partial<ExpenseFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function onSubmitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const result = validateExpenseForm(values, { categories, month });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onSubmit({ ...result.draft, requestId });
  }

  return (
    <form
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
      noValidate
      onSubmit={onSubmitForm}
    >
      <h2 id={headingId} className="text-lg font-semibold">
        مصروف جديد
      </h2>
      {serverError ? <p role="alert">{serverError}</p> : null}
      <label className="flex flex-col gap-1">
        التصنيف
        <select
          className={fieldClass}
          value={values.categoryId}
          disabled={disabled}
          onChange={(event) => change({ categoryId: event.target.value })}
        >
          <option value="">اختار التصنيف</option>
          {categories
            .filter((row) => row.active)
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
        </select>
      </label>
      {errors.categoryId ? <p role="alert">{errors.categoryId}</p> : null}
      {kind ? <p>النوع: {kindLabels[kind]}</p> : null}
      {monthly ? (
        <label className="flex flex-col gap-1">
          شهر المصروف
          <input
            className={fieldClass}
            type="month"
            value={month}
            disabled={disabled}
            onChange={(event) => onMonthChange(event.target.value)}
          />
        </label>
      ) : null}
      {errors.month ? <p role="alert">{errors.month}</p> : null}
      {dated ? (
        <label className="flex flex-col gap-1">
          التاريخ
          <input
            className={fieldClass}
            type="date"
            value={values.date}
            min={monthEnd ? `${month}-01` : undefined}
            max={monthEnd}
            disabled={disabled}
            onChange={(event) => change({ date: event.target.value })}
          />
        </label>
      ) : null}
      {errors.date ? <p role="alert">{errors.date}</p> : null}
      {driver ? (
        <>
          <label className="flex flex-col gap-1">
            الساعات
            <input
              className={fieldClass}
              inputMode="decimal"
              autoComplete="off"
              value={values.hours}
              disabled={disabled}
              onChange={(event) => change({ hours: event.target.value })}
            />
          </label>
          {errors.hours ? <p role="alert">{errors.hours}</p> : null}
          <label className="flex flex-col gap-1">
            سعر الساعة
            <input
              className={fieldClass}
              inputMode="decimal"
              autoComplete="off"
              value={values.hourlyRate}
              disabled={disabled}
              onChange={(event) => change({ hourlyRate: event.target.value })}
            />
          </label>
          {errors.hourlyRate ? <p role="alert">{errors.hourlyRate}</p> : null}
          <label className="flex flex-col gap-1">
            اسم الطيار
            <input
              className={fieldClass}
              autoComplete="off"
              value={values.driverLabel}
              disabled={disabled}
              onChange={(event) => change({ driverLabel: event.target.value })}
            />
          </label>
          {errors.driverLabel ? <p role="alert">{errors.driverLabel}</p> : null}
          <label className="flex flex-col gap-1">
            المبلغ
            <output>{pay?.ok ? formatEgpText(pay.value) : '—'}</output>
          </label>
          {errors.amount ? <p role="alert">{errors.amount}</p> : null}
        </>
      ) : kind ? (
        <>
          <label className="flex flex-col gap-1">
            المبلغ
            <input
              className={fieldClass}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={errors.amount ? true : undefined}
              aria-describedby={errors.amount ? amountErrorId : undefined}
              value={values.amount}
              disabled={disabled}
              onChange={(event) => change({ amount: event.target.value })}
            />
          </label>
          {errors.amount ? (
            <p id={amountErrorId} role="alert">
              {errors.amount}
            </p>
          ) : null}
        </>
      ) : null}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={values.isEstimate}
          disabled={disabled}
          onChange={(event) => change({ isEstimate: event.target.checked })}
        />
        تقدير
      </label>
      <label className="flex flex-col gap-1">
        تاريخ الدفع
        <input
          className={fieldClass}
          type="date"
          value={values.paidOn}
          disabled={disabled}
          onChange={(event) => change({ paidOn: event.target.value })}
        />
      </label>
      {errors.paidOn ? <p role="alert">{errors.paidOn}</p> : null}
      <label className="flex flex-col gap-1">
        ملاحظة
        <textarea
          className={fieldClass}
          rows={3}
          value={values.note}
          disabled={disabled}
          onChange={(event) => change({ note: event.target.value })}
        />
      </label>
      {errors.note ? <p role="alert">{errors.note}</p> : null}
      <button className={primaryButton} type="submit" disabled={disabled}>
        حفظ المصروف
      </button>
    </form>
  );
}
