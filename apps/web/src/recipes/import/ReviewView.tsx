import { useState } from 'react';
import { kindLabels, unitLabels } from '@/items/labels';
import { baseUnits, type BaseUnit } from '@/items/types';
import { normalizeDecimal } from '@/items/validation';
import { secondaryButton } from '@/lib/page-style';
import { recipeKindLabels } from '@/recipes/labels';
import {
  candidateItems,
  candidateRecipes,
  ingredientChoices,
  patchBlock,
  patchIngredient,
  patchNewItem,
  retargetBlock,
  retargetIngredient,
  usedIngredientNorms,
  type BlockReview,
  type ImportContext,
  type ImportKind,
  type IngredientReview,
  type IngredientTarget,
  type NewItemKind,
  type Review,
  type ReviewIssues,
} from '@/recipes/import/model';
import { collapseSpaces } from '@/recipes/import/normalize';
import type { ParsedLine, ParsedWorkbook } from '@/recipes/import/parse';

const fieldClass = 'w-full rounded border border-neutral-300 px-3 py-2';
const rowClass = 'flex flex-col gap-2 rounded border border-neutral-200 p-3';

function percentText(fraction: string): string {
  return `${Number((Number(fraction) * 100).toFixed(3))}%`;
}

function Issues({ messages }: { messages: readonly string[] | undefined }) {
  if (!messages || messages.length === 0) return null;
  return (
    <ul className="text-sm text-red-700">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function isNewItemKind(value: string): value is NewItemKind {
  return value === 'ingredient' || value === 'seafood';
}

function isBaseUnit(value: string): value is BaseUnit {
  return (baseUnits as readonly string[]).includes(value);
}

function isImportKind(value: string): value is ImportKind {
  return value === 'dish' || value === 'batch';
}

function parseTargetValue(value: string): IngredientTarget | null {
  const [type, ...rest] = value.split(':');
  const id = rest.join(':');
  if (id.length === 0) return null;
  if (type === 'item') return { type: 'item', itemId: id };
  if (type === 'recipe') return { type: 'recipe', recipeId: id };
  if (type === 'block' && /^\d+$/.test(id)) {
    return { type: 'block', blockId: Number(id) };
  }
  return null;
}

export function ReviewView({
  parsed,
  review,
  ctx,
  issues,
  disabled,
  onChange,
}: {
  parsed: ParsedWorkbook;
  review: Review;
  ctx: ImportContext;
  issues: ReviewIssues;
  disabled: boolean;
  onChange: (next: Review) => void;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const used = usedIngredientNorms(review, parsed);
  const ingredients = review.ingredients.filter((entry) =>
    used.has(entry.norm),
  );
  const items = candidateItems(ctx);
  const recipes = candidateRecipes(ctx);
  const unitName = (code: string) =>
    ctx.units.find((unit) => unit.code === code)?.labelAr ?? code;

  function blockName(id: number): string {
    return parsed.blocks.find((block) => block.id === id)?.name ?? '';
  }

  function ingredientTargetLabel(entry: IngredientReview): string {
    const { target } = entry;
    if (target.type === 'item') {
      return ctx.stock.find((item) => item.id === target.itemId)?.name ?? 'صنف';
    }
    if (target.type === 'recipe') {
      return (
        ctx.batches.find((batch) => batch.id === target.recipeId)?.name ??
        'تحضيرة'
      );
    }
    if (target.type === 'block')
      return `${blockName(target.blockId)} (من الملف)`;
    return 'صنف جديد';
  }

  function lineText(line: ParsedLine): string {
    const entry = review.ingredients.find((item) => item.norm === line.norm);
    const quantity = normalizeDecimal(line.qty) ?? line.qty;
    const code = line.unit ?? entry?.unit ?? '';
    const unit = code === '' ? 'من غير وحدة' : unitName(code);
    const target = entry ? ingredientTargetLabel(entry) : 'مش متحدد';
    return `${entry?.name ?? collapseSpaces(line.name)}: ${quantity} ${unit} ← ${target}`;
  }

  function recipeTargetLabel(block: BlockReview): string {
    if (block.target.mode === 'new') return 'وصفة جديدة';
    const { recipeId } = block.target;
    return ctx.recipes.find((recipe) => recipe.id === recipeId)?.name ?? 'وصفة';
  }

  function renderBlock(block: BlockReview) {
    const source = parsed.blocks.find((entry) => entry.id === block.id);
    if (!source) return null;
    const key = `block:${block.id}`;
    const existing = block.target.mode === 'existing';
    const menuNames = parsed.menuLinks
      .filter((link) => link.blockId === block.id)
      .map((link) => link.menuName);
    return (
      <li
        key={block.id}
        className={rowClass}
        aria-label={`وصفة ${source.name}`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={disabled || source.lines.length === 0}
              checked={block.include}
              onChange={(event) =>
                onChange(
                  patchBlock(review, ctx, block.id, {
                    include: event.target.checked,
                  }),
                )
              }
            />
            <span>استورد {source.name}</span>
          </label>
          <span className="text-sm text-neutral-600">
            {source.lines.length} مكوّن
          </span>
        </div>
        {menuNames.length > 0 ? (
          <p className="text-sm text-neutral-600">
            في المنيو: {menuNames.join('، ')}
          </p>
        ) : null}
        {source.lines.length > 0 ? (
          <ul
            className="flex flex-col gap-1 text-sm"
            aria-label={`تركيب ${source.name}`}
          >
            {source.lines.map((line, index) => (
              <li key={`${line.norm}:${index}`}>{lineText(line)}</li>
            ))}
          </ul>
        ) : null}
        {block.include ? (
          <>
            <p>
              {block.matched === 'none'
                ? 'الاختيار'
                : block.matched === 'binding'
                  ? 'مقترح من استيراد قبل كده'
                  : 'مقترح بنفس الاسم'}
              : {recipeTargetLabel(block)}{' '}
              {block.confirmed ? '— متأكد' : '— لسه مش متأكد'}
            </p>
            {block.target.mode === 'new' ? (
              <label className="flex flex-col gap-1">
                اسم الوصفة الجديدة لـ {source.name}
                <input
                  className={fieldClass}
                  disabled={disabled}
                  value={block.target.name}
                  onChange={(event) =>
                    onChange(
                      patchBlock(review, ctx, block.id, {
                        target: { mode: 'new', name: event.target.value },
                      }),
                    )
                  }
                />
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              نوع الوصفة {source.name}
              <select
                className={fieldClass}
                disabled={disabled || existing}
                value={block.kind}
                onChange={(event) => {
                  if (!isImportKind(event.target.value)) return;
                  onChange(
                    patchBlock(review, ctx, block.id, {
                      kind: event.target.value,
                      batchUnit:
                        event.target.value === 'batch' && block.batchUnit === ''
                          ? 'g'
                          : block.batchUnit,
                    }),
                  );
                }}
              >
                <option value="dish">{recipeKindLabels.dish}</option>
                <option value="batch">{recipeKindLabels.batch}</option>
              </select>
            </label>
            {block.kind === 'batch' ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  كمية التحضيرة {source.name}
                  <input
                    className={fieldClass}
                    dir="ltr"
                    inputMode="decimal"
                    disabled={disabled}
                    value={block.batchQty}
                    onChange={(event) =>
                      onChange(
                        patchBlock(review, ctx, block.id, {
                          batchQty: event.target.value,
                        }),
                      )
                    }
                  />
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  وحدة التحضيرة {source.name}
                  <select
                    className={fieldClass}
                    disabled={disabled}
                    value={block.batchUnit}
                    onChange={(event) =>
                      onChange(
                        patchBlock(review, ctx, block.id, {
                          batchUnit: event.target.value,
                        }),
                      )
                    }
                  >
                    <option value="">اختار الوحدة</option>
                    {ctx.units
                      .filter((unit) => unit.metricScale !== null)
                      .map((unit) => (
                        <option key={unit.code} value={unit.code}>
                          {unit.labelAr}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                className={secondaryButton}
                type="button"
                disabled={disabled || block.confirmed}
                onClick={() =>
                  onChange(
                    patchBlock(review, ctx, block.id, { confirmed: true }),
                  )
                }
              >
                أكّد الوصفة {source.name}
              </button>
              <button
                className={secondaryButton}
                type="button"
                disabled={disabled}
                onClick={() => setPicking(picking === key ? null : key)}
              >
                اختار وصفة موجودة لـ {source.name}
              </button>
              {existing ? (
                <button
                  className={secondaryButton}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      retargetBlock(review, ctx, block.id, {
                        mode: 'new',
                        name: source.name,
                      }),
                    )
                  }
                >
                  اعمل وصفة جديدة بدل {source.name}
                </button>
              ) : null}
            </div>
            {picking === key ? (
              <label className="flex flex-col gap-1">
                الوصفة الموجودة لـ {source.name}
                <select
                  className={fieldClass}
                  disabled={disabled}
                  value=""
                  onChange={(event) => {
                    if (event.target.value === '') return;
                    onChange(
                      retargetBlock(review, ctx, block.id, {
                        mode: 'existing',
                        recipeId: event.target.value,
                      }),
                    );
                    setPicking(null);
                  }}
                >
                  <option value="">اختار وصفة</option>
                  {recipes.map((recipe) => (
                    <option key={recipe.id} value={recipe.id}>
                      {recipe.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        ) : null}
        <Issues messages={issues.blocks.get(block.id)} />
      </li>
    );
  }

  function renderIngredient(entry: IngredientReview) {
    const key = `ingredient:${entry.norm}`;
    const choices = ingredientChoices(entry, review, ctx);
    const isNew = entry.target.type === 'new';
    const base = isNew
      ? entry.newItem.baseUnit
      : entry.target.type === 'item'
        ? ctx.stock.find(
            (item) =>
              entry.target.type === 'item' && item.id === entry.target.itemId,
          )?.baseUnit
        : undefined;
    return (
      <li
        key={entry.norm}
        className={rowClass}
        aria-label={`مكوّن ${entry.name}`}
      >
        <p className="font-semibold">
          {entry.name}{' '}
          <span className="text-sm font-normal text-neutral-600">
            ({entry.uses} مرة)
          </span>
        </p>
        <p>
          {entry.matched === 'none'
            ? 'الاختيار'
            : entry.matched === 'binding'
              ? 'مقترح من استيراد قبل كده'
              : entry.matched === 'block'
                ? 'مقترح: وصفة بنفس الاسم في الملف'
                : 'مقترح بنفس الاسم'}
          : {ingredientTargetLabel(entry)}{' '}
          {entry.confirmed ? '— متأكد' : '— لسه مش متأكد'}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className={secondaryButton}
            type="button"
            disabled={disabled || entry.confirmed}
            onClick={() =>
              onChange(
                patchIngredient(review, ctx, entry.norm, { confirmed: true }),
              )
            }
          >
            أكّد {entry.name}
          </button>
          <button
            className={secondaryButton}
            type="button"
            disabled={disabled}
            onClick={() => setPicking(picking === key ? null : key)}
          >
            اختار غيره لـ {entry.name}
          </button>
          {isNew ? null : (
            <button
              className={secondaryButton}
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange(
                  retargetIngredient(review, ctx, entry.norm, { type: 'new' }),
                )
              }
            >
              اعمل صنف جديد بدل {entry.name}
            </button>
          )}
        </div>
        {picking === key ? (
          <label className="flex flex-col gap-1">
            الاختيار لـ {entry.name}
            <select
              className={fieldClass}
              disabled={disabled}
              value=""
              onChange={(event) => {
                const target = parseTargetValue(event.target.value);
                if (!target) return;
                onChange(retargetIngredient(review, ctx, entry.norm, target));
                setPicking(null);
              }}
            >
              <option value="">اختار</option>
              <optgroup label="أصناف">
                {items.map((item) => (
                  <option key={item.id} value={`item:${item.id}`}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="تحضيرات موجودة">
                {ctx.batches
                  .filter((batch) => batch.active)
                  .map((batch) => (
                    <option key={batch.id} value={`recipe:${batch.id}`}>
                      {batch.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="تحضيرات من الملف">
                {review.blocks
                  .filter((block) => block.include && block.kind === 'batch')
                  .map((block) => (
                    <option key={block.id} value={`block:${block.id}`}>
                      {blockName(block.id)}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
        ) : null}
        {isNew ? (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              اسم الصنف الجديد لـ {entry.name}
              <input
                className={fieldClass}
                disabled={disabled}
                value={entry.newItem.name}
                onChange={(event) =>
                  onChange(
                    patchNewItem(review, ctx, entry.norm, {
                      name: event.target.value,
                    }),
                  )
                }
              />
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                نوع الصنف {entry.name}
                <select
                  className={fieldClass}
                  disabled={disabled}
                  value={entry.newItem.kind}
                  onChange={(event) => {
                    if (!isNewItemKind(event.target.value)) return;
                    onChange(
                      patchNewItem(review, ctx, entry.norm, {
                        kind: event.target.value,
                        baseUnit: entry.newItem.baseUnit,
                      }),
                    );
                  }}
                >
                  <option value="ingredient">{kindLabels.ingredient}</option>
                  <option value="seafood">{kindLabels.seafood}</option>
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                الوحدة الأساسية {entry.name}
                <select
                  className={fieldClass}
                  disabled={disabled}
                  value={entry.newItem.baseUnit}
                  onChange={(event) => {
                    if (!isBaseUnit(event.target.value)) return;
                    onChange(
                      patchNewItem(review, ctx, entry.norm, {
                        baseUnit: event.target.value,
                      }),
                    );
                  }}
                >
                  {baseUnits.map((unit) => (
                    <option key={unit} value={unit}>
                      {unitLabels[unit]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : null}
        <label className="flex flex-col gap-1">
          وحدة الكميات {entry.name}
          <select
            className={fieldClass}
            disabled={disabled}
            value={entry.unit}
            onChange={(event) =>
              onChange(
                patchIngredient(review, ctx, entry.norm, {
                  unit: event.target.value,
                }),
              )
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
        {entry.lossFraction !== null &&
        (entry.target.type === 'item' || isNew) ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={disabled}
              checked={entry.lossApproved}
              onChange={(event) =>
                onChange(
                  patchIngredient(review, ctx, entry.norm, {
                    lossApproved: event.target.checked,
                  }),
                )
              }
            />
            <span>
              اعتمد فاقد {entry.name}: {percentText(entry.lossFraction)}
            </span>
          </label>
        ) : null}
        {isNew ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              سعر افتتاحي اختياري لـ {entry.name}
              {base
                ? ` (جنيه لكل ${unitLabels[base as BaseUnit] ?? base})`
                : ''}
              <input
                className={fieldClass}
                dir="ltr"
                inputMode="decimal"
                disabled={disabled}
                value={entry.price}
                onChange={(event) =>
                  onChange(
                    patchIngredient(review, ctx, entry.norm, {
                      price: event.target.value,
                    }),
                  )
                }
              />
            </label>
            {/^\s*0+([.,]0*)?\s*$/.test(entry.price) ? (
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                سبب السعر صفر لـ {entry.name}
                <input
                  className={fieldClass}
                  disabled={disabled}
                  value={entry.priceReason}
                  onChange={(event) =>
                    onChange(
                      patchIngredient(review, ctx, entry.norm, {
                        priceReason: event.target.value,
                      }),
                    )
                  }
                />
              </label>
            ) : null}
          </div>
        ) : null}
        <p className="text-sm text-neutral-600">
          {choices.length === 0
            ? ''
            : `الوحدات المتاحة: ${choices.map((choice) => unitName(choice.code)).join('، ')}`}
        </p>
        <Issues messages={issues.ingredients.get(entry.norm)} />
      </li>
    );
  }

  return (
    <>
      <section className="flex flex-col gap-3" aria-label="الوصفات في الملف">
        <h2 className="text-lg font-semibold">
          الوصفات اللي اتلقت ({review.blocks.length})
        </h2>
        <ul className="flex flex-col gap-3">
          {review.blocks.map(renderBlock)}
        </ul>
      </section>
      <section className="flex flex-col gap-3" aria-label="المكونات">
        <h2 className="text-lg font-semibold">
          المكونات ({ingredients.length})
        </h2>
        <ul className="flex flex-col gap-3">
          {ingredients.map(renderIngredient)}
        </ul>
      </section>
    </>
  );
}
