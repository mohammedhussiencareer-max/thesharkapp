import { genericCatalogError } from '@/items/errors';

/** A lost reply can be saved again; the same request id will not post twice. */
export const retrySafeMessage =
  'حصل خطأ. اضغط حفظ تاني — لو الطلب اتسجل مش هيتسجل مرتين.';

const differentRequestMessage =
  'الحفظ اللي فات ممكن يكون اتسجل قبل التعديل. راجع مصاريف الشهر قبل ما تسجّل تاني';

const reasons: Array<[string, string]> = [
  [
    'driver amount must be greater than zero',
    'أجر الساعات لازم يكون أكبر من صفر',
  ],
  ['driver amount is too large', 'أجر الساعات أكبر من المسموح'],
  [
    'driver label must not contain a phone number',
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
  ],
  [
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
  ],
  ['request_id already used for a different expense', differentRequestMessage],
  ['request_id is required', retrySafeMessage],
  [
    'driver fields must be empty unless the category is driver hours',
    'بيانات الطيار للمصروف ده بس',
  ],
  ['hourly rate must have at most 2 decimal places', 'سعر الساعة لأقرب قرش'],
  ['hourly rate must be greater than zero', 'سعر الساعة لازم يكون أكبر من صفر'],
  ['hourly rate is required for driver pay', 'اكتب سعر الساعة'],
  ['hourly rate is too large', 'سعر الساعة أكبر من المسموح'],
  ['amount must have at most 2 decimal places', 'المبلغ لأقرب قرش'],
  ['amount must be greater than zero', 'المبلغ لازم يكون أكبر من صفر'],
  ['amount is too large', 'المبلغ أكبر من المسموح'],
  ['hours must have at most 2 decimal places', 'الساعات لأقرب جزء من مية'],
  ['hours must be greater than zero', 'الساعات لازم تكون أكبر من صفر'],
  ['hours are required for driver pay', 'اكتب عدد الساعات'],
  ['hours are too large', 'الساعات أكبر من المسموح'],
  [
    'period month must be the first day of the month',
    'الشهر لازم يبدأ من أول يوم',
  ],
  [
    'period month must be empty for a daily expense',
    'المصروف اليومي ملوش شهر لوحده',
  ],
  [
    'expense date must be empty for a monthly expense',
    'المصروف الشهري ملوش تاريخ يوم',
  ],
  ['expense date is required', 'اختار التاريخ'],
  ['period month is required', 'اختار الشهر'],
  ['driver label is too long', 'اسم الطيار أطول من 40 حرف'],
  ['note is too long', 'الملاحظة أطول من 500 حرف'],
  ['void reason is required', 'اكتب سبب الإلغاء'],
  ['void reason is too long', 'سبب الإلغاء أطول من 500 حرف'],
  ['expense entry is already voided', 'المصروف ده اتلغى قبل كده'],
  ['cannot void a void', 'مينفعش تلغي حركة إلغاء'],
  ['unknown expense entry', 'المصروف مش موجود'],
  ['unknown expense category', 'التصنيف مش موجود'],
  ['expense category is inactive', 'التصنيف ده متوقف'],
  ['expense category is required', 'اختار التصنيف'],
  ['expense category name is required', 'اكتب اسم التصنيف'],
  ['expense category name is too long', 'اسم التصنيف أطول من 80 حرف'],
  ['expense category kind is not allowed', 'نوع التصنيف مش مظبوط'],
  ['expense category kind is fixed', 'مينفعش تغيّر نوع التصنيف'],
  ['expense categories are not deleted', 'مينفعش تمسح التصنيف'],
  ['month must be the first day of the month', 'الشهر لازم يبدأ من أول يوم'],
  ['date range is too long', 'الفترة أطول من المسموح'],
  ['date range is invalid', 'الفترة مش مظبوطة'],
  ['date is out of range', 'التاريخ خارج النطاق'],
  ['is_estimate is required', 'حدد إذا كان المصروف تقدير'],
  ['confirmed_by is required', 'مينفعش تأكيد الشهر من غير مستخدم'],
  ['complete is required', 'حدد حالة الشهر'],
  ['insufficient_privilege', 'مفيش صلاحية'],
];
reasons.sort((left, right) => right[0].length - left[0].length);

function errorText(error: object): { code: string; text: string } {
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const parts = [record.message, record.details, record.hint].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return { code, text: parts.join('\n') };
}

export function mapExpenseError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return genericCatalogError;
  const { code, text } = errorText(error);

  if (code === '23505') {
    if (text.includes('voids_id')) return 'المصروف ده اتلغى قبل كده';
    if (text.includes('request_id') || text.includes('expense_entries')) {
      return retrySafeMessage;
    }
    return 'الاسم ده موجود قبل كده';
  }

  if (code === '42501' || text.includes('permission denied')) {
    return 'مفيش صلاحية';
  }

  for (const [needle, message] of reasons) {
    if (text.includes(needle)) return message;
  }

  return genericCatalogError;
}
