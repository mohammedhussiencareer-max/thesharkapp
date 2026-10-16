import {
  genericCatalogError,
  mapCatalogError,
  StaleWriteError,
} from '@/items/errors';
import type { ItemExpectation } from '@/items/expectation';
import { supabase } from '@/lib/supabase';
import {
  isBaseUnit,
  isCountFrequency,
  isStockKind,
  type CatalogItem,
  type ItemDraft,
  type UnitConversion,
} from '@/items/types';

export type { ItemExpectation };

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

function throwIfError(
  error: {
    code?: string;
    message?: string;
    details?: string | null;
    hint?: string | null;
  } | null,
): void {
  if (error) throw new Error(mapCatalogError(error));
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function itemPayload(draft: ItemDraft) {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    base_unit: draft.baseUnit,
    count_frequency: draft.countFrequency,
    loss_pct: draft.lossPct,
    parent_item_id: draft.parentItemId,
    active: draft.active,
  };
}

export async function listItems(): Promise<CatalogItem[]> {
  const db = appDb();
  const [itemsResult, balancesResult] = await Promise.all([
    db
      .from('stock_items')
      .select(
        'id, name, kind, base_unit, count_frequency, loss_pct, parent_item_id, active',
      )
      .order('name'),
    db
      .from('item_balances')
      .select('item_id, on_hand_qty, avg_cost, on_hand_value'),
  ]);
  throwIfError(itemsResult.error);
  throwIfError(balancesResult.error);

  const balances = new Map(
    (balancesResult.data ?? []).map((row) => [row.item_id, row]),
  );

  return (itemsResult.data ?? []).map((row) => {
    if (
      !isStockKind(row.kind) ||
      !isBaseUnit(row.base_unit) ||
      !isCountFrequency(row.count_frequency)
    ) {
      throw new Error(genericCatalogError);
    }
    const balance = balances.get(row.id);
    const storedLossPct = row.loss_pct;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUnit: row.base_unit,
      countFrequency: row.count_frequency,
      lossPct: toNumber(storedLossPct),
      storedLossPct:
        typeof storedLossPct === 'string' || typeof storedLossPct === 'number'
          ? storedLossPct
          : toNumber(storedLossPct),
      parentItemId: row.parent_item_id,
      active: row.active,
      onHandQty: balance ? toNumber(balance.on_hand_qty) : 0,
      avgCost: balance ? toNumber(balance.avg_cost) : 0,
      onHandValue: balance ? toNumber(balance.on_hand_value) : 0,
    };
  });
}

export async function createItem(draft: ItemDraft): Promise<void> {
  const { data, error } = await appDb()
    .from('stock_items')
    .insert(itemPayload(draft))
    .select('id');
  throwIfError(error);
  if (!data || data.length === 0) throw new Error(genericCatalogError);
}

export async function updateItem(
  id: string,
  draft: ItemDraft,
  expected: ItemExpectation,
): Promise<void> {
  const matched = appDb()
    .from('stock_items')
    .update(itemPayload(draft))
    .eq('id', id)
    .eq('name', expected.name)
    .eq('kind', expected.kind)
    .eq('base_unit', expected.baseUnit)
    .eq('count_frequency', expected.countFrequency)
    .eq('loss_pct', expected.lossPct as number)
    .eq('active', expected.active);
  const filtered =
    expected.parentItemId === null
      ? matched.is('parent_item_id', null)
      : matched.eq('parent_item_id', expected.parentItemId);
  const { data, error } = await filtered.select('id');
  throwIfError(error);
  if (!data || data.length === 0) throw new StaleWriteError();
}

export async function listConversions(
  itemId: string,
): Promise<UnitConversion[]> {
  const { data, error } = await appDb()
    .from('item_unit_conversions')
    .select('item_id, unit, factor_to_base')
    .eq('item_id', itemId)
    .order('unit');
  throwIfError(error);
  return (data ?? []).map((row) => {
    const storedFactor = row.factor_to_base;
    return {
      itemId: row.item_id,
      unit: row.unit,
      factorToBase: toNumber(storedFactor),
      storedFactor:
        typeof storedFactor === 'string' || typeof storedFactor === 'number'
          ? storedFactor
          : toNumber(storedFactor),
    };
  });
}

export async function addConversion(
  itemId: string,
  unit: string,
  factorToBase: number,
): Promise<void> {
  const { data, error } = await appDb()
    .from('item_unit_conversions')
    .insert({
      item_id: itemId,
      unit: unit.trim(),
      factor_to_base: factorToBase,
    })
    .select('unit');
  throwIfError(error);
  if (!data || data.length === 0) throw new Error(genericCatalogError);
}

export async function updateConversion(
  itemId: string,
  unit: string,
  factorToBase: number,
  expectedFactor: number | string,
): Promise<void> {
  const { data, error } = await appDb()
    .from('item_unit_conversions')
    .update({ factor_to_base: factorToBase })
    .eq('item_id', itemId)
    .eq('unit', unit)
    .eq('factor_to_base', expectedFactor as number)
    .select('unit');
  throwIfError(error);
  if (!data || data.length === 0) throw new StaleWriteError();
}

export async function deleteConversion(
  itemId: string,
  unit: string,
  expectedFactor: number | string,
): Promise<void> {
  const { data, error } = await appDb()
    .from('item_unit_conversions')
    .delete()
    .eq('item_id', itemId)
    .eq('unit', unit)
    .eq('factor_to_base', expectedFactor as number)
    .select('unit');
  throwIfError(error);
  if (!data || data.length === 0) throw new StaleWriteError();
}
