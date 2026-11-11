import { useEffect, useRef, useState } from 'react';
import { messageFrom } from '@/items/errors';
import { settleAction, subscribeHeldWrites } from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { setOrderDisposition } from '@/order-decisions/api';
import { unknownDecisions } from '@/order-decisions/held-decisions';
import { decisionLabels, decisionSubject } from '@/order-decisions/format';
import type { DecisionNotice, DecisionWrite } from '@/order-decisions/types';

/**
 * The retry control for a decision whose answer was lost, shown for orders that
 * have no form on screen: a refresh or a filter change can drop the card, and a
 * closing decision takes the order out of both queue filters.
 */
export function PendingSaves({
  shown,
  onSettled,
}: {
  shown: ReadonlySet<string>;
  onSettled: (orderId: string, notice: DecisionNotice) => void;
}) {
  const [, setEpoch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const flight = useRef(false);

  useEffect(
    () => subscribeHeldWrites(() => setEpoch((value) => value + 1)),
    [],
  );

  const pending = unknownDecisions().filter(
    (write) => !shown.has(write.orderId),
  );
  if (pending.length === 0) return null;

  async function retry(write: DecisionWrite): Promise<void> {
    if (flight.current) return;
    flight.current = true;
    setBusy(write.orderId);
    const subject = decisionSubject(write.orderId);
    try {
      const saved = await setOrderDisposition(write);
      settleAction(subject, write.requestId);
      onSettled(write.orderId, { kind: 'saved', result: saved, warning: null });
    } catch (failure) {
      settleAction(subject, write.requestId, failure);
      onSettled(write.orderId, {
        kind: 'failed',
        message: messageFrom(failure),
      });
    } finally {
      flight.current = false;
      setBusy(null);
    }
  }

  return (
    <section
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
      aria-label="قرارات مش متأكد إنها اتسجلت"
    >
      <h2 className="text-lg font-semibold">قرارات مش متأكد إنها اتسجلت</h2>
      {pending.map((write) => (
        <div key={write.orderId} className="flex flex-col gap-1">
          <p>
            طلب {write.orderId} — {decisionLabels[write.decision]}
          </p>
          <UnknownSave
            disabled={busy !== null}
            onRetry={() => void retry(write)}
          />
        </div>
      ))}
    </section>
  );
}
