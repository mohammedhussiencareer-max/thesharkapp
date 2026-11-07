/** Canonical text for ["none"] or ["type", label]. Spacing from Postgres does not matter. */
export function canonicalOrderTypeKey(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 1 && value[0] === 'none')
    return JSON.stringify(['none']);
  if (
    value.length === 2 &&
    value[0] === 'type' &&
    typeof value[1] === 'string' &&
    value[1].trim().length > 0
  ) {
    return JSON.stringify(['type', value[1]]);
  }
  return null;
}

export function orderTypeTitle(label: string | null): string {
  return label && label.trim().length > 0 ? label : 'من غير نوع';
}
