import { PosSyncError } from './safe-error.ts';
import {
  CATALOG_ITEM_FIELDS,
  CATALOG_OPTION_GROUP_FIELDS,
} from './catalog-allowlist.ts';
import {
  assertNoPriceShapedKeys,
  hasCustomerShapedSchemaKey,
} from './catalog-refusals.ts';
import {
  isRecord,
  isSafeCatalogDocumentId,
  splitDocumentName,
} from './decode.ts';
import { canonicalJson, compareId, sha256Canonical } from './hash.ts';
import { normalizeOptionalText } from './mapper.ts';
import type { FirestoreRestDocument } from './pos-firestore.ts';
import { normalizeCatalogTimestamp } from './time.ts';

export { assertNoPriceShapedKeys } from './catalog-refusals.ts';

export type PosSizeKey = readonly ['none'] | readonly ['name', string];

export type PosCatalogSize = {
  size_name: string | null;
  size_key: PosSizeKey;
};

export type StoredCatalogItem = {
  pos_item_id: string;
  name: string;
  sizes: PosCatalogSize[];
  item_option_groups: Record<string, string[]>;
  shared_option_group_ids: string[];
};

export type PosCatalogItemIngest = StoredCatalogItem & {
  update_time: string;
  content_hash: string;
};

export type PosCatalogOptionGroupIngest = {
  group_id: string;
  name: string;
  values: string[];
};

export type PosCatalogItemPresence = {
  pos_item_id: string;
  outcome: 'accepted' | 'rejected';
};

export type PosCatalogOptionGroupPresence = {
  group_id: string;
  outcome: 'accepted' | 'rejected';
};

export type PosCatalogIngestPayload = {
  items: PosCatalogItemIngest[];
  option_groups: PosCatalogOptionGroupIngest[];
  presence: PosCatalogItemPresence[];
  option_group_presence: PosCatalogOptionGroupPresence[];
};

export type ParsedCatalogItem =
  | { outcome: 'accepted'; item: PosCatalogItemIngest }
  | { outcome: 'rejected'; pos_item_id: string };

export type ParsedCatalogOptionGroup =
  | { outcome: 'accepted'; option_group: PosCatalogOptionGroupIngest }
  | { outcome: 'rejected'; group_id: string };

export type CatalogFieldSelectors = {
  itemName: string;
  sizesArray: string;
  sizeName: string;
  optionsMap: string;
  optionValue: string;
  sharedOptionGroupIdsMap: string;
  groupName: string;
  groupValuesArray: string;
  groupOptionValue: string;
};

const SCALAR_PATH = /^([A-Za-z_]\w*)$/;
const ARRAY_FIELD_PATH = /^([A-Za-z_]\w*)\[\]\.([A-Za-z_]\w*)$/;
const LABELED_ARRAY_FIELD_PATH =
  /^([A-Za-z_]\w*)\.<label>\[\]\.([A-Za-z_]\w*)$/;
const LABELED_SCALAR_PATH = /^([A-Za-z_]\w*)\.<label>$/;

/**
 * Derives parser field selectors directly from `CATALOG_ITEM_FIELDS` and
 * `CATALOG_OPTION_GROUP_FIELDS`, failing fast on any allowlist drift.
 */
