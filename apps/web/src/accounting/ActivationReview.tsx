import { activationAction } from '@/accounting/activation-action';
import { checklistLabels } from '@/accounting/labels';
import type { OpeningReview, RosterItem } from '@/accounting/types';
import { unitLabels } from '@/items/labels';
import { formatCairo } from '@/lib/cairo';

function Num({ value }: { value: string }) {
  return <span dir="ltr">{value}</span>;
}

function unitName(unit: string): string {
  if (unit === 'kg' || unit === 'piece' || unit === 'liter') {
    return unitLabels[unit];
  }
  return unit;
}

function RosterRow({ item }: { item: RosterItem }) {
  const observation = item.observation;
  const repeated =
    observation !== null &&
    item.openingLineCount !== '0' &&
    item.openingLineCount !== '1';
  return (
    <article className="flex flex-col gap-1 rounded border border-neutral-300 p-3">
      <h2 className="text-lg font-semibold">{item.name}</h2>
      <p>{unitName(item.baseUnit)}</p>
      {item.active ? null : <p>موقوف</p>}
      {item.missing || observation === null ? (
        <p>مفيش رصد — الصفر لازم يتسجل صراحة</p>
      ) : (
        <>
          <p>
            الكمية <Num value={observation.quantity} /> {observation.unit}
          </p>
          <p>
            سعر الوحدة <Num value={observation.unitCost} />
          </p>
          <p>{formatCairo(observation.occurredAt)}</p>
          {repeated ? <p>اتسجل {item.openingLineCount} مرات</p> : null}
        </>
      )}
    </article>
  );
}

export function ActivationReview({ review }: { review: OpeningReview }) {
  return (
    <div className="flex flex-col gap-4">
      {review.activated ? (
        <p>
          التفعيل اتسجل
          {review.stockStartedAt
            ? ` ${formatCairo(review.stockStartedAt)}`
            : ''}
        </p>
      ) : null}
      {review.canActivate ? <p>الرصيد جاهز للتفعيل</p> : null}
      {activationAction(review)}
      <section aria-label="جاهزية التفعيل" className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">جاهزية التفعيل</h2>
        <ul>
          {review.checklist.map((item) => (
            <li key={item.code}>
              {checklistLabels[item.code]} — {item.ready ? 'جاهز' : 'ناقص'}
              {item.count === '0' ? null : (
                <>
                  {' '}
                  <Num value={item.count} />
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="قائمة الافتتاح" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">قائمة الافتتاح</h2>
        {review.roster.length === 0 ? <p>مفيش أصناف</p> : null}
        {review.roster.map((item) => (
          <RosterRow key={item.itemId} item={item} />
        ))}
      </section>
    </div>
  );
}
