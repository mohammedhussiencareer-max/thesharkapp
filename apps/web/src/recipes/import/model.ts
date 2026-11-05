import { defaultsForKind } from '@/items/labels';
import type { BaseUnit } from '@/items/types';
import { normalizeDecimal, parseUnitCost } from '@/items/validation';
import {
  childUnitChoices,
  itemAllowed,
  itemUnitChoices,
  metricChoices,
  type UnitChoice,
} from '@/recipes/lines';
import type {
  BatchOption,
  ItemUnit,
  RecipeSummary,
  StockOption,
  UnitMeta,
} from '@/recipes/types';
import type { SourceBinding } from '@/recipes/import/bindings';
import { collapseSpaces, normalizeName } from '@/recipes/import/normalize';
import type { ParsedWorkbook } from '@/recipes/import/parse';

export type { SourceBinding };

export type ImportContext = {
  stock: StockOption[];
  recipes: RecipeSummary[];
  batches: BatchOption[];
  itemUnits: ItemUnit[];
  units: UnitMeta[];
  shiftStart: string | null;
  /** The latest binding per normalised source name. */
  bindings: SourceBinding[];
  /** The latest binding per source name that was ever a recipe block title. */
  blockBindings: SourceBinding[];
  knownHashes: string[];
};

export type ImportKind = 'dish' | 'batch';
export type NewItemKind = 'ingredient' | 'seafood';

export type IngredientTarget =
  | { type: 'item'; itemId: string }
  | { type: 'recipe'; recipeId: string }
  | { type: 'block'; blockId: number }
  | { type: 'new' };

export type NewItemDraft = {
  name: string;
  kind: NewItemKind;
  baseUnit: BaseUnit;
};

export type IngredientReview = {
  norm: string;
  name: string;
  uses: number;
  target: IngredientTarget;
  matched: 'binding' | 'name' | 'block' | 'none';
  confirmed: boolean;
  newItem: NewItemDraft;
  /** Unit of the lines whose workbook cell named none. */
  unit: string;
  /** Loss ratio read from the loss sheet, as exact fraction text. */
  lossFraction: string | null;
  lossApproved: boolean;
  /** Typed by the owner. Never read from the workbook. */
  price: string;
  priceReason: string;
};

export type BlockTarget =
  { mode: 'new'; name: string } | { mode: 'existing'; recipeId: string };

export type BlockReview = {
  id: number;
  include: boolean;
  kind: ImportKind;
  target: BlockTarget;
  matched: 'binding' | 'name' | 'none';
  confirmed: boolean;
  batchQty: string;
  batchUnit: string;
};

export type Review = { blocks: BlockReview[]; ingredients: IngredientReview[] };

export const nameMaxLength = 120;
export const reasonMaxLength = 500;

/** The commit's own limits, checked here so the owner sees them before saving. */
const limits = {
  recipes: 500,
  items: 2000,
  bindings: 4000,
  lines: 300,
  sourceName: 200,
};

/** A block is a batch with an explicit net row, a batch-list entry, or a use as an ingredient. */
export function guessKinds(parsed: ParsedWorkbook): Map<number, ImportKind> {
  const listed = new Set(parsed.batchNames.map(normalizeName));
  const used = new Map<string, Set<number>>();
  for (const block of parsed.blocks) {
    for (const line of block.lines) {
      const users = used.get(line.norm) ?? new Set<number>();
      users.add(block.id);
      used.set(line.norm, users);
    }
  }
  const kinds = new Map<number, ImportKind>();
  for (const block of parsed.blocks) {
    const users = used.get(block.norm);
    const usedByOther =
      users !== undefined && [...users].some((id) => id !== block.id);
    kinds.set(
      block.id,
      block.batchQty !== null || listed.has(block.norm) || usedByOther
        ? 'batch'
        : 'dish',
    );
  }
  return kinds;
}

function choicesByTarget(
  target: IngredientTarget,
  newItem: NewItemDraft,
  blocks: readonly BlockReview[],
  ctx: ImportContext,
): UnitChoice[] {
  if (target.type === 'item') {
    return itemUnitChoices(target.itemId, ctx.itemUnits);
  }
  if (target.type === 'new') return metricChoices(newItem.baseUnit, ctx.units);
  if (target.type === 'recipe') {
    const updated = blocks.find(
      (block) =>
        block.include &&
        block.kind === 'batch' &&
        block.target.mode === 'existing' &&
        block.target.recipeId === target.recipeId,
    );
    if (updated) {
      return updated.batchUnit
        ? metricChoices(updated.batchUnit, ctx.units)
        : [];
    }
    return childUnitChoices(
      ctx.batches.find((batch) => batch.id === target.recipeId),
      Date.now(),
      ctx.units,
    );
  }
  const block = blocks.find((entry) => entry.id === target.blockId);
  return block && block.batchUnit
    ? metricChoices(block.batchUnit, ctx.units)
    : [];
}

