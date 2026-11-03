import {
  CostingChangedError,
  genericCatalogError,
  mapCatalogError,
  StaleWriteError,
} from '@/items/errors';
import type { ItemExpectation } from '@/items/expectation';
import { emptyScheduleToken } from '@/items/effective';
import { exactDecimal } from '@/lib/decimal';
import { isDefiniteRefusal, isUnknownOutcome } from '@/lib/write-outcome';
import { supabase } from '@/lib/supabase';
import {
  isBaseUnit,
  isCountFrequency,
  isStockKind,
  type BaseUnit,
  type CatalogItem,
  type CostingImpact,
  type CostingSchedule,
  type CostingVersion,
  type DatedWrite,
  type ItemDraft,
  type UnitCatalogOption,
  type UnitConversion,
  type UnitSource,
} from '@/items/types';

export type { ItemExpectation };

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

type PostgrestError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

function throwIfError(error: PostgrestError | null): void {
  if (!error) return;
  if (error.code === '40001') throw new CostingChangedError();
  throw new Error(mapCatalogError(error));
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** PostgREST accepts a JSON decimal string for a numeric column. */
function numericColumn(value: string): number {
  return value as unknown as number;
}

function nullableNumeric(value: string | null): number {
  if (value === null) return null as unknown as number;
  return numericColumn(value);
}

function nullableText(value: string | null): string {
  return value as unknown as string;
}

function itemPayload(draft: ItemDraft) {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    base_unit: draft.baseUnit,
    count_frequency: draft.countFrequency,
    parent_item_id: draft.parentItemId,
    active: draft.active,
  };
}

function itemBalance(value: unknown): {
  on_hand_qty: unknown;
  avg_cost: unknown;
  on_hand_value: unknown;
} | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(genericCatalogError);
  }
  const record = value as Record<string, unknown>;
  return {
    on_hand_qty: record.on_hand_qty,
    avg_cost: record.avg_cost,
    on_hand_value: record.on_hand_value,
  };
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error(genericCatalogError);
    return row as Record<string, unknown>;
  });
}

function instantMs(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return Number.NaN;
  return Date.parse(value);
}

function coversNow(row: Record<string, unknown>, nowMs: number): boolean {
  if (row.superseded_change_id != null) return false;
  const from = instantMs(row.effective_from);
  if (Number.isNaN(from) || from > nowMs) return false;
  if (row.effective_to == null) return true;
  const to = instantMs(row.effective_to);
  return !Number.isNaN(to) && nowMs < to;
}

const pendingRequests = new Map<string, string>();

function requestIdFor(key: string): string {
  const existing = pendingRequests.get(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  pendingRequests.set(key, next);
  return next;
}

function finishRequest(key: string, error: unknown): void {
  if (error === undefined || !isUnknownOutcome(error)) {
    pendingRequests.delete(key);
  }
}

export async function listItems(): Promise<CatalogItem[]> {
  const { data, error } = await appDb()
    .from('stock_items')
    .select(
      'id, name, kind, base_unit, count_frequency, parent_item_id, active, item_balances(on_hand_qty, avg_cost, on_hand_value), item_loss_versions(loss_pct, loss_text:loss_pct::text, effective_from, effective_to, superseded_change_id), item_conversion_versions(id, superseded_change_id), item_opening_prices(id, price_text:unit_cost::text, superseded_change_id)',
    )
    .order('name');
  throwIfError(error);
  const nowMs = Date.now();

  return (data ?? []).map((row) => {
    if (
      !isStockKind(row.kind) ||
      !isBaseUnit(row.base_unit) ||
      !isCountFrequency(row.count_frequency)
    ) {
      throw new Error(genericCatalogError);
    }
    const balance = itemBalance(row.item_balances);
    const loss = rowsOf(row.item_loss_versions).find((version) =>
      coversNow(version, nowMs),
    );
    const lossFractionText = loss
      ? exactDecimal(loss.loss_text, genericCatalogError)
      : null;
    const opening = rowsOf(row.item_opening_prices).find(
      (price) => price.superseded_change_id == null,
    );
    const configured =
      rowsOf(row.item_loss_versions).some(
        (version) => version.superseded_change_id == null,
      ) ||
      rowsOf(row.item_conversion_versions).some(
        (version) => version.superseded_change_id == null,
      ) ||
      opening !== undefined ||
      balance !== null;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUnit: row.base_unit,
      countFrequency: row.count_frequency,
      lossPct: lossFractionText === null ? null : toNumber(loss?.loss_pct),
      lossFractionText,
      identityLocked: configured,
      openingPriceId:
        opening && typeof opening.id === 'string' ? opening.id : null,
      openingPriceText: opening
        ? exactDecimal(opening.price_text, genericCatalogError)
        : null,
      parentItemId: row.parent_item_id,
      active: row.active,
      onHandQty: balance ? toNumber(balance.on_hand_qty) : 0,
      avgCost: balance ? toNumber(balance.avg_cost) : 0,
      onHandValue: balance ? toNumber(balance.on_hand_value) : 0,
    };
  });
}

