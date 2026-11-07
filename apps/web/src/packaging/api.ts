import { currentShiftStart } from '@/items/api';
import {
  ConfirmedRefusalError,
  CostingChangedError,
  genericCatalogError,
} from '@/items/errors';
import type { Json } from '@/lib/database.types';
import { exactDecimal, exactDecimalOrNull } from '@/lib/decimal';
import { keysAfterFilter, readAllByKey, readAllByKeys } from '@/lib/paged';
import { supabase } from '@/lib/supabase';
import { isDefiniteRefusal, isPayloadRefusal } from '@/lib/write-outcome';
import { mapPackagingError } from '@/packaging/errors';
import { canonicalOrderTypeKey } from '@/packaging/format';
import type {
  BasePackagingWrite,
  ObservedOrderType,
  OrderTypePackagingWrite,
  PackagingCatalog,
  PackagingDecision,
  PackagingDetail,
  PackagingHistoryRow,
  PackagingLine,
  PackagingSchedule,
  PackagingVersion,
} from '@/packaging/types';
import { listUnitsMeta } from '@/recipes/api';

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
  if (error.code === '40001' && error.message === 'configuration changed') {
    throw new CostingChangedError();
  }
  const message = mapPackagingError(error);
  if (isPayloadRefusal(error)) throw new ConfirmedRefusalError(message);
  const mapped = new Error(message);
  if (isDefiniteRefusal(error)) Object.assign(mapped, { code: error.code });
  throw mapped;
}

function nullableText(value: string | null): string {
  return value as unknown as string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(genericCatalogError);
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(genericCatalogError);
  return value.map(record);
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(genericCatalogError);
  }
  return value;
}

function countOf(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(genericCatalogError);
}

function decisionOf(value: unknown): PackagingDecision {
  if (value === 'lines' || value === 'none') return value;
  throw new Error(genericCatalogError);
}

function lineOf(row: Record<string, unknown>, lineNo: number): PackagingLine {
  const capacity =
    row.capacity_kg === undefined
      ? null
      : exactDecimalOrNull(row.capacity_kg, genericCatalogError);
  return {
    lineNo,
    stockItemId: requiredText(row.stock_item_id),
    quantity: exactDecimal(row.quantity, genericCatalogError),
    unitCode: requiredText(row.unit_code ?? row.unit),
    capacityKg: capacity,
  };
}

function versionOf(row: Record<string, unknown>): PackagingVersion {
  const to = row.effective_to;
  if (to !== null && typeof to !== 'string') {
    throw new Error(genericCatalogError);
  }
  return {
    id: requiredText(row.id),
    effectiveFrom: requiredText(row.effective_from),
    effectiveTo: to,
    decision: decisionOf(row.decision),
    lines: rows(row.lines).map((line, index) => lineOf(line, index + 1)),
  };
}

export function packagingScheduleOf(value: unknown): PackagingSchedule {
  const row = record(value);
  const subject = row.subject_id;
  if (subject !== null && typeof subject !== 'string') {
    throw new Error(genericCatalogError);
  }
  return {
    subjectId: subject,
    token: requiredText(row.token),
    emptyToken: requiredText(row.empty_token),
    versions: rows(row.versions).map(versionOf),
  };
}

const lineColumns =
  'id, version_id, line_no, stock_item_id, quantity_text:quantity::text, unit_code, capacity_text:capacity_kg::text, subject_id';

async function loadHistory(subjectId: string): Promise<PackagingHistoryRow[]> {
  const versions = await readAllByKey<{
    id: string;
    effective_from: string;
    effective_to: string | null;
    decision: string;
    superseded_change_id: number | null;
  }>((afterId, size) => {
    const query = appDb()
      .from('packaging_versions')
      .select(
        'id, effective_from, effective_to, decision, superseded_change_id',
      )
      .eq('subject_id', subjectId);
    return (afterId === null ? query : query.gt('id', afterId))
      .order('id')
      .limit(size);
  }, genericCatalogError);
  const lines = await readAllByKey<{
    id: string;
    version_id: string;
    line_no: number;
    stock_item_id: string;
    quantity_text: string;
    unit_code: string;
    capacity_text: string | null;
  }>((afterId, size) => {
    const query = appDb()
      .from('packaging_line_rows')
      .select(lineColumns)
      .eq('subject_id', subjectId);
    return (afterId === null ? query : query.gt('id', afterId))
      .order('id')
      .limit(size);
  }, genericCatalogError);
  const grouped = new Map<string, PackagingLine[]>();
  for (const line of lines) {
    if (
      typeof line.version_id !== 'string' ||
      typeof line.stock_item_id !== 'string' ||
      typeof line.unit_code !== 'string' ||
      typeof line.line_no !== 'number'
    ) {
      throw new Error(genericCatalogError);
    }
    const parsed: PackagingLine = {
      lineNo: line.line_no,
      stockItemId: line.stock_item_id,
      quantity: exactDecimal(line.quantity_text, genericCatalogError),
      unitCode: line.unit_code,
      capacityKg: exactDecimalOrNull(line.capacity_text, genericCatalogError),
    };
    const list = grouped.get(line.version_id) ?? [];
    list.push(parsed);
    grouped.set(line.version_id, list);
  }
  return versions
    .map((version) => ({
      id: version.id,
      effectiveFrom: version.effective_from,
      effectiveTo: version.effective_to,
      decision: decisionOf(version.decision),
      lines: (grouped.get(version.id) ?? []).sort(
        (left, right) => left.lineNo - right.lineNo,
      ),
      superseded: version.superseded_change_id !== null,
    }))
    .sort((left, right) => {
      const from = right.effectiveFrom.localeCompare(left.effectiveFrom);
      if (from !== 0) return from;
      return right.id.localeCompare(left.id);
    });
}

