import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConversion,
  createItem,
  deleteConversion,
  listConversions,
  listItems,
  updateConversion,
  updateItem,
} from '@/items/api';
import type { ItemExpectation } from '@/items/expectation';
import { StaleWriteError } from '@/items/errors';
import type { ItemDraft } from '@/items/types';

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
    insert?: unknown;
    update?: unknown;
    filters: { op: 'eq' | 'is'; column: string; value: unknown }[];
  } = { filters: [] };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = (columns?: unknown) => {
    captured.select = columns;
    return chain;
  };
  chain.order = self;
  chain.delete = self;
  chain.eq = (column: string, value: unknown) => {
    captured.filters.push({ op: 'eq', column, value });
    return chain;
  };
  chain.is = (column: string, value: unknown) => {
    captured.filters.push({ op: 'is', column, value });
    return chain;
  };
  chain.insert = (payload: unknown) => {
    captured.insert = payload;
    return chain;
  };
  chain.update = (payload: unknown) => {
    captured.update = payload;
    return chain;
  };
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return { chain, captured };
}

const draft: ItemDraft = {
  name: '  جمبري  ',
  kind: 'seafood',
  baseUnit: 'kg',
  countFrequency: 'weekly',
  lossPct: '0.125',
  parentItemId: null,
  active: true,
};

