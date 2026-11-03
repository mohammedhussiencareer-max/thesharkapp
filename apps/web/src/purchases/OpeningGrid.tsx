import { useState, type FormEvent } from 'react';
import { formatStoredFactor } from '@/items/format';
import { groupCatalog } from '@/items/group';
import { kindLabels, unitLabels } from '@/items/labels';
import type { CatalogItem } from '@/items/types';
import type { OpeningDraft, StockChoice, UnitOption } from '@/purchases/types';
import { nowCairoDateTimeLocal } from '@/purchases/time';
import { useResolvedUnits } from '@/purchases/units-at';
import {
  choiceLabel,
  unitChoices,
  validateOpening,
  type OpeningFieldErrors,
  type OpeningValues,
} from '@/purchases/validation';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const primaryButton =
  'w-fit rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';

function asCatalog(item: StockChoice): CatalogItem {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    baseUnit: item.baseUnit,
    countFrequency: 'daily',
    lossPct: 0,
    parentItemId: item.parentItemId,
    active: true,
    onHandQty: 0,
    avgCost: 0,
    onHandValue: 0,
  };
}

function OpeningRow({
  item,
  quantity,
  unit,
  unitCost,
  errors,
  disabled,
  onChange,
}: {
  item: StockChoice;
  quantity: string;
  unit: string;
  unitCost: string;
  errors: OpeningFieldErrors[string];
  disabled: boolean;
  onChange: (patch: {
    quantity?: string;
    unit?: string;
    unitCost?: string;
  }) => void;
}) {
  const choices = unitChoices(item);
  const selected = choices.find((choice) => choice.unit === unit) ?? choices[0];
  return (
    <article
      aria-label={item.name}
      className="flex flex-col gap-3 rounded border border-neutral-300 p-3"
    >
      <h3 className="text-base font-semibold">{item.name}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          {`كمية ${item.name}`}
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            disabled={disabled}
            value={quantity}
            onChange={(event) => onChange({ quantity: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          {`وحدة ${item.name}`}
          <select
            className={fieldClass}
            disabled={disabled}
            value={unit}
            onChange={(event) => onChange({ unit: event.target.value })}
          >
            {choices.map((choice) => (
              <option key={choice.unit} value={choice.unit}>
                {choiceLabel(choice, item.baseUnit)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          {`تكلفة ${item.name}`}
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            disabled={disabled}
            value={unitCost}
            onChange={(event) => onChange({ unitCost: event.target.value })}
          />
        </label>
      </div>
      {selected && selected.unit !== item.baseUnit ? (
        <p>
          {`1 ${choiceLabel(selected, item.baseUnit)} = ${formatStoredFactor(selected.factorToBase)} ${unitLabels[item.baseUnit]}`}
        </p>
      ) : null}
      {errors?.quantity ? <p role="alert">{errors.quantity}</p> : null}
      {errors?.unitCost ? <p role="alert">{errors.unitCost}</p> : null}
    </article>
  );
}

export function OpeningGrid({
  items,
  locked,
  submitting,
  serverError,
  onClearServerError,
  onSubmit,
  resolveUnits,
}: {
  items: readonly StockChoice[];
  locked: boolean;
  submitting: boolean;
  serverError: string | null;
  onClearServerError: () => void;
  onSubmit: (draft: OpeningDraft) => void;
  resolveUnits?: (
    itemIds: readonly string[],
    atIso: string,
  ) => Promise<Record<string, UnitOption[]>>;
}) {
  // One id for this draft. A failed save retries it; a new form gets a new one.
  const [requestId] = useState(() => crypto.randomUUID());
  // The current Cairo minute, captured when this form mounts, including after
  // navigation. The unit lookup and the save both parse this same value.
  const [occurredAt, setOccurredAt] = useState(() => nowCairoDateTimeLocal());
  const [values, setValues] = useState<OpeningValues>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [fields, setFields] = useState<OpeningFieldErrors>({});
  const { items: resolvedItems, loading: unitsLoading } = useResolvedUnits(
    items,
    occurredAt,
    resolveUnits,
  );
  const disabled = locked || submitting;
  const blocked = disabled || unitsLoading;
  const byId = new Map(resolvedItems.map((item) => [item.id, item]));
  const groups = groupCatalog(items.map(asCatalog), false);

  function chosenUnit(unit: string, item: StockChoice): string {
    const choices = unitChoices(item);
    if (choices.some((choice) => choice.unit === unit)) return unit;
    return item.baseUnit;
  }

  function rowValue(item: StockChoice) {
    const stored = values[item.id] ?? {
      quantity: '',
      unit: item.baseUnit,
      unitCost: '',
    };
    return { ...stored, unit: chosenUnit(stored.unit, item) };
  }

  function settledValues(): OpeningValues {
    const next: OpeningValues = {};
    for (const item of resolvedItems) {
      const stored = values[item.id];
      if (!stored) continue;
      next[item.id] = { ...stored, unit: chosenUnit(stored.unit, item) };
    }
    return next;
  }

  function change(
    item: StockChoice,
    patch: { quantity?: string; unit?: string; unitCost?: string },
  ) {
    onClearServerError();
    setFormError(null);
    setFields({});
    setValues((current) => ({
      ...current,
      [item.id]: { ...rowValue(item), ...patch },
    }));
  }

  function onSubmitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const result = validateOpening(settledValues(), resolvedItems, occurredAt);
    if (!result.ok) {
      setFormError(result.formError);
      setFields(result.fields);
      return;
    }
    onSubmit({ ...result.draft, requestId });
  }

  function renderItem(catalogItem: CatalogItem) {
    const item = byId.get(catalogItem.id);
    if (!item) return null;
    const row = rowValue(item);
    return (
      <OpeningRow
        key={item.id}
        item={item}
        quantity={row.quantity}
        unit={row.unit}
        unitCost={row.unitCost}
        errors={fields[item.id]}
        disabled={disabled}
        onChange={(patch) => change(item, patch)}
      />
    );
  }

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={onSubmitForm}>
      {serverError ? <p role="alert">{serverError}</p> : null}
      {formError ? <p role="alert">{formError}</p> : null}
      <label className="flex max-w-xs flex-col gap-1">
        وقت الرصيد
        <input
          className={fieldClass}
          type="datetime-local"
          disabled={disabled}
          value={occurredAt}
          onChange={(event) => {
            onClearServerError();
            setFormError(null);
            setOccurredAt(event.target.value);
          }}
        />
      </label>
      {groups.fish.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{kindLabels.fish_mixed}</h2>
          {groups.fish.map((block) => (
            <div key={block.parent.id} className="flex flex-col gap-3">
              {block.showParent ? renderItem(block.parent) : null}
              {block.children.length > 0 ? (
                <div className="flex flex-col gap-3 border-s border-neutral-200 ps-3">
                  <h3 className="text-base font-semibold">
                    {kindLabels.fish_size}
                  </h3>
                  {block.children.map(renderItem)}
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {groups.orphans.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{kindLabels.fish_size}</h2>
          {groups.orphans.map(renderItem)}
        </section>
      ) : null}
      {groups.seafood.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{kindLabels.seafood}</h2>
          {groups.seafood.map(renderItem)}
        </section>
      ) : null}
      {groups.ingredients.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{kindLabels.ingredient}</h2>
          {groups.ingredients.map(renderItem)}
        </section>
      ) : null}
      {groups.packaging.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{kindLabels.packaging}</h2>
          {groups.packaging.map(renderItem)}
        </section>
      ) : null}
      <button className={primaryButton} type="submit" disabled={blocked}>
        حفظ
      </button>
    </form>
  );
}
