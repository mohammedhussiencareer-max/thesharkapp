import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CountForm } from '@/counts/CountForm';
import { CountList } from '@/counts/CountList';
import { listCounts, listDailyItems, recordCount } from '@/counts/api';
import {
  genericCountError,
  isPayloadRefusal,
  isUnknownOutcome,
  mapCountError,
  retrySafeMessage,
} from '@/counts/errors';
import type { CountDraft, CountItem, CountRecord } from '@/counts/types';
import { messageFrom } from '@/items/errors';
import { pageShell, secondaryButton } from '@/lib/page-style';

type Snapshot = { items: CountItem[]; counts: CountRecord[] };

type ReadResult = { status: 'ready'; snapshot: Snapshot } | { status: 'stale' };

export function CountsPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [loads, setLoads] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState<CountDraft | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const seqRef = useRef(0);
  const loadsRef = useRef(0);
  const editingLocked = saving || needsReload;
  const busy = editingLocked || loads > 0;

  async function readSnapshot(): Promise<ReadResult> {
    const seq = ++seqRef.current;
    loadsRef.current += 1;
    setLoads(loadsRef.current);
    try {
      const [items, counts] = await Promise.all([
        listDailyItems(),
        listCounts(),
      ]);
      return seq === seqRef.current
        ? { status: 'ready', snapshot: { items, counts } }
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

  async function handleSubmit(draft: CountDraft) {
    if (busy || loadsRef.current > 0) return;
    setSaving(true);
    setServerError(null);
    setSuccess(null);
    let saved = false;
    try {
      await recordCount(draft);
      saved = true;
      // The form resubmits the pinned object, so this success is that payload.
      setPending(null);
      // Stays set until the reload applies data, or a visible retryable error
      // replaces it. A stale read clears the lock instead of leaving it stuck.
      setNeedsReload(true);
      setFormEpoch((value) => value + 1);
      setSuccess('اتسجل الجرد');
      const next = await readSnapshot();
      if (next.status === 'ready') {
        setSnapshot(next.snapshot);
        setLoadError(null);
        setNeedsReload(false);
      } else {
        setNeedsReload(false);
      }
    } catch (error) {
      if (!saved) {
        setServerError(reportedCountError(error));
        // A pin stays until this exact payload succeeds or the same replay
        // is refused by a rule the payload itself breaks. A permission or
        // contention error can fire before the server's request_id replay,
        // so it leaves the original unknown and keeps the pin.
        setPending((current) => {
          if (current && current !== draft) return current;
          if (current) return isPayloadRefusal(error) ? null : current;
          return isUnknownOutcome(error) ? draft : null;
        });
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
          {items.length === 0 ? (
            <p>مفيش أصناف جرد يومي نشطة</p>
          ) : (
            <CountForm
              key={formEpoch}
              items={items}
              locked={busy}
              submitting={saving}
              serverError={serverError}
              pending={pending}
              onClearServerError={() => setServerError(null)}
              onSubmit={(next) => void handleSubmit(next)}
            />
          )}
          <CountList counts={snapshot.counts} />
        </>
      ) : null}
    </main>
  );
}
