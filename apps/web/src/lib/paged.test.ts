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

    await expect(fetchAllPages(load)).resolves.toEqual(rows);
    expect(calls).toEqual([
      [0, pageSize - 1],
      [pageSize, pageSize * 2 - 1],
    ]);
  });

  it('stops after a full page followed by an empty page', async () => {
    const rows = Array.from({ length: pageSize }, (_, index) => index);
    const { calls, load } = pagesOf(rows);

    await expect(fetchAllPages(load)).resolves.toEqual(rows);
    expect(calls).toEqual([
      [0, pageSize - 1],
      [pageSize, pageSize * 2 - 1],
    ]);
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

    await expect(fetchAllPages(load)).rejects.toBeInstanceOf(PageCapError);
    expect(calls).toHaveLength(maxPages);
    expect(calls[maxPages - 1]).toBe((maxPages - 1) * pageSize);
  });
});
