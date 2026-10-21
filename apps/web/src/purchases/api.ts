import { isBaseUnit, isStockKind } from '@/items/types';
import type { Json } from '@/lib/database.types';
import { fetchAllPages, PageCapError } from '@/lib/paged';
import { supabase } from '@/lib/supabase';
import { genericPurchaseError, mapPurchaseError } from '@/purchases/errors';
import type {
  OpeningDraft,
  Purchase,
  PurchaseDraft,
  PurchaseFilter,
  PurchaseLine,
  StockChoice,
  UnitOption,
} from '@/purchases/types';

function appDb() {
  if (!supabase) throw new Error(genericPurchaseError);
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
): Promise<T[]> {
  try {
    return await fetchAllPages(async (from, to) => {
      const result = await load(from, to);
      throwIfError(result.error);
      return { data: result.data, error: null };
    });
  } catch (error) {
    if (error instanceof PageCapError) {
      throw new Error(genericPurchaseError, { cause: error });
    }
    throw error;
  }
}

function throwIfError(
  error: {
    code?: string;
    message?: string;
    details?: string | null;
    hint?: string | null;
  } | null,
): void {
  if (error) throw new Error(mapPurchaseError(error));
}

/** Exact decimal text from a PostgREST `::text` cast. Rejects JSON numbers. */
function exactDecimal(value: unknown): string {
  if (typeof value !== 'string') throw new Error(genericPurchaseError);
  const text = value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(genericPurchaseError);
  return text;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    if (!first || typeof first !== 'object') return null;
    return first as Record<string, unknown>;
  }
  if (typeof value !== 'object') throw new Error(genericPurchaseError);
  return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(genericPurchaseError);
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error(genericPurchaseError);
    return row as Record<string, unknown>;
  });
}

function conversionsOf(value: unknown): UnitOption[] {
  return rows(value)
    .map((row) => {
      if (typeof row.unit !== 'string') throw new Error(genericPurchaseError);
      return { unit: row.unit, factorToBase: exactDecimal(row.factor_text) };
    })
    .sort((left, right) => left.unit.localeCompare(right.unit, 'ar'));
}

export async function listStockChoices(): Promise<StockChoice[]> {
  // One paged read so a balance (the sign that the item already has a movement)
  // is read with the same catalog row as its conversions. name, id is unique.
  const data = await readPages((from, to) =>
    appDb()
      .from('stock_items')
      .select(
        'id, name, kind, base_unit, parent_item_id, active, item_balances(item_id), item_unit_conversions(unit, factor_text:factor_to_base::text)',
      )
      .eq('active', true)
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );

  return (data ?? []).map((row) => {
    if (!isStockKind(row.kind) || !isBaseUnit(row.base_unit)) {
      throw new Error(genericPurchaseError);
    }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUnit: row.base_unit,
      parentItemId: row.parent_item_id,
      active: row.active,
      hasMovements: record(row.item_balances) !== null,
      conversions: conversionsOf(row.item_unit_conversions),
    };
  });
}

function purchaseLine(row: Record<string, unknown>): {
  purchaseId: string;
  line: PurchaseLine;
} {
  const item = record(row.stock_items);
  if (
    !item ||
    typeof item.name !== 'string' ||
    typeof item.base_unit !== 'string' ||
    !isBaseUnit(item.base_unit)
  ) {
    throw new Error(genericPurchaseError);
  }
  if (
    typeof row.purchase_id !== 'string' ||
    typeof row.item_id !== 'string' ||
    typeof row.unit !== 'string'
  ) {
    throw new Error(genericPurchaseError);
  }
  const lineNo = row.line_no;
  if (typeof lineNo !== 'number' || !Number.isInteger(lineNo)) {
    throw new Error(genericPurchaseError);
  }
  return {
    purchaseId: row.purchase_id,
    line: {
      lineNo,
      itemId: row.item_id,
      itemName: item.name,
      baseUnit: item.base_unit,
      quantity: exactDecimal(row.quantity_text),
      unit: row.unit,
      baseQuantity: exactDecimal(row.base_quantity_text),
      amountPaid: exactDecimal(row.amount_paid_text),
    },
  };
}

const lineChunk = 100;

async function linesByPurchase(
  purchaseIds: readonly string[],
): Promise<Map<string, PurchaseLine[]>> {
  const grouped = new Map<string, PurchaseLine[]>();
  for (let index = 0; index < purchaseIds.length; index += lineChunk) {
    const ids = purchaseIds.slice(index, index + lineChunk);
    const page = await readPages((from, to) =>
      appDb()
        .from('purchase_lines')
        .select(
          'purchase_id, line_no, item_id, quantity_text:quantity::text, unit, base_quantity_text:base_quantity::text, amount_paid_text:amount_paid::text, stock_items(name, base_unit)',
        )
        .in('purchase_id', ids)
        .order('purchase_id', { ascending: true })
        .order('line_no', { ascending: true })
        .range(from, to),
    );
    for (const row of page) {
      const parsed = purchaseLine(row);
      const list = grouped.get(parsed.purchaseId) ?? [];
      list.push(parsed.line);
      grouped.set(parsed.purchaseId, list);
    }
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => left.lineNo - right.lineNo);
  }
  return grouped;
}

export async function listPurchases(
  filter: PurchaseFilter = {},
): Promise<Purchase[]> {
  const data = await readPages((from, to) => {
    // purchased_at, created_at, id is a unique total order for stable pages.
    let query = appDb()
      .from('purchases')
      .select(
        'id, purchased_at, supplier, invoice_no, note, total_paid_text:total_paid::text, created_at',
      )
      .order('purchased_at', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (filter.from) query = query.gte('purchased_at', filter.from);
    if (filter.toExclusive)
      query = query.lt('purchased_at', filter.toExclusive);
    return query.range(from, to);
  });
  const lines = await linesByPurchase(data.map((row) => row.id));

  return data.map((row) => ({
    id: row.id,
    purchasedAt: row.purchased_at,
    supplier: row.supplier,
    invoiceNo: row.invoice_no,
    note: row.note,
    totalPaid: exactDecimal(row.total_paid_text),
    lines: lines.get(row.id) ?? [],
  }));
}

function purchasePayload(draft: PurchaseDraft): Json {
  return {
    purchased_at: draft.purchasedAt,
    supplier: draft.supplier,
    invoice_no: draft.invoiceNo,
    note: draft.note,
    lines: draft.lines.map((line) => ({
      item_id: line.itemId,
      quantity: line.quantity,
      unit: line.unit,
      amount_paid: line.amountPaid,
    })),
  };
}

export async function recordPurchase(draft: PurchaseDraft): Promise<void> {
  const { error } = await appDb().rpc('record_purchase', {
    p_purchase: purchasePayload(draft),
  });
  throwIfError(error);
}

export async function recordOpeningStock(draft: OpeningDraft): Promise<void> {
  const lines: Json = draft.lines.map((line) => ({
    item_id: line.itemId,
    quantity: line.quantity,
    unit: line.unit,
    unit_cost: line.unitCost,
  }));
  const { error } = await appDb().rpc('record_opening_stock', {
    p_occurred_at: draft.occurredAt,
    p_lines: lines,
  });
  throwIfError(error);
}
