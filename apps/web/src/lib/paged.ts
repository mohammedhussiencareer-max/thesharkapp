/** PostgREST `max_rows` is 1000, and a shorter response is not an error. */
export const postgrestPageSize = 1000;

/** A full page at this count means the list is too large to show. */
export const postgrestMaxPages = 50;

/**
 * A list query already ordered by a unique key (or unique key tuple).
 * `range(from, to)` is inclusive and must return that same thenable builder.
 */
export type PagedQuery = {
  range: (from: number, to: number) => unknown;
};

type PageOptions = {
  pageSize?: number;
  maxPages?: number;
};

function paging(
  errorMessage: string,
  options?: PageOptions,
): { pageSize: number; maxPages: number } {
  const pageSize = options?.pageSize ?? postgrestPageSize;
  const maxPages = options?.maxPages ?? postgrestMaxPages;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1
  ) {
    throw new Error(errorMessage);
  }
  return { pageSize, maxPages };
}

function pageRows(result: unknown, errorMessage: string): unknown[] {
  if (typeof result !== 'object' || result === null) {
    throw new Error(errorMessage);
  }
  if (!('data' in result) || !('error' in result)) {
    throw new Error(errorMessage);
  }
  if (result.error !== null) throw new Error(errorMessage);
  if (!Array.isArray(result.data)) throw new Error(errorMessage);
  return result.data;
}

/**
 * Read every row of a PostgREST list.
 * Callers pass `.order()` on a unique key first, so later pages cannot skip
 * or repeat a row. A short page ends the read. A failed page or a full
 * `maxPages` run throws `errorMessage` and does not return a partial list.
 */
export async function readAllPages<Row = unknown>(
  query: PagedQuery,
  errorMessage: string,
  options?: PageOptions,
): Promise<Row[]> {
  const { pageSize, maxPages } = paging(errorMessage, options);
  const rows: Row[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    let result: unknown;
    try {
      result = await Promise.resolve(query.range(from, to));
    } catch {
      throw new Error(errorMessage);
    }
    const data = pageRows(result, errorMessage);
    if (data.length > pageSize) throw new Error(errorMessage);
    rows.push(...(data as Row[]));
    if (data.length < pageSize) return rows;
  }
  throw new Error(errorMessage);
}