export function ingredientChoices(
  ingredient: IngredientReview,
  review: Review,
  ctx: ImportContext,
): UnitChoice[] {
  return choicesByTarget(
    ingredient.target,
    ingredient.newItem,
    review.blocks,
    ctx,
  );
}

/** Workbook quantities are grams or millilitres, whatever the target is measured in. */
function defaultUnit(choices: readonly UnitChoice[]): string {
  for (const code of ['g', 'ml']) {
    if (choices.some((choice) => choice.code === code)) return code;
  }
  return '';
}

/** Keeps the owner's unit while it is still offered, else falls back to the default. */
function settleUnit(
  ingredient: IngredientReview,
  blocks: readonly BlockReview[],
  ctx: ImportContext,
): IngredientReview {
  const choices = choicesByTarget(
    ingredient.target,
    ingredient.newItem,
    blocks,
    ctx,
  );
  if (choices.some((choice) => choice.code === ingredient.unit)) {
    return ingredient;
  }
  return { ...ingredient, unit: defaultUnit(choices) };
}

function unique<T>(list: readonly T[]): T | null {
  return list.length === 1 ? (list[0] ?? null) : null;
}

export function candidateItems(ctx: ImportContext): StockOption[] {
  return ctx.stock.filter((item) => item.active && itemAllowed(item, 'dish'));
}

export function candidateRecipes(ctx: ImportContext): RecipeSummary[] {
  return ctx.recipes.filter((recipe) => recipe.kind !== 'cooking');
}

export function buildReview(
  parsed: ParsedWorkbook,
  ctx: ImportContext,
): Review {
  const kinds = guessKinds(parsed);
  const bindingOf = new Map(ctx.bindings.map((entry) => [entry.source, entry]));
  const recipes = candidateRecipes(ctx);

  const blocks: BlockReview[] = parsed.blocks.map((block) => {
    const guess = kinds.get(block.id) ?? 'dish';
    const bound = bindingOf.get(block.norm);
    const byBinding = bound?.recipeId
      ? recipes.find((recipe) => recipe.id === bound.recipeId)
      : undefined;
    const byName = byBinding
      ? undefined
      : unique(
          recipes.filter((recipe) => normalizeName(recipe.name) === block.norm),
        );
    const existing = byBinding ?? byName;
    const kind: ImportKind =
      existing && existing.kind !== 'cooking' ? existing.kind : guess;
    return {
      id: block.id,
      include: block.lines.length > 0,
      kind,
      target: existing
        ? { mode: 'existing', recipeId: existing.id }
        : { mode: 'new', name: collapseSpaces(block.name) },
      matched: byBinding ? 'binding' : byName ? 'name' : 'none',
      confirmed: false,
      batchQty: block.batchQty ?? '',
      batchUnit: block.batchUnit ?? (kind === 'batch' ? 'g' : ''),
    };
  });

  const items = candidateItems(ctx);
  const blockByNorm = new Map(
    parsed.blocks.map((block) => [block.norm, block]),
  );
  const seen = new Map<string, IngredientReview>();
  const order: string[] = [];
  for (const block of parsed.blocks) {
    for (const line of block.lines) {
      const known = seen.get(line.norm);
      if (known) {
        known.uses += 1;
        continue;
      }
      const bound = bindingOf.get(line.norm);
      const byBindingItem = bound?.stockItemId
        ? items.find((item) => item.id === bound.stockItemId)
        : undefined;
      const byBindingRecipe =
        !byBindingItem && bound?.recipeId
          ? ctx.batches.find(
              (batch) => batch.id === bound.recipeId && batch.active,
            )
          : undefined;
      const sameBlock = blockByNorm.get(line.norm);
      const byNameItem =
        byBindingItem || byBindingRecipe || sameBlock
          ? undefined
          : unique(
              items.filter((item) => normalizeName(item.name) === line.norm),
            );
      const byNameRecipe =
        byBindingItem || byBindingRecipe || sameBlock || byNameItem
          ? undefined
          : unique(
              ctx.batches.filter(
                (batch) =>
                  batch.active && normalizeName(batch.name) === line.norm,
              ),
            );
      let target: IngredientTarget = { type: 'new' };
      let matched: IngredientReview['matched'] = 'none';
      if (byBindingItem) {
        target = { type: 'item', itemId: byBindingItem.id };
        matched = 'binding';
      } else if (byBindingRecipe) {
        target = { type: 'recipe', recipeId: byBindingRecipe.id };
        matched = 'binding';
      } else if (sameBlock) {
        target = { type: 'block', blockId: sameBlock.id };
        matched = 'block';
      } else if (byNameItem) {
        target = { type: 'item', itemId: byNameItem.id };
        matched = 'name';
      } else if (byNameRecipe) {
        target = { type: 'recipe', recipeId: byNameRecipe.id };
        matched = 'name';
      }
      const hint = line.unit;
      const baseUnit: BaseUnit =
        hint === 'ml' || hint === 'liter'
          ? 'liter'
          : hint === 'piece'
            ? 'piece'
            : 'kg';
      const loss = parsed.losses.find((entry) => entry.norm === line.norm);
      const entry: IngredientReview = {
        norm: line.norm,
        name: collapseSpaces(line.name),
        uses: 1,
        target,
        matched,
        confirmed: false,
        newItem: {
          name: collapseSpaces(line.name),
          kind: 'ingredient',
          baseUnit,
        },
        unit: '',
        lossFraction: loss?.fraction ?? null,
        lossApproved: false,
        price: '',
        priceReason: '',
      };
      seen.set(line.norm, entry);
      order.push(line.norm);
    }
  }
  const ingredients = order.flatMap((norm) => {
    const entry = seen.get(norm);
    return entry ? [settleUnit(entry, blocks, ctx)] : [];
  });
  return { blocks, ingredients };
}

