import {
  causeLabel,
  dispositionLabels,
  movementLabel,
  receiptLabels,
} from '@/accounting/labels';
import type {
  AdjustmentRow,
  CostApplication,
  CostLine,
  OrderCostDetail as OrderCostDetailData,
  PostedMovement,
  Provenance,
  ReversalRow,
} from '@/accounting/types';
import { unitLabels } from '@/items/labels';
import { formatCairo } from '@/lib/cairo';
import { formatEgpText } from '@/lib/money';

function Num({ value }: { value: string }) {
  return <span dir="ltr">{value}</span>;
}

function unitName(unit: string | null): string {
  if (unit === 'kg' || unit === 'piece' || unit === 'liter') {
    return unitLabels[unit];
  }
  return unit ?? '';
}

function IdList({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return <span>—</span>;
  return <span dir="ltr">{ids.join('، ')}</span>;
}

function Lines({ lines }: { lines: readonly CostLine[] }) {
  if (lines.length === 0) return <p>مفيش كميات محفوظة</p>;
  return (
    <ul>
      {lines.map((line) => (
        <li key={line.itemId}>
          {line.name ?? 'صنف'} —{' '}
          {line.quantity === null ? (
            'الكمية مش محفوظة'
          ) : (
            <Num value={line.quantity} />
          )}{' '}
          {unitName(line.baseUnit)}
        </li>
      ))}
    </ul>
  );
}

function MovementList({
  label,
  rows,
}: {
  label: string;
  rows: readonly PostedMovement[];
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h4 className="font-semibold">{label}</h4>
      <ul>
        {rows.map((row) => (
          <li key={row.movementId}>
            {row.name ?? 'صنف'} — {movementLabel(row.movementType)} —{' '}
            <Num value={row.quantity} /> — {formatEgpText(row.totalCost)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReversalList({ rows }: { rows: readonly ReversalRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h4 className="font-semibold">العكس</h4>
      <ul>
        {rows.map((row) => (
          <li key={row.movementId}>
            {row.name ?? 'صنف'} — {movementLabel(row.movementType)} —{' '}
            <Num value={row.quantity} /> — {formatEgpText(row.totalCost)}
            {row.reversesMovementId ? (
              <>
                {' '}
                — يعكس <Num value={row.reversesMovementId} />
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdjustmentList({ rows }: { rows: readonly AdjustmentRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h4 className="font-semibold">تعديلات القيمة</h4>
      <ul>
        {rows.map((row) => (
          <li key={row.movementId}>
            {row.name ?? 'صنف'} — <Num value={row.quantity} /> —{' '}
            {formatEgpText(row.totalCost)}
            {row.adjustsMovementId ? (
              <>
                {' '}
                — على <Num value={row.adjustsMovementId} />
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProvenanceList({ provenance }: { provenance: Provenance }) {
  return (
    <dl
      aria-label="مصدر الإعداد"
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"
    >
      <dt>إصدار الخوارزمية</dt>
      <dd>
        <Num value={provenance.algorithmVersion} />
      </dd>
      <dt>نسخ الربط</dt>
      <dd>
        <IdList ids={provenance.mappingVersions} />
      </dd>
      <dt>نسخ الوصفة</dt>
      <dd>
        <IdList ids={provenance.recipeVersions} />
      </dd>
      <dt>نسخ التغليف</dt>
      <dd>
        <IdList ids={provenance.packagingVersions} />
      </dd>
      <dt>نسخ الفاقد</dt>
      <dd>
        {provenance.lossVersions.length === 0 ? (
          '—'
        ) : (
          <ul>
            {provenance.lossVersions.map((row) => (
              <li key={`${row.itemId}/${row.versionId}`}>
                <Num value={row.lossPct} />
              </li>
            ))}
          </ul>
        )}
      </dd>
      <dt>نسخ التحويل</dt>
      <dd>
        {provenance.conversionVersions.length === 0 ? (
          '—'
        ) : (
          <ul>
            {provenance.conversionVersions.map((row) => (
              <li key={`${row.itemId}/${row.unitCode}/${row.versionId}`}>
                {row.unitCode} <Num value={row.factorToBase} />
              </li>
            ))}
          </ul>
        )}
      </dd>
    </dl>
  );
}

function ApplicationBlock({
  application,
  current,
}: {
  application: CostApplication;
  current: boolean;
}) {
  return (
    <article className="flex flex-col gap-2 rounded border border-neutral-300 p-3">
      <h3 className="font-semibold">
        إيصال <Num value={application.id} /> —{' '}
        {dispositionLabels[application.disposition]} —{' '}
        {receiptLabels[application.receiptKind]}
        {current ? ' — الحالي' : ''}
      </h3>
      <p>
        مدخل <Num value={application.inputRevision} /> — نسخة الطلب{' '}
        <Num value={application.snapshotVersion} />
      </p>
      {application.occurredAt ? (
        <p>{formatCairo(application.occurredAt)}</p>
      ) : null}
      <Lines lines={application.lines} />
      <MovementList label="الحركات" rows={application.posted} />
      <ReversalList rows={application.reversals} />
      <AdjustmentList rows={application.adjustments} />
      <ProvenanceList provenance={application.provenance} />
    </article>
  );
}

export function OrderCostDetail({ detail }: { detail: OrderCostDetailData }) {
  if (!detail.found) return <p>الطلب مش موجود</p>;
  const currentId = detail.state?.latestApplicationId ?? null;
  return (
    <div className="flex flex-col gap-3">
      <p>
        {detail.orderNumber !== null ? (
          <>
            طلب رقم <Num value={detail.orderNumber} />
          </>
        ) : (
          <>
            طلب <Num value={detail.orderId} />
          </>
        )}
      </p>
      {detail.state ? (
        <p>
          الحالة الحالية:{' '}
          {detail.state.disposition
            ? dispositionLabels[detail.state.disposition]
            : 'من غير حالة'}
        </p>
      ) : null}
      {detail.state && detail.state.causes.length > 0 ? (
        <ul aria-label="أسباب النقص">
          {detail.state.causes.map((code) => (
            <li key={code}>{causeLabel(code)}</li>
          ))}
        </ul>
      ) : null}
      {detail.input ? (
        <p>
          المدخل المطبق مراجعة <Num value={detail.input.inputRevision} /> — نسخة{' '}
          <Num value={detail.input.snapshotVersion} />
          {detail.input.missingFromPos ? ' — الطلب مختفي من الكاشير' : ''}
        </p>
      ) : null}
      {detail.applications.length === 0 ? (
        <p>لسه مفيش تكلفة محفوظة</p>
      ) : (
        detail.applications.map((application) => (
          <ApplicationBlock
            key={application.id}
            application={application}
            current={application.id === currentId}
          />
        ))
      )}
    </div>
  );
}
