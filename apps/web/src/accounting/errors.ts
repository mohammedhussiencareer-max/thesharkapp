import { genericCatalogError } from '@/items/errors';

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
