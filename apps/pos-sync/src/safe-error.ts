const FIELD_LABELS = [
  'amount',
  'cash_payments_net',
  'closingTime',
  'credit_payments',
  'deliveryDetails',
  'deliveryFee',
  'discount',
  'financialRevision',
  'id',
  'isActive',
  'item',
  'item id',
  'item name',
  'items',
  'lastFinancialOperationKey',
  'line id',
  'opening_time',
  'option price',
  'option pricingBaseQuantity',
  'option pricingType',
  'option value',
  'orderId',
  'orderNumber',
  'orderType',
  'paymentType',
  'price',
  'price per kg',
  'quantity',
  'selectedOptions',
  'selectedSize',
  'service tax',
  'shift id',
  'size',
  'size name',
  'status',
  'subtotal',
  'tax',
  'timestamp',
  'total',
  'type',
  'weighted unit',
  'weightedQuantity',
] as const;

export type FieldLabel = (typeof FIELD_LABELS)[number];
const fieldLabels: ReadonlySet<string> = new Set(FIELD_LABELS);

function httpStatusDetail(status: unknown): string {
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? ` HTTP ${status}`
    : '';
}

// All thrown POS diagnostics originate here. Sinks render the classification
// again so a dependency's message, stack, and cause are never emitted.
const DIAGNOSTICS = {
  syncFailed: 'sync failed',
  syncAlreadyRunning: 'another POS sync is running',
  unknownArgument: 'Unknown argument',
  unknownMode: 'Unknown mode',
  googleTokenUnavailable: 'Could not obtain a Google access token',
  emptyToken: 'empty token',
  gcloudFailed: 'gcloud failed',
  firestoreReadRefused: 'Firestore read refused',
  firestoreInvalidResponse: 'Firestore read failed: invalid response',
  firestoreNetwork: 'Firestore read failed: network',
  firestoreHttp: (detail: string) => `Firestore read failed:${detail}`,
  firestorePageLimit: 'Firestore page limit exceeded',
  firestoreRepeatedPageToken: 'repeated Firestore page token',
  invalidDocumentName: 'Firestore document name is invalid',
  firestoreIntegerOutOfRange: 'Firestore integer is out of range',
  invalidFirestoreArray: 'invalid Firestore array',
  invalidFirestoreBoolean: 'invalid Firestore boolean',
  invalidFirestoreDocument: 'invalid Firestore document',
  invalidFirestoreDouble: 'invalid Firestore double',
  invalidFirestoreInteger: 'invalid Firestore integer',
  invalidFirestoreMap: 'invalid Firestore map',
  invalidFirestoreString: 'invalid Firestore string',
  invalidFirestoreTimestamp: 'invalid Firestore timestamp',
  invalidFirestoreValue: 'invalid Firestore value',
  unsupportedFirestoreValue: 'unsupported Firestore value',
  nonLocalSupabase: 'Refusing non-local Supabase URL',
  supabaseKeyRequired: 'Supabase service role key is required',
  rpcNetwork: 'Supabase RPC failed: network',
  rpcResponse: 'Supabase RPC failed: unexpected response',
  rpcHttp: (detail: string) => `Supabase RPC failed:${detail}`,
  batchSizeNotPositive: 'batch size must be positive',
  duplicateCatalogItem: 'duplicate catalog item id',
  duplicateCatalogOptionGroup: 'duplicate catalog option group id',
  duplicateLine: 'duplicate line id',
  duplicateOrder: 'duplicate order id',
  duplicateShift: 'duplicate shift id',
  duplicateTransaction: 'duplicate tx id',
  expectedShift: 'expected a shift document',
  expectedOrder: 'expected an order document',
  invalidDecimal: 'invalid decimal',
  invalidDecimalPlaces: 'invalid decimal places',
  invalidHashValue: 'invalid hash value',
  invalidTimestamp: 'invalid timestamp',
  numberNotFinite: 'number must be finite',
  negativeOptionPricingBase: 'option pricingBaseQuantity must be >= 0',
  negativeQuantity: 'quantity must be >= 0',
  nonPositiveWeightedQuantity: 'weighted quantity must be > 0',
  negativeWeightedQuantity: 'weighted quantity must be >= 0',
  ordersAfterScanWindow: 'orders exist after the scan window',
  recentOrdersTruncated: 'recent orders page was truncated',
  shiftIdMismatch: 'shift id does not match document id',
  timestampRangeFull: 'timestamp range is still full',
  unexpectedTransactionShape: 'unexpected transaction shape',
  updateTimeRequired: 'updateTime is required',
  unexpectedField: (label: FieldLabel) => `unexpected ${label}`,
  requiredField: (label: FieldLabel) => `${label} is required`,
  unexpectedCatalogItemPath: 'Catalog allowlist mismatch: unexpected item path',
  unsupportedCatalogItemPath:
    'Catalog allowlist mismatch: unsupported item path',
  unexpectedCatalogGroupPath:
    'Catalog allowlist mismatch: unexpected optionGroup path',
  unsupportedCatalogGroupPath:
    'Catalog allowlist mismatch: unsupported optionGroup path',
  catalogSelectorMissing:
    'Catalog allowlist mismatch: missing required selector',
  catalogExcessiveNesting: 'Catalog payload refused: excessive nesting',
  catalogPriceKey: 'Catalog payload refused: price-shaped key',
  invalidCatalogItemName: 'invalid catalog item document name',
  invalidCatalogOptionGroupName: 'invalid catalog option group document name',
  catalogExpectedString: 'expected Firestore stringValue',
  catalogStringContainsNul: 'string contains NUL',
  catalogStringMissing: 'missing required string',
  catalogStringBlank: 'blank required string',
  catalogExpectedMap: 'expected Firestore mapValue',
  catalogUnexpectedMapKey: 'unexpected mapValue key',
  catalogInvalidMapFields: 'invalid mapValue.fields',
  catalogExpectedArray: 'expected Firestore arrayValue',
  catalogUnexpectedArrayKey: 'unexpected arrayValue key',
  catalogInvalidArrayValues: 'invalid arrayValue.values',
  catalogInvalidSharedOptionLabel: 'invalid shared option label',
  catalogDuplicateSharedOptionLabel: 'duplicate shared option label',
  catalogUnsafeSharedOptionGroupId: 'unsafe shared option group id',
  catalogInvalidOptionGroupLabel: 'invalid option group label',
  catalogDuplicateOptionGroupLabel: 'duplicate option group label',
  combined: (primary: string, secondary: string) => `${primary}; ${secondary}`,
} as const;

