/**
 * POS catalog field names (Phase 7 P7-1, field-name discovery).
 *
 * Discovered with read-only GETs on the POS `items` (210 documents) and
 * `optionGroups` (3 documents) collections. Only field names and value kinds
 * were collected; no document body, price, or customer value was read into the
 * repository. No customer-shaped field exists in either collection.
 *
 * Shape notes for the catalog parser (P7-2):
 * - An item has no active flag. Presence in a catalog read is the only signal;
 *   an item missing from a later read is marked absent, never deleted.
 * - `sizes` is an array of maps keyed by `name`. Every item had at least one
 *   size at discovery time; the parser still maps an empty list to `["none"]`.
 * - `options` is a map keyed by option-group label. Each value is an array of
 *   option maps keyed by `value`. For shared groups the label equals the
 *   group document's `name`, and `sharedOptionGroupIds[label]` holds the
 *   `optionGroups` document id. A label without a shared id is an item-local
 *   group.
 * - Document id and `updateTime` come from the document envelope, not from
 *   `fields`.
 */

/** Item fields the parser may read. Paths use `[]` for array elements and `<label>` for map keys. */
export const CATALOG_ITEM_FIELDS = [
  'name',
  'sizes[].name',
  'options.<label>[].value',
  'sharedOptionGroupIds.<label>',
] as const;

/** Option-group fields the parser may read. */
export const CATALOG_OPTION_GROUP_FIELDS = ['name', 'values[].value'] as const;

/**
 * Fields present in the POS catalog that the parser must never read or store:
 * prices and costs, pricing rules, the POS's own recipes, and display data.
 */
export const CATALOG_REJECTED_FIELDS = [
  'categoryId',
  'description',
  'imageUrl',
  'name_lowercase',
  'pluCode',
  'pricingType',
  'scaleSizeName',
  'weightedUnit',
  'sizes[].costPrice',
  'sizes[].price',
  'sizes[].pricingBaseQuantity',
  'sizes[].recipe',
  'options.<label>[].costPrice',
  'options.<label>[].price',
  'options.<label>[].pricingBaseQuantity',
  'options.<label>[].pricingType',
  'options.<label>[].recipe',
  'values[].costPrice',
  'values[].price',
  'values[].pricingBaseQuantity',
  'values[].pricingType',
  'values[].recipe',
] as const;

/** A key that looks like money or a pricing rule is refused wherever it appears. */
export const PRICE_SHAPED_KEY = /price|cost|amount|total|pricing/i;

/** A key that looks like a person or contact is refused, and the whole document is rejected. */
export const CUSTOMER_SHAPED_KEY =
  /customer|client|phone|mobile|email|address|employee|cashier|waiter|guest/i;

function lastSegment(path: string): string {
  const parts = path.replace(/\[\]/g, '').split('.');
  return parts[parts.length - 1] ?? path;
}

/** True when a field path ends in a price-shaped key. */
export function isPriceShapedPath(path: string): boolean {
  return PRICE_SHAPED_KEY.test(lastSegment(path));
}

/** True when any segment of a field path is customer-shaped. */
export function isCustomerShapedPath(path: string): boolean {
  return path
    .replace(/\[\]/g, '')
    .split('.')
    .some((segment) => CUSTOMER_SHAPED_KEY.test(segment));
}
