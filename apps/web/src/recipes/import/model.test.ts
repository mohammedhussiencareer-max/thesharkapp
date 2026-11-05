import { describe, expect, it } from 'vitest';
import { normalizeName } from '@/recipes/import/normalize';
import {
  buildReview,
  confirmSuggestions,
  disappearedRecipes,
  guessKinds,
  isKnownStructure,
  issueCount,
  patchBlock,
  patchIngredient,
  patchNewItem,
  retargetBlock,
  retargetIngredient,
  summarize,
  usedIngredientNorms,
  validateReview,
  type ImportContext,
  type Review,
} from '@/recipes/import/model';
import {
  parseRecipeWorkbook,
  type ParsedBlock,
  type ParsedWorkbook,
} from '@/recipes/import/parse';
import type { StockOption } from '@/recipes/types';
import { importContext, stockItems } from '@/test/import-context';
import { sampleNames, sampleWorkbook } from '@/test/sample-workbook';

const names = sampleNames();
const parsed = parseRecipeWorkbook(sampleWorkbook());

const inactiveGarlic: StockOption = {
  id: 'item-garlic-old',
  name: names.garlic,
  kind: 'ingredient',
  baseUnit: 'kg',
  active: false,
};

function blockOf(review: Review, name: string) {
  const source = parsed.blocks.find((block) => block.name === name)!;
  return review.blocks.find((block) => block.id === source.id)!;
}

