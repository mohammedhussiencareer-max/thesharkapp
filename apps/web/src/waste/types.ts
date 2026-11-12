export const wasteReasons = ['staff_meal', 'spoilage', 'other'] as const;

export type WasteReason = (typeof wasteReasons)[number];

export function isWasteReason(value: unknown): value is WasteReason {
  return (
    typeof value === 'string' &&
    (wasteReasons as readonly string[]).includes(value)
  );
}

/** The reasons a stored document can carry, including the system-only one. */
export type StoredReason = WasteReason | 'cancel_after_preparation';

export function isStoredReason(value: unknown): value is StoredReason {
  return isWasteReason(value) || value === 'cancel_after_preparation';
}

export type WasteKind = 'record' | 'correction' | 'void';

export function isWasteKind(value: unknown): value is WasteKind {
  return value === 'record' || value === 'correction' || value === 'void';
}

export type WasteLineInput = {
  itemId: string;
  /** Decimal text, at most 6 fraction digits. */
  quantity: string;
  /** A unit code: the item's base unit, a metric unit or a dated conversion. */
  unit: string;
};

export type WasteDocumentInput =
  | {
      kind: 'record';
      occurredAt: string;
      reason: WasteReason;
      explanation: string | null;
      lines: WasteLineInput[];
    }
  | {
      kind: 'correction';
      /** The corrected document, as decimal text. */
      predecessorId: string;
      occurredAt: string;
      reason: WasteReason;
      explanation: string | null;
      lines: WasteLineInput[];
    }
  | { kind: 'void'; predecessorId: string };

export type WasteWrite = {
  requestId: string;
  document: WasteDocumentInput;
};

export type Differences = {
  stockQuantity: string;
  stockValue: string;
  cogs: string;
  waste: string;
  profit: string;
};

export type SavedLine = {
  lineNo: number;
  itemId: string;
  inputQuantity: string;
  inputUnit: string;
  factor: string;
  factorSource: string;
  baseUnit: string;
  baseQuantity: string;
};

export type WasteResult = {
  documentId: string;
  predecessorId: string | null;
  kind: WasteKind;
  occurredAt: string | null;
  reason: StoredReason | null;
  lines: SavedLine[];
  differences: Differences;
};

export type HistoryLine = {
  lineNo: number;
  itemId: string;
  name: string;
  inputQuantity: string;
  inputUnit: string;
  factor: string;
  factorSource: string;
  conversionVersionId: string | null;
  baseUnit: string;
  baseQuantity: string;
  value: string;
};

export type HistoryEntry = {
  /** Document id as decimal text. */
  id: string;
  requestId: string;
  occurredAt: string;
  reason: StoredReason;
  explanation: string | null;
  predecessorId: string | null;
  successorId: string | null;
  kind: WasteKind;
  isVoid: boolean;
  isCurrent: boolean;
  createdAt: string;
  value: string;
  lines: HistoryLine[];
};

export type WasteNotice =
  | { kind: 'saved'; result: WasteResult; warning: string | null }
  | { kind: 'failed'; message: string; itemIds?: readonly string[] };
