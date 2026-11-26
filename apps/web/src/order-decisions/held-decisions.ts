import { hasAction, unknownAction } from '@/items/request-id';
import { listHeldWritesByPrefix } from '@/lib/held-writes';
import { decisionSubject } from '@/order-decisions/format';
import type { DecisionWrite } from '@/order-decisions/types';

const DECISION_PREFIX = 'order-decision:';
const started = new Set<string>();

/** Remember an order whose decision was sent, so a lost answer can be retried. */
export function noteDecisionOrder(orderId: string): void {
  started.add(orderId);
}

/**
 * Decisions whose last save might already be stored, whether or not the order
 * is still in the queue (a closing decision removes it). Reads persisted held
 * writes so a lost decision survives page reload.
 */
export function unknownDecisions(): DecisionWrite[] {
  const byOrder = new Map<string, DecisionWrite>();
  for (const record of listHeldWritesByPrefix<DecisionWrite>(DECISION_PREFIX)) {
    if (record.phase === 'unknown' && record.payload) {
      byOrder.set(record.payload.orderId, record.payload);
    }
  }
  for (const orderId of [...started]) {
    const subject = decisionSubject(orderId);
    const write = unknownAction<DecisionWrite>(subject);
    if (write !== null) byOrder.set(write.orderId, write);
    else if (!hasAction(subject)) started.delete(orderId);
  }
  return [...byOrder.values()];
}

export type PostedDecisionPin = {
  orderId: string;
  subject: string;
  requestId: string;
};

/** Parse the order id out of a `order-decision:` held-write subject. */
export function orderIdFromDecisionSubject(subject: string): string | null {
  if (!subject.startsWith(DECISION_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(subject.slice(DECISION_PREFIX.length));
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Decisions whose RPC succeeded and are awaiting a verifying read for that order. */
export function postedDecisionOrders(): PostedDecisionPin[] {
  const byOrder = new Map<string, PostedDecisionPin>();
  for (const record of listHeldWritesByPrefix(DECISION_PREFIX)) {
    if (record.phase !== 'posted_reload') continue;
    const orderId = orderIdFromDecisionSubject(record.subject);
    if (!orderId) continue;
    byOrder.set(orderId, {
      orderId,
      subject: record.subject,
      requestId: record.requestId,
    });
  }
  return [...byOrder.values()];
}
