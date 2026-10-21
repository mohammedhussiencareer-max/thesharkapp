import type { BaseUnit, StockKind } from '@/items/types';

export type UnitOption = {
  unit: string;
  /** Exact `factor_to_base::text`. The base unit itself uses `"1"`. */
  factorToBase: string;
};

export type StockChoice = {
  id: string;
  name: string;
  kind: StockKind;
  baseUnit: BaseUnit;
  parentItemId: string | null;
  active: boolean;
  /** True when the item already has a balance row, which the ledger creates with the first movement. */
  hasMovements: boolean;
  conversions: UnitOption[];
};

export type OpeningLineDraft = {
  itemId: string;
  quantity: string;
  unit: string;
  unitCost: string;
  /** Base unit shown when the owner reviewed the line. */
  expectedBaseUnit: string;
  /** Exact factor shown when the owner reviewed the line. `"1"` for the base unit. */
  expectedFactor: string;
};

export type OpeningDraft = {
  requestId: string;
  occurredAt: string;
  lines: OpeningLineDraft[];
};

export type PurchaseLineDraft = {
  itemId: string;
  itemName: string;
  quantity: string;
  unit: string;
  amountPaid: string;
  baseUnit: BaseUnit;
  baseQuantity: string;
  unitCost: string;
  /** Exact factor shown on the review step. `"1"` when the unit is the base unit. */
  expectedFactor: string;
};

export type PurchaseDraft = {
  requestId: string;
  purchasedAt: string;
  supplier: string | null;
  invoiceNo: string | null;
  note: string | null;
  lines: PurchaseLineDraft[];
};

export type PurchaseLine = {
  lineNo: number;
  itemId: string;
  itemName: string;
  baseUnit: BaseUnit;
  quantity: string;
  unit: string;
  baseQuantity: string;
  amountPaid: string;
};

export type Purchase = {
  id: string;
  purchasedAt: string;
  supplier: string | null;
  invoiceNo: string | null;
  note: string | null;
  totalPaid: string;
  lines: PurchaseLine[];
};

export type PurchaseFilter = {
  from?: string;
  toExclusive?: string;
};
