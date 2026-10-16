import { genericCatalogError, mapCatalogError } from '@/items/errors';
import { supabase } from '@/lib/supabase';
import {
  isBaseUnit,
  isCountFrequency,
  isStockKind,
  type CatalogItem,
  type ItemDraft,
  type UnitConversion,
} from '@/items/types';

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
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUnit: row.base_unit,
      countFrequency: row.count_frequency,
      lossPct: toNumber(row.loss_pct),
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

export async function updateItem(id: string, draft: ItemDraft): Promise<void> {
  const { data, error } = await appDb()
    .from('stock_items')
    .update(itemPayload(draft))
    .eq('id', id)
    .select('id');
  throwIfError(error);
  if (!data || data.length === 0) throw new Error(genericCatalogError);
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
  return (data ?? []).map((row) => ({
    itemId: row.item_id,
    unit: row.unit,
    factorToBase: toNumber(row.factor_to_base),
  }));
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
): Promise<void> {
  const { data, error } = await appDb()
    .from('item_unit_conversions')
    .update({ factor_to_base: factorToBase })
    .eq('item_id', itemId)
    .eq('unit', unit)
    .select('unit');
  throwIfError(error);
  if (!data || data.length === 0) throw new Error(genericCatalogError);
}

export async function deleteConversion(
  itemId: string,
  unit: string,
): Promise<void> {
  const { data, error } = await appDb()
    .from('item_unit_conversions')
    .delete()
    .eq('item_id', itemId)
    .eq('unit', unit)
    .select('unit');
  throwIfError(error);
  if (!data || data.length === 0) throw new Error(genericCatalogError);
}
