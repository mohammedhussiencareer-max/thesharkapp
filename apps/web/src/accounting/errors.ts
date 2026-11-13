import { ConfirmedRefusalError, genericCatalogError } from '@/items/errors';

export const ownerReadMessage = 'المالك بس يقدر يشوف الحساب';

export const ownerRunMessage = 'المالك بس يقدر يشغّل الحساب';

export const callFailedMessage = 'المكالمة ما اكتملتش';

export const badOrderMessage = 'الطلب مش مظبوط';

type RpcError = {
  code?: string;
};

function codeOf(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as RpcError).code;
  return typeof code === 'string' ? code : '';
}

/** A read failure. The database message is never shown. */
export function readError(error: unknown): Error {
  const code = codeOf(error);
  const mapped = new Error(
    code === '42501' ? ownerReadMessage : genericCatalogError,
  );
  if (code !== '') Object.assign(mapped, { code });
  return mapped;
}

/** A worker or retry failure. The SQLSTATE is kept for the unknown-outcome check. */
export function writeError(error: unknown): Error {
  const code = codeOf(error);
  let message = callFailedMessage;
  if (code === '42501') message = ownerRunMessage;
  else if (/^22[0-9A-Z]{3}$/.test(code)) message = badOrderMessage;
  const mapped = new Error(message);
  if (code !== '') Object.assign(mapped, { code });
  return mapped;
}

export const manifestChangedMessage =
  'قائمة الافتتاح اتغيرت — راجعها وفعّل تاني';

export const syncRunningMessage = 'المزامنة شغالة — نفس الطلب هيتعمله إعادة';

export const activationOwnerMessage = 'المالك بس يقدر يفعّل الخصم';

export class OpeningManifestChangedError extends Error {
  readonly code = '40001';

  constructor() {
    super(manifestChangedMessage);
    this.name = 'OpeningManifestChangedError';
  }
}

/**
 * The activation RPC raised 40001 with `opening manifest changed`.
 * A generic 40001 is not this, and it is not `configuration changed`.
 */
export function isOpeningManifestChange(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (current instanceof OpeningManifestChangedError) return true;
    const record = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      record.code === '40001' &&
      record.message === 'opening manifest changed'
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

const activationRefusals: ReadonlyArray<readonly [string, string]> = [
  ['request_id is required', 'الطلب ناقص'],
  ['opening manifest hash is required', 'قائمة الافتتاح ناقصة'],
  ['explicit zeros are required', 'الأصفار لازم تتسجل'],
  ['explicit zero is repeated', 'صنف اتكرر في الأصفار'],
  [
    'request id was used for a different activation',
    'الطلب ده اتبعت بقائمة مختلفة',
  ],
  ['inventory is already activated', 'التفعيل اتسجل قبل كده'],
  ['explicit zeros do not match the roster', 'الأصفار مش مطابقة للقائمة'],
  ['unreceipted outflows', 'في صرف من غير إيصال'],
  ['empty roster', 'مفيش أصناف'],
  [
    'a positive opening is required',
    'المطعم دايمًا عنده رصيد افتتاح — لازم صنف موجب واحد على الأقل',
  ],
  ['repeated opening', 'صنف عليه أكتر من رصيد افتتاح'],
  ['opening floor does not match', 'رصيد الافتتاح مش مطابق للحركة'],
  ['explicit zero item has movements', 'الصفر الصريح عليه حركات'],
  ['item base unit changed', 'وحدة الصنف اتغيرت'],
];

function activationMessage(serverMessage: string): string {
  for (const [needle, message] of activationRefusals) {
    if (serverMessage === needle) return message;
  }
  return genericCatalogError;
}

/** Maps an activate_inventory failure. The SQLSTATE stays on the error. */
export function mapActivationError(error: unknown): Error {
  const code = codeOf(error);
  const serverMessage =
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : '';
  if (code === '40001' && serverMessage === 'opening manifest changed') {
    return new OpeningManifestChangedError();
  }
  if (code === '55P03') {
    return Object.assign(new Error(syncRunningMessage), { code });
  }
  if (code === '42501') {
    return Object.assign(new Error(activationOwnerMessage), { code });
  }
  if (code === '22023') {
    return new ConfirmedRefusalError(activationMessage(serverMessage));
  }
  return writeError(error);
}
