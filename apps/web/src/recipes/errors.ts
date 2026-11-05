import { costingChangedMessage, genericCatalogError } from '@/items/errors';

const publicationCodes: Record<string, string> = {
  cooking_marine: 'وصفة طريقة الطهي مينفعش فيها سمك ولا مأكولات بحرية',
  cycle: 'الوصفة بتدخل في دايرة وبتستخدم نفسها',
  depth_exceeded: 'التحضيرات متداخلة أكتر من اللازم',
  no_version_in_force: 'في تحضيرة مالهاش نسخة سارية في الوقت ده',
  unit_not_convertible: 'وحدة التحضيرة مش متوافقة مع وحدتها في الوصفة',
};

const invalidAtPublication = 'الوصفة هتبقى غير صالحة في الوقت ده';

const invalidAtPattern =
  /would be invalid at [\s\S]*?: ([a-z_]+)(?: in recipe "|\s+for item "|\s*$)/;

const reasons: ReadonlyArray<readonly [string, string]> = [
  ['reason is required', 'اكتب سبب التغيير بأثر رجعي'],
  ['reason must be at most', 'سبب التغيير طويل'],
  ['name must be 1 to 120', 'الاسم لازم يكون من حرف لحد 120 حرف'],
  ['kind must be', 'نوع الوصفة مش مظبوط'],
  [
    'lines must not be empty',
    'ضيف مكوّن واحد على الأقل أو وقّف الوصفة من الوقت ده',
  ],
  ['lines must be a json array', 'سطور الوصفة مش مظبوطة'],
  ['price-like key', 'الوصفة مبتقبلش أسعار'],
  ['unknown key', 'في بيان مش مسموح في سطر الوصفة'],
  [
    'packaging and fish_mixed',
    'التغليف والسمك المخلوط مينفعوش يبقوا مكوّن في وصفة',
  ],
  [
    'cannot be a recipe leaf',
    'التغليف والسمك المخلوط مينفعوش يبقوا مكوّن في وصفة',
  ],
  [
    'only a batch recipe can be a child',
    'المكوّن اللي هو وصفة لازم يكون تحضيرة',
  ],
  ['only for batch recipes', 'الكمية والوحدة دي للتحضيرات بس'],
  ['only a batch recipe version carries', 'الكمية والوحدة دي للتحضيرات بس'],
  ['requires batch_qty', 'التحضيرة محتاجة كمية ووحدة'],
  ['batch_qty must be', 'كمية التحضيرة لازم تكون رقم أكبر من صفر'],
  ['unknown unit', 'الوحدة مش معرّفة'],
  ['unit in line', 'الوحدة مش مظبوطة'],
  ['quantity in line', 'الكمية لازم تكون رقم أكبر من صفر'],
  ['must be a uuid string', 'الصنف أو الوصفة مش مظبوطين'],
  ['needs exactly one of', 'كل سطر لازم يكون له صنف أو تحضيرة'],
  ['unknown stock_item', 'الصنف مش موجود'],
  ['unknown recipe id', 'الوصفة مش موجودة'],
  ['effective_to must be', 'نهاية الفترة لازم تيجي بعد بدايتها'],
  ['effective_from must be', 'وقت السريان مش مظبوط'],
];

function errorText(error: object): { code: string; text: string } {
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const parts = [record.message, record.details, record.hint].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return { code, text: parts.join('\n') };
}

function lineNumber(text: string): string {
  const match = /\bline (\d+)/.exec(text);
  return match ? `سطر ${match[1]}: ` : '';
}

/** The writers raise this after the replay lookup, so the request stored nothing. */
export function isDuplicateRecipeName(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === '23505' &&
    typeof message === 'string' &&
    message.includes('unique constraint "recipes_name_key"')
  );
}

export function mapRecipeError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return genericCatalogError;
  const { code, text } = errorText(error);

  if (code === '40001') return costingChangedMessage;
  if (code === '42501') return 'المالك بس يقدر يعمل التغيير ده';
  if (isDuplicateRecipeName(error)) return 'الاسم ده موجود قبل كده';

  if (text.includes('would be invalid at')) {
    const detail = invalidAtPattern.exec(text)?.[1] ?? '';
    return publicationCodes[detail] ?? invalidAtPublication;
  }

  for (const [needle, message] of reasons) {
    if (text.includes(needle)) return `${lineNumber(text)}${message}`;
  }

  if (code === '23514') return 'التغيير ده مش مسموح';
  return genericCatalogError;
}
