import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CountForm } from '@/counts/CountForm';
import { CountList } from '@/counts/CountList';
import { PendingCounts } from '@/counts/PendingCounts';
import {
  listCounts,
  listDailyItems,
  listPendingCounts,
  recordCount,
  recordStoredCount,
} from '@/counts/api';
import {
  genericCountError,
  isPayloadRefusal,
  isUnknownOutcome,
  mapCountError,
  retrySafeMessage,
  waitingForSyncMessage,
} from '@/counts/errors';
import type {
  CountDraft,
  CountItem,
  CountRecord,
  CountWriteResult,
  PendingCount,
} from '@/counts/types';
import { messageFrom } from '@/items/errors';
import type { Json } from '@/lib/database.types';
import {
  clearHeldWrite,
  clearPostedReload,
  getHeldWrite,
  listHeldWritesByPrefix,
  putHeldWrite,
  setHeldWritePhase,
  subscribeHeldWritesStore,
} from '@/lib/held-writes';
import { isOnline, offlineWriteMessage, useOnline } from '@/lib/online';
import { pageShell, secondaryButton } from '@/lib/page-style';

const COUNT_DAILY_SUBJECT = 'count:daily';
const COUNT_STORED_PREFIX = 'count:stored:';

type Snapshot = {
  items: CountItem[];
  counts: CountRecord[];
  pendingCounts: PendingCount[];
};

type ReadResult = { status: 'ready'; snapshot: Snapshot } | { status: 'stale' };

function requestIdOf(payload: Json): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const requestId = (payload as { request_id?: unknown }).request_id;
  return typeof requestId === 'string' ? requestId : null;
}

function clearCountPostedReloads(): void {
  clearPostedReload(COUNT_DAILY_SUBJECT);
  for (const record of listHeldWritesByPrefix(COUNT_STORED_PREFIX)) {
    if (record.phase === 'posted_reload') {
      clearPostedReload(record.subject);
    }
  }
}

