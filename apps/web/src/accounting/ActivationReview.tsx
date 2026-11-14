import { checklistLabels } from '@/accounting/labels';
import type { OpeningReview, RosterItem } from '@/accounting/types';
import { unitLabels } from '@/items/labels';
import { formatCairo } from '@/lib/cairo';
import { primaryButton } from '@/lib/page-style';

const noChecks = new Set<string>();

function Num({ value }: { value: string }) {
  return <span dir="ltr">{value}</span>;
}

function unitName(unit: string): string {
  if (unit === 'kg' || unit === 'piece' || unit === 'liter') {
    return unitLabels[unit];
  }
  return unit;
}

function RosterRow({
  item,
  checked,
  checksLocked,
  onToggleZero,
}: {
  item: RosterItem;
  checked: boolean;
  checksLocked: boolean;
  onToggleZero?: (itemId: string) => void;
}) {
  const observation = item.observation;
  const repeated =
    observation !== null &&
    !observation.explicitZero &&
    item.openingLineCount !== '0' &&
    item.openingLineCount !== '1';
  return (
    <article className="flex flex-col gap-1 rounded border border-neutral-300 p-3">
      <h2 className="text-lg font-semibold">{item.name}</h2>
      <p>{unitName(item.baseUnit)}</p>
      {item.active ? null : <p>موقوف</p>}
      {observation?.explicitZero ? (
        <p>رصيد صفر مسجّل</p>
      ) : item.missing || observation === null ? (
        <>
          <p>مفيش رصد — الصفر لازم يتسجل صراحة</p>
          {onToggleZero ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={checked}
                disabled={checksLocked}
                onChange={() => onToggleZero(item.itemId)}
              />
              صفر صريح
            </label>
          ) : null}
        </>
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

export function ActivationReview({
  review,
  checkedZeroIds = noChecks,
  checksLocked = false,
  onToggleZero,
  notice = null,
  showActivate = false,
  activateLabel = 'تفعيل الخصم',
  activateDisabled = true,
  onActivate,
}: {
  review: OpeningReview;
  checkedZeroIds?: ReadonlySet<string>;
  checksLocked?: boolean;
  onToggleZero?: (itemId: string) => void;
  notice?: string | null;
  showActivate?: boolean;
  activateLabel?: string;
  activateDisabled?: boolean;
  onActivate?: () => void;
}) {
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
      {notice ? <p>{notice}</p> : null}
      {showActivate ? (
        <button
          className={primaryButton}
          type="button"
          disabled={activateDisabled}
          onClick={onActivate}
        >
          {activateLabel}
        </button>
      ) : null}
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
          <RosterRow
            key={item.itemId}
            item={item}
            checked={checkedZeroIds.has(item.itemId)}
            checksLocked={checksLocked}
            onToggleZero={onToggleZero}
          />
        ))}
      </section>
    </div>
  );
}
