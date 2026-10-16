import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createItem, listItems, updateItem } from '@/items/api';
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
  const captured: { insert?: unknown; update?: unknown } = {};
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.order = self;
  chain.eq = self;
  chain.delete = self;
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
  lossPct: 0.125,
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
          loss_pct: '0.125',
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
        parentItemId: null,
        active: false,
        onHandQty: 0,
        avgCost: 0,
        onHandValue: 0,
      },
    ]);
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
      loss_pct: 0.125,
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

    await expect(updateItem('a', draft)).rejects.toThrow(
      'مينفعش تغيّر وحدة صنف عليه حركات',
    );
    expect(items.captured.update).not.toHaveProperty('id');
    expect(items.captured.update).not.toHaveProperty('created_at');
  });
});
