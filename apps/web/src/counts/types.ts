export type CountItem = {
  id: string;
  name: string;
  onHandQty: string;
  /** Ledger book value, numeric(14,2) text. A shortage prices from this, not qty × average. */
  onHandValue: string;
  avgCost: string;
};

export type CountLineDraft = {
  itemId: string;
  countedQty: string;
};

export type CountDraft = {
  requestId: string;
  countedAt: string;
  note: string | null;
  lines: CountLineDraft[];
};

export type CountValues = {
  countedAt: string;
  note: string;
  quantities: Record<string, string>;
};

export type CountRecord = {
  id: string;
  countedAt: string;
  frequency: 'daily' | 'weekly';
  createdAt: string;
  note: string | null;
  itemCount: number;
  shortageValue: string;
  surplusValue: string;
  hasSurplus: boolean;
};
