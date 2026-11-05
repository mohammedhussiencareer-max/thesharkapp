import { describe, expect, it } from 'vitest';
import { reduceBindings, type BindingRow } from '@/recipes/import/bindings';
import {
  buildReview,
  disappearedRecipes,
  patchBlock,
  patchIngredient,
  validateReview,
  type ImportContext,
  type Review,
} from '@/recipes/import/model';
import { normalizeName } from '@/recipes/import/normalize';
import { parseRecipeWorkbook } from '@/recipes/import/parse';
import {
  buildImportPayload,
  requiredTokens,
  structuralHash,
  type ImportPayload,
} from '@/recipes/import/payload';
import { importContext, stockItems } from '@/test/import-context';
import {
  sampleNames,
  samplePriceValues,
  sampleWorkbook,
} from '@/test/sample-workbook';

const names = sampleNames();
const parsed = parseRecipeWorkbook(sampleWorkbook());
const hash = 'a'.repeat(64);
const norm = normalizeName;

function blockId(name: string): number {
  return parsed.blocks.find((block) => block.name === name)!.id;
}

function confirmAll(review: Review, ctx: ImportContext): Review {
  let next = review;
  for (const block of review.blocks) {
    next = patchBlock(next, ctx, block.id, { confirmed: true });
  }
  for (const ingredient of review.ingredients) {
    next = patchIngredient(next, ctx, ingredient.norm, { confirmed: true });
  }
  return next;
}

const garlicItem = {
  id: 'item-garlic',
  name: names.garlic,
  kind: 'ingredient' as const,
  baseUnit: 'kg',
  active: true,
};

function setup(typed: boolean) {
  const ctx = importContext({
    stock: [...stockItems, garlicItem],
    itemUnits: [
      ...importContext().itemUnits,
      { itemId: 'item-garlic', unit: 'g', label: 'جرام' },
    ],
    recipes: [
      {
        id: 'rec-dish',
        name: names.dish,
        kind: 'dish',
        active: true,
        inForce: true,
      },
    ],
  });
  let review = confirmAll(buildReview(parsed, ctx), ctx);
  review = patchIngredient(review, ctx, norm(names.tomato), {
    lossApproved: true,
  });
  review = patchIngredient(review, ctx, norm(names.garlic), {
    lossApproved: true,
  });
  if (typed) {
    review = patchIngredient(review, ctx, norm(names.fish), { price: '12.5' });
    review = patchIngredient(review, ctx, norm(names.oil), {
      price: '0',
      priceReason: 'هدية',
    });
  }
  expect(validateReview(review, parsed, ctx).general).toEqual([]);
  const tokens = {
    recipes: new Map([['rec-dish', 'token-dish']]),
    losses: new Map([['item-garlic', 'token-garlic']]),
  };
  const payload = buildImportPayload({
    review,
    parsed,
    hash,
    effectiveFrom: null,
    reason: null,
    tokens,
  });
  return { ctx, review, payload, tokens };
}

function keysOutside(value: unknown, skip: string): string[] {
  const found: string[] = [];
  function walk(node: unknown, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((entry) => walk(entry, path));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) {
        if (path === '' && key === skip) continue;
        found.push(key);
        walk(entry, `${path}/${key}`);
      }
    }
  }
  walk(value, '');
  return found;
}

describe('structuralHash', () => {
  it('is a stable sha-256 of the structure', async () => {
    const first = await structuralHash(parsed);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await structuralHash(parseRecipeWorkbook(sampleWorkbook()))).toBe(
      first,
    );
  });

  it('ignores block order, spacing variants and workbook layout', async () => {
    const first = await structuralHash(parsed);
    const reversed = { ...parsed, blocks: [...parsed.blocks].reverse() };
    expect(await structuralHash(reversed)).toBe(first);
    const inline = parseRecipeWorkbook(sampleWorkbook({ inlineStrings: true }));
    expect(await structuralHash(inline)).toBe(first);
  });

  it('changes with a quantity, a unit, a name or a batch quantity', async () => {
    const first = await structuralHash(parsed);
    const clone = () => structuredClone(parsed);
    const qty = clone();
    qty.blocks[0]!.lines[0]!.qty = '301';
    const name = clone();
    name.blocks[0]!.lines[0]!.norm = 'اسم تاني';
    const batch = clone();
    batch.blocks[2]!.batchQty = '2500';
    const unit = clone();
    unit.blocks[2]!.batchUnit = 'ml';
    const hashes = await Promise.all(
      [qty, name, batch, unit].map((entry) => structuralHash(entry)),
    );
    expect(new Set([first, ...hashes]).size).toBe(5);
  });
});

