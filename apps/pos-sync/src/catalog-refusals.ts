import { PosSyncError } from './safe-error.ts';
import { isRecord } from './decode.ts';

/**
 * Schema-key detectors for the POS catalog parser (Phase 7 P7-2).
 *
 * Applied ONLY to schema keys, never to dynamic data labels under `options` or
 * `sharedOptionGroupIds` (see `catalog-allowlist.ts`). Each original object key
 * is tested directly rather than splitting on dots.
 */
export const PRICE_SHAPED_KEY =
  /price|cost|amount|total|pricing|fee|charge|discount|tax|tip/i;

export const CUSTOMER_SHAPED_KEY =
  /customer|client|phone|mobile|email|address|employee|cashier|waiter|guest|recipient|contact/i;

export const MAX_CATALOG_WALK_DEPTH = 32;

/**
 * Firestore REST scalar value wrapper keys whose values are leaf primitives.
 * The customer-key scan inspects only keys and structural wrappers
 * (`mapValue.fields`, `arrayValue.values`) and never reads these scalar leaves.
 */
const FIRESTORE_SCALAR_VALUE_KEYS = new Set([
  'nullValue',
  'booleanValue',
  'integerValue',
  'doubleValue',
  'timestampValue',
  'stringValue',
  'bytesValue',
  'referenceValue',
  'geoPointValue',
]);

const FIRESTORE_VALUE_KEYS = new Set([
  ...FIRESTORE_SCALAR_VALUE_KEYS,
  'mapValue',
  'arrayValue',
]);

export type CatalogCollection = 'items' | 'optionGroups';

/** True when an original schema key is price-shaped. */
export function isPriceShapedKey(key: string): boolean {
  return PRICE_SHAPED_KEY.test(key);
}

/** True when an original schema key is customer-shaped. */
export function isCustomerShapedKey(key: string): boolean {
  return CUSTOMER_SHAPED_KEY.test(key);
}

