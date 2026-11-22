import { useEffect, useRef, useState } from 'react';
import { messageFrom } from '@/items/errors';
import {
  abortActionBeforeDispatch,
  canDispatchAction,
  claimReplayAction,
  hasDurableAction,
  markActionPostedReload,
  settleAction,
  subscribeHeldWrites,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import {
  captureWriteSession,
  storageWriteFailedMessage,
} from '@/lib/held-writes';
import { isOnline, offlineWriteMessage, useOnline } from '@/lib/online';
import { secondaryButton } from '@/lib/page-style';
import { setOrderDisposition } from '@/order-decisions/api';
import {
  postedDecisionOrders,
  unknownDecisions,
} from '@/order-decisions/held-decisions';
import { decisionLabels, decisionSubject } from '@/order-decisions/format';
import type { DecisionNotice, DecisionWrite } from '@/order-decisions/types';

/**
 * The retry control for a decision whose answer was lost, shown for orders that
 * have no form on screen: a refresh or a filter change can drop the card, and a
 * closing decision takes the order out of both queue filters. Also surfaces
 * `posted_reload` pins awaiting direct verification by order id.
 */
export function PendingSaves({
  shown,
  onSettled,
  onVerifyPosted,
}: {
  shown: ReadonlySet<string>;
  onSettled: (orderId: string, notice: DecisionNotice) => void;
  onVerifyPosted?: (orderId: string) => Promise<void>;
}) {
  const online = useOnline();
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
  const posted = postedDecisionOrders();
  if (pending.length === 0 && posted.length === 0) return null;

  async function retry(write: DecisionWrite): Promise<void> {
    if (flight.current || !isOnline()) return;
    const session = captureWriteSession();
    const subject = decisionSubject(write.orderId);
    const claim = await claimReplayAction<DecisionWrite>(
      subject,
      write.requestId,
      { session },
    );
    if (!claim.ok) {
      if (claim.reason === 'missing' || claim.reason === 'storage') {
        onSettled(write.orderId, {
          kind: 'failed',
          message: storageWriteFailedMessage,
        });
      } else if (claim.reason === 'session_invalid' && !isOnline()) {
        onSettled(write.orderId, {
          kind: 'failed',
          message: offlineWriteMessage,
        });
      }
      return;
    }
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        claim.release();
      }
    };
    if (!canDispatchAction(subject, write.requestId, session)) {
      const missingPin = !hasDurableAction(subject, write.requestId);
      abortActionBeforeDispatch(subject, write.requestId, true, releaseOnce);
      if (!isOnline()) {
        onSettled(write.orderId, {
          kind: 'failed',
          message: offlineWriteMessage,
        });
      } else if (missingPin) {
        onSettled(write.orderId, {
          kind: 'failed',
          message: storageWriteFailedMessage,
        });
      }
      return;
    }
    flight.current = true;
    setBusy(write.orderId);
    let persisted = false;
    try {
      const saved = await setOrderDisposition(claim.record.payload);
      persisted = true;
      if (saved.status === 'ok') {
        markActionPostedReload(subject, write.requestId, subject);
      } else {
        settleAction(subject, write.requestId);
      }
      onSettled(write.orderId, { kind: 'saved', result: saved, warning: null });
    } catch (failure) {
      if (!persisted) {
        settleAction(subject, write.requestId, failure);
      }
      onSettled(write.orderId, {
        kind: 'failed',
        message: messageFrom(failure),
      });
    } finally {
      releaseOnce();
      flight.current = false;
      setBusy(null);
    }
  }

  async function verifyPosted(orderId: string): Promise<void> {
    if (!onVerifyPosted || flight.current || !isOnline()) return;
    flight.current = true;
    setBusy(orderId);
    try {
      await onVerifyPosted(orderId);
    } catch (failure) {
      onSettled(orderId, {
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
            disabled={busy !== null || !online}
            onRetry={() => void retry(write)}
          />
        </div>
      ))}
      {posted.map((pin) => (
        <div key={`posted:${pin.orderId}`} className="flex flex-col gap-1">
          <p>طلب {pin.orderId} — القرار اتسجل ومستني تأكيد التحديث</p>
          {onVerifyPosted ? (
            <button
              className={secondaryButton}
              type="button"
              disabled={busy !== null || !online}
              onClick={() => void verifyPosted(pin.orderId)}
            >
              تحديث حالة القرار
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
