import { ConfirmedRefusalError, genericCatalogError } from '@/items/errors';
import type { Json } from '@/lib/database.types';
import { exactDecimal } from '@/lib/decimal';
import { supabase } from '@/lib/supabase';
import { isDefiniteRefusal, isPayloadRefusal } from '@/lib/write-outcome';
import {
  AlreadyCorrectedError,
  blockedItemIds,
  isAlreadyCorrected,
  isMissingCostBasis,
  isNotActivated,
  mapWasteError,
  MissingCostBasisError,
  notActivatedMessage,
} from '@/waste/errors';
import {
  isStoredReason,
  isWasteKind,
  type Differences,
  type HistoryEntry,
  type HistoryLine,
  type SavedLine,
  type WasteDocumentInput,
  type WasteResult,
  type WasteWrite,
} from '@/waste/types';

/** Rows per keyset page of the history. */
export const historyPageSize = 20;

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

type PostgrestError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

function throwIfError(error: PostgrestError | null): void {
  if (!error) return;
  if (isAlreadyCorrected(error)) throw new AlreadyCorrectedError();
  if (isMissingCostBasis(error)) {
    throw new MissingCostBasisError(blockedItemIds(error));
  }
  if (isNotActivated(error))
    throw new ConfirmedRefusalError(notActivatedMessage);
  const message = mapWasteError(error);
  if (isPayloadRefusal(error)) throw new ConfirmedRefusalError(message);
  const mapped = new Error(message);
  if (isDefiniteRefusal(error)) Object.assign(mapped, { code: error.code });
  throw mapped;
}

function bad(): never {
  throw new Error(genericCatalogError);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
  return value as Record<string, unknown>;
}

function list(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) bad();
  return (value as unknown[]).map(record);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) bad();
  return value;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return text(value);
}

function count(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return bad();
}

/** A bigint id as decimal text; a number is accepted only when it is exact. */
function idText(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (
    typeof value === 'string' &&
    /^[1-9]\d{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  ) {
    return value;
  }
  return bad();
}

function idOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : idText(value);
}

function decimal(value: unknown): string {
  return exactDecimal(value, genericCatalogError);
}

function differencesOf(value: unknown): Differences {
  const row = record(value);
  return {
    stockQuantity: decimal(row.stock_quantity),
    stockValue: decimal(row.stock_value),
    cogs: decimal(row.cogs),
    waste: decimal(row.waste),
    profit: decimal(row.profit),
  };
}

function savedLineOf(row: Record<string, unknown>): SavedLine {
  return {
    lineNo: count(row.line_no),
    itemId: text(row.item_id),
    inputQuantity: decimal(row.input_quantity),
    inputUnit: text(row.input_unit),
    factor: decimal(row.factor),
    factorSource: text(row.factor_source),
    baseUnit: text(row.base_unit),
    baseQuantity: decimal(row.base_quantity),
  };
}

function historyLineOf(row: Record<string, unknown>): HistoryLine {
  return {
    ...savedLineOf(row),
    name: text(row.name),
    conversionVersionId: textOrNull(row.conversion_version_id),
    value: decimal(row.value),
  };
}

export const historyColumns =
  'id, request_id, occurred_at, reason_code, explanation, predecessor_id, successor_id, kind, is_void, is_current, created_at, value, lines';

export function entryOf(value: unknown): HistoryEntry {
  const row = record(value);
  const reason = row.reason_code;
  const kind = row.kind;
  if (
    !isStoredReason(reason) ||
    !isWasteKind(kind) ||
    typeof row.is_void !== 'boolean' ||
    typeof row.is_current !== 'boolean'
  ) {
    return bad();
  }
  return {
    id: idText(row.id),
    requestId: text(row.request_id),
    occurredAt: text(row.occurred_at),
    reason,
    explanation: textOrNull(row.explanation),
    predecessorId: idOrNull(row.predecessor_id),
    successorId: idOrNull(row.successor_id),
    kind,
    isVoid: row.is_void,
    isCurrent: row.is_current,
    createdAt: text(row.created_at),
    value: decimal(row.value),
    lines: list(row.lines).map(historyLineOf),
  };
}

export type HistoryPage = {
  entries: HistoryEntry[];
  /** The id to page after, or null when this page was the last. */
  next: string | null;
};

/**
 * One keyset page of the history, newest first. `after` is the last id of the
 * previous page, so a document stored between pages cannot shift a row.
 */
export async function loadHistoryPage(
  after: string | null,
  size: number = historyPageSize,
): Promise<HistoryPage> {
  let query = appDb().from('waste_history').select(historyColumns);
  if (after !== null) query = query.lt('id', Number(after));
  const { data, error } = await query
    .order('id', { ascending: false })
    .limit(size);
  if (error || !Array.isArray(data)) throw new Error(genericCatalogError);
  const entries = data.map(entryOf);
  const last = entries[entries.length - 1];
  return { entries, next: entries.length === size && last ? last.id : null };
}

export function resultOf(value: unknown): WasteResult {
  const row = record(value);
  if (row.status !== 'ok') return bad();
  const kind = row.kind;
  const reason = row.reason_code;
  if (!isWasteKind(kind) || (reason !== null && !isStoredReason(reason))) {
    return bad();
  }
  return {
    documentId: idText(row.document_id),
    predecessorId: idOrNull(row.predecessor_id),
    kind,
    occurredAt: textOrNull(row.occurred_at),
    reason: reason ?? null,
    lines: list(row.lines).map(savedLineOf),
    differences: differencesOf(row.differences),
  };
}

export function documentJson(document: WasteDocumentInput): Json {
  if (document.kind === 'void') {
    return { predecessor_id: document.predecessorId, lines: [] };
  }
  return {
    ...(document.kind === 'correction'
      ? { predecessor_id: document.predecessorId }
      : {}),
    occurred_at: document.occurredAt,
    reason_code: document.reason,
    explanation: document.explanation,
    lines: document.lines.map((line) => ({
      item_id: line.itemId,
      quantity: line.quantity,
      unit: line.unit,
    })),
  };
}

export async function recordWaste(write: WasteWrite): Promise<WasteResult> {
  const { data, error } = await appDb().rpc('record_waste', {
    p_request_id: write.requestId,
    p_document: documentJson(write.document),
  });
  throwIfError(error);
  return resultOf(data);
}
