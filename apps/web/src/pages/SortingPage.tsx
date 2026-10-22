import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { messageFrom } from '@/items/errors';
import { pageShell, secondaryButton } from '@/lib/page-style';
import { listMixedFish, listSorts, recordSort } from '@/sorting/api';
import {
  genericSortError,
  isDefiniteRefusal,
  isUnknownOutcome,
  mapSortError,
  retrySafeMessage,
} from '@/sorting/errors';
import { SortForm } from '@/sorting/SortForm';
import { SortList } from '@/sorting/SortList';
import type { MixedFish, SortDraft, SortRecord } from '@/sorting/types';
import {
  cairoDateStartIso,
  cairoNextDateStartIso,
  dateRangeError,
} from '@/purchases/time';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

type Snapshot = { items: MixedFish[]; sorts: SortRecord[] };

type ReadResult =
  | { status: 'ready'; snapshot: Snapshot }
  | { status: 'stale' }
  | { status: 'blocked'; message: string };

function historyFilterError(from: string, to: string): string | null {
  const range = dateRangeError(from, to);
  if (range) return range;
  if (
    (from && !cairoDateStartIso(from)) ||
    (to && !cairoNextDateStartIso(to))
  ) {
    return 'التاريخ مش مظبوط';
  }
  return null;
}

export function SortingPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [loads, setLoads] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState<SortDraft | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filterError, setFilterError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const loadsRef = useRef(0);
  const filterRef = useRef({ from: '', to: '' });
  const editingLocked = saving || needsReload;
  const busy = editingLocked || loads > 0;

  async function readSnapshot(): Promise<ReadResult> {
    const problem = historyFilterError(
      filterRef.current.from,
      filterRef.current.to,
    );
    if (problem) {
      setFilterError(problem);
      return { status: 'blocked', message: problem };
    }
    const fromIso = filterRef.current.from
      ? cairoDateStartIso(filterRef.current.from)
      : null;
    const toExclusive = filterRef.current.to
      ? cairoNextDateStartIso(filterRef.current.to)
      : null;
    setFilterError(null);
    const seq = ++seqRef.current;
    loadsRef.current += 1;
    setLoads(loadsRef.current);
    try {
      const [items, sorts] = await Promise.all([
        listMixedFish(),
        listSorts({
          from: fromIso ?? undefined,
          toExclusive: toExclusive ?? undefined,
        }),
      ]);
      return seq === seqRef.current
        ? { status: 'ready', snapshot: { items, sorts } }
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
        if (next.status === 'blocked') {
          setLoadError(next.message);
          setNeedsReload(false);
          return;
        }
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

  function retry() {
    if (saving || loadsRef.current > 0) return;
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function changeFilter(next: { from: string; to: string }) {
    if (editingLocked) return;
    filterRef.current = next;
    setFrom(next.from);
    setTo(next.to);
    const problem = historyFilterError(next.from, next.to);
    setFilterError(problem);
    if (problem) {
      seqRef.current += 1;
      return;
    }
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function reportedSortError(error: unknown): string {
    if (error instanceof Error && error.message.trim() !== '') {
      return error.message;
    }
    if (isUnknownOutcome(error)) return retrySafeMessage;
    return mapSortError(error);
  }

  async function handleSubmit(draft: SortDraft) {
    if (busy || loadsRef.current > 0) return;
    const problem = historyFilterError(
      filterRef.current.from,
      filterRef.current.to,
    );
    if (problem) {
      setFilterError(problem);
      return;
    }
    setSaving(true);
    setServerError(null);
    setSuccess(null);
    let saved = false;
    try {
      await recordSort(draft);
      saved = true;
      // The form resubmits the pinned object, so this success is that payload.
      setPending(null);
      // Stays set until the reload applies data, or a visible retryable error
      // replaces it. A range that cannot be read clears the lock instead.
      setNeedsReload(true);
      setFormEpoch((value) => value + 1);
      setSuccess('اتسجل الفرز');
      const next = await readSnapshot();
      if (next.status === 'ready') {
        setSnapshot(next.snapshot);
        setLoadError(null);
        setNeedsReload(false);
      } else if (next.status === 'blocked') {
        setLoadError(next.message);
        setNeedsReload(false);
      } else {
        setNeedsReload(false);
      }
    } catch (error) {
      if (!saved) {
        setServerError(reportedSortError(error));
        // A pin stays until this exact payload succeeds or the same replay
        // is definitely refused. A later unknown result does not clear it
        // or replace it with a different draft.
        setPending((current) => {
          if (current && current !== draft) return current;
          if (current) return isDefiniteRefusal(error) ? null : current;
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
      <h1 className="text-2xl font-semibold">الفرز</h1>
      {success ? <p role="status">{success}</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          من
          <input
            className={fieldClass}
            type="date"
            disabled={editingLocked}
            aria-invalid={filterError ? true : undefined}
            aria-describedby={filterError ? 'sort-range-error' : undefined}
            value={from}
            onChange={(event) =>
              changeFilter({
                from: event.target.value,
                to: filterRef.current.to,
              })
            }
          />
        </label>
        <label className="flex flex-col gap-1">
          إلى
          <input
            className={fieldClass}
            type="date"
            disabled={editingLocked}
            aria-invalid={filterError ? true : undefined}
            aria-describedby={filterError ? 'sort-range-error' : undefined}
            value={to}
            onChange={(event) =>
              changeFilter({
                from: filterRef.current.from,
                to: event.target.value,
              })
            }
          />
        </label>
      </div>
      {filterError ? (
        <p id="sort-range-error" role="alert">
          {filterError}
        </p>
      ) : null}
      {loading && snapshot === null ? <p>جاري تحميل الفرز…</p> : null}
      {snapshot === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericSortError}</p>
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
          {loadError !== filterError ? <p role="alert">{loadError}</p> : null}
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
            <p>لسه مفيش سمك مخلوط — ضيف صنف الأول</p>
          ) : (
            <SortForm
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
          <SortList sorts={snapshot.sorts} />
        </>
      ) : null}
    </main>
  );
}
