import { pendingResendMessage } from '@/counts/errors';
import type { PendingCount } from '@/counts/types';
import type { Json } from '@/lib/database.types';
import { primaryButton } from '@/lib/page-style';
import { formatCairoDateTime } from '@/purchases/time';

export type PendingCountEntry = PendingCount & {
  /** Local unknown retry pin whose server reply was lost. */
  unknown?: boolean;
};

export function PendingCounts({
  counts,
  disabled,
  onResend,
}: {
  counts: readonly PendingCountEntry[];
  disabled: boolean;
  onResend: (payload: Json) => void;
}) {
  if (counts.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">جرد مستني المزامنة</h2>
      {counts.map((count) => {
        const when = count.countedAt
          ? formatCairoDateTime(count.countedAt)
          : count.requestId;
        return (
          <article
            key={count.requestId}
            aria-label={`جرد مستني ${when}`}
            className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
          >
            <p>{when}</p>
            <p>{`الأصناف ${count.itemCount}`}</p>
            {count.unknown ? <p>{pendingResendMessage}</p> : null}
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
