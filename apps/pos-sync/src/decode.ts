export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeFirestoreValue(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error('invalid Firestore value');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new Error('invalid Firestore value');
  }
  const kind = keys[0];
  switch (kind) {
    case 'stringValue':
      if (typeof value.stringValue !== 'string') {
        throw new Error('invalid Firestore string');
      }
      return value.stringValue;
    case 'integerValue': {
      if (
        typeof value.integerValue !== 'string' ||
        !/^-?\d+$/.test(value.integerValue)
      ) {
        throw new Error('invalid Firestore integer');
      }
      const parsed = Number(value.integerValue);
      if (!Number.isSafeInteger(parsed)) {
        throw new Error('Firestore integer is out of range');
      }
      return parsed;
    }
    case 'doubleValue':
      if (
        typeof value.doubleValue !== 'number' ||
        !Number.isFinite(value.doubleValue)
      ) {
        throw new Error('invalid Firestore double');
      }
      return value.doubleValue;
    case 'booleanValue':
      if (typeof value.booleanValue !== 'boolean') {
        throw new Error('invalid Firestore boolean');
      }
      return value.booleanValue;
    case 'timestampValue':
      if (typeof value.timestampValue !== 'string') {
        throw new Error('invalid Firestore timestamp');
      }
      return value.timestampValue;
    case 'nullValue':
      return null;
    case 'mapValue': {
      if (!isRecord(value.mapValue)) {
        throw new Error('invalid Firestore map');
      }
      const fields = value.mapValue.fields;
      return decodeFields(fields === undefined ? {} : fields);
    }
    case 'arrayValue': {
      if (!isRecord(value.arrayValue)) {
        throw new Error('invalid Firestore array');
      }
      const values = value.arrayValue.values;
      if (values === undefined) {
        return [];
      }
      if (!Array.isArray(values)) {
        throw new Error('invalid Firestore array');
      }
      return values.map((entry) => decodeFirestoreValue(entry));
    }
    default:
      throw new Error('unsupported Firestore value');
  }
}

export function decodeFields(fields: unknown): Record<string, unknown> {
  if (!isRecord(fields)) {
    throw new Error('invalid Firestore map');
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    decoded[key] = decodeFirestoreValue(value);
  }
  return decoded;
}

const DOCUMENT_PREFIX =
  'projects/thesharkrestaurant/databases/(default)/documents/';

export function isSafeDocumentId(id: string): boolean {
  if (id.length === 0 || id.length > 1500) {
    return false;
  }
  if (id === '.' || id === '..' || id.includes('..')) {
    return false;
  }
  return !/[/%:?#\\\s]/.test(id);
}

export function splitDocumentName(name: string): {
  collection: 'orders' | 'custody_shifts';
  id: string;
} {
  if (!name.startsWith(DOCUMENT_PREFIX)) {
    throw new Error('Firestore document name is invalid');
  }
  const rest = name.slice(DOCUMENT_PREFIX.length);
  const parts = rest.split('/');
  if (parts.length !== 2) {
    throw new Error('Firestore document name is invalid');
  }
  const collection = parts[0];
  const id = parts[1];
  if (
    (collection !== 'orders' && collection !== 'custody_shifts') ||
    id === undefined ||
    !isSafeDocumentId(id)
  ) {
    throw new Error('Firestore document name is invalid');
  }
  return { collection, id };
}

/** `custody_shifts/{shiftId}/transactions/{txId}` under the POS project. */
export function splitTransactionName(name: string): {
  shiftId: string;
  txId: string;
} {
  if (!name.startsWith(DOCUMENT_PREFIX)) {
    throw new Error('Firestore document name is invalid');
  }
  const parts = name.slice(DOCUMENT_PREFIX.length).split('/');
  if (parts.length !== 4) {
    throw new Error('Firestore document name is invalid');
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
    throw new Error('Firestore document name is invalid');
  }
  return { shiftId, txId };
}
