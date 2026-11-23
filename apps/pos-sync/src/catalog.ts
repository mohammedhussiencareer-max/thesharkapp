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

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class MalformedCatalogFieldError extends Error {}

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
    throw new MalformedCatalogFieldError('expected Firestore stringValue');
  }
  return value.stringValue;
}

function readRequiredTrimmedString(value: unknown): string {
  if (value === undefined || isNullValue(value)) {
    throw new MalformedCatalogFieldError('missing required string');
  }
  const trimmed = readStringValue(value).trim();
  if (trimmed.length === 0) {
    throw new MalformedCatalogFieldError('blank required string');
  }
  return trimmed;
}

function readMapFields(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !isOnlyKey(value, 'mapValue') ||
    !isRecord(value.mapValue)
  ) {
    throw new MalformedCatalogFieldError('expected Firestore mapValue');
  }
  for (const key of Object.keys(value.mapValue)) {
    if (key !== 'fields') {
      throw new MalformedCatalogFieldError('unexpected mapValue key');
    }
  }
  const fields = value.mapValue.fields;
  if (fields === undefined) {
    return {};
  }
  if (!isRecord(fields)) {
    throw new MalformedCatalogFieldError('invalid mapValue.fields');
  }
  return fields;
}

function readArrayValues(value: unknown): unknown[] {
  if (
    !isRecord(value) ||
    !isOnlyKey(value, 'arrayValue') ||
    !isRecord(value.arrayValue)
  ) {
    throw new MalformedCatalogFieldError('expected Firestore arrayValue');
  }
  for (const key of Object.keys(value.arrayValue)) {
    if (key !== 'values') {
      throw new MalformedCatalogFieldError('unexpected arrayValue key');
    }
  }
  const values = value.arrayValue.values;
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new MalformedCatalogFieldError('invalid arrayValue.values');
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
    const rawName = field(sizeFields, 'name');
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
    if (label.length === 0 || RESERVED_KEYS.has(label)) {
      throw new MalformedCatalogFieldError('invalid shared option label');
    }
    if (labels.has(label)) {
      throw new MalformedCatalogFieldError('duplicate shared option label');
    }
    const groupId = readStringValue(rawGroupId);
    if (!isSafeCatalogDocumentId(groupId)) {
      throw new MalformedCatalogFieldError('unsafe shared option group id');
    }
    labels.add(label);
    ids.add(groupId);
  }
  return [...ids].sort(compareId);
}

function readOptionValues(raw: unknown): string[] {
  const entries = readArrayValues(raw);
  const values = new Set<string>();
  for (const entry of entries) {
    const entryFields = readMapFields(entry);
    values.add(readRequiredTrimmedString(field(entryFields, 'value')));
  }
  return [...values].sort(compareId);
}

/**
 * Preserves every inline option group on the item (including copies of shared
 * groups) so item-scoped option subjects remain available even when the text
 * matches a global option group value. Labels stay exactly as stored.
 * Firestore map keys are unique, so byte-identical duplicate labels cannot
 * occur in a Firestore document; the duplicate check is only a defensive
 * guard for non-Firestore input.
 */
function readItemOptionGroups(raw: unknown): Record<string, string[]> {
  if (raw === undefined || isNullValue(raw)) {
    return {};
  }
  const mapFields = readMapFields(raw);
  const seenLabels = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const [label, rawGroup] of Object.entries(mapFields)) {
    if (label.length === 0 || RESERVED_KEYS.has(label)) {
      throw new MalformedCatalogFieldError('invalid option group label');
    }
    if (seenLabels.has(label)) {
      throw new MalformedCatalogFieldError('duplicate option group label');
    }
    seenLabels.add(label);
    groups.set(label, readOptionValues(rawGroup));
  }
  const sorted: Record<string, string[]> = {};
  for (const label of [...groups.keys()].sort(compareId)) {
    const values = groups.get(label);
    if (values !== undefined) {
      sorted[label] = values;
    }
  }
  return sorted;
}

function normalizedHashBody(item: StoredCatalogItem): StoredCatalogItem {
  const sizes = [...item.sizes].sort((left, right) =>
    compareId(canonicalJson(left.size_key), canonicalJson(right.size_key)),
  );
  const groups: Record<string, string[]> = {};
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
    throw new Error('invalid catalog item document name');
  }
  const { collection, id: posItemId } = splitDocumentName(document.name);
  if (collection !== 'items') {
    throw new Error('invalid catalog item document name');
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
    const name = readRequiredTrimmedString(field(document.fields, 'name'));
    const sizes = readSizes(field(document.fields, 'sizes'));
    const sharedOptionGroupIds = readSharedOptionGroupIds(
      field(document.fields, 'sharedOptionGroupIds'),
    );
    const itemOptionGroups = readItemOptionGroups(
      field(document.fields, 'options'),
    );
    const stored: StoredCatalogItem = {
      pos_item_id: posItemId,
      name,
      sizes,
      item_option_groups: itemOptionGroups,
      shared_option_group_ids: sharedOptionGroupIds,
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
    throw new Error('invalid catalog option group document name');
  }
  const { collection, id: groupId } = splitDocumentName(document.name);
  if (collection !== 'optionGroups') {
    throw new Error('invalid catalog option group document name');
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
    const name = readRequiredTrimmedString(field(document.fields, 'name'));
    const rawValues = field(document.fields, 'values');
    const values =
      rawValues === undefined || isNullValue(rawValues)
        ? []
        : readOptionValues(rawValues);
    return {
      outcome: 'accepted',
      option_group: {
        group_id: groupId,
        name,
        values,
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
      throw new Error('duplicate catalog item id');
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
      throw new Error('duplicate catalog option group id');
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
