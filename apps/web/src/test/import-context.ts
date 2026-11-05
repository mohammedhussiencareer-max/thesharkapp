import type { ImportContext } from '@/recipes/import/model';
import type { StockOption } from '@/recipes/types';

export const unitMeta = [
  { code: 'g', labelAr: 'جرام', dimension: 'mass', metricScale: 1 },
  { code: 'kg', labelAr: 'كيلو', dimension: 'mass', metricScale: 1000 },
  { code: 'ml', labelAr: 'مللي', dimension: 'volume', metricScale: 1 },
  { code: 'liter', labelAr: 'لتر', dimension: 'volume', metricScale: 1000 },
  { code: 'piece', labelAr: 'قطعة', dimension: 'count', metricScale: null },
];

export const stockItems: StockOption[] = [
  {
    id: 'item-salt',
    name: 'ملح',
    kind: 'ingredient',
    baseUnit: 'kg',
    active: true,
  },
  {
    id: 'item-rice',
    name: 'ارز خام',
    kind: 'ingredient',
    baseUnit: 'kg',
    active: true,
  },
  {
    id: 'item-box',
    name: 'علبة',
    kind: 'packaging',
    baseUnit: 'piece',
    active: true,
  },
  {
    id: 'item-old',
    name: 'بصل',
    kind: 'ingredient',
    baseUnit: 'kg',
    active: false,
  },
];

export function importContext(
  overrides: Partial<ImportContext> = {},
): ImportContext {
  return {
    stock: stockItems,
    recipes: [],
    batches: [],
    itemUnits: [
      { itemId: 'item-salt', unit: 'g', label: 'جرام' },
      { itemId: 'item-salt', unit: 'kg', label: 'كيلو' },
      { itemId: 'item-rice', unit: 'g', label: 'جرام' },
      { itemId: 'item-rice', unit: 'kg', label: 'كيلو' },
    ],
    units: unitMeta,
    shiftStart: null,
    bindings: [],
    knownHashes: [],
    ...overrides,
  };
}
