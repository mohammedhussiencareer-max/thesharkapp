import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { genericCatalogError, messageFrom } from '@/items/errors';
import { cairoDateIso, formatCairo } from '@/lib/cairo';
import { pageShell, secondaryButton } from '@/lib/page-style';
import { orderCoverageText } from '@/mapping/format';
import { loadCoverage } from '@/mapping/api';
import type { Coverage, OrderTypeCoverage } from '@/mapping/types';
import {
  loadObservedOrderTypes,
  loadOrderTypePackaging,
  loadPackagingCatalog,
} from '@/packaging/api';
import { PackagingEditor } from '@/packaging/PackagingEditor';
import { orderTypeTitle } from '@/packaging/format';
import { orderTypePackagingSubject } from '@/packaging/subjects';
import type {
  ObservedOrderType,
  PackagingCatalog,
  PackagingDetail,
} from '@/packaging/types';
import {
  cairoDateStartIso,
  cairoNextDateStartIso,
  dateRangeError,
} from '@/purchases/time';

function typeCoverageText(
  row: OrderTypeCoverage | undefined,
  loaded: boolean,
): string {
  if (!loaded) return '…';
  if (!row) return 'مش في الفترة';
  if (row.eligible === 0 || row.coverage === null) return '—';
  return `${row.covered} من ${row.eligible}`;
}

