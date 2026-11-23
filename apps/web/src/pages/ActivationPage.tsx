import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ACTIVATION_SUBJECT,
  useActivationAction,
} from '@/accounting/activation-action';
import { loadOpeningReview } from '@/accounting/api';
import { ActivationReview } from '@/accounting/ActivationReview';
import type { OpeningReview } from '@/accounting/types';
import { messageFrom } from '@/items/errors';
import {
  clearActionPostedReloadSnapshot,
  snapshotActionPostedReloads,
} from '@/items/request-id';
import { offlineMoneyMessage, useReconnectReload } from '@/lib/online';
import { pageShell, secondaryButton } from '@/lib/page-style';

export function ActivationPage() {
  const [review, setReview] = useState<OpeningReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const seqRef = useRef(0);

  const online = useReconnectReload(() => {
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  });

  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    const pendingReloads = snapshotActionPostedReloads({
      subject: ACTIVATION_SUBJECT,
    });
    void (async () => {
      try {
        const next = await loadOpeningReview();
        if (cancelled || seq !== seqRef.current) return;
        setReview(next);
        setLoadError(null);
        if (next.activated) {
          await clearActionPostedReloadSnapshot(
            pendingReloads,
            ACTIVATION_SUBJECT,
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
  }, [loadId]);

  const activation = useActivationAction(review, setReview);

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">مراجعة التفعيل</h1>
      {!online ? <p role="status">{offlineMoneyMessage}</p> : null}
      {online && loading && review === null ? (
        <p>جاري تحميل المراجعة…</p>
      ) : null}
      {loadError ? (
        <>
          <p>{loadError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={!online}
            onClick={() => setLoadId((value) => value + 1)}
          >
            إعادة تحميل المراجعة
          </button>
        </>
      ) : null}
      {review ? (
        <ActivationReview
          review={review}
          checkedZeroIds={activation.checkedZeroIds}
          checksLocked={activation.checksLocked}
          hideMoney={!online}
          onToggleZero={activation.toggleZero}
          notice={activation.notice}
          showActivate={activation.showActivate}
          activateLabel={activation.activateLabel}
          activateDisabled={activation.activateDisabled}
          onActivate={() => void activation.activate()}
        />
      ) : null}
    </main>
  );
}
