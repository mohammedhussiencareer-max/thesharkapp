import { moneyText } from '@/order-decisions/format';
import type { Differences } from '@/order-decisions/types';

function Num({ value }: { value: string }) {
  return <span dir="ltr">{value}</span>;
}

/** The exact difference one decision makes, as the server computed it. */
export function DifferencesList({
  differences,
  label,
}: {
  differences: Differences;
  label: string;
}) {
  return (
    <dl
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"
      aria-label={label}
    >
      <dt>فرق كمية المخزون</dt>
      <dd>
        <Num value={differences.stockQuantity} />
      </dd>
      <dt>فرق قيمة المخزون</dt>
      <dd>
        <Num value={moneyText(differences.stockValue)} />
      </dd>
      <dt>فرق تكلفة المبيعات</dt>
      <dd>
        <Num value={moneyText(differences.cogs)} />
      </dd>
      <dt>فرق الهالك</dt>
      <dd>
        <Num value={moneyText(differences.waste)} />
      </dd>
      <dt>فرق الربح</dt>
      <dd>
        <Num value={moneyText(differences.profit)} />
      </dd>
    </dl>
  );
}
