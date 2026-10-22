import type { Json } from '@/lib/database.types';
import { fetchAllPages, PageCapError } from '@/lib/paged';
import { supabase } from '@/lib/supabase';
import {
  genericSortError,
  isUnknownOutcome,
  mapSortError,
  retrySafeMessage,
} from '@/sorting/errors';
import type {
  MixedFish,
  SizeChoice,
  SortDraft,
  SortFilter,
  SortLine,
  SortRecord,
} from '@/sorting/types';

function appDb() {
  if (!supabase) throw new Error(genericSortError);
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
      throw new Error(genericSortError, { cause: error });
    }
    throw error;
  }
}

async function writeRpc(
  call: () => PromiseLike<{
    error: Parameters<typeof throwIfError>[0];
  }>,
): Promise<void> {
  let result: { error: Parameters<typeof throwIfError>[0] };
  try {
    result = await call();
  } catch (error) {
    throw new Error(retrySafeMessage, { cause: error });
  }
  if (!result.error) return;
  const mapped = mapSortError(result.error);
  // A definite refusal already rolled back, so its mapped text stands.
  // An unknown outcome (anything off the allow-list, including 23505 and
  // PostgREST codes) is retry-safe when there is no specific Arabic mapping.
  const message =
    mapped === genericSortError && isUnknownOutcome(result.error)
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
  if (error) throw new Error(mapSortError(error));
}

/** Exact decimal text from a PostgREST `::text` cast. Rejects JSON numbers. */
function exactDecimal(value: unknown): string {
  if (typeof value !== 'string') throw new Error(genericSortError);
  const text = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(genericSortError);
  return text;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    if (!first || typeof first !== 'object') return null;
    return first as Record<string, unknown>;
  }
  if (typeof value !== 'object') throw new Error(genericSortError);
  return value as Record<string, unknown>;
}

function balanceOf(value: unknown): {
  onHandQty: string;
  onHandValue: string;
  avgCost: string;
  hasUncoveredDeficit: boolean;
} {
  const row = record(value);
  if (!row) {
    return {
      onHandQty: '0',
      onHandValue: '0.00',
      avgCost: '0',
      hasUncoveredDeficit: false,
    };
  }
  return {
    onHandQty: exactDecimal(row.on_hand_qty_text),
    onHandValue: exactDecimal(row.on_hand_value_text),
    avgCost: exactDecimal(row.avg_cost_text),
    hasUncoveredDeficit: row.has_uncovered_deficit === true,
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

export async function listMixedFish(): Promise<MixedFish[]> {
  // Page by id, which never changes. Active and kind are applied after the
  // read: a server filter would let a row change shift the next page and skip
  // an item that is still active.
  const all = await readPages(
    (from, to) =>
      appDb()
        .from('stock_items')
        .select(
          'id, name, kind, base_unit, parent_item_id, active, item_balances(on_hand_qty_text:on_hand_qty::text, on_hand_value_text:on_hand_value::text, avg_cost_text:avg_cost::text, has_uncovered_deficit)',
        )
        .order('id', { ascending: true })
        .range(from, to),
    (row) => row.id,
  );
  const active = all.filter((row) => row.active === true);
  const mixedRows = active.filter(
    (row) => row.kind === 'fish_mixed' && row.base_unit === 'kg',
  );
  const sizeRows = active.filter(
    (row) =>
      row.kind === 'fish_size' &&
      row.base_unit === 'kg' &&
      typeof row.parent_item_id === 'string',
  );
  const sizesByParent = new Map<string, SizeChoice[]>();
  for (const row of sizeRows) {
    const parentId = row.parent_item_id;
    if (typeof parentId !== 'string') continue;
    const list = sizesByParent.get(parentId) ?? [];
    list.push({ id: row.id, name: row.name });
    sizesByParent.set(parentId, list);
  }
  for (const list of sizesByParent.values()) list.sort(byNameThenId);

  return mixedRows.sort(byNameThenId).map((row) => {
    const balance = balanceOf(row.item_balances);
    return {
      id: row.id,
      name: row.name,
      onHandQty: balance.onHandQty,
      onHandValue: balance.onHandValue,
      avgCost: balance.avgCost,
      hasUncoveredDeficit: balance.hasUncoveredDeficit,
      sizes: sizesByParent.get(row.id) ?? [],
    };
  });
}

const lineChunk = 100;

function sortLine(row: Record<string, unknown>): {
  batchId: string;
  line: SortLine;
} {
  const item = record(row.stock_items);
  if (!item || typeof item.name !== 'string') {
    throw new Error(genericSortError);
  }
  if (
    typeof row.batch_id !== 'string' ||
    typeof row.size_item_id !== 'string'
  ) {
    throw new Error(genericSortError);
  }
  const lineNo = row.line_no;
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo)) {
    throw new Error(genericSortError);
  }
  return {
    batchId: row.batch_id,
    line: {
      lineNo,
      itemId: row.size_item_id,
      itemName: item.name,
      quantity: exactDecimal(row.quantity_text),
    },
  };
}

