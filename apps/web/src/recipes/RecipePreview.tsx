import { useEffect, useState, type ReactNode } from 'react';
import { genericCatalogError, messageFrom } from '@/items/errors';
import { normalizeDecimal } from '@/items/validation';
import { expandRecipe } from '@/recipes/api';
import { issueMessages, portionLabel, portionUnit } from '@/recipes/labels';
import { massChoices, metricChoices, type UnitChoice } from '@/recipes/lines';
import type {
  Expansion,
  RecipeCatalog,
  RecipeRecord,
  RecipeVersion,
} from '@/recipes/types';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';

type Shown =
  { key: string; result: Expansion } | { key: string; error: string };

function outputChoices(
  recipe: RecipeRecord,
  version: RecipeVersion | null,
  catalog: RecipeCatalog,
): UnitChoice[] {
  if (recipe.kind === 'dish')
    return [{ code: portionUnit, label: portionLabel }];
  if (recipe.kind === 'cooking') {
    const mass = massChoices(catalog.units);
    return mass.length > 0 ? mass : [{ code: 'kg', label: 'كيلو' }];
  }
  return version?.batchUnit
    ? metricChoices(version.batchUnit, catalog.units)
    : [];
}

function defaultOutput(
  recipe: RecipeRecord,
  version: RecipeVersion | null,
): { quantity: string; unit: string } {
  if (recipe.kind === 'dish') return { quantity: '1', unit: portionUnit };
  if (recipe.kind === 'cooking') return { quantity: '1', unit: 'kg' };
  return {
    quantity: version?.batchQty ?? '1',
    unit: version?.batchUnit ?? '',
  };
}

export function RecipePreview({
  recipe,
  version,
  catalog,
  atMs,
  refreshKey,
}: {
  recipe: RecipeRecord;
  /** The saved version in force at `atMs`. */
  version: RecipeVersion | null;
  catalog: RecipeCatalog;
  atMs: number;
  /** Changes whenever the saved versions change. */
  refreshKey: string;
}) {
  const defaults = defaultOutput(recipe, version);
  const [quantityText, setQuantityText] = useState<string | null>(null);
  const [chosenUnit, setChosenUnit] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const choices = outputChoices(recipe, version, catalog);
  const quantityRaw = quantityText ?? defaults.quantity;
  const unit =
    chosenUnit !== null && choices.some((choice) => choice.code === chosenUnit)
      ? chosenUnit
      : defaults.unit;
  const quantity = normalizeDecimal(quantityRaw);
  const quantityValid = quantity !== null && quantity !== '0';
  const atIso = new Date(atMs).toISOString();
  const runnable = quantityValid && unit.length > 0 && !!version;
  const key = `${recipe.id}|${quantity ?? ''}|${unit}|${atIso}|${refreshKey}`;
  const current = shown?.key === key ? shown : null;

  useEffect(() => {
    if (!runnable || quantity === null) return;
    let cancelled = false;
    void expandRecipe(recipe.id, quantity, unit, atIso)
      .then((result) => {
        if (!cancelled) setShown({ key, result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setShown({ key, error: messageFrom(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [atIso, key, quantity, recipe.id, runnable, unit]);

  function nameOf(issue: {
    stockItemId: string | null;
    recipeId: string | null;
  }) {
    if (issue.stockItemId) {
      return catalog.stock.find((item) => item.id === issue.stockItemId)?.name;
    }
    if (issue.recipeId) {
      return catalog.batches.find((batch) => batch.id === issue.recipeId)?.name;
    }
    return undefined;
  }

  function unitLabel(code: string): string {
    return catalog.units.find((entry) => entry.code === code)?.labelAr ?? code;
  }

  let body: ReactNode;
  if (!quantityValid) {
    body = <p role="alert">الكمية لازم تكون رقم أكبر من صفر</p>;
  } else if (!version) {
    body = <p>{issueMessages.no_version_in_force}</p>;
  } else if (!current) {
    body = runnable ? <p>جاري حساب المعاينة…</p> : null;
  } else if ('error' in current) {
    body = <p role="alert">{current.error}</p>;
  } else if (current.result.status === 'ready') {
    body =
      current.result.requirements.length === 0 ? (
        <p>مفيش مكونات في المعاينة</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="المكونات المطلوبة">
          {current.result.requirements.map((entry) => (
            <li key={`${entry.stockItemId}|${entry.baseUnit}`}>
              {catalog.stock.find((item) => item.id === entry.stockItemId)
                ?.name ?? 'صنف غير معروف'}
              {': '}
              <span dir="ltr">{entry.quantity}</span>{' '}
              {unitLabel(entry.baseUnit)}
            </li>
          ))}
        </ul>
      );
  } else {
    body = (
      <ul className="flex flex-col gap-1" aria-label="مشاكل المعاينة">
        {current.result.issues.map((issue) => {
          const name = nameOf(issue);
          return (
            <li
              key={`${issue.code}|${issue.stockItemId ?? ''}|${issue.recipeId ?? ''}|${issue.unit ?? ''}`}
            >
              {issueMessages[issue.code] ?? genericCatalogError}
              {name ? ` (${name})` : ''}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="flex flex-col gap-3" aria-label="معاينة الوصفة">
      <h2 className="text-xl font-semibold">معاينة</h2>
      <p className="text-sm text-neutral-600">
        المعاينة بتعرض النسخة المحفوظة في الوقت المختار.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          كمية المعاينة
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="decimal"
            value={quantityRaw}
            onChange={(event) => setQuantityText(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          وحدة المعاينة
          <select
            className={fieldClass}
            value={unit}
            disabled={choices.length < 2}
            onChange={(event) => setChosenUnit(event.target.value)}
          >
            {choices.map((choice) => (
              <option key={choice.code} value={choice.code}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {body}
    </section>
  );
}
