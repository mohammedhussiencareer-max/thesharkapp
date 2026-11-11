import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { genericCatalogError, messageFrom } from '@/items/errors';
import { formatCairo } from '@/lib/cairo';
import { pageShell, secondaryButton } from '@/lib/page-style';
import {
  loadQueuePage,
  loadQueueRow,
  loadUnlinkedRefunds,
} from '@/order-decisions/api';
import { DecisionCard, NoticeView } from '@/order-decisions/DecisionCard';
import { reloadFailedMessage } from '@/order-decisions/DecisionForm';
import { moneyText } from '@/order-decisions/format';
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

  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const page = await loadQueuePage(filter, null);
        if (cancelled || seq !== seqRef.current) return;
        setEntries(page.rows.map((row) => ({ row, closed: false })));
        setNext(page.next);
        setLoadError(null);
        setMoreError(null);
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
    setEntries(null);
    setNext(null);
    setLoadError(null);
    setLoading(true);
    setFilter(value);
  }

  async function loadMore() {
    if (next === null || loadingMore) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await loadQueuePage(filter, next);
      if (seq !== seqRef.current) return;
      setEntries((current) => {
        const known = new Set(
          (current ?? []).map((entry) => entry.row.orderId),
        );
        return [
          ...(current ?? []),
          ...page.rows
            .filter((row) => !known.has(row.orderId))
            .map((row) => ({ row, closed: false })),
        ];
      });
      setNext(page.next);
    } catch (error) {
      if (seq === seqRef.current) setMoreError(messageFrom(error));
    } finally {
      setLoadingMore(false);
    }
  }

  const reloadRow = useCallback(async (orderId: string): Promise<void> => {
    const row = await loadQueueRow(orderId);
    setEntries((current) =>
      current === null
        ? current
        : current.map((entry) =>
            entry.row.orderId !== orderId
              ? entry
              : row === null
                ? { row: entry.row, closed: true }
                : { row, closed: false },
          ),
    );
  }, []);

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">قرارات الطلبات</h1>
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
      />
      {rescued.map((item) => (
        <section
          key={item.orderId}
          className="flex flex-col gap-1"
          aria-label={`نتيجة إعادة المحاولة لطلب ${item.orderId}`}
        >
          <NoticeView notice={item.notice} />
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
              onChanged={reloadRow}
            />
          ))}
        </div>
      ) : null}
      {moreError ? <p role="alert">{moreError}</p> : null}
      {next !== null ? (
        <button
          className={secondaryButton}
          type="button"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          عرض المزيد
        </button>
      ) : null}
      {entries === null && !loading && !loadError ? (
        <p role="alert">{genericCatalogError}</p>
      ) : null}
      <section className="flex flex-col gap-2" aria-label="مرتجعات من غير طلب">
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
    </main>
  );
}