describe('catalog api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
  });

  it('lists items with a zero balance when no balance row exists', async () => {
    const items = query({
      data: [
        {
          id: 'a',
          name: 'جمبري',
          kind: 'seafood',
          base_unit: 'kg',
          count_frequency: 'weekly',
          loss_pct: 0.125,
          loss_pct_text: '0.12500',
          parent_item_id: null,
          active: true,
        },
        {
          id: 'b',
          name: 'علبة',
          kind: 'packaging',
          base_unit: 'piece',
          count_frequency: 'weekly',
          loss_pct: 0,
          loss_pct_text: '0.00000',
          parent_item_id: null,
          active: false,
        },
      ],
      error: null,
    });
    const balances = query({
      data: [
        {
          item_id: 'a',
          on_hand_qty: '1.500000',
          avg_cost: '80.5',
          on_hand_value: '120.75',
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({
      from(table: string) {
        return table === 'item_balances' ? balances.chain : items.chain;
      },
    });

    await expect(listItems()).resolves.toEqual([
      {
        id: 'a',
        name: 'جمبري',
        kind: 'seafood',
        baseUnit: 'kg',
        countFrequency: 'weekly',
        lossPct: 0.125,
        storedLossPct: '0.12500',
        parentItemId: null,
        active: true,
        onHandQty: 1.5,
        avgCost: 80.5,
        onHandValue: 120.75,
      },
      {
        id: 'b',
        name: 'علبة',
        kind: 'packaging',
        baseUnit: 'piece',
        countFrequency: 'weekly',
        lossPct: 0,
        storedLossPct: '0.00000',
        parentItemId: null,
        active: false,
        onHandQty: 0,
        avgCost: 0,
        onHandValue: 0,
      },
    ]);
    expect(items.captured.select).toBe(
      'id, name, kind, base_unit, count_frequency, loss_pct, loss_pct_text:loss_pct::text, parent_item_id, active',
    );
  });

  it('trims the name and does not send id or created_at', async () => {
    const items = query({ data: [{ id: 'a' }], error: null });
    mocks.schema.mockReturnValue({
      from: () => items.chain,
    });

    await createItem(draft);

    expect(items.captured.insert).toEqual({
      name: 'جمبري',
      kind: 'seafood',
      base_unit: 'kg',
      count_frequency: 'weekly',
      loss_pct: '0.125',
      parent_item_id: null,
      active: true,
    });
  });

  it('throws the Arabic message for a frozen base unit', async () => {
    const items = query({
      data: null,
      error: {
        code: '23514',
        message: 'cannot change base_unit of an item that has movements',
      },
    });
    mocks.schema.mockReturnValue({
      from: () => items.chain,
    });

    await expect(
      updateItem('a', draft, {
        name: 'جمبري',
        kind: 'seafood',
        baseUnit: 'kg',
        countFrequency: 'weekly',
        lossPct: '0.12500',
        parentItemId: null,
        active: true,
      }),
    ).rejects.toThrow('مينفعش تغيّر وحدة صنف عليه حركات');
    expect(items.captured.update).not.toHaveProperty('id');
    expect(items.captured.update).not.toHaveProperty('created_at');
  });

  it('throws StaleWriteError when an item update matches no snapshot row', async () => {
    const items = query({ data: [], error: null });
    mocks.schema.mockReturnValue({ from: () => items.chain });
    const expected: ItemExpectation = {
      name: 'جمبري',
      kind: 'seafood',
      baseUnit: 'kg',
      countFrequency: 'weekly',
      lossPct: '0.12500',
      parentItemId: null,
      active: true,
    };

    await expect(updateItem('a', draft, expected)).rejects.toBeInstanceOf(
      StaleWriteError,
    );
    expect(items.captured.filters).toEqual([
      { op: 'eq', column: 'id', value: 'a' },
      { op: 'eq', column: 'name', value: 'جمبري' },
      { op: 'eq', column: 'kind', value: 'seafood' },
      { op: 'eq', column: 'base_unit', value: 'kg' },
      { op: 'eq', column: 'count_frequency', value: 'weekly' },
      { op: 'eq', column: 'loss_pct', value: '0.12500' },
      { op: 'eq', column: 'active', value: true },
      { op: 'is', column: 'parent_item_id', value: null },
    ]);
  });

  it('filters a parent id with eq when the item snapshot has one', async () => {
    const items = query({ data: [{ id: 'size' }], error: null });
    mocks.schema.mockReturnValue({ from: () => items.chain });

    await updateItem(
      'size',
      { ...draft, name: 'بوري كبير', kind: 'fish_size', parentItemId: 'mixed' },
      {
        name: 'بوري',
        kind: 'fish_size',
        baseUnit: 'kg',
        countFrequency: 'daily',
        lossPct: 0,
        parentItemId: 'mixed',
        active: true,
      },
    );

    expect(items.captured.filters).toContainEqual({
      op: 'eq',
      column: 'parent_item_id',
      value: 'mixed',
    });
  });

  it('throws StaleWriteError when a conversion update matches no factor', async () => {
    const rows = query({ data: [], error: null });
    mocks.schema.mockReturnValue({ from: () => rows.chain });

    await expect(
      updateConversion('oil', 'كيس', '3', '1.000000000'),
    ).rejects.toBeInstanceOf(StaleWriteError);
    expect(rows.captured.update).toEqual({ factor_to_base: '3' });
    expect(rows.captured.filters).toEqual([
      { op: 'eq', column: 'item_id', value: 'oil' },
      { op: 'eq', column: 'unit', value: 'كيس' },
      { op: 'eq', column: 'factor_to_base', value: '1.000000000' },
    ]);
  });

  it('throws StaleWriteError when a conversion delete matches no factor', async () => {
    const rows = query({ data: [], error: null });
    mocks.schema.mockReturnValue({ from: () => rows.chain });

    await expect(deleteConversion('oil', 'كيس', 1)).rejects.toBeInstanceOf(
      StaleWriteError,
    );
    expect(rows.captured.filters).toEqual([
      { op: 'eq', column: 'item_id', value: 'oil' },
      { op: 'eq', column: 'unit', value: 'كيس' },
      { op: 'eq', column: 'factor_to_base', value: 1 },
    ]);
  });

  it('uses the exact factor text in the update filter', async () => {
    const listed = query({
      data: [
        {
          item_id: 'oil',
          unit: 'كيس',
          factor_to_base: 12345678.12345679,
          factor_text: '12345678.123456789',
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => listed.chain });

    const [row] = await listConversions('oil');

    expect(listed.captured.select).toBe(
      'item_id, unit, factor_to_base, factor_text:factor_to_base::text',
    );
    expect(row?.storedFactor).toBe('12345678.123456789');
    expect(row?.factorToBase).toBe(12345678.12345679);

    const updated = query({ data: [{ unit: 'كيس' }], error: null });
    mocks.schema.mockReturnValue({ from: () => updated.chain });
    await updateConversion('oil', 'كيس', '2', row?.storedFactor ?? '');

    expect(updated.captured.filters).toEqual([
      { op: 'eq', column: 'item_id', value: 'oil' },
      { op: 'eq', column: 'unit', value: 'كيس' },
      { op: 'eq', column: 'factor_to_base', value: '12345678.123456789' },
    ]);
  });

  it('rejects a factor cast that is not exact decimal text', async () => {
    const listed = query({
      data: [
        {
          item_id: 'oil',
          unit: 'كيس',
          factor_to_base: 1,
          factor_text: 1,
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => listed.chain });

    await expect(listConversions('oil')).rejects.toThrow('حصل خطأ. حاول تاني.');
  });

  it('writes factor_to_base and loss_pct as exact decimal strings', async () => {
    const items = query({ data: [{ id: 'a' }], error: null });
    mocks.schema.mockReturnValue({ from: () => items.chain });
    const expected: ItemExpectation = {
      name: 'جمبري',
      kind: 'seafood',
      baseUnit: 'kg',
      countFrequency: 'weekly',
      lossPct: '0.00001',
      parentItemId: null,
      active: true,
    };

    await createItem({ ...draft, lossPct: '0.00001' });
    expect(items.captured.insert).toMatchObject({ loss_pct: '0.00001' });

    await updateItem('a', { ...draft, lossPct: '0.99999' }, expected);
    expect(items.captured.update).toMatchObject({ loss_pct: '0.99999' });

    const rows = query({ data: [{ unit: 'كيس' }], error: null });
    mocks.schema.mockReturnValue({ from: () => rows.chain });

    await addConversion('oil', 'كيس', '12345678.123456789');
    expect(rows.captured.insert).toMatchObject({
      factor_to_base: '12345678.123456789',
    });
    await addConversion('oil', 'كيس', '999999999.999999999');
    expect(rows.captured.insert).toMatchObject({
      factor_to_base: '999999999.999999999',
    });

    await updateConversion('oil', 'كيس', '12345678.123456789', '1');
    expect(rows.captured.update).toEqual({
      factor_to_base: '12345678.123456789',
    });
    await updateConversion('oil', 'كيس', '999999999.999999999', '1');
    expect(rows.captured.update).toEqual({
      factor_to_base: '999999999.999999999',
    });
  });

  it('maps a duplicate conversion unit from the insert', async () => {
    const rows = query({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "item_unit_conversions_pkey"',
      },
    });
    mocks.schema.mockReturnValue({ from: () => rows.chain });

    await expect(addConversion('oil', 'كيس', '2')).rejects.toThrow(
      'الوحدة دي موجودة قبل كده',
    );
  });
});