export function resolveCatalogFieldSelectors(
  itemFields: readonly string[],
  optionGroupFields: readonly string[],
): CatalogFieldSelectors {
  let itemName: string | undefined;
  let sizesArray: string | undefined;
  let sizeName: string | undefined;
  let optionsMap: string | undefined;
  let optionValue: string | undefined;
  let sharedOptionGroupIdsMap: string | undefined;

  for (const path of itemFields) {
    const scalar = SCALAR_PATH.exec(path);
    if (scalar?.[1] !== undefined) {
      if (itemName !== undefined) {
        throw new PosSyncError('unexpectedCatalogItemPath');
      }
      itemName = scalar[1];
      continue;
    }
    const arrayField = ARRAY_FIELD_PATH.exec(path);
    if (arrayField?.[1] !== undefined && arrayField[2] !== undefined) {
      if (sizesArray !== undefined) {
        throw new PosSyncError('unexpectedCatalogItemPath');
      }
      sizesArray = arrayField[1];
      sizeName = arrayField[2];
      continue;
    }
    const labeledArray = LABELED_ARRAY_FIELD_PATH.exec(path);
    if (labeledArray?.[1] !== undefined && labeledArray[2] !== undefined) {
      if (optionsMap !== undefined) {
        throw new PosSyncError('unexpectedCatalogItemPath');
      }
      optionsMap = labeledArray[1];
      optionValue = labeledArray[2];
      continue;
    }
    const labeledScalar = LABELED_SCALAR_PATH.exec(path);
    if (labeledScalar?.[1] !== undefined) {
      if (sharedOptionGroupIdsMap !== undefined) {
        throw new PosSyncError('unexpectedCatalogItemPath');
      }
      sharedOptionGroupIdsMap = labeledScalar[1];
      continue;
    }
    throw new PosSyncError('unsupportedCatalogItemPath');
  }

  let groupName: string | undefined;
  let groupValuesArray: string | undefined;
  let groupOptionValue: string | undefined;

  for (const path of optionGroupFields) {
    const scalar = SCALAR_PATH.exec(path);
    if (scalar?.[1] !== undefined) {
      if (groupName !== undefined) {
        throw new PosSyncError('unexpectedCatalogGroupPath');
      }
      groupName = scalar[1];
      continue;
    }
    const arrayField = ARRAY_FIELD_PATH.exec(path);
    if (arrayField?.[1] !== undefined && arrayField[2] !== undefined) {
      if (groupValuesArray !== undefined) {
        throw new PosSyncError('unexpectedCatalogGroupPath');
      }
      groupValuesArray = arrayField[1];
      groupOptionValue = arrayField[2];
      continue;
    }
    throw new PosSyncError('unsupportedCatalogGroupPath');
  }

  if (
    itemName === undefined ||
    sizesArray === undefined ||
    sizeName === undefined ||
    optionsMap === undefined ||
    optionValue === undefined ||
    sharedOptionGroupIdsMap === undefined ||
    groupName === undefined ||
    groupValuesArray === undefined ||
    groupOptionValue === undefined
  ) {
    throw new PosSyncError('catalogSelectorMissing');
  }

  return {
    itemName,
    sizesArray,
    sizeName,
    optionsMap,
    optionValue,
    sharedOptionGroupIdsMap,
    groupName,
    groupValuesArray,
    groupOptionValue,
  };
}

const SELECTORS = resolveCatalogFieldSelectors(
  CATALOG_ITEM_FIELDS,
  CATALOG_OPTION_GROUP_FIELDS,
);

class MalformedCatalogFieldError extends PosSyncError {}

function btrimSpaces(value: string): string {
  return value.replace(/^ +| +$/g, '');
}

/**
 * Canonical size key matching `app.pos_size_key(text)` in
 * `supabase/migrations/20261106000000_pos_mapping.sql:418`.
 * PostgreSQL `btrim(text)` removes leading and trailing ASCII spaces only.
 */
export function posSizeKey(sizeName: string | null | undefined): PosSizeKey {
  if (sizeName === null || sizeName === undefined) {
    return ['none'];
  }
  const trimmed = btrimSpaces(sizeName);
  if (trimmed.length === 0) {
    return ['none'];
  }
  return ['name', trimmed];
}

function field(fields: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(fields, key)
    ? fields[key]
    : undefined;
}

function isOnlyKey(value: Record<string, unknown>, key: string): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key;
}

function isNullValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOnlyKey(value, 'nullValue') &&
    (value.nullValue === null || value.nullValue === 'NULL_VALUE')
  );
}

function readStringValue(value: unknown): string {
  if (
    !isRecord(value) ||
    !isOnlyKey(value, 'stringValue') ||
    typeof value.stringValue !== 'string'
  ) {
    throw new MalformedCatalogFieldError('catalogExpectedString');
  }
  // PostgreSQL jsonb rejects U+0000 in stored strings; reject only this doc.
  if (value.stringValue.includes('\0')) {
    throw new MalformedCatalogFieldError('catalogStringContainsNul');
  }
  return value.stringValue;
}

function readRequiredTrimmedString(value: unknown): string {
  if (value === undefined || isNullValue(value)) {
    throw new MalformedCatalogFieldError('catalogStringMissing');
  }
  const trimmed = readStringValue(value).trim();
  if (trimmed.length === 0) {
    throw new MalformedCatalogFieldError('catalogStringBlank');
  }
  return trimmed;
}

