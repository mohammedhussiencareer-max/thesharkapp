import type { StockKind } from '@/items/types';

export const recipeKinds = ['dish', 'cooking', 'batch'] as const;

export type RecipeKind = (typeof recipeKinds)[number];

export function isRecipeKind(value: string): value is RecipeKind {
  return (recipeKinds as readonly string[]).includes(value);
}

export type RecipeRecord = {
  id: string;
  name: string;
  kind: RecipeKind;
  active: boolean;
};

export type RecipeSummary = RecipeRecord & {
  /** A version covers the current instant. Otherwise nothing is in force. */
  inForce: boolean;
};

export type RecipeLine = {
  id: string;
  stockItemId: string | null;
  childRecipeId: string | null;
  /** Exact decimal text. */
  quantity: string;
  unit: string;
};

export type RecipeVersion = {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  batchQty: string | null;
  batchUnit: string | null;
  lines: RecipeLine[];
};

export type RecipeSchedule = {
  identity: string;
  token: string;
  emptyToken: string;
  versions: RecipeVersion[];
};

/** One line of the version being written. Lines are `null` to leave a gap. */
export type WireLine = {
  stock_item_id?: string;
  child_recipe_id?: string;
  quantity: string;
  unit: string;
};

export type RecipeWrite = {
  requestId: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  batchQty: string | null;
  batchUnit: string | null;
  lines: WireLine[] | null;
  reason: string | null;
  token: string;
};

export type StockOption = {
  id: string;
  name: string;
  kind: StockKind;
  baseUnit: string;
  active: boolean;
};

export type ItemUnit = {
  itemId: string;
  unit: string;
  label: string;
};

export type UnitMeta = {
  code: string;
  labelAr: string;
  dimension: string;
  /** Null for units that only convert through an item factor. */
  metricScale: number | null;
};

export type BatchOption = {
  id: string;
  name: string;
  active: boolean;
  /** Dated batch units of the child, so a line can offer the unit in force. */
  versions: {
    effectiveFrom: string;
    effectiveTo: string | null;
    unit: string;
  }[];
};

export type RecipeCatalog = {
  stock: StockOption[];
  itemUnits: ItemUnit[];
  units: UnitMeta[];
  batches: BatchOption[];
  shiftStart: string | null;
};

export type RecipeIssue = {
  code: string;
  recipeId: string | null;
  stockItemId: string | null;
  unit: string | null;
};

export type Requirement = {
  stockItemId: string;
  baseUnit: string;
  /** Rounded once to six places by the server. */
  quantity: string;
};

export type Expansion =
  | { status: 'ready'; requirements: Requirement[] }
  | { status: 'blocked'; issues: RecipeIssue[] };