function mapIngredients(
  review: Review,
  ctx: ImportContext,
  change: (ingredient: IngredientReview) => IngredientReview,
  blocks: BlockReview[] = review.blocks,
): Review {
  return {
    blocks,
    ingredients: review.ingredients.map((ingredient) =>
      settleUnit(change(ingredient), blocks, ctx),
    ),
  };
}

export function patchIngredient(
  review: Review,
  ctx: ImportContext,
  norm: string,
  patch: Partial<IngredientReview>,
): Review {
  return mapIngredients(review, ctx, (ingredient) =>
    ingredient.norm === norm ? { ...ingredient, ...patch } : ingredient,
  );
}

/** Picking another target is an owner action, so it confirms the row. */
export function retargetIngredient(
  review: Review,
  ctx: ImportContext,
  norm: string,
  target: IngredientTarget,
): Review {
  return patchIngredient(review, ctx, norm, {
    target,
    confirmed: true,
    matched: 'none',
    unit: '',
    ...(target.type === 'new' ? {} : { price: '', priceReason: '' }),
    ...(target.type === 'item' || target.type === 'new'
      ? {}
      : { lossApproved: false }),
  });
}

export function patchNewItem(
  review: Review,
  ctx: ImportContext,
  norm: string,
  patch: Partial<NewItemDraft>,
): Review {
  return mapIngredients(review, ctx, (ingredient) => {
    if (ingredient.norm !== norm) return ingredient;
    const next = { ...ingredient.newItem, ...patch };
    if (patch.kind && !patch.baseUnit) {
      next.baseUnit = defaultsForKind(patch.kind).baseUnit;
    }
    return { ...ingredient, newItem: next };
  });
}

export function patchBlock(
  review: Review,
  ctx: ImportContext,
  id: number,
  patch: Partial<BlockReview>,
): Review {
  const blocks = review.blocks.map((block) =>
    block.id === id ? { ...block, ...patch } : block,
  );
  return mapIngredients(review, ctx, (ingredient) => ingredient, blocks);
}

export function retargetBlock(
  review: Review,
  ctx: ImportContext,
  id: number,
  target: BlockTarget,
): Review {
  const existing =
    target.mode === 'existing'
      ? ctx.recipes.find((recipe) => recipe.id === target.recipeId)
      : undefined;
  const kind: ImportKind | undefined =
    existing && existing.kind !== 'cooking' ? existing.kind : undefined;
  return patchBlock(review, ctx, id, {
    target,
    confirmed: true,
    matched: 'none',
    ...(kind ? { kind } : {}),
  });
}