function readMapFields(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !isOnlyKey(value, 'mapValue') ||
    !isRecord(value.mapValue)
  ) {
    throw new MalformedCatalogFieldError('catalogExpectedMap');
  }
  for (const key of Object.keys(value.mapValue)) {
    if (key !== 'fields') {
      throw new MalformedCatalogFieldError('catalogUnexpectedMapKey');
    }
  }
  const fields = value.mapValue.fields;
  if (fields === undefined) {
    return {};
  }
  if (!isRecord(fields)) {
    throw new MalformedCatalogFieldError('catalogInvalidMapFields');
  }
  return fields;
}

function readArrayValues(value: unknown): unknown[] {
  if (
    !isRecord(value) ||
    !isOnlyKey(value, 'arrayValue') ||
    !isRecord(value.arrayValue)
  ) {
    throw new MalformedCatalogFieldError('catalogExpectedArray');
  }
  for (const key of Object.keys(value.arrayValue)) {
    if (key !== 'values') {
      throw new MalformedCatalogFieldError('catalogUnexpectedArrayKey');
    }
  }
  const values = value.arrayValue.values;
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new MalformedCatalogFieldError('catalogInvalidArrayValues');
  }
  return values;
}

function readSizes(raw: unknown): PosCatalogSize[] {
  if (raw === undefined || isNullValue(raw)) {
    return [{ size_name: null, size_key: ['none'] }];
  }
  const entries = readArrayValues(raw);
  if (entries.length === 0) {
    return [{ size_name: null, size_key: ['none'] }];
  }
  const byKey = new Map<string, PosCatalogSize>();
  for (const entry of entries) {
    const sizeFields = readMapFields(entry);
    const rawName = field(sizeFields, SELECTORS.sizeName);
    let sizeKey: PosSizeKey;
    if (rawName === undefined || isNullValue(rawName)) {
      sizeKey = posSizeKey(null);
    } else {
      // Apply the exact same JS trim normalization as mapper.ts before pos_size_key.
      sizeKey = posSizeKey(normalizeOptionalText(readStringValue(rawName)));
    }
    const sizeName = sizeKey[0] === 'name' ? sizeKey[1] : null;
    const keyText = canonicalJson(sizeKey);
    if (!byKey.has(keyText)) {
      byKey.set(keyText, { size_name: sizeName, size_key: sizeKey });
    }
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareId(left, right))
    .map(([, size]) => size);
}

function readSharedOptionGroupIds(raw: unknown): string[] {
  if (raw === undefined || isNullValue(raw)) {
    return [];
  }
  const mapFields = readMapFields(raw);
  const labels = new Set<string>();
  const ids = new Set<string>();
  // Exact keys. Trimming would treat distinct labels as one group and reject the item.
  // Firestore map keys are unique, so byte-identical duplicate labels cannot
  // occur in a Firestore document; this duplicate check is only a defensive
  // guard for non-Firestore input.
  for (const [label, rawGroupId] of Object.entries(mapFields)) {
    if (label.length === 0 || label.includes('\0')) {
      throw new MalformedCatalogFieldError('catalogInvalidSharedOptionLabel');
    }
    if (labels.has(label)) {
      throw new MalformedCatalogFieldError('catalogDuplicateSharedOptionLabel');
    }
    const groupId = readStringValue(rawGroupId);
    if (!isSafeCatalogDocumentId(groupId)) {
      throw new MalformedCatalogFieldError('catalogUnsafeSharedOptionGroupId');
    }
    labels.add(label);
    ids.add(groupId);
  }
  return [...ids].sort(compareId);
}

function readOptionValues(raw: unknown, valueField: string): string[] {
  const entries = readArrayValues(raw);
  const values = new Set<string>();
  for (const entry of entries) {
    const entryFields = readMapFields(entry);
    values.add(readRequiredTrimmedString(field(entryFields, valueField)));
  }
  return [...values].sort(compareId);
}

/**
 * Preserves every inline option group on the item (including copies of shared
 * groups) so item-scoped option subjects remain available even when the text
 * matches a global option group value. Uses a null-prototype object so labels
 * like `constructor`, `prototype`, and `__proto__` survive safely.
 */
