import { describe, expect, it } from 'vitest';
import { groupCatalog } from '@/items/group';
import type { CatalogItem } from '@/items/types';

function item(
  overrides: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'name' | 'kind'>,
): CatalogItem {
  const row: CatalogItem = {
    baseUnit: 'kg',
    countFrequency: 'daily',
    lossPct: 0,
    storedLossPct: 0,
    parentItemId: null,
    active: true,
    onHandQty: 0,
    avgCost: 0,
    onHandValue: 0,
    ...overrides,
  };
  if (overrides.storedLossPct === undefined) row.storedLossPct = row.lossPct;
  return row;
}

describe('groupCatalog', () => {
  it('keeps an active size with a missing parent on its own', () => {
    const groups = groupCatalog(
      [item({ id: 'size', name: 'حجم يتيم', kind: 'fish_size' })],
      false,
    );

    expect(groups.orphans.map((row) => row.id)).toEqual(['size']);
    expect(groups.fish).toEqual([]);
  });

  it('hides an inactive parent but keeps its active sizes', () => {
    const groups = groupCatalog(
      [
        item({
          id: 'mixed',
          name: 'مرجان',
          kind: 'fish_mixed',
          active: false,
        }),
        item({
          id: 'size',
          name: 'صغير',
          kind: 'fish_size',
          parentItemId: 'mixed',
        }),
      ],
      false,
    );

    expect(groups.fish).toEqual([
      {
        parent: expect.objectContaining({ id: 'mixed' }) as CatalogItem,
        showParent: false,
        children: [expect.objectContaining({ id: 'size' })],
      },
    ]);
  });
});
