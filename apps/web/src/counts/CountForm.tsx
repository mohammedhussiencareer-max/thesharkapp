import { useState, type FormEvent } from 'react';
import { formatCairoDateTime, nowCairoDateTimeLocal } from '@/purchases/time';
import { pendingResendMessage, surplusWarning } from '@/counts/errors';
import { formatQty, formatSignedMoney } from '@/counts/format';
import { formatMoneyText } from '@/purchases/decimal';
import { assessCount } from '@/counts/validation';
import type { CountDraft, CountItem, CountValues } from '@/counts/types';
import { primaryButton } from '@/lib/page-style';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

function emptyValues(): CountValues {
  return {
    countedAt: nowCairoDateTimeLocal(),
    note: '',
    quantities: {},
  };
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
   * Bumped when a stored request is refused. The field values stay; the next
   * save uses a new request id. The stored row remains in the pending list.
   */
  requestKey: number;
  onClearServerError: () => void;
  onSubmit: (draft: CountDraft) => void;
}) {
  // Reused after a refusal that stored nothing. An unknown outcome resends
  // `pending` with this same id. A stored request that is later refused
  // bumps `requestKey` and mints a new id. A confirmed save remounts the form.
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
    ? Object.values(submitted.quantities).find((message) => message.length > 0)
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
    onClearServerError();
    setShowErrors(false);
    setValues((current) => ({
      ...current,
      quantities: { ...current.quantities, [itemId]: quantity },
    }));
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
                  <label className="flex flex-col gap-1">
                    {`الكمية المعدودة ${name}`}
                    <input
                      className={fieldClass}
                      inputMode="decimal"
                      disabled={disabled}
                      readOnly
                      value={line.countedQty}
                    />
                  </label>
                </div>
              );
            })
          : items.map((item) => {
              const line = previewByItem.get(item.id);
              const fieldError = submitted?.quantities[item.id];
              return (
                <div
                  key={item.id}
                  className={`flex flex-col gap-2 rounded border border-neutral-300 p-3${line?.surplus ? ' bg-amber-50' : ''}`}
                >
                  <p className="font-medium">{item.name}</p>
                  <p>{`الرصيد ${formatQty(item.onHandQty)} — متوسط التكلفة ${formatQty(item.avgCost)} ج.م`}</p>
                  <label className="flex flex-col gap-1">
                    {`الكمية المعدودة ${item.name}`}
                    <input
                      className={fieldClass}
                      inputMode="decimal"
                      disabled={disabled}
                      readOnly={pinned !== null}
                      aria-invalid={fieldError ? true : undefined}
                      value={values.quantities[item.id] ?? ''}
                      onChange={(event) =>
                        editQuantity(item.id, event.target.value)
                      }
                    />
                  </label>
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
