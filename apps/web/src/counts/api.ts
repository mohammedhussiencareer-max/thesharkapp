import type { Json } from '@/lib/database.types';
import { isBaseUnit } from '@/items/types';
import { fetchAllPages, maxPages, pageSize, PageCapError } from '@/lib/paged';
import { supabase } from '@/lib/supabase';
import {
  genericCountError,
  isUnknownOutcome,
  mapCountError,
  retrySafeMessage,
} from '@/counts/errors';
import type {
  CountDraft,
  CountItem,
  CountRecord,
  CountWriteResult,
  PendingCount,
} from '@/counts/types';

function appDb() {
  if (!supabase) throw new Error(genericCountError);
  return supabase.schema('app');
}

async function readPages<T>(
  load: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: T[] | null;
    error: Parameters<typeof throwIfError>[0];
  }>,
  keyOf: (row: T) => string,
): Promise<T[]> {
  try {
    return await fetchAllPages(async (from, to) => {
      const result = await load(from, to);
      throwIfError(result.error);
      return { data: result.data, error: null };
    }, keyOf);
  } catch (error) {
    if (error instanceof PageCapError) {
      throw new Error(genericCountError, { cause: error });
    }
    throw error;
  }
}

async function writeRpc(
  call: () => PromiseLike<{
    data: unknown;
    error: Parameters<typeof throwIfError>[0];
  }>,
): Promise<unknown> {
  let result: {
    data: unknown;
    error: Parameters<typeof throwIfError>[0];
  };
  try {
    result = await call();
  } catch (error) {
    throw new Error(retrySafeMessage, { cause: error });
  }
  if (!result.error) return result.data;
  const mapped = mapCountError(result.error);
  const message =
    mapped === genericCountError && isUnknownOutcome(result.error)
      ? retrySafeMessage
      : mapped;
  throw new Error(message, { cause: result.error });
}

function throwIfError(
  error: {
    code?: string;
    message?: string;
    details?: string | null;
    hint?: string | null;
  } | null,
): void {
  if (error) throw new Error(mapCountError(error));
}

/** Exact decimal text from a PostgREST `::text` cast. Rejects JSON numbers. */
function exactDecimal(value: unknown): string {
  if (typeof value !== 'string') throw new Error(genericCountError);
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(genericCountError);
  return text;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    if (!first || typeof first !== 'object') return null;
    return first as Record<string, unknown>;
  }
  if (typeof value !== 'object') throw new Error(genericCountError);
  return value as Record<string, unknown>;
}

function balanceOf(value: unknown): {
  onHandQty: string;
  onHandValue: string;
  avgCost: string;
} {
  const row = record(value);
  if (!row) {
    return { onHandQty: '0', onHandValue: '0.00', avgCost: '0' };
  }
  return {
    onHandQty: exactDecimal(row.on_hand_qty_text),
    onHandValue: exactDecimal(row.on_hand_value_text),
    avgCost: exactDecimal(row.avg_cost_text),
  };
}

function byNameThenId(
  left: { name: string; id: string },
  right: { name: string; id: string },
): number {
  return (
    left.name.localeCompare(right.name, 'ar') ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

export async function listDailyItems(): Promise<CountItem[]> {
  // Page by id, which never changes. Active and frequency are applied after
  // the read: a server filter would let a row change shift the next page.
  const all = await readPages(
    (from, to) =>
      appDb()
        .from('stock_items')
        .select(
          'id, name, base_unit, active, count_frequency, item_balances(on_hand_qty_text:on_hand_qty::text, on_hand_value_text:on_hand_value::text, avg_cost_text:avg_cost::text)',
        )
        .order('id', { ascending: true })
        .range(from, to),
    (row) => row.id,
  );
  const daily = all.filter(
    (row) => row.active === true && row.count_frequency === 'daily',
  );
  return daily.sort(byNameThenId).map((row) => {
    if (!isBaseUnit(row.base_unit)) throw new Error(genericCountError);
    const balance = balanceOf(row.item_balances);
    return {
      id: row.id,
      name: row.name,
      baseUnit: row.base_unit,
      onHandQty: balance.onHandQty,
      onHandValue: balance.onHandValue,
      avgCost: balance.avgCost,
    };
  });
}

function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function listCounts(): Promise<CountRecord[]> {
  const data = await readPages(
    (from, to) =>
      appDb()
        .from('stock_count_history')
        .select(
          'id, counted_at, frequency, created_at, note, item_count, shortage_value_text:shortage_value::text, surplus_value_text:surplus_value::text, has_surplus, revised_difference_text:revised_difference::text, compensator_sum_text:compensator_sum::text, has_compensator',
        )
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    (row) => {
      if (typeof row.id !== 'string' || row.id.length === 0) {
        throw new Error(genericCountError);
      }
      return row.id;
    },
  );
  data.sort((left, right) => {
    const at =
      timeValue(right.counted_at ?? '') - timeValue(left.counted_at ?? '') ||
      timeValue(right.created_at ?? '') - timeValue(left.created_at ?? '');
    if (at !== 0) return at;
    const leftId = left.id ?? '';
    const rightId = right.id ?? '';
    return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
  });

  return data.map((row) => {
    if (
      typeof row.id !== 'string' ||
      typeof row.counted_at !== 'string' ||
      typeof row.created_at !== 'string' ||
      (row.frequency !== 'daily' && row.frequency !== 'weekly') ||
      typeof row.item_count !== 'number' ||
      !Number.isInteger(row.item_count) ||
      typeof row.has_surplus !== 'boolean' ||
      typeof row.has_compensator !== 'boolean'
    ) {
      throw new Error(genericCountError);
    }
    const note = row.note;
    if (note !== null && typeof note !== 'string') {
      throw new Error(genericCountError);
    }
    return {
      id: row.id,
      countedAt: row.counted_at,
      frequency: row.frequency,
      createdAt: row.created_at,
      note,
      itemCount: row.item_count,
      shortageValue: exactDecimal(row.shortage_value_text),
      surplusValue: exactDecimal(row.surplus_value_text),
      hasSurplus: row.has_surplus,
      revisedDifference: exactDecimal(row.revised_difference_text),
      compensatorSum: exactDecimal(row.compensator_sum_text),
      hasCompensator: row.has_compensator,
    };
  });
}

function countPayload(draft: CountDraft): Json {
  return {
    request_id: draft.requestId,
    frequency: 'daily',
    counted_at: draft.countedAt,
    note: draft.note,
    lines: draft.lines.map((line) => ({
      item_id: line.itemId,
      counted_qty: line.countedQty,
      expected_base_unit: line.expectedBaseUnit,
    })),
  };
}

function parseCountWrite(data: unknown): CountWriteResult {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error(retrySafeMessage, { cause: error });
    }
  }
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(retrySafeMessage);
  }
  const row = value as Record<string, unknown>;
  if (typeof row.status !== 'string') {
    throw new Error(retrySafeMessage);
  }
  if (row.status === 'waiting_for_sync') return { status: 'waiting_for_sync' };
  if (
    row.status === 'posted' &&
    typeof row.count_id === 'string' &&
    row.count_id.length > 0
  ) {
    return { status: 'posted', countId: row.count_id };
  }
  throw new Error(retrySafeMessage);
}

