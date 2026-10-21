import { formatStoredFactor } from '@/items/format';
import type { SalesOrderLine } from '@/sales/types';

/** Quantity for a fixed line, or weight plus unit for a weighted line. */
export function formatLineQty(
  line: Pick<SalesOrderLine, 'quantity' | 'weightedQty' | 'weightedUnit'>,
): string {
  if (line.weightedQty !== null) {
    const weight = formatStoredFactor(line.weightedQty);
    return line.weightedUnit ? `${weight} ${line.weightedUnit}` : weight;
  }
  return formatStoredFactor(line.quantity);
}
