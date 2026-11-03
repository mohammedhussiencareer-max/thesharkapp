import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConversion,
  addCustomUnit,
  createItem,
  deleteConversion,
  listConversions,
  listItems,
  setItemLoss,
  setOpeningPrice,
  updateConversion,
  updateItem,
} from '@/items/api';
import type { ItemExpectation } from '@/items/expectation';
import { StaleWriteError } from '@/items/errors';
import { emptyScheduleToken } from '@/items/effective';
import type { DatedWrite, ItemDraft } from '@/items/types';

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
  chain.maybeSingle = self;
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

const expectedItem: ItemExpectation = {
  name: 'جمبري',
  kind: 'seafood',
  baseUnit: 'kg',
  countFrequency: 'weekly',
  parentItemId: null,
  active: true,
};

const nowTiming: DatedWrite = {
  effectiveFrom: null,
  effectiveTo: null,
  token: emptyScheduleToken,
  reason: null,
  requestId: 'req-loss',
};

describe('catalog api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
  });

  it('lists the current dated loss and leaves an unset loss null', async () => {
    const items = query({
      data: [
        {
          id: 'a',
          name: 'جمبري',
          kind: 'seafood',
          base_unit: 'kg',
          count_frequency: 'weekly',
          parent_item_id: null,
          active: true,
          item_balances: {
            on_hand_qty: '1.500000',
            avg_cost: '80.5',
            on_hand_value: '120.75',
          },
          item_loss_versions: [
            {
              loss_pct: 0.125,
              loss_text: '0.12500',
              effective_from: '2000-01-01T00:00:00.000Z',
              effective_to: null,
              superseded_change_id: null,
            },
          ],
          item_conversion_versions: [],
          item_opening_prices: [],
        },
        {
          id: 'b',
          name: 'علبة',
          kind: 'packaging',
          base_unit: 'piece',
          count_frequency: 'weekly',
          parent_item_id: null,
          active: false,
          item_balances: null,
          item_loss_versions: [],
          item_conversion_versions: [],
          item_opening_prices: [],
        },
      ],
      error: null,
    });
    const tables: string[] = [];
    mocks.schema.mockReturnValue({
      from(table: string) {
        tables.push(table);
        return items.chain;
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
        lossFractionText: '0.12500',
        identityLocked: true,
        openingPriceId: null,
        openingPriceText: null,
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
        lossPct: null,
        lossFractionText: null,
        identityLocked: false,
        openingPriceId: null,
        openingPriceText: null,
        parentItemId: null,
        active: false,
        onHandQty: 0,
        avgCost: 0,
        onHandValue: 0,
      },
    ]);
    expect(items.captured.select).toBe(
      'id, name, kind, base_unit, count_frequency, parent_item_id, active, item_balances(on_hand_qty, avg_cost, on_hand_value), item_loss_versions(loss_pct, loss_text:loss_pct::text, effective_from, effective_to, superseded_change_id), item_conversion_versions(id, superseded_change_id), item_opening_prices(id, price_text:unit_cost::text, superseded_change_id)',
    );
    expect(tables).toEqual(['stock_items']);
  });

  it('creates an item through the dated writer and does not send loss on rename', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'a', error: null });
    const items = query({ data: [{ id: 'a' }], error: null });
    mocks.schema.mockReturnValue({
      rpc,
      from: () => items.chain,
    });

    await createItem(draft);

    expect(rpc).toHaveBeenCalledWith(
      'create_stock_item',
      expect.objectContaining({
        p_name: 'جمبري',
        p_kind: 'seafood',
        p_base_unit: 'kg',
        p_count_frequency: 'weekly',
        p_parent_item_id: null,
        p_loss_pct: '0.125',
        p_active: true,
      }),
    );
    const created = rpc.mock.calls[0]?.[1] as { p_request_id: string };
    expect(created.p_request_id).toEqual(expect.any(String));
    expect(items.captured.insert).toBeUndefined();

    await updateItem(
      'a',
      { ...draft, name: 'جمبري كبير', lossPct: '0.5' },
      {
        ...expectedItem,
        name: 'جمبري',
      },
    );
    expect(items.captured.update).toEqual({
      name: 'جمبري كبير',
      kind: 'seafood',
      base_unit: 'kg',
      count_frequency: 'weekly',
      parent_item_id: null,
      active: true,
    });
    expect(items.captured.update).not.toHaveProperty('loss_pct');
    expect(items.captured.filters.map((filter) => filter.column)).not.toContain(
      'loss_pct',
    );
  });

  it('sends a null loss when the owner left it unset', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'a', error: null });
    mocks.schema.mockReturnValue({ rpc });
    await createItem({ ...draft, lossPct: null });
    expect(rpc).toHaveBeenCalledWith(
      'create_stock_item',
      expect.objectContaining({ p_loss_pct: null }),
    );
  });

  it('creates an inactive item through create_stock_item', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'a', error: null });
    mocks.schema.mockReturnValue({ rpc });
    await createItem({ ...draft, active: false });
    expect(rpc).toHaveBeenCalledWith(
      'create_stock_item',
      expect.objectContaining({ p_active: false }),
    );
  });

  it('retires a create request id after a definite refusal and reuses it when the outcome is unknown', async () => {
    const refused = { ...draft, name: 'صنف مرفوض' };
    const unknown = { ...draft, name: 'صنف مجهول' };
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: '22023', message: 'bad' },
      })
      .mockResolvedValueOnce({ data: 'a', error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'network down' },
      })
      .mockResolvedValueOnce({ data: 'b', error: null });
    mocks.schema.mockReturnValue({ rpc });

    await expect(createItem(refused)).rejects.toThrow();
    await createItem(refused);
    const refusedFirst = (rpc.mock.calls[0]?.[1] as { p_request_id: string })
      .p_request_id;
    const refusedRetry = (rpc.mock.calls[1]?.[1] as { p_request_id: string })
      .p_request_id;
    expect(refusedFirst).toEqual(expect.any(String));
    expect(refusedRetry).not.toBe(refusedFirst);

    await expect(createItem(unknown)).rejects.toThrow();
    await createItem(unknown);
    const unknownFirst = (rpc.mock.calls[2]?.[1] as { p_request_id: string })
      .p_request_id;
    const unknownRetry = (rpc.mock.calls[3]?.[1] as { p_request_id: string })
      .p_request_id;
    expect(unknownRetry).toBe(unknownFirst);
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

    await expect(updateItem('a', draft, expectedItem)).rejects.toThrow(
      'مينفعش تغيّر وحدة صنف عليه حركات',
    );
    expect(items.captured.update).not.toHaveProperty('id');
    expect(items.captured.update).not.toHaveProperty('loss_pct');
  });

  it('throws StaleWriteError when an item update matches no snapshot row', async () => {
    const items = query({ data: [], error: null });
    mocks.schema.mockReturnValue({ from: () => items.chain });

    await expect(updateItem('a', draft, expectedItem)).rejects.toBeInstanceOf(
      StaleWriteError,
    );
    expect(items.captured.filters).toEqual([
      { op: 'eq', column: 'id', value: 'a' },
      { op: 'eq', column: 'name', value: 'جمبري' },
      { op: 'eq', column: 'kind', value: 'seafood' },
      { op: 'eq', column: 'base_unit', value: 'kg' },
      { op: 'eq', column: 'count_frequency', value: 'weekly' },
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

  it('maps a stale conversion update to StaleWriteError', async () => {
    mocks.schema.mockReturnValue({
      rpc: () =>
        Promise.resolve({
          data: null,
          error: { code: '40001', message: 'conversion changed' },
        }),
    });

    await expect(
      updateConversion('oil', 'كيس', '3', '1.000000000', 'kg', nowTiming),
    ).rejects.toBeInstanceOf(StaleWriteError);
  });

  it('reads current units and writes the dated conversion', async () => {
    const listed = query({
      data: [
        {
          item_id: 'oil',
          unit_code: 'liter',
          label_ar: 'لتر',
          factor_to_base: 1,
          factor_text: '1',
          source: 'base',
          version_id: null,
          effective_from: null,
        },
        {
          item_id: 'oil',
          unit_code: 'كيس',
          label_ar: 'كيس',
          factor_to_base: 12345678.12345679,
          factor_text: '12345678.123456789',
          source: 'explicit',
          version_id: 'v1',
          effective_from: '2026-01-01T00:00:00.000Z',
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => listed.chain });

    const snapshot = await listConversions('oil');
    expect(listed.captured.select).toContain('item_id, unit_code');
    expect(snapshot.baseUnit).toBe('liter');
    expect(snapshot.rows[0]?.storedFactor).toBe('12345678.123456789');
    expect(snapshot.rows[0]?.factorToBase).toBe(12345678.12345679);

    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await updateConversion(
      'oil',
      'كيس',
      '12345678.123456789',
      '1',
      'liter',
      nowTiming,
    );
    await deleteConversion('oil', 'كيس', '1', 'liter', nowTiming);
    await addConversion('oil', 'كيس', '999999999.999999999', 'kg', nowTiming);

    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'set_item_conversion',
      expect.objectContaining({
        p_item_id: 'oil',
        p_unit_code: 'كيس',
        p_factor: '12345678.123456789',
        p_effective_from: null,
        p_request_id: 'req-loss',
      }),
    );
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'set_item_conversion',
      expect.objectContaining({ p_factor: null, p_unit_code: 'كيس' }),
    );
    expect(rpc).toHaveBeenNthCalledWith(
      3,
      'set_item_conversion',
      expect.objectContaining({ p_factor: '999999999.999999999' }),
    );
  });

  it('throws StaleWriteError when the conversion snapshot item is missing', async () => {
    const listed = query({ data: [], error: null });
    const missing = query({ data: null, error: null });
    mocks.schema.mockReturnValue({
      from: (table: string) =>
        table === 'item_units_current' ? listed.chain : missing.chain,
    });

    await expect(listConversions('oil')).rejects.toBeInstanceOf(
      StaleWriteError,
    );
  });

  it('rejects a factor cast that is not exact decimal text', async () => {
    const listed = query({
      data: [
        {
          item_id: 'oil',
          unit_code: 'kg',
          label_ar: 'كيلو',
          factor_to_base: 1,
          factor_text: '1',
          source: 'base',
          version_id: null,
          effective_from: null,
        },
        {
          item_id: 'oil',
          unit_code: 'كيس',
          label_ar: 'كيس',
          factor_to_base: 1,
          factor_text: 1,
          source: 'explicit',
          version_id: 'v1',
          effective_from: null,
        },
      ],
      error: null,
    });
    mocks.schema.mockReturnValue({ from: () => listed.chain });

    await expect(listConversions('oil')).rejects.toThrow('حصل خطأ. حاول تاني.');
  });

  it('sends a null effective time for a loss change made now', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await setItemLoss('a', '0.125', nowTiming);
    expect(rpc).toHaveBeenCalledWith(
      'set_item_loss',
      expect.objectContaining({
        p_item_id: 'a',
        p_loss_pct: '0.125',
        p_effective_from: null,
        p_reason: null,
        p_expected_token: emptyScheduleToken,
        p_request_id: 'req-loss',
      }),
    );
  });

  it('sets an opening price with the current id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    mocks.schema.mockReturnValue({ rpc });
    await setOpeningPrice('a', '0', 'افتتاح', 'price-1', 'req-price');
    expect(rpc).toHaveBeenCalledWith('set_item_opening_price', {
      p_request_id: 'req-price',
      p_item_id: 'a',
      p_unit_cost: '0',
      p_zero_cost_reason: 'افتتاح',
      p_expected_current_id: 'price-1',
    });
  });

  it('adds a custom unit and maps a duplicate code', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: 'carton', error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '22023', message: 'unit already exists' },
      });
    mocks.schema.mockReturnValue({ rpc });
    await expect(addCustomUnit('carton', 'كرتونة', 'req-unit')).resolves.toBe(
      'carton',
    );
    await expect(
      addCustomUnit('carton', 'كرتونة', 'req-unit-2'),
    ).rejects.toThrow('الوحدة دي موجودة قبل كده');
  });

  it('maps a duplicate conversion unit from the writer', async () => {
    mocks.schema.mockReturnValue({
      rpc: () =>
        Promise.resolve({
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "item_unit_conversions_pkey"',
          },
        }),
    });

    await expect(
      addConversion('oil', 'كيس', '2', 'kg', nowTiming),
    ).rejects.toThrow('الوحدة دي موجودة قبل كده');
  });
});
