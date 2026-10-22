import { formatStoredFactor } from '@/items/format';
import { formatMoneyText } from '@/purchases/decimal';

export function formatKg(value: string): string {
  return `${formatStoredFactor(value)} كيلو`;
}

export function formatCostPerKg(value: string): string {
  return `${formatStoredFactor(value)} ج.م`;
}

export function formatLossMoney(value: string): string {
  return formatMoneyText(value);
}
