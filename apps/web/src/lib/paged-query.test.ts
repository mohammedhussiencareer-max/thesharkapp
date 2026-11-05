import { describe, expect, it } from 'vitest';
import {
  postgrestMaxPages,
  postgrestPageSize,
  readAllByKey,
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

describe('readAllByKey', () => {
  function keyed(
    pages: { data: unknown; error: { message?: string } | null }[],
  ) {
    const asked: { afterId: string | null; pageSize: number }[] = [];
    const load = (afterId: string | null, pageSize: number) => {
      asked.push({ afterId, pageSize });
      return Promise.resolve(
        pages[asked.length - 1] ?? { data: [], error: null },
      );
    };
    return { load, asked };
  }

  function idPage(start: number, length: number): { id: string }[] {
    return Array.from({ length }, (_, offset) => ({
      id: `id${String(start + offset).padStart(5, '0')}`,
    }));
  }

  it('starts each page after the last id of the one before', async () => {
    const { load, asked } = keyed([
      { data: idPage(0, 1000), error: null },
      { data: idPage(1000, 2), error: null },
    ]);

    const rows = await readAllByKey<{ id: string }>(load, pageError);

    expect(rows).toHaveLength(1002);
    expect(rows[1001]?.id).toBe('id01001');
    expect(asked).toEqual([
      { afterId: null, pageSize: 1000 },
      { afterId: 'id00999', pageSize: 1000 },
    ]);
  });

  it('returns the full page when the next page is empty', async () => {
    const { load, asked } = keyed([
      { data: idPage(0, 1000), error: null },
      { data: [], error: null },
    ]);

    await expect(readAllByKey(load, pageError)).resolves.toHaveLength(1000);
    expect(asked).toHaveLength(2);
  });

  it('fails closed when every page is full up to the cap', async () => {
    const { load, asked } = keyed([
      { data: idPage(0, 2), error: null },
      { data: idPage(2, 2), error: null },
      { data: idPage(4, 2), error: null },
    ]);

    await expect(
      readAllByKey(load, pageError, { pageSize: 2, maxPages: 3 }),
    ).rejects.toThrow(pageError);
    expect(asked).toHaveLength(3);
  });

  it('fails closed when the server ignores the key and repeats a page', async () => {
    const { load } = keyed([
      { data: idPage(0, 2), error: null },
      { data: idPage(0, 2), error: null },
    ]);

    await expect(
      readAllByKey(load, pageError, { pageSize: 2 }),
    ).rejects.toThrow(pageError);
  });

  it('uses the caller error when a page fails or a row has no id', async () => {
    const failed = keyed([
      { data: null, error: { message: 'permission denied for schema app' } },
    ]);
    await expect(readAllByKey(failed.load, pageError)).rejects.toThrow(
      pageError,
    );

    const keyless = keyed([
      { data: [{ name: 'x' }, { name: 'y' }], error: null },
    ]);
    await expect(
      readAllByKey(keyless.load, pageError, { pageSize: 2 }),
    ).rejects.toThrow(pageError);
  });
});
