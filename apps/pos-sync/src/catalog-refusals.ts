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

export type CatalogCollection = 'items' | 'optionGroups';

/** True when an original schema key is price-shaped. */
export function isPriceShapedKey(key: string): boolean {
  return PRICE_SHAPED_KEY.test(key);
}

/** True when an original schema key is customer-shaped. */
export function isCustomerShapedKey(key: string): boolean {
  return CUSTOMER_SHAPED_KEY.test(key);
}

function isOnlyKey(record: Record<string, unknown>, key: string): boolean {
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0] === key;
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
  for (const [key, child] of Object.entries(value)) {
    if (
      isCustomerShapedKey(key) ||
      walkArbitraryForCustomerKey(child, depth + 1)
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
  if (isOnlyKey(value, 'mapValue') && isRecord(value.mapValue)) {
    for (const [mapKey, mapChild] of Object.entries(value.mapValue)) {
      if (mapKey === 'fields' && isRecord(mapChild)) {
        if (
          walkFirestoreFieldsForCustomerKey(
            mapChild,
            false,
            dynamicLabelMap,
            depth + 1,
          )
        ) {
          return true;
        }
      } else if (
        isCustomerShapedKey(mapKey) ||
        walkArbitraryForCustomerKey(mapChild, depth + 1)
      ) {
        return true;
      }
    }
    return false;
  }
  if (isOnlyKey(value, 'arrayValue') && isRecord(value.arrayValue)) {
    for (const [arrKey, arrChild] of Object.entries(value.arrayValue)) {
      if (arrKey === 'values' && Array.isArray(arrChild)) {
        for (const entry of arrChild) {
          if (walkFirestoreValueForCustomerKey(entry, false, depth + 1)) {
            return true;
          }
        }
      } else if (
        isCustomerShapedKey(arrKey) ||
        walkArbitraryForCustomerKey(arrChild, depth + 1)
      ) {
        return true;
      }
    }
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      isCustomerShapedKey(key) ||
      walkArbitraryForCustomerKey(child, depth + 1)
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
  for (const [key, value] of Object.entries(fields)) {
    if (!keysAreLabels && isCustomerShapedKey(key)) {
      return true;
    }
    const childIsLabelMap =
      isItemRoot && (key === 'options' || key === 'sharedOptionGroupIds');
    if (walkFirestoreValueForCustomerKey(value, childIsLabelMap, depth + 1)) {
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
 */
export function hasCustomerShapedSchemaKey(
  rawDocument: Record<string, unknown>,
  collection: CatalogCollection,
): boolean {
  for (const [key, value] of Object.entries(rawDocument)) {
    if (isCustomerShapedKey(key)) {
      return true;
    }
    if (key === 'fields' && isRecord(value)) {
      if (
        walkFirestoreFieldsForCustomerKey(
          value,
          collection === 'items',
          false,
          1,
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

function isItemOptionGroupLabelMapPath(segments: readonly string[]): boolean {
  return (
    segments.length === 3 &&
    segments[0] === 'items' &&
    segments[1] === '[]' &&
    segments[2] === 'item_option_groups'
  );
}

function walkPayloadForPriceKey(
  value: unknown,
  segments: readonly string[],
  depth: number,
): void {
  if (depth > MAX_CATALOG_WALK_DEPTH) {
    throw new Error('Catalog payload refused: excessive nesting');
  }
  if (Array.isArray(value)) {
    const nextSegments = [...segments, '[]'];
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
      throw new Error('Catalog payload refused: price-shaped key');
    }
    walkPayloadForPriceKey(
      child,
      [...segments, keysAreLabels ? '<label>' : key],
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
