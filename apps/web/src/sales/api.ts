import { genericCatalogError } from '@/items/errors';
import { exactDecimal, exactDecimalOrNull } from '@/lib/decimal';
import { addMoney } from '@/lib/money';
import { supabase } from '@/lib/supabase';
import type {
  SalesHome,
  SalesOrder,
  SalesOrderLine,
  ShiftDetail,
  ShiftSummary,
} from '@/sales/types';

export const salesWindowMs = 35 * 24 * 60 * 60 * 1000;

const summaryColumns =
  'shift_id, opened_at, closed_at, is_active, orders_complete, gross_sales_text:gross_sales::text, refunds_text:refunds::text, net_sales_text:net_sales::text, orders_canceled, orders_open, orders_missing, drawer_total_text:drawer_total::text, drawer_difference_text:drawer_difference::text, unknown_tx';

const orderColumns =
  'id, order_number, ordered_at, order_type, payment_type, status, missing_from_pos, total_text:total::text';

const lineColumns =
  'order_id, line_id, item_name, size_name, quantity_text:quantity::text, weighted_qty_text:weighted_qty::text, weighted_unit, line_total_text:line_total::text, options';

const transactionColumns = 'order_id, amount_text:amount::text';

function appDb() {
  if (!supabase) throw new Error(genericCatalogError);
  return supabase.schema('app');
}

function throwIfError(error: { message?: string } | null): void {
  if (error) throw new Error(genericCatalogError);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(genericCatalogError);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(genericCatalogError);
  const text = value.trim();
  return text === '' ? null : text;
}

function requiredCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(genericCatalogError);
  }
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(genericCatalogError);
  return value;
}

function optionalOrderNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(genericCatalogError);
  }
  return value;
}

function optionValues(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(genericCatalogError);
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(genericCatalogError);
    }
    const raw = (entry as { value?: unknown }).value;
    if (raw === null || raw === undefined) return [];
    if (typeof raw !== 'string') throw new Error(genericCatalogError);
    const text = raw.trim();
    return text === '' ? [] : [text];
  });
}

// View columns are nullable in the generated types; every field is checked here.
function mapSummary(row: {
  shift_id: unknown;
  opened_at: unknown;
  closed_at: unknown;
  is_active: unknown;
  orders_complete: unknown;
  gross_sales_text: unknown;
  refunds_text: unknown;
  net_sales_text: unknown;
  orders_canceled: unknown;
  orders_open: unknown;
  orders_missing: unknown;
  drawer_total_text: unknown;
  drawer_difference_text: unknown;
  unknown_tx: unknown;
}): ShiftSummary {
  return {
    shiftId: requiredString(row.shift_id),
    openedAt: requiredString(row.opened_at),
    closedAt: optionalString(row.closed_at),
    isActive: requiredBoolean(row.is_active),
    ordersComplete: requiredCount(row.orders_complete),
    grossSales: exactDecimal(row.gross_sales_text, genericCatalogError),
    refunds: exactDecimal(row.refunds_text, genericCatalogError),
    netSales: exactDecimal(row.net_sales_text, genericCatalogError),
    ordersCanceled: requiredCount(row.orders_canceled),
    ordersOpen: requiredCount(row.orders_open),
    ordersMissing: requiredCount(row.orders_missing),
    drawerTotal: exactDecimalOrNull(row.drawer_total_text, genericCatalogError),
    drawerDifference: exactDecimalOrNull(
      row.drawer_difference_text,
      genericCatalogError,
    ),
    unknownTx: requiredCount(row.unknown_tx),
  };
}

function mapLine(row: {
  line_id: string;
  item_name: string | null;
  size_name: string | null;
  quantity_text: unknown;
  weighted_qty_text: unknown;
  weighted_unit: string | null;
  line_total_text: unknown;
  options: unknown;
}): SalesOrderLine {
  return {
    lineId: requiredString(row.line_id),
    itemName: optionalString(row.item_name),
    sizeName: optionalString(row.size_name),
    quantity: exactDecimal(row.quantity_text, genericCatalogError),
    weightedQty: exactDecimalOrNull(row.weighted_qty_text, genericCatalogError),
    weightedUnit: optionalString(row.weighted_unit),
    lineTotal: exactDecimal(row.line_total_text, genericCatalogError),
    optionValues: optionValues(row.options),
  };
}

