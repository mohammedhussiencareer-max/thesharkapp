import type { CatalogItem } from '@/items/types';

export type FishBlock = {
  parent: CatalogItem;
  showParent: boolean;
  children: CatalogItem[];
};

export type CatalogGroups = {
  fish: FishBlock[];
  orphans: CatalogItem[];
  seafood: CatalogItem[];
  ingredients: CatalogItem[];
  packaging: CatalogItem[];
};

function byName(a: CatalogItem, b: CatalogItem): number {
  return a.name.localeCompare(b.name, 'ar');
}

function isVisible(item: CatalogItem, showInactive: boolean): boolean {
  return showInactive || item.active;
}

export function groupCatalog(
  items: readonly CatalogItem[],
  showInactive: boolean,
): CatalogGroups {
  const mixed = items
    .filter((item) => item.kind === 'fish_mixed')
    .slice()
    .sort(byName);
  const mixedIds = new Set(mixed.map((item) => item.id));
  const sizes = items.filter((item) => item.kind === 'fish_size');

  const fish = mixed.flatMap((parent) => {
    const children = sizes
      .filter(
        (size) =>
          size.parentItemId === parent.id && isVisible(size, showInactive),
      )
      .slice()
      .sort(byName);
    const showParent = isVisible(parent, showInactive);
    if (!showParent && children.length === 0) return [];
    return [{ parent, showParent, children }];
  });

  const orphans = sizes
    .filter(
      (size) =>
        isVisible(size, showInactive) &&
        (size.parentItemId === null || !mixedIds.has(size.parentItemId)),
    )
    .slice()
    .sort(byName);

  return {
    fish,
    orphans,
    seafood: items
      .filter(
        (item) => item.kind === 'seafood' && isVisible(item, showInactive),
      )
      .slice()
      .sort(byName),
    ingredients: items
      .filter(
        (item) => item.kind === 'ingredient' && isVisible(item, showInactive),
      )
      .slice()
      .sort(byName),
    packaging: items
      .filter(
        (item) => item.kind === 'packaging' && isVisible(item, showInactive),
      )
      .slice()
      .sort(byName),
  };
}
