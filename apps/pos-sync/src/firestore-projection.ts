import {
  CATALOG_ITEM_FIELDS,
  CATALOG_OPTION_GROUP_FIELDS,
} from './catalog-allowlist.ts';
import { isRecord } from './decode.ts';
import { normalizeTimestamp } from './time.ts';

function isValidTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    normalizeTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

// The accounting paths mirror the reads in mapper.ts. Firestore cannot mask
// individual fields inside array elements, so orders select the items array.
const VALUE_PAYLOADS = {
  stringValue: (value: unknown) => typeof value === 'string',
  timestampValue: isValidTimestamp,
  booleanValue: (value: unknown) => typeof value === 'boolean',
  integerValue: (value: unknown) =>
    typeof value === 'string' &&
    /^-?\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)),
  doubleValue: (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value),
  nullValue: (value: unknown) => value === null || value === 'NULL_VALUE',
  arrayValue: (value: unknown) =>
    isRecord(value) &&
    Object.keys(value).every((key) => key === 'values') &&
    (value.values === undefined || Array.isArray(value.values)),
  mapValue: (value: unknown) =>
    isRecord(value) &&
    Object.keys(value).every((key) => key === 'fields') &&
    (value.fields === undefined || isRecord(value.fields)),
};

type Kind = keyof typeof VALUE_PAYLOADS;
const NUMBER = ['integerValue', 'doubleValue'] as const;
const OPTIONAL_NUMBER = [...NUMBER, 'nullValue'] as const;
const OPTIONAL_STRING = ['stringValue', 'nullValue'] as const;
const TIMESTAMP = ['timestampValue', 'stringValue'] as const;
const OPTIONAL_TIMESTAMP = [...TIMESTAMP, 'nullValue'] as const;
const OPTIONAL_ARRAY = ['arrayValue', 'nullValue'] as const;
const OPTIONAL_MAP = ['mapValue', 'nullValue'] as const;
const TIMESTAMP_FIELDS = new Set(['timestamp', 'opening_time', 'closingTime']);

const ORDER_FIELD_KINDS = {
  status: ['stringValue'],
  orderNumber: OPTIONAL_NUMBER,
  shiftId: ['stringValue'],
  orderType: OPTIONAL_STRING,
  paymentType: OPTIONAL_STRING,
  timestamp: TIMESTAMP,
  subtotalAmount: NUMBER,
  discountAmount: NUMBER,
  taxTotalAmount: NUMBER,
  serviceTaxAmount: NUMBER,
  'deliveryDetails.deliveryFee': OPTIONAL_NUMBER,
  totalAmount: NUMBER,
  financialRevision: OPTIONAL_NUMBER,
  lastFinancialOperationKey: OPTIONAL_STRING,
  items: OPTIONAL_ARRAY,
} satisfies Record<string, readonly Kind[]>;

const SHIFT_FIELD_KINDS = {
  id: OPTIONAL_STRING,
  opening_time: TIMESTAMP,
  closingTime: OPTIONAL_TIMESTAMP,
  isActive: ['booleanValue'],
  cash_payments_net: OPTIONAL_NUMBER,
  credit_payments: OPTIONAL_NUMBER,
} satisfies Record<string, readonly Kind[]>;

export const TRANSACTION_FIELD_KINDS = {
  orderId: OPTIONAL_STRING,
  type: NUMBER,
  amount: NUMBER,
  timestamp: TIMESTAMP,
} satisfies Record<string, readonly Kind[]>;

const FIELD_KINDS: Readonly<Record<string, readonly Kind[] | undefined>> = {
  ...ORDER_FIELD_KINDS,
  ...SHIFT_FIELD_KINDS,
  ...TRANSACTION_FIELD_KINDS,
  name: ['stringValue'],
  sizes: OPTIONAL_ARRAY,
  options: OPTIONAL_MAP,
  sharedOptionGroupIds: OPTIONAL_MAP,
  values: OPTIONAL_ARRAY,
};

export const ORDER_FIELD_PATHS = Object.freeze(Object.keys(ORDER_FIELD_KINDS));
export const TRANSACTION_FIELD_PATHS = Object.freeze(
  Object.keys(TRANSACTION_FIELD_KINDS),
);

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
  custody_shifts: Object.freeze(Object.keys(SHIFT_FIELD_KINDS)),
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
  if (!isRecord(document) || document.fields === undefined) {
    return;
  }
  if (!isRecord(document.fields)) {
    throw new Error('Firestore read failed: invalid response');
  }
  assertProjectedFields(document.fields, projection);
}

function assertProjectedFields(
  fields: Record<string, unknown>,
  projection: readonly string[],
  parent = '',
): void {
  for (const key of Object.keys(fields)) {
    const path = `${parent}${key}`;
    if (!key.includes('.') && projection.includes(key)) {
      if (!matchesValueKind(fields[key], FIELD_KINDS[path], path)) {
        throw new Error('Firestore read failed: invalid response');
      }
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
      assertProjectedFields(nested, children, `${path}.`);
    }
  }
}

function matchesValueKind(
  value: unknown,
  kinds: readonly Kind[] | undefined,
  path: string,
): boolean {
  if (
    kinds === undefined ||
    !isRecord(value) ||
    Object.keys(value).length !== 1
  ) {
    return false;
  }
  const kind = kinds.find((candidate) => Object.hasOwn(value, candidate));
  if (kind === undefined || !VALUE_PAYLOADS[kind](value[kind])) {
    return false;
  }
  return !(
    kind === 'stringValue' &&
    TIMESTAMP_FIELDS.has(path) &&
    !isValidTimestamp(value[kind])
  );
}
