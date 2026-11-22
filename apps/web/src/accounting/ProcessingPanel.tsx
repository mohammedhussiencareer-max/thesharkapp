import { useEffect, useRef, useState } from 'react';
import {
  loadProcessingSummary,
  recordRunFailure,
  retryParkedOrder,
  runDeductions,
} from '@/accounting/api';
import {
  formatCountPair,
  formatCoverage,
  formatFailureReason,
  runStopLabel,
} from '@/accounting/format';
import {
  accountingRetrySubject,
  accountingRunSubject,
  type AttemptReport,
  type FailureReport,
  type RunHeld,
  type RunOutcome,
} from '@/accounting/run';
import {
  noteRetryOrder,
  unknownRetries,
  type RetryHeld,
} from '@/accounting/held-retries';
import type { ParkedOrder, ProcessingSummary } from '@/accounting/types';
import { ConfirmedRefusalError, messageFrom } from '@/items/errors';
import {
  claimFreshAction,
  claimReplayAction,
  hasAction,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
  updateActionPayload,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import {
  setHeldWritePhase,
  storageWriteFailedMessage,
  type HeldWriteRecord,
} from '@/lib/held-writes';
import { isOnline, useOnline } from '@/lib/online';
import { isDefiniteRefusal } from '@/lib/write-outcome';
import { primaryButton, secondaryButton } from '@/lib/page-style';

const recordedNotice = 'اتسجل إن المكالمة اتقطعت';
const busyNotice = 'الحساب مشغول، حاول تاني';
const notFailedNotice = 'الطلب مش متوقف';
const retriedNotice = 'الطلب رجع للشغل';
const dormantNotice = 'الخصم لسه ما اتفعّلش. التشغيل بيرجع من غير ما يكتب.';

/** recorded, committed, duplicate, no_work, and stale. busy is not terminal. */
function acknowledgedReport(status: FailureReport): boolean {
  switch (status) {
    case 'recorded':
    case 'committed':
    case 'duplicate':
    case 'no_work':
    case 'stale':
      return true;
    case 'busy':
      return false;
  }
}

function retireRefusal(
  subject: string,
  requestId: string,
  cause: unknown,
): void {
  settleAction(
    subject,
    requestId,
    new ConfirmedRefusalError(messageFrom(cause)),
  );
}

/**
 * Sales-page processing panel. One in-flight accounting action at a time.
 * A reload failure never settles the action that just finished.
 *
 * `refreshKey` reloads pending counts, coverage, and parked orders. The load
 * effect lists `loadId` only, so a same-key parent render does not read again.
 * `onShiftDataStale` runs only after an acknowledged run or retry settles.
 * The page handler must change `refreshKey`; that change is this panel's
 * reload. Busy, unreported, and refused outcomes stay retryable and do not
 * notify the page. A lost parked-order retry stays on screen after تحديث
 * drops that order, until the same retry returns retried or not_failed.
 */
export function ProcessingPanel({
  refreshKey = 0,
  onShiftDataStale,
}: {
  refreshKey?: number;
  onShiftDataStale?: () => void;
}) {
  const online = useOnline();
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loadId, setLoadId] = useState(0);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [seenRefresh, setSeenRefresh] = useState(refreshKey);
  const flight = useRef(false);
  const seqRef = useRef(0);
  if (seenRefresh !== refreshKey) {
    setSeenRefresh(refreshKey);
    setLoadId((value) => value + 1);
  }
  const heldRun =
    heldEpoch < 0 ? null : unknownAction<RunHeld>(accountingRunSubject);

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadProcessingSummary();
        if (cancelled || seq !== seqRef.current) return;
        setSummary(next);
        setLoadError(null);
      } catch (error) {
        if (cancelled || seq !== seqRef.current) return;
        setLoadError(messageFrom(error));
      } finally {
        if (!cancelled && seq === seqRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadId]);

  function requestReload(): void {
    setLoadId((value) => value + 1);
  }

  function publishAcknowledged(): void {
    if (onShiftDataStale) {
      onShiftDataStale();
      return;
    }
    requestReload();
  }

  async function finishFresh(
    action: RunHeld,
    release: () => void,
  ): Promise<void> {
    if (flight.current || !isOnline()) {
      release();
      return;
    }
    flight.current = true;
    setRunning(true);
    setNotice(null);
    try {
      let outcome: RunOutcome;
      try {
        const persistAttempt = (report: AttemptReport) => {
          action.report = { ...report };
          updateActionPayload(accountingRunSubject, action.requestId, {
            ...action,
          });
        };
        outcome = await runDeductions(persistAttempt, persistAttempt);
      } catch (error) {
        updateActionPayload(accountingRunSubject, action.requestId, action);
        settleAction(accountingRunSubject, action.requestId, error);
        setNotice(messageFrom(error));
        return;
      }
      if (
        outcome.stop === 'call_failed' &&
        outcome.report === 'not_needed' &&
        isDefiniteRefusal(outcome.cause)
      ) {
        retireRefusal(accountingRunSubject, action.requestId, outcome.cause);
        setNotice(messageFrom(outcome.cause));
        return;
      }
      if (
        outcome.stop === 'call_failed' &&
        (outcome.report === 'unreported' || outcome.report === 'busy')
      ) {
        updateActionPayload(accountingRunSubject, action.requestId, action);
        settleAction(accountingRunSubject, action.requestId, outcome.cause);
        setNotice(runStopLabel('call_failed'));
        return;
      }
      settleAction(accountingRunSubject, action.requestId);
      setNotice(runStopLabel(outcome.stop));
      publishAcknowledged();
    } finally {
      release();
      flight.current = false;
      setRunning(false);
    }
  }

  async function finishUnknown(
    action: RunHeld,
    release: () => void,
  ): Promise<void> {
    if (flight.current || !isOnline()) {
      release();
      return;
    }
    flight.current = true;
    setRunning(true);
    setNotice(null);
    try {
      if (!action.report) {
        settleAction(accountingRunSubject, action.requestId);
        setNotice(runStopLabel('call_failed'));
        return;
      }
      try {
        const status = await recordRunFailure(action.report);
        if (!acknowledgedReport(status)) {
          setHeldWritePhase(accountingRunSubject, action.requestId, 'unknown');
          setNotice(busyNotice);
          return;
        }
        settleAction(accountingRunSubject, action.requestId);
        setNotice(recordedNotice);
        publishAcknowledged();
      } catch (error) {
        // The attempt stays until recording acknowledges a terminal status.
        setHeldWritePhase(accountingRunSubject, action.requestId, 'unknown');
        setNotice(messageFrom(error));
      }
    } finally {
      release();
      flight.current = false;
      setRunning(false);
    }
  }

  async function finishRetry(
    action: RetryHeld,
    release: () => void,
  ): Promise<void> {
    if (flight.current || !isOnline()) {
      release();
      return;
    }
    flight.current = true;
    setRunning(true);
    setNotice(null);
    const subject = accountingRetrySubject(action.orderId);
    try {
      let status: 'retried' | 'not_failed' | 'busy';
      try {
        status = await retryParkedOrder(action.orderId);
      } catch (error) {
        if (isDefiniteRefusal(error)) {
          retireRefusal(subject, action.requestId, error);
        } else {
          settleAction(subject, action.requestId, error);
        }
        setNotice(messageFrom(error));
        return;
      }
      settleAction(subject, action.requestId);
      if (status === 'busy') {
        setNotice(busyNotice);
        return;
      }
      setNotice(status === 'not_failed' ? notFailedNotice : retriedNotice);
      publishAcknowledged();
    } finally {
      release();
      flight.current = false;
      setRunning(false);
    }
  }

  async function replayUnknownRun(requestId: string): Promise<void> {
    if (flight.current || running || !isOnline()) return;
    const claim = await claimReplayAction<RunHeld>(
      accountingRunSubject,
      requestId,
    );
    if (!claim.ok) {
      if (claim.reason === 'locked') {
        setNotice(busyNotice);
      } else if (claim.reason === 'missing' || claim.reason === 'storage') {
        setNotice(storageWriteFailedMessage);
      }
      return;
    }
    await finishUnknown(claim.record.payload, claim.release);
  }

  async function run(): Promise<void> {
    if (
      flight.current ||
      running ||
      !isOnline() ||
      hasAction(accountingRunSubject)
    )
      return;
    const claim = await claimFreshAction<RunHeld>(
      accountingRunSubject,
      (requestId) => ({
        requestId,
        report: null,
      }),
    );
    if (!claim.ok) {
      if (claim.reason === 'storage') {
        setNotice(storageWriteFailedMessage);
        return;
      }
      if (claim.reason === 'locked') {
        setNotice(busyNotice);
        return;
      }
      if (claim.reason === 'conflict' && claim.existing) {
        const existing = claim.existing as HeldWriteRecord<RunHeld>;
        if (existing.phase === 'unknown') {
          await replayUnknownRun(existing.requestId);
        } else {
          setNotice(busyNotice);
        }
      }
      return;
    }
    await finishFresh(claim.record.payload, claim.release);
  }

  function retryRun(): void {
    if (!heldRun || flight.current || running || !isOnline()) return;
    void replayUnknownRun(heldRun.requestId);
  }

  async function retryOrder(order: ParkedOrder): Promise<void> {
    const subject = accountingRetrySubject(order.orderId);
    if (flight.current || running || !isOnline() || hasAction(subject)) return;
    const claim = await claimFreshAction<RetryHeld>(subject, (requestId) => ({
      requestId,
      orderId: order.orderId,
    }));
    if (!claim.ok) {
      if (claim.reason === 'storage') {
        setNotice(storageWriteFailedMessage);
      } else if (claim.reason === 'locked') {
        setNotice(busyNotice);
      }
      return;
    }
    noteRetryOrder(order.orderId);
    await finishRetry(claim.record.payload, claim.release);
  }

  const unresolvedRetries =
    heldEpoch < 0 || summary === null
      ? []
      : unknownRetries().filter(
          (held) =>
            !summary.parked.some((order) => order.orderId === held.orderId),
        );

  async function retryHeldOrder(orderId: string): Promise<void> {
    const subject = accountingRetrySubject(orderId);
    const held = unknownAction<RetryHeld>(subject);
    if (!held || flight.current || running || !isOnline()) return;
    const claim = await claimReplayAction<RetryHeld>(subject, held.requestId);
    if (!claim.ok) {
      if (claim.reason === 'locked') {
        setNotice(busyNotice);
      } else if (claim.reason === 'missing' || claim.reason === 'storage') {
        setNotice(storageWriteFailedMessage);
      }
      return;
    }
    await finishRetry(claim.record.payload, claim.release);
  }

  return (
    <section aria-label="معالجة الخصم" className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">معالجة الخصم</h2>
      {loading && summary === null ? <p>جاري تحميل المعالجة…</p> : null}
      {loadError ? (
        <>
          <p>{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            onClick={requestReload}
          >
            إعادة تحميل المعالجة
          </button>
        </>
      ) : null}
      {summary ? (
        <>
          {summary.activated ? null : <p>{dormantNotice}</p>}
          <p>
            مستني <span dir="ltr">{summary.pendingCount}</span>
          </p>
          <p>
            واقف <span dir="ltr">{summary.blockedCount}</span>
          </p>
          <p>
            متوقف بعد ٥ محاولات <span dir="ltr">{summary.failedCount}</span>
          </p>
          <p>
            {formatCountPair(
              summary.processedEventCount,
              summary.openEventCount,
            )}
          </p>
          <p>
            فترات إعدادات لسه مفتوحة{' '}
            <span dir="ltr">{summary.openSpanCount}</span>
          </p>
          <p>{formatCoverage(summary.coverage)}</p>
          {notice ? <p>{notice}</p> : null}
          {heldRun ? (
            <UnknownSave disabled={running || !online} onRetry={retryRun} />
          ) : (
            <button
              className={primaryButton}
              type="button"
              disabled={running || !online}
              onClick={() => void run()}
            >
              {running ? 'جاري الحساب…' : 'شغّل الخصم'}
            </button>
          )}
          {summary.parkedTruncated ? (
            <p>فيه طلبات متوقفة أكتر من المعروض</p>
          ) : null}
          {summary.parked.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label="طلبات متوقفة">
              {summary.parked.map((order) => {
                const held = unknownAction<RetryHeld>(
                  accountingRetrySubject(order.orderId),
                );
                return (
                  <li key={order.orderId} className="flex flex-col gap-1">
                    <p dir="ltr">{order.orderId}</p>
                    <p>{formatFailureReason(order.reason, order.sqlstate)}</p>
                    {held ? (
                      <UnknownSave
                        disabled={running || !online}
                        onRetry={() => void retryHeldOrder(order.orderId)}
                      />
                    ) : (
                      <button
                        className={secondaryButton}
                        type="button"
                        disabled={running || !online}
                        onClick={() => void retryOrder(order)}
                      >
                        رجّع الطلب
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {unresolvedRetries.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label="رجوع مش متأكد">
              {unresolvedRetries.map((held) => (
                <li key={held.orderId} className="flex flex-col gap-1">
                  <p dir="ltr">{held.orderId}</p>
                  <UnknownSave
                    disabled={running || !online}
                    onRetry={() => void retryHeldOrder(held.orderId)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
