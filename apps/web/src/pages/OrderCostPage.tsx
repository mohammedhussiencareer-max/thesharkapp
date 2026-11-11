import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { loadOrderCost } from '@/accounting/api';
import { OrderCostDetail } from '@/accounting/OrderCostDetail';
import type { OrderCostDetail as OrderCostDetailData } from '@/accounting/types';
import { messageFrom } from '@/items/errors';
import { pageShell, secondaryButton } from '@/lib/page-style';

export function OrderCostPage() {
  const { orderId = '' } = useParams();
  const [detail, setDetail] = useState<OrderCostDetailData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const requestKey = `${orderId}\n${loadId.toString()}`;
  const [seenKey, setSeenKey] = useState(requestKey);
  if (seenKey !== requestKey) {
    setSeenKey(requestKey);
    setDetail(null);
    setLoading(true);
    setLoadError(null);
  }
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadOrderCost(orderId);
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
  }, [loadId, orderId]);

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/sales">
          المبيعات
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">تكلفة الطلب</h1>
      {loading && detail === null ? <p>جاري تحميل التكلفة…</p> : null}
      {loadError ? (
        <>
          <p>{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            onClick={() => setLoadId((value) => value + 1)}
          >
            إعادة تحميل التكلفة
          </button>
        </>
      ) : null}
      {detail ? <OrderCostDetail detail={detail} /> : null}
    </main>
  );
}
