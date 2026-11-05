import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmedRefusalError, CostingChangedError } from '@/items/errors';
import { hasAction, resetHeldWrites, unknownAction } from '@/items/request-id';
import {
  createRecipe,
  expandRecipe,
  getRecipe,
  listBatchOptions,
  listItemUnits,
  listRecipes,
  listStockOptions,
  listUnitsMeta,
  recipeSchedule,
  setRecipeVersion,
  updateRecipe,
} from '@/recipes/api';
import { recipeCreateSubject } from '@/recipes/subjects';
import type { RecipeWrite } from '@/recipes/types';

const mocks = vi.hoisted(() => ({
  schema: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    schema: mocks.schema,
  },
}));

function query(result: { data: unknown; error: unknown }) {
  const captured: {
    select?: unknown;
    filters: { column: string; value: unknown }[];
    table?: string;
  } = { filters: [] };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = (columns?: unknown) => {
    captured.select = columns;
    return chain;
  };
  chain.order = self;
  chain.range = self;
  chain.limit = self;
  chain.eq = (column: string, value: unknown) => {
    captured.filters.push({ column, value });
    return chain;
  };
  chain.in = chain.eq;
  chain.is = chain.eq;
  chain.not = (column: string, operator: string, value: unknown) => {
    captured.filters.push({
      column,
      value: `not.${operator}.${String(value)}`,
    });
    return chain;
  };
  chain.maybeSingle = self;
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return { chain, captured };
}

function byTable(tables: Record<string, { chain: Record<string, unknown> }>) {
  return (name: string) => {
    const found = tables[name];
    if (!found) throw new Error(`unexpected table ${name}`);
    return found.chain;
  };
}

type Row = Record<string, unknown>;

/**
 * A table that applies each request's filters, key and range to its data as it
 * is at that moment. `beforeRequest` may change the data between page requests.
 */
function liveTable(data: Row[], beforeRequest?: (request: number) => void) {
  const seen: {
    select?: unknown;
    requests: number;
    ranges: number[];
    afters: unknown[];
    filters: { column: string; value: unknown }[];
  } = { requests: 0, ranges: [], afters: [], filters: [] };
  function note(column: string, value: unknown) {
    if (!seen.filters.some((f) => f.column === column && f.value === value)) {
      seen.filters.push({ column, value });
    }
  }
  function fresh() {
    const keep: ((row: Row) => boolean)[] = [];
    let after: string | null = null;
    let limit = Infinity;
    function serve(): Row[] {
      seen.requests += 1;
      beforeRequest?.(seen.requests);
      return data
        .filter((row) => keep.every((test) => test(row)))
        .sort((left, right) => (String(left.id) < String(right.id) ? -1 : 1));
    }
    const chain: Record<string, unknown> = {};
    chain.select = (columns?: unknown) => {
      seen.select = columns;
      return chain;
    };
    chain.eq = (column: string, value: unknown) => {
      note(column, value);
      keep.push((row) => row[column] === value);
      return chain;
    };
    chain.is = (column: string, value: unknown) => {
      note(column, value);
      keep.push((row) => (row[column] ?? null) === value);
      return chain;
    };
    chain.not = (column: string, operator: string, value: unknown) => {
      note(column, `not.${operator}.${String(value)}`);
      keep.push((row) => (row[column] ?? null) !== value);
      return chain;
    };
    chain.gt = (_column: string, value: string) => {
      seen.afters.push(value);
      after = value;
      return chain;
    };
    chain.order = () => chain;
    chain.limit = (count: number) => {
      limit = count;
      return chain;
    };
    chain.range = (from: number, to: number) => {
      seen.ranges.push(from);
      return Promise.resolve({
        data: serve().slice(from, to + 1),
        error: null,
      });
    };
    chain.then = (
      resolve: (value: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => {
      const rows = serve()
        .filter((row) => after === null || String(row.id) > after)
        .slice(0, limit);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    };
    return chain;
  }
  return {
    get chain() {
      return fresh();
    },
    seen,
  };
}

function oldVersions(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `v${String(index).padStart(4, '0')}`,
    recipe_id: 'old',
    effective_from: '2026-01-01T00:00:00+00:00',
    effective_to: '2026-02-01T00:00:00+00:00',
    batch_unit: 'liter',
    superseded_change_id: null,
  }));
}

