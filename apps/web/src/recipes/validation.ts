export const recipeNameError = 'الاسم لازم يكون من حرف لحد 120 حرف';

export function validateRecipeName(name: string): string | null {
  const length = name.trim().length;
  return length >= 1 && length <= 120 ? null : recipeNameError;
}