export function CountsPage() {
  const online = useOnline();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [loads, setLoads] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [heldEpoch, setHeldEpoch] = useState(0);
  // The request id whose waiting_for_sync reply is shown, so its own
  // later success clears it even when no local draft matches (a card).
  const [waitNotice, setWaitNotice] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [requestKey, setRequestKey] = useState(0);
  const seqRef = useRef(0);
  const loadsRef = useRef(0);

  useEffect(
    () => subscribeHeldWritesStore(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  const storedDaily =
    heldEpoch < 0 ? null : getHeldWrite<CountDraft>(COUNT_DAILY_SUBJECT);
  const pending = storedDaily?.phase === 'unknown' ? storedDaily.payload : null;
  const waiting =
    storedDaily?.phase === 'waiting_for_sync' ? storedDaily.payload : null;
  const inflightDaily = storedDaily?.phase === 'inflight';
  const postedReload =
    heldEpoch >= 0 &&
    (storedDaily?.phase === 'posted_reload' ||
      listHeldWritesByPrefix(COUNT_STORED_PREFIX).some(
        (record) => record.phase === 'posted_reload',
      ));

  const needsReload = localNeedsReload || postedReload;
  const editingLocked = saving || inflightDaily || needsReload;
  const busy = editingLocked || loads > 0;
  const writeLocked = busy || !online;

  async function readSnapshot(): Promise<ReadResult> {
    const seq = ++seqRef.current;
    loadsRef.current += 1;
    setLoads(loadsRef.current);
    try {
      const [items, counts, pendingCounts] = await Promise.all([
        listDailyItems(),
        listCounts(),
        listPendingCounts(),
      ]);
      return seq === seqRef.current
        ? { status: 'ready', snapshot: { items, counts, pendingCounts } }
        : { status: 'stale' };
    } catch (error) {
      if (seq !== seqRef.current) return { status: 'stale' };
      throw error;
    } finally {
      loadsRef.current -= 1;
      setLoads(loadsRef.current);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await readSnapshot();
        if (cancelled || next.status === 'stale') return;
        setSnapshot(next.snapshot);
        setLoadError(null);
        clearCountPostedReloads();
        setLocalNeedsReload(false);
      } catch (error) {
        if (cancelled) return;
        setLoadError(messageFrom(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadId]);

  function refresh() {
    if (saving || needsReload) return;
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function retry() {
    if (saving || loadsRef.current > 0) return;
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function reportedCountError(error: unknown): string {
    if (error instanceof Error && error.message.trim() !== '') {
      return error.message;
    }
    if (isUnknownOutcome(error)) return retrySafeMessage;
    return mapCountError(error);
  }

  async function refreshAfterWait(): Promise<void> {
    try {
      const next = await readSnapshot();
      if (next.status === 'ready') {
        setSnapshot(next.snapshot);
        setLoadError(null);
      }
    } catch (error) {
      setLoadError(messageFrom(error));
    }
  }

  function applyPosted(
    requestId: string | null,
    fromForm: boolean,
    storedSubject: string | null,
  ): void {
    const daily = getHeldWrite<CountDraft>(COUNT_DAILY_SUBJECT);
    const matchesDaily = requestId !== null && daily?.requestId === requestId;
    if (fromForm || matchesDaily) {
      if (daily && requestId !== null && daily.requestId === requestId) {
        setHeldWritePhase(COUNT_DAILY_SUBJECT, requestId, 'posted_reload');
      }
      setFormEpoch((value) => value + 1);
    }
    if (storedSubject && requestId !== null) {
      setHeldWritePhase(storedSubject, requestId, 'posted_reload');
    }
    setWaitNotice((current) =>
      current !== null && current === requestId ? null : current,
    );
    // Stays set until the reload applies data, or a visible retryable error
    // replaces it. A stale read clears the local lock while posted_reload waits
    // for a successful read.
    setLocalNeedsReload(true);
    setSuccess('اتسجل الجرد');
  }

  function holdUnknown(
    draft: CountDraft,
    error: unknown,
    priorPhase: 'unknown' | 'waiting_for_sync' | null,
  ): void {
    setServerError(reportedCountError(error));
    // A pin stays until this exact payload succeeds or the same replay
    // is refused by a rule the payload itself breaks. A permission or
    // contention error can fire before the server's request_id replay,
    // so it leaves the existing pin in place and does not start a new one.
    if (isPayloadRefusal(error)) {
      const replay = priorPhase !== null;
      setWaitNotice(null);
      clearHeldWrite(COUNT_DAILY_SUBJECT, draft.requestId);
      if (replay) setRequestKey((value) => value + 1);
      return;
    }
    if (isUnknownOutcome(error)) {
      // A lost reply may have posted. The next حفظ resends this payload,
      // including when the lost call was the waiting resend.
      setWaitNotice(null);
      setHeldWritePhase(COUNT_DAILY_SUBJECT, draft.requestId, 'unknown');
      return;
    }
    if (priorPhase !== null) {
      setHeldWritePhase(COUNT_DAILY_SUBJECT, draft.requestId, priorPhase);
      return;
    }
    // Definite non-payload refusal on a first submit stored nothing.
    clearHeldWrite(COUNT_DAILY_SUBJECT, draft.requestId);
  }

  async function finishWrite(
    result: CountWriteResult,
    draft: CountDraft | null,
    requestId: string | null,
    storedSubject: string | null,
  ): Promise<boolean> {
    if (result.status === 'waiting_for_sync') {
      if (draft) {
        setHeldWritePhase(
          COUNT_DAILY_SUBJECT,
          draft.requestId,
          'waiting_for_sync',
        );
      }
      if (storedSubject && requestId) {
        clearHeldWrite(storedSubject, requestId);
      }
      setWaitNotice(requestId ?? draft?.requestId ?? null);
      setSuccess(null);
      await refreshAfterWait();
      return false;
    }
    applyPosted(requestId, draft !== null, storedSubject);
    const next = await readSnapshot();
    if (next.status === 'ready') {
      setSnapshot(next.snapshot);
      setLoadError(null);
      clearCountPostedReloads();
      setLocalNeedsReload(false);
    } else {
      setLocalNeedsReload(false);
    }
    return true;
  }

  async function handleSubmit(draft: CountDraft) {
    if (busy || loadsRef.current > 0 || !isOnline()) return;
    const prior = getHeldWrite<CountDraft>(COUNT_DAILY_SUBJECT);
    const priorPhase =
      prior !== null &&
      prior.requestId === draft.requestId &&
      (prior.phase === 'unknown' || prior.phase === 'waiting_for_sync')
        ? prior.phase
        : null;
    // Persist BEFORE sending so a reload during transmission restores `unknown`.
    putHeldWrite(COUNT_DAILY_SUBJECT, {
      requestId: draft.requestId,
      payload: draft,
      phase: 'inflight',
      kind: 'count',
    });
    setSaving(true);
    setServerError(null);
    setCardError(null);
    setSuccess(null);
    let saved = false;
    try {
      const result = await recordCount(draft);
      if (result.status === 'posted') saved = true;
      await finishWrite(result, draft, draft.requestId, null);
    } catch (error) {
      if (!saved) {
        holdUnknown(draft, error, priorPhase);
      } else {
        setLocalNeedsReload(true);
        setLoadError(messageFrom(error));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleStored(payload: Json) {
    if (busy || loadsRef.current > 0 || !isOnline()) return;
    const requestId = requestIdOf(payload);
    const storedSubject =
      requestId !== null ? `${COUNT_STORED_PREFIX}${requestId}` : null;
    if (storedSubject && requestId !== null) {
      putHeldWrite(storedSubject, {
        requestId,
        payload,
        phase: 'inflight',
        kind: 'count_stored',
      });
    }
    setSaving(true);
    setServerError(null);
    setCardError(null);
    setSuccess(null);
    let saved = false;
    try {
      const result = await recordStoredCount(payload);
      if (result.status === 'posted') saved = true;
      await finishWrite(result, null, requestId, storedSubject);
    } catch (error) {
      if (!saved) {
        setCardError(reportedCountError(error));
        if (requestId && !isUnknownOutcome(error)) {
          setWaitNotice((current) => (current === requestId ? null : current));
        }
        if (storedSubject && requestId) {
          if (isUnknownOutcome(error)) {
            setHeldWritePhase(storedSubject, requestId, 'unknown');
          } else {
            clearHeldWrite(storedSubject, requestId);
          }
        }
        const daily = getHeldWrite<CountDraft>(COUNT_DAILY_SUBJECT);
        if (
          requestId &&
          daily &&
          daily.requestId === requestId &&
          (daily.phase === 'unknown' || daily.phase === 'waiting_for_sync') &&
          isPayloadRefusal(error)
        ) {
          setRequestKey((value) => value + 1);
          clearHeldWrite(COUNT_DAILY_SUBJECT, requestId);
          setWaitNotice(null);
        }
      } else {
        setLocalNeedsReload(true);
        setLoadError(messageFrom(error));
      }
    } finally {
      setSaving(false);
    }
  }

  const items = snapshot?.items ?? [];

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">الجرد اليومي</h1>
      {!online ? <p role="status">{offlineWriteMessage}</p> : null}
      {waiting || waitNotice !== null ? (
        <p role="status">{waitingForSyncMessage}</p>
      ) : null}
      {success ? <p role="status">{success}</p> : null}
      <button
        className={secondaryButton}
        type="button"
        disabled={saving || needsReload}
        onClick={refresh}
      >
        تحديث
      </button>
      {loading && snapshot === null ? <p>جاري تحميل الجرد…</p> : null}
      {snapshot === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericCountError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || loads > 0}
            onClick={retry}
          >
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {snapshot !== null && loadError ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || loads > 0}
            onClick={retry}
          >
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {snapshot !== null ? (
        <>
          {items.length === 0 && pending === null && waiting === null ? (
            <p>مفيش أصناف جرد يومي نشطة</p>
          ) : (
            <CountForm
              key={formEpoch}
              items={items}
              locked={writeLocked}
              submitting={saving}
              serverError={serverError}
              pending={pending}
              waiting={waiting}
              requestKey={requestKey}
              onClearServerError={() => setServerError(null)}
              onSubmit={(next) => void handleSubmit(next)}
            />
          )}
          {cardError ? <p role="alert">{cardError}</p> : null}
          <PendingCounts
            counts={snapshot.pendingCounts.filter(
              (row) => row.requestId !== waiting?.requestId,
            )}
            disabled={writeLocked}
            onResend={(payload) => void handleStored(payload)}
          />
          <CountList counts={snapshot.counts} refreshKey={loadId} />
        </>
      ) : null}
    </main>
  );
}
