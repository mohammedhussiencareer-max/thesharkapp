import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatCairo } from '@/lib/cairo';
import { formatEgpText } from '@/lib/money';
import { pageShell } from '@/lib/page-style';
import { reconciliationBadge, unknownTxLabel } from '@/sales/badges';
import { formatLineQty } from '@/sales/format';
import { orderTypeLabel, paymentLabel, statusLabel } from '@/sales/labels';
import type { SalesOrder, ShiftDetail as ShiftDetailData } from '@/sales/types';

function OrderLines({ order }: { order: SalesOrder }) {
  if (order.lines.length === 0) return <p>مفيش سطور</p>;
  return (
    <ul className="flex flex-col gap-2 ps-4">
      {order.lines.map((line) => (
        <li key={line.lineId}>
          <p>{line.itemName ?? 'صنف بدون اسم'}</p>
          <p>{line.sizeName ?? '—'}</p>
          <p>{formatLineQty(line)}</p>
          <p>{formatEgpText(line.lineTotal)}</p>
          {line.optionValues.length > 0 ? (
            <p>{line.optionValues.join('، ')}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function OrderRow({ order }: { order: SalesOrder }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>{order.orderNumber ?? '—'}</td>
        <td>{formatCairo(order.orderedAt)}</td>
        <td>{orderTypeLabel(order.orderType)}</td>
        <td>{paymentLabel(order.paymentType)}</td>
        <td>
          {statusLabel(order.status)}
          {order.missingFromPos ? ' — مش موجود في الـ POS' : ''}
        </td>
        <td>{formatEgpText(order.total)}</td>
        <td>{formatEgpText(order.refunded)}</td>
        <td>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            السطور
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={8}>
            <OrderLines order={order} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function ShiftDetailView({ detail }: { detail: ShiftDetailData }) {
  const { summary } = detail;
  const unknown = unknownTxLabel(summary.unknownTx);
  const opened = formatCairo(summary.openedAt);
  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/sales">
          المبيعات
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">وردية {opened}</h1>
      <p>
        {summary.closedAt === null
          ? 'لسه مفتوحة'
          : `قفلت ${formatCairo(summary.closedAt)}`}
      </p>
      <p>طلبات مكتملة {summary.ordersComplete.toString()}</p>
      <p>صافي المبيعات {formatEgpText(summary.netSales)}</p>
      <p>مرتجعات {formatEgpText(summary.refunds)}</p>
      <p>
        ملغي {summary.ordersCanceled.toString()} · مفتوح{' '}
        {summary.ordersOpen.toString()} · ناقص{' '}
        {summary.ordersMissing.toString()}
      </p>
      <p>{reconciliationBadge(summary)}</p>
      {unknown ? <p>{unknown}</p> : null}
      <table className="w-full border-collapse text-start">
        <caption className="sr-only">طلبات الوردية</caption>
        <thead>
          <tr>
            <th>الرقم</th>
            <th>الوقت</th>
            <th>النوع</th>
            <th>الدفع</th>
            <th>الحالة</th>
            <th>الإجمالي</th>
            <th>المرتجع</th>
            <th>السطور</th>
          </tr>
        </thead>
        <tbody>
          {detail.orders.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </tbody>
      </table>
    </main>
  );
}
