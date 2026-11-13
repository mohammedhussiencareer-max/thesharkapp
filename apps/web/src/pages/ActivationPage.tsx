import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadOpeningReview } from '@/accounting/api';
import { ActivationReview } from '@/accounting/ActivationReview';
import type { OpeningReview } from '@/accounting/types';
import { messageFrom } from '@/items/errors';
import { pageShell, secondaryButton } from '@/lib/page-style';

export function ActivationPage() {
  const [review, setReview] = useState<OpeningReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadOpeningReview();
        if (cancelled || seq !== seqRef.current) return;
        setReview(next);
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

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">مراجعة التفعيل</h1>
      {loading && review === null ? <p>جاري تحميل المراجعة…</p> : null}
      {loadError ? (
        <>
          <p>{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            onClick={() => setLoadId((value) => value + 1)}
          >
            إعادة تحميل المراجعة
          </button>
        </>
      ) : null}
      {review ? <ActivationReview review={review} /> : null}
    </main>
  );
}