export async function createItem(draft: ItemDraft): Promise<void> {
  const key = `create:${JSON.stringify(itemPayload(draft))}:${draft.lossPct ?? ''}`;
  const requestId = requestIdFor(key);
  try {
    const { data, error } = await appDb().rpc('create_stock_item', {
      p_request_id: requestId,
      p_name: draft.name.trim(),
      p_kind: draft.kind,
      p_base_unit: draft.baseUnit,
      p_count_frequency: draft.countFrequency,
      p_parent_item_id: nullableText(draft.parentItemId),
      p_loss_pct: nullableNumeric(draft.lossPct),
      p_active: draft.active,
    });
    throwIfError(error);
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error(genericCatalogError);
    }
    finishRequest(key, undefined);
  } catch (error) {
    finishRequest(key, error);
    throw error;
  }
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
    .eq('active', expected.active);
  const filtered =
    expected.parentItemId === null
      ? matched.is('parent_item_id', null)
      : matched.eq('parent_item_id', expected.parentItemId);
  const { data, error } = await filtered.select('id');
  throwIfError(error);
  if (!data || data.length === 0) throw new StaleWriteError();
}

function isSource(value: unknown): value is UnitSource {
  return value === 'base' || value === 'explicit' || value === 'implicit';
}

export type ConversionList = {
  baseUnit: BaseUnit;
  rows: UnitConversion[];
};

export async function listConversions(itemId: string): Promise<ConversionList> {
  const { data, error } = await appDb()
    .from('item_units_current')
    .select(
      'item_id, unit_code, label_ar, factor_to_base, factor_text, source, version_id, effective_from',
    )
    .eq('item_id', itemId);
  throwIfError(error);
  const raw = data ?? [];
  if (raw.length === 0) {
    const item = await appDb()
      .from('stock_items')
      .select('base_unit')
      .eq('id', itemId)
      .maybeSingle();
    throwIfError(item.error);
    if (!item.data || !isBaseUnit(item.data.base_unit)) {
      throw new StaleWriteError();
    }
    return { baseUnit: item.data.base_unit, rows: [] };
  }
  const base = raw.find((row) => row.source === 'base');
  const baseCode = base?.unit_code ?? '';
  if (!isBaseUnit(baseCode)) {
    throw new Error(genericCatalogError);
  }
  const rows = raw
    .filter((row) => row.source !== 'base')
    .map((row) => {
      if (
        row.item_id !== itemId ||
        typeof row.unit_code !== 'string' ||
        typeof row.label_ar !== 'string' ||
        !isSource(row.source)
      ) {
        throw new Error(genericCatalogError);
      }
      return {
        itemId,
        unit: row.unit_code,
        label: row.label_ar,
        factorToBase: toNumber(row.factor_to_base),
        storedFactor: exactDecimal(row.factor_text, genericCatalogError),
        source: row.source,
        effectiveFrom: row.effective_from,
        versionId: row.version_id,
      };
    });
  rows.sort((left, right) =>
    (left.label ?? left.unit).localeCompare(right.label ?? right.unit, 'ar'),
  );
  return { baseUnit: baseCode, rows };
}