function walkArbitraryForCustomerKey(value: unknown, depth: number): boolean {
  if (depth > MAX_CATALOG_WALK_DEPTH) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => walkArbitraryForCustomerKey(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (
      isCustomerShapedKey(key) ||
      walkArbitraryForCustomerKey(value[key], depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

function walkFirestoreValueForCustomerKey(
  value: unknown,
  dynamicLabelMap: boolean,
  depth: number,
): boolean {
  if (depth > MAX_CATALOG_WALK_DEPTH) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      walkFirestoreValueForCustomerKey(entry, false, depth + 1),
    );
  }
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const onlyKey = keys[0];
    if (onlyKey !== undefined && FIRESTORE_SCALAR_VALUE_KEYS.has(onlyKey)) {
      return false;
    }
    if (onlyKey === 'mapValue') {
      const mapValue = value.mapValue;
      if (!isRecord(mapValue)) {
        return true;
      }
      const mapKeys = Object.keys(mapValue);
      if (mapKeys.some((mapKey) => mapKey !== 'fields')) {
        return true;
      }
      if (mapKeys.length === 0) {
        return false;
      }
      const mapFields = mapValue.fields;
      if (mapFields === undefined) {
        return false;
      }
      if (!isRecord(mapFields)) {
        return true;
      }
      return walkFirestoreFieldsForCustomerKey(
        mapFields,
        false,
        dynamicLabelMap,
        depth + 1,
      );
    }
    if (onlyKey === 'arrayValue') {
      const arrayValue = value.arrayValue;
      if (!isRecord(arrayValue)) {
        return true;
      }
      const arrKeys = Object.keys(arrayValue);
      if (arrKeys.some((arrKey) => arrKey !== 'values')) {
        return true;
      }
      if (arrKeys.length === 0) {
        return false;
      }
      const arrValues = arrayValue.values;
      if (arrValues === undefined) {
        return false;
      }
      if (!Array.isArray(arrValues)) {
        return true;
      }
      for (const entry of arrValues) {
        if (walkFirestoreValueForCustomerKey(entry, false, depth + 1)) {
          return true;
        }
      }
      return false;
    }
  }
  // Reject mixed scalar, map, or array wrappers by their keys without opening payloads.
  if (keys.some((key) => FIRESTORE_VALUE_KEYS.has(key))) {
    return true;
  }
  for (const key of keys) {
    if (
      isCustomerShapedKey(key) ||
      walkArbitraryForCustomerKey(value[key], depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

function walkFirestoreFieldsForCustomerKey(
  fields: Record<string, unknown>,
  isItemRoot: boolean,
  keysAreLabels: boolean,
  depth: number,
): boolean {
  if (depth > MAX_CATALOG_WALK_DEPTH) {
    return true;
  }
  for (const key of Object.keys(fields)) {
    if (!keysAreLabels && isCustomerShapedKey(key)) {
      return true;
    }
    const childIsLabelMap =
      isItemRoot && (key === 'options' || key === 'sharedOptionGroupIds');
    if (walkFirestoreValueForCustomerKey(fields[key], childIsLabelMap, depth)) {
      return true;
    }
  }
  return false;
}

/**
 * Scans a raw catalog Firestore document (all top-level properties and nested
 * fields) for customer-shaped schema keys. Dynamic map labels under an item's
 * `options` and `sharedOptionGroupIds` are treated as data labels, not schema
 * keys, while nested keys inside their values are still scanned as schema keys.
 * Depth counts real map/array nesting levels rather than REST wrapper objects.
 */
export function hasCustomerShapedSchemaKey(
  rawDocument: Record<string, unknown>,
  collection: CatalogCollection,
): boolean {
  for (const key of Object.keys(rawDocument)) {
    if (isCustomerShapedKey(key)) {
      return true;
    }
    const value = rawDocument[key];
    if (key === 'fields' && isRecord(value)) {
      if (
        walkFirestoreFieldsForCustomerKey(
          value,
          collection === 'items',
          false,
          0,
        )
      ) {
        return true;
      }
    } else if (walkArbitraryForCustomerKey(value, 1)) {
      return true;
    }
  }
  return false;
}

const ARRAY_STEP = Symbol('array-step');
const LABEL_STEP = Symbol('label-step');

type PathStep = string | typeof ARRAY_STEP | typeof LABEL_STEP;

function isItemOptionGroupLabelMapPath(segments: readonly PathStep[]): boolean {
  return (
    segments.length === 3 &&
    segments[0] === 'items' &&
    segments[1] === ARRAY_STEP &&
    segments[2] === 'item_option_groups'
  );
}

function walkPayloadForPriceKey(
  value: unknown,
  segments: readonly PathStep[],
  depth: number,
): void {
  if (depth > MAX_CATALOG_WALK_DEPTH) {
    throw new PosSyncError('catalogExcessiveNesting');
  }
  if (Array.isArray(value)) {
    const nextSegments: readonly PathStep[] = [...segments, ARRAY_STEP];
    for (const entry of value) {
      walkPayloadForPriceKey(entry, nextSegments, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const keysAreLabels = isItemOptionGroupLabelMapPath(segments);
  for (const [key, child] of Object.entries(value)) {
    if (!keysAreLabels && isPriceShapedKey(key)) {
      throw new PosSyncError('catalogPriceKey');
    }
    walkPayloadForPriceKey(
      child,
      [...segments, keysAreLabels ? LABEL_STEP : key],
      depth + 1,
    );
  }
}

/**
 * Refuses any outgoing catalog payload containing a price-shaped schema key at
 * any depth. Dynamic option-group labels under `items[].item_option_groups` are
 * data labels, not schema keys; any nested schema keys inside their values are
 * still checked.
 */
export function assertNoPriceShapedKeys(payload: unknown): void {
  walkPayloadForPriceKey(payload, [], 0);
}
