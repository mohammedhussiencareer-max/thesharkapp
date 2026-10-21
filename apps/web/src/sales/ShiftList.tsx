import { Link } from 'react-router-dom';
import { formatCairo } from '@/lib/cairo';
import { formatEgpText } from '@/lib/money';
import { reconciliationBadge, unknownTxLabel } from '@/sales/badges';
import type { ShiftSummary } from '@/sales/types';

function countLine(shift: ShiftSummary): string {
  return `ملغي ${shift.ordersCanceled.toString()} · مفتوح ${shift.ordersOpen.toString()} · ناقص ${shift.ordersMissing.toString()}`;
}

export function ShiftList({ shifts }: { shifts: readonly ShiftSummary[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {shifts.map((shift) => {
        const unknown = unknownTxLabel(shift.unknownTx);
        const opened = formatCairo(shift.openedAt);
        return (
          <li key={shift.shiftId}>
            <article className="flex flex-col gap-1 rounded border border-neutral-300 p-3">
              <h2 className="text-lg font-semibold">
                <Link to={`/sales/${encodeURIComponent(shift.shiftId)}`}>
                  وردية {opened}
                </Link>
              </h2>
              <p>
                {shift.closedAt === null
                  ? 'لسه مفتوحة'
                  : `قفلت ${formatCairo(shift.closedAt)}`}
              </p>
              <p>طلبات مكتملة {shift.ordersComplete.toString()}</p>
              <p>صافي المبيعات {formatEgpText(shift.netSales)}</p>
              <p>مرتجعات {formatEgpText(shift.refunds)}</p>
              <p>{countLine(shift)}</p>
              <p>{reconciliationBadge(shift)}</p>
              {unknown ? <p>{unknown}</p> : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}
