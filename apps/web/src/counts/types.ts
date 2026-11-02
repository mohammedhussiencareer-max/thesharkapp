import type { Json } from '@/lib/database.types';
import type { BaseUnit } from '@/items/types';

export type CountItem = {
  id: string;
  name: string;
  /** Catalog base unit at the time this row was read. */
  baseUnit: BaseUnit;
  onHandQty: string;
  /** Ledger book value, numeric(14,2) text. A shortage prices from this, not qty × average. */
  onHandValue: string;
  avgCost: string;
};

export type CountLineDraft = {
  itemId: string;
  /** Catalog name when the draft was built. Display only; the RPC does not send it. */
  itemName?: string;
  countedQty: string;
  /** Base unit shown for this item when the line was counted. */
  expectedBaseUnit: BaseUnit;
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

export type CountWriteResult =
  { status: 'posted'; countId: string } | { status: 'waiting_for_sync' };

export type PendingCount = {
  requestId: string;
  preparedAt: string;
  countedAt: string;
  itemCount: number;
  /** Normalized body stored by the server. Resend it unchanged. */
  payload: Json;
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
