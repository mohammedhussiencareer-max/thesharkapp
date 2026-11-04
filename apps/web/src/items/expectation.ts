import type {
  BaseUnit,
  CatalogItem,
  CountFrequency,
  ItemDraft,
  StockKind,
} from '@/items/types';

export type ItemExpectation = {
  name: string;
  kind: StockKind;
  baseUnit: BaseUnit;
  countFrequency: CountFrequency;
  parentItemId: string | null;
  active: boolean;
};

export function expectationFromDraft(draft: ItemDraft): ItemExpectation {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    baseUnit: draft.baseUnit,
    countFrequency: draft.countFrequency,
    parentItemId: draft.parentItemId,
    active: draft.active,
  };
}

export function expectationFromItem(item: CatalogItem): ItemExpectation {
  return {
    name: item.name,
    kind: item.kind,
    baseUnit: item.baseUnit,
    countFrequency: item.countFrequency,
    parentItemId: item.parentItemId,
    active: item.active,
  };
}
