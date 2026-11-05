import type {
  MapStatus,
  MappingFamily,
  OptionPolicy,
  TargetKind,
  TargetMode,
} from '@/mapping/types';

export const statusLabels: Record<MapStatus, string> = {
  ready: 'جاهز',
  incomplete: 'ناقص',
  exception: 'استثناء',
};

export const familyLabels: Record<MappingFamily, string> = {
  mapping: 'ربط',
  option_policy: 'سياسة اختيارات',
  exception: 'استثناء',
};

export const policyLabels: Record<OptionPolicy, string> = {
  none_expected: 'من غير اختيار',
  exactly_one: 'اختيار واحد',
  additive: 'اختيارات بتتضاف',
};

export const targetModeLabels: Record<TargetMode, string> = {
  recipe: 'وصفة',
  stock: 'صنف مخزون',
  unmapped: 'غير مربوط',
  no_stock: 'من غير مخزون',
  gap: 'فضي',
};

export const issueLabels: Record<string, string> = {
  unmapped_base: 'الصنف مش مربوط',
  unmapped_option: 'اختيار مش مربوط',
  ambiguous_option: 'اختيار متكرر ومش واضح',
  option_policy_violation: 'الاختيارات مخالفة للسياسة',
  option_policy_missing: 'سياسة الاختيارات مش متحددة',
  blocked_recipe: 'الوصفة واقفة',
  below_precision: 'الكمية أصغر من دقة الحساب',
  unresolved_option: 'اختيار فاضي',
  weighted_unit_invalid: 'وحدة الوزن مش مظبوطة',
  target_kind_mismatch: 'نوع الهدف مش مناسب للسطر',
  loss_not_set: 'الفاقد مش متحدد',
  unit_not_convertible: 'الوحدة مش قابلة للتحويل',
  exception_overlap: 'الاستثناء متداخل مع الربط',
};

export function statusLabel(status: MapStatus): string {
  return statusLabels[status];
}

export function familyLabel(family: MappingFamily): string {
  return familyLabels[family];
}

export function policyLabel(policy: OptionPolicy): string {
  return policyLabels[policy];
}

export function issueLabel(code: string): string {
  return issueLabels[code] ?? 'محتاج مراجعة';
}

export function targetKindLabel(kind: TargetKind): string {
  if (kind === 'recipe') return targetModeLabels.recipe;
  if (kind === 'stock') return targetModeLabels.stock;
  if (kind === 'unmapped') return targetModeLabels.unmapped;
  return targetModeLabels.no_stock;
}

export const sourceChangedMessage =
  'البيانات السارية اتغيرت. راجعها واحفظ تاني';

export const savedMappingMessage = 'الربط اتحفظ';
export const savedPolicyMessage = 'السياسة اتحفظت';
export const savedExceptionMessage = 'الاستثناء اتحفظ';
export const savedOptionMessage = 'ربط الاختيار اتحفظ';