/** Confirms every row that has a suggestion. Rows that would create something stay open. */
export function confirmSuggestions(review: Review): Review {
  return {
    blocks: review.blocks.map((block) =>
      block.matched !== 'none' ? { ...block, confirmed: true } : block,
    ),
    ingredients: review.ingredients.map((ingredient) =>
      ingredient.matched !== 'none'
        ? { ...ingredient, confirmed: true }
        : ingredient,
    ),
  };
}

export function usedIngredientNorms(
  review: Review,
  parsed: ParsedWorkbook,
): Set<string> {
  const included = new Set(
    review.blocks.filter((block) => block.include).map((block) => block.id),
  );
  const used = new Set<string>();
  for (const block of parsed.blocks) {
    if (!included.has(block.id)) continue;
    for (const line of block.lines) used.add(line.norm);
  }
  return used;
}

export type ReviewIssues = {
  general: string[];
  blocks: Map<number, string[]>;
  ingredients: Map<string, string[]>;
};

export function issueCount(issues: ReviewIssues): number {
  let count = issues.general.length;
  for (const list of issues.blocks.values()) count += list.length;
  for (const list of issues.ingredients.values()) count += list.length;
  return count;
}

function push<K>(map: Map<K, string[]>, key: K, message: string): void {
  const list = map.get(key);
  if (list) list.push(message);
  else map.set(key, [message]);
}

function validName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= nameMaxLength;
}