function readItemOptionGroups(raw: unknown): Record<string, string[]> {
  const sorted = Object.create(null) as Record<string, string[]>;
  if (raw === undefined || isNullValue(raw)) {
    return sorted;
  }
  const mapFields = readMapFields(raw);
  const seenLabels = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const [label, rawGroup] of Object.entries(mapFields)) {
    if (label.length === 0 || label.includes('\0')) {
      throw new MalformedCatalogFieldError('catalogInvalidOptionGroupLabel');
    }
    if (seenLabels.has(label)) {
      throw new MalformedCatalogFieldError('catalogDuplicateOptionGroupLabel');
    }
    seenLabels.add(label);
    groups.set(label, readOptionValues(rawGroup, SELECTORS.optionValue));
  }
  for (const label of [...groups.keys()].sort(compareId)) {
    const values = groups.get(label);
    if (values !== undefined) {
      sorted[label] = values;
    }
  }
  return sorted;
}

/** Projects only the fields listed in `CATALOG_ITEM_FIELDS`. */
export function projectAllowedItemFields(fields: Record<string, unknown>): {
  name: string;
  sizes: PosCatalogSize[];
  item_option_groups: Record<string, string[]>;
  shared_option_group_ids: string[];
} {
  const name = readRequiredTrimmedString(field(fields, SELECTORS.itemName));
  const sizes = readSizes(field(fields, SELECTORS.sizesArray));
  const shared_option_group_ids = readSharedOptionGroupIds(
    field(fields, SELECTORS.sharedOptionGroupIdsMap),
  );
  const item_option_groups = readItemOptionGroups(
    field(fields, SELECTORS.optionsMap),
  );
  return {
    name,
    sizes,
    item_option_groups,
    shared_option_group_ids,
  };
}

/** Projects only the fields listed in `CATALOG_OPTION_GROUP_FIELDS`. */
export function projectAllowedOptionGroupFields(
  fields: Record<string, unknown>,
): {
  name: string;
  values: string[];
} {
  const name = readRequiredTrimmedString(field(fields, SELECTORS.groupName));
  const rawValues = field(fields, SELECTORS.groupValuesArray);
  const values =
    rawValues === undefined || isNullValue(rawValues)
      ? []
      : readOptionValues(rawValues, SELECTORS.groupOptionValue);
  return { name, values };
}

function normalizedHashBody(item: StoredCatalogItem): StoredCatalogItem {
  const sizes = [...item.sizes].sort((left, right) =>
    compareId(canonicalJson(left.size_key), canonicalJson(right.size_key)),
  );
  const groups = Object.create(null) as Record<string, string[]>;
  for (const label of Object.keys(item.item_option_groups).sort(compareId)) {
    const values = item.item_option_groups[label];
    if (values !== undefined) {
      groups[label] = [...values].sort(compareId);
    }
  }
  return {
    pos_item_id: item.pos_item_id,
    name: item.name,
    sizes,
    item_option_groups: groups,
    shared_option_group_ids: [...item.shared_option_group_ids].sort(compareId),
  };
}

/** SHA-256 of the stored catalog fields only. `update_time` is compared separately. */
export function catalogItemContentHash(item: StoredCatalogItem): string {
  return sha256Canonical(normalizedHashBody(item));
}

export function parseCatalogItemDocument(
  document: FirestoreRestDocument,
): ParsedCatalogItem {
  if (typeof document.name !== 'string') {
    throw new PosSyncError('invalidCatalogItemName');
  }
  const { collection, id: posItemId } = splitDocumentName(document.name);
  if (collection !== 'items') {
    throw new PosSyncError('invalidCatalogItemName');
  }
  if (
    document.rejected === true ||
    hasCustomerShapedSchemaKey(document, 'items')
  ) {
    return { outcome: 'rejected', pos_item_id: posItemId };
  }
  if (!isRecord(document.fields)) {
    return { outcome: 'rejected', pos_item_id: posItemId };
  }
  if (
    typeof document.updateTime !== 'string' ||
    document.updateTime.trim().length === 0
  ) {
    return { outcome: 'rejected', pos_item_id: posItemId };
  }
  let updateTime: string;
  try {
    updateTime = normalizeCatalogTimestamp(document.updateTime);
  } catch {
    return { outcome: 'rejected', pos_item_id: posItemId };
  }
  try {
    const projected = projectAllowedItemFields(document.fields);
    const stored: StoredCatalogItem = {
      pos_item_id: posItemId,
      ...projected,
    };
    return {
      outcome: 'accepted',
      item: {
        ...stored,
        update_time: updateTime,
        content_hash: catalogItemContentHash(stored),
      },
    };
  } catch (error) {
    if (error instanceof MalformedCatalogFieldError) {
      return { outcome: 'rejected', pos_item_id: posItemId };
    }
    throw error;
  }
}

