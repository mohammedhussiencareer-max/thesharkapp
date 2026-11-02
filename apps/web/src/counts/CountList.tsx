import { historySurplusWarning } from '@/counts/errors';
import { formatFrequency } from '@/counts/format';
import type { CountRecord } from '@/counts/types';
import { formatMoneyText } from '@/purchases/decimal';
import { formatCairoDateTime } from '@/purchases/time';

export function CountList({ counts }: { counts: readonly CountRecord[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">الجرد السابق</h2>
      {counts.length === 0 ? <p>لسه مفيش جرد</p> : null}
      {counts.map((count) => (
        <article
          key={count.id}
          aria-label={count.note ?? formatCairoDateTime(count.countedAt)}
          className="flex flex-col gap-1 rounded border border-neutral-300 p-3"
        >
          <p>{formatCairoDateTime(count.countedAt)}</p>
          <p>{formatFrequency(count.frequency)}</p>
          <p>{`الأصناف ${count.itemCount}`}</p>
          <p>{`عجز ${formatMoneyText(count.shortageValue)}`}</p>
          <p>{`زيادة ${formatMoneyText(count.surplusValue)}`}</p>
          {count.hasSurplus ? <p>{historySurplusWarning}</p> : null}
          {count.note ? <p>{count.note}</p> : null}
        </article>
      ))}
    </section>
  );
}