export const POS_SYNC_ALREADY_RUNNING = DIAGNOSTICS.syncAlreadyRunning;

type DiagnosticCode = keyof typeof DIAGNOSTICS;
type StaticCode = {
  [Code in DiagnosticCode]: (typeof DIAGNOSTICS)[Code] extends string
    ? Code
    : never;
}[DiagnosticCode];
type Diagnostic =
  | [code: StaticCode, options?: ErrorOptions]
  | [code: 'unexpectedField' | 'requiredField', label: FieldLabel]
  | [code: 'firestoreHttp', status: number];

function renderDiagnostic([code, detail]: Diagnostic): string {
  if (code === 'unexpectedField' || code === 'requiredField') {
    return fieldLabels.has(detail)
      ? DIAGNOSTICS[code](detail)
      : DIAGNOSTICS.syncFailed;
  }
  if (code === 'firestoreHttp') {
    const status = httpStatusDetail(detail);
    return status === ''
      ? DIAGNOSTICS.firestoreInvalidResponse
      : DIAGNOSTICS.firestoreHttp(status);
  }
  const message = Object.hasOwn(DIAGNOSTICS, code)
    ? DIAGNOSTICS[code]
    : undefined;
  return typeof message === 'string' ? message : DIAGNOSTICS.syncFailed;
}

export class PosSyncError extends Error {
  readonly #diagnostic: Diagnostic;

  constructor(...diagnostic: Diagnostic) {
    const detail = diagnostic[1];
    super(
      renderDiagnostic(diagnostic),
      typeof detail === 'object' ? detail : undefined,
    );
    this.name = 'PosSyncError';
    this.#diagnostic = diagnostic;
  }

  static hasHttpStatus(error: unknown, status: number): boolean {
    return (
      error instanceof PosSyncError &&
      #diagnostic in error &&
      error.#diagnostic[0] === 'firestoreHttp' &&
      error.#diagnostic[1] === status
    );
  }

  static describe(error: PosSyncError): string {
    return #diagnostic in error
      ? renderDiagnostic(error.#diagnostic)
      : DIAGNOSTICS.syncFailed;
  }
}

export type RpcFailureKind = 'network' | 'http' | 'response';

function renderRpc(
  kind: RpcFailureKind,
  status: number | null,
  sqlstate: string | null,
): string {
  switch (kind) {
    case 'network':
      return DIAGNOSTICS.rpcNetwork;
    case 'response':
      return DIAGNOSTICS.rpcResponse;
    case 'http': {
      const state =
        typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)
          ? ` ${sqlstate}`
          : '';
      const detail = `${httpStatusDetail(status)}${state}`;
      return detail === ''
        ? DIAGNOSTICS.syncFailed
        : DIAGNOSTICS.rpcHttp(detail);
    }
    default:
      return DIAGNOSTICS.syncFailed;
  }
}

export class SupabaseRpcError extends Error {
  readonly kind: RpcFailureKind;
  readonly status: number | null;
  readonly sqlstate: string | null;

  constructor(
    kind: RpcFailureKind,
    status: number | null = null,
    sqlstate: string | null = null,
  ) {
    super(renderRpc(kind, status, null));
    this.name = 'SupabaseRpcError';
    this.kind = kind;
    this.status = status;
    this.sqlstate = sqlstate;
  }
}

type ClassifiedError = PosSyncError | SupabaseRpcError | PosSyncCombinedError;

export function classifySyncError(error: unknown): ClassifiedError {
  if (
    error instanceof PosSyncError ||
    error instanceof SupabaseRpcError ||
    error instanceof PosSyncCombinedError
  ) {
    return error;
  }
  return new PosSyncError('syncFailed');
}

export class PosSyncCombinedError extends Error {
  readonly #primary: ClassifiedError;
  readonly #secondary: ClassifiedError;

  constructor(primary: unknown, secondary: unknown) {
    const first = classifySyncError(primary);
    const second = classifySyncError(secondary);
    super(
      DIAGNOSTICS.combined(safeErrorMessage(first), safeErrorMessage(second)),
    );
    this.name = 'PosSyncCombinedError';
    this.#primary = first;
    this.#secondary = second;
  }

  static describe(error: PosSyncCombinedError): string {
    return #primary in error
      ? DIAGNOSTICS.combined(
          safeErrorMessage(error.#primary),
          safeErrorMessage(error.#secondary),
        )
      : DIAGNOSTICS.syncFailed;
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof PosSyncError) {
    return PosSyncError.describe(error);
  }
  if (error instanceof SupabaseRpcError) {
    return renderRpc(error.kind, error.status, error.sqlstate);
  }
  if (error instanceof PosSyncCombinedError) {
    return PosSyncCombinedError.describe(error);
  }
  return DIAGNOSTICS.syncFailed;
}
