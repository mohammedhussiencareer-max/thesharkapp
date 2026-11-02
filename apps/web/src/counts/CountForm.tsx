import { useState, type FormEvent } from 'react';
import {
  countUnitReentryMessage,
  pendingResendMessage,
  surplusWarning,
} from '@/counts/errors';
import { formatQty, formatSignedMoney } from '@/counts/format';
import { assessCount } from '@/counts/validation';
import type { CountDraft, CountItem, CountValues } from '@/counts/types';
import { unitLabels } from '@/items/labels';
import type { BaseUnit } from '@/items/types';
import { primaryButton } from '@/lib/page-style';
import { formatMoneyText } from '@/purchases/decimal';
import { formatCairoDateTime, nowCairoDateTimeLocal } from '@/purchases/time';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

function emptyValues(): CountValues {
  return {
    countedAt: nowCairoDateTimeLocal(),
    note: '',
    quantities: {},
  };
}

function QuantityControl({
  name,
  fieldId,
  value,
  unit,
  disabled,
  readOnly,
  invalid,
  onValue,
}: {
  name: string;
  fieldId: string;
  value: string;
  unit: BaseUnit;
  disabled: boolean;
  readOnly: boolean;
  invalid: boolean;
  onValue?: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId}>{`الكمية المعدودة ${name}`}</label>
      <div className="flex items-center gap-2">
        <input
          id={fieldId}
          className={`${fieldClass} min-w-0 flex-1`}
          inputMode="decimal"
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={`${fieldId}-unit`}
          value={value}
          onChange={
            onValue ? (event) => onValue(event.target.value) : undefined
          }
        />
        <span id={`${fieldId}-unit`} className="shrink-0">
          {unitLabels[unit]}
        </span>
      </div>
    </div>
  );
}

/** datetime-local value for a pinned ISO count time, in the Cairo wall clock. */
function pinnedCountTime(iso: string): string {
  const formatted = formatCairoDateTime(iso);
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(formatted);
  return match ? `${match[1]}T${match[2]}` : iso;
}

