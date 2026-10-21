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
 * The caller applies a stable total order (a unique key or key tuple) before
 * `range`, so later pages do not skip or repeat rows.
 * A short page ends the read. Fifty full pages throw instead of returning them.
 */
export async function fetchAllPages<T>(
  load: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await load(from, to);
    if (error instanceof Error) throw error;
    if (error) throw new Error('page read failed');
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new PageCapError();
}
