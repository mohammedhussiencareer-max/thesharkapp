import { useRef, useState, type FormEvent } from 'react';
import { formatStoredFactor } from '@/items/format';
import { kindLabels, unitLabels } from '@/items/labels';
import type { StockKind } from '@/items/types';
import { formatMoneyText } from '@/purchases/decimal';
import type { PurchaseDraft, StockChoice } from '@/purchases/types';

type ReviewedPurchase = Omit<PurchaseDraft, 'requestId'>;
import { nowCairoDateTimeLocal } from '@/purchases/time';
import {
  previewPurchaseLine,
  unitChoices,
  unitLabel,
  validatePurchase,
  type PurchaseErrors,
  type PurchaseLineValues,
  type PurchaseValues,
} from '@/purchases/validation';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';
const secondaryButton =
  'rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

const kindOrder: readonly StockKind[] = [
  'fish_mixed',
  'fish_size',
  'seafood',
  'ingredient',
  'packaging',
];

function emptyLine(key: string): PurchaseLineValues {
  return { key, itemId: '', quantity: '', unit: '', amount: '' };
}

export function PurchaseForm({
  items,
  locked,
  submitting,
  serverError,
  onClearServerError,
  onSubmit,
}: {
  items: readonly StockChoice[];
  locked: boolean;
  submitting: boolean;
  serverError: string | null;
  onClearServerError: () => void;
  onSubmit: (draft: PurchaseDraft) => void;
}) {
  const keyRef = useRef(1);
  // One id for this draft. A failed save retries it; a new form gets a new one.
  const [requestId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<PurchaseValues>(() => ({
    purchasedAt: nowCairoDateTimeLocal(),
    supplier: '',
    invoiceNo: '',
    note: '',
    lines: [emptyLine('1')],
  }));
  const [errors, setErrors] = useState<PurchaseErrors>({ lines: {} });
  const [draft, setDraft] = useState<ReviewedPurchase | null>(null);
  const disabled = locked || submitting;

  function edit(patch: Partial<PurchaseValues>) {
    onClearServerError();
    setErrors({ lines: {} });
    setValues((current) => ({ ...current, ...patch }));
  }

  function updateLine(key: string, patch: Partial<PurchaseLineValues>) {
    onClearServerError();
    setErrors({ lines: {} });
    setValues((current) => ({
      ...current,
      lines: current.lines.map((line) => {
        if (line.key !== key) return line;
        const next = { ...line, ...patch };
        if (patch.itemId !== undefined) {
          const item = items.find((candidate) => candidate.id === patch.itemId);
          const choices = item ? unitChoices(item) : [];
          if (!choices.some((choice) => choice.unit === next.unit)) {
            next.unit = item?.baseUnit ?? '';
          }
        }
        return next;
      }),
    }));
  }

  function addLine() {
    if (disabled || values.lines.length >= 100) return;
    keyRef.current += 1;
    edit({ lines: [...values.lines, emptyLine(String(keyRef.current))] });
  }

  function removeLine(key: string) {
    if (disabled || values.lines.length <= 1) return;
    edit({ lines: values.lines.filter((line) => line.key !== key) });
  }

  function onSubmitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    if (!draft) {
      const result = validatePurchase(values, items);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setDraft(result.draft);
      return;
    }
    onSubmit({ ...draft, requestId });
  }

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={onSubmitForm}>
      {serverError ? <p role="alert">{serverError}</p> : null}
      {errors.form ? <p role="alert">{errors.form}</p> : null}
      {draft ? (
        <section aria-label="مراجعة المشتريات" className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">مراجعة المشتريات</h2>
          <p>المشتريات نهائية لحد ما نضيف التعديل</p>
          <dl className="flex flex-col gap-1">
            <div>
              <dt className="text-neutral-600">المورد</dt>
              <dd>{draft.supplier ?? 'من غير مورد'}</dd>
            </div>
            {draft.invoiceNo ? (
              <div>
                <dt className="text-neutral-600">رقم الفاتورة</dt>
                <dd>{draft.invoiceNo}</dd>
              </div>
            ) : null}
            {draft.note ? (
              <div>
                <dt className="text-neutral-600">ملاحظة</dt>
                <dd>{draft.note}</dd>
              </div>
            ) : null}
          </dl>
          <ul className="flex flex-col gap-2">
            {draft.lines.map((line, index) => (
              <li key={`${index}:${line.itemId}`}>
                {`${line.itemName}: ${formatStoredFactor(line.quantity)} ${unitLabel(line.unit, line.baseUnit)} = ${formatStoredFactor(line.baseQuantity)} ${unitLabels[line.baseUnit]} — ${formatMoneyText(line.amountPaid)} — تكلفة ${unitLabels[line.baseUnit]} ${formatStoredFactor(line.unitCost)} ج.م`}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              className={secondaryButton}
              type="button"
              disabled={disabled}
              onClick={() => setDraft(null)}
            >
              رجوع
            </button>
            <button className={primaryButton} type="submit" disabled={disabled}>
              حفظ
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              وقت الشراء
              <input
                className={fieldClass}
                type="datetime-local"
                disabled={disabled}
                value={values.purchasedAt}
                onChange={(event) => edit({ purchasedAt: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              المورد
              <input
                className={fieldClass}
                autoComplete="off"
                disabled={disabled}
                value={values.supplier}
                onChange={(event) => edit({ supplier: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              رقم الفاتورة
              <input
                className={fieldClass}
                autoComplete="off"
                disabled={disabled}
                value={values.invoiceNo}
                onChange={(event) => edit({ invoiceNo: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              ملاحظة
              <textarea
                className={fieldClass}
                disabled={disabled}
                value={values.note}
                onChange={(event) => edit({ note: event.target.value })}
              />
            </label>
          </div>
          {errors.purchasedAt ? <p role="alert">{errors.purchasedAt}</p> : null}
          {errors.supplier ? <p role="alert">{errors.supplier}</p> : null}
          {errors.invoiceNo ? <p role="alert">{errors.invoiceNo}</p> : null}
          {errors.note ? <p role="alert">{errors.note}</p> : null}
          {values.lines.map((line, index) => {
            const item = items.find(
              (candidate) => candidate.id === line.itemId,
            );
            const choices = item ? unitChoices(item) : [];
            const preview = previewPurchaseLine(line, items);
            const lineErrors = errors.lines[line.key] ?? {};
            return (
              <fieldset
                key={line.key}
                className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
              >
                <legend className="px-1">{`سطر ${index + 1}`}</legend>
                <label className="flex flex-col gap-1">
                  الصنف
                  <select
                    className={fieldClass}
                    disabled={disabled}
                    value={line.itemId}
                    onChange={(event) =>
                      updateLine(line.key, { itemId: event.target.value })
                    }
                  >
                    <option value="">اختار</option>
                    {kindOrder.map((kind) => {
                      const group = items
                        .filter((candidate) => candidate.kind === kind)
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
                      if (group.length === 0) return null;
                      return (
                        <optgroup key={kind} label={kindLabels[kind]}>
                          {group.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.name}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="flex flex-col gap-1">
                    الكمية
                    <input
                      className={fieldClass}
                      dir="ltr"
                      inputMode="decimal"
                      autoComplete="off"
                      disabled={disabled}
                      value={line.quantity}
                      onChange={(event) =>
                        updateLine(line.key, { quantity: event.target.value })
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    الوحدة
                    <select
                      className={fieldClass}
                      disabled={disabled || !item}
                      value={line.unit}
                      onChange={(event) =>
                        updateLine(line.key, { unit: event.target.value })
                      }
                    >
                      {choices.map((choice) => (
                        <option key={choice.unit} value={choice.unit}>
                          {choice.unit === item?.baseUnit
                            ? unitLabels[item.baseUnit]
                            : choice.unit}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    المبلغ
                    <input
                      className={fieldClass}
                      dir="ltr"
                      inputMode="decimal"
                      autoComplete="off"
                      disabled={disabled}
                      value={line.amount}
                      onChange={(event) =>
                        updateLine(line.key, { amount: event.target.value })
                      }
                    />
                  </label>
                </div>
                {item && line.unit && line.unit !== item.baseUnit ? (
                  <p>
                    {`1 ${line.unit} = ${formatStoredFactor(
                      choices.find((choice) => choice.unit === line.unit)
                        ?.factorToBase ?? '',
                    )} ${unitLabels[item.baseUnit]}`}
                  </p>
                ) : null}
                {preview ? (
                  <p>
                    {`تكلفة ${unitLabels[preview.baseUnit]}: ${formatStoredFactor(preview.unitCost)} ج.م`}
                  </p>
                ) : null}
                {lineErrors.itemId ? (
                  <p role="alert">{lineErrors.itemId}</p>
                ) : null}
                {lineErrors.quantity ? (
                  <p role="alert">{lineErrors.quantity}</p>
                ) : null}
                {lineErrors.unit ? <p role="alert">{lineErrors.unit}</p> : null}
                {lineErrors.amount ? (
                  <p role="alert">{lineErrors.amount}</p>
                ) : null}
                {values.lines.length > 1 ? (
                  <button
                    className={secondaryButton}
                    type="button"
                    disabled={disabled}
                    onClick={() => removeLine(line.key)}
                  >
                    احذف السطر
                  </button>
                ) : null}
              </fieldset>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <button
              className={secondaryButton}
              type="button"
              disabled={disabled || values.lines.length >= 100}
              onClick={addLine}
            >
              ضيف سطر
            </button>
            <button className={primaryButton} type="submit" disabled={disabled}>
              مراجعة
            </button>
          </div>
        </>
      )}
    </form>
  );
}