const currentVersion: Row = {
  id: 'vzzz',
  recipe_id: 'target',
  effective_from: '2026-07-01T00:00:00+00:00',
  effective_to: null,
  batch_unit: 'kg',
  superseded_change_id: null,
};

const write: RecipeWrite = {
  requestId: 'req-1',
  effectiveFrom: null,
  effectiveTo: null,
  batchQty: null,
  batchUnit: null,
  lines: [{ stock_item_id: 'oil', quantity: '0.123456789', unit: 'kg' }],
  reason: null,
  token: 'tok',
};

describe('recipe api', () => {
  beforeEach(() => {
    resetHeldWrites();
    mocks.schema.mockReset();
  });

  it('lists recipes and marks the ones with a version in force', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
    const recipes = query({
      data: [
        { id: 'a', name: 'صلصة', kind: 'batch', active: true },
        { id: 'b', name: 'طبق', kind: 'dish', active: false },
        { id: 'c', name: 'طهي', kind: 'cooking', active: true },
      ],
      error: null,
    });
    const versions = query({
      data: [
        {
          id: 'va',
          recipe_id: 'a',
          effective_from: '2026-07-01T00:00:00.000Z',
          effective_to: null,
        },
        {
          id: 'vb',
          recipe_id: 'b',
          effective_from: '2026-01-01T00:00:00.000Z',
          effective_to: '2026-02-01T00:00:00.000Z',
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({
      from: byTable({ recipes, recipe_versions: versions }),
    });
    try {
      await expect(listRecipes()).resolves.toEqual([
        { id: 'a', name: 'صلصة', kind: 'batch', active: true, inForce: true },
        { id: 'b', name: 'طبق', kind: 'dish', active: false, inForce: false },
        { id: 'c', name: 'طهي', kind: 'cooking', active: true, inForce: false },
      ]);
      expect(versions.captured.filters).toEqual([
        { column: 'superseded_change_id', value: null },
      ]);
      expect(versions.captured.select).not.toContain('superseded_change_id');
      expect(recipes.captured.select).not.toContain('recipe_versions');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads past the first thousand recipes and batches', async () => {
    const all = Array.from({ length: 1001 }, (_, index) => ({
      id: `r${String(index).padStart(4, '0')}`,
      name: `وصفة ${index}`,
      kind: 'batch',
      active: true,
    }));
    const recipes = liveTable(all);
    const versions = liveTable([]);
    mocks.schema.mockReturnValue({
      from: byTable({ recipes, recipe_versions: versions }),
    });
    const listed = await listRecipes();
    expect(listed).toHaveLength(1001);
    expect(listed.some((recipe) => recipe.id === 'r1000')).toBe(true);
    expect(recipes.seen.ranges).toEqual([0, 1000]);

    const batchRecipes = liveTable(all);
    mocks.schema.mockReturnValue({
      from: byTable({ recipes: batchRecipes, recipe_versions: versions }),
    });
    const batches = await listBatchOptions();
    expect(batches).toHaveLength(1001);
    expect(batches.some((batch) => batch.id === 'r1000')).toBe(true);
    expect(batchRecipes.seen.ranges).toEqual([0, 1000]);
  });

  it('finds the version in force behind a thousand older version rows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
    const recipes = liveTable([
      { id: 'old', name: 'قديمة', kind: 'dish', active: true },
      { id: 'target', name: 'حالية', kind: 'dish', active: true },
    ]);
    const versions = liveTable([...oldVersions(1000), currentVersion]);
    mocks.schema.mockReturnValue({
      from: byTable({ recipes, recipe_versions: versions }),
    });
    try {
      const listed = await listRecipes();
      expect(listed.map((recipe) => [recipe.id, recipe.inForce])).toEqual([
        ['target', true],
        ['old', false],
      ]);
      expect(versions.seen.afters).toEqual(['v0999']);
      expect(versions.seen.ranges).toEqual([]);
      expect(versions.seen.filters).toEqual([
        { column: 'superseded_change_id', value: null },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not skip a recipe version when an earlier row is superseded between pages', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
    const recipes = liveTable([
      { id: 'old', name: 'قديمة', kind: 'dish', active: true },
      { id: 'target', name: 'حالية', kind: 'dish', active: true },
    ]);
    const data = [...oldVersions(1000), currentVersion];
    const versions = liveTable(data, (request) => {
      if (request === 2) {
        data[0] = { ...data[0], superseded_change_id: 'chg' };
      }
    });
    mocks.schema.mockReturnValue({
      from: byTable({ recipes, recipe_versions: versions }),
    });
    try {
      const listed = await listRecipes();
      expect(versions.seen.requests).toBe(2);
      expect(listed.map((recipe) => [recipe.id, recipe.inForce])).toEqual([
        ['target', true],
        ['old', false],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the batch units that sit behind a thousand older version rows', async () => {
    const recipes = liveTable([
      { id: 'old', name: 'أ', kind: 'batch', active: true },
      { id: 'target', name: 'ب', kind: 'batch', active: true },
    ]);
    const versions = liveTable([...oldVersions(1000), currentVersion]);
    mocks.schema.mockReturnValue({
      from: byTable({ recipes, recipe_versions: versions }),
    });
    const batches = await listBatchOptions();
    expect(batches.find((batch) => batch.id === 'target')?.versions).toEqual([
      {
        effectiveFrom: '2026-07-01T00:00:00+00:00',
        effectiveTo: null,
        unit: 'kg',
      },
    ]);
    expect(batches.find((batch) => batch.id === 'old')?.versions).toHaveLength(
      1000,
    );
    expect(versions.seen.afters).toEqual(['v0999']);
    expect(versions.seen.ranges).toEqual([]);
    expect(versions.seen.filters).toEqual([
      { column: 'superseded_change_id', value: null },
      { column: 'batch_unit', value: 'not.is.null' },
    ]);
  });

  it('does not skip a batch version when an earlier row is superseded between pages', async () => {
    const recipes = liveTable([
      { id: 'old', name: 'أ', kind: 'batch', active: true },
      { id: 'target', name: 'ب', kind: 'batch', active: true },
    ]);
    const data = [...oldVersions(1000), currentVersion];
    const versions = liveTable(data, (request) => {
      if (request === 2) {
        data[0] = { ...data[0], superseded_change_id: 'chg' };
      }
    });
    mocks.schema.mockReturnValue({
      from: byTable({ recipes, recipe_versions: versions }),
    });
    const batches = await listBatchOptions();
    expect(versions.seen.requests).toBe(2);
    expect(batches.find((batch) => batch.id === 'target')?.versions).toEqual([
      {
        effectiveFrom: '2026-07-01T00:00:00+00:00',
        effectiveTo: null,
        unit: 'kg',
      },
    ]);
    expect(batches.find((batch) => batch.id === 'old')?.versions).toHaveLength(
      1000,
    );
  });

  it('rejects a recipe with an unknown kind', async () => {
    const recipes = query({
      data: [{ id: 'a', name: 'x', kind: 'other', active: true }],
      error: null,
    });
    const versions = query({ data: [], error: null });
    mocks.schema.mockReturnValue({
      from: byTable({ recipes, recipe_versions: versions }),
    });
    await expect(listRecipes()).rejects.toThrow();
  });

  it('reads one recipe by id and returns null when it is absent', async () => {
    const found = query({
      data: { id: 'a', name: 'صلصة', kind: 'batch', active: true },
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => found.chain });
    await expect(getRecipe('a')).resolves.toEqual({
      id: 'a',
      name: 'صلصة',
      kind: 'batch',
      active: true,
    });
    expect(found.captured.filters).toEqual([{ column: 'id', value: 'a' }]);

    const absent = query({ data: null, error: null });
    mocks.schema.mockReturnValue({ from: () => absent.chain });
    await expect(getRecipe('zzz')).resolves.toBeNull();
  });

  it('creates a recipe with a trimmed name and a request id', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { recipe_id: 'new-id' }, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await expect(createRecipe('  صلصة  ', 'batch')).resolves.toBe('new-id');
    expect(rpc).toHaveBeenCalledWith('create_recipe', {
      p_request_id: expect.any(String) as string,
      p_name: 'صلصة',
      p_kind: 'batch',
    });
    expect(hasAction(recipeCreateSubject('صلصة', 'batch'))).toBe(false);
  });

  it('keeps the request id of a create whose outcome is unknown', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Failed to fetch' },
      })
      .mockResolvedValueOnce({ data: { recipe_id: 'new-id' }, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await expect(createRecipe('صلصة', 'batch')).rejects.toThrow();
    const subject = recipeCreateSubject('صلصة', 'batch');
    expect(unknownAction(subject)).not.toBeNull();
    await expect(createRecipe('صلصة', 'batch')).resolves.toBe('new-id');
    const ids = rpc.mock.calls.map(
      (call) => (call[1] as { p_request_id: string }).p_request_id,
    );
    expect(ids[1]).toBe(ids[0]);
    expect(hasAction(subject)).toBe(false);
  });

  it('retires a create that the server definitely refused', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'name must be 1 to 120 characters' },
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(createRecipe('x', 'dish')).rejects.toMatchObject({
      code: 'P0001',
    });
    expect(hasAction(recipeCreateSubject('x', 'dish'))).toBe(false);
  });

  it('retires a create refused for a duplicate name so the owner can fix it', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "recipes_name_key"',
        details: 'Key (name)=(صلصة) already exists.',
      },
    });
    mocks.schema.mockReturnValue({ rpc });
    const failure: unknown = await createRecipe('صلصة', 'batch').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfirmedRefusalError);
    expect((failure as Error).message).toBe('الاسم ده موجود قبل كده');
    const subject = recipeCreateSubject('صلصة', 'batch');
    expect(hasAction(subject)).toBe(false);

    await expect(createRecipe('صلصة', 'batch')).rejects.toThrow();
    const ids = rpc.mock.calls.map(
      (call) => (call[1] as { p_request_id: string }).p_request_id,
    );
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('keeps a create whose request id collided as unknown', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "costing_changes_request_id_key"',
        details: 'Key (request_id)=(abc) already exists.',
      },
    });
    mocks.schema.mockReturnValue({ rpc });
    const failure: unknown = await createRecipe('صلصة', 'batch').catch(
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(ConfirmedRefusalError);
    expect((failure as Error).message).not.toBe('الاسم ده موجود قبل كده');
    const subject = recipeCreateSubject('صلصة', 'batch');
    expect(unknownAction(subject)).not.toBeNull();
  });

  it('refuses a rename to an existing name as a confirmed refusal', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "recipes_name_key"',
      },
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(
      updateRecipe('a', {
        requestId: 'r',
        name: 'موجود',
        active: true,
        expectedName: 'قديم',
        expectedActive: true,
      }),
    ).rejects.toBeInstanceOf(ConfirmedRefusalError);
  });

  it('sends the expected name and active flag with an update', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await updateRecipe('a', {
      requestId: 'req-2',
      name: ' جديد ',
      active: false,
      expectedName: 'قديم',
      expectedActive: true,
    });
    expect(rpc).toHaveBeenCalledWith('update_recipe', {
      p_request_id: 'req-2',
      p_recipe_id: 'a',
      p_name: 'جديد',
      p_active: false,
      p_expected_name: 'قديم',
      p_expected_active: true,
    });
  });

  it('turns an exact configuration-changed 40001 into the stale error', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'configuration changed' },
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(
      updateRecipe('a', {
        requestId: 'r',
        name: 'x',
        active: true,
        expectedName: 'y',
        expectedActive: true,
      }),
    ).rejects.toBeInstanceOf(CostingChangedError);
    await expect(setRecipeVersion('a', write)).rejects.toBeInstanceOf(
      CostingChangedError,
    );
  });

  it('does not treat another 40001 as a confirmed change', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'could not serialize access' },
    });
    mocks.schema.mockReturnValue({ rpc });
    const failure: unknown = await setRecipeVersion('a', write).catch(
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(CostingChangedError);
    expect(failure).toBeInstanceOf(Error);
  });

  it('sends the version with the exact decimal text and the token', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await setRecipeVersion('a', {
      ...write,
      effectiveFrom: '2026-07-15T09:00:00.000Z',
      effectiveTo: '2026-08-01T00:00:00.000Z',
      reason: 'تصحيح',
    });
    expect(rpc).toHaveBeenCalledWith('set_recipe_version', {
      p_request_id: 'req-1',
      p_recipe_id: 'a',
      p_effective_from: '2026-07-15T09:00:00.000Z',
      p_effective_to: '2026-08-01T00:00:00.000Z',
      p_batch_qty: null,
      p_batch_unit: null,
      p_lines: [{ stock_item_id: 'oil', quantity: '0.123456789', unit: 'kg' }],
      p_reason: 'تصحيح',
      p_expected_token: 'tok',
    });
  });

  it('sends null lines to stop a recipe', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await setRecipeVersion('a', { ...write, lines: null });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_lines: null });
  });

  function scheduleRpc(
    versions: { id: string; batch_qty?: unknown; lines?: unknown[] }[],
  ) {
    return vi.fn().mockResolvedValue({
      data: {
        identity: 'batch',
        token: 'tok',
        empty_token: 'empty',
        versions: versions.map((version) => ({
          effective_from: '2026-07-01T00:00:00+00:00',
          effective_to: null,
          batch_qty: null,
          batch_unit: null,
          lines: [],
          ...version,
        })),
      },
      error: null,
    });
  }

  it('reads schedule quantities as exact text, not the lossy jsonb numbers', async () => {
    const rpc = scheduleRpc([
      {
        id: 'v1',
        batch_qty: 2.5,
        lines: [
          {
            id: 'l1',
            stock_item_id: 'oil',
            child_recipe_id: null,
            quantity: 0.1234565,
            unit: 'kg',
          },
          {
            id: 'l2',
            stock_item_id: null,
            child_recipe_id: 'sauce',
            quantity: 1.5,
            unit: 'kg',
          },
        ],
      },
    ]);
    const exact = query({
      data: [
        {
          id: 'v1',
          batch_qty: '2.500000000000000001',
          recipe_lines: [
            { id: 'l2', quantity: '1.5' },
            { id: 'l1', quantity: '0.123456499999999999' },
          ],
        },
      ],
      error: null,
    });
    const from = vi.fn(() => exact.chain);
    mocks.schema.mockReturnValue({ rpc, from });
    const schedule = await recipeSchedule('a');
    expect(schedule.versions[0]?.batchQty).toBe('2.500000000000000001');
    expect(schedule.versions[0]?.lines).toEqual([
      {
        id: 'l1',
        stockItemId: 'oil',
        childRecipeId: null,
        quantity: '0.123456499999999999',
        unit: 'kg',
      },
      {
        id: 'l2',
        stockItemId: null,
        childRecipeId: 'sauce',
        quantity: '1.5',
        unit: 'kg',
      },
    ]);
    expect(schedule).toMatchObject({
      identity: 'batch',
      token: 'tok',
      emptyToken: 'empty',
    });
    expect(rpc).toHaveBeenCalledWith('recipe_schedule', { p_recipe_id: 'a' });
    expect(from).toHaveBeenCalledWith('recipe_versions');
    expect(exact.captured.select).toBe(
      'id, batch_qty::text, recipe_lines(id, quantity::text)',
    );
    expect(exact.captured.filters).toEqual([{ column: 'id', value: ['v1'] }]);
  });

  it('keeps an unrelated edit from changing an untouched quantity', async () => {
    const rpc = scheduleRpc([
      {
        id: 'v1',
        lines: [
          {
            id: 'l1',
            stock_item_id: 'oil',
            child_recipe_id: null,
            quantity: 0.1234565,
            unit: 'kg',
          },
        ],
      },
    ]);
    const exact = query({
      data: [
        {
          id: 'v1',
          batch_qty: null,
          recipe_lines: [{ id: 'l1', quantity: '0.123456499999999999' }],
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ rpc, from: () => exact.chain });
    const line = (await recipeSchedule('a')).versions[0]?.lines[0];
    expect(line?.quantity).toBe('0.123456499999999999');
    expect(line?.quantity).not.toBe(String(0.1234565));
  });

  it('asks for the version ids in groups of fifty', async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `v${index}`);
    const rpc = scheduleRpc(ids.map((id) => ({ id })));
    const reads: unknown[] = [];
    const from = vi.fn(() => {
      const read = query({
        data: ids.map((id) => ({ id, batch_qty: null, recipe_lines: [] })),
        error: null,
      });
      reads.push(read.captured);
      return read.chain;
    });
    mocks.schema.mockReturnValue({ rpc, from });
    const schedule = await recipeSchedule('a');
    expect(schedule.versions).toHaveLength(120);
    const sizes = (reads as { filters: { value: unknown[] }[] }[]).map(
      (read) => read.filters[0]?.value.length,
    );
    expect(sizes).toEqual([50, 50, 20]);
  });

  it('rejects a schedule whose exact quantities are missing or malformed', async () => {
    const withLine = () =>
      scheduleRpc([
        {
          id: 'v1',
          lines: [
            {
              id: 'l1',
              stock_item_id: 'oil',
              child_recipe_id: null,
              quantity: 1,
              unit: 'kg',
            },
          ],
        },
      ]);
    const missingVersion = query({ data: [], error: null });
    mocks.schema.mockReturnValue({
      rpc: withLine(),
      from: () => missingVersion.chain,
    });
    await expect(recipeSchedule('a')).rejects.toThrow();

    const missingLine = query({
      data: [{ id: 'v1', batch_qty: null, recipe_lines: [] }],
      error: null,
    });
    mocks.schema.mockReturnValue({
      rpc: withLine(),
      from: () => missingLine.chain,
    });
    await expect(recipeSchedule('a')).rejects.toThrow();

    const exponent = query({
      data: [
        {
          id: 'v1',
          batch_qty: null,
          recipe_lines: [{ id: 'l1', quantity: '1e-7' }],
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({
      rpc: withLine(),
      from: () => exponent.chain,
    });
    await expect(recipeSchedule('a')).rejects.toThrow();
  });

  it('rejects a schedule without a token', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { identity: 'batch', versions: [] },
      error: null,
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(recipeSchedule('a')).rejects.toThrow();
  });

  it('expands a recipe into ready requirements', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        status: 'ready',
        requirements: [
          { stock_item_id: 'oil', base_unit: 'liter', quantity: 0.25 },
        ],
      },
      error: null,
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(
      expandRecipe('a', '2', 'portion', '2026-07-15T09:00:00.000Z'),
    ).resolves.toEqual({
      status: 'ready',
      requirements: [
        { stockItemId: 'oil', baseUnit: 'liter', quantity: '0.25' },
      ],
    });
    expect(rpc).toHaveBeenCalledWith('expand_recipe', {
      p_recipe_id: 'a',
      p_output_qty: '2',
      p_output_unit: 'portion',
      p_at: '2026-07-15T09:00:00.000Z',
    });
  });

  it('expands a recipe into blocked issues', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        status: 'blocked',
        issues: [
          { code: 'loss_not_set', stock_item_id: 'oil' },
          { code: 'cycle', recipe_id: 'sauce' },
        ],
      },
      error: null,
    });
    mocks.schema.mockReturnValue({ rpc });
    await expect(
      expandRecipe('a', '1', 'portion', '2026-07-15T09:00:00.000Z'),
    ).resolves.toEqual({
      status: 'blocked',
      issues: [
        {
          code: 'loss_not_set',
          recipeId: null,
          stockItemId: 'oil',
          unit: null,
        },
        { code: 'cycle', recipeId: 'sauce', stockItemId: null, unit: null },
      ],
    });
  });

  it('rejects an expansion with an unknown status', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { status: 'odd' }, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await expect(expandRecipe('a', '1', 'kg', 'x')).rejects.toThrow();
  });

  it('lists stock options sorted by name', async () => {
    const stock = query({
      data: [
        {
          id: 'b',
          name: 'ملح',
          kind: 'ingredient',
          base_unit: 'kg',
          active: true,
        },
        {
          id: 'a',
          name: 'زيت',
          kind: 'ingredient',
          base_unit: 'liter',
          active: false,
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => stock.chain });
    const options = await listStockOptions();
    expect(options.map((option) => option.name)).toEqual(['زيت', 'ملح']);
    expect(options[0]).toEqual({
      id: 'a',
      name: 'زيت',
      kind: 'ingredient',
      baseUnit: 'liter',
      active: false,
    });
  });

  it('lists item units from the current view and skips empty rows', async () => {
    const units = query({
      data: [
        { item_id: 'a', unit_code: 'kg', label_ar: 'كيلو' },
        { item_id: 'a', unit_code: 'كيس', label_ar: null },
        { item_id: null, unit_code: 'g', label_ar: 'جرام' },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => units.chain });
    await expect(listItemUnits()).resolves.toEqual([
      { itemId: 'a', unit: 'kg', label: 'كيلو' },
      { itemId: 'a', unit: 'كيس', label: 'كيس' },
    ]);
  });

  it('lists units with their dimension and metric scale', async () => {
    const units = query({
      data: [
        { code: 'kg', label_ar: 'كيلو', dimension: 'mass', metric_scale: 1000 },
        {
          code: 'piece',
          label_ar: 'قطعة',
          dimension: 'count',
          metric_scale: null,
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => units.chain });
    await expect(listUnitsMeta()).resolves.toEqual([
      { code: 'kg', labelAr: 'كيلو', dimension: 'mass', metricScale: 1000 },
      { code: 'piece', labelAr: 'قطعة', dimension: 'count', metricScale: null },
    ]);
  });

  it('lists batch recipes with their dated batch units', async () => {
    const batches = query({
      data: [{ id: 'sauce', name: 'صلصة', active: true }],
      error: null,
    });
    const versions = query({
      data: [
        {
          id: 'v1',
          recipe_id: 'sauce',
          effective_from: '2026-07-01T00:00:00+00:00',
          effective_to: null,
          batch_unit: 'kg',
        },
        {
          id: 'v2',
          recipe_id: 'other',
          effective_from: '2026-07-01T00:00:00+00:00',
          effective_to: null,
          batch_unit: 'liter',
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({
      from: byTable({ recipes: batches, recipe_versions: versions }),
    });
    await expect(listBatchOptions()).resolves.toEqual([
      {
        id: 'sauce',
        name: 'صلصة',
        active: true,
        versions: [
          {
            effectiveFrom: '2026-07-01T00:00:00+00:00',
            effectiveTo: null,
            unit: 'kg',
          },
        ],
      },
    ]);
    expect(batches.captured.filters).toEqual([
      { column: 'kind', value: 'batch' },
    ]);
  });
});
