import { mapExpenseError, retrySafeMessage } from '@/expenses/errors';
import { markSuperseded } from '@/expenses/status';
import {
  isExpenseKind,
  type AllocationDay,
  type ExpenseCategory,
  type ExpenseDraft,
  type ExpenseLine,
  type ExpenseMonth,
} from '@/expenses/types';
import { genericCatalogError } from '@/items/errors';
import { monthEndIso } from '@/lib/cairo';
import type { Database } from '@/lib/database.types';
import { exactDecimal, exactDecimalOrNull } from '@/lib/decimal';
import { fetchAllPages, PageCapError } from '@/lib/paged';
import { supabase } from '@/lib/supabase';

const categoryColumns = 'id, name, kind, active';

const lineColumns =
  'id, category_id, category_name, category_kind, amount_text:amount::text, period_month, expense_date, paid_on, is_estimate, note, hours_text:hours::text, hourly_rate_text:hourly_rate::text, driver_label, created_at, void_id, void_reason';

const dayColumns =
  'date, fixed_share_text:fixed_share::text, daily_total_text:daily_total::text, driver_total_text:driver_total::text, interest_text:interest::text, depreciation_text:depreciation::text, total_text:total::text';

type EntryArgs = Database['app']['Functions']['add_expense_entry']['Args'];

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

function throwIfError(error: { message?: string } | null): void {
  if (error) throw new Error(mapExpenseError(error));
}

async function readPages<T extends object>(
  load: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: T[] | null;
    error: { message?: string } | null;
  }>,
  keyOf: (row: T) => string,
): Promise<T[]> {
  try {
    return await fetchAllPages(async (from, to) => {
      const result = await load(from, to);
      throwIfError(result.error);
      return { data: result.data, error: null };
    }, keyOf);
  } catch (error) {
    if (error instanceof PageCapError) {
      throw new Error(genericCatalogError, { cause: error });
    }
    throw error;
  }
}

function pageKey(row: object, field: string): string {
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(genericCatalogError);
  }
  return value;
}

async function writeEntry(
  call: () => PromiseLike<{ error: { message?: string } | null }>,
): Promise<void> {
  let result: { error: { message?: string } | null };
  try {
    result = await call();
  } catch (error) {
    throw new Error(retrySafeMessage, { cause: error });
  }
  if (!result.error) return;
  const mapped = mapExpenseError(result.error);
  if (mapped === genericCatalogError) {
    throw new Error(retrySafeMessage, { cause: result.error });
  }
  throw new Error(mapped);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(genericCatalogError);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(genericCatalogError);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(genericCatalogError);
  const text = value.trim();
  return text === '' ? null : text;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(genericCatalogError);
  return value;
}

function optionalDate(value: unknown): string | null {
  if (value === null) return null;
  return requiredDate(value);
}

function requiredDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(genericCatalogError);
  }
  return value;
}

function monthStartOrThrow(monthStart: string): string {
  if (!/^\d{4}-\d{2}-01$/.test(monthStart)) {
    throw new Error('الشهر مش مظبوط');
  }
  return monthStart;
}

/** PostgREST accepts a JSON decimal string for a numeric argument. */
function numericParam(value: string): number {
  return value as unknown as number;
}

function mapCategory(value: unknown): ExpenseCategory {
  const row = asRecord(value);
  const kind = row.kind;
  if (!isExpenseKind(kind)) throw new Error(genericCatalogError);
  return {
    id: requiredString(row.id),
    name: requiredString(row.name),
    kind,
    active: requiredBoolean(row.active),
  };
}

function mapLine(value: unknown): ExpenseLine {
  const row = asRecord(value);
  const kind = row.category_kind;
  if (!isExpenseKind(kind)) throw new Error(genericCatalogError);
  const voidId = optionalString(row.void_id);
  return {
    id: requiredString(row.id),
    categoryId: requiredString(row.category_id),
    categoryName: requiredString(row.category_name),
    categoryKind: kind,
    amount: exactDecimal(row.amount_text, genericCatalogError),
    periodMonth: optionalDate(row.period_month),
    expenseDate: optionalDate(row.expense_date),
    paidOn: optionalDate(row.paid_on),
    isEstimate: requiredBoolean(row.is_estimate),
    note: optionalString(row.note),
    hours: exactDecimalOrNull(row.hours_text, genericCatalogError),
    hourlyRate: exactDecimalOrNull(row.hourly_rate_text, genericCatalogError),
    driverLabel: optionalString(row.driver_label),
    createdAt: requiredString(row.created_at),
    voided: voidId !== null,
    voidReason: optionalString(row.void_reason),
    superseded: false,
  };
}

