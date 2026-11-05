import { currentShiftStart, listCostingSchedule } from '@/items/api';
import { CostingChangedError, genericCatalogError } from '@/items/errors';
import { readAllByKey } from '@/lib/paged';
import { supabase } from '@/lib/supabase';
import type { Json } from '@/lib/database.types';
import { isDefiniteRefusal } from '@/lib/write-outcome';
import {
  listBatchOptions,
  listItemUnits,
  listRecipes,
  listStockOptions,
  listUnitsMeta,
} from '@/recipes/api';
import { mapRecipeError } from '@/recipes/errors';
import type { ImportContext, SourceBinding } from '@/recipes/import/model';
import type { ImportPayload, ImportTokens } from '@/recipes/import/payload';

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
  if (error.code === '40001' && error.message === 'configuration changed') {
    throw new CostingChangedError();
  }
  const mapped = new Error(mapRecipeError(error));
  if (isDefiniteRefusal(error)) Object.assign(mapped, { code: error.code });
  throw mapped;
}

type BindingRow = {
  id: string;
  source_name: string;
  recipe_id: string | null;
  stock_item_id: string | null;
  is_block: boolean;
  created_at: string;
};

/** The latest row per source name is the current binding. */
async function listBindings(): Promise<SourceBinding[]> {
  const rows = await readAllByKey<BindingRow>((afterId, size) => {
    const query = appDb()
      .from('recipe_import_bindings')
      .select(
        'id, source_name, recipe_id, stock_item_id, is_block, created_at',
      );
    return (afterId === null ? query : query.gt('id', afterId))
      .order('id')
      .limit(size);
  }, genericCatalogError);
  const latest = new Map<string, BindingRow>();
  for (const row of rows) {
    const known = latest.get(row.source_name);
    if (
      !known ||
      Date.parse(row.created_at) > Date.parse(known.created_at) ||
      (row.created_at === known.created_at && row.id > known.id)
    ) {
      latest.set(row.source_name, row);
    }
  }
  return [...latest.values()].map((row) => ({
    source: row.source_name,
    recipeId: row.recipe_id,
    stockItemId: row.stock_item_id,
    block: row.is_block,
  }));
}

async function listKnownHashes(): Promise<string[]> {
  const rows = await readAllByKey<{ id: string; structural_hash: string }>(
    (afterId, size) => {
      const query = appDb()
        .from('recipe_imports')
        .select('id, structural_hash');
      return (afterId === null ? query : query.gt('id', afterId))
        .order('id')
        .limit(size);
    },
    genericCatalogError,
  );
  return rows.map((row) => row.structural_hash);
}

export async function loadImportContext(): Promise<ImportContext> {
  const [
    stock,
    recipes,
    batches,
    itemUnits,
    units,
    shiftStart,
    bindings,
    hashes,
  ] = await Promise.all([
    listStockOptions(),
    listRecipes(),
    listBatchOptions(),
    listItemUnits(),
    listUnitsMeta(),
    currentShiftStart(),
    listBindings(),
    listKnownHashes(),
  ]);
  return {
    stock,
    recipes,
    batches,
    itemUnits,
    units,
    shiftStart,
    bindings,
    knownHashes: hashes,
  };
}

async function recipeToken(recipeId: string): Promise<string> {
  const { data, error } = await appDb().rpc('recipe_schedule', {
    p_recipe_id: recipeId,
  });
  throwIfError(error);
  const token =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).token
      : undefined;
  if (typeof token !== 'string') throw new Error(genericCatalogError);
  return token;
}

async function inChunks<T>(
  ids: readonly string[],
  load: (id: string) => Promise<T>,
): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  for (let start = 0; start < ids.length; start += 8) {
    const chunk = ids.slice(start, start + 8);
    const values = await Promise.all(chunk.map(load));
    chunk.forEach((id, index) => {
      const value = values[index];
      if (value !== undefined) found.set(id, value);
    });
  }
  return found;
}

/** Current tokens of the existing recipes and item losses the commit will touch. */
export async function fetchImportTokens(need: {
  recipeIds: readonly string[];
  itemIds: readonly string[];
}): Promise<ImportTokens> {
  const [recipes, losses] = await Promise.all([
    inChunks(need.recipeIds, recipeToken),
    inChunks(
      need.itemIds,
      async (id) => (await listCostingSchedule(id)).lossToken,
    ),
  ]);
  return { recipes, losses };
}

export type ImportAction = { requestId: string; payload: ImportPayload };

export type ImportResult = {
  importId: string;
  counts: Record<string, number>;
  recipes: { key: string; recipeId: string; status: string }[];
};

function counts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(genericCatalogError);
  }
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number') result[key] = entry;
  }
  return result;
}

/** The one write of an import. Never retried here; the caller owns the request id. */
export async function commitRecipeImport(
  action: ImportAction,
): Promise<ImportResult> {
  const { data, error } = await appDb().rpc('commit_recipe_import', {
    p_request_id: action.requestId,
    p_payload: action.payload as unknown as Json,
  });
  throwIfError(error);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(genericCatalogError);
  }
  const row = data as Record<string, unknown>;
  const recipes = Array.isArray(row.recipes) ? row.recipes : [];
  return {
    importId: typeof row.import_id === 'string' ? row.import_id : '',
    counts: counts(row.counts),
    recipes: recipes.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      return typeof item.key === 'string' &&
        typeof item.recipe_id === 'string' &&
        typeof item.status === 'string'
        ? [{ key: item.key, recipeId: item.recipe_id, status: item.status }]
        : [];
    }),
  };
}
