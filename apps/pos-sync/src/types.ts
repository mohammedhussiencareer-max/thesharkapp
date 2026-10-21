export type SyncMode = 'recent' | 'window35' | 'full';

export type SyncScope =
  { shift_ids: string[] } | { from: string } | { all: true };

export type PosShiftTransactionIngest = {
  tx_id: string;
  order_id: string | null;
  tx_type: number;
  amount: string;
  occurred_at: string;
};

export type PosShiftIngest = {
  id: string;
  opened_at: string;
  closed_at: string | null;
  is_active: boolean;
  pos_update_time: string;
  drawer_cash_net: string | null;
  drawer_credit: string | null;
  transactions: PosShiftTransactionIngest[];
};

export type PosLineOptionIngest = {
  value: string | null;
  price: string | null;
  pricingType: string | null;
  pricingBaseQuantity: string | null;
};

export type PosLineIngest = {
  line_id: string;
  item_id: string;
  item_name: string | null;
  size_name: string | null;
  quantity: string;
  weighted_qty: string | null;
  weighted_unit: string | null;
  unit_price: string;
  price_per_kg: string | null;
  options: PosLineOptionIngest[];
};

export type StoredLine = {
  line_id: string;
  item_id: string;
  item_name: string | null;
  size_name: string | null;
  quantity: string;
  weighted_qty: string | null;
  weighted_unit: string | null;
  unit_price: string;
  price_per_kg: string | null;
  options: PosLineOptionIngest[];
  line_total: string;
};

export type StoredOrder = {
  id: string;
  order_number: number | null;
  shift_id: string;
  status: 'complete' | 'canceled' | 'active';
  order_type: string | null;
  payment_type: string | null;
  ordered_at: string;
  subtotal: string;
  discount: string;
  tax: string;
  service_tax: string;
  delivery_fee: string;
  total: string;
  financial_revision: number | null;
  last_financial_operation_key: string | null;
  lines: StoredLine[];
};

export type PosOrderIngest = {
  id: string;
  order_number: number | null;
  shift_id: string;
  status: 'complete' | 'canceled' | 'active';
  order_type: string | null;
  payment_type: string | null;
  ordered_at: string;
  subtotal: string;
  discount: string;
  tax: string;
  service_tax: string;
  delivery_fee: string;
  total: string;
  financial_revision: number | null;
  last_financial_operation_key: string | null;
  pos_update_time: string;
  content_hash: string;
  lines: PosLineIngest[];
};

export type IngestCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
  stale: number;
  missing: number;
  shifts_upserted: number;
  shifts_skipped: number;
  transactions: number;
};
