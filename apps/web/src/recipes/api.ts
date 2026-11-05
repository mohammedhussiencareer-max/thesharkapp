import {
  ConfirmedRefusalError,
  CostingChangedError,
  genericCatalogError,
} from '@/items/errors';
import { beginAction, settleAction } from '@/items/request-id';
import { isStockKind } from '@/items/types';
import { readAllByKey, readAllPages } from '@/lib/paged';
import { supabase } from '@/lib/supabase';
import { isDefiniteRefusal } from '@/lib/write-outcome';
import { isDuplicateRecipeName, mapRecipeError } from '@/recipes/errors';
import { recipeCreateSubject } from '@/recipes/subjects';
import {
  isRecipeKind,
  type BatchOption,
  type Expansion,
  type ItemUnit,
  type RecipeIssue,
  type RecipeKind,
  type RecipeLine,
  type RecipeRecord,
  type RecipeSchedule,
  type RecipeSummary,
  type RecipeVersion,
  type RecipeWrite,
  type StockOption,
  type UnitMeta,
} from '@/recipes/types';

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

type PostgrestError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

function throwIfError(error: PostgrestError | null): void {
  if (!error) return;
  // Only the writers' post-replay message proves this request stored nothing.
  if (error.code === '40001' && error.message === 'configuration changed') {
    throw new CostingChangedError();
  }
  if (isDuplicateRecipeName(error)) {
    throw new ConfirmedRefusalError(mapRecipeError(error));
  }
  const mapped = new Error(mapRecipeError(error));
  // The sqlstate stays on the error so a definite refusal retires its request id.
  if (isDefiniteRefusal(error)) {
    Object.assign(mapped, { code: error.code });
  }
  throw mapped;
}

/** PostgREST accepts a JSON decimal string for a numeric argument. */
function numericArg(value: string): number {
  return value as unknown as number;
}

function nullableNumeric(value: string | null): number {
  return value as unknown as number;
}

function nullableText(value: string | null): string {
  return value as unknown as string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(genericCatalogError);
  }
  return value as Record<string, unknown>;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(genericCatalogError);
  return value;
}

/** A jsonb number arrives as a JS number. Write it back without an exponent. */
function plainDecimal(value: unknown): string {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(genericCatalogError);
  }
  const text = String(value);
  if (!/e/i.test(text)) return text;
  return value.toFixed(20).replace(/\.?0+$/, '');
}

function coversNow(
  row: { effective_from: string; effective_to: string | null },
  nowMs: number,
): boolean {
  const from = Date.parse(row.effective_from);
  if (Number.isNaN(from) || from > nowMs) return false;
  if (row.effective_to == null) return true;
  return nowMs < Date.parse(row.effective_to);
}

function byRecipe<T extends { recipe_id: string }>(
  versions: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const version of versions) {
    const group = grouped.get(version.recipe_id);
    if (group) group.push(version);
    else grouped.set(version.recipe_id, [version]);
  }
  return grouped;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(genericCatalogError);
  return value.map(record);
}

function recipeRow(row: {
  id: string;
  name: string;
  kind: string;
  active: boolean;
}): RecipeRecord {
  if (!isRecipeKind(row.kind)) throw new Error(genericCatalogError);
  return { id: row.id, name: row.name, kind: row.kind, active: row.active };
}

