/** Mapping, policy and exception of one base subject share one token. */
export function baseSubject(posItemId: string, sizeKeyText: string): string {
  return `pos-base:${JSON.stringify([posItemId, sizeKeyText])}`;
}

/** One option subject, global or scoped. Its token is not the base token. */
export function optionSubject(
  scope: 'global' | 'item',
  posItemId: string,
  sizeKeyText: string,
  optionValue: string,
): string {
  return `pos-option:${JSON.stringify([
    scope,
    posItemId,
    sizeKeyText,
    optionValue,
  ])}`;
}
