import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { genericCatalogError, messageFrom } from '@/items/errors';
import { cairoDateIso, formatCairo } from '@/lib/cairo';
import { pageShell, secondaryButton } from '@/lib/page-style';
import {
  loadBases,
  loadCatalog,
  loadCoverage,
  loadSubjectDetail,
} from '@/mapping/api';
import {
  coverageText,
  orderCoverageText,
  sizeLabel,
  sortBases,
  subjectTitle,
} from '@/mapping/format';
import { statusLabel } from '@/mapping/labels';
import { SubjectPanel } from '@/mapping/SubjectPanel';
import type {
  Coverage,
  MappingCatalog,
  ObservedBase,
  SubjectDetail,
} from '@/mapping/types';
import {
  cairoDateStartIso,
  cairoNextDateStartIso,
  dateRangeError,
} from '@/purchases/time';

function baseKey(base: ObservedBase): string {
  return `${base.posItemId}\n${base.sizeKeyText}`;
}

export function MappingPage() {
  const today = cairoDateIso();
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [bases, setBases] = useState<ObservedBase[] | null>(null);
  const [catalog, setCatalog] = useState<MappingCatalog | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    key: string;
    value: SubjectDetail;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [loadId, setLoadId] = useState(0);
  // Refs, not the render that started a save. A late onReload still reads the
  // period that is on screen when the response arrives.
  const fromDateRef = useRef(fromDate);
  const toDateRef = useRef(toDate);
  // One generation for every write of bases, catalog, coverage, and load state.
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
      const [nextBases, nextCatalog, nextCoverage] = await Promise.all([
        loadBases(),
        loadCatalog(),
        loadCoverage(fromIso, toIso),
      ]);
      if (gen !== listSeq.current) return null;
      setBases(nextBases);
      setCatalog(nextCatalog);
      setCoverage(nextCoverage);
      setLoadError(null);
      return nextBases;
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

  const selected = bases?.find((base) => baseKey(base) === selectedKey) ?? null;

  useEffect(() => {
    if (!selected) return;
    const seq = ++detailSeq.current;
    const key = baseKey(selected);
    let cancelled = false;
    const current = selected;
    void (async () => {
      try {
        const next = await loadSubjectDetail(current);
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
    const nextBases = await loadHome(gen);
    if (!nextBases || gen !== listSeq.current) return;
    if (keyAtStart === null || selectedKeyRef.current !== keyAtStart) return;
    const current = nextBases.find((base) => baseKey(base) === keyAtStart);
    if (!current) return;
    const detailRequest = ++detailSeq.current;
    const next = await loadSubjectDetail(current);
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

  const shown = sortBases(bases ?? []).filter((base) =>
    onlyIncomplete ? base.mapStatus === 'incomplete' : true,
  );

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
        {' — '}
        <Link className="underline" to="/packaging">
          التغليف
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">ربط الكاشير</h1>
      <section className="flex flex-col gap-2" aria-label="التغطية">
        <h2 className="text-xl font-semibold">التغطية</h2>
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
            <p>المغطى {coverageText(coverage)}</p>
            <p>تغطية الطلبات {orderCoverageText(coverage)}</p>
            <p>
              سطر {coverage.orders.causes.line}، تغليف مش متراجع{' '}
              {coverage.orders.causes.packagingUnreviewed}، موقوف{' '}
              {coverage.orders.causes.blocked}
            </p>
            <p>
              جاهز {coverage.readyLines}، ناقص {coverage.incompleteLines}،
              استثناء {coverage.exceptionLines}
            </p>
            <p>
              ملغي {coverage.causes.canceled}، مفتوح {coverage.causes.open}،
              ناقص من الكاشير {coverage.causes.missing}، قبل بداية المخزون{' '}
              {coverage.causes.beforeStockStart}
            </p>
            {coverage.stockStart ? (
              <p>بداية المخزون {formatCairo(coverage.stockStart)}</p>
            ) : (
              <p>لسه مفيش رصيد افتتاحي</p>
            )}
          </>
        ) : null}
      </section>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={onlyIncomplete}
          onChange={(event) => setOnlyIncomplete(event.target.checked)}
        />
        غير المربوط بس
      </label>
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
      {loading && bases === null ? <p>جاري تحميل الربط…</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {bases && shown.length === 0 ? (
        <p>لسه مفيش أصناف ظاهرة من الكاشير</p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="أصناف الكاشير">
          {shown.map((base) => (
            <li key={baseKey(base)}>
              <button
                className="w-full rounded border border-neutral-300 px-3 py-2 text-start"
                type="button"
                aria-pressed={baseKey(base) === selectedKey}
                onClick={() => {
                  const key = baseKey(base);
                  // Same key does not change `selected`, so the detail effect
                  // would not replace the panel this click clears.
                  if (key === selectedKeyRef.current) return;
                  selectedKeyRef.current = key;
                  detailSeq.current += 1;
                  setDetail(null);
                  setDetailError(null);
                  setSelectedKey(key);
                }}
              >
                {subjectTitle(base)} — {sizeLabel(base.sizeKey)} —{' '}
                {statusLabel(base.mapStatus)} — {base.saleCount} عملية
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {detailError ? <p role="alert">{detailError}</p> : null}
      {selected &&
      !detailError &&
      (!detail || detail.key !== baseKey(selected)) ? (
        <p>جاري تحميل الصنف…</p>
      ) : null}
      {selected && detail && detail.key === baseKey(selected) && catalog ? (
        <SubjectPanel
          base={selected}
          detail={detail.value}
          catalog={catalog}
          onReload={reload}
        />
      ) : null}
      {bases === null && !loading && !loadError ? (
        <p role="alert">{genericCatalogError}</p>
      ) : null}
    </main>
  );
}
