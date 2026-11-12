import {
  ConfirmedRefusalError,
  genericCatalogError,
  StaleWriteError,
} from '@/items/errors';

export const alreadyCorrectedMessage =
  'السجل ده اتصحّح من مكان تاني — اتحدّثت البيانات، راجعها وصحّح تاني';

export const alreadyCorrectedServerMessage =
  'the waste document was already corrected';

export const notActivatedMessage =
  'الخصم لسه ما اتفعّلش — الهالك ما اتسجلش. استنى لحد ما المخزون يتفعّل';

export const notActivatedServerMessage = 'inventory is not activated';

export const missingCostMessage =
  'مفيش تكلفة مسجلة لصنف أو أكتر — سجّل سعر افتتاحي أو شراء الأول';

export const syncRunningMessage =
  'مزامنة الكاشير شغالة دلوقتي — استنى لحظة وجرّب تاني';

/** The corrected document already has a successor: its request id stored nothing. */
export class AlreadyCorrectedError extends StaleWriteError {
  readonly code = '40001';

  constructor() {
    super();
    this.name = 'AlreadyCorrectedError';
    this.message = alreadyCorrectedMessage;
  }
}

/** Posting stopped because an item has no cost to value the loss at. */
export class MissingCostBasisError extends ConfirmedRefusalError {
  readonly code = 'P0001';

  constructor(readonly itemIds: readonly string[]) {
    super(missingCostMessage);
    this.name = 'MissingCostBasisError';
  }
}

type ServerError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Item ids in the `missing_cost_basis` hint; empty when the hint is unusable. */
export function blockedItemIds(error: ServerError): string[] {
  if (error.code !== 'P0001' || error.details !== 'missing_cost_basis') {
    return [];
  }
  const ids = (error.hint ?? '').split(',').map((id) => id.trim());
  return ids.every((id) => uuidPattern.test(id)) ? ids : [];
}

export function isMissingCostBasis(error: ServerError): boolean {
  return error.code === 'P0001' && error.details === 'missing_cost_basis';
}

export function isNotActivated(error: ServerError): boolean {
  return error.code === '55000' && error.message === notActivatedServerMessage;
}

export function isAlreadyCorrected(error: ServerError): boolean {
  return (
    error.code === '40001' && error.message === alreadyCorrectedServerMessage
  );
}

const phrases: ReadonlyArray<readonly [string, string]> = [
  [
    'an explanation is required for the reason other',
    'اكتب شرح — السبب "سبب تاني" محتاج شرح',
  ],
  ['explanation is longer than 300 characters', 'الشرح أطول من 300 حرف'],
  [
    'cancel_after_preparation is recorded by the system only',
    'السبب ده بيتسجل من النظام بس',
  ],
  ['unknown waste reason', 'سبب الهالك مش معروف'],
  ['quantity must be greater than zero', 'الكمية لازم تكون أكبر من صفر'],
  [
    'quantity is too small in the base unit',
    'الكمية صغيرة جدًا بالنسبة للوحدة الأساسية',
  ],
  ['quantity is too large', 'الكمية كبيرة جدًا'],
  [
    'each line is {item_id, quantity, unit} with decimal text',
    'كل سطر لازم يكون صنف وكمية (رقم من غير علامة) ووحدة',
  ],
  ['a stock item is listed twice', 'صنف اتكرر في السطور'],
  [
    'a waste document needs at least one line',
    'لازم يكون فيه سطر واحد على الأقل',
  ],
  ['a waste document has at most 50 lines', 'الحد الأقصى 50 سطر في السجل'],
  [
    'occurred_at must be an ISO timestamp with an offset',
    'وقت الهالك مش مظبوط',
  ],
  ['occurred_at is not a valid timestamp', 'وقت الهالك مش مظبوط'],
  ['unknown unit', 'الوحدة دي مش متاحة للصنف في الوقت ده'],
  ['invalid unit', 'الوحدة مش مظبوطة'],
  ['unknown stock item', 'الصنف مش موجود'],
  ['unknown waste document', 'سجل الهالك مش موجود'],
  ['a voided waste document cannot be corrected', 'السجل الملغي مينفعش يتصحّح'],
  [
    'a void carries no time, reason or explanation',
    'إلغاء السجل مالوش وقت ولا سبب',
  ],
  [
    'request id was used for a different waste document',
    'معرّف الحفظ اتستخدم لسجل تاني',
  ],
  ['a POS sync is running', syncRunningMessage],
];

export function mapWasteError(error: ServerError): string {
  if (error.code === '42501') return 'المالك بس يقدر يسجّل الهالك';
  if (isNotActivated(error)) return notActivatedMessage;
  if (isMissingCostBasis(error)) return missingCostMessage;
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`;
  for (const [needle, message] of phrases) {
    if (text.includes(needle)) return message;
  }
  return genericCatalogError;
}
