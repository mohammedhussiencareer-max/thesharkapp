import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { messageFrom } from '@/items/errors';
import { pageShell, secondaryButton } from '@/lib/page-style';
import { listMixedFish, listSorts, recordSort } from '@/sorting/api';
import { genericSortError } from '@/sorting/errors';
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

export function SortingPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [loads, setLoads] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
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

  async function readSnapshot(): Promise<Snapshot | null> {
    const range = dateRangeError(filterRef.current.from, filterRef.current.to);
    if (range) {
      setFilterError(range);
      return null;
    }
    const fromIso = filterRef.current.from
      ? cairoDateStartIso(filterRef.current.from)
      : null;
    const toExclusive = filterRef.current.to
      ? cairoNextDateStartIso(filterRef.current.to)
      : null;
    if (
      (filterRef.current.from && !fromIso) ||
      (filterRef.current.to && !toExclusive)
    ) {
      setFilterError('التاريخ مش مظبوط');
      return null;
    }
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
      return seq === seqRef.current ? { items, sorts } : null;
    } catch (error) {
      if (seq !== seqRef.current) return null;
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
        if (cancelled || !next) return;
        setSnapshot(next);
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
    const range = dateRangeError(next.from, next.to);
    setFilterError(range);
    if (range) {
      seqRef.current += 1;
      return;
    }
    setLoadId((value) => value + 1);
  }

  async function handleSubmit(draft: SortDraft) {
    if (busy || loadsRef.current > 0) return;
    setSaving(true);
    setServerError(null);
    setSuccess(null);
    let saved = false;
    try {
      await recordSort(draft);
      saved = true;
      setNeedsReload(true);
      setFormEpoch((value) => value + 1);
      setSuccess('اتسجل الفرز');
      const next = await readSnapshot();
      if (next) {
        setSnapshot(next);
        setLoadError(null);
        setNeedsReload(false);
      }
    } catch (error) {
      if (!saved) {
        setServerError(messageFrom(error));
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
      {filterError ? <p role="alert">{filterError}</p> : null}
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
            <p>لسه مفيش سمك مخلوط — ضيف صنف الأول</p>
          ) : (
            <SortForm
              key={formEpoch}
              items={items}
              locked={busy}
              submitting={saving}
              serverError={serverError}
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
