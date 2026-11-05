import { defaultsForKind } from '@/items/labels';
import { normalizeDecimal, parseUnitCost } from '@/items/validation';
import {
  guessKinds,
  usedIngredientNorms,
  type IngredientReview,
  type Review,
} from '@/recipes/import/model';
import type { ParsedWorkbook } from '@/recipes/import/parse';

export type ImportTokens = {
  /** recipe id to `recipe_schedule` token. */
  recipes: ReadonlyMap<string, string>;
  /** stock item id to loss token. */
  losses: ReadonlyMap<string, string>;
};

type PayloadLine = {
  stock_item_id?: string;
  item_key?: string;
  child_recipe_id?: string;
  recipe_key?: string;
  quantity: string;
  unit: string;
};

export type ImportPayload = {
  structural_hash: string;
  effective_from: string | null;
  reason: string | null;
  items: {
    key: string;
    name: string;
    kind: string;
    base_unit: string;
    count_frequency: string;
  }[];
  recipes: {
    key: string;
    kind: string;
    name?: string;
    recipe_id?: string;
    expected_token?: string;
    batch_qty?: string;
    batch_unit?: string;
    lines: PayloadLine[];
  }[];
  losses: {
    stock_item_id?: string;
    item_key?: string;
    expected_token?: string;
    loss_pct: string;
  }[];
  manual_opening_prices: {
    item_key: string;
    unit_cost: string;
    zero_cost_reason?: string;
  }[];
  bindings: {
    source_name: string;
    stock_item_id?: string;
    item_key?: string;
    recipe_id?: string;
    recipe_key?: string;
    is_block?: boolean;
  }[];
};

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * SHA-256 of names, kinds, lines, quantities, units and batch quantities.
 * No price, no cell position and no owner choice goes in, so the same file
 * structure always gives the same hash.
 */
