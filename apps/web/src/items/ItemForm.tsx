import { useId, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  frequencyOptions,
  kindOptions,
  unitOptions,
  defaultsForKind,
} from '@/items/labels';
import {
  isBaseUnit,
  isCountFrequency,
  isStockKind,
  type CatalogItem,
  type ItemDraft,
} from '@/items/types';
import {
  emptyItemForm,
  validateItemForm,
  type ItemFormErrors,
  type ItemFormValues,
} from '@/items/validation';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';
const secondaryButton =
  'rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

export function ItemForm({
  items,
  editingId,
  initial,
  submitting,
  serverError,
  onClearServerError,
  onSubmit,
  onCancel,
}: {
  items: readonly CatalogItem[];
  editingId?: string;
  initial?: ItemFormValues;
  submitting: boolean;
  serverError: string | null;
  onClearServerError: () => void;
  onSubmit: (draft: ItemDraft) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [values, setValues] = useState(initial ?? emptyItemForm);
  const [errors, setErrors] = useState<ItemFormErrors>({});
  const title = editingId ? 'تعديل الصنف' : 'صنف جديد';
  const parents = items
    .filter((item) => item.kind === 'fish_mixed')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  function change(patch: Partial<ItemFormValues>) {
    onClearServerError();
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function onKind(event: ChangeEvent<HTMLSelectElement>) {
    const kind = event.target.value;
    if (!isStockKind(kind)) return;
    const defaults = defaultsForKind(kind);
    change({
      kind,
      baseUnit: defaults.baseUnit,
      countFrequency: defaults.countFrequency,
      parentItemId: kind === 'fish_size' ? values.parentItemId : '',
    });
  }

  function onSubmitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateItemForm(values, { items, editingId });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onSubmit(result.draft);
  }

  return (
    <form
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
      noValidate
      onSubmit={onSubmitForm}
    >
      <h2 id={titleId} className="text-lg font-semibold">
        {title}
      </h2>
      {serverError ? <p role="alert">{serverError}</p> : null}
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          الاسم
          <input
            className={fieldClass}
            name="item-name"
            autoComplete="off"
            disabled={submitting}
            value={values.name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        {errors.name ? <p role="alert">{errors.name}</p> : null}
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          النوع
          <select
            className={fieldClass}
            disabled={submitting}
            value={values.kind}
            onChange={onKind}
          >
            {kindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {errors.kind ? <p role="alert">{errors.kind}</p> : null}
      </div>
      {values.kind === 'fish_size' ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            السمك المخلوط
            <select
              className={fieldClass}
              disabled={submitting}
              value={values.parentItemId}
              onChange={(event) => change({ parentItemId: event.target.value })}
            >
              <option value="">اختار</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.name}
                  {parent.active ? '' : ' (موقوف)'}
                </option>
              ))}
            </select>
          </label>
          {errors.parentItemId ? (
            <p role="alert">{errors.parentItemId}</p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          الوحدة الأساسية
          <select
            className={fieldClass}
            disabled={submitting}
            value={values.baseUnit}
            onChange={(event) => {
              const baseUnit = event.target.value;
              if (!isBaseUnit(baseUnit)) return;
              change({ baseUnit });
            }}
          >
            {unitOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {errors.baseUnit ? <p role="alert">{errors.baseUnit}</p> : null}
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          الجرد
          <select
            className={fieldClass}
            disabled={submitting}
            value={values.countFrequency}
            onChange={(event) => {
              const countFrequency = event.target.value;
              if (!isCountFrequency(countFrequency)) return;
              change({ countFrequency });
            }}
          >
            {frequencyOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {errors.countFrequency ? (
          <p role="alert">{errors.countFrequency}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          نسبة الفاقد
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="decimal"
            disabled={submitting}
            value={values.lossPercent}
            onChange={(event) => change({ lossPercent: event.target.value })}
          />
        </label>
        <p className="text-sm text-neutral-600">
          اكتبها نسبة مئوية من 0 لحد 99.999
        </p>
        {errors.lossPercent ? <p role="alert">{errors.lossPercent}</p> : null}
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          disabled={submitting}
          checked={values.active}
          onChange={(event) => change({ active: event.target.checked })}
        />
        شغال
      </label>
      <div className="flex flex-wrap gap-2">
        <button className={primaryButton} type="submit" disabled={submitting}>
          {submitting ? 'جاري الحفظ…' : 'حفظ'}
        </button>
        <button
          className={secondaryButton}
          type="button"
          disabled={submitting}
          onClick={onCancel}
        >
          إلغاء
        </button>
      </div>
    </form>
  );
}
