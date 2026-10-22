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
import { pageShell, secondaryButton } from '@/lib/page-style';

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

export function CountsPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [loads, setLoads] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [pending, setPending] = useState<CountDraft | null>(null);
  const [waiting, setWaiting] = useState<CountDraft | null>(null);
  const [waitNotice, setWaitNotice] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [requestKey, setRequestKey] = useState(0);
  const seqRef = useRef(0);
  const loadsRef = useRef(0);
  const editingLocked = saving || needsReload;
  const busy = editingLocked || loads > 0;

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
        setNeedsReload(false);
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

  function applyPosted(requestId: string | null, fromForm: boolean): void {
    const matches = (draft: CountDraft | null) =>
      requestId !== null && draft?.requestId === requestId;
    // Success releases only this request. A different pending card can still
    // post while another draft stays pinned after an unknown outcome.
    if (fromForm || matches(pending) || matches(waiting)) {
      setPending((current) => (matches(current) ? null : current));
      setWaiting((current) => (matches(current) ? null : current));
      setWaitNotice(false);
      setFormEpoch((value) => value + 1);
    }
    // Stays set until the reload applies data, or a visible retryable error
    // replaces it. A stale read clears the lock instead of leaving it stuck.
    setNeedsReload(true);
    setSuccess('اتسجل الجرد');
  }

  function holdUnknown(draft: CountDraft, error: unknown): void {
    setServerError(reportedCountError(error));
    // A pin stays until this exact payload succeeds or the same replay
    // is refused by a rule the payload itself breaks. A permission or
    // contention error can fire before the server's request_id replay,
    // so it leaves the existing pin in place and does not start a new one.
    if (isPayloadRefusal(error)) {
      // A lost prepare reply can already be stored. Reusing that id for an
      // edited count is refused, so any payload refusal of a pinned or
      // stored request starts a new id. A first submit that is refused
      // stored nothing and keeps its id. The old row stays in the list.
      const replay =
        pending?.requestId === draft.requestId ||
        waiting?.requestId === draft.requestId;
      setWaitNotice(false);
      setPending((current) =>
        current?.requestId === draft.requestId ? null : current,
      );
      setWaiting((current) =>
        current?.requestId === draft.requestId ? null : current,
      );
      if (replay) setRequestKey((value) => value + 1);
      return;
    }
    if (isUnknownOutcome(error)) {
      // A lost reply may have posted. The next حفظ resends this payload,
      // including when the lost call was the waiting resend.
      setWaitNotice(false);
      setPending((current) => (current && current !== draft ? current : draft));
      setWaiting((current) => (current && current !== draft ? current : null));
    }
  }

  async function finishWrite(
    result: CountWriteResult,
    draft: CountDraft | null,
    requestId: string | null,
  ): Promise<boolean> {
    if (result.status === 'waiting_for_sync') {
      if (draft) {
        setWaiting(draft);
        setPending(null);
      }
      setWaitNotice(true);
      setSuccess(null);
      await refreshAfterWait();
      return false;
    }
    applyPosted(requestId, draft !== null);
    const next = await readSnapshot();
    if (next.status === 'ready') {
      setSnapshot(next.snapshot);
      setLoadError(null);
      setNeedsReload(false);
    } else {
      setNeedsReload(false);
    }
    return true;
  }

  async function handleSubmit(draft: CountDraft) {
    if (busy || loadsRef.current > 0) return;
    setSaving(true);
    setServerError(null);
    setCardError(null);
    setSuccess(null);
    let saved = false;
    try {
      const result = await recordCount(draft);
      if (result.status === 'posted') saved = true;
      await finishWrite(result, draft, draft.requestId);
    } catch (error) {
      if (!saved) {
        holdUnknown(draft, error);
      } else {
        setNeedsReload(true);
        setLoadError(messageFrom(error));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleStored(payload: Json) {
    if (busy || loadsRef.current > 0) return;
    const requestId = requestIdOf(payload);
    setSaving(true);
    setServerError(null);
    setCardError(null);
    setSuccess(null);
    let saved = false;
    try {
      const result = await recordStoredCount(payload);
      if (result.status === 'posted') saved = true;
      await finishWrite(result, null, requestId);
    } catch (error) {
      if (!saved) {
        // The form is hidden when nothing is active, so a card refusal
        // has to render beside the pending list.
        setCardError(reportedCountError(error));
        if (
          requestId &&
          (pending?.requestId === requestId ||
            waiting?.requestId === requestId) &&
          isPayloadRefusal(error)
        ) {
          setRequestKey((value) => value + 1);
          setPending((current) =>
            current?.requestId === requestId ? null : current,
          );
          setWaiting((current) =>
            current?.requestId === requestId ? null : current,
          );
          setWaitNotice(false);
        }
      } else {
        setNeedsReload(true);
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
      {waiting || waitNotice ? (
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
              locked={busy}
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
            disabled={busy}
            onResend={(payload) => void handleStored(payload)}
          />
          <CountList counts={snapshot.counts} />
        </>
      ) : null}
    </main>
  );
}
