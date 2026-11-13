import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadShiftStatuses } from '@/accounting/api';
import type { ShiftAccountingStatus } from '@/accounting/types';
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
  const [status, setStatus] = useState<ShiftAccountingStatus | null>(null);
  const [statusCapped, setStatusCapped] = useState(false);
  const [statusMissing, setStatusMissing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [showStatus, setShowStatus] = useState(false);
  const requestKey = `${shiftId}\n${loadId.toString()}`;
  const [seenKey, setSeenKey] = useState(requestKey);
  if (seenKey !== requestKey) {
    setSeenKey(requestKey);
    setDetail(undefined);
    setLoading(true);
    setLoadError(null);
    setStatus(null);
    setStatusMissing(false);
    setStatusError(null);
    setShowStatus(false);
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

  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    const id = detail.summary.shiftId;
    void (async () => {
      try {
        const loaded = await loadShiftStatuses([id]);
        if (cancelled) return;
        const row = loaded.byId.get(id) ?? null;
        setStatus(row);
        setStatusCapped(loaded.capped);
        setStatusMissing(row === null);
        setStatusError(null);
        setShowStatus(true);
      } catch (error) {
        if (cancelled) return;
        setStatus(null);
        setStatusMissing(false);
        setShowStatus(false);
        setStatusError(messageFrom(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail]);

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

  return (
    <>
      {statusError ? (
        <p className="mx-auto w-full max-w-3xl px-4">{statusError}</p>
      ) : null}
      <ShiftDetailView
        detail={detail}
        status={status}
        statusCapped={statusCapped}
        statusMissing={statusMissing}
        showStatus={showStatus}
      />
    </>
  );
}
