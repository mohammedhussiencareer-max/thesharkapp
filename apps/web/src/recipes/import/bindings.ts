export type BindingRow = {
  id: string;
  source_name: string;
  recipe_id: string | null;
  stock_item_id: string | null;
  is_block: boolean;
  created_at: string;
};

export type SourceBinding = {
  source: string;
  recipeId: string | null;
  stockItemId: string | null;
};

function isNewer(row: BindingRow, known: BindingRow): boolean {
  return (
    Date.parse(row.created_at) > Date.parse(known.created_at) ||
    (row.created_at === known.created_at && row.id > known.id)
  );
}

function newestPerSource(rows: readonly BindingRow[]): BindingRow[] {
  const latest = new Map<string, BindingRow>();
  for (const row of rows) {
    const known = latest.get(row.source_name);
    if (!known || isNewer(row, known)) latest.set(row.source_name, row);
  }
  return [...latest.values()];
}

function toBinding(row: BindingRow): SourceBinding {
  return {
    source: row.source_name,
    recipeId: row.recipe_id,
    stockItemId: row.stock_item_id,
  };
}

/**
 * `bindings` is the latest mapping per source name. `blockBindings` is the
 * latest row per source name that was a recipe block title, kept even after
 * a later import mapped the same name as an ingredient line.
 */
export function reduceBindings(rows: readonly BindingRow[]): {
  bindings: SourceBinding[];
  blockBindings: SourceBinding[];
} {
  return {
    bindings: newestPerSource(rows).map(toBinding),
    blockBindings: newestPerSource(rows.filter((row) => row.is_block)).map(
      toBinding,
    ),
  };
}
