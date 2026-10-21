import { useState } from 'react';
import { formatStoredFactor } from '@/items/format';
import { unitLabels } from '@/items/labels';
import { formatMoneyText } from '@/purchases/decimal';
import type { Purchase } from '@/purchases/types';
import { formatCairoDateTime } from '@/purchases/time';
import { unitLabel } from '@/purchases/validation';

export function PurchaseList({
  purchases,
}: {
  purchases: readonly Purchase[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (purchases.length === 0) return <p>لسه مفيش مشتريات</p>;

  return (
    <div className="flex flex-col gap-3">
      {purchases.map((purchase) => {
        const open = openId === purchase.id;
        const label = purchase.supplier ?? 'من غير مورد';
        return (
          <article
            key={purchase.id}
            aria-label={label}
            className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">{label}</h2>
                <p>{formatCairoDateTime(purchase.purchasedAt)}</p>
              </div>
              <p>{formatMoneyText(purchase.totalPaid)}</p>
            </div>
            {purchase.invoiceNo ? (
              <p>{`فاتورة ${purchase.invoiceNo}`}</p>
            ) : null}
            {purchase.note ? <p>{purchase.note}</p> : null}
            <button
              className="w-fit rounded border border-neutral-300 px-3 py-2"
              type="button"
              aria-expanded={open}
              onClick={() =>
                setOpenId((current) =>
                  current === purchase.id ? null : purchase.id,
                )
              }
            >
              التفاصيل
            </button>
            {open ? (
              <ul className="flex flex-col gap-2">
                {purchase.lines.map((line) => (
                  <li key={line.lineNo}>
                    {`${line.itemName}: ${formatStoredFactor(line.quantity)} ${unitLabel(line.unit, line.baseUnit)}`}
                    {line.unit === line.baseUnit
                      ? ''
                      : ` = ${formatStoredFactor(line.baseQuantity)} ${unitLabels[line.baseUnit]}`}
                    {` — ${formatMoneyText(line.amountPaid)}`}
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
