/**
 * POS catalog field names (Phase 7 P7-1, field-name discovery).
 *
 * Discovered with read-only GETs on the POS `items` (210 documents) and
 * `optionGroups` (3 documents) collections. Only field names and value kinds
 * were collected; no document body, price, or customer value was read into the
 * repository. No customer-shaped field exists in either collection.
 *
 * Shape notes for the catalog parser (P7-2):
 * - An item has no active flag. The mirror stores `active` as unknown (null).
 *   Presence in a read is the only signal: only a COMPLETE read may set
 *   `absent_at`, and only for an id with neither an accepted nor a rejected
 *   presence row. A partial read sets no absence. Nothing is deleted.
 * - `sizes` is an array of size objects; each size object has a `name` field.
 *   Every item had at least one size at discovery time; the parser still maps
 *   an empty list to `["none"]`.
 * - `options` is a map whose dynamic key is the option-group label. Each map
 *   value is an array of option objects; each option object has a `value`
 *   field. For shared groups the label equals the group document's `name`, and
 *   `sharedOptionGroupIds[label]` holds the `optionGroups` document id. A label
 *   without a shared id is an item-local group.
 * - Map keys under `options` and `sharedOptionGroupIds` are data (labels), not
 *   schema keys. Firestore masks support neither dynamic-label wildcards nor
 *   paths inside arrays. The read mask stops at those containers and the
 *   catalog decoder selects only these leaves by key.
 * - Document id and `updateTime` come from the document envelope, not from
 *   `fields`.
 */

/** Item fields the parser may read. Paths use `[]` for array elements and `<label>` for a dynamic map key. */
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