export function PackagingPage() {
  const today = cairoDateIso();
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [types, setTypes] = useState<ObservedOrderType[] | null>(null);
  const [catalog, setCatalog] = useState<PackagingCatalog | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    key: string;
    value: PackagingDetail;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const fromDateRef = useRef(fromDate);
  const toDateRef = useRef(toDate);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const selectedKeyRef = useRef<string | null>(null);
  const rangeError = dateRangeError(fromDate, toDate);

  const loadHome = useCallback(async (gen: number) => {
    const from = fromDateRef.current;
    const to = toDateRef.current;
    try {
      const fromIso = cairoDateStartIso(from);
      const toIso = cairoNextDateStartIso(to);
      const range = dateRangeError(from, to);
      if (!fromIso || !toIso || range) {
        throw new Error(range ?? 'فترة التغطية مش مظبوطة');
      }
      const [nextTypes, nextCatalog, nextCoverage] = await Promise.all([
        loadObservedOrderTypes(),
        loadPackagingCatalog(),
        loadCoverage(fromIso, toIso),
      ]);
      if (gen !== listSeq.current) return null;
      setTypes(nextTypes);
      setCatalog(nextCatalog);
      setCoverage(nextCoverage);
      setLoadError(null);
      return nextTypes;
    } catch (error) {
      if (gen !== listSeq.current) return null;
      setLoadError(messageFrom(error));
      throw error;
    } finally {
      if (gen === listSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fromDateRef.current = fromDate;
    toDateRef.current = toDate;
  }, [fromDate, toDate]);

  useEffect(() => {
    const gen = ++listSeq.current;
    void loadHome(gen).catch(() => undefined);
    return () => {
      if (listSeq.current === gen) listSeq.current += 1;
    };
  }, [fromDate, loadHome, loadId, toDate]);

  const selected = types?.find((row) => row.key === selectedKey) ?? null;

  useEffect(() => {
    if (!selected) return;
    const seq = ++detailSeq.current;
    const key = selected.key;
    let cancelled = false;
    const current = selected;
    void (async () => {
      try {
        const next = await loadOrderTypePackaging(current.label);
        if (
          cancelled ||
          seq !== detailSeq.current ||
          selectedKeyRef.current !== key
        ) {
          return;
        }
        setDetail({ key, value: next });
        setDetailError(null);
      } catch (error) {
        if (
          cancelled ||
          seq !== detailSeq.current ||
          selectedKeyRef.current !== key
        ) {
          return;
        }
        setDetail(null);
        setDetailError(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  async function reload() {
    const keyAtStart = selectedKeyRef.current;
    const gen = ++listSeq.current;
    const nextTypes = await loadHome(gen);
    if (!nextTypes || gen !== listSeq.current) return;
    if (keyAtStart === null || selectedKeyRef.current !== keyAtStart) return;
    const current = nextTypes.find((row) => row.key === keyAtStart);
    if (!current) return;
    const detailRequest = ++detailSeq.current;
    const next = await loadOrderTypePackaging(current.label);
    if (
      gen !== listSeq.current ||
      detailRequest !== detailSeq.current ||
      selectedKeyRef.current !== keyAtStart
    ) {
      return;
    }
    setDetail({ key: keyAtStart, value: next });
    setDetailError(null);
  }

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
        {' — '}
        <Link className="underline" to="/mapping">
          ربط الكاشير
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">التغليف</h1>
      <section className="flex flex-col gap-2" aria-label="تغطية الطلبات">
        <h2 className="text-xl font-semibold">تغطية الطلبات</h2>
        <p>الورديات اللي فتحت في الفترة دي بتوقيت القاهرة.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex flex-col gap-1">
            من تاريخ
            <input
              className="rounded border border-neutral-300 px-3 py-2"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            إلى تاريخ
            <input
              className="rounded border border-neutral-300 px-3 py-2"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
            />
          </label>
        </div>
        {rangeError ? <p role="alert">{rangeError}</p> : null}
        {coverage ? (
          <>
            <p>تغطية الطلبات {orderCoverageText(coverage)}</p>
            <p>
              سطر {coverage.orders.causes.line}، تغليف مش متراجع{' '}
              {coverage.orders.causes.packagingUnreviewed}، موقوف{' '}
              {coverage.orders.causes.blocked}
            </p>
            {coverage.stockStart ? (
              <p>بداية المخزون {formatCairo(coverage.stockStart)}</p>
            ) : (
              <p>لسه مفيش رصيد افتتاحي</p>
            )}
          </>
        ) : null}
      </section>
      <button
        className={secondaryButton}
        type="button"
        onClick={() => {
          setLoading(true);
          setLoadError(null);
          setLoadId((value) => value + 1);
        }}
      >
        {loadError ? 'إعادة المحاولة' : 'تحديث'}
      </button>
      {loading && types === null ? <p>جاري تحميل التغليف…</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {types && types.length === 0 ? (
        <p>لسه مفيش أنواع طلبات من الكاشير</p>
      ) : null}
      {types && types.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="أنواع الطلبات">
          {types.map((row) => {
            const period = coverage?.orderTypes.find(
              (entry) => entry.key === row.key,
            );
            return (
              <li key={row.keyText}>
                <button
                  className="w-full rounded border border-neutral-300 px-3 py-2 text-start"
                  type="button"
                  aria-pressed={row.key === selectedKey}
                  onClick={() => {
                    if (row.key === selectedKeyRef.current) return;
                    selectedKeyRef.current = row.key;
                    detailSeq.current += 1;
                    setDetail(null);
                    setDetailError(null);
                    setSelectedKey(row.key);
                  }}
                >
                  {orderTypeTitle(row.label)} —{' '}
                  {typeCoverageText(period, coverage !== null)} —{' '}
                  {row.orderCount} طلب
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {detailError ? <p role="alert">{detailError}</p> : null}
      {selected && !detailError && (!detail || detail.key !== selected.key) ? (
        <p>جاري تحميل النوع…</p>
      ) : null}
      {selected && detail && detail.key === selected.key && catalog ? (
        <PackagingEditor
          subjectKey={orderTypePackagingSubject(selected.key)}
          kind="order_type"
          orderType={selected.label}
          schedule={detail.value.schedule}
          history={detail.value.history}
          items={catalog.items}
          units={catalog.units}
          shiftStart={catalog.shiftStart}
          allowCapacity={false}
          onReload={reload}
        />
      ) : null}
      {types === null && !loading && !loadError ? (
        <p role="alert">{genericCatalogError}</p>
      ) : null}
    </main>
  );
}
