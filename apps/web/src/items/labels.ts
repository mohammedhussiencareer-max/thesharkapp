import type { BaseUnit, CountFrequency, StockKind } from '@/items/types';

export const kindLabels: Record<StockKind, string> = {
  fish_mixed: 'سمك مخلوط',
  fish_size: 'حجم سمك',
  seafood: 'مأكولات بحرية',
  ingredient: 'مكونات',
  packaging: 'تغليف',
};

export const unitLabels: Record<BaseUnit, string> = {
  kg: 'كيلو',
  piece: 'قطعة',
  liter: 'لتر',
};

export const frequencyLabels: Record<CountFrequency, string> = {
  daily: 'يومي',
  weekly: 'أسبوعي',
};

export const kindOptions = (
  ['fish_mixed', 'fish_size', 'seafood', 'ingredient', 'packaging'] as const
).map((value) => ({ value, label: kindLabels[value] }));

export const unitOptions = (['kg', 'piece', 'liter'] as const).map((value) => ({
  value,
  label: unitLabels[value],
}));

export const frequencyOptions = (['daily', 'weekly'] as const).map((value) => ({
  value,
  label: frequencyLabels[value],
}));

export function defaultsForKind(kind: StockKind): {
  baseUnit: BaseUnit;
  countFrequency: CountFrequency;
} {
  if (kind === 'fish_mixed' || kind === 'fish_size') {
    return { baseUnit: 'kg', countFrequency: 'daily' };
  }
  if (kind === 'packaging') {
    return { baseUnit: 'piece', countFrequency: 'weekly' };
  }
  return { baseUnit: 'kg', countFrequency: 'weekly' };
}
