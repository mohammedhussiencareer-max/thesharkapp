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