async function detailFrom(
  schedule: PackagingSchedule,
): Promise<PackagingDetail> {
  return {
    schedule,
    history: schedule.subjectId ? await loadHistory(schedule.subjectId) : [],
  };
}

export async function loadOrderTypePackaging(
  orderType: string | null,
): Promise<PackagingDetail> {
  const { data, error } = await appDb().rpc('packaging_order_type_schedule', {
    p_order_type: nullableText(orderType),
  });
  throwIfError(error);
  return detailFrom(packagingScheduleOf(data));
}

export async function loadBasePackaging(
  posItemId: string,
  sizeKey: Json,
): Promise<PackagingDetail> {
  const { data, error } = await appDb().rpc('packaging_base_schedule', {
    p_pos_item_id: posItemId,
    p_size_key: sizeKey,
  });
  throwIfError(error);
  return detailFrom(packagingScheduleOf(data));
}

export async function loadObservedOrderTypes(): Promise<ObservedOrderType[]> {
  const list = await readAllByKeys<
    {
      order_type_key: Json;
      order_type_key_text: string;
      order_type_label: string | null;
      order_count: number | string;
      last_ordered_at: string;
    },
    'order_type_key_text'
  >(
    ['order_type_key_text'],
    (after, size) => {
      const query = appDb()
        .from('packaging_observed_order_types')
        .select(
          'order_type_key, order_type_key_text, order_type_label, order_count, last_ordered_at',
        );
      return (
        after === null
          ? query
          : query.or(keysAfterFilter(['order_type_key_text'], after))
      )
        .order('order_type_key_text')
        .limit(size);
    },
    genericCatalogError,
  );
  return list.map((row) => {
    const key = canonicalOrderTypeKey(row.order_type_key);
    if (!key || typeof row.order_type_key_text !== 'string') {
      throw new Error(genericCatalogError);
    }
    if (
      row.order_type_label !== null &&
      typeof row.order_type_label !== 'string'
    ) {
      throw new Error(genericCatalogError);
    }
    if (typeof row.last_ordered_at !== 'string') {
      throw new Error(genericCatalogError);
    }
    return {
      key,
      keyText: row.order_type_key_text,
      label: row.order_type_label,
      orderCount: countOf(row.order_count),
      lastOrderedAt: row.last_ordered_at,
    };
  });
}

export async function loadPackagingCatalog(): Promise<PackagingCatalog> {
  const [itemRows, units, shiftStart] = await Promise.all([
    readAllByKey<{ id: string; name: string; base_unit: string }>(
      (afterId, size) => {
        const query = appDb()
          .from('stock_items')
          .select('id, name, base_unit')
          .eq('kind', 'packaging');
        return (afterId === null ? query : query.gt('id', afterId))
          .order('id')
          .limit(size);
      },
      genericCatalogError,
    ),
    listUnitsMeta(),
    currentShiftStart(),
  ]);
  return {
    items: itemRows
      .map((item) => ({
        id: item.id,
        name: item.name,
        baseUnit: item.base_unit,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ar')),
    units: units
      .map((unit) => ({ code: unit.code, label: unit.labelAr }))
      .sort((left, right) => left.label.localeCompare(right.label, 'ar')),
    shiftStart,
  };
}

export async function setOrderTypePackaging(
  write: OrderTypePackagingWrite,
): Promise<void> {
  const { error } = await appDb().rpc('set_order_type_packaging', {
    p_request_id: write.requestId,
    p_order_type: nullableText(write.orderType),
    p_effective_from: nullableText(write.effectiveFrom),
    p_effective_to: nullableText(write.effectiveTo),
    p_policy: write.policy,
    p_expected_token: write.token,
    p_reason: nullableText(write.reason),
  });
  throwIfError(error);
}

export async function setBasePackaging(
  write: BasePackagingWrite,
): Promise<void> {
  const { error } = await appDb().rpc('set_base_packaging', {
    p_request_id: write.requestId,
    p_pos_item_id: write.posItemId,
    p_size_key: write.sizeKey,
    p_effective_from: nullableText(write.effectiveFrom),
    p_effective_to: nullableText(write.effectiveTo),
    p_policy: write.policy,
    p_expected_token: write.token,
    p_reason: nullableText(write.reason),
  });
  throwIfError(error);
}