function mapDay(value: unknown): AllocationDay {
  const row = asRecord(value);
  return {
    date: requiredDate(row.date),
    fixedShare: exactDecimal(row.fixed_share_text, genericCatalogError),
    dailyTotal: exactDecimal(row.daily_total_text, genericCatalogError),
    driverTotal: exactDecimal(row.driver_total_text, genericCatalogError),
    interest: exactDecimal(row.interest_text, genericCatalogError),
    depreciation: exactDecimal(row.depreciation_text, genericCatalogError),
    total: exactDecimal(row.total_text, genericCatalogError),
  };
}

export async function loadExpenseMonth(
  monthStart: string,
): Promise<ExpenseMonth> {
  const month = monthStartOrThrow(monthStart);
  const monthEnd = monthEndIso(month);
  const db = appDb();
  // Page by an immutable unique key, then sort for display. A rename must not
  // repeat one category and drop another. period_month and expense_date do not
  // change after insert, so those filters stay on the query. date is the whole
  // key of a day row.
  const [categoryRows, lineRows, dayRows, statusResult] = await Promise.all([
    readPages(
      (from, to) =>
        db
          .from('expense_categories')
          .select(categoryColumns)
          .order('id', { ascending: true })
          .range(from, to),
      (row) => pageKey(row, 'id'),
    ),
    readPages(
      (from, to) =>
        db
          .from('expense_lines')
          .select(lineColumns)
          .or(
            `period_month.eq.${month},and(expense_date.gte.${month},expense_date.lte.${monthEnd})`,
          )
          .order('id', { ascending: true })
          .range(from, to),
      (row) => pageKey(row, 'id'),
    ),
    readPages(
      (from, to) =>
        db
          .rpc('expense_daily', { p_from: month, p_to: monthEnd })
          .select(dayColumns)
          .order('date', { ascending: true })
          .range(from, to),
      (row) => pageKey(row, 'date'),
    ),
    db
      .from('month_expense_status')
      .select('month, complete, confirmed_at, confirmed_by')
      .eq('month', month)
      .maybeSingle(),
  ]);
  throwIfError(statusResult.error);
  const status = statusResult.data;

  const categories = categoryRows.map((row) => mapCategory(row));
  categories.sort(
    (left, right) =>
      left.name.localeCompare(right.name, 'ar') ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const lines = lineRows.map((row) => mapLine(row));
  lines.sort((left, right) => {
    const created = right.createdAt.localeCompare(left.createdAt);
    if (created !== 0) return created;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
  });
  const days = dayRows.map((row) => mapDay(row));
  days.sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );

  return {
    monthStart: month,
    categories,
    entries: markSuperseded(lines),
    days,
    complete: status ? requiredBoolean(status.complete) : false,
    confirmedAt: status ? optionalString(status.confirmed_at) : null,
  };
}

export async function addExpenseEntry(draft: ExpenseDraft): Promise<void> {
  const args: EntryArgs = {
    p_category_id: draft.categoryId,
    p_is_estimate: draft.isEstimate,
    p_request_id: draft.requestId,
  };
  if (draft.amount !== null && draft.hours === null) {
    args.p_amount = numericParam(draft.amount);
  }
  if (draft.periodMonth !== null) args.p_period_month = draft.periodMonth;
  if (draft.expenseDate !== null) args.p_expense_date = draft.expenseDate;
  if (draft.paidOn !== null) args.p_paid_on = draft.paidOn;
  if (draft.note !== null) args.p_note = draft.note;
  if (draft.hours !== null) args.p_hours = numericParam(draft.hours);
  if (draft.hourlyRate !== null) {
    args.p_hourly_rate = numericParam(draft.hourlyRate);
  }
  if (draft.driverLabel !== null) args.p_driver_label = draft.driverLabel;
  await writeEntry(() => appDb().rpc('add_expense_entry', args));
}

export async function voidExpenseEntry(
  id: string,
  reason: string,
  requestId: string,
): Promise<void> {
  await writeEntry(() =>
    appDb().rpc('void_expense_entry', {
      p_id: id,
      p_reason: reason,
      p_request_id: requestId,
    }),
  );
}

export async function setMonthExpenseComplete(
  monthStart: string,
  complete: boolean,
): Promise<void> {
  const { error } = await appDb().rpc('set_month_expense_complete', {
    p_month: monthStartOrThrow(monthStart),
    p_complete: complete,
  });
  throwIfError(error);
}

export async function addExpenseCategory(
  name: string,
  kind: string,
): Promise<void> {
  const { error } = await appDb().rpc('add_expense_category', {
    p_name: name,
    p_kind: kind,
  });
  throwIfError(error);
}

export async function renameExpenseCategory(
  id: string,
  name: string,
): Promise<void> {
  const { error } = await appDb().rpc('rename_expense_category', {
    p_id: id,
    p_name: name,
  });
  throwIfError(error);
}

export async function setExpenseCategoryActive(
  id: string,
  active: boolean,
): Promise<void> {
  const { error } = await appDb().rpc('set_expense_category_active', {
    p_id: id,
    p_active: active,
  });
  throwIfError(error);
}
