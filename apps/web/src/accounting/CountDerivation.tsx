import { useEffect, useState } from 'react';
import { loadCountDerivation } from '@/accounting/api';
import { movementLabel } from '@/accounting/labels';
import type { CountDerivation, CountPosting } from '@/accounting/types';
import { historySurplusWarning } from '@/counts/errors';
import { formatFrequency } from '@/counts/format';
import { messageFrom } from '@/items/errors';
import { formatCairo } from '@/lib/cairo';
import { formatEgpText } from '@/lib/money';
import { secondaryButton } from '@/lib/page-style';

const postingRoleLabels: Record<CountPosting['role'], string> = {
  original: 'الجرد الأصلي',
  compensation: 'تعويض جرد',
  adjustment: 'تعديل قيمة',
};

function Qty({ value }: { value: string }) {
  return <span dir="ltr">{value}</span>;
}

function DetailBody({ detail }: { detail: CountDerivation }) {
  return (
    <div className="flex flex-col gap-3">
      {detail.countedAt ? <p>{formatCairo(detail.countedAt)}</p> : null}
      {detail.frequency ? <p>{formatFrequency(detail.frequency)}</p> : null}
      {detail.waitingForSync ? <p>مستني مزامنة تغطي الجرد</p> : null}
      {detail.waitingForProcessing ? <p>مستني معالجة الخصم</p> : null}
      {detail.hasSurplus ? <p>{historySurplusWarning}</p> : null}
      {detail.lines.map((line) => (
        <article key={line.lineNo} className="flex flex-col gap-2">
          <h4 className="font-semibold">
            {line.name} <span dir="ltr">{line.lineNo}</span>
          </h4>
          <section aria-label="الرصد الأصلي" className="flex flex-col gap-1">
            <h5 className="font-semibold">الرصد الأصلي</h5>
            <p>
              المعدود <Qty value={line.countedQty} />
            </p>
            <p>
              المتوقع <Qty value={line.originalExpectedQty} />
            </p>
            <p>
              فرق الكمية <Qty value={line.originalDeltaQty} />
            </p>
            <p>فرق القيمة {formatEgpText(line.originalDeltaValue)}</p>
          </section>
          <section aria-label="التسوية الحالية" className="flex flex-col gap-1">
            <h5 className="font-semibold">التسوية الحالية</h5>
            <p>
              المتوقع <Qty value={line.latestExpectedQty} />
            </p>
            <p>
              التسوية المطلوبة <Qty value={line.latestRequiredQty} />
            </p>
            <p>قيمة التسوية {formatEgpText(line.latestRequiredValue)}</p>
            <p>
              مجموع التعويض <Qty value={line.compensatorQty} />
            </p>
            <p>قيمة التعويض {formatEgpText(line.compensatorValue)}</p>
          </section>
          {line.originalSurplus || line.derivedSurplus ? (
            <p>{historySurplusWarning}</p>
          ) : null}
          {line.derivations.length > 0 ? (
            <ol aria-label="سجل الاشتقاق">
              {line.derivations.map((row) => (
                <li key={row.id}>
                  متوقع <Qty value={row.expectedQty} /> — مطلوب{' '}
                  <Qty value={row.requiredQty} /> —{' '}
                  {formatEgpText(row.requiredValue)} —{' '}
                  {formatCairo(row.createdAt)}
                </li>
              ))}
            </ol>
          ) : null}
          {line.postings.length > 0 ? (
            <ul aria-label="سجل التعويض">
              {line.postings.map((posting) => (
                <li key={posting.movementId}>
                  {postingRoleLabels[posting.role]} —{' '}
                  {movementLabel(posting.movementType)} —{' '}
                  <Qty value={posting.quantity} /> —{' '}
                  {formatEgpText(posting.totalCost)}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
    </div>
  );
}

/**
 * Loads derivation history for one count when the owner asks for it.
 * A page refresh drops the cached detail. Opening again reads it again.
 */
export function CountDerivation({
  countId,
  refreshKey = 0,
}: {
  countId: string;
  refreshKey?: number;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<CountDerivation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seenRefresh, setSeenRefresh] = useState(refreshKey);
  if (seenRefresh !== refreshKey) {
    setSeenRefresh(refreshKey);
    setDetail(null);
    setError(null);
    if (open) setLoading(true);
  }

  function toggle(): void {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setDetail(null);
    setError(null);
    setLoading(true);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadCountDerivation(countId);
        if (cancelled) return;
        setDetail(next);
        setError(null);
      } catch (failure) {
        if (cancelled) return;
        setError(messageFrom(failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, countId, refreshKey]);

  return (
    <div className="flex flex-col gap-2">
      <button
        className={secondaryButton}
        type="button"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        تفاصيل الاشتقاق
      </button>
      {open && loading ? <p>جاري تحميل الاشتقاق…</p> : null}
      {open && error ? <p role="alert">{error}</p> : null}
      {open && detail && !detail.found ? <p>الجرد مش موجود</p> : null}
      {open && detail?.found ? <DetailBody detail={detail} /> : null}
    </div>
  );
}