export function validateReview(
  review: Review,
  parsed: ParsedWorkbook,
  ctx: ImportContext,
): ReviewIssues {
  const issues: ReviewIssues = {
    general: [],
    blocks: new Map(),
    ingredients: new Map(),
  };
  const included = review.blocks.filter((block) => block.include);
  const includedIds = new Set(included.map((block) => block.id));
  if (included.length === 0) {
    issues.general.push('اختار وصفة واحدة على الأقل للاستيراد');
  }
  const byId = new Map(review.blocks.map((block) => [block.id, block]));
  const parsedById = new Map(parsed.blocks.map((block) => [block.id, block]));
  const used = usedIngredientNorms(review, parsed);
  if (
    included.length > limits.recipes ||
    used.size > limits.items ||
    included.length + used.size > limits.bindings
  ) {
    issues.general.push('الملف كبير أكتر من اللازم، قسّمه على أكتر من استيراد');
  }
  for (const block of included) {
    const source = parsedById.get(block.id);
    if (source && source.lines.length > limits.lines) {
      push(issues.blocks, block.id, 'عدد المكونات أكتر من اللازم');
    }
    if (source && source.norm.length > limits.sourceName) {
      push(issues.blocks, block.id, 'اسم الوصفة في الملف طويل');
    }
  }

  const recipeNames = new Set(ctx.recipes.map((recipe) => recipe.name));
  const itemNames = new Set(ctx.stock.map((item) => item.name));
  const newRecipeNames = new Map<string, number>();
  const existingTargets = new Map<string, number>();

  for (const block of included) {
    const source = parsedById.get(block.id);
    if (!source) continue;
    if (!block.confirmed) {
      push(issues.blocks, block.id, 'أكّد الوصفة أو اختار غيرها');
    }
    if (block.target.mode === 'new') {
      const name = block.target.name.trim();
      if (!validName(name)) {
        push(issues.blocks, block.id, 'اسم الوصفة من حرف لحد 120 حرف');
      } else if (recipeNames.has(name)) {
        push(
          issues.blocks,
          block.id,
          'في وصفة بنفس الاسم، اختارها أو غيّر الاسم',
        );
      } else {
        newRecipeNames.set(name, (newRecipeNames.get(name) ?? 0) + 1);
      }
    } else {
      const { recipeId } = block.target;
      const recipe = ctx.recipes.find((entry) => entry.id === recipeId);
      if (!recipe || recipe.kind === 'cooking') {
        push(issues.blocks, block.id, 'الوصفة المختارة مش متاحة للاستيراد');
      } else if (!recipe.active) {
        push(issues.blocks, block.id, 'الوصفة المختارة موقوفة');
      }
      existingTargets.set(recipeId, (existingTargets.get(recipeId) ?? 0) + 1);
    }
    if (block.kind === 'batch') {
      const qty = normalizeDecimal(block.batchQty);
      if (qty === null || qty === '0') {
        push(issues.blocks, block.id, 'اكتب كمية التحضيرة (رقم أكبر من صفر)');
      }
      if (block.batchUnit.length === 0) {
        push(issues.blocks, block.id, 'اختار وحدة التحضيرة');
      }
    }
  }
  for (const [name, count] of newRecipeNames) {
    if (count < 2) continue;
    for (const block of included) {
      if (block.target.mode === 'new' && block.target.name.trim() === name) {
        push(issues.blocks, block.id, 'اسم الوصفة متكرر في الاستيراد');
      }
    }
  }
  for (const [recipeId, count] of existingTargets) {
    if (count < 2) continue;
    for (const block of included) {
      if (
        block.target.mode === 'existing' &&
        block.target.recipeId === recipeId
      ) {
        push(
          issues.blocks,
          block.id,
          'نفس الوصفة مختارة لأكتر من وصفة في الملف',
        );
      }
    }
  }

  const newItemNames = new Map<string, number>();
  const lossByItem = new Map<string, string>();
  const packaging = new Set(parsed.packagingNames.map(normalizeName));
  const ingredients = review.ingredients.filter((entry) =>
    used.has(entry.norm),
  );
  for (const ingredient of ingredients) {
    const { norm, target } = ingredient;
    if (!ingredient.confirmed) {
      push(issues.ingredients, norm, 'أكّد المكوّن أو اختار غيره');
    }
    if (norm.length > limits.sourceName) {
      push(issues.ingredients, norm, 'اسم المكوّن في الملف طويل');
    }
    if (packaging.has(norm)) {
      push(
        issues.ingredients,
        norm,
        'الاسم ده في قايمة التغليف، والتغليف مش مكوّن',
      );
    }
    if (target.type === 'item') {
      const item = ctx.stock.find((entry) => entry.id === target.itemId);
      if (!item || !itemAllowed(item, 'dish')) {
        push(issues.ingredients, norm, 'الصنف المختار مش متاح كمكوّن');
      } else if (!item.active) {
        push(issues.ingredients, norm, 'الصنف المختار موقوف');
      }
    } else if (target.type === 'recipe') {
      const batch = ctx.batches.find((entry) => entry.id === target.recipeId);
      if (!batch || !batch.active) {
        push(issues.ingredients, norm, 'التحضيرة المختارة مش متاحة');
      }
    } else if (target.type === 'block') {
      const block = byId.get(target.blockId);
      if (!block || !block.include) {
        push(issues.ingredients, norm, 'الوصفة المختارة مش داخلة في الاستيراد');
      } else if (block.kind !== 'batch') {
        push(issues.ingredients, norm, 'المكوّن اللي هو وصفة لازم يكون تحضيرة');
      }
    } else {
      const name = ingredient.newItem.name.trim();
      if (!validName(name)) {
        push(issues.ingredients, norm, 'اسم الصنف من حرف لحد 120 حرف');
      } else if (itemNames.has(name)) {
        push(
          issues.ingredients,
          norm,
          'في صنف بنفس الاسم، اختاره أو غيّر الاسم',
        );
      } else {
        newItemNames.set(name, (newItemNames.get(name) ?? 0) + 1);
      }
    }

    const choices = ingredientChoices(ingredient, review, ctx);
    if (ingredient.unit.length === 0 || choices.length === 0) {
      push(issues.ingredients, norm, 'اختار وحدة الكميات');
    }
    for (const block of parsed.blocks) {
      if (!includedIds.has(block.id)) continue;
      for (const line of block.lines) {
        if (line.norm !== norm || line.unit === null) continue;
        if (!choices.some((choice) => choice.code === line.unit)) {
          push(
            issues.ingredients,
            norm,
            `الوحدة ${line.unit} المكتوبة في الملف مش متاحة للمكوّن ده`,
          );
          break;
        }
      }
    }

    const price = parseUnitCost(ingredient.price);
    if (target.type !== 'new' && ingredient.price.trim() !== '') {
      push(issues.ingredients, norm, 'السعر الافتتاحي للأصناف الجديدة بس');
    } else if (!price.ok) {
      push(issues.ingredients, norm, price.error);
    } else if (!('empty' in price) && /^0(\.0+)?$/.test(price.text)) {
      const reason = ingredient.priceReason.trim();
      if (reason.length === 0) {
        push(issues.ingredients, norm, 'اكتب سبب إن السعر صفر');
      } else if (reason.length > reasonMaxLength) {
        push(issues.ingredients, norm, 'سبب السعر طويل');
      }
    }

    if (ingredient.lossApproved) {
      if (ingredient.lossFraction === null) {
        push(issues.ingredients, norm, 'مفيش نسبة فاقد في الملف للمكوّن ده');
      } else if (target.type === 'item') {
        const earlier = lossByItem.get(target.itemId);
        if (earlier !== undefined && earlier !== ingredient.lossFraction) {
          push(issues.ingredients, norm, 'نسبتين فاقد مختلفتين لنفس الصنف');
        }
        lossByItem.set(target.itemId, ingredient.lossFraction);
      } else if (target.type !== 'new') {
        push(issues.ingredients, norm, 'الفاقد للأصناف بس');
      }
    }
  }
  for (const [name, count] of newItemNames) {
    if (count < 2) continue;
    for (const ingredient of ingredients) {
      if (
        ingredient.target.type === 'new' &&
        ingredient.newItem.name.trim() === name
      ) {
        push(
          issues.ingredients,
          ingredient.norm,
          'اسم الصنف متكرر في الاستيراد',
        );
      }
    }
  }

  const children = new Map<number, number[]>();
  const ingredientOf = new Map(ingredients.map((entry) => [entry.norm, entry]));
  for (const block of included) {
    const source = parsedById.get(block.id);
    const next: number[] = [];
    for (const line of source?.lines ?? []) {
      const target = ingredientOf.get(line.norm)?.target;
      if (target?.type === 'block') next.push(target.blockId);
    }
    children.set(block.id, next);
  }
  const state = new Map<number, 'open' | 'done'>();
  const cyclic = new Set<number>();
  function visit(id: number, trail: number[]): void {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      for (const member of trail.slice(trail.indexOf(id))) cyclic.add(member);
      return;
    }
    state.set(id, 'open');
    for (const child of children.get(id) ?? []) visit(child, [...trail, id]);
    state.set(id, 'done');
  }
  for (const block of included) visit(block.id, []);
  for (const id of cyclic) {
    push(issues.blocks, id, 'الوصفة بتدخل في دايرة وبتستخدم نفسها');
  }
  return issues;
}

