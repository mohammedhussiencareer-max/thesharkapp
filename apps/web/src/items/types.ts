export const stockKinds = [
  'fish_mixed',
  'fish_size',
  'seafood',
  'ingredient',
  'packaging',
] as const;

export type StockKind = (typeof stockKinds)[number];

export const baseUnits = ['kg', 'piece', 'liter'] as const;

export type BaseUnit = (typeof baseUnits)[number];

export const countFrequencies = ['daily', 'weekly'] as const;

export type CountFrequency = (typeof countFrequencies)[number];

export type CatalogItem = {
  id: string;
  name: string;
  kind: StockKind;
  baseUnit: BaseUnit;
  countFrequency: CountFrequency;
  lossPct: number;
  /** Exact `loss_pct` value read from PostgREST, used as the update filter. */
  storedLossPct: number | string;
  parentItemId: string | null;
  active: boolean;
  onHandQty: number;
  avgCost: number;
  onHandValue: number;
};

export type ItemDraft = {
  name: string;
  kind: StockKind;
  baseUnit: BaseUnit;
  countFrequency: CountFrequency;
  lossPct: number;
  parentItemId: string | null;
  active: boolean;
};

export type UnitConversion = {
  itemId: string;
  unit: string;
  factorToBase: number;
  /** Exact `factor_to_base` value read from PostgREST, used as the write filter. */
  storedFactor: number | string;
};

export function isStockKind(value: string): value is StockKind {
  return (stockKinds as readonly string[]).includes(value);
}

export function isBaseUnit(value: string): value is BaseUnit {
  return (baseUnits as readonly string[]).includes(value);
}

export function isCountFrequency(value: string): value is CountFrequency {
  return (countFrequencies as readonly string[]).includes(value);
}
