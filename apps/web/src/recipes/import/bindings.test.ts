import { describe, expect, it } from 'vitest';
import { reduceBindings, type BindingRow } from '@/recipes/import/bindings';

function row(
  id: string,
  source: string,
  created: string,
  patch: Partial<BindingRow> = {},
): BindingRow {
  return {
    id,
    source_name: source,
    recipe_id: 'rec-a',
    stock_item_id: null,
    is_block: false,
    created_at: created,
    ...patch,
  };
}

describe('reduceBindings', () => {
  const first = row('1', 'a', '2026-11-01T10:00:00.000Z', { is_block: true });
  const later = row('2', 'a', '2026-11-02T10:00:00.000Z', {
    recipe_id: 'rec-b',
  });

  it('keeps the newest mapping per source, whatever the row order', () => {
    for (const rows of [
      [first, later],
      [later, first],
    ]) {
      expect(reduceBindings(rows).bindings).toEqual([
        { source: 'a', recipeId: 'rec-b', stockItemId: null },
      ]);
    }
  });

  it('keeps the newest block row even after a later plain mapping', () => {
    for (const rows of [
      [first, later],
      [later, first],
    ]) {
      expect(reduceBindings(rows).blockBindings).toEqual([
        { source: 'a', recipeId: 'rec-a', stockItemId: null },
      ]);
    }
  });

  it('breaks a created_at tie by id and ignores sources that were never blocks', () => {
    const stamp = '2026-11-03T10:00:00.000Z';
    const result = reduceBindings([
      row('9', 'b', stamp, { recipe_id: 'rec-9', is_block: true }),
      row('8', 'b', stamp, { recipe_id: 'rec-8', is_block: true }),
      row('7', 'c', stamp, { recipe_id: null, stock_item_id: 'item-1' }),
    ]);
    expect(result.blockBindings).toEqual([
      { source: 'b', recipeId: 'rec-9', stockItemId: null },
    ]);
    expect(result.bindings).toContainEqual({
      source: 'c',
      recipeId: null,
      stockItemId: 'item-1',
    });
  });
});
