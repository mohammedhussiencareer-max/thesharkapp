import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatCairo } from '@/lib/cairo';
import { DecisionForm } from '@/order-decisions/DecisionForm';
import { DifferencesList } from '@/order-decisions/DifferencesList';
import {
  basisStatusLabels,
  classLabels,
  decisionLabels,
  moneyText,
  outcomeMessage,
  reviewReasonLabels,
  sourceLabels,
  unitText,
} from '@/order-decisions/format';
import type {
  DecisionNotice,
  HistoryEntry,
  QueueRow,
} from '@/order-decisions/types';

export const notActivatedMessage = 'الخصم لسه ما اتفعّلش — القرار ما اتسجلش';

function Num({ value }: { value: string }) {
  return <span dir="ltr">{value}</span>;
}

function HistoryItem({
  entry,
  hideMoney = false,
}: {
  entry: HistoryEntry;
  hideMoney?: boolean;
}) {
  return (
    <li className="flex flex-col gap-1 border-t border-neutral-200 pt-2">
      <p>
        {formatCairo(entry.createdAt)} — {decisionLabels[entry.decision]} —{' '}
        {classLabels[entry.decisionClass]} — {sourceLabels[entry.source]}
      </p>
      {entry.reason ? <p>السبب: {entry.reason}</p> : null}
      {entry.returned.length > 0 ? (
        <ul>
          {entry.returned.map((line) => (
            <li key={line.stockItemId}>
              مرتجع {line.stockItemId}: <Num value={line.returned} />
            </li>
          ))}
        </ul>
      ) : null}
      {!hideMoney ? (
        <DifferencesList
          differences={entry.differences}
          label={`فروق القرار ${entry.eventId}`}
        />
      ) : null}
    </li>
  );
}

export function NoticeView({
  notice,
  hideMoney = false,
}: {
  notice: DecisionNotice;
  hideMoney?: boolean;
}) {
  if (notice.kind === 'failed') return <p role="alert">{notice.message}</p>;
  const { result, warning } = notice;
  return (
    <div className="flex flex-col gap-2" role="status">
      {result.status === 'ok' ? (
        <>
          <p>{outcomeMessage(result.outcome, result.reason)}</p>
          {!hideMoney ? (
            <DifferencesList
              differences={result.differences}
              label="الفروق الناتجة"
            />
          ) : null}
        </>
      ) : (
        <p>{notActivatedMessage}</p>
      )}
      {warning ? <p role="alert">{warning}</p> : null}
    </div>
  );
}

export function DecisionCard({
  row,
  closed,
  hideMoney = false,
  onChanged,
}: {
  row: QueueRow;
  closed: boolean;
  hideMoney?: boolean;
  onChanged: (orderId: string) => Promise<void>;
}) {
  const [notice, setNotice] = useState<DecisionNotice | null>(null);
  const history = [...row.history].sort((a, b) => b.eventId - a.eventId);
  const title =
    row.orderNumber !== null
      ? `طلب رقم ${row.orderNumber}`
      : `طلب ${row.orderId}`;

  return (
    <article
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
      aria-label={title}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Link to={`/orders/${encodeURIComponent(row.orderId)}`}>
          تكلفة الطلب
        </Link>
        <p>{formatCairo(row.orderedAt)}</p>
        <p>
          {row.currentClass ? classLabels[row.currentClass] : classLabels.none}
          {' — '}
          {decisionLabels[row.decision]} ({sourceLabels[row.source]})
        </p>
        {row.missingFromPos ? <p>الطلب اختفى من الكاشير</p> : null}
        {row.reviewReason ? (
          <p role="alert">
            محتاج قرارك من جديد: {reviewReasonLabels[row.reviewReason]}
          </p>
        ) : null}
        {row.decisionReason ? <p>سبب القرار: {row.decisionReason}</p> : null}
      </header>
      {!hideMoney ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt>إجمالي الطلب</dt>
          <dd>
            <Num value={moneyText(row.orderTotal)} />
          </dd>
          {row.refundTotal !== null ? (
            <>
              <dt>إجمالي المرتجع</dt>
              <dd>
                <Num value={moneyText(row.refundTotal)} />
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {!hideMoney && row.refunds.length > 0 ? (
        <ul aria-label="المرتجعات">
          {row.refunds.map((refund) => (
            <li key={`${refund.shiftId}/${refund.txId}`}>
              {formatCairo(refund.occurredAt)} —{' '}
              <Num value={moneyText(refund.amount)} />
            </li>
          ))}
        </ul>
      ) : null}
      <section className="flex flex-col gap-1" aria-label="أساس التحضير">
        <h3 className="font-semibold">
          أساس التحضير ({basisStatusLabels[row.basisStatus]})
        </h3>
        {row.basisItems.length > 0 ? (
          <ul>
            {row.basisItems.map((item) => (
              <li key={item.stockItemId}>
                {item.name} — <Num value={item.quantity} />{' '}
                {unitText(item.baseUnit)}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {!hideMoney ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">الفرق عن البيع العادي</h3>
          <DifferencesList
            differences={row.differences}
            label="الفروق الحالية"
          />
        </section>
      ) : null}
      {notice ? <NoticeView notice={notice} hideMoney={hideMoney} /> : null}
      {closed ? (
        <p>الطلب ده مبقاش محتاج قرار</p>
      ) : (
        <DecisionForm
          key={`${row.token}:${row.eventId}`}
          row={row}
          onNotice={setNotice}
          onChanged={onChanged}
        />
      )}
      {history.length > 0 ? (
        <details>
          <summary>سجل القرارات ({history.length})</summary>
          <ol className="flex flex-col gap-2">
            {history.map((entry) => (
              <HistoryItem
                key={entry.eventId}
                entry={entry}
                hideMoney={hideMoney}
              />
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}