export async function recordCount(
  draft: CountDraft,
): Promise<CountWriteResult> {
  const data = await writeRpc(() =>
    appDb().rpc('record_count', { p_count: countPayload(draft) }),
  );
  return parseCountWrite(data);
}

/** Resend the stored payload unchanged, including exact counted_qty strings and the pinned unit. */
export async function recordStoredCount(
  payload: Json,
): Promise<CountWriteResult> {
  const data = await writeRpc(() =>
    appDb().rpc('record_count', { p_count: payload }),
  );
  return parseCountWrite(data);
}

type PendingRow = {
  request_id: string | null;
  prepared_at: string | null;
  counted_at: string | null;
  item_count: number | null;
  payload: Json | null;
};

function byPreparedThenRequest(left: PendingRow, right: PendingRow): number {
  const at =
    timeValue(left.prepared_at ?? '') - timeValue(right.prepared_at ?? '');
  if (at !== 0) return at;
  const leftId = left.request_id ?? '';
  const rightId = right.request_id ?? '';
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/**
 * Pending rows leave the view when they post. Offset pages would then skip
 * the row that shifted into the previous page. request_id is unique and does
 * not change, so the next page starts after the last id already read.
 */
type PendingPage = {
  data: PendingRow[] | null;
  error: Parameters<typeof throwIfError>[0];
};

async function loadPendingPage(after: string | null): Promise<PendingPage> {
  const pending = appDb()
    .from('stock_count_pending')
    .select('request_id, prepared_at, counted_at, item_count, payload')
    .order('request_id', { ascending: true });
  if (after === null) return pending.limit(pageSize);
  return pending.gt('request_id', after).limit(pageSize);
}

async function readPendingPages(): Promise<PendingRow[]> {
  const rows: PendingRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await loadPendingPage(after);
    throwIfError(result.error);
    const batch = result.data ?? [];
    if (batch.length > pageSize) throw new Error(genericCountError);
    for (const row of batch) {
      if (typeof row.request_id !== 'string' || row.request_id.length === 0) {
        throw new Error(genericCountError);
      }
    }
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
    const last = batch[batch.length - 1]?.request_id;
    if (typeof last !== 'string' || (after !== null && last <= after)) {
      throw new Error(genericCountError);
    }
    after = last;
  }
  throw new PageCapError();
}

export async function listPendingCounts(): Promise<PendingCount[]> {
  let data: PendingRow[];
  try {
    data = await readPendingPages();
  } catch (error) {
    if (error instanceof PageCapError) {
      throw new Error(genericCountError, { cause: error });
    }
    throw error;
  }
  data.sort(byPreparedThenRequest);
  return data.map((row) => {
    if (
      typeof row.request_id !== 'string' ||
      typeof row.prepared_at !== 'string' ||
      typeof row.counted_at !== 'string' ||
      typeof row.item_count !== 'number' ||
      !Number.isInteger(row.item_count) ||
      row.payload === null ||
      typeof row.payload !== 'object' ||
      Array.isArray(row.payload)
    ) {
      throw new Error(genericCountError);
    }
    return {
      requestId: row.request_id,
      preparedAt: row.prepared_at,
      countedAt: row.counted_at,
      itemCount: row.item_count,
      payload: row.payload,
    };
  });
}
