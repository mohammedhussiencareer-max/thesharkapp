import { genericCatalogError, ConfirmedRefusalError } from '@/items/errors';
import type { Json } from '@/lib/database.types';
import { exactDecimal } from '@/lib/decimal';
import { keysAfterFilter, readAllByKeys } from '@/lib/paged';
import { supabase } from '@/lib/supabase';
import { isDefiniteRefusal, isPayloadRefusal } from '@/lib/write-outcome';
import {
  mapDecisionError,
  OrderChangedError,
  orderChangedServerMessage,
} from '@/order-decisions/errors';
import {
  isBasisStatus,
  isDecision,
  isDecisionClass,
  isDecisionSource,
  isReviewReason,
  type BasisItem,
  type DecisionResult,
  type DecisionWrite,
  type Differences,
  type HistoryEntry,
  type QueueFilter,
  type QueueRow,
  type RefundRef,
  type ReturnedLine,
  type UnlinkedRefund,
} from '@/order-decisions/types';

/** Rows per keyset page on the decision screen. */
export const queuePageSize = 25;

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
  if (error.code === '40001' && error.message === orderChangedServerMessage) {
    throw new OrderChangedError();
  }
  const message = mapDecisionError(error);
  if (isPayloadRefusal(error)) throw new ConfirmedRefusalError(message);
  const mapped = new Error(message);
  if (isDefiniteRefusal(error)) Object.assign(mapped, { code: error.code });
  throw mapped;
}

function nullableText(value: string | null): string {
  return value as unknown as string;
}

function nullableJson(value: Json | null): Json {
  return value;
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
  if (typeof value !== 'string') bad();
  return value;
}

