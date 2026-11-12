import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { genericCatalogError, messageFrom } from '@/items/errors';
import { UnknownSave } from '@/items/UnknownSave';
import { pageShell, secondaryButton } from '@/lib/page-style';
import { listStockChoices } from '@/purchases/api';
import type { StockChoice } from '@/purchases/types';
import { historyPageSize, loadHistoryPage } from '@/waste/api';
import { freshStart, newWasteSubject } from '@/waste/format';
import { reloadHistory } from '@/waste/history';
import type { HistoryEntry } from '@/waste/types';
import { useWasteAction } from '@/waste/useWasteAction';
import { WasteForm } from '@/waste/WasteForm';
import { WasteHistory } from '@/waste/WasteHistory';
import { WasteNoticeView } from '@/waste/WasteNotice';

export function WastePage() {
  const [choices, setChoices] = useState<StockChoice[] | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadId, setLoadId] = useState(0);
  const [formKey, setFormKey] = useState(0);
  const [reloading, setReloading] = useState(0);
  const loadSeqRef = useRef(0);
  const historySeqRef = useRef(0);
  const loadedRef = useRef(0);
  // The cursor only belongs to the list on screen while no refresh or reload is replacing that list.
  const pagingBlocked = loading || reloading > 0;

  useEffect(() => {
    const seq = ++loadSeqRef.current;
    const historySeq = ++historySeqRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const [items, page] = await Promise.all([
          listStockChoices(),
          loadHistoryPage(null),
        ]);
        if (cancelled || seq !== loadSeqRef.current) return;
        setChoices(items);
        setLoadError(null);
        if (historySeq === historySeqRef.current) {
          setEntries(page.entries);
          setNext(page.next);
          loadedRef.current = page.entries.length;
          setMoreError(null);
        }
      } catch (error) {
        if (cancelled || seq !== loadSeqRef.current) return;
        setLoadError(messageFrom(error));
      } finally {
        if (!cancelled && seq === loadSeqRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadId]);

  function refresh() {
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  async function loadMore() {
    if (next === null || loadingMore || pagingBlocked) return;
    const seq = historySeqRef.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await loadHistoryPage(next);
      if (seq !== historySeqRef.current) return;
      setEntries((current) => {
        const known = new Set((current ?? []).map((entry) => entry.id));
        const merged = [
          ...(current ?? []),
          ...page.entries.filter((entry) => !known.has(entry.id)),
        ];
        loadedRef.current = merged.length;
        return merged;
      });
      setNext(page.next);
    } catch (error) {
      if (seq === historySeqRef.current) setMoreError(messageFrom(error));
    } finally {
      setLoadingMore(false);
    }
  }

  // Re-reads everything already on screen plus the new document, so a corrected row refreshes too.
  const reload = useCallback(async (): Promise<void> => {
    const seq = ++historySeqRef.current;
    setReloading((count) => count + 1);
    try {
      const page = await reloadHistory(
        Math.max(historyPageSize, loadedRef.current + 1),
      );
      if (seq !== historySeqRef.current) return;
      setEntries(page.entries);
      setNext(page.next);
      loadedRef.current = page.entries.length;
      setMoreError(null);
    } finally {
      setReloading((count) => count - 1);
    }
  }, []);

  const record = useWasteAction(newWasteSubject, {
    reload,
    onSaved: () => setFormKey((value) => value + 1),
  });
  const start = useMemo(() => freshStart(), [formKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of entries ?? []) {
      for (const line of entry.lines) map[line.itemId] = line.name;
    }
    for (const choice of choices ?? []) map[choice.id] = choice.name;
    return map;
  }, [choices, entries]);

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">الهالك</h1>
      <p>سجّل الأصناف اللي اتشالت من المخزون من غير بيع، مع السبب.</p>
      <div className="flex flex-wrap gap-2">
        <button
          className={secondaryButton}
          type="button"
          disabled={loading}
          onClick={refresh}
        >
          {loadError ? 'إعادة المحاولة' : 'تحديث'}
        </button>
      </div>
      {loading && choices === null ? <p>جاري تحميل الهالك…</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {choices === null && !loading && !loadError ? (
        <p role="alert">{genericCatalogError}</p>
      ) : null}
      <section className="flex flex-col gap-3" aria-label="تسجيل هالك">
        <h2 className="text-lg font-semibold">تسجيل هالك</h2>
        {record.held ? (
          <UnknownSave disabled={record.saving} onRetry={record.retry} />
        ) : null}
        {record.notice ? (
          <WasteNoticeView notice={record.notice} names={names} />
        ) : null}
        {choices && choices.length === 0 ? <p>مفيش أصناف مخزون نشطة</p> : null}
        {choices && choices.length > 0 ? (
          <WasteForm
            key={formKey}
            choices={choices}
            action={record}
            start={start}
            predecessorId={null}
            label="تسجيل هالك جديد"
            submitLabel="سجّل الهالك"
          />
        ) : null}
      </section>
      <section className="flex flex-col gap-3" aria-label="سجل الهالك">
        <h2 className="text-lg font-semibold">سجل الهالك</h2>
        {entries && entries.length === 0 ? <p>مفيش هالك متسجل</p> : null}
        {entries && entries.length > 0 ? (
          <WasteHistory
            entries={entries}
            choices={choices ?? []}
            names={names}
            reload={reload}
          />
        ) : null}
        {moreError ? <p role="alert">{moreError}</p> : null}
        {next !== null ? (
          <button
            className={secondaryButton}
            type="button"
            disabled={loadingMore || pagingBlocked}
            onClick={() => void loadMore()}
          >
            عرض المزيد
          </button>
        ) : null}
      </section>
    </main>
  );
}
