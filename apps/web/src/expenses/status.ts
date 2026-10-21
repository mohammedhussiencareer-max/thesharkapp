import type { ExpenseLine } from '@/expenses/types';

function periodKey(
  line: Pick<ExpenseLine, 'categoryId' | 'periodMonth' | 'expenseDate'>,
): string {
  return `${line.categoryId}\u0000${line.periodMonth ?? ''}\u0000${line.expenseDate ?? ''}`;
}

/** Estimates stop counting while a live actual exists for the same category and period. */
export function markSuperseded(lines: readonly ExpenseLine[]): ExpenseLine[] {
  const actuals = new Set(
    lines
      .filter((line) => !line.voided && !line.isEstimate)
      .map((line) => periodKey(line)),
  );
  return lines.map((line) => ({
    ...line,
    superseded: !line.voided && line.isEstimate && actuals.has(periodKey(line)),
  }));
}

export function entryStatusLabel(
  line: Pick<ExpenseLine, 'voided' | 'superseded' | 'isEstimate'>,
): string {
  if (line.voided) return 'ملغي';
  if (line.superseded) return 'التقدير اتلغى بالفاتورة';
  if (line.isEstimate) return 'تقدير';
  return 'فاتورة';
}
