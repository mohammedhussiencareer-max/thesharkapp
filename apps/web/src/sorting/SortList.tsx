import { formatCostPerKg, formatKg, formatLossMoney } from '@/sorting/format';
import type { SortRecord } from '@/sorting/types';
import { formatCairoDateTime } from '@/purchases/time';

export function SortList({ sorts }: { sorts: readonly SortRecord[] }) {
  if (sorts.length === 0) return <p>لسه مفيش فرز</p>;

  return (
    <div className="flex flex-col gap-3">
      {sorts.map((sort) => (
        <article
          key={sort.id}
          aria-label={sort.mixedItemName}
          className="flex flex-col gap-1 rounded border border-neutral-300 p-3"
        >
          <h2 className="text-base font-semibold">{sort.mixedItemName}</h2>
          <p>{formatCairoDateTime(sort.occurredAt)}</p>
          <p>{`اتاخد ${formatKg(sort.qtyTaken)}`}</p>
          <p>{`الأحجام ${formatKg(sort.sizesQty)}`}</p>
          <p>{`الفاقد ${formatKg(sort.lossQty)}`}</p>
          <p>{`قيمة الفاقد ${formatLossMoney(sort.lossValue)}`}</p>
          <p>{`تكلفة الكيلو ${formatCostPerKg(sort.costPerKg)}`}</p>
          {sort.note ? <p>{sort.note}</p> : null}
          {sort.lines.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {sort.lines.map((line) => (
                <li key={line.lineNo}>
                  {`${line.itemName}: ${formatKg(line.quantity)}`}
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      ))}
    </div>
  );
}
