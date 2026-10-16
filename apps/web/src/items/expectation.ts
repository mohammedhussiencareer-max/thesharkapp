import type {
  BaseUnit,
  CatalogItem,
  CountFrequency,
  StockKind,
} from '@/items/types';

export type ItemExpectation = {
  name: string;
  kind: StockKind;
  baseUnit: BaseUnit;
  countFrequency: CountFrequency;
  lossPct: number | string;
  parentItemId: string | null;
  active: boolean;
};

export function expectationFromItem(item: CatalogItem): ItemExpectation {
  return {
    name: item.name,
    kind: item.kind,
    baseUnit: item.baseUnit,
    countFrequency: item.countFrequency,
    lossPct: item.storedLossPct,
    parentItemId: item.parentItemId,
    active: item.active,
  };
}
