import type { StockKind } from '@/items/types';
import { normalizeDecimal } from '@/items/validation';
import type {
  BatchOption,
  ItemUnit,
  RecipeKind,
  RecipeVersion,
  StockOption,
  UnitMeta,
  WireLine,
} from '@/recipes/types';

export type LineDraft = {
  key: string;
  /** `item:<id>` or `recipe:<id>`. Empty until the owner picks one. */
  target: string;
  quantity: string;
  unit: string;
};

export type UnitChoice = { code: string; label: string };

const marineKinds: readonly StockKind[] = [
  'seafood',
  'fish_size',
  'fish_mixed',
];
const neverInRecipe: readonly StockKind[] = ['packaging', 'fish_mixed'];

let lineCounter = 0;

export function newLine(): LineDraft {
  lineCounter += 1;
  return { key: `line-${lineCounter}`, target: '', quantity: '', unit: '' };
}

export function itemTarget(id: string): string {
  return `item:${id}`;
}

export function recipeTarget(id: string): string {
  return `recipe:${id}`;
}

export function parseTarget(
  target: string,
): { kind: 'item' | 'recipe'; id: string } | null {
  const [kind, ...rest] = target.split(':');
  const id = rest.join(':');
  if ((kind !== 'item' && kind !== 'recipe') || id.length === 0) return null;
  return { kind, id };
}

export function linesFromVersion(version: RecipeVersion | null): LineDraft[] {
  if (!version) return [];
  return version.lines.map((line) => {
    lineCounter += 1;
    const target = line.stockItemId
      ? itemTarget(line.stockItemId)
      : line.childRecipeId
        ? recipeTarget(line.childRecipeId)
        : '';
    return {
      key: `line-${lineCounter}`,
      target,
      quantity: line.quantity,
      unit: line.unit,
    };
  });
}

/** Packaging and mixed fish never enter a recipe, and cooking has no marine items. */
export function itemAllowed(
  item: StockOption,
  recipeKind: RecipeKind,
): boolean {
  if (neverInRecipe.includes(item.kind)) return false;
  return !(recipeKind === 'cooking' && marineKinds.includes(item.kind));
}

export function itemUnitChoices(
  itemId: string,
  itemUnits: readonly ItemUnit[],
): UnitChoice[] {
  return itemUnits
    .filter((entry) => entry.itemId === itemId)
    .map((entry) => ({ code: entry.unit, label: entry.label }));
}

function childUnit(child: BatchOption, atMs: number): string | null {
  const covering = child.versions.find((version) => {
    const from = Date.parse(version.effectiveFrom);
    const to = version.effectiveTo ? Date.parse(version.effectiveTo) : null;
    return from <= atMs && (to === null || atMs < to);
  });
  if (covering) return covering.unit;
  const latest = [...child.versions].sort(
    (left, right) =>
      Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom),
  )[0];
  return latest?.unit ?? null;
}

/** The unit itself, plus metric units of the same dimension. */
export function metricChoices(
  code: string,
  units: readonly UnitMeta[],
): UnitChoice[] {
  const own = units.find((unit) => unit.code === code);
  const choices: UnitChoice[] = [{ code, label: own?.labelAr ?? code }];
  if (!own || own.metricScale === null) return choices;
  for (const unit of units) {
    if (
      unit.code !== code &&
      unit.dimension === own.dimension &&
      unit.metricScale !== null
    ) {
      choices.push({ code: unit.code, label: unit.labelAr });
    }
  }
  return choices;
}

export function childUnitChoices(
  child: BatchOption | undefined,
  atMs: number,
  units: readonly UnitMeta[],
): UnitChoice[] {
  const batchUnit = child ? childUnit(child, atMs) : null;
  return batchUnit ? metricChoices(batchUnit, units) : [];
}

export function massChoices(units: readonly UnitMeta[]): UnitChoice[] {
  return units
    .filter((unit) => unit.dimension === 'mass' && unit.metricScale !== null)
    .map((unit) => ({ code: unit.code, label: unit.labelAr }));
}

export type LinesCheck =
  { ok: true; lines: WireLine[] } | { ok: false; error: string };

export function validateLines(drafts: readonly LineDraft[]): LinesCheck {
  if (drafts.length === 0) {
    return {
      ok: false,
      error: 'ضيف مكوّن واحد على الأقل أو وقّف الوصفة من الوقت ده',
    };
  }
  const lines: WireLine[] = [];
  for (const [index, draft] of drafts.entries()) {
    const prefix = `سطر ${index + 1}: `;
    const target = parseTarget(draft.target);
    if (!target)
      return { ok: false, error: `${prefix}اختار الصنف أو التحضيرة` };
    const quantity = normalizeDecimal(draft.quantity);
    if (quantity === null || quantity === '0') {
      return {
        ok: false,
        error: `${prefix}الكمية لازم تكون رقم أكبر من صفر`,
      };
    }
    if (draft.unit.length === 0) {
      return { ok: false, error: `${prefix}اختار الوحدة` };
    }
    lines.push(
      target.kind === 'item'
        ? { stock_item_id: target.id, quantity, unit: draft.unit }
        : { child_recipe_id: target.id, quantity, unit: draft.unit },
    );
  }
  return { ok: true, lines };
}

export type BatchCheck =
  | { ok: true; batchQty: string; batchUnit: string }
  | { ok: false; error: string };

export function validateBatch(quantity: string, unit: string): BatchCheck {
  const batchQty = normalizeDecimal(quantity);
  if (batchQty === null || batchQty === '0') {
    return { ok: false, error: 'كمية التحضيرة لازم تكون رقم أكبر من صفر' };
  }
  if (unit.length === 0) return { ok: false, error: 'اختار وحدة التحضيرة' };
  return { ok: true, batchQty, batchUnit: unit };
}
