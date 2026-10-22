export const genericSortError = 'حصل خطأ. حاول تاني.';

export const permissionMessage = 'مفيش صلاحية للعملية دي';

/** A lost reply can be saved again; the same request id will not post twice. */
export const retrySafeMessage =
  'حصل خطأ. اضغط حفظ تاني — لو الطلب اتسجل مش هيتسجل مرتين.';

/** Shown while a lost save is still waiting, so the next حفظ sends it unchanged. */
export const pendingResendMessage =
  'الحفظ اللي فات ممكن يكون اتسجل — هيتبعت تاني من غير تغيير';

export const requestIdConflictMessage =
  'الحفظ اللي فات ممكن يكون اتسجل قبل التعديل. راجع الفرز قبل ما تسجّل تاني';

export const notEnoughStockMessage = 'الرصيد مش كفاية للفرز';

export const sizesExceedMessage = 'مجموع الأحجام أكبر من الكمية اللي اتاخدت';

export const sizeNotChildMessage = 'الحجم مش من أحجام السمك المخلوط ده';

export const mixedRequiredMessage = 'اختار سمك مخلوط بالكيلو';

export const phoneMessage = 'مينفعش تكتب أرقام تليفونات أو أرقام قومية';

export const quantityScaleMessage = 'الكمية مينفعش تبقى أدق من 6 خانات';

export const quantityRangeMessage = 'الكمية أكبر من اللازم';

export const quantityPositiveMessage = 'الكمية لازم تكون أكبر من صفر';

export const quantityInvalidMessage = 'اكتب كمية صحيحة';

export const takenRequiredMessage = 'اكتب الكمية اللي اتاخدت من المخلوط';

export const noteLengthMessage = 'الملاحظة أطول من 500 حرف';

export const timeRequiredMessage = 'اكتب وقت الفرز';

export const timeInvalidMessage = 'وقت الفرز مش مظبوط';

export const atLeastOneSizeMessage = 'اكتب كمية لحجم واحد على الأقل';

export const tooManySizesMessage = 'الحد الأقصى 20 حجم';

export const duplicateSizeMessage = 'الحجم متكرر';

export const linesCountMessage = 'اكتب من حجم لـ 20 حجم';

export const badCostMessage = 'متوسط التكلفة مش مظبوط';

export const invalidPayloadMessage = 'البيانات مش مظبوطة';

const backDatedMarker = 'back-dated movement not supported yet';

export function backDatedSortMessage(itemName: string): string {
  return `مينفعش تسجّل حركة لـ ${itemName} بتاريخ أقدم من آخر حركة ليه — التعديل بأثر رجعي جاي في مرحلة لاحقة`;
}

const exactReasons: ReadonlyArray<readonly [string, string]> = [
  ['qty_taken must have at most 6 decimal places', quantityScaleMessage],
  ['quantity must have at most 6 decimal places', quantityScaleMessage],
  ['qty_taken must be a finite number > 0', quantityPositiveMessage],
  ['quantity must be a finite number > 0', quantityPositiveMessage],
  ['qty_taken is out of range', quantityRangeMessage],
  ['quantity is out of range', quantityRangeMessage],
  ['not enough stock to sort', notEnoughStockMessage],
  ['sum of sizes exceeds quantity taken', sizesExceedMessage],
  ['size item is not a child of the mixed item', sizeNotChildMessage],
  ['mixed item must be a fish_mixed item in kg', mixedRequiredMessage],
  ['request_id already used for a different sort', requestIdConflictMessage],
  ['note must be at most 500 characters', noteLengthMessage],
  ['lines must be a jsonb array of 1 to 20 size lines', linesCountMessage],
  ['duplicate size item', duplicateSizeMessage],
  ['occurred_at is required', timeRequiredMessage],
  ['occurred_at must be a finite timestamp', timeInvalidMessage],
  ['mixed_item_id is required', mixedRequiredMessage],
  ['mixed_item_id must be a uuid', mixedRequiredMessage],
  [phoneMessage, phoneMessage],
];

function errorParts(error: object): {
  code: string;
  message: string;
  details: string;
  text: string;
} {
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const details = typeof record.details === 'string' ? record.details : '';
  const hint = typeof record.hint === 'string' ? record.hint : '';
  return {
    code,
    message,
    details,
    text: [message, details, hint].filter((part) => part.length > 0).join('\n'),
  };
}

export function mapSortError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return genericSortError;
  const { code, details, text } = errorParts(error);

  if (
    code === '42501' ||
    text.includes('insufficient_privilege') ||
    text.includes('permission denied')
  ) {
    return permissionMessage;
  }

  if (code === '23505') return retrySafeMessage;

  if (text.includes(backDatedMarker)) {
    const name =
      details.trim() && !details.includes('occurred_at')
        ? details.trim()
        : 'الصنف';
    return backDatedSortMessage(name);
  }

  const reasons = [...exactReasons].sort(
    (left, right) => right[0].length - left[0].length,
  );
  for (const [needle, arabic] of reasons) {
    if (text.includes(needle)) return arabic;
  }

  if (code === '22023') return invalidPayloadMessage;
  return genericSortError;
}
