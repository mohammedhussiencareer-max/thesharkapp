import {
  CATALOG_ITEM_FIELDS,
  CATALOG_OPTION_GROUP_FIELDS,
} from './catalog-allowlist.ts';
import { isRecord } from './decode.ts';

// The accounting paths mirror the reads in mapper.ts. Firestore cannot mask
// individual fields inside array elements, so orders select the items array.
export const ORDER_FIELD_PATHS = Object.freeze([
  'status',
  'orderNumber',
  'shiftId',
  'orderType',
  'paymentType',
  'timestamp',
  'subtotalAmount',
  'discountAmount',
  'taxTotalAmount',
  'serviceTaxAmount',
  'deliveryDetails.deliveryFee',
  'totalAmount',
  'financialRevision',
  'lastFinancialOperationKey',
  'items',
]);

export const TRANSACTION_FIELD_PATHS = Object.freeze([
  'orderId',
  'type',
  'amount',
  'timestamp',
]);

// Parent paths preserve all dynamic labels and array entries. Firestore has
// no wildcard for unknown map keys or field paths through array elements.
// The catalog refusal scan and leaf allowlist still apply to these subtrees.
function catalogRootPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze([
    ...new Set(paths.map((path) => path.replace(/\[\].*|\..*/, ''))),
  ]);
}

export const FIRESTORE_FIELD_PATHS = Object.freeze({
  orders: ORDER_FIELD_PATHS,
  custody_shifts: Object.freeze([
    'id',
    'opening_time',
    'closingTime',
    'isActive',
    'cash_payments_net',
    'credit_payments',
  ]),
  transactions: TRANSACTION_FIELD_PATHS,
  items: catalogRootPaths(CATALOG_ITEM_FIELDS),
  optionGroups: catalogRootPaths(CATALOG_OPTION_GROUP_FIELDS),
});

export function matchesProjection(
  actual: readonly unknown[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((path) => actual.includes(path))
  );
}

export function assertProjectedDocument(
  document: unknown,
  projection: readonly string[],
): void {
  // The document parsers own envelope validation and catalog rejection rows.
  if (isRecord(document) && isRecord(document.fields)) {
    assertProjectedFields(document.fields, projection);
  }
}

function assertProjectedFields(
  fields: Record<string, unknown>,
  projection: readonly string[],
): void {
  for (const key of Object.keys(fields)) {
    if (!key.includes('.') && projection.includes(key)) {
      continue;
    }
    const prefix = `${key}.`;
    const children = projection
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
    const value = fields[key];
    if (
      children.length === 0 ||
      !isRecord(value) ||
      Object.keys(value).length !== 1 ||
      !isRecord(value.mapValue) ||
      Object.keys(value.mapValue).some((property) => property !== 'fields')
    ) {
      throw new Error('Firestore read failed: invalid response');
    }
    const nested = value.mapValue.fields;
    if (nested !== undefined) {
      if (!isRecord(nested)) {
        throw new Error('Firestore read failed: invalid response');
      }
      assertProjectedFields(nested, children);
    }
  }
}

const TRANSACTION_RESPONSE_KEYS = new Set([
  'documents',
  'nextPageToken',
  'name',
  'fields',
  'createTime',
  'updateTime',
  'stringValue',
  'timestampValue',
  'integerValue',
  'doubleValue',
  'nullValue',
  ...TRANSACTION_FIELD_PATHS,
]);

export function transactionResponseKeysAllowed(text: string): boolean {
  // Scan JSON string tokens, including escaped quotes, before parsing the
  // response. A string followed by a colon is a key. Decode only escaped
  // keys here. JSON.parse validates the full syntax after this check passes.
  const strings = /("[^"\\]*(?:\\[\s\S][^"\\]*)*")\s*(:)?/g;
  for (const [, token, colon] of text.matchAll(strings)) {
    if (colon === undefined || token === undefined) {
      continue;
    }
    const key: unknown = token.includes('\\')
      ? JSON.parse(token)
      : token.slice(1, -1);
    if (typeof key !== 'string' || !TRANSACTION_RESPONSE_KEYS.has(key)) {
      return false;
    }
  }
  return true;
}
