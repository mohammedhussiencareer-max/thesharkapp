import { SupabaseRpcError } from './supabase-write.ts';

// Every console line and every persisted run error goes through here. Only
// messages this package writes itself pass through unchanged; anything else
// (library errors, JSON parse errors that quote response text, database
// messages that embed owner-entered names) becomes a fixed class.
const FALLBACK = 'sync failed';

/** Literal messages thrown in this package. Kept in sync by a source scan test. */
export const STATIC_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  'Catalog allowlist mismatch: missing required selector',
  'Catalog payload refused: excessive nesting',
  'Catalog payload refused: price-shaped key',
  'Could not obtain a Google access token',
  'Firestore document name is invalid',
  'Firestore integer is out of range',
  'Firestore page limit exceeded',
  'Firestore read failed: invalid response',
  'Firestore read failed: network',
  'Firestore read refused',
  'Refusing non-local Supabase URL',
  'Supabase RPC failed: network',
  'Supabase RPC failed: unexpected response',
  'Supabase service role key is required',
  'Unknown argument',
  'Unknown mode',
  'another POS sync is running',
  'batch size must be positive',
  'duplicate catalog item id',
  'duplicate catalog option group id',
  'duplicate line id',
  'duplicate order id',
  'duplicate tx id',
  'empty token',
  'expected a shift document',
  'expected an order document',
  'gcloud failed',
  'invalid Firestore array',
  'invalid Firestore boolean',
  'invalid Firestore document',
  'invalid Firestore double',
  'invalid Firestore integer',
  'invalid Firestore map',
  'invalid Firestore string',
  'invalid Firestore timestamp',
  'invalid Firestore value',
  'invalid catalog item document name',
  'invalid catalog option group document name',
  'invalid decimal',
  'invalid decimal places',
  'invalid hash value',
  'invalid timestamp',
  'number must be finite',
  'option pricingBaseQuantity must be >= 0',
  'orders exist after the scan window',
  'quantity must be >= 0',
  'recent orders page was truncated',
  'repeated Firestore page token',
  'shift id does not match document id',
  'timestamp range is still full',
  'unexpected items',
  'unexpected selectedOptions',
  'unexpected size',
  'unexpected status',
  'unexpected transaction shape',
  'unsupported Firestore value',
  'updateTime is required',
  'weighted quantity must be > 0',
  'weighted quantity must be >= 0',
]);

// Template messages whose variable part is a code-defined field label or an
// HTTP status. A label is a short identifier, never free text.
const LABEL = '[A-Za-z][A-Za-z0-9_.]{0,63}';
const TEMPLATE_MESSAGES: readonly RegExp[] = [
  new RegExp(`^unexpected ${LABEL}$`),
  new RegExp(`^${LABEL} is required$`),
  new RegExp(`^duplicate ${LABEL} id$`),
  /^Firestore read failed: HTTP [1-5][0-9]{2}$/,
];

function rpcMessage(error: SupabaseRpcError): string {
  if (error.kind === 'network') {
    return 'Supabase RPC failed: network';
  }
  if (error.kind === 'response') {
    return 'Supabase RPC failed: unexpected response';
  }
  const status =
    error.status !== null &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? ` HTTP ${error.status}`
      : '';
  const sqlstate =
    error.sqlstate !== null && /^[0-9A-Z]{5}$/.test(error.sqlstate)
      ? ` ${error.sqlstate}`
      : '';
  const detail = `${status}${sqlstate}`;
  return detail === '' ? FALLBACK : `Supabase RPC failed:${detail}`;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof SupabaseRpcError) {
    return rpcMessage(error);
  }
  if (!(error instanceof Error)) {
    return FALLBACK;
  }
  const message = error.message;
  if (STATIC_ERROR_MESSAGES.has(message)) {
    return message;
  }
  if (TEMPLATE_MESSAGES.some((pattern) => pattern.test(message))) {
    return message;
  }
  return FALLBACK;
}