export async function listRecipes(): Promise<RecipeSummary[]> {
  // Versions are read on their own: an embedded list is cut at the row limit too.
  // They page by id, since a superseded row leaving the filter shifts offsets.
  const [list, versions] = await Promise.all([
    readAllPages<{
      id: string;
      name: string;
      kind: string;
      active: boolean;
    }>(
      appDb().from('recipes').select('id, name, kind, active').order('id'),
      genericCatalogError,
    ),
    readAllByKey<{
      id: string;
      recipe_id: string;
      effective_from: string;
      effective_to: string | null;
    }>((afterId, size) => {
      const query = appDb()
        .from('recipe_versions')
        .select('id, recipe_id, effective_from, effective_to')
        .is('superseded_change_id', null);
      return (afterId === null ? query : query.gt('id', afterId))
        .order('id')
        .limit(size);
    }, genericCatalogError),
  ]);
  const current = byRecipe(versions);
  const nowMs = Date.now();
  return list
    .map((row) => ({
      ...recipeRow(row),
      inForce: (current.get(row.id) ?? []).some((version) =>
        coversNow(version, nowMs),
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ar'));
}

export async function getRecipe(id: string): Promise<RecipeRecord | null> {
  const { data, error } = await appDb()
    .from('recipes')
    .select('id, name, kind, active')
    .eq('id', id)
    .maybeSingle();
  throwIfError(error);
  return data ? recipeRow(data) : null;
}

export async function createRecipe(
  name: string,
  kind: RecipeKind,
): Promise<string> {
  const subject = recipeCreateSubject(name, kind);
  const requestId = beginAction(subject, (id) => id);
  try {
    const { data, error } = await appDb().rpc('create_recipe', {
      p_request_id: requestId,
      p_name: name.trim(),
      p_kind: kind,
    });
    throwIfError(error);
    const recipeId = record(data).recipe_id;
    if (typeof recipeId !== 'string' || recipeId.length === 0) {
      throw new Error(genericCatalogError);
    }
    settleAction(subject);
    return recipeId;
  } catch (failure) {
    settleAction(subject, failure);
    throw failure;
  }
}

export type RecipeUpdate = {
  requestId: string;
  name: string;
  active: boolean;
  expectedName: string;
  expectedActive: boolean;
};

export async function updateRecipe(
  recipeId: string,
  update: RecipeUpdate,
): Promise<void> {
  const { error } = await appDb().rpc('update_recipe', {
    p_request_id: update.requestId,
    p_recipe_id: recipeId,
    p_name: update.name.trim(),
    p_active: update.active,
    p_expected_name: update.expectedName,
    p_expected_active: update.expectedActive,
  });
  throwIfError(error);
}

type ExactVersion = { batchQty: string | null; lines: Map<string, string> };

function exactText(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(genericCatalogError);
  }
  return value;
}

/** The schedule's jsonb numbers lose digits in JSON.parse, so read them as text. */
async function exactQuantities(
  versionIds: readonly string[],
): Promise<Map<string, ExactVersion>> {
  const found = new Map<string, ExactVersion>();
  for (let start = 0; start < versionIds.length; start += 50) {
    const { data, error } = await appDb()
      .from('recipe_versions')
      .select('id, batch_qty::text, recipe_lines(id, quantity::text)')
      .in('id', versionIds.slice(start, start + 50));
    throwIfError(error);
    for (const version of rows(data)) {
      if (typeof version.id !== 'string') throw new Error(genericCatalogError);
      found.set(version.id, {
        batchQty:
          version.batch_qty == null ? null : exactText(version.batch_qty),
        lines: new Map(
          rows(version.recipe_lines).map((line) => {
            if (typeof line.id !== 'string') {
              throw new Error(genericCatalogError);
            }
            return [line.id, exactText(line.quantity)] as const;
          }),
        ),
      });
    }
  }
  return found;
}

function lineOf(value: unknown, exact: ExactVersion): RecipeLine {
  const row = record(value);
  if (typeof row.id !== 'string' || typeof row.unit !== 'string') {
    throw new Error(genericCatalogError);
  }
  const quantity = exact.lines.get(row.id);
  if (quantity === undefined) throw new Error(genericCatalogError);
  return {
    id: row.id,
    stockItemId: textOrNull(row.stock_item_id),
    childRecipeId: textOrNull(row.child_recipe_id),
    quantity,
    unit: row.unit,
  };
}

function versionOf(
  value: unknown,
  exactById: ReadonlyMap<string, ExactVersion>,
): RecipeVersion {
  const row = record(value);
  if (typeof row.id !== 'string' || typeof row.effective_from !== 'string') {
    throw new Error(genericCatalogError);
  }
  const exact = exactById.get(row.id);
  if (!exact || (row.batch_qty == null) !== (exact.batchQty === null)) {
    throw new Error(genericCatalogError);
  }
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    effectiveTo: textOrNull(row.effective_to),
    batchQty: exact.batchQty,
    batchUnit: textOrNull(row.batch_unit),
    lines: rows(row.lines).map((line) => lineOf(line, exact)),
  };
}

export async function recipeSchedule(
  recipeId: string,
): Promise<RecipeSchedule> {
  const { data, error } = await appDb().rpc('recipe_schedule', {
    p_recipe_id: recipeId,
  });
  throwIfError(error);
  const row = record(data);
  if (
    typeof row.identity !== 'string' ||
    typeof row.token !== 'string' ||
    typeof row.empty_token !== 'string'
  ) {
    throw new Error(genericCatalogError);
  }
  const scheduled = rows(row.versions);
  const exact = await exactQuantities(
    scheduled.map((version) => {
      if (typeof version.id !== 'string') throw new Error(genericCatalogError);
      return version.id;
    }),
  );
  return {
    identity: row.identity,
    token: row.token,
    emptyToken: row.empty_token,
    versions: scheduled.map((version) => versionOf(version, exact)),
  };
}

export async function setRecipeVersion(
  recipeId: string,
  write: RecipeWrite,
): Promise<void> {
  const { error } = await appDb().rpc('set_recipe_version', {
    p_request_id: write.requestId,
    p_recipe_id: recipeId,
    p_effective_from: nullableText(write.effectiveFrom),
    p_effective_to: nullableText(write.effectiveTo),
    p_batch_qty: nullableNumeric(write.batchQty),
    p_batch_unit: nullableText(write.batchUnit),
    p_lines: write.lines,
    p_reason: nullableText(write.reason),
    p_expected_token: write.token,
  });
  throwIfError(error);
}

function issueOf(value: unknown): RecipeIssue {
  const row = record(value);
  if (typeof row.code !== 'string') throw new Error(genericCatalogError);
  return {
    code: row.code,
    recipeId: textOrNull(row.recipe_id),
    stockItemId: textOrNull(row.stock_item_id),
    unit: textOrNull(row.unit),
  };
}

export async function expandRecipe(
  recipeId: string,
  outputQty: string,
  outputUnit: string,
  atIso: string,
): Promise<Expansion> {
  const { data, error } = await appDb().rpc('expand_recipe', {
    p_recipe_id: recipeId,
    p_output_qty: numericArg(outputQty),
    p_output_unit: outputUnit,
    p_at: atIso,
  });
  throwIfError(error);
  const row = record(data);
  if (row.status === 'ready') {
    return {
      status: 'ready',
      requirements: rows(row.requirements).map((entry) => {
        if (
          typeof entry.stock_item_id !== 'string' ||
          typeof entry.base_unit !== 'string'
        ) {
          throw new Error(genericCatalogError);
        }
        return {
          stockItemId: entry.stock_item_id,
          baseUnit: entry.base_unit,
          quantity: plainDecimal(entry.quantity),
        };
      }),
    };
  }
  if (row.status === 'blocked') {
    return { status: 'blocked', issues: rows(row.issues).map(issueOf) };
  }
  throw new Error(genericCatalogError);
}

export async function listStockOptions(): Promise<StockOption[]> {
  const list = await readAllPages<{
    id: string;
    name: string;
    kind: string;
    base_unit: string;
    active: boolean;
  }>(
    appDb()
      .from('stock_items')
      .select('id, name, kind, base_unit, active')
      .order('id'),
    genericCatalogError,
  );
  return list
    .map((row) => {
      if (!isStockKind(row.kind)) throw new Error(genericCatalogError);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        baseUnit: row.base_unit,
        active: row.active,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'ar'));
}

export async function listItemUnits(): Promise<ItemUnit[]> {
  const list = await readAllPages<{
    item_id: string | null;
    unit_code: string | null;
    label_ar: string | null;
  }>(
    appDb()
      .from('item_units_current')
      .select('item_id, unit_code, label_ar')
      .order('item_id')
      .order('unit_code'),
    genericCatalogError,
  );
  return list.flatMap((row) =>
    row.item_id && row.unit_code
      ? [
          {
            itemId: row.item_id,
            unit: row.unit_code,
            label: row.label_ar ?? row.unit_code,
          },
        ]
      : [],
  );
}

export async function listUnitsMeta(): Promise<UnitMeta[]> {
  const { data, error } = await appDb()
    .from('units')
    .select('code, label_ar, dimension, metric_scale')
    .order('label_ar');
  throwIfError(error);
  return (data ?? []).map((row) => ({
    code: row.code,
    labelAr: row.label_ar,
    dimension: row.dimension,
    metricScale: row.metric_scale,
  }));
}

export async function listBatchOptions(): Promise<BatchOption[]> {
  const [list, versions] = await Promise.all([
    readAllPages<{ id: string; name: string; active: boolean }>(
      appDb()
        .from('recipes')
        .select('id, name, active')
        .eq('kind', 'batch')
        .order('id'),
      genericCatalogError,
    ),
    readAllByKey<{
      id: string;
      recipe_id: string;
      effective_from: string;
      effective_to: string | null;
      batch_unit: string | null;
    }>((afterId, size) => {
      const query = appDb()
        .from('recipe_versions')
        .select('id, recipe_id, effective_from, effective_to, batch_unit')
        .is('superseded_change_id', null)
        .not('batch_unit', 'is', null);
      return (afterId === null ? query : query.gt('id', afterId))
        .order('id')
        .limit(size);
    }, genericCatalogError),
  ]);
  const current = byRecipe(versions);
  return list
    .map((row) => ({
      id: row.id,
      name: row.name,
      active: row.active,
      versions: (current.get(row.id) ?? []).flatMap((version) =>
        typeof version.batch_unit === 'string'
          ? [
              {
                effectiveFrom: version.effective_from,
                effectiveTo: version.effective_to,
                unit: version.batch_unit,
              },
            ]
          : [],
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ar'));
}
