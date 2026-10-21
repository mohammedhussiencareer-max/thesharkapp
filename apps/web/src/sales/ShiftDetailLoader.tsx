import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { messageFrom } from '@/items/errors';
import { pageShell, secondaryButton } from '@/lib/page-style';
import { loadShiftDetail } from '@/sales/api';
import { ShiftDetailView } from '@/sales/ShiftDetail';
import type { ShiftDetail } from '@/sales/types';

export function ShiftDetailLoader({ shiftId }: { shiftId: string }) {
  const [detail, setDetail] = useState<ShiftDetail | null | undefined>(
    undefined,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const requestKey = `${shiftId}\n${loadId.toString()}`;
  const [seenKey, setSeenKey] = useState(requestKey);
  if (seenKey !== requestKey) {
    setSeenKey(requestKey);
    setDetail(undefined);
    setLoading(true);
    setLoadError(null);
  }
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadShiftDetail(shiftId);
        if (cancelled || seq !== seqRef.current) return;
        setDetail(next);
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
  }, [loadId, shiftId]);

  function reload() {
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  if (loading && detail === undefined) {
    return (
      <main className={pageShell}>
        <p>جاري تحميل المبيعات…</p>
      </main>
    );
  }

  if (loadError && detail === undefined) {
    return (
      <main className={pageShell}>
        <p role="alert">{loadError}</p>
        <button className={secondaryButton} type="button" onClick={reload}>
          إعادة المحاولة
        </button>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className={pageShell}>
        <p>الوردية دي مش موجودة</p>
        <Link className="underline" to="/sales">
          المبيعات
        </Link>
      </main>
    );
  }

  return <ShiftDetailView detail={detail} />;
}