export function parseCatalogOptionGroupDocument(
  document: FirestoreRestDocument,
): ParsedCatalogOptionGroup {
  if (typeof document.name !== 'string') {
    throw new PosSyncError('invalidCatalogOptionGroupName');
  }
  const { collection, id: groupId } = splitDocumentName(document.name);
  if (collection !== 'optionGroups') {
    throw new PosSyncError('invalidCatalogOptionGroupName');
  }
  if (
    document.rejected === true ||
    hasCustomerShapedSchemaKey(document, 'optionGroups')
  ) {
    return { outcome: 'rejected', group_id: groupId };
  }
  if (!isRecord(document.fields)) {
    return { outcome: 'rejected', group_id: groupId };
  }
  if (document.updateTime !== undefined) {
    if (
      typeof document.updateTime !== 'string' ||
      document.updateTime.trim().length === 0
    ) {
      return { outcome: 'rejected', group_id: groupId };
    }
    try {
      normalizeCatalogTimestamp(document.updateTime);
    } catch {
      return { outcome: 'rejected', group_id: groupId };
    }
  }
  try {
    const projected = projectAllowedOptionGroupFields(document.fields);
    return {
      outcome: 'accepted',
      option_group: {
        group_id: groupId,
        ...projected,
      },
    };
  } catch (error) {
    if (error instanceof MalformedCatalogFieldError) {
      return { outcome: 'rejected', group_id: groupId };
    }
    throw error;
  }
}

export function parseCatalog(
  itemDocuments: readonly FirestoreRestDocument[],
  optionGroupDocuments: readonly FirestoreRestDocument[],
): PosCatalogIngestPayload {
  const items: PosCatalogItemIngest[] = [];
  const presence: PosCatalogItemPresence[] = [];
  const seenItems = new Set<string>();
  for (const document of itemDocuments) {
    const parsed = parseCatalogItemDocument(document);
    const id =
      parsed.outcome === 'accepted'
        ? parsed.item.pos_item_id
        : parsed.pos_item_id;
    if (seenItems.has(id)) {
      throw new PosSyncError('duplicateCatalogItem');
    }
    seenItems.add(id);
    presence.push({ pos_item_id: id, outcome: parsed.outcome });
    if (parsed.outcome === 'accepted') {
      items.push(parsed.item);
    }
  }

  const optionGroups: PosCatalogOptionGroupIngest[] = [];
  const optionGroupPresence: PosCatalogOptionGroupPresence[] = [];
  const seenGroups = new Set<string>();
  for (const document of optionGroupDocuments) {
    const parsed = parseCatalogOptionGroupDocument(document);
    const id =
      parsed.outcome === 'accepted'
        ? parsed.option_group.group_id
        : parsed.group_id;
    if (seenGroups.has(id)) {
      throw new PosSyncError('duplicateCatalogOptionGroup');
    }
    seenGroups.add(id);
    optionGroupPresence.push({ group_id: id, outcome: parsed.outcome });
    if (parsed.outcome === 'accepted') {
      optionGroups.push(parsed.option_group);
    }
  }

  items.sort((left, right) => compareId(left.pos_item_id, right.pos_item_id));
  presence.sort((left, right) =>
    compareId(left.pos_item_id, right.pos_item_id),
  );
  optionGroups.sort((left, right) => compareId(left.group_id, right.group_id));
  optionGroupPresence.sort((left, right) =>
    compareId(left.group_id, right.group_id),
  );

  const payload: PosCatalogIngestPayload = {
    items,
    option_groups: optionGroups,
    presence,
    option_group_presence: optionGroupPresence,
  };
  assertNoPriceShapedKeys(payload);
  return payload;
}
