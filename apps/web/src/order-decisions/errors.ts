import { genericCatalogError, StaleWriteError } from '@/items/errors';

export const orderChangedMessage =
  'الطلب اتغيّر من ساعة ما فتحته — اتحدّثت البيانات، راجعها وقرّر تاني';

export const orderChangedServerMessage =
  'the order changed since it was loaded';

/** The server proved this request id stored nothing: the order moved on. */
export class OrderChangedError extends StaleWriteError {
  readonly code = '40001';

  constructor() {
    super();
    this.name = 'OrderChangedError';
    this.message = orderChangedMessage;
  }
}

const phrases: ReadonlyArray<readonly [string, string]> = [
  ['a reason is required to change a decision', 'اكتب سبب تغيير القرار'],
  ['reason is longer than 300 characters', 'السبب أطول من 300 حرف'],
  [
    'a refund with a negative amount must be corrected first',
    'فيه مرتجع بمبلغ سالب — لازم يتصلح في الكاشير الأول',
  ],
  [
    'an order with no cancel or refund can only be confirmed as made',
    'الطلب ده مش ملغي ولا مرتجع — تقدر تأكده بس',
  ],
  [
    'returned quantities apply only to a not-made partial refund',
    'الكميات المرتجعة بتتسجل بس لمرتجع جزئي ماتعملش',
  ],
  ['the preparation basis is not available', 'مفيش أساس تحضير جاهز للطلب ده'],
  [
    'returned quantities must be listed items',
    'الكمية المرتجعة لازم تكون لصنف من الطلب ومتزيدش عن المحضّر',
  ],
  ['a stock item is listed twice', 'صنف اتكرر في الكميات المرتجعة'],
  ['the order has no open decision', 'الطلب ده مالوش قرار مفتوح دلوقتي'],
  [
    'request id was used for a different decision',
    'معرّف الحفظ اتستخدم لقرار تاني',
  ],
  [
    'a POS sync is running',
    'مزامنة الكاشير شغالة دلوقتي — استنى لحظة وجرّب تاني',
  ],
];

export function mapDecisionError(error: {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}): string {
  if (error.code === '42501') return 'المالك بس يقدر يسجّل القرار ده';
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`;
  for (const [needle, message] of phrases) {
    if (text.includes(needle)) return message;
  }
  return genericCatalogError;
}
