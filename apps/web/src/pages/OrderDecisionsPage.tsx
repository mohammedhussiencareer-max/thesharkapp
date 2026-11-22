import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { genericCatalogError, messageFrom } from '@/items/errors';
import {
  clearActionPostedReloadSnapshot,
  snapshotActionPostedReloads,
} from '@/items/request-id';
import { formatCairo } from '@/lib/cairo';
import { offlineMoneyMessage, useReconnectReload } from '@/lib/online';
import { pageShell, secondaryButton } from '@/lib/page-style';
import {
  loadQueuePage,
  loadQueueRow,
  loadUnlinkedRefunds,
} from '@/order-decisions/api';
import { DecisionCard, NoticeView } from '@/order-decisions/DecisionCard';
import {
  reloadFailedMessage,
  type OrderDecisionDraft,
} from '@/order-decisions/DecisionForm';
import { decisionSubject, moneyText } from '@/order-decisions/format';
import { orderIdFromDecisionSubject } from '@/order-decisions/held-decisions';
import { PendingSaves } from '@/order-decisions/PendingSaves';
import type {
  DecisionNotice,
  QueueFilter,
  QueueRow,
  UnlinkedRefund,
} from '@/order-decisions/types';

type Entry = { row: QueueRow; closed: boolean };

type Rescued = { orderId: string; notice: DecisionNotice };

const filters: ReadonlyArray<readonly [QueueFilter, string]> = [
  ['pending', 'محتاجة قرار'],
  ['all', 'كل الطلبات'],
];

