import { genericCatalogError } from '@/items/errors';

const phrases: ReadonlyArray<readonly [string, string]> = [
  ['reason is required for a backdated change', 'اكتب سبب التغيير بأثر رجعي'],
  ['price-like key', 'مفيش أسعار في التغليف'],
  ['unknown key', 'البيانات فيها حقل مش معروف'],
  [
    'only packaging items can be packaging targets',
    'التغليف بس اللي ينفع هدف للتغليف',
  ],
  ['order packaging has no capacity', 'تغليف الطلب ملوش سعة'],
  ['a packaging list names an item twice', 'الصنف متكرر في التغليف'],
  ['a packaging list needs at least one line', 'ضيف سطر تغليف'],
  ['approved none must be true', 'مفيش تغليف لازم يتأكد'],
  ['order_type must be at most 200', 'نوع الطلب طويل أوي'],
  ['unknown unit', 'الوحدة مش معروفة'],
  ['unknown stock_item', 'صنف التغليف مش موجود'],
  ['request_id already used', 'معرّف الحفظ اتستخدم لتغيير تاني'],
  ['quantity must be', 'كمية التغليف مش مظبوطة'],
  ['capacity_kg must be', 'السعة مش مظبوطة'],
];

export function mapPackagingError(error: {
  message?: string;
  details?: string | null;
  hint?: string | null;
}): string {
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`;
  for (const [needle, message] of phrases) {
    if (text.includes(needle)) return message;
  }
  return genericCatalogError;
}
