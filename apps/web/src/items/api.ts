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
  type BaseUnit,
  type CatalogItem,
  type ItemDraft,
  type UnitConversion,
} from '@/items/types';

export type { ItemExpectation };

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

function isStaleWrite(error: {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}): boolean {
  const text = [error.message, error.details, error.hint]
    .filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    )
    .join('\n');
  return (
    error.code === '40001' ||
    text.includes('base unit changed') ||
    text.includes('conversion changed')
  );
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

/** Exact decimal text from a PostgREST `::text` cast. Rejects JSON numbers. */
function exactDecimal(value: unknown): string {
  if (typeof value !== 'string') throw new Error(genericCatalogError);
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(genericCatalogError);
  return text;
}

/** PostgREST accepts a JSON decimal string for a numeric column. */
function numericColumn(value: string): number {
  return value as unknown as number;
}

function itemPayload(draft: ItemDraft) {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    base_unit: draft.baseUnit,
    count_frequency: draft.countFrequency,
    loss_pct: numericColumn(draft.lossPct),
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
        'id, name, kind, base_unit, count_frequency, loss_pct, loss_pct_text:loss_pct::text, parent_item_id, active',
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
    const storedLossPct = exactDecimal(row.loss_pct_text);
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
      storedLossPct,
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

export type ConversionList = {
  baseUnit: BaseUnit;
  rows: UnitConversion[];
};

function conversionRows(value: unknown): UnitConversion[] {
  if (!Array.isArray(value)) throw new Error(genericCatalogError);
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error(genericCatalogError);
    const record = row as Record<string, unknown>;
    if (typeof record.item_id !== 'string' || typeof record.unit !== 'string') {
      throw new Error(genericCatalogError);
    }
    return {
      itemId: record.item_id,
      unit: record.unit,
      factorToBase: toNumber(record.factor_to_base),
      storedFactor: exactDecimal(record.factor_text),
    };
  });
}

export async function listConversions(itemId: string): Promise<ConversionList> {
  const { data, error } = await appDb()
    .from('stock_items')
    .select(
      'base_unit, item_unit_conversions(item_id, unit, factor_to_base, factor_text:factor_to_base::text)',
    )
    .eq('id', itemId)
    .maybeSingle();
  throwIfError(error);
  if (!data) throw new StaleWriteError();
  if (!isBaseUnit(data.base_unit)) throw new Error(genericCatalogError);
  const rows = conversionRows(data.item_unit_conversions);
  rows.sort((left, right) => left.unit.localeCompare(right.unit));
  return { baseUnit: data.base_unit, rows };
}

export async function addConversion(
  itemId: string,
  unit: string,
  factorToBase: string,
  expectedBaseUnit: BaseUnit,
): Promise<void> {
  const { error } = await appDb().rpc('add_unit_conversion', {
    p_item_id: itemId,
    p_unit: unit.trim(),
    p_factor: numericColumn(factorToBase),
    p_expected_base_unit: expectedBaseUnit,
  });
  if (error && isStaleWrite(error)) throw new StaleWriteError();
  throwIfError(error);
}

export async function updateConversion(
  itemId: string,
  unit: string,
  factorToBase: string,
  expectedFactor: string,
  expectedBaseUnit: BaseUnit,
): Promise<void> {
  const { error } = await appDb().rpc('update_unit_conversion', {
    p_item_id: itemId,
    p_unit: unit,
    p_expected_factor: numericColumn(expectedFactor),
    p_factor: numericColumn(factorToBase),
    p_expected_base_unit: expectedBaseUnit,
  });
  if (error && isStaleWrite(error)) throw new StaleWriteError();
  throwIfError(error);
}

export async function deleteConversion(
  itemId: string,
  unit: string,
  expectedFactor: string,
  expectedBaseUnit: BaseUnit,
): Promise<void> {
  const { error } = await appDb().rpc('delete_unit_conversion', {
    p_item_id: itemId,
    p_unit: unit,
    p_expected_factor: numericColumn(expectedFactor),
    p_expected_base_unit: expectedBaseUnit,
  });
  if (error && isStaleWrite(error)) throw new StaleWriteError();
  throwIfError(error);
}
