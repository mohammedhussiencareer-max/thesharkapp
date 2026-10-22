import type { Json } from '@/lib/database.types';
import type { PendingCount } from '@/counts/types';
import { formatCairoDateTime } from '@/purchases/time';
import { primaryButton } from '@/lib/page-style';

export function PendingCounts({
  counts,
  disabled,
  onResend,
}: {
  counts: readonly PendingCount[];
  disabled: boolean;
  onResend: (payload: Json) => void;
}) {
  if (counts.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">جرد مستني المزامنة</h2>
      {counts.map((count) => {
        const when = formatCairoDateTime(count.countedAt);
        return (
          <article
            key={count.requestId}
            aria-label={`جرد مستني ${when}`}
            className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
          >
            <p>{when}</p>
            <p>{`الأصناف ${count.itemCount}`}</p>
            <button
              className={primaryButton}
              type="button"
              disabled={disabled}
              onClick={() => onResend(count.payload)}
            >
              سجّل الجرد
            </button>
          </article>
        );
      })}
    </section>
  );
}
