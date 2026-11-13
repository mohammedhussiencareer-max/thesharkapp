import { causeLabel } from '@/accounting/labels';
import { formatSignedDifference } from '@/accounting/format';
import type {
  DifferenceVector,
  ShiftAccountingStatus,
  ShiftRevision,
} from '@/accounting/types';
import { formatCairo } from '@/lib/cairo';

function revisionKinds(revisions: readonly ShiftRevision[]): string[] {
  const seen = new Set<string>();
  const kinds: string[] = [];
  for (const revision of revisions) {
    if (seen.has(revision.causeKind)) continue;
    seen.add(revision.causeKind);
    kinds.push(revision.causeKind);
  }
  return kinds;
}

function latestRevision(
  revisions: readonly ShiftRevision[],
): ShiftRevision | null {
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index];
    if (revision?.isLatest) return revision;
  }
  return revisions[revisions.length - 1] ?? null;
}

function DifferenceList({
  label,
  vector,
}: {
  label: string;
  vector: DifferenceVector;
}) {
  const rows: { term: string; value: string }[] = [
    ['فرق المبيعات', vector.netSalesDifference],
    ['تكلفة المبيعات', vector.cogsDifference],
    ['الهالك', vector.wasteDifference],
    ['الجرد', vector.countDifference],
    ['الربح', vector.profitDifference],
  ].map(([term, value]) => ({ term: term ?? '', value: value ?? '' }));
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"
    >
      {rows.map((row) => (
        <div key={row.term} className="contents">
          <dt>{row.term}</dt>
          <dd dir="ltr">{formatSignedDifference(row.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ShiftStatus({
  status,
  capped,
  missing,
}: {
  status: ShiftAccountingStatus | null;
  capped: boolean;
  missing: boolean;
}) {
  const kinds = status ? revisionKinds(status.revisions) : [];
  const sourceAt = status
    ? (latestRevision(status.revisions)?.sourceAt ?? null)
    : null;
  return (
    <section aria-label="حالة الوردية" className="flex flex-col gap-1">
      <h3 className="font-semibold">حالة الوردية</h3>
      {missing ? (
        <p>
          {capped
            ? 'حالة الوردية مش في النافذة المحمّلة'
            : 'حالة الوردية مش متاحة'}
        </p>
      ) : null}
      {status ? (
        <>
          <p>{status.statusLabel}</p>
          {status.revised ? <p>معدّل</p> : null}
          {status.causes.length > 0 ? (
            <ul aria-label="أسباب الحالة">
              {status.causes.map((code) => (
                <li key={code}>{causeLabel(code)}</li>
              ))}
            </ul>
          ) : null}
          {kinds.length > 0 ? (
            <ul aria-label="أسباب الفروق">
              {kinds.map((kind) => (
                <li key={kind}>{causeLabel(kind)}</li>
              ))}
            </ul>
          ) : null}
          {sourceAt ? (
            <p>
              وقت الواقعة <span dir="ltr">{formatCairo(sourceAt)}</span>
            </p>
          ) : null}
          <DifferenceList label="آخر فرق" vector={status.latestDifference} />
          <DifferenceList
            label="مجموع الفروق"
            vector={status.cumulativeDifference}
          />
        </>
      ) : null}
    </section>
  );
}
