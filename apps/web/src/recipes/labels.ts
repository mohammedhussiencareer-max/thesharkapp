import type { RecipeKind } from '@/recipes/types';

export const recipeKindLabels: Record<RecipeKind, string> = {
  dish: 'طبق',
  cooking: 'طريقة طهي لكل كيلو',
  batch: 'تحضيرة',
};

export const noVersionLabel = 'مش متحددة دلوقتي';
export const inForceLabel = 'متحددة';

export const portionUnit = 'portion';
export const portionLabel = 'حصة';

export const netQuantityHint =
  'الكمية صافي، من غير الفاقد. الفاقد بيتحسب لوحده من الصنف.';

/** Shown when the version in force at save time is not the one the draft came from. */
export const sourceChangedMessage =
  'السطور دي كانت مبنية على نسخة غير السارية في الوقت ده. راجع السطور المحدّثة واحفظ تاني';

/** One Arabic message per code a preview can report. */
export const issueMessages: Record<string, string> = {
  no_version_in_force: 'مفيش نسخة سارية للوصفة في الوقت ده',
  loss_not_set: 'نسبة الفاقد لسه متحددتش للصنف',
  unit_not_convertible: 'الوحدة دي مالهاش تحويل',
  cycle: 'الوصفة بتدخل في دايرة وبتستخدم نفسها',
  depth_exceeded: 'التحضيرات متداخلة أكتر من اللازم',
  below_precision: 'الكمية صغيرة أوي وبتتقرب لصفر',
  invalid_output_unit: 'وحدة الإخراج مش مناسبة للوصفة دي',
};