describe('requiredTokens', () => {
  it('lists the existing recipes and the existing items with an approved loss', () => {
    const { review } = setup(false);
    expect(requiredTokens(review, parsed)).toEqual({
      recipeIds: ['rec-dish'],
      itemIds: ['item-garlic'],
    });
  });
});

describe('buildImportPayload', () => {
  it('sends names, kinds, lines, quantities and units under the approved shape', () => {
    const { payload } = setup(false);
    expect(Object.keys(payload).sort()).toEqual([
      'bindings',
      'effective_from',
      'items',
      'losses',
      'manual_opening_prices',
      'reason',
      'recipes',
      'structural_hash',
    ]);
    expect(payload.structural_hash).toBe(hash);
    expect(payload.effective_from).toBeNull();
    expect(payload.reason).toBeNull();

    expect(payload.items.map((item) => item.name).sort()).toEqual(
      [names.fish, names.oil, names.tomato].sort(),
    );
    expect(payload.items.every((item) => /^i\d+$/.test(item.key))).toBe(true);
    expect(payload.items[0]).toMatchObject({
      kind: 'ingredient',
      base_unit: 'kg',
      count_frequency: 'weekly',
    });
  });

  it('keys recipes, carries tokens for existing ones and nests batches by key', () => {
    const { payload } = setup(false);
    const dish = payload.recipes.find(
      (entry) => entry.key === `r${blockId(names.dish)}`,
    )!;
    expect(dish).toMatchObject({
      kind: 'dish',
      recipe_id: 'rec-dish',
      expected_token: 'token-dish',
    });
    expect(dish).not.toHaveProperty('name');
    expect(dish.lines).toContainEqual({
      recipe_key: `r${blockId(names.sauce)}`,
      quantity: '100',
      unit: 'g',
    });
    expect(dish.lines).toContainEqual({
      stock_item_id: 'item-salt',
      quantity: '5',
      unit: 'g',
    });

    const rice = payload.recipes.find(
      (entry) => entry.key === `r${blockId(names.rice)}`,
    )!;
    expect(rice).toMatchObject({ kind: 'dish', name: names.rice });
    expect(rice).not.toHaveProperty('recipe_id');
    expect(rice).not.toHaveProperty('batch_qty');

    const sauce = payload.recipes.find(
      (entry) => entry.key === `r${blockId(names.sauce)}`,
    )!;
    expect(sauce).toMatchObject({
      kind: 'batch',
      name: names.sauce,
      batch_qty: '2400',
      batch_unit: 'g',
    });
    expect(sauce.lines).toContainEqual({
      stock_item_id: 'item-garlic',
      quantity: '100',
      unit: 'g',
    });
  });

  it('sends approved losses with the item token, or by key for a new item', () => {
    const { payload } = setup(false);
    const tomatoKey = payload.items.find(
      (item) => item.name === names.tomato,
    )!.key;
    expect(payload.losses).toHaveLength(2);
    expect(payload.losses).toContainEqual({
      stock_item_id: 'item-garlic',
      expected_token: 'token-garlic',
      loss_pct: '0.1',
    });
    expect(payload.losses).toContainEqual({
      item_key: tomatoKey,
      loss_pct: '0.2',
    });
  });

  it('sends a price only when the owner typed one, and a reason with a zero', () => {
    const none = setup(false).payload;
    expect(none.manual_opening_prices).toEqual([]);
    expect(JSON.stringify(none)).not.toContain('unit_cost');

    const typed = setup(true).payload;
    const fishKey = typed.items.find((item) => item.name === names.fish)!.key;
    const oilKey = typed.items.find((item) => item.name === names.oil)!.key;
    expect(typed.manual_opening_prices).toHaveLength(2);
    expect(typed.manual_opening_prices).toContainEqual({
      item_key: fishKey,
      unit_cost: '12.5',
    });
    expect(typed.manual_opening_prices).toContainEqual({
      item_key: oilKey,
      unit_cost: '0',
      zero_cost_reason: 'هدية',
    });
  });

  it('binds every source name once, preferring the block over an ingredient of the same name', () => {
    const { payload } = setup(false);
    const sources = payload.bindings.map((binding) => binding.source_name);
    expect(new Set(sources).size).toBe(sources.length);
    expect(payload.bindings).toContainEqual({
      source_name: norm(names.sauce),
      recipe_key: `r${blockId(names.sauce)}`,
      is_block: true,
    });
    expect(payload.bindings).toContainEqual({
      source_name: norm(names.salt),
      stock_item_id: 'item-salt',
    });
    expect(
      payload.bindings.every(
        (binding) =>
          Object.keys(binding).filter(
            (key) => key !== 'source_name' && key !== 'is_block',
          ).length === 1,
      ),
    ).toBe(true);
  });

  it('marks exactly the recipe-title bindings as source blocks', () => {
    const { payload } = setup(false);
    const flagged = payload.bindings
      .filter((binding) => binding.is_block === true)
      .map((binding) => binding.source_name)
      .sort();
    expect(flagged).toEqual(
      [names.dish, names.sauce, names.rice].map(norm).sort(),
    );
    expect(
      payload.bindings.filter((binding) => 'is_block' in binding),
    ).toHaveLength(flagged.length);
  });

  it('never carries a workbook price, a cell position or a formula', () => {
    for (const typed of [false, true]) {
      const { payload } = setup(typed);
      const text = JSON.stringify(payload);
      for (const value of samplePriceValues) {
        const pattern = new RegExp(
          `(?<![\\d.])${String(value).replace('.', '\\.')}(?![\\d])`,
        );
        expect(text).not.toMatch(pattern);
      }
      expect(text).not.toMatch(/SUM\(|!\$?[A-Z]+\$?\d+|[A-Z]\d{2,}/);
      const priceKeys = keysOutside(payload, 'manual_opening_prices').filter(
        (key) => /price|cost|amount/i.test(key),
      );
      expect(priceKeys).toEqual([]);
    }
  });

  it('is deterministic for the same review and tokens', () => {
    const first: ImportPayload = setup(true).payload;
    const second: ImportPayload = setup(true).payload;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('sends workbook grams as grams to a batch measured in kg', () => {
    const ctx = importContext({
      batches: [
        {
          id: 'batch-kg',
          name: names.fish,
          active: true,
          versions: [
            {
              effectiveFrom: '2020-01-01T00:00:00.000Z',
              effectiveTo: null,
              unit: 'kg',
            },
          ],
        },
      ],
    });
    const review = confirmAll(buildReview(parsed, ctx), ctx);
    expect(validateReview(review, parsed, ctx).general).toEqual([]);
    const payload = buildImportPayload({
      review,
      parsed,
      hash,
      effectiveFrom: null,
      reason: null,
      tokens: {
        recipes: new Map(),
        losses: new Map(),
      },
    });
    const dish = payload.recipes.find(
      (recipe) => recipe.key === `r${blockId(names.dish)}`,
    );
    expect(dish?.lines).toContainEqual({
      child_recipe_id: 'batch-kg',
      quantity: '300',
      unit: 'g',
    });
  });

  it('sends the parent line in the unit of the batch version it is published with', () => {
    const sauceSource = norm(names.sauce);
    const bound = { source: sauceSource, recipeId: 'rec-sauce' };
    const ctx = importContext({
      recipes: [
        {
          id: 'rec-sauce',
          name: names.sauce,
          kind: 'batch',
          active: true,
          inForce: true,
        },
      ],
      batches: [
        {
          id: 'rec-sauce',
          name: names.sauce,
          active: true,
          versions: [
            {
              effectiveFrom: '2020-01-01T00:00:00.000Z',
              effectiveTo: null,
              unit: 'g',
            },
          ],
        },
      ],
      bindings: [{ ...bound, stockItemId: null }],
      blockBindings: [{ ...bound, stockItemId: null }],
    });
    let review = buildReview(parsed, ctx);
    review = patchBlock(review, ctx, blockId(names.sauce), { batchUnit: 'ml' });
    review = confirmAll(review, ctx);
    expect(validateReview(review, parsed, ctx).general).toEqual([]);
    const payload = buildImportPayload({
      review,
      parsed,
      hash,
      effectiveFrom: null,
      reason: null,
      tokens: {
        recipes: new Map([['rec-sauce', 'token-sauce']]),
        losses: new Map(),
      },
    });
    const dish = payload.recipes.find(
      (recipe) => recipe.key === `r${blockId(names.dish)}`,
    );
    expect(dish?.lines).toContainEqual({
      child_recipe_id: 'rec-sauce',
      quantity: '100',
      unit: 'ml',
    });
    expect(
      payload.recipes.find((recipe) => recipe.recipe_id === 'rec-sauce'),
    ).toMatchObject({ kind: 'batch', batch_unit: 'ml' });
  });
});

describe('block provenance across three imports', () => {
  const ids: Record<string, string> = {
    [`r${blockId(names.dish)}`]: 'rec-dish',
    [`r${blockId(names.rice)}`]: 'rec-rice',
    [`r${blockId(names.sauce)}`]: 'rec-sauce',
  };
  const recipes: ImportContext['recipes'] = [
    {
      id: 'rec-dish',
      name: names.dish,
      kind: 'dish',
      active: true,
      inForce: true,
    },
    {
      id: 'rec-rice',
      name: names.rice,
      kind: 'dish',
      active: true,
      inForce: true,
    },
    {
      id: 'rec-sauce',
      name: names.sauce,
      kind: 'batch',
      active: true,
      inForce: true,
    },
  ];
  const batches: ImportContext['batches'] = [
    {
      id: 'rec-sauce',
      name: names.sauce,
      active: true,
      versions: [
        {
          effectiveFrom: '2020-01-01T00:00:00.000Z',
          effectiveTo: null,
          unit: 'g',
        },
      ],
    },
  ];

  function rowsOf(payload: ImportPayload, created: string): BindingRow[] {
    return payload.bindings.map((binding, index) => ({
      id: `${created}-${String(index).padStart(3, '0')}`,
      source_name: binding.source_name,
      recipe_id:
        binding.recipe_id ??
        (binding.recipe_key ? (ids[binding.recipe_key] ?? null) : null),
      stock_item_id: binding.stock_item_id ?? null,
      is_block: binding.is_block ?? false,
      created_at: created,
    }));
  }

  function importOnce(
    ctx: ImportContext,
    tokens: string[],
    leaveOut: string[] = [],
  ): ImportPayload {
    let review = confirmAll(buildReview(parsed, ctx), ctx);
    for (const name of leaveOut) {
      review = patchBlock(review, ctx, blockId(name), { include: false });
    }
    expect(validateReview(review, parsed, ctx).general).toEqual([]);
    return buildImportPayload({
      review,
      parsed,
      hash,
      effectiveFrom: null,
      reason: null,
      tokens: {
        recipes: new Map(tokens.map((id) => [id, `token-${id}`])),
        losses: new Map(),
      },
    });
  }

  it('still reports a block that a later import only referenced as an ingredient', () => {
    const first = importOnce(importContext(), []);
    const rows1 = rowsOf(first, '2026-11-01T10:00:00.000Z');
    expect(
      rows1.filter((row) => row.is_block).map((row) => row.recipe_id),
    ).toEqual(expect.arrayContaining(['rec-dish', 'rec-sauce']));

    const ctx2 = importContext({ recipes, batches, ...reduceBindings(rows1) });
    expect(disappearedRecipes(parsed, ctx2)).toEqual([]);
    const second = importOnce(ctx2, ['rec-dish', 'rec-rice'], [names.sauce]);
    const sauceBinding = second.bindings.find(
      (binding) => binding.source_name === norm(names.sauce),
    );
    expect(sauceBinding).toEqual({
      source_name: norm(names.sauce),
      recipe_id: 'rec-sauce',
    });
    const rows2 = rowsOf(second, '2026-11-02T10:00:00.000Z');
    expect(
      rows2.find((row) => row.source_name === norm(names.sauce)),
    ).toMatchObject({ recipe_id: 'rec-sauce', is_block: false });

    const gone = {
      ...parsed,
      blocks: parsed.blocks.filter((block) => block.name !== names.sauce),
    };
    const ctx3 = importContext({
      recipes,
      batches,
      ...reduceBindings([...rows2, ...rows1]),
    });
    expect(
      ctx3.bindings.find((binding) => binding.source === norm(names.sauce)),
    ).toMatchObject({ recipeId: 'rec-sauce' });
    expect(disappearedRecipes(gone, ctx3)).toEqual([
      { id: 'rec-sauce', name: names.sauce },
    ]);
  });
});
