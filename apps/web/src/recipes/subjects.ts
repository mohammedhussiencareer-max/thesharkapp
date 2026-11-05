import type { RecipeKind } from '@/recipes/types';

/** One create action per submitted name and kind. */
export function recipeCreateSubject(name: string, kind: RecipeKind): string {
  return `recipe-create:${JSON.stringify([name.trim(), kind])}`;
}

export function recipeUpdateSubject(recipeId: string): string {
  return `recipe-update:${recipeId}`;
}

/** One workbook import at a time, whatever the file. */
export const recipeImportSubject = 'recipe-import';

/** One version save per recipe, whatever its interval. */
export function recipeVersionSubject(recipeId: string): string {
  return `recipe-version:${recipeId}`;
}
