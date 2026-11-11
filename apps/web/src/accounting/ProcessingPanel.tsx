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
import type { ParkedOrder, ProcessingSummary } from '@/accounting/types';
import { ConfirmedRefusalError, messageFrom } from '@/items/errors';
import {
  beginAction,
  hasAction,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { UnknownSave } from '@/items/UnknownSave';
import { isDefiniteRefusal } from '@/lib/write-outcome';
import { primaryButton, secondaryButton } from '@/lib/page-style';

type RetryHeld = {
  requestId: string;
  orderId: string;
};

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
 */
export function ProcessingPanel() {
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loadId, setLoadId] = useState(0);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const flight = useRef(false);
  const seqRef = useRef(0);
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

  async function finishFresh(action: RunHeld): Promise<void> {
    if (flight.current) return;
    flight.current = true;
    setRunning(true);
    setNotice(null);
    try {
      let outcome: RunOutcome;
      try {
        outcome = await runDeductions((report: AttemptReport) => {
          action.report = report;
        });
      } catch (error) {
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
        settleAction(accountingRunSubject, action.requestId, outcome.cause);
        setNotice(runStopLabel('call_failed'));
        return;
      }
      settleAction(accountingRunSubject, action.requestId);
      setNotice(runStopLabel(outcome.stop));
      requestReload();
    } finally {
      flight.current = false;
      setRunning(false);
    }
  }

  async function finishUnknown(action: RunHeld): Promise<void> {
    if (flight.current) return;
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
          setNotice(busyNotice);
          return;
        }
        settleAction(accountingRunSubject, action.requestId);
        setNotice(recordedNotice);
        requestReload();
      } catch (error) {
        // The attempt stays until recording acknowledges a terminal status.
        setNotice(messageFrom(error));
      }
    } finally {
      flight.current = false;
      setRunning(false);
    }
  }

  async function finishRetry(action: RetryHeld): Promise<void> {
    if (flight.current) return;
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
      requestReload();
    } finally {
      flight.current = false;
      setRunning(false);
    }
  }

  function run(): void {
    if (flight.current || running || hasAction(accountingRunSubject)) return;
    const action = beginAction<RunHeld>(accountingRunSubject, (requestId) => ({
      requestId,
      report: null,
    }));
    void finishFresh(action);
  }

  function retryRun(): void {
    if (!heldRun || flight.current || running) return;
    void finishUnknown(heldRun);
  }

  function retryOrder(order: ParkedOrder): void {
    const subject = accountingRetrySubject(order.orderId);
    if (flight.current || running || hasAction(subject)) return;
    const action = beginAction<RetryHeld>(subject, (requestId) => ({
      requestId,
      orderId: order.orderId,
    }));
    void finishRetry(action);
  }

  function retryHeldOrder(orderId: string): void {
    const held = unknownAction<RetryHeld>(accountingRetrySubject(orderId));
    if (!held || flight.current || running) return;
    void finishRetry(held);
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
            <UnknownSave disabled={running} onRetry={retryRun} />
          ) : (
            <button
              className={primaryButton}
              type="button"
              disabled={running}
              onClick={run}
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
                        disabled={running}
                        onRetry={() => retryHeldOrder(order.orderId)}
                      />
                    ) : (
                      <button
                        className={secondaryButton}
                        type="button"
                        disabled={running}
                        onClick={() => retryOrder(order)}
                      >
                        رجّع الطلب
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
