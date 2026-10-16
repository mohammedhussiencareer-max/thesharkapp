/** Normalize a Firestore timestamp to UTC with microsecond precision. */
export function normalizeTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d{1,9}))?Z$/.exec(
    value,
  );
  if (!match) {
    throw new Error('invalid timestamp');
  }
  const base = match[1];
  if (base === undefined) {
    throw new Error('invalid timestamp');
  }
  const micros = `${match[3] ?? ''}000000`.slice(0, 6);
  const iso = `${base}.${micros}Z`;
  if (!Number.isFinite(Date.parse(iso))) {
    throw new Error('invalid timestamp');
  }
  return iso;
}