async function linesByBatch(
  batchIds: readonly string[],
): Promise<Map<string, SortLine[]>> {
  const grouped = new Map<string, SortLine[]>();
  for (let index = 0; index < batchIds.length; index += lineChunk) {
    const ids = batchIds.slice(index, index + lineChunk);
    const page = await readPages(
      (from, to) =>
        appDb()
          .from('sort_batch_lines')
          .select(
            'batch_id, line_no, size_item_id, quantity_text:quantity::text, stock_items(name)',
          )
          .in('batch_id', ids)
          .order('batch_id', { ascending: true })
          .order('line_no', { ascending: true })
          .range(from, to),
      (row) => `${String(row.batch_id)}:${String(row.line_no)}`,
    );
    for (const row of page) {
      const parsed = sortLine(row);
      const list = grouped.get(parsed.batchId) ?? [];
      list.push(parsed.line);
      grouped.set(parsed.batchId, list);
    }
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => left.lineNo - right.lineNo);
  }
  return grouped;
}

export async function listSorts(
  filter: SortFilter = {},
): Promise<SortRecord[]> {
  const data = await readPages(
    (from, to) => {
      // Sorts are append-only: page by insert time + id, then show the newest
      // sort first. The date filter uses occurred_at, which is not edited.
      let query = appDb()
        .from('sort_history')
        .select(
          'id, mixed_item_id, mixed_item_name, occurred_at, created_at, note, qty_taken_text:qty_taken::text, sizes_qty_text:sizes_qty::text, loss_qty_text:loss_qty::text, loss_value_text:loss_value::text, cost_per_kg_text:cost_per_kg::text',
        )
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (filter.from) query = query.gte('occurred_at', filter.from);
      if (filter.toExclusive)
        query = query.lt('occurred_at', filter.toExclusive);
      return query.range(from, to);
    },
    (row) => {
      if (typeof row.id !== 'string' || row.id.length === 0) {
        throw new Error(genericSortError);
      }
      return row.id;
    },
  );
  data.sort((left, right) => {
    const at =
      Date.parse(right.occurred_at ?? '') -
        Date.parse(left.occurred_at ?? '') ||
      Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? '');
    if (at !== 0) return at;
    const leftId = left.id ?? '';
    const rightId = right.id ?? '';
    return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
  });
  const lines = await linesByBatch(
    data.flatMap((row) => (typeof row.id === 'string' ? [row.id] : [])),
  );

  return data.map((row) => {
    if (
      typeof row.id !== 'string' ||
      typeof row.mixed_item_id !== 'string' ||
      typeof row.mixed_item_name !== 'string' ||
      typeof row.occurred_at !== 'string' ||
      typeof row.created_at !== 'string'
    ) {
      throw new Error(genericSortError);
    }
    const note = row.note;
    if (note !== null && typeof note !== 'string') {
      throw new Error(genericSortError);
    }
    return {
      id: row.id,
      mixedItemId: row.mixed_item_id,
      mixedItemName: row.mixed_item_name,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      note,
      qtyTaken: exactDecimal(row.qty_taken_text),
      sizesQty: exactDecimal(row.sizes_qty_text),
      lossQty: exactDecimal(row.loss_qty_text),
      lossValue: exactDecimal(row.loss_value_text),
      costPerKg: exactDecimal(row.cost_per_kg_text),
      lines: lines.get(row.id) ?? [],
    };
  });
}

function sortPayload(draft: SortDraft): Json {
  return {
    request_id: draft.requestId,
    mixed_item_id: draft.mixedItemId,
    occurred_at: draft.occurredAt,
    qty_taken: draft.qtyTaken,
    note: draft.note,
    lines: draft.lines.map((line) => ({
      item_id: line.itemId,
      quantity: line.quantity,
    })),
  };
}

export async function recordSort(draft: SortDraft): Promise<void> {
  await writeRpc(() =>
    appDb().rpc('record_sort', { p_sort: sortPayload(draft) }),
  );
}