export async function loadSalesHome(now = Date.now()): Promise<SalesHome> {
  const since = new Date(now - salesWindowMs).toISOString();
  const db = appDb();
  const [shiftsResult, syncResult] = await Promise.all([
    db
      .from('pos_shift_summaries')
      .select(summaryColumns)
      .gte('opened_at', since)
      .order('opened_at', { ascending: false }),
    db
      .from('pos_sync_runs')
      .select('finished_at')
      .eq('status', 'ok')
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  throwIfError(shiftsResult.error);
  throwIfError(syncResult.error);
  const finished = syncResult.data?.finished_at ?? null;
  return {
    shifts: (shiftsResult.data ?? []).map((row) => mapSummary(row)),
    lastSyncAt: finished === null ? null : requiredString(finished),
  };
}

export async function loadShiftDetail(
  shiftId: string,
): Promise<ShiftDetail | null> {
  const db = appDb();
  const [summaryResult, ordersResult, refundsResult] = await Promise.all([
    db
      .from('pos_shift_summaries')
      .select(summaryColumns)
      .eq('shift_id', shiftId)
      .maybeSingle(),
    db
      .from('pos_orders')
      .select(orderColumns)
      .eq('shift_id', shiftId)
      .order('ordered_at', { ascending: true }),
    db
      .from('pos_shift_transactions')
      .select(transactionColumns)
      .eq('shift_id', shiftId)
      .eq('tx_type', 3),
  ]);
  throwIfError(summaryResult.error);
  throwIfError(ordersResult.error);
  throwIfError(refundsResult.error);
  if (!summaryResult.data) return null;

  const orderRows = ordersResult.data ?? [];
  const orderIds = orderRows.map((row) => requiredString(row.id));
  const linesResult =
    orderIds.length === 0
      ? { data: [], error: null }
      : await db
          .from('pos_order_lines')
          .select(lineColumns)
          .in('order_id', orderIds);
  throwIfError(linesResult.error);

  const linesByOrder = new Map<string, SalesOrderLine[]>();
  for (const row of linesResult.data ?? []) {
    const orderId = requiredString(row.order_id);
    const lines = linesByOrder.get(orderId) ?? [];
    lines.push(mapLine(row));
    linesByOrder.set(orderId, lines);
  }
  for (const lines of linesByOrder.values()) {
    lines.sort((left, right) => left.lineId.localeCompare(right.lineId));
  }

  const refunded = new Map<string, string>();
  for (const row of refundsResult.data ?? []) {
    const orderId = optionalString(row.order_id);
    if (orderId === null) continue;
    const amount = exactDecimal(row.amount_text, genericCatalogError);
    refunded.set(orderId, addMoney(refunded.get(orderId) ?? '0.00', amount));
  }

  const orders: SalesOrder[] = orderRows
    .map((row) => {
      const id = requiredString(row.id);
      return {
        id,
        orderNumber: optionalOrderNumber(row.order_number),
        orderedAt: requiredString(row.ordered_at),
        orderType: optionalString(row.order_type),
        paymentType: optionalString(row.payment_type),
        status: requiredString(row.status),
        missingFromPos: requiredBoolean(row.missing_from_pos),
        total: exactDecimal(row.total_text, genericCatalogError),
        refunded: refunded.get(id) ?? '0.00',
        lines: linesByOrder.get(id) ?? [],
      };
    })
    .sort(
      (left, right) =>
        left.orderedAt.localeCompare(right.orderedAt) ||
        left.id.localeCompare(right.id),
    );

  return { summary: mapSummary(summaryResult.data), orders };
}
