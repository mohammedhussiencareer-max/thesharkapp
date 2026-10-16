export const genericCatalogError = 'حصل خطأ. حاول تاني.';

const checkReasons: ReadonlyArray<readonly [string, string]> = [
  [
    'cannot change base_unit of an item that has movements',
    'مينفعش تغيّر وحدة صنف عليه حركات',
  ],
  [
    'cannot change base_unit to a unit that already has a conversion',
    'مينفعش تخلي الوحدة الأساسية وحدة ليها تحويل',
  ],
  [
    'cannot store a conversion for the item base unit',
    'مينفعش التحويل يبقى بنفس الوحدة الأساسية',
  ],
  [
    'cannot change kind of fish_mixed item that has fish_size children',
    'مينفعش تغيّر نوع السمك المخلوط وعنده أحجام',
  ],
  [
    'parent_item_id for fish_size must reference a fish_mixed item',
    'حجم السمك لازم يتسجل تحت سمك مخلوط',
  ],
  [
    'fish_size item requires parent_item_id',
    'حجم السمك لازم يتسجل تحت سمك مخلوط',
  ],
  [
    'parent_item_id must be null for non-fish_size items',
    'الصنف ده مش محتاج صنف أب',
  ],
  ['stock_items_loss_pct_check', 'نسبة الفاقد لازم تكون من صفر لحد أقل من 100'],
  [
    'item_unit_conversions_factor_to_base_check',
    'معامل التحويل لازم يكون رقم أكبر من صفر',
  ],
  ['item_unit_conversions_unit_check', 'اسم الوحدة فاضي'],
  ['stock_items_name_check', 'الاسم فاضي'],
  ['stock_items_kind_check', 'نوع الصنف مش مظبوط'],
  ['stock_items_base_unit_check', 'الوحدة الأساسية مش مظبوطة'],
  ['stock_items_count_frequency_check', 'دورية الجرد مش مظبوطة'],
  ['stock_items_parent_presence_chk', 'علاقة الصنف بالأب مش مظبوطة'],
];

function errorText(error: object): { code: string; text: string } {
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const parts = [record.message, record.details, record.hint].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return { code, text: parts.join('\n') };
}

export function mapCatalogError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return genericCatalogError;
  const { code, text } = errorText(error);

  if (code === '23505') {
    if (text.includes('item_unit_conversions')) {
      return 'الوحدة دي موجودة قبل كده';
    }
    return 'الاسم ده موجود قبل كده';
  }

  if (code === '23514') {
    for (const [needle, message] of checkReasons) {
      if (text.includes(needle)) return message;
    }
    return 'التغيير ده مش مسموح';
  }

  return genericCatalogError;
}

export function messageFrom(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '')
    return error.message;
  return genericCatalogError;
}
