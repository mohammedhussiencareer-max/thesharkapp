import { useRef, useState } from 'react';
import { kindLabels as stockKindLabels } from '@/items/labels';
import { stockKinds } from '@/items/types';
import { primaryButton, secondaryButton } from '@/lib/page-style';
import { listUnitsAt } from '@/purchases/api';
import type { StockChoice } from '@/purchases/types';
import { useResolvedUnits } from '@/purchases/units-at';
import { choiceLabel, choicesIncluding } from '@/purchases/validation';
import {
  documentFrom,
  emptyLine,
  explanationLimit,
  maxLines,
  previewBaseQuantity,
  reasonLabels,
  unitCodeLabel,
  validateWaste,
  type FormErrors,
  type FormLine,
  type FormStart,
  type FormValues,
} from '@/waste/format';
import { wasteReasons } from '@/waste/types';
import type { useWasteAction } from '@/waste/useWasteAction';

const field = 'rounded border border-neutral-300 px-3 py-2';

export function WasteForm({
  choices,
  action,
  start,
  predecessorId,
  label,
  submitLabel,
  onCancel,
}: {
  choices: readonly StockChoice[];
  action: ReturnType<typeof useWasteAction>;
  start: FormStart;
  predecessorId: string | null;
  label: string;
  submitLabel: string;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<FormValues>(start.values);
  const [errors, setErrors] = useState<FormErrors | null>(null);
  const counter = useRef(start.values.lines.length);
  const locked = action.saving || action.held !== null;

  const used = new Set(values.lines.map((line) => line.itemId));
  const selected = choices.filter((choice) => used.has(choice.id));
  const resolved = useResolvedUnits(selected, values.at, listUnitsAt);
  const byId = new Map(resolved.items.map((item) => [item.id, item]));
  const itemOf = (id: string) =>
    byId.get(id) ?? choices.find((c) => c.id === id);

  function update(patch: Partial<FormValues>) {
    setValues((current) => ({ ...current, ...patch }));
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setValues((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.key === key ? { ...line, ...patch } : line,
      ),
    }));
  }

  function chooseItem(key: string, itemId: string) {
    const item = choices.find((choice) => choice.id === itemId);
    updateLine(key, { itemId, unit: item?.baseUnit ?? '' });
  }

  function addLine() {
    counter.current += 1;
    setValues((current) => ({
      ...current,
      lines: [...current.lines, emptyLine(`l${counter.current}`)],
    }));
  }

  function removeLine(key: string) {
    setValues((current) => ({
      ...current,
      lines: current.lines.filter((line) => line.key !== key),
    }));
  }

  function submit() {
    if (locked || !resolved.ready) return;
    const validated = validateWaste(values, resolved.items, start.original);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors(null);
    action.clearNotice();
    action.send((requestId) => ({
      requestId,
      document: documentFrom(values, validated, predecessorId),
    }));
  }

  const grouped = stockKinds
    .map((kind) => ({
      kind,
      items: choices.filter((choice) => choice.kind === kind),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <form
      className="flex flex-col gap-3"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="flex flex-col gap-3" disabled={locked}>
        <label className="flex flex-col gap-1">
          وقت الهالك
          <input
            className={field}
            type="datetime-local"
            value={values.at}
            aria-invalid={errors?.at ? true : undefined}
            onChange={(event) => update({ at: event.target.value })}
          />
          {errors?.at ? <span role="alert">{errors.at}</span> : null}
        </label>
        <label className="flex flex-col gap-1">
          السبب
          <select
            className={field}
            value={values.reason}
            aria-invalid={errors?.reason ? true : undefined}
            onChange={(event) => {
              const reason = wasteReasons.find((r) => r === event.target.value);
              update({ reason: reason ?? '' });
            }}
          >
            <option value="">اختار السبب</option>
            {wasteReasons.map((reason) => (
              <option key={reason} value={reason}>
                {reasonLabels[reason]}
              </option>
            ))}
          </select>
          {errors?.reason ? <span role="alert">{errors.reason}</span> : null}
        </label>
        <label className="flex flex-col gap-1">
          الشرح{values.reason === 'other' ? ' (مطلوب)' : ' (اختياري)'}
          <textarea
            className={field}
            rows={2}
            maxLength={explanationLimit}
            value={values.explanation}
            aria-invalid={errors?.explanation ? true : undefined}
            onChange={(event) => update({ explanation: event.target.value })}
          />
          {errors?.explanation ? (
            <span role="alert">{errors.explanation}</span>
          ) : null}
        </label>
        <div className="flex flex-col gap-2">
          {values.lines.map((line, index) => {
            const item = itemOf(line.itemId);
            const problems = errors?.line[line.key];
            const base = previewBaseQuantity(line, item);
            return (
              <div
                key={line.key}
                className="flex flex-col gap-2 rounded border border-neutral-200 p-2"
                role="group"
                aria-label={`سطر ${index + 1}`}
              >
                <label className="flex flex-col gap-1">
                  الصنف
                  <select
                    className={field}
                    value={line.itemId}
                    aria-invalid={problems?.itemId ? true : undefined}
                    onChange={(event) =>
                      chooseItem(line.key, event.target.value)
                    }
                  >
                    <option value="">اختار الصنف</option>
                    {grouped.map((group) => (
                      <optgroup
                        key={group.kind}
                        label={stockKindLabels[group.kind]}
                      >
                        {group.items.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.name}
                            {choice.active ? '' : ' (غير نشط)'}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {problems?.itemId ? (
                    <span role="alert">{problems.itemId}</span>
                  ) : null}
                </label>
                <label className="flex flex-col gap-1">
                  الكمية
                  <input
                    className={field}
                    inputMode="decimal"
                    dir="ltr"
                    value={line.quantity}
                    aria-invalid={problems?.quantity ? true : undefined}
                    onChange={(event) =>
                      updateLine(line.key, { quantity: event.target.value })
                    }
                  />
                  {problems?.quantity ? (
                    <span role="alert">{problems.quantity}</span>
                  ) : null}
                </label>
                <label className="flex flex-col gap-1">
                  الوحدة
                  <select
                    className={field}
                    value={line.unit}
                    disabled={!item}
                    aria-invalid={problems?.unit ? true : undefined}
                    onChange={(event) =>
                      updateLine(line.key, { unit: event.target.value })
                    }
                  >
                    {item ? (
                      choicesIncluding(item, line.unit).map((option) => (
                        <option key={option.unit} value={option.unit}>
                          {choiceLabel(option, item.baseUnit)}
                        </option>
                      ))
                    ) : (
                      <option value="">اختار الصنف الأول</option>
                    )}
                  </select>
                  {problems?.unit ? (
                    <span role="alert">{problems.unit}</span>
                  ) : null}
                </label>
                {item && base !== null && line.unit !== item.baseUnit ? (
                  <span>
                    بالوحدة الأساسية: <span dir="ltr">{base}</span>{' '}
                    {unitCodeLabel(item.baseUnit)}
                  </span>
                ) : null}
                {values.lines.length > 1 ? (
                  <button
                    className={secondaryButton}
                    type="button"
                    onClick={() => removeLine(line.key)}
                  >
                    حذف السطر
                  </button>
                ) : null}
              </div>
            );
          })}
          {errors?.lines ? <p role="alert">{errors.lines}</p> : null}
          <button
            className={secondaryButton}
            type="button"
            disabled={values.lines.length >= maxLines}
            onClick={addLine}
          >
            إضافة صنف
          </button>
        </div>
      </fieldset>
      {resolved.loading ? <p>جاري تحميل وحدات الوقت ده…</p> : null}
      {resolved.error ? (
        <div className="flex flex-col gap-2">
          <p role="alert">{resolved.error}</p>
          <button
            className={secondaryButton}
            type="button"
            onClick={resolved.retry}
          >
            إعادة تحميل الوحدات
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          className={primaryButton}
          type="submit"
          disabled={locked || !resolved.ready}
        >
          {submitLabel}
        </button>
        {onCancel ? (
          <button
            className={secondaryButton}
            type="button"
            disabled={locked}
            onClick={onCancel}
          >
            إلغاء
          </button>
        ) : null}
      </div>
    </form>
  );
}
