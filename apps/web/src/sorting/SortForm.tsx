import { useState, type FormEvent } from 'react';
import { nowCairoDateTimeLocal } from '@/purchases/time';
import { pendingResendMessage } from '@/sorting/errors';
import { formatCostPerKg, formatKg, formatLossMoney } from '@/sorting/format';
import { assessSort } from '@/sorting/validation';
import type { MixedFish, SortDraft, SortValues } from '@/sorting/types';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';

function emptyValues(): SortValues {
  return {
    occurredAt: nowCairoDateTimeLocal(),
    mixedItemId: '',
    qtyTaken: '',
    note: '',
    quantities: {},
  };
}

export function SortForm({
  items,
  locked,
  submitting,
  serverError,
  pending,
  onClearServerError,
  onSubmit,
}: {
  items: readonly MixedFish[];
  locked: boolean;
  submitting: boolean;
  serverError: string | null;
  /** Set only after an unknown outcome. Null when the save was not sent or was refused. */
  pending: SortDraft | null;
  onClearServerError: () => void;
  onSubmit: (draft: SortDraft) => void;
}) {
  // Reused after a coded refusal, because that attempt was not stored.
  // An unknown outcome resends `pending` with this same id. A confirmed
  // save remounts the form and mints a new id.
  const [requestId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<SortValues>(emptyValues);
  const [showErrors, setShowErrors] = useState(false);
  const disabled = locked || submitting;
  const selected = items.find((item) => item.id === values.mixedItemId) ?? null;
  const assessment = pending ? null : assessSort(values, items);
  const preview = assessment?.preview ?? null;
  const submitted = showErrors && assessment ? assessment.errors : null;
  const quantityError = submitted
    ? Object.values(submitted.quantities).find((message) => message.length > 0)
    : undefined;
  const alertMessage =
    serverError ??
    submitted?.qtyTaken ??
    submitted?.form ??
    submitted?.occurredAt ??
    submitted?.mixedItemId ??
    submitted?.note ??
    quantityError ??
    assessment?.blockers.qtyTaken ??
    assessment?.blockers.form ??
    null;

  function edit(patch: Partial<SortValues>) {
    if (pending) return;
    onClearServerError();
    setShowErrors(false);
    setValues((current) => ({ ...current, ...patch }));
  }

  function editQuantity(sizeId: string, quantity: string) {
    if (pending) return;
    onClearServerError();
    setShowErrors(false);
    setValues((current) => ({
      ...current,
      quantities: { ...current.quantities, [sizeId]: quantity },
    }));
  }

  function onSubmitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    if (pending) {
      onSubmit(pending);
      return;
    }
    const result = assessSort(values, items);
    if (!result.draft) {
      setShowErrors(true);
      return;
    }
    onSubmit({ ...result.draft, requestId });
  }

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={onSubmitForm}>
      {alertMessage ? <p role="alert">{alertMessage}</p> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          وقت الفرز
          <input
            className={fieldClass}
            type="datetime-local"
            disabled={disabled}
            readOnly={pending !== null}
            value={values.occurredAt}
            onChange={(event) => edit({ occurredAt: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          السمك المخلوط
          <select
            className={fieldClass}
            disabled={disabled || pending !== null}
            value={values.mixedItemId}
            onChange={(event) => edit({ mixedItemId: event.target.value })}
          >
            <option value="">اختار</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selected ? (
        <p>
          {`الرصيد ${formatKg(selected.onHandQty)} — متوسط التكلفة ${formatCostPerKg(selected.avgCost)}`}
        </p>
      ) : null}
      <label className="flex flex-col gap-1">
        كمية المخلوط
        <input
          className={fieldClass}
          inputMode="decimal"
          disabled={disabled}
          readOnly={pending !== null}
          value={values.qtyTaken}
          onChange={(event) => edit({ qtyTaken: event.target.value })}
        />
      </label>
      {selected && selected.sizes.length === 0 ? (
        <p>الصنف ده ملوش أحجام</p>
      ) : null}
      {selected && selected.sizes.length > 0 ? (
        <fieldset className="flex flex-col gap-3" disabled={disabled}>
          <legend className="font-semibold">أحجام السمك</legend>
          <p>سيب الحجم فاضي لو مش هتفرزه</p>
          {selected.sizes.map((size) => (
            <label key={size.id} className="flex flex-col gap-1">
              {`كمية ${size.name}`}
              <input
                className={fieldClass}
                inputMode="decimal"
                readOnly={pending !== null}
                value={values.quantities[size.id] ?? ''}
                onChange={(event) => editQuantity(size.id, event.target.value)}
              />
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="flex flex-col gap-1">
        ملاحظة
        <input
          className={fieldClass}
          disabled={disabled}
          readOnly={pending !== null}
          value={values.note}
          onChange={(event) => edit({ note: event.target.value })}
        />
      </label>
      {preview ? (
        <section aria-label="معاينة الفرز" className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">معاينة الفرز</h2>
          <p>{`مجموع الأحجام ${formatKg(preview.sizesQty)}`}</p>
          <p>{`تكلفة الكيلو ${formatCostPerKg(preview.costPerKg)}`}</p>
          {preview.lossQty !== null && preview.lossValue !== null ? (
            <>
              <p>{`الفاقد ${formatKg(preview.lossQty)}`}</p>
              <p>{`قيمة الفاقد ${formatLossMoney(preview.lossValue)}`}</p>
            </>
          ) : null}
          <ul className="flex flex-col gap-1">
            {preview.lines.map((line) => {
              const size = selected?.sizes.find(
                (candidate) => candidate.id === line.itemId,
              );
              return (
                <li key={line.itemId}>
                  {`${size?.name ?? line.itemId}: ${formatKg(line.quantity)} — ${formatLossMoney(line.value)}`}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {pending ? <p>{pendingResendMessage}</p> : null}
      <button className={primaryButton} type="submit" disabled={disabled}>
        حفظ
      </button>
    </form>
  );
}