function count(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return bad();
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

function returnedOf(value: unknown): ReturnedLine[] {
  return list(value).map((line) => ({
    stockItemId: text(line.stock_item_id),
    returned: decimal(line.returned),
  }));
}

function basisItemOf(row: Record<string, unknown>): BasisItem {
  return {
    stockItemId: text(row.stock_item_id),
    name: textOrNull(row.name) ?? text(row.stock_item_id),
    baseUnit: textOrNull(row.base_unit) ?? '',
    quantity: decimal(row.quantity),
  };
}

function refundOf(row: Record<string, unknown>): RefundRef {
  return {
    shiftId: text(row.shift_id),
    txId: text(row.tx_id),
    amount: decimal(row.amount),
    occurredAt: text(row.occurred_at),
  };
}

function historyOf(row: Record<string, unknown>): HistoryEntry {
  const decision = row.decision;
  const decisionClass = row.class;
  const source = row.source;
  if (
    !isDecision(decision) ||
    !isDecisionClass(decisionClass) ||
    !isDecisionSource(source) ||
    typeof row.owner_reviewed !== 'boolean'
  ) {
    return bad();
  }
  return {
    eventId: count(row.event_id),
    episode: count(row.episode),
    decision,
    decisionClass,
    source,
    ownerReviewed: row.owner_reviewed,
    reason: textOrNull(row.reason),
    createdAt: text(row.created_at),
    returned: returnedOf(row.returned),
    differences: differencesOf(row.differences),
  };
}

export const queueColumns =
  'order_id, episode, current_class, decided_class, review_reason, token, needs_decision, event_id, decision, source, owner_reviewed, decision_reason, decided_at, order_number, ordered_at, order_status, missing_from_pos, order_total, decided_order_total, refund_total, decided_refund_total, basis_status, basis_items, refunds, returned, differences, history';

export function rowOf(value: unknown): QueueRow {
  const row = record(value);
  const currentClass = row.current_class;
  const decidedClass = row.decided_class;
  const reviewReason = row.review_reason;
  const decision = row.decision;
  const source = row.source;
  const basisStatus = row.basis_status;
  if (
    (currentClass !== null && !isDecisionClass(currentClass)) ||
    !isDecisionClass(decidedClass) ||
    (reviewReason !== null && !isReviewReason(reviewReason)) ||
    !isDecision(decision) ||
    !isDecisionSource(source) ||
    !isBasisStatus(basisStatus) ||
    typeof row.owner_reviewed !== 'boolean' ||
    typeof row.needs_decision !== 'boolean' ||
    typeof row.missing_from_pos !== 'boolean'
  ) {
    return bad();
  }
  return {
    orderId: text(row.order_id),
    episode: count(row.episode),
    currentClass: currentClass ?? null,
    decidedClass,
    reviewReason: reviewReason ?? null,
    token: text(row.token),
    needsDecision: row.needs_decision,
    eventId: count(row.event_id),
    decision,
    source,
    ownerReviewed: row.owner_reviewed,
    decisionReason: textOrNull(row.decision_reason),
    decidedAt: text(row.decided_at),
    orderNumber:
      row.order_number === null || row.order_number === undefined
        ? null
        : count(row.order_number),
    orderedAt: text(row.ordered_at),
    orderStatus: text(row.order_status),
    missingFromPos: row.missing_from_pos,
    orderTotal: decimal(row.order_total),
    decidedOrderTotal: decimal(row.decided_order_total),
    refundTotal:
      row.refund_total === null || row.refund_total === undefined
        ? null
        : decimal(row.refund_total),
    decidedRefundTotal: decimal(row.decided_refund_total),
    basisStatus,
    basisItems: list(row.basis_items).map(basisItemOf),
    refunds: list(row.refunds).map(refundOf),
    returned: returnedOf(row.returned),
    differences: differencesOf(row.differences),
    history: list(row.history).map(historyOf),
  };
}

export type QueuePage = {
  rows: QueueRow[];
  /** The order id to page after, or null when this page was the last. */
  next: string | null;
};

/**
 * One keyset page of the decision queue, ordered by order id. `after` is the
 * last order id of the previous page, so a row that leaves the filter between
 * pages cannot push another out of reach.
 */
export async function loadQueuePage(
  filter: QueueFilter,
  after: string | null,
  size: number = queuePageSize,
): Promise<QueuePage> {
  let query = appDb().from('order_decision_queue').select(queueColumns);
  if (filter === 'pending') query = query.eq('needs_decision', true);
  if (after !== null) query = query.gt('order_id', after);
  const { data, error } = await query.order('order_id').limit(size);
  if (error || !Array.isArray(data)) throw new Error(genericCatalogError);
  const rows = data.map(rowOf);
  const last = rows[rows.length - 1];
  return { rows, next: rows.length === size && last ? last.orderId : null };
}

/** One order's current row, or null once its episode has closed. */
export async function loadQueueRow(orderId: string): Promise<QueueRow | null> {
  const { data, error } = await appDb()
    .from('order_decision_queue')
    .select(queueColumns)
    .eq('order_id', orderId)
    .limit(1);
  if (error || !Array.isArray(data)) throw new Error(genericCatalogError);
  const first: unknown = data[0];
  return first === undefined ? null : rowOf(first);
}

const unlinkedKeys = ['shift_id', 'tx_id'] as const;

export async function loadUnlinkedRefunds(): Promise<UnlinkedRefund[]> {
  const rows = await readAllByKeys<
    {
      shift_id: string;
      tx_id: string;
      amount: string;
      occurred_at: string;
    },
    'shift_id' | 'tx_id'
  >(
    unlinkedKeys,
    (after, size) => {
      const query = appDb()
        .from('unlinked_refunds')
        .select('shift_id, tx_id, amount, occurred_at');
      return (
        after === null ? query : query.or(keysAfterFilter(unlinkedKeys, after))
      )
        .order('shift_id')
        .order('tx_id')
        .limit(size);
    },
    genericCatalogError,
  );
  return rows.map((row) => ({
    shiftId: text(row.shift_id),
    txId: text(row.tx_id),
    amount: decimal(row.amount),
    occurredAt: text(row.occurred_at),
  }));
}

function returnedJson(lines: readonly ReturnedLine[] | null): Json | null {
  if (lines === null) return null;
  return lines.map((line) => ({
    stock_item_id: line.stockItemId,
    returned: line.returned,
  }));
}

export function resultOf(value: unknown): DecisionResult {
  const row = record(value);
  if (row.status === 'not_activated') return { status: 'not_activated' };
  if (row.status !== 'ok') return bad();
  const decision = row.decision;
  const decisionClass = row.class;
  if (!isDecision(decision) || !isDecisionClass(decisionClass)) return bad();
  return {
    status: 'ok',
    orderId: text(row.order_id),
    eventId: count(row.event_id),
    decision,
    decisionClass,
    outcome: text(row.outcome),
    reason: textOrNull(row.reason),
    differences: differencesOf(row.differences),
  };
}

export async function setOrderDisposition(
  write: DecisionWrite,
): Promise<DecisionResult> {
  const { data, error } = await appDb().rpc('set_order_disposition', {
    p_request_id: write.requestId,
    p_order_id: write.orderId,
    p_decision: write.decision,
    p_token: write.token,
    p_reason: nullableText(write.reason),
    p_returned: nullableJson(returnedJson(write.returned)),
  });
  throwIfError(error);
  return resultOf(data);
}
