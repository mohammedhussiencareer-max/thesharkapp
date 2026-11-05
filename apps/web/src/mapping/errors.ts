import { genericCatalogError } from '@/items/errors';

const phrases: ReadonlyArray<readonly [string, string]> = [
  ['reason is required for a backdated change', 'اكتب سبب التغيير بأثر رجعي'],
  ['an exception overlaps a mapping', 'الاستثناء متداخل مع ربط لنفس الصنف'],
  ['price-like key', 'مفيش أسعار في الربط'],
  ['unknown key', 'البيانات فيها حقل مش معروف'],
  ['packaging and fish_mixed', 'التعبئة والسمك المخلوط مش هدف للربط'],
  ['cannot target a batch', 'التحضيرة مش هدف للربط'],
  ['option policy must be', 'سياسة الاختيارات مش مظبوطة'],
  ['scope must be', 'نطاق الاختيار مش مظبوط'],
  ['a global option mapping has no item', 'الربط العام ملوش صنف'],
  ['exception reason must be', 'سبب الاستثناء طويل أوي'],
  ['unknown order line', 'سطر الكاشير مش موجود'],
  ['coverage window', 'فترة التغطية مش مظبوطة'],
  ['request_id already used', 'معرّف الحفظ اتستخدم لتغيير تاني'],
];

export function mapMappingError(error: {
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
