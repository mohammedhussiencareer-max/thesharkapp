import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { genericCatalogError, messageFrom } from '@/items/errors';
import { formatCairo } from '@/lib/cairo';
import { pageShell, secondaryButton } from '@/lib/page-style';
import { loadSalesHome } from '@/sales/api';
import { ShiftList } from '@/sales/ShiftList';
import type { ShiftSummary } from '@/sales/types';

export function SalesPage() {
  const [shifts, setShifts] = useState<ShiftSummary[] | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const home = await loadSalesHome();
        if (cancelled || seq !== seqRef.current) return;
        setShifts(home.shifts);
        setLastSyncAt(home.lastSyncAt);
        setLoadError(null);
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
  }, [loadId]);

  function reload() {
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">المبيعات</h1>
      {lastSyncAt ? <p>آخر مزامنة {formatCairo(lastSyncAt)}</p> : null}
      <button className={secondaryButton} type="button" onClick={reload}>
        {loadError ? 'إعادة المحاولة' : 'تحديث'}
      </button>
      {loading && shifts === null ? <p>جاري تحميل المبيعات…</p> : null}
      {loadError ? <p role="alert">{loadError}</p> : null}
      {shifts && shifts.length === 0 ? <p>لسه مفيش مبيعات متزامنة</p> : null}
      {shifts && shifts.length > 0 ? <ShiftList shifts={shifts} /> : null}
      {shifts === null && !loading && !loadError ? (
        <p role="alert">{genericCatalogError}</p>
      ) : null}
    </main>
  );
}
