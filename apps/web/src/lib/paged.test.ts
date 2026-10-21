import { describe, expect, it } from 'vitest';
import { fetchAllPages, maxPages, PageCapError, pageSize } from '@/lib/paged';

function pagesOf(rows: readonly number[]) {
  const calls: Array<[number, number]> = [];
  const load = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({
      data: rows.slice(from, to + 1),
      error: null,
    });
  };
  return { calls, load };
}

describe('fetchAllPages', () => {
  it('returns 1002 rows in order when the second page is short', async () => {
    const rows = Array.from({ length: pageSize + 2 }, (_, index) => index);
    const { calls, load } = pagesOf(rows);

    await expect(fetchAllPages(load, String)).resolves.toEqual(rows);
    expect(calls).toEqual([
      [0, pageSize - 1],
      [pageSize, pageSize * 2 - 1],
    ]);
  });

  it('stops after a full page followed by an empty page', async () => {
    const rows = Array.from({ length: pageSize }, (_, index) => index);
    const { calls, load } = pagesOf(rows);

    await expect(fetchAllPages(load, String)).resolves.toEqual(rows);
    expect(calls).toEqual([
      [0, pageSize - 1],
      [pageSize, pageSize * 2 - 1],
    ]);
  });

  it('drops a row repeated when another session inserts between pages', async () => {
    // Ordered by an immutable key on an append-only table: an insert that
    // sorts before the read position shifts the rest forward by one.
    const table = Array.from({ length: pageSize + 2 }, (_, index) => index + 1);
    const load = (from: number, to: number) => {
      if (from === pageSize) table.unshift(0);
      return Promise.resolve({ data: table.slice(from, to + 1), error: null });
    };

    const read = await fetchAllPages(load, String);
    expect(read).toHaveLength(pageSize + 2);
    expect(new Set(read).size).toBe(read.length);
    expect(read).toEqual(
      Array.from({ length: pageSize + 2 }, (_, index) => index + 1),
    );
  });

  it('fails closed when every page is full through the cap', async () => {
    const calls: number[] = [];
    const load = (from: number) => {
      calls.push(from);
      return Promise.resolve({
        data: Array.from({ length: pageSize }, (_, index) => from + index),
        error: null,
      });
    };

    await expect(fetchAllPages(load, String)).rejects.toBeInstanceOf(
      PageCapError,
    );
    expect(calls).toHaveLength(maxPages);
    expect(calls[maxPages - 1]).toBe((maxPages - 1) * pageSize);
  });
});
