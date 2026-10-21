/** PostgREST `db-max-rows` is 1000, so a single response can hide the rest. */
export const pageSize = 1000;

/** Fail closed rather than return a silently truncated list. */
export const maxPages = 50;

export class PageCapError extends Error {
  constructor() {
    super(`stopped after ${maxPages} full pages of ${pageSize}`);
    this.name = 'PageCapError';
  }
}

/**
 * Read every row by `.range(from, to)`.
 * The caller orders by a unique key whose value never changes (an id or an
 * insert time plus id), on tables whose rows are never deleted. A row inserted
 * by another session while paging can then only push later rows forward, so a
 * row can repeat across pages but never be skipped; repeats are dropped by
 * `keyOf`. Sort for display after reading, not by a column that can change.
 * A short page ends the read. Fifty full pages throw instead of returning them.
 */
export async function fetchAllPages<T>(
  load: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
  keyOf: (row: T) => string,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await load(from, to);
    if (error instanceof Error) throw error;
    if (error) throw new Error('page read failed');
    const batch = data ?? [];
    for (const row of batch) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (batch.length < pageSize) return rows;
  }
  throw new PageCapError();
}
