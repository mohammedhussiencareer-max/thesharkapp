import { PosSyncError } from './safe-error.ts';
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasFirestoreValueKind(
  value: unknown,
  ...kinds: string[]
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const [kind, extra] = Object.keys(value);
  return kind !== undefined && extra === undefined && kinds.includes(kind);
}

export function decodeFirestoreValue(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new PosSyncError('invalidFirestoreValue');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new PosSyncError('invalidFirestoreValue');
  }
  const kind = keys[0];
  switch (kind) {
    case 'stringValue':
      if (typeof value.stringValue !== 'string') {
        throw new PosSyncError('invalidFirestoreString');
      }
      return value.stringValue;
    case 'integerValue': {
      if (
        typeof value.integerValue !== 'string' ||
        !/^-?\d+$/.test(value.integerValue)
      ) {
        throw new PosSyncError('invalidFirestoreInteger');
      }
      const parsed = Number(value.integerValue);
      if (!Number.isSafeInteger(parsed)) {
        throw new PosSyncError('firestoreIntegerOutOfRange');
      }
      return parsed;
    }
    case 'doubleValue':
      if (
        typeof value.doubleValue !== 'number' ||
        !Number.isFinite(value.doubleValue)
      ) {
        throw new PosSyncError('invalidFirestoreDouble');
      }
      return value.doubleValue;
    case 'booleanValue':
      if (typeof value.booleanValue !== 'boolean') {
        throw new PosSyncError('invalidFirestoreBoolean');
      }
      return value.booleanValue;
    case 'timestampValue':
      if (typeof value.timestampValue !== 'string') {
        throw new PosSyncError('invalidFirestoreTimestamp');
      }
      return value.timestampValue;
    case 'nullValue':
      return null;
    case 'mapValue': {
      if (!isRecord(value.mapValue)) {
        throw new PosSyncError('invalidFirestoreMap');
      }
      const fields = value.mapValue.fields;
      return decodeFields(fields === undefined ? {} : fields);
    }
    case 'arrayValue': {
      if (!isRecord(value.arrayValue)) {
        throw new PosSyncError('invalidFirestoreArray');
      }
      const values = value.arrayValue.values;
      if (values === undefined) {
        return [];
      }
      if (!Array.isArray(values)) {
        throw new PosSyncError('invalidFirestoreArray');
      }
      return values.map((entry) => decodeFirestoreValue(entry));
    }
    default:
      throw new PosSyncError('unsupportedFirestoreValue');
  }
}

export function decodeFields(fields: unknown): Record<string, unknown> {
  if (!isRecord(fields)) {
    throw new PosSyncError('invalidFirestoreMap');
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    decoded[key] = decodeFirestoreValue(value);
  }
  return decoded;
}

const DOCUMENT_PREFIX =
  'projects/thesharkrestaurant/databases/(default)/documents/';

const UNICODE_CONTROL_CHAR = /\p{Cc}/u;

export function isSafeDocumentId(id: string): boolean {
  if (id.length === 0 || id.length > 1500) {
    return false;
  }
  if (id === '.' || id === '..' || id.includes('..')) {
    return false;
  }
  return !/[/%:?#\\\s]/.test(id);
}

/** Stricter id check for catalog document ids and sharedOptionGroupIds references. */
export function isSafeCatalogDocumentId(id: string): boolean {
  return isSafeDocumentId(id) && !UNICODE_CONTROL_CHAR.test(id);
}

export type PosCollection =
  'orders' | 'custody_shifts' | 'items' | 'optionGroups';

const POS_COLLECTIONS = new Set<string>([
  'orders',
  'custody_shifts',
  'items',
  'optionGroups',
]);

export function splitDocumentName(name: string): {
  collection: PosCollection;
  id: string;
} {
  if (!name.startsWith(DOCUMENT_PREFIX)) {
    throw new PosSyncError('invalidDocumentName');
  }
  const rest = name.slice(DOCUMENT_PREFIX.length);
  const parts = rest.split('/');
  if (parts.length !== 2) {
    throw new PosSyncError('invalidDocumentName');
  }
  const collection = parts[0];
  const id = parts[1];
  if (
    collection === undefined ||
    !POS_COLLECTIONS.has(collection) ||
    id === undefined
  ) {
    throw new PosSyncError('invalidDocumentName');
  }
  const validId =
    collection === 'items' || collection === 'optionGroups'
      ? isSafeCatalogDocumentId(id)
      : isSafeDocumentId(id);
  if (!validId) {
    throw new PosSyncError('invalidDocumentName');
  }
  return { collection: collection as PosCollection, id };
}

/** `custody_shifts/{shiftId}/transactions/{txId}` under the POS project. */
export function splitTransactionName(name: string): {
  shiftId: string;
  txId: string;
} {
  if (!name.startsWith(DOCUMENT_PREFIX)) {
    throw new PosSyncError('invalidDocumentName');
  }
  const parts = name.slice(DOCUMENT_PREFIX.length).split('/');
  if (parts.length !== 4) {
    throw new PosSyncError('invalidDocumentName');
  }
  const collection = parts[0];
  const shiftId = parts[1];
  const sub = parts[2];
  const txId = parts[3];
  if (
    collection !== 'custody_shifts' ||
    sub !== 'transactions' ||
    shiftId === undefined ||
    txId === undefined ||
    !isSafeDocumentId(shiftId) ||
    !isSafeDocumentId(txId)
  ) {
    throw new PosSyncError('invalidDocumentName');
  }
  return { shiftId, txId };
}
