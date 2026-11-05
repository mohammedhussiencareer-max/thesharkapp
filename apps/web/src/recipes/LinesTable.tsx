import {
  childUnitChoices,
  itemAllowed,
  itemTarget,
  itemUnitChoices,
  newLine,
  parseTarget,
  recipeTarget,
  type LineDraft,
  type UnitChoice,
} from '@/recipes/lines';
import { netQuantityHint } from '@/recipes/labels';
import type { RecipeCatalog, RecipeRecord } from '@/recipes/types';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const secondaryButton =
  'w-fit rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

export function LinesTable({
  drafts,
  recipe,
  catalog,
  atMs,
  disabled,
  onChange,
}: {
  drafts: readonly LineDraft[];
  recipe: RecipeRecord;
  catalog: RecipeCatalog;
  /** The chosen effective instant, for the batch unit in force then. */
  atMs: number;
  disabled: boolean;
  onChange: (next: LineDraft[]) => void;
}) {
  function unitLabel(code: string): string {
    return catalog.units.find((unit) => unit.code === code)?.labelAr ?? code;
  }

  function choicesFor(draft: LineDraft): UnitChoice[] {
    const target = parseTarget(draft.target);
    let choices: UnitChoice[] = [];
    if (target?.kind === 'item') {
      choices = itemUnitChoices(target.id, catalog.itemUnits);
    } else if (target?.kind === 'recipe') {
      choices = childUnitChoices(
        catalog.batches.find((batch) => batch.id === target.id),
        atMs,
        catalog.units,
      );
    }
    if (draft.unit && !choices.some((choice) => choice.code === draft.unit)) {
      choices = [
        { code: draft.unit, label: unitLabel(draft.unit) },
        ...choices,
      ];
    }
    return choices;
  }

  function update(key: string, patch: Partial<LineDraft>) {
    if (disabled) return;
    onChange(
      drafts.map((draft) =>
        draft.key === key ? { ...draft, ...patch } : draft,
      ),
    );
  }

  function pick(draft: LineDraft, target: string) {
    const parsed = parseTarget(target);
    let choices: UnitChoice[] = [];
    let preferred = '';
    if (parsed?.kind === 'item') {
      choices = itemUnitChoices(parsed.id, catalog.itemUnits);
      preferred =
        catalog.stock.find((item) => item.id === parsed.id)?.baseUnit ?? '';
    } else if (parsed?.kind === 'recipe') {
      choices = childUnitChoices(
        catalog.batches.find((batch) => batch.id === parsed.id),
        atMs,
        catalog.units,
      );
      preferred = choices[0]?.code ?? '';
    }
    const keep = choices.some((choice) => choice.code === draft.unit);
    const fallback = choices.some((choice) => choice.code === preferred)
      ? preferred
      : (choices[0]?.code ?? '');
    update(draft.key, { target, unit: keep ? draft.unit : fallback });
  }

  return (
    <div className="flex flex-col gap-3">
      {drafts.length === 0 ? <p>مفيش مكونات في النسخة دي</p> : null}
      <ul className="flex flex-col gap-3" aria-label="مكونات الوصفة">
        {drafts.map((draft, index) => {
          const number = index + 1;
          const choices = choicesFor(draft);
          return (
            <li
              key={draft.key}
              className="flex flex-col gap-2 rounded border border-neutral-200 p-2 sm:flex-row sm:items-end"
            >
              <label className="flex min-w-0 flex-[2] flex-col gap-1">
                <span className="sr-only">المكوّن {number}</span>
                <select
                  className={fieldClass}
                  disabled={disabled}
                  value={draft.target}
                  onChange={(event) => pick(draft, event.target.value)}
                >
                  <option value="">اختار الصنف أو التحضيرة</option>
                  <optgroup label="أصناف">
                    {catalog.stock
                      .filter(
                        (item) =>
                          itemAllowed(item, recipe.kind) &&
                          (item.active || draft.target === itemTarget(item.id)),
                      )
                      .map((item) => (
                        <option key={item.id} value={itemTarget(item.id)}>
                          {item.name}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="تحضيرات">
                    {catalog.batches
                      .filter(
                        (batch) =>
                          batch.id !== recipe.id &&
                          (batch.active ||
                            draft.target === recipeTarget(batch.id)),
                      )
                      .map((batch) => (
                        <option key={batch.id} value={recipeTarget(batch.id)}>
                          {batch.name}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="sr-only">الكمية {number}</span>
                <input
                  className={fieldClass}
                  dir="ltr"
                  inputMode="decimal"
                  disabled={disabled}
                  value={draft.quantity}
                  onChange={(event) =>
                    update(draft.key, { quantity: event.target.value })
                  }
                />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="sr-only">الوحدة {number}</span>
                <select
                  className={fieldClass}
                  disabled={disabled}
                  value={draft.unit}
                  onChange={(event) =>
                    update(draft.key, { unit: event.target.value })
                  }
                >
                  <option value="">اختار الوحدة</option>
                  {choices.map((choice) => (
                    <option key={choice.code} value={choice.code}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={secondaryButton}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onChange(drafts.filter((line) => line.key !== draft.key));
                }}
              >
                احذف السطر {number}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-neutral-600">{netQuantityHint}</p>
      <button
        className={secondaryButton}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          onChange([...drafts, newLine()]);
        }}
      >
        ضيف مكوّن
      </button>
    </div>
  );
}