export async function listUnitOptions(): Promise<UnitCatalogOption[]> {
  const { data, error } = await appDb()
    .from('units')
    .select('code, label_ar')
    .order('label_ar');
  throwIfError(error);
  return (data ?? []).map((row) => ({ code: row.code, labelAr: row.label_ar }));
}

function versionOf(value: unknown, valueKey: string): CostingVersion {
  if (!value || typeof value !== 'object') throw new Error(genericCatalogError);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.effective_from !== 'string') {
    throw new Error(genericCatalogError);
  }
  const payload = row[valueKey];
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    effectiveTo: typeof row.effective_to === 'string' ? row.effective_to : null,
    valueText:
      typeof payload === 'string'
        ? payload
        : typeof payload === 'number'
          ? String(payload)
          : exactDecimal(payload, genericCatalogError),
  };
}

export async function listCostingSchedule(
  itemId: string,
): Promise<CostingSchedule> {
  const { data, error } = await appDb().rpc('item_costing_schedule', {
    p_item_id: itemId,
  });
  throwIfError(error);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(genericCatalogError);
  }
  const record = data as Record<string, unknown>;
  const loss = record.loss;
  if (!loss || typeof loss !== 'object' || Array.isArray(loss)) {
    throw new Error(genericCatalogError);
  }
  const lossRow = loss as Record<string, unknown>;
  if (typeof lossRow.token !== 'string' || !Array.isArray(lossRow.versions)) {
    throw new Error(genericCatalogError);
  }
  if (!Array.isArray(record.conversions)) throw new Error(genericCatalogError);
  return {
    lossToken: lossRow.token,
    lossVersions: lossRow.versions.map((version) =>
      versionOf(version, 'loss_pct'),
    ),
    conversions: record.conversions.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(genericCatalogError);
      }
      const row = entry as Record<string, unknown>;
      if (
        typeof row.unit_code !== 'string' ||
        typeof row.token !== 'string' ||
        !Array.isArray(row.versions)
      ) {
        throw new Error(genericCatalogError);
      }
      return {
        unitCode: row.unit_code,
        token: row.token,
        versions: row.versions.map((version) =>
          versionOf(version, 'factor_to_base'),
        ),
      };
    }),
  };
}

export async function currentShiftStart(): Promise<string | null> {
  const { data, error } = await appDb().rpc('current_shift_start');
  throwIfError(error);
  return typeof data === 'string' && data.length > 0 ? data : null;
}

export async function costingImpact(
  fromIso: string,
  toIso: string | null,
  itemId: string,
): Promise<CostingImpact> {
  const { data, error } = await appDb().rpc('costing_impact', {
    p_from: fromIso,
    p_to: nullableText(toIso),
    p_item_id: itemId,
  });
  throwIfError(error);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(genericCatalogError);
  }
  const row = data as Record<string, unknown>;
  return {
    orders: toNumber(row.orders),
    shifts: toNumber(row.shifts),
    movements: row.movements == null ? null : toNumber(row.movements),
  };
}

async function callDated(
  key: string,
  call: (requestId: string) => PromiseLike<{ error: PostgrestError | null }>,
  timing: DatedWrite | undefined,
): Promise<void> {
  const requestId = timing?.requestId ?? requestIdFor(key);
  if (!timing) pendingRequests.set(key, requestId);
  try {
    const { error } = await call(requestId);
    throwIfError(error);
    if (!timing) finishRequest(key, undefined);
  } catch (error) {
    if (!timing) finishRequest(key, error);
    if (isDefiniteRefusal(error) || error instanceof CostingChangedError) {
      throw error;
    }
    throw error;
  }
}

