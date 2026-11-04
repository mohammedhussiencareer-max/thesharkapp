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
  /** Null when no loss is approved. Zero is an approved loss, not "unset". */
  lossPct: number | null;
  /** Exact current loss fraction text. Null when `lossPct` is null. */
  lossFractionText?: string | null;
  /** Kind, base unit, and parent are frozen once the item is configured or has moved. */
  identityLocked?: boolean;
  openingPriceId?: string | null;
  /** Exact current opening unit cost text. */
  openingPriceText?: string | null;
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
  /** Exact loss fraction text. Null leaves the loss unset on create. */
  lossPct: string | null;
  parentItemId: string | null;
  active: boolean;
  /** Set on edit when the approved loss changes. Create uses `lossPct` only. */
  lossWrite?: DatedWrite | null;
  openingWrite?: {
    price: string;
    reason: string | null;
    expectedId: string | null;
    requestId: string;
  } | null;
};

export type UnitSource = 'base' | 'explicit' | 'implicit';

export type UnitConversion = {
  itemId: string;
  /** Unit code sent to the ledger. */
  unit: string;
  /** Arabic label shown in the picker. Falls back to `unit`. */
  label?: string;
  factorToBase: number;
  /** Exact factor text. */
  storedFactor: number | string;
  source?: UnitSource;
  effectiveFrom?: string | null;
  versionId?: string | null;
};

export type UnitCatalogOption = {
  code: string;
  labelAr: string;
};

export type CostingVersion = {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  valueText: string;
};

export type CostingSchedule = {
  lossToken: string;
  /**
   * Token of an empty schedule for this item. It binds base unit, kind, and
   * parent. Absent only in tests that never load a schedule response.
   */
  emptyToken?: string;
  /**
   * `base_unit|kind|parent_item_id|` for this item. Absent only in tests that
   * never load a schedule response.
   */
  identity?: string;
  lossVersions: CostingVersion[];
  conversions: {
    unitCode: string;
    token: string;
    versions: CostingVersion[];
  }[];
};

export type CostingImpact = {
  orders: number;
  shifts: number;
  movements: number | null;
};

export type DatedWrite = {
  effectiveFrom: string | null;
  effectiveTo: string | null;
  token: string;
  reason: string | null;
  requestId: string;
};

/** One editor action. Each kind performs exactly one write. */
export type ItemSave =
  | { kind: 'create'; draft: ItemDraft }
  | { kind: 'details'; draft: ItemDraft }
  | { kind: 'loss'; lossPct: string; write: DatedWrite }
  | {
      kind: 'price';
      price: string;
      reason: string | null;
      expectedId: string | null;
      identity: string;
      requestId: string;
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
