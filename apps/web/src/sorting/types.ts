export type SizeChoice = {
  id: string;
  name: string;
};

/** An active mixed-fish item and the active sizes that belong to it. */
export type MixedFish = {
  id: string;
  name: string;
  onHandQty: string;
  avgCost: string;
  hasUncoveredDeficit: boolean;
  sizes: SizeChoice[];
};

export type SortLineDraft = {
  itemId: string;
  quantity: string;
};

export type SortDraft = {
  requestId: string;
  mixedItemId: string;
  occurredAt: string;
  qtyTaken: string;
  note: string | null;
  lines: SortLineDraft[];
};

export type SortValues = {
  occurredAt: string;
  mixedItemId: string;
  qtyTaken: string;
  note: string;
  quantities: Record<string, string>;
};

export type SortLine = {
  lineNo: number;
  itemId: string;
  itemName: string;
  quantity: string;
};

export type SortRecord = {
  id: string;
  mixedItemId: string;
  mixedItemName: string;
  occurredAt: string;
  createdAt: string;
  note: string | null;
  qtyTaken: string;
  sizesQty: string;
  lossQty: string;
  lossValue: string;
  costPerKg: string;
  lines: SortLine[];
};

export type SortFilter = {
  from?: string;
  toExclusive?: string;
};
