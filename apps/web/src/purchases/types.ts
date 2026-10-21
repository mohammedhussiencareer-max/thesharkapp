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
};

export type OpeningDraft = {
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
};

export type PurchaseDraft = {
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