export function CountForm({
  items,
  locked,
  submitting,
  serverError,
  pending,
  waiting,
  requestKey,
  onClearServerError,
  onSubmit,
}: {
  items: readonly CountItem[];
  locked: boolean;
  submitting: boolean;
  serverError: string | null;
  /** Set only after an unknown outcome. Null when the save was not sent or was refused. */
  pending: CountDraft | null;
  /** The server stored this payload and is waiting for a later sync. */
  waiting: CountDraft | null;
  /**
   * Bumped when a pinned or stored request is refused. The field values
   * stay; the next save uses a new request id. The old row remains in the
   * pending list, so an edited count must not reuse that id.
   */
  requestKey: number;
  onClearServerError: () => void;
  onSubmit: (draft: CountDraft) => void;
}) {
  // Reused after a first-submit refusal, which stored nothing. An unknown
  // outcome resends `pending` with this same id. A payload refusal of that
  // pinned resend, or of a stored request, bumps `requestKey`. A confirmed
  // save remounts the form.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [appliedKey, setAppliedKey] = useState(requestKey);
  if (appliedKey !== requestKey) {
    setAppliedKey(requestKey);
    setRequestId(crypto.randomUUID());
  }
  const [values, setValues] = useState<CountValues>(emptyValues);
  const [showErrors, setShowErrors] = useState(false);
  const disabled = locked || submitting;
  const pinned = pending ?? waiting;
  const assessment = pinned ? null : assessCount(values, items);
  const preview = assessment?.preview ?? null;
  const submitted = showErrors && assessment ? assessment.errors : null;
  const quantityError = submitted
    ? Object.values(submitted.quantities).find(
        (message) => message.length > 0 && message !== countUnitReentryMessage,
      )
    : undefined;
  const alertMessage =
    serverError ??
    submitted?.form ??
    submitted?.countedAt ??
    submitted?.note ??
    quantityError ??
    null;
  const previewByItem = new Map(
    preview?.lines.map((line) => [line.itemId, line]) ?? [],
  );

  function edit(patch: Partial<CountValues>) {
    if (pinned) return;
    onClearServerError();
    setShowErrors(false);
    setValues((current) => ({ ...current, ...patch }));
  }

  function editQuantity(itemId: string, quantity: string) {
    if (pinned) return;
    const item = items.find((row) => row.id === itemId);
    onClearServerError();
    setShowErrors(false);
    setValues((current) => ({
      ...current,
      quantities: {
        ...current.quantities,
        [itemId]: {
          countedQty: quantity,
          expectedBaseUnit:
            quantity.trim() === '' || !item ? null : item.baseUnit,
        },
      },
    }));
  }

  function unitOnScreen(item: CountItem): BaseUnit {
    const entry = values.quantities[item.id];
    if (entry && entry.countedQty.trim() !== '' && entry.expectedBaseUnit) {
      return entry.expectedBaseUnit;
    }
    return item.baseUnit;
  }

  function quantityErrorFor(itemId: string): string | undefined {
    const live = assessment?.errors.quantities[itemId];
    if (live === countUnitReentryMessage) return live;
    return submitted?.quantities[itemId];
  }

  function onSubmitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    if (pending) {
      onSubmit(pending);
      return;
    }
    if (waiting) {
      onSubmit(waiting);
      return;
    }
    const result = assessCount(values, items);
    if (!result.draft) {
      setShowErrors(true);
      return;
    }
    onSubmit({ ...result.draft, requestId });
  }

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={onSubmitForm}>
      {alertMessage ? <p role="alert">{alertMessage}</p> : null}
      {pending ? <p>{pendingResendMessage}</p> : null}
      <p>السطر الفاضي مش داخل في الجرد ده</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          وقت الجرد
          <input
            className={fieldClass}
            type="datetime-local"
            disabled={disabled}
            readOnly={pinned !== null}
            value={
              pinned ? pinnedCountTime(pinned.countedAt) : values.countedAt
            }
            onChange={(event) => edit({ countedAt: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          ملاحظة
          <input
            className={fieldClass}
            disabled={disabled}
            readOnly={pinned !== null}
            value={pinned ? (pinned.note ?? '') : values.note}
            onChange={(event) => edit({ note: event.target.value })}
          />
        </label>
      </div>
      <div className="flex flex-col gap-3">
        {pinned
          ? pinned.lines.map((line) => {
              const name = line.itemName ?? line.itemId;
              return (
                <div
                  key={line.itemId}
                  className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
                >
                  <p className="font-medium">{name}</p>
                  <QuantityControl
                    name={name}
                    fieldId={`count-qty-${line.itemId}`}
                    value={line.countedQty}
                    unit={line.expectedBaseUnit}
                    disabled={disabled}
                    readOnly
                    invalid={false}
                  />
                </div>
              );
            })
          : items.map((item) => {
              const line = previewByItem.get(item.id);
              const fieldError = quantityErrorFor(item.id);
              return (
                <div
                  key={item.id}
                  className={`flex flex-col gap-2 rounded border border-neutral-300 p-3${line?.surplus ? ' bg-amber-50' : ''}`}
                >
                  <p className="font-medium">{item.name}</p>
                  <p>{`الرصيد ${formatQty(item.onHandQty)} — متوسط التكلفة ${formatQty(item.avgCost)} ج.م`}</p>
                  <QuantityControl
                    name={item.name}
                    fieldId={`count-qty-${item.id}`}
                    value={values.quantities[item.id]?.countedQty ?? ''}
                    unit={unitOnScreen(item)}
                    disabled={disabled}
                    readOnly={false}
                    invalid={fieldError !== undefined}
                    onValue={(quantity) => editQuantity(item.id, quantity)}
                  />
                  {fieldError ? <p role="alert">{fieldError}</p> : null}
                  {line ? (
                    <p>{`الفرق ${formatQty(line.deltaQty)} — القيمة ${formatSignedMoney(line.deltaValue)}`}</p>
                  ) : null}
                  {line?.surplus ? <p>{surplusWarning}</p> : null}
                </div>
              );
            })}
      </div>
      {preview ? (
        <section
          aria-label="معاينة الجرد"
          className="flex flex-col gap-1 rounded border border-neutral-300 p-3"
        >
          <h2 className="text-base font-semibold">معاينة الجرد</h2>
          <p>{`عجز ${formatMoneyText(preview.shortageValue)}`}</p>
          <p>{`زيادة ${formatMoneyText(preview.surplusValue)}`}</p>
        </section>
      ) : null}
      <button className={primaryButton} type="submit" disabled={disabled}>
        {waiting && !pending ? 'سجّل الجرد' : 'حفظ'}
      </button>
    </form>
  );
}
