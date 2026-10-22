export const genericCountError = 'حصل خطأ. حاول تاني.';

export const permissionMessage = 'مفيش صلاحية للعملية دي';

/** A lost reply can be saved again; the same request id will not post twice. */
export const retrySafeMessage =
  'حصل خطأ. اضغط حفظ تاني — لو الطلب اتسجل مش هيتسجل مرتين.';

/** Shown while a lost save is still waiting, so the next حفظ sends it unchanged. */
export const pendingResendMessage =
  'الحفظ اللي فات ممكن يكون اتسجل — هيتبعت تاني من غير تغيير';

/** In-transaction refusals only. The allow-list lives in write-outcome.ts. */
export {
  isDefiniteRefusal,
  isPayloadRefusal,
  isUnknownOutcome,
} from '@/lib/write-outcome';

export const requestIdConflictMessage =
  'الحفظ اللي فات ممكن يكون اتسجل قبل التعديل. راجع الجرد قبل ما تسجّل تاني';

export const insideShiftMessage =
  'وقت الجرد جوه وردية. الجرد يكون بعد قفل الوردية وقبل ما الوردية اللي بعدها تفتح';

export const openShiftMessage =
  'فيه وردية لسه مفتوحة. اقفلها الأول وبعدين اعمل الجرد';

export const syncCoverageMessage =
  'لازم مزامنة جديدة تشتغل بعد ما قفلة الوردية تتسجل';

export const frequencyMessage = 'الصنف مش من أصناف الجرد ده';

export const inactiveItemMessage = 'الصنف موقوف';

export const unknownItemMessage = 'الصنف مش موجود';

export const phoneMessage = 'مينفعش تكتب أرقام تليفونات أو أرقام قومية';

export const quantityScaleMessage =
  'الكمية المعدودة مينفعش تبقى أدق من 6 خانات';

export const quantityRangeMessage = 'الكمية المعدودة أكبر من اللازم';

export const quantityNegativeMessage = 'الكمية المعدودة مينفعش تكون بالسالب';

export const quantityInvalidMessage = 'اكتب كمية صحيحة';

export const noteLengthMessage = 'الملاحظة أطول من 500 حرف';

export const timeRequiredMessage = 'اكتب وقت الجرد';

export const timeInvalidMessage = 'وقت الجرد مش مظبوط';

export const atLeastOneMessage = 'اكتب كمية لصنف واحد على الأقل';

export const tooManyMessage = 'الحد الأقصى 200 صنف';

export const duplicateItemMessage = 'الصنف متكرر';

export const badBalanceMessage = 'الرصيد أو التكلفة مش مظبوطين';

export const invalidPayloadMessage = 'البيانات مش مظبوطة';

export const surplusWarning = 'زيادة — راجع البيانات';

export const historySurplusWarning = 'فيه زيادة محتاجة مراجعة';

const backDatedMarker = 'back-dated movement not supported yet';

export function backDatedCountMessage(itemName: string): string {
  return `مينفعش تسجّل حركة لـ ${itemName} بتاريخ أقدم من آخر حركة ليه — التعديل بأثر رجعي جاي في مرحلة لاحقة`;
}

const exactReasons: ReadonlyArray<readonly [string, string]> = [
  ['counted_qty must have at most 6 decimal places', quantityScaleMessage],
  ['counted_qty must be a finite number >= 0', quantityNegativeMessage],
  ['counted_qty is out of range', quantityRangeMessage],
  ['count time is inside a shift', insideShiftMessage],
  ['a shift is still open', openShiftMessage],
  ['sync has not covered this count time', syncCoverageMessage],
  ['item count frequency does not match', frequencyMessage],
  ['item is inactive', inactiveItemMessage],
  ['unknown stock item', unknownItemMessage],
  ['request_id already used for a different count', requestIdConflictMessage],
  ['note must be at most 500 characters', noteLengthMessage],
  ['lines must be a jsonb array of 1 to 200 lines', tooManyMessage],
  ['duplicate item', duplicateItemMessage],
  ['counted_at is required', timeRequiredMessage],
  ['counted_at must be a finite timestamp', timeInvalidMessage],
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

export function mapCountError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return genericCountError;
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
    return backDatedCountMessage(name);
  }

  const reasons = [...exactReasons].sort(
    (left, right) => right[0].length - left[0].length,
  );
  for (const [needle, arabic] of reasons) {
    if (text.includes(needle)) return arabic;
  }

  if (code === '22023') return invalidPayloadMessage;
  return genericCountError;
}