/** Recipes bound to a block name of an earlier import that this file no longer has. Only listed, never archived. */
export function disappearedRecipes(
  parsed: ParsedWorkbook,
  ctx: ImportContext,
): { id: string; name: string }[] {
  const present = new Set(parsed.blocks.map((block) => block.norm));
  const stillSourced = new Set(
    ctx.blockBindings.flatMap((binding) =>
      binding.recipeId && present.has(binding.source) ? [binding.recipeId] : [],
    ),
  );
  const found: { id: string; name: string }[] = [];
  for (const binding of ctx.blockBindings) {
    if (!binding.recipeId || present.has(binding.source)) continue;
    const recipe = ctx.recipes.find((entry) => entry.id === binding.recipeId);
    if (
      recipe &&
      recipe.active &&
      recipe.kind !== 'cooking' &&
      !stillSourced.has(recipe.id) &&
      !present.has(normalizeName(recipe.name)) &&
      !found.some((entry) => entry.id === recipe.id)
    ) {
      found.push({ id: recipe.id, name: recipe.name });
    }
  }
  return found;
}

export function isKnownStructure(hash: string, ctx: ImportContext): boolean {
  return ctx.knownHashes.includes(hash);
}

export type ReviewSummary = {
  recipesNew: number;
  recipesExisting: number;
  itemsNew: number;
  losses: number;
  prices: number;
};

export function summarize(
  review: Review,
  parsed: ParsedWorkbook,
): ReviewSummary {
  const used = usedIngredientNorms(review, parsed);
  const included = review.blocks.filter((block) => block.include);
  const ingredients = review.ingredients.filter((entry) =>
    used.has(entry.norm),
  );
  return {
    recipesNew: included.filter((block) => block.target.mode === 'new').length,
    recipesExisting: included.filter(
      (block) => block.target.mode === 'existing',
    ).length,
    itemsNew: ingredients.filter((entry) => entry.target.type === 'new').length,
    losses: ingredients.filter(
      (entry) => entry.lossApproved && entry.lossFraction !== null,
    ).length,
    prices: ingredients.filter(
      (entry) => entry.target.type === 'new' && entry.price.trim() !== '',
    ).length,
  };
}
