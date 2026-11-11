import { hasAction, unknownAction } from '@/items/request-id';
import { decisionSubject } from '@/order-decisions/format';
import type { DecisionWrite } from '@/order-decisions/types';

const started = new Set<string>();

/** Remember an order whose decision was sent, so a lost answer can be retried. */
export function noteDecisionOrder(orderId: string): void {
  started.add(orderId);
}

/**
 * Decisions whose last save might already be stored, whether or not the order
 * is still in the queue (a closing decision removes it).
 */
export function unknownDecisions(): DecisionWrite[] {
  const found: DecisionWrite[] = [];
  for (const orderId of [...started]) {
    const subject = decisionSubject(orderId);
    const write = unknownAction<DecisionWrite>(subject);
    if (write !== null) found.push(write);
    else if (!hasAction(subject)) started.delete(orderId);
  }
  return found;
}
