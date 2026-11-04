export const genericCatalogError = 'حصل خطأ. حاول تاني.';

export const staleWriteMessage =
  'البيانات اتغيّرت من مكان تاني — اتعملها تحديث، راجعها واحفظ تاني';

/** A dated loss or conversion lost the race with another schedule write. */
export const costingChangedMessage = 'البيانات اتغيرت — حدّث الصفحة وجرّب تاني';

/** The editor shows a kind, base unit or parent that is not saved yet. */
export const saveDetailsFirstMessage =
  'النوع أو الوحدة الأساسية أو الأب اتغيّروا ولسه ماتحفظوش — احفظ البيانات الأول';

/** The costing schedule belongs to a different identity than the one shown. */
export const identityOutOfDateMessage =
  'نوع الصنف أو وحدته اتغيّروا من مكان تاني — بنحدّث البيانات، استنى لحظة وجرّب تاني';

export class StaleWriteError extends Error {
  constructor() {
    super(staleWriteMessage);
    this.name = 'StaleWriteError';
  }
}

export class CostingChangedError extends StaleWriteError {
  /**
   * Thrown only when a costing writer raises 40001 with the message
   * `configuration changed` after the request-id replay lookup. That proves
   * this request id stored nothing. A generic 40001 does not.
   */
  readonly code = '40001';

  constructor() {
    super();
    this.name = 'CostingChangedError';
    this.message = costingChangedMessage;
  }
}

/**
 * True only for the writers' post-replay conflict. The Arabic owner message
 * is not enough: a generic serialization failure is also 40001.
 */
export function isConfirmedConfigurationChange(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (current instanceof CostingChangedError) return true;
    const record = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (record.code === '40001' && record.message === 'configuration changed') {
      return true;
    }
    current = record.cause;
  }
  return false;
}

const checkReasons: ReadonlyArray<readonly [string, string]> = [
  [
    'cannot change base_unit of an item that is configured or has movements',
    'مينفعش تغيّر وحدة صنف اتحدد أو عليه حركات',
  ],
  [
    'cannot change kind of an item that is configured or has movements',
    'مينفعش تغيّر نوع صنف اتحدد أو عليه حركات',
  ],
  [
    'cannot change parent_item_id of an item that is configured or has movements',
    'مينفعش تغيّر أب صنف اتحدد أو عليه حركات',
  ],
  [
    'cannot change base_unit of an item that has movements',
    'مينفعش تغيّر وحدة صنف عليه حركات',
  ],
  [
    'cannot change base_unit while the item has unit conversions',
    'امسح التحويلات الأول قبل ما تغيّر الوحدة',
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

  if (code === '40001') return costingChangedMessage;
  if (code === '42501') return 'المالك بس يقدر يعمل التغيير ده';

  if (text.includes('zero_cost_reason') || text.includes('zero cost'))
    return 'اكتب سبب إن السعر صفر';
  if (text.includes('reason is required')) return 'اكتب سبب التغيير بأثر رجعي';
  if (text.includes('unit already exists')) return 'الوحدة دي موجودة قبل كده';
  if (text.includes('unknown unit')) return 'الوحدة دي مش معرّفة للصنف';
  if (text.includes('is frozen'))
    return 'القيمة القديمة متقفلة. عدّل الفاقد أو التحويل بتاريخ سريان';

  if (code === '23505') {
    if (text.includes('item_unit_conversions') || text.includes('units')) {
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
