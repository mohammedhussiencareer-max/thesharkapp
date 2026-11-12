import { accountingRetrySubject } from '@/accounting/run';
import { hasAction, unknownAction } from '@/items/request-id';

export type RetryHeld = {
  requestId: string;
  orderId: string;
};

const started = new Set<string>();

/** Remember an order whose retry was sent, so a lost answer can be retried. */
export function noteRetryOrder(orderId: string): void {
  started.add(orderId);
}

/**
 * Retries whose last reply might already be stored. The order can leave the
 * parked list when the commit cleared `failed_at` and the reply was lost.
 * An in-flight retry stays noted until it settles.
 */
export function unknownRetries(): RetryHeld[] {
  const found: RetryHeld[] = [];
  for (const orderId of [...started]) {
    const subject = accountingRetrySubject(orderId);
    const write = unknownAction<RetryHeld>(subject);
    if (write !== null) found.push(write);
    else if (!hasAction(subject)) started.delete(orderId);
  }
  return found;
}
