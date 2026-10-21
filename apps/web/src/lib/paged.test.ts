import { describe, expect, it } from 'vitest';
import {
  postgrestMaxPages,
  postgrestPageSize,
  readAllPages,
} from '@/lib/paged';

const pageError = 'حصل خطأ. حاول تاني.';

function scripted(
  pages: { data: unknown; error: { message?: string } | null }[],
) {
  const ranges: { from: number; to: number }[] = [];
  let index = 0;
  const query = {
    range(from: number, to: number) {
      ranges.push({ from, to });
      const result = pages[index] ?? { data: [], error: null };
      index += 1;
      return Promise.resolve(result);
    },
  };
  return { query, ranges };
}

function numberedPage(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

describe('readAllPages', () => {
  it('returns 1002 rows in order from a full page and a short page', async () => {
    const { query, ranges } = scripted([
      { data: numberedPage(0, postgrestPageSize), error: null },
      { data: numberedPage(postgrestPageSize, 2), error: null },
    ]);

    const rows = await readAllPages<number>(query, pageError);

    expect(rows).toHaveLength(1002);
    expect(rows[0]).toBe(0);
    expect(rows[999]).toBe(999);
    expect(rows[1000]).toBe(1000);
    expect(rows[1001]).toBe(1001);
    expect(ranges).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
  });

  it('returns the full page when the next page is empty', async () => {
    const { query, ranges } = scripted([
      { data: numberedPage(0, postgrestPageSize), error: null },
      { data: [], error: null },
    ]);

    const rows = await readAllPages<number>(query, pageError);

    expect(rows).toHaveLength(1000);
    expect(rows[0]).toBe(0);
    expect(rows[999]).toBe(999);
    expect(ranges).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
  });

  it('fails closed when every page is full up to the cap', async () => {
    const full = numberedPage(0, postgrestPageSize);
    const ranges: { from: number; to: number }[] = [];
    const query = {
      range(from: number, to: number) {
        ranges.push({ from, to });
        return Promise.resolve({ data: full, error: null });
      },
    };

    await expect(readAllPages(query, pageError)).rejects.toThrow(pageError);
    expect(ranges).toHaveLength(postgrestMaxPages);
    expect(ranges[0]).toEqual({ from: 0, to: postgrestPageSize - 1 });
    expect(ranges[1]).toEqual({
      from: postgrestPageSize,
      to: postgrestPageSize * 2 - 1,
    });
    expect(ranges[postgrestMaxPages - 1]).toEqual({
      from: (postgrestMaxPages - 1) * postgrestPageSize,
      to: postgrestMaxPages * postgrestPageSize - 1,
    });
  });

  it('uses the caller error when a page fails', async () => {
    const { query } = scripted([
      {
        data: null,
        error: { message: 'permission denied for schema app' },
      },
    ]);

    await expect(readAllPages(query, pageError)).rejects.toThrow(pageError);
  });
});