export async function structuralHash(parsed: ParsedWorkbook): Promise<string> {
  const kinds = guessKinds(parsed);
  const blocks = parsed.blocks
    .map((block) => [
      block.norm,
      kinds.get(block.id) ?? 'dish',
      block.batchQty,
      block.batchUnit,
      block.lines
        .map((line) => [line.norm, line.qty, line.unit])
        .sort((left, right) =>
          compare(JSON.stringify(left), JSON.stringify(right)),
        ),
    ])
    .sort((left, right) => compare(String(left[0]), String(right[0])));
  const bytes = new TextEncoder().encode(JSON.stringify(blocks));
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** The existing recipes and items whose tokens the commit has to carry. */
export function requiredTokens(
  review: Review,
  parsed: ParsedWorkbook,
): { recipeIds: string[]; itemIds: string[] } {
  const recipeIds = new Set<string>();
  for (const block of review.blocks) {
    if (block.include && block.target.mode === 'existing') {
      recipeIds.add(block.target.recipeId);
    }
  }
  const used = usedIngredientNorms(review, parsed);
  const itemIds = new Set<string>();
  for (const ingredient of review.ingredients) {
    if (
      used.has(ingredient.norm) &&
      ingredient.lossApproved &&
      ingredient.lossFraction !== null &&
      ingredient.target.type === 'item'
    ) {
      itemIds.add(ingredient.target.itemId);
    }
  }
  return { recipeIds: [...recipeIds], itemIds: [...itemIds] };
}

function tokenOf(map: ReadonlyMap<string, string>, id: string): string {
  const token = map.get(id);
  if (token === undefined) throw new Error('missing token');
  return token;
}

/** Assumes the review passed `validateReview`. */
export function buildImportPayload(input: {
  review: Review;
  parsed: ParsedWorkbook;
  hash: string;
  effectiveFrom: string | null;
  reason: string | null;
  tokens: ImportTokens;
}): ImportPayload {
  const { review, parsed, tokens } = input;
  const used = usedIngredientNorms(review, parsed);
  const ingredients = review.ingredients.filter((entry) =>
    used.has(entry.norm),
  );
  const ingredientOf = new Map(ingredients.map((entry) => [entry.norm, entry]));
  const included = review.blocks.filter((block) => block.include);

  const itemKeys = new Map<string, string>();
  const items: ImportPayload['items'] = [];
  for (const ingredient of ingredients) {
    if (ingredient.target.type !== 'new') continue;
    const key = `i${items.length + 1}`;
    itemKeys.set(ingredient.norm, key);
    items.push({
      key,
      name: ingredient.newItem.name.trim(),
      kind: ingredient.newItem.kind,
      base_unit: ingredient.newItem.baseUnit,
      count_frequency: defaultsForKind(ingredient.newItem.kind).countFrequency,
    });
  }

  function lineOf(
    ingredient: IngredientReview,
    quantity: string,
    unit: string | null,
  ): PayloadLine {
    const base = { quantity, unit: unit ?? ingredient.unit };
    const { target } = ingredient;
    if (target.type === 'item')
      return { stock_item_id: target.itemId, ...base };
    if (target.type === 'recipe') {
      return { child_recipe_id: target.recipeId, ...base };
    }
    if (target.type === 'block') {
      return { recipe_key: `r${target.blockId}`, ...base };
    }
    return { item_key: itemKeys.get(ingredient.norm) ?? '', ...base };
  }

  const recipes: ImportPayload['recipes'] = [];
  for (const block of included) {
    const source = parsed.blocks.find((entry) => entry.id === block.id);
    if (!source) continue;
    const lines = source.lines.flatMap((line) => {
      const ingredient = ingredientOf.get(line.norm);
      return ingredient
        ? [
            lineOf(
              ingredient,
              normalizeDecimal(line.qty) ?? line.qty,
              line.unit,
            ),
          ]
        : [];
    });
    const batch =
      block.kind === 'batch'
        ? {
            batch_qty: normalizeDecimal(block.batchQty) ?? block.batchQty,
            batch_unit: block.batchUnit,
          }
        : {};
    if (block.target.mode === 'new') {
      recipes.push({
        key: `r${block.id}`,
        kind: block.kind,
        name: block.target.name.trim(),
        ...batch,
        lines,
      });
    } else {
      recipes.push({
        key: `r${block.id}`,
        kind: block.kind,
        recipe_id: block.target.recipeId,
        expected_token: tokenOf(tokens.recipes, block.target.recipeId),
        ...batch,
        lines,
      });
    }
  }

  const losses: ImportPayload['losses'] = [];
  const lossItems = new Set<string>();
  for (const ingredient of ingredients) {
    if (!ingredient.lossApproved || ingredient.lossFraction === null) continue;
    const { target } = ingredient;
    if (target.type === 'item') {
      if (lossItems.has(target.itemId)) continue;
      lossItems.add(target.itemId);
      losses.push({
        stock_item_id: target.itemId,
        expected_token: tokenOf(tokens.losses, target.itemId),
        loss_pct: ingredient.lossFraction,
      });
    } else if (target.type === 'new') {
      losses.push({
        item_key: itemKeys.get(ingredient.norm) ?? '',
        loss_pct: ingredient.lossFraction,
      });
    }
  }

  const prices: ImportPayload['manual_opening_prices'] = [];
  for (const ingredient of ingredients) {
    if (ingredient.target.type !== 'new') continue;
    const typed = parseUnitCost(ingredient.price);
    if (!typed.ok || 'empty' in typed) continue;
    const zero = /^0(\.0+)?$/.test(typed.text);
    prices.push({
      item_key: itemKeys.get(ingredient.norm) ?? '',
      unit_cost: typed.text,
      ...(zero ? { zero_cost_reason: ingredient.priceReason.trim() } : {}),
    });
  }

  const bindings: ImportPayload['bindings'] = [];
  const taken = new Set<string>();
  for (const block of included) {
    const source = parsed.blocks.find((entry) => entry.id === block.id);
    if (!source || taken.has(source.norm)) continue;
    taken.add(source.norm);
    bindings.push({
      source_name: source.norm,
      recipe_key: `r${block.id}`,
      is_block: true,
    });
  }
  for (const ingredient of ingredients) {
    if (taken.has(ingredient.norm)) continue;
    taken.add(ingredient.norm);
    const { target } = ingredient;
    if (target.type === 'item') {
      bindings.push({
        source_name: ingredient.norm,
        stock_item_id: target.itemId,
      });
    } else if (target.type === 'recipe') {
      bindings.push({
        source_name: ingredient.norm,
        recipe_id: target.recipeId,
      });
    } else if (target.type === 'block') {
      bindings.push({
        source_name: ingredient.norm,
        recipe_key: `r${target.blockId}`,
      });
    } else {
      bindings.push({
        source_name: ingredient.norm,
        item_key: itemKeys.get(ingredient.norm) ?? '',
      });
    }
  }

  return {
    structural_hash: input.hash,
    effective_from: input.effectiveFrom,
    reason: input.reason,
    items,
    recipes,
    losses,
    manual_opening_prices: prices,
    bindings,
  };
}