export async function setItemLoss(
  itemId: string,
  lossFraction: string,
  timing: DatedWrite,
): Promise<void> {
  await callDated(
    `loss:${itemId}:${lossFraction}:${timing.effectiveFrom ?? 'now'}`,
    (requestId) =>
      appDb().rpc('set_item_loss', {
        p_request_id: timing.requestId || requestId,
        p_item_id: itemId,
        p_loss_pct: numericColumn(lossFraction),
        p_effective_from: nullableText(timing.effectiveFrom),
        p_effective_to: nullableText(timing.effectiveTo),
        p_expected_token: timing.token,
        p_reason: nullableText(timing.reason),
      }),
    timing,
  );
}

export async function setItemConversion(
  itemId: string,
  unitCode: string,
  factor: string | null,
  timing: DatedWrite,
): Promise<void> {
  await callDated(
    `conv:${itemId}:${unitCode}:${factor ?? ''}:${timing.effectiveFrom ?? 'now'}`,
    () =>
      appDb().rpc('set_item_conversion', {
        p_request_id: timing.requestId,
        p_item_id: itemId,
        p_unit_code: unitCode,
        p_factor: nullableNumeric(factor),
        p_effective_from: nullableText(timing.effectiveFrom),
        p_effective_to: nullableText(timing.effectiveTo),
        p_expected_token: timing.token,
        p_reason: nullableText(timing.reason),
      }),
    timing,
  );
}

export async function addCustomUnit(
  code: string,
  labelAr: string,
  requestId?: string,
): Promise<string> {
  const key = `unit:${code}:${labelAr}`;
  const id = requestId ?? requestIdFor(key);
  try {
    const { data, error } = await appDb().rpc('add_custom_unit', {
      p_request_id: id,
      p_code: code.trim(),
      p_label_ar: labelAr.trim(),
    });
    throwIfError(error);
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error(genericCatalogError);
    }
    if (!requestId) finishRequest(key, undefined);
    return data;
  } catch (error) {
    if (!requestId) finishRequest(key, error);
    throw error;
  }
}

export async function setOpeningPrice(
  itemId: string,
  price: string,
  reason: string | null,
  expectedId: string | null,
  requestId: string,
): Promise<void> {
  const { error } = await appDb().rpc('set_item_opening_price', {
    p_request_id: requestId,
    p_item_id: itemId,
    p_unit_cost: numericColumn(price),
    p_zero_cost_reason: nullableText(reason),
    p_expected_current_id: nullableText(expectedId),
  });
  throwIfError(error);
}

function datedOrNow(
  itemId: string,
  unit: string,
  factor: string | null,
  timing: DatedWrite | undefined,
): DatedWrite {
  return (
    timing ?? {
      effectiveFrom: null,
      effectiveTo: null,
      token: emptyScheduleToken,
      reason: null,
      requestId: requestIdFor(`conv:${itemId}:${unit}:${factor ?? ''}:now`),
    }
  );
}

export async function addConversion(
  itemId: string,
  unit: string,
  factorToBase: string,
  _expectedBaseUnit: BaseUnit,
  timing?: DatedWrite,
): Promise<void> {
  await setItemConversion(
    itemId,
    unit.trim(),
    factorToBase,
    datedOrNow(itemId, unit, factorToBase, timing),
  );
}

export async function updateConversion(
  itemId: string,
  unit: string,
  factorToBase: string,
  _expectedFactor: string,
  _expectedBaseUnit: BaseUnit,
  timing?: DatedWrite,
): Promise<void> {
  await setItemConversion(
    itemId,
    unit,
    factorToBase,
    datedOrNow(itemId, unit, factorToBase, timing),
  );
}

export async function deleteConversion(
  itemId: string,
  unit: string,
  _expectedFactor: string,
  _expectedBaseUnit: BaseUnit,
  timing?: DatedWrite,
): Promise<void> {
  await setItemConversion(
    itemId,
    unit,
    null,
    datedOrNow(itemId, unit, null, timing),
  );
}
