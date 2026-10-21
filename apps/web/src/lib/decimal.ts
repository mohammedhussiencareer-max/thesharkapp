/** Exact decimal text from a PostgREST `::text` cast. Rejects JSON numbers. */
export function exactDecimal(value: unknown, invalidMessage: string): string {
  if (typeof value !== 'string') throw new Error(invalidMessage);
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(invalidMessage);
  return text;
}

/** Same as {@link exactDecimal}, and SQL null stays null. */
export function exactDecimalOrNull(
  value: unknown,
  invalidMessage: string,
): string | null {
  if (value === null) return null;
  return exactDecimal(value, invalidMessage);
}
