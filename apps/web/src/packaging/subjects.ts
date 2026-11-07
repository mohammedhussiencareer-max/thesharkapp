/** Packaging and mapping keep separate request ids, so one save does not block the other. */
export function orderTypePackagingSubject(key: string): string {
  return `packaging-order-type:${key}`;
}

export function basePackagingSubject(
  posItemId: string,
  sizeKeyText: string,
): string {
  return `packaging-base:${JSON.stringify([posItemId, sizeKeyText])}`;
}
