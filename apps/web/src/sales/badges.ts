import { formatEgpText, moneyAbsAtMost } from '@/lib/money';
import type { ShiftSummary } from '@/sales/types';

/**
 * An open shift wins, then a missing drawer, then a match within one piaster.
 * Anything wider is the signed drawer difference.
 */
export function reconciliationBadge(
  shift: Pick<ShiftSummary, 'isActive' | 'drawerDifference'>,
): string {
  if (shift.isActive) return 'الوردية مفتوحة';
  if (shift.drawerDifference === null) return 'مفيش أرقام درج';
  if (moneyAbsAtMost(shift.drawerDifference, 1n)) return 'مطابق للدرج';
  return `فرق مع الدرج: ${formatEgpText(shift.drawerDifference)}`;
}

export function unknownTxLabel(unknownTx: number): string | null {
  if (unknownTx > 0) return 'حركات درج غير معروفة';
  return null;
}
