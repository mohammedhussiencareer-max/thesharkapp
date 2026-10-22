import { formatStoredFactor } from '@/items/format';
import { formatMoneyText } from '@/purchases/decimal';

export function formatQty(value: string): string {
  return formatStoredFactor(value);
}

/** Signed piaster text. A leading minus is kept; the magnitude uses the money formatter. */
export function formatSignedMoney(value: string): string {
  if (value.startsWith('-')) return `-${formatMoneyText(value.slice(1))}`;
  return formatMoneyText(value);
}

export function formatFrequency(frequency: string): string {
  if (frequency === 'daily') return 'يومي';
  if (frequency === 'weekly') return 'أسبوعي';
  return frequency;
}