function ingredientOf(review: Review, name: string) {
  return review.ingredients.find(
    (ingredient) => ingredient.norm === normalizeName(name),
  )!;
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

function manual(
  blocks: [number, string, string[]][],
  extra: Partial<ParsedWorkbook> = {},
): ParsedWorkbook {
  const list: ParsedBlock[] = blocks.map(([id, name, lines]) => ({
    id,
    name,
    norm: normalizeName(name),
    lines: lines.map((line) => ({
      name: line,
      norm: normalizeName(line),
      qty: '1',
      unit: null,
    })),
    batchQty: '100',
    batchUnit: 'g',
    paddingRows: 0,
    emptyRows: 0,
    skippedRows: 0,
  }));
  return {
    blocks: list,
    losses: [],
    batchNames: [],
    packagingNames: [],
    menuLinks: [],
    warnings: [],
    sheets: { recipes: true, loss: false, menu: false },
    ...extra,
  };
}

describe('guessKinds', () => {
  it('calls a block a batch from a net row, a batch-list entry, or a use as an ingredient', () => {
    const kinds = guessKinds(parsed);
    const id = (name: string) =>
      parsed.blocks.find((block) => block.name === name)!.id;
    expect(kinds.get(id(names.sauce))).toBe('batch');
    expect(kinds.get(id(names.dish))).toBe('dish');
    expect(kinds.get(id(names.rice))).toBe('dish');

    const listed = manual([[1, 'قاعدة', ['ملح']]], { batchNames: ['قاعدة'] });
    listed.blocks[0]!.batchQty = null;
    expect(guessKinds(listed).get(1)).toBe('batch');

    const used = manual([
      [1, 'أساس', ['ملح']],
      [2, 'طبق', ['أساس']],
    ]);
    used.blocks[0]!.batchQty = null;
    used.blocks[1]!.batchQty = null;
    expect(guessKinds(used).get(1)).toBe('batch');
    expect(guessKinds(used).get(2)).toBe('dish');
  });
});

describe('buildReview suggestions', () => {
  it('suggests an existing item by normalised name and leaves every row unconfirmed', () => {
    const review = buildReview(parsed, importContext());
    const salt = ingredientOf(review, names.salt);
    expect(salt.target).toEqual({ type: 'item', itemId: 'item-salt' });
    expect(salt.matched).toBe('name');
    const rice = ingredientOf(review, names.riceRaw);
    expect(rice.target).toEqual({ type: 'item', itemId: 'item-rice' });
    expect(review.ingredients.every((entry) => !entry.confirmed)).toBe(true);
    expect(review.blocks.every((entry) => !entry.confirmed)).toBe(true);
  });

  it('never suggests an inactive item, a packaging item or a cooking recipe', () => {
    const ctx = importContext({
      stock: [...stockItems, inactiveGarlic],
      recipes: [
        {
          id: 'cook',
          name: names.dish,
          kind: 'cooking',
          active: true,
          inForce: true,
        },
      ],
    });
    const review = buildReview(parsed, ctx);
    expect(ingredientOf(review, names.garlic).target).toEqual({ type: 'new' });
    expect(blockOf(review, names.dish).target.mode).toBe('new');
    const box = buildReview(
      manual([[1, 'طبق', ['علبة']]], { packagingNames: ['علبة'] }),
      ctx,
    );
    expect(box.ingredients[0]?.target).toEqual({ type: 'new' });
  });

  it('suggests an existing recipe by name and takes its kind', () => {
    const ctx = importContext({
      recipes: [
        {
          id: 'rec-dish',
          name: names.dish,
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
      ],
    });
    const review = buildReview(parsed, ctx);
    expect(blockOf(review, names.dish)).toMatchObject({
      target: { mode: 'existing', recipeId: 'rec-dish' },
      matched: 'name',
      kind: 'dish',
      confirmed: false,
    });
    expect(blockOf(review, names.sauce)).toMatchObject({
      target: { mode: 'existing', recipeId: 'rec-sauce' },
      kind: 'batch',
    });
  });

  it('points an ingredient named like a block at that block', () => {
    const review = buildReview(parsed, importContext());
    const sauce = ingredientOf(review, names.sauce);
    expect(sauce.matched).toBe('block');
    expect(sauce.target).toEqual({
      type: 'block',
      blockId: blockOf(review, names.sauce).id,
    });
  });

  it('prefers a binding from an earlier import over a name match', () => {
    const ctx = importContext({
      bindings: [
        {
          source: normalizeName(names.salt),
          recipeId: null,
          stockItemId: 'item-rice',
        },
      ],
    });
    const salt = ingredientOf(buildReview(parsed, ctx), names.salt);
    expect(salt.target).toEqual({ type: 'item', itemId: 'item-rice' });
    expect(salt.matched).toBe('binding');
    expect(salt.confirmed).toBe(false);
  });

  it('defaults the unit to grams and a nested batch to its own unit', () => {
    const review = buildReview(parsed, importContext());
    expect(ingredientOf(review, names.salt).unit).toBe('g');
    expect(ingredientOf(review, names.fish).unit).toBe('g');
    expect(ingredientOf(review, names.sauce).unit).toBe('g');
    expect(blockOf(review, names.sauce)).toMatchObject({
      batchQty: '2400',
      batchUnit: 'g',
    });
  });

  it('carries the loss ratio as a suggestion that starts unapproved', () => {
    const review = buildReview(parsed, importContext());
    const tomato = ingredientOf(review, names.tomato);
    expect(tomato.lossFraction).toBe('0.2');
    expect(tomato.lossApproved).toBe(false);
    expect(ingredientOf(review, names.fish).lossFraction).toBeNull();
  });
});

describe('review edits', () => {
  it('confirms only rows that have a suggestion', () => {
    const review = confirmSuggestions(buildReview(parsed, importContext()));
    expect(ingredientOf(review, names.salt).confirmed).toBe(true);
    expect(ingredientOf(review, names.fish).confirmed).toBe(false);
    expect(blockOf(review, names.dish).confirmed).toBe(false);
  });

  it('confirms a row the owner re-targets and re-picks the unit', () => {
    const ctx = importContext();
    const review = retargetIngredient(
      buildReview(parsed, ctx),
      ctx,
      normalizeName(names.fish),
      { type: 'item', itemId: 'item-salt' },
    );
    expect(ingredientOf(review, names.fish)).toMatchObject({
      target: { type: 'item', itemId: 'item-salt' },
      confirmed: true,
      matched: 'none',
      unit: 'g',
    });
  });

  it('creates a new item with its kind and base unit', () => {
    const ctx = importContext();
    let review = retargetIngredient(
      buildReview(parsed, ctx),
      ctx,
      normalizeName(names.salt),
      { type: 'new' },
    );
    review = patchNewItem(review, ctx, normalizeName(names.salt), {
      kind: 'seafood',
    });
    expect(ingredientOf(review, names.salt).newItem).toMatchObject({
      kind: 'seafood',
      baseUnit: 'kg',
    });
    review = patchNewItem(review, ctx, normalizeName(names.salt), {
      baseUnit: 'liter',
    });
    expect(ingredientOf(review, names.salt).unit).toBe('ml');
  });

  it('confirms a re-picked recipe and takes its kind', () => {
    const ctx = importContext({
      recipes: [
        {
          id: 'rec-sauce',
          name: 'صلصة قديمة',
          kind: 'batch',
          active: true,
          inForce: true,
        },
      ],
    });
    const review = retargetBlock(
      buildReview(parsed, ctx),
      ctx,
      blockOf(buildReview(parsed, ctx), names.rice).id,
      { mode: 'existing', recipeId: 'rec-sauce' },
    );
    expect(blockOf(review, names.rice)).toMatchObject({
      confirmed: true,
      kind: 'batch',
      target: { mode: 'existing', recipeId: 'rec-sauce' },
    });
  });

  it('drops the ingredients of a block that is left out', () => {
    const ctx = importContext();
    let review = buildReview(parsed, ctx);
    for (const name of [names.dish, names.sauce]) {
      review = patchBlock(review, ctx, blockOf(review, name).id, {
        include: false,
      });
    }
    expect([...usedIngredientNorms(review, parsed)].sort()).toEqual(
      [names.riceRaw, names.salt].map(normalizeName).sort(),
    );
    expect(summarize(review, parsed)).toMatchObject({
      recipesNew: 1,
      itemsNew: 0,
    });
  });
});

describe('validateReview', () => {
  it('asks for a confirmation on every included row, then passes', () => {
    const ctx = importContext();
    const review = buildReview(parsed, ctx);
    const first = validateReview(review, parsed, ctx);
    expect(first.blocks.size).toBe(3);
    expect(first.ingredients.size).toBe(review.ingredients.length);
    const done = validateReview(confirmAll(review, ctx), parsed, ctx);
    expect(issueCount(done)).toBe(0);
  });

  it('refuses an empty selection', () => {
    const ctx = importContext();
    let review = buildReview(parsed, ctx);
    for (const block of review.blocks) {
      review = patchBlock(review, ctx, block.id, { include: false });
    }
    expect(validateReview(review, parsed, ctx).general).toHaveLength(1);
  });

  it('flags a new name that already exists as an item or a recipe', () => {
    const ctx = importContext({
      stock: [...stockItems, inactiveGarlic],
      recipes: [
        {
          id: 'rec-other',
          name: names.rice,
          kind: 'dish',
          active: true,
          inForce: true,
        },
      ],
    });
    let review = confirmAll(buildReview(parsed, ctx), ctx);
    review = patchBlock(review, ctx, blockOf(review, names.rice).id, {
      target: { mode: 'new', name: names.rice },
    });
    const issues = validateReview(review, parsed, ctx);
    expect(issues.blocks.get(blockOf(review, names.rice).id)).toEqual([
      'في وصفة بنفس الاسم، اختارها أو غيّر الاسم',
    ]);
    expect(issues.ingredients.get(normalizeName(names.garlic))).toEqual([
      'في صنف بنفس الاسم، اختاره أو غيّر الاسم',
    ]);
  });

  it('flags two new items or two new recipes with the same name', () => {
    const ctx = importContext();
    let review = confirmAll(buildReview(parsed, ctx), ctx);
    review = patchNewItem(review, ctx, normalizeName(names.fish), {
      name: 'صنف',
    });
    review = patchNewItem(review, ctx, normalizeName(names.oil), {
      name: 'صنف',
    });
    review = patchBlock(review, ctx, blockOf(review, names.rice).id, {
      target: { mode: 'new', name: names.dish },
    });
    const issues = validateReview(review, parsed, ctx);
    expect(issues.ingredients.get(normalizeName(names.fish))).toContain(
      'اسم الصنف متكرر في الاستيراد',
    );
    expect(issues.ingredients.get(normalizeName(names.oil))).toContain(
      'اسم الصنف متكرر في الاستيراد',
    );
    expect(issues.blocks.get(blockOf(review, names.rice).id)).toContain(
      'اسم الوصفة متكرر في الاستيراد',
    );
  });

  it('needs a quantity and a unit for a batch', () => {
    const ctx = importContext();
    let review = confirmAll(buildReview(parsed, ctx), ctx);
    const id = blockOf(review, names.sauce).id;
    review = patchBlock(review, ctx, id, { batchQty: '', batchUnit: '' });
    expect(validateReview(review, parsed, ctx).blocks.get(id)).toEqual([
      'اكتب كمية التحضيرة (رقم أكبر من صفر)',
      'اختار وحدة التحضيرة',
    ]);
    review = patchBlock(review, ctx, id, { batchQty: '0', batchUnit: 'g' });
    expect(validateReview(review, parsed, ctx).blocks.get(id)).toEqual([
      'اكتب كمية التحضيرة (رقم أكبر من صفر)',
    ]);
  });

  it('refuses a dish used as an ingredient and a packaging name', () => {
    const ctx = importContext();
    let review = confirmAll(buildReview(parsed, ctx), ctx);
    review = patchBlock(review, ctx, blockOf(review, names.sauce).id, {
      kind: 'dish',
    });
    const issues = validateReview(review, parsed, ctx);
    expect(issues.ingredients.get(normalizeName(names.sauce))).toContain(
      'المكوّن اللي هو وصفة لازم يكون تحضيرة',
    );
    const packed = validateReview(
      confirmAll(buildReview(parsed, ctx), ctx),
      { ...parsed, packagingNames: [names.salt] },
      ctx,
    );
    expect(packed.ingredients.get(normalizeName(names.salt))).toContain(
      'الاسم ده في قايمة التغليف، والتغليف مش مكوّن',
    );
  });

  it('finds a cycle between two blocks', () => {
    const cyclic = manual([
      [1, 'أول', ['ثاني']],
      [2, 'ثاني', ['أول']],
    ]);
    const ctx = importContext();
    const review = confirmAll(buildReview(cyclic, ctx), ctx);
    const issues = validateReview(review, cyclic, ctx);
    expect(issues.blocks.get(1)).toContain(
      'الوصفة بتدخل في دايرة وبتستخدم نفسها',
    );
    expect(issues.blocks.get(2)).toContain(
      'الوصفة بتدخل في دايرة وبتستخدم نفسها',
    );
  });

  it('keeps a loss approval to a ratio that exists and to items', () => {
    const ctx = importContext();
    let review = confirmAll(buildReview(parsed, ctx), ctx);
    review = patchIngredient(review, ctx, normalizeName(names.tomato), {
      lossApproved: true,
    });
    expect(issueCount(validateReview(review, parsed, ctx))).toBe(0);
    expect(summarize(review, parsed).losses).toBe(1);

    review = patchIngredient(review, ctx, normalizeName(names.fish), {
      lossApproved: true,
    });
    expect(
      validateReview(review, parsed, ctx).ingredients.get(
        normalizeName(names.fish),
      ),
    ).toEqual(['مفيش نسبة فاقد في الملف للمكوّن ده']);

    review = patchIngredient(review, ctx, normalizeName(names.fish), {
      lossApproved: false,
    });
    review = patchIngredient(review, ctx, normalizeName(names.sauce), {
      lossApproved: true,
      lossFraction: '0.1',
    });
    expect(
      validateReview(review, parsed, ctx).ingredients.get(
        normalizeName(names.sauce),
      ),
    ).toEqual(['الفاقد للأصناف بس']);
  });

  it('takes an opening price only for a new item, and a zero needs a reason', () => {
    const ctx = importContext();
    let review = confirmAll(buildReview(parsed, ctx), ctx);
    const fish = normalizeName(names.fish);
    review = patchIngredient(review, ctx, fish, { price: '12.5' });
    expect(issueCount(validateReview(review, parsed, ctx))).toBe(0);
    expect(summarize(review, parsed).prices).toBe(1);

    review = patchIngredient(review, ctx, fish, { price: '0' });
    expect(validateReview(review, parsed, ctx).ingredients.get(fish)).toEqual([
      'اكتب سبب إن السعر صفر',
    ]);
    review = patchIngredient(review, ctx, fish, { priceReason: 'هدية' });
    expect(issueCount(validateReview(review, parsed, ctx))).toBe(0);

    review = patchIngredient(review, ctx, fish, { price: 'abc' });
    expect(
      validateReview(review, parsed, ctx).ingredients.get(fish),
    ).toHaveLength(1);

    review = patchIngredient(review, ctx, normalizeName(names.salt), {
      price: '3',
    });
    expect(
      validateReview(review, parsed, ctx).ingredients.get(
        normalizeName(names.salt),
      ),
    ).toEqual(['السعر الافتتاحي للأصناف الجديدة بس']);
  });
});

describe('re-import helpers', () => {
  it('lists active recipes of an earlier import that the file no longer has', () => {
    const ctx = importContext({
      recipes: [
        {
          id: 'rec-old',
          name: 'سمك قديم',
          kind: 'dish',
          active: true,
          inForce: true,
        },
        {
          id: 'rec-stopped',
          name: 'وصفة موقوفة',
          kind: 'dish',
          active: false,
          inForce: false,
        },
        {
          id: 'rec-dish',
          name: names.dish,
          kind: 'dish',
          active: true,
          inForce: true,
        },
      ],
      bindings: [
        { source: 'سمك قديم', recipeId: 'rec-old', stockItemId: null },
        { source: 'وصفة موقوفة', recipeId: 'rec-stopped', stockItemId: null },
        {
          source: normalizeName(names.dish),
          recipeId: 'rec-dish',
          stockItemId: null,
        },
        { source: 'ملح', recipeId: null, stockItemId: 'item-salt' },
      ],
    });
    expect(disappearedRecipes(parsed, ctx)).toEqual([
      { id: 'rec-old', name: 'سمك قديم' },
    ]);
  });

  it('knows a structure it has imported before', () => {
    const ctx = importContext({ knownHashes: ['a'.repeat(64)] });
    expect(isKnownStructure('a'.repeat(64), ctx)).toBe(true);
    expect(isKnownStructure('b'.repeat(64), ctx)).toBe(false);
  });
});
