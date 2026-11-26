import { accountingRetrySubject } from '@/accounting/run';
import { hasAction, unknownAction } from '@/items/request-id';
import { listHeldWritesByPrefix } from '@/lib/held-writes';

export type RetryHeld = {
  requestId: string;
  orderId: string;
  workGeneration?: number;
};

const RETRY_PREFIX = 'accounting:retry:';
const started = new Set<string>();

/** Remember an order whose retry was sent, so a lost answer can be retried. */
export function noteRetryOrder(orderId: string): void {
  started.add(orderId);
}

/**
 * Retries whose last reply might already be stored. Reads persisted held writes
 * as well as any started in-session so a lost retry survives page reload.
 */
export function unknownRetries(): RetryHeld[] {
  const byOrder = new Map<string, RetryHeld>();
  for (const record of listHeldWritesByPrefix<RetryHeld>(RETRY_PREFIX)) {
    if (record.phase === 'unknown' && record.payload) {
      byOrder.set(record.payload.orderId, record.payload);
    }
  }
  for (const orderId of [...started]) {
    const subject = accountingRetrySubject(orderId);
    const write = unknownAction<RetryHeld>(subject);
    if (write !== null) byOrder.set(write.orderId, write);
    else if (!hasAction(subject)) started.delete(orderId);
  }
  return [...byOrder.values()];
}