export function OrderDecisionsPage() {
  const [filter, setFilter] = useState<QueueFilter>('pending');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unlinked, setUnlinked] = useState<UnlinkedRefund[] | null>(null);
  const [unlinkedError, setUnlinkedError] = useState<string | null>(null);
  const [loadId, setLoadId] = useState(0);
  const [unlinkedId, setUnlinkedId] = useState(0);
  const [rescued, setRescued] = useState<Rescued[]>([]);
  const seqRef = useRef(0);
  const loadedPagesRef = useRef(1);
  const preservePagesRef = useRef(false);
  // In-memory unsent drafts keyed by orderId (never written to localStorage).
  const [drafts, setDrafts] = useState<ReadonlyMap<string, OrderDecisionDraft>>(
    () => new Map(),
  );
  const draftsRef = useRef<Map<string, OrderDecisionDraft>>(new Map());
  const entriesRef = useRef<Entry[] | null>(null);

  const handleDraftChange = useCallback(
    (orderId: string, nextDraft: OrderDecisionDraft | null) => {
      const prev = draftsRef.current.get(orderId) ?? null;
      if (nextDraft === null) {
        if (prev === null) return;
        draftsRef.current.delete(orderId);
        setDrafts((current) => {
          if (!current.has(orderId)) return current;
          const next = new Map(current);
          next.delete(orderId);
          return next;
        });
        return;
      }
      draftsRef.current.set(orderId, nextDraft);
      setDrafts((current) => {
        const next = new Map(current);
        next.set(orderId, nextDraft);
        return next;
      });
    },
    [],
  );

  const online = useReconnectReload(() => {
    preservePagesRef.current = true;
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  });

  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    const isReconnect = preservePagesRef.current;
    const pagesToLoad = isReconnect ? Math.max(1, loadedPagesRef.current) : 1;
    preservePagesRef.current = false;
    const pendingReloads = snapshotActionPostedReloads({
      prefix: 'order-decision:',
    });
    void (async () => {
      try {
        const merged: QueueRow[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        let nextCursor: string | null = null;
        let loadedCount = 0;
        for (let index = 0; index < pagesToLoad; index += 1) {
          const page = await loadQueuePage(filter, cursor);
          if (cancelled || seq !== seqRef.current) return;
          loadedCount += 1;
          for (const row of page.rows) {
            if (!seen.has(row.orderId)) {
              seen.add(row.orderId);
              merged.push(row);
            }
          }
          nextCursor = page.next;
          if (nextCursor === null) break;
          cursor = nextCursor;
        }
        loadedPagesRef.current = Math.max(1, loadedCount);
        const nextEntries: Entry[] = merged.map((row) => ({
          row,
          closed: false,
        }));
        // If earlier orders entered the queue while offline and pushed a
        // drafted card past the loaded pages, keep the drafted card rendered
        // (and draftsRef also restores it by orderId if it later remounts).
        if (isReconnect && entriesRef.current) {
          for (const previous of entriesRef.current) {
            if (
              !seen.has(previous.row.orderId) &&
              draftsRef.current.has(previous.row.orderId)
            ) {
              seen.add(previous.row.orderId);
              nextEntries.push(previous);
            }
          }
        }
        entriesRef.current = nextEntries;
        setEntries(nextEntries);
        setNext(nextCursor);
        setLoadError(null);
        setMoreError(null);
        // Clear posted_reload pins directly covered by loaded rows, AND verify
        // any remaining posted_reload pins (e.g., closed decisions or later
        // pages) directly by order id via loadQueueRow(orderId).
        const loadedSubjects = new Set(
          merged.map((row) => decisionSubject(row.orderId)),
        );
        const directlyCovered = pendingReloads.filter(
          (entry) =>
            loadedSubjects.has(entry.subject) &&
            entry.readTarget === entry.subject,
        );
        clearActionPostedReloadSnapshot(directlyCovered);
        const unverified = pendingReloads.filter(
          (entry) =>
            !loadedSubjects.has(entry.subject) &&
            entry.readTarget === entry.subject,
        );
        if (unverified.length > 0) {
          await Promise.all(
            unverified.map(async (pin) => {
              const orderId = orderIdFromDecisionSubject(pin.subject);
              if (!orderId) return;
              try {
                await loadQueueRow(orderId);
                if (cancelled || seq !== seqRef.current) return;
                clearActionPostedReloadSnapshot([pin], pin.subject);
              } catch {
                // Keep posted_reload held until a direct read for this order succeeds.
              }
            }),
          );
        }
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
  }, [filter, loadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await loadUnlinkedRefunds();
        if (cancelled) return;
        setUnlinked(rows);
        setUnlinkedError(null);
      } catch (error) {
        if (cancelled) return;
        setUnlinkedError(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadId, unlinkedId]);

  function reload() {
    loadedPagesRef.current = 1;
    preservePagesRef.current = false;
    setLoading(true);
    setLoadError(null);
    setEntries(null);
    setNext(null);
    setLoadId((value) => value + 1);
  }

  function refresh() {
    setRescued([]);
    reload();
  }

  function showRescued(orderId: string, notice: DecisionNotice) {
    setRescued((current) => [
      ...current.filter((item) => item.orderId !== orderId),
      { orderId, notice },
    ]);
  }

  // A recovered save refreshes only its own order and the refund list, so the
  // forms and drafts of every other order stay mounted.
  function settled(orderId: string, notice: DecisionNotice) {
    showRescued(orderId, notice);
    if (notice.kind !== 'saved' || notice.result.status !== 'ok') return;
    setUnlinkedId((value) => value + 1);
    void reloadRow(orderId).catch(() =>
      showRescued(orderId, { ...notice, warning: reloadFailedMessage }),
    );
  }

  function chooseFilter(value: QueueFilter) {
    if (value === filter) return;
    loadedPagesRef.current = 1;
    preservePagesRef.current = false;
    setEntries(null);
    setNext(null);
    setLoadError(null);
    setLoading(true);
    setFilter(value);
  }

  async function loadMore() {
    if (next === null || loadingMore) return;
    const seq = seqRef.current;
    const pendingReloads = snapshotActionPostedReloads({
      prefix: 'order-decision:',
    });
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await loadQueuePage(filter, next);
      if (seq !== seqRef.current) return;
      loadedPagesRef.current += 1;
      setEntries((current) => {
        const byId = new Map(page.rows.map((row) => [row.orderId, row]));
        const updated = (current ?? []).map((entry) => {
          const refreshed = byId.get(entry.row.orderId);
          return refreshed ? { row: refreshed, closed: false } : entry;
        });
        const known = new Set(updated.map((entry) => entry.row.orderId));
        const combined = [
          ...updated,
          ...page.rows
            .filter((row) => !known.has(row.orderId))
            .map((row) => ({ row, closed: false })),
        ];
        entriesRef.current = combined;
        return combined;
      });
      setNext(page.next);
      const loadedSubjects = new Set(
        page.rows.map((row) => decisionSubject(row.orderId)),
      );
      clearActionPostedReloadSnapshot(
        pendingReloads.filter(
          (entry) =>
            loadedSubjects.has(entry.subject) &&
            entry.readTarget === entry.subject,
        ),
      );
    } catch (error) {
      if (seq === seqRef.current) setMoreError(messageFrom(error));
    } finally {
      setLoadingMore(false);
    }
  }

  const reloadRow = useCallback(async (orderId: string): Promise<void> => {
    const subj = decisionSubject(orderId);
    const pendingReloads = snapshotActionPostedReloads({ subject: subj });
    const row = await loadQueueRow(orderId);
    clearActionPostedReloadSnapshot(pendingReloads, subj);
    setEntries((current) => {
      const updated =
        current === null
          ? current
          : current.map((entry) =>
              entry.row.orderId !== orderId
                ? entry
                : row === null
                  ? { row: entry.row, closed: true }
                  : { row, closed: false },
            );
      entriesRef.current = updated;
      return updated;
    });
  }, []);

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">قرارات الطلبات</h1>
      {!online ? <p role="status">{offlineMoneyMessage}</p> : null}
      <p>الطلبات الملغية والمرتجعة: اتعملت ولا ماتعملتش؟</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="التصفية">
        {filters.map(([value, label]) => (
          <button
            key={value}
            className={secondaryButton}
            type="button"
            aria-pressed={filter === value}
            onClick={() => chooseFilter(value)}
          >
            {label}
          </button>
        ))}
        <button className={secondaryButton} type="button" onClick={refresh}>
          {loadError ? 'إعادة المحاولة' : 'تحديث'}
        </button>
      </div>
      <PendingSaves
        shown={
          new Set(
            (entries ?? [])
              .filter((entry) => !entry.closed)
              .map((entry) => entry.row.orderId),
          )
        }
        onSettled={settled}
        onVerifyPosted={reloadRow}
      />
      {rescued.map((item) => (
        <section
          key={item.orderId}
          className="flex flex-col gap-1"
          aria-label={`نتيجة إعادة المحاولة لطلب ${item.orderId}`}
        >
          <NoticeView notice={item.notice} hideMoney={!online} />
        </section>
      ))}
      {loading && entries === null ? <p>جاري تحميل الطلبات…</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {entries && entries.length === 0 ? (
        <p>
          {filter === 'pending'
            ? 'مفيش طلبات محتاجة قرار'
            : 'مفيش طلبات ملغية أو مرتجعة'}
        </p>
      ) : null}
      {entries && entries.length > 0 ? (
        <div className="flex flex-col gap-3">
          {entries.map((entry) => (
            <DecisionCard
              key={entry.row.orderId}
              row={entry.row}
              closed={entry.closed}
              hideMoney={!online}
              savedDraft={drafts.get(entry.row.orderId)}
              onDraftChange={handleDraftChange}
              onChanged={reloadRow}
            />
          ))}
        </div>
      ) : null}
      {online && moreError ? <p role="alert">{moreError}</p> : null}
      {online && next !== null ? (
        <button
          className={secondaryButton}
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          عرض المزيد
        </button>
      ) : null}
      {online && entries === null && !loading && !loadError ? (
        <p role="alert">{genericCatalogError}</p>
      ) : null}
      {online ? (
        <section
          className="flex flex-col gap-2"
          aria-label="مرتجعات من غير طلب"
        >
          <h2 className="text-lg font-semibold">مرتجعات من غير طلب</h2>
          {unlinkedError ? <p role="alert">{unlinkedError}</p> : null}
          {unlinked && unlinked.length === 0 ? (
            <p>مفيش مرتجعات من غير طلب</p>
          ) : null}
          {unlinked && unlinked.length > 0 ? (
            <ul>
              {unlinked.map((refund) => (
                <li key={`${refund.shiftId}/${refund.txId}`}>
                  {formatCairo(refund.occurredAt)} —{' '}
                  <span dir="ltr">{moneyText(refund.amount)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
