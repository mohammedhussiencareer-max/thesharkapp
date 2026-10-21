import {
  decodeFirestoreValue,
  isRecord,
  splitDocumentName,
  splitTransactionName,
} from './decode.ts';
import {
  decimalFromNumber,
  fixedLineTotal,
  moneyFromNumber,
  moneyText,
  parseDecimal,
  qtyText,
} from './decimal.ts';
import { compareId, contentHash } from './hash.ts';
import { normalizeTimestamp } from './time.ts';
import type {
  PosLineIngest,
  PosLineOptionIngest,
  PosOrderIngest,
  PosShiftIngest,
  PosShiftTransactionIngest,
  StoredLine,
  StoredOrder,
} from './types.ts';

function field(fields: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(fields, key)
    ? fields[key]
    : undefined;
}

function isOnlyKey(value: Record<string, unknown>, key: string): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key;
}

function isNullValue(value: unknown): boolean {
  return isRecord(value) && isOnlyKey(value, 'nullValue');
}

function isMapValue(
  value: unknown,
): value is { mapValue: { fields?: unknown } } {
  return (
    isRecord(value) && isOnlyKey(value, 'mapValue') && isRecord(value.mapValue)
  );
}

function isArrayValue(
  value: unknown,
): value is { arrayValue: { values?: unknown } } {
  return (
    isRecord(value) &&
    isOnlyKey(value, 'arrayValue') &&
    isRecord(value.arrayValue)
  );
}

function mapFields(value: unknown, label: string): Record<string, unknown> {
  if (!isMapValue(value)) {
    throw new Error(`unexpected ${label}`);
  }
  if (value.mapValue.fields === undefined) {
    return {};
  }
  if (!isRecord(value.mapValue.fields)) {
    throw new Error(`unexpected ${label}`);
  }
  return value.mapValue.fields;
}

function documentFields(fields: unknown): Record<string, unknown> {
  if (fields === undefined) {
    return {};
  }
  if (!isRecord(fields)) {
    throw new Error('invalid Firestore document');
  }
  return fields;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || isNullValue(value)) {
    return null;
  }
  const decoded = decodeFirestoreValue(value);
  if (decoded === null) {
    return null;
  }
  if (typeof decoded !== 'string') {
    throw new Error(`unexpected ${label}`);
  }
  const trimmed = decoded.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value, label);
  if (text === null) {
    throw new Error(`${label} is required`);
  }
  return text;
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === undefined || isNullValue(value)) {
    return null;
  }
  const decoded = decodeFirestoreValue(value);
  if (decoded === null) {
    return null;
  }
  if (typeof decoded !== 'number') {
    throw new Error(`unexpected ${label}`);
  }
  return decoded;
}

function requiredNumber(value: unknown, label: string): number {
  const parsed = optionalNumber(value, label);
  if (parsed === null) {
    throw new Error(`${label} is required`);
  }
  return parsed;
}

function optionalInt(value: unknown, label: string): number | null {
  const parsed = optionalNumber(value, label);
  if (parsed === null) {
    return null;
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`unexpected ${label}`);
  }
  return parsed;
}

function requiredInt(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`unexpected ${label}`);
  }
  return parsed;
}

function optionalMoney(value: unknown, label: string): string | null {
  const parsed = optionalNumber(value, label);
  if (parsed === null) {
    return null;
  }
  return moneyFromNumber(parsed);
}

function requiredBool(value: unknown, label: string): boolean {
  if (value === undefined || isNullValue(value)) {
    throw new Error(`${label} is required`);
  }
  const decoded = decodeFirestoreValue(value);
  if (typeof decoded !== 'boolean') {
    throw new Error(`unexpected ${label}`);
  }
  return decoded;
}

function requiredTime(value: unknown, label: string): string {
  const text = requiredString(value, label);
  return normalizeTimestamp(text);
}

function optionalTime(value: unknown, label: string): string | null {
  const text = optionalString(value, label);
  if (text === null) {
    return null;
  }
  return normalizeTimestamp(text);
}

function optionalDecimal(value: unknown, label: string): string | null {
  const parsed = optionalNumber(value, label);
  if (parsed === null) {
    return null;
  }
  return decimalFromNumber(parsed);
}

function requiredDecimal(value: unknown, label: string): string {
  return decimalFromNumber(requiredNumber(value, label));
}

function readDeliveryFee(value: unknown): number {
  if (value === undefined || isNullValue(value)) {
    return 0;
  }
  const fields = mapFields(value, 'deliveryDetails');
  const fee = field(fields, 'deliveryFee');
  if (fee === undefined || isNullValue(fee)) {
    return 0;
  }
  return requiredNumber(fee, 'deliveryFee');
}

function readSizeName(fields: Record<string, unknown>): string | null {
  const selected = field(fields, 'selectedSize');
  if (selected !== undefined && !isNullValue(selected)) {
    const name = optionalString(
      field(mapFields(selected, 'selectedSize'), 'name'),
      'size name',
    );
    if (name !== null) {
      return name;
    }
  }
  const size = field(fields, 'size');
  if (size === undefined || isNullValue(size)) {
    return null;
  }
  if (isRecord(size) && isOnlyKey(size, 'stringValue')) {
    return optionalString(size, 'size name');
  }
  if (isMapValue(size)) {
    return optionalString(field(mapFields(size, 'size'), 'name'), 'size name');
  }
  throw new Error('unexpected size');
}

function readOptions(value: unknown): PosLineOptionIngest[] {
  if (value === undefined || isNullValue(value)) {
    return [];
  }
  if (!isArrayValue(value)) {
    throw new Error('unexpected selectedOptions');
  }
  const values = value.arrayValue.values;
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error('unexpected selectedOptions');
  }
  return values.map((entry) => {
    const optionFields = mapFields(entry, 'selectedOptions');
    return {
      value: optionalString(field(optionFields, 'value'), 'option value'),
      price: optionalDecimal(field(optionFields, 'price'), 'option price'),
      pricingType: optionalString(
        field(optionFields, 'pricingType'),
        'option pricingType',
      ),
      pricingBaseQuantity: optionalDecimal(
        field(optionFields, 'pricingBaseQuantity'),
        'option pricingBaseQuantity',
      ),
    };
  });
}

function readLines(value: unknown): PosLineIngest[] {
  if (value === undefined || isNullValue(value)) {
    return [];
  }
  if (!isArrayValue(value)) {
    throw new Error('unexpected items');
  }
  const values = value.arrayValue.values;
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error('unexpected items');
  }
  const lines = values.map((entry) => readLine(entry));
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.line_id)) {
      throw new Error('duplicate line id');
    }
    seen.add(line.line_id);
  }
  return lines.sort((left, right) => compareId(left.line_id, right.line_id));
}

function readLine(value: unknown): PosLineIngest {
  const fields = mapFields(value, 'item');
  const weightedRaw = optionalNumber(
    field(fields, 'weightedQuantity'),
    'weightedQuantity',
  );
  if (weightedRaw !== null && weightedRaw < 0) {
    throw new Error('weighted quantity must be >= 0');
  }
  const weighted = weightedRaw !== null && weightedRaw > 0;
  const weightedQty = weighted ? decimalFromNumber(weightedRaw) : null;
  if (weightedQty !== null && qtyText(weightedQty) === '0') {
    throw new Error('weighted quantity must be > 0');
  }
  const quantity = requiredDecimal(field(fields, 'quantity'), 'quantity');
  if (parseDecimal(quantity).sign < 0) {
    throw new Error('quantity must be >= 0');
  }
  return {
    line_id: requiredString(field(fields, 'orderItemId'), 'line id'),
    item_id: requiredString(field(fields, 'itemId'), 'item id'),
    item_name: optionalString(field(fields, 'name'), 'item name'),
    size_name: readSizeName(fields),
    quantity,
    weighted_qty: weightedQty,
    weighted_unit: weighted
      ? optionalString(field(fields, 'weightedUnit'), 'weighted unit')
      : null,
    unit_price: requiredDecimal(field(fields, 'price'), 'price'),
    price_per_kg: optionalDecimal(
      field(fields, 'scalePricePerKg'),
      'price per kg',
    ),
    options: readOptions(field(fields, 'selectedOptions')),
  };
}

function projectOption(option: PosLineOptionIngest): PosLineOptionIngest {
  if (
    option.pricingBaseQuantity !== null &&
    parseDecimal(option.pricingBaseQuantity).sign < 0
  ) {
    throw new Error('option pricingBaseQuantity must be >= 0');
  }
  return {
    value: option.value,
    price: option.price === null ? null : moneyText(option.price),
    pricingType: option.pricingType,
    pricingBaseQuantity:
      option.pricingBaseQuantity === null
        ? null
        : qtyText(option.pricingBaseQuantity),
  };
}

/** Stored accounting shape. Line prices here are rounded the way Postgres stores them. */
export function projectLine(line: PosLineIngest): StoredLine {
  if (parseDecimal(line.quantity).sign < 0) {
    throw new Error('quantity must be >= 0');
  }
  const weightedQty = line.weighted_qty;
  if (
    weightedQty !== null &&
    (parseDecimal(weightedQty).sign < 0 || qtyText(weightedQty) === '0')
  ) {
    throw new Error('weighted quantity must be > 0');
  }
  const unitPrice = moneyText(line.unit_price);
  return {
    line_id: line.line_id,
    item_id: line.item_id,
    item_name: line.item_name,
    size_name: line.size_name,
    quantity: qtyText(line.quantity),
    weighted_qty: weightedQty === null ? null : qtyText(weightedQty),
    weighted_unit: weightedQty === null ? null : line.weighted_unit,
    unit_price: unitPrice,
    price_per_kg:
      line.price_per_kg === null ? null : moneyText(line.price_per_kg),
    options: line.options.map(projectOption),
    line_total:
      weightedQty === null
        ? fixedLineTotal(line.unit_price, line.quantity)
        : unitPrice,
  };
}

export function storedProjection(order: {
  id: string;
  order_number: number | null;
  shift_id: string;
  status: PosOrderIngest['status'];
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
  lines: PosLineIngest[];
}): StoredOrder {
  return {
    id: order.id,
    order_number: order.order_number,
    shift_id: order.shift_id,
    status: order.status,
    order_type: order.order_type,
    payment_type: order.payment_type,
    ordered_at: order.ordered_at,
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    service_tax: order.service_tax,
    delivery_fee: order.delivery_fee,
    total: order.total,
    financial_revision: order.financial_revision,
    last_financial_operation_key: order.last_financial_operation_key,
    lines: order.lines.map(projectLine),
  };
}

function requireUpdateTime(updateTime: string | undefined): string {
  if (updateTime === undefined || updateTime.trim().length === 0) {
    throw new Error('updateTime is required');
  }
  return normalizeTimestamp(updateTime);
}

function requireStatus(value: unknown): PosOrderIngest['status'] {
  const status = requiredString(value, 'status');
  if (status === 'complete' || status === 'canceled' || status === 'active') {
    return status;
  }
  throw new Error('unexpected status');
}

export function mapShiftDocument(document: {
  name?: string;
  updateTime?: string;
  fields?: unknown;
}): PosShiftIngest {
  if (typeof document.name !== 'string') {
    throw new Error('Firestore document name is invalid');
  }
  const { collection, id } = splitDocumentName(document.name);
  if (collection !== 'custody_shifts') {
    throw new Error('expected a shift document');
  }
  const fields = documentFields(document.fields);
  const fieldId = optionalString(field(fields, 'id'), 'id');
  if (fieldId !== null && fieldId !== id) {
    throw new Error('shift id does not match document id');
  }
  return {
    id,
    opened_at: requiredTime(field(fields, 'opening_time'), 'opening_time'),
    closed_at: optionalTime(field(fields, 'closingTime'), 'closingTime'),
    is_active: requiredBool(field(fields, 'isActive'), 'isActive'),
    pos_update_time: requireUpdateTime(document.updateTime),
    drawer_cash_net: optionalMoney(
      field(fields, 'cash_payments_net'),
      'cash_payments_net',
    ),
    drawer_credit: optionalMoney(
      field(fields, 'credit_payments'),
      'credit_payments',
    ),
    transactions: [],
  };
}

const TRANSACTION_KEYS = [
  'tx_id',
  'order_id',
  'tx_type',
  'amount',
  'occurred_at',
] as const;

/** Accounting fields only. `description` and `operationKey` are never read. */
export function mapShiftTransaction(
  shiftId: string,
  document: { name?: string; fields?: unknown },
): PosShiftTransactionIngest {
  if (typeof document.name !== 'string') {
    throw new Error('Firestore document name is invalid');
  }
  const parsed = splitTransactionName(document.name);
  if (parsed.shiftId !== shiftId) {
    throw new Error('Firestore read failed: invalid response');
  }
  const fields = documentFields(document.fields);
  const row: PosShiftTransactionIngest = {
    tx_id: parsed.txId,
    order_id: optionalString(field(fields, 'orderId'), 'orderId'),
    tx_type: requiredInt(field(fields, 'type'), 'type'),
    amount: moneyFromNumber(requiredNumber(field(fields, 'amount'), 'amount')),
    occurred_at: requiredTime(field(fields, 'timestamp'), 'timestamp'),
  };
  const keys = Object.keys(row);
  if (
    keys.length !== TRANSACTION_KEYS.length ||
    TRANSACTION_KEYS.some((key) => !keys.includes(key))
  ) {
    throw new Error('unexpected transaction shape');
  }
  return row;
}

export function mapShiftTransactions(
  shiftId: string,
  documents: Array<{ name?: string; fields?: unknown }>,
): PosShiftTransactionIngest[] {
  const rows = documents.map((document) =>
    mapShiftTransaction(shiftId, document),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.tx_id)) {
      throw new Error('duplicate tx id');
    }
    seen.add(row.tx_id);
  }
  return rows.sort((left, right) => compareId(left.tx_id, right.tx_id));
}

export function mapOrderDocument(document: {
  name?: string;
  updateTime?: string;
  fields?: unknown;
}): PosOrderIngest {
  if (typeof document.name !== 'string') {
    throw new Error('Firestore document name is invalid');
  }
  const { collection, id } = splitDocumentName(document.name);
  if (collection !== 'orders') {
    throw new Error('expected an order document');
  }
  const fields = documentFields(document.fields);
  const status = requireStatus(field(fields, 'status'));
  const draft = {
    id,
    order_number: optionalInt(field(fields, 'orderNumber'), 'orderNumber'),
    shift_id: requiredString(field(fields, 'shiftId'), 'shift id'),
    status,
    order_type: optionalString(field(fields, 'orderType'), 'orderType'),
    payment_type: optionalString(field(fields, 'paymentType'), 'paymentType'),
    ordered_at: requiredTime(field(fields, 'timestamp'), 'timestamp'),
    subtotal: moneyFromNumber(
      requiredNumber(field(fields, 'subtotalAmount'), 'subtotal'),
    ),
    discount: moneyFromNumber(
      requiredNumber(field(fields, 'discountAmount'), 'discount'),
    ),
    tax: moneyFromNumber(
      requiredNumber(field(fields, 'taxTotalAmount'), 'tax'),
    ),
    service_tax: moneyFromNumber(
      requiredNumber(field(fields, 'serviceTaxAmount'), 'service tax'),
    ),
    delivery_fee: moneyFromNumber(
      readDeliveryFee(field(fields, 'deliveryDetails')),
    ),
    total: moneyFromNumber(
      requiredNumber(field(fields, 'totalAmount'), 'total'),
    ),
    financial_revision: optionalInt(
      field(fields, 'financialRevision'),
      'financialRevision',
    ),
    last_financial_operation_key: optionalString(
      field(fields, 'lastFinancialOperationKey'),
      'lastFinancialOperationKey',
    ),
    lines: readLines(field(fields, 'items')),
  };
  return {
    ...draft,
    pos_update_time: requireUpdateTime(document.updateTime),
    content_hash: contentHash(storedProjection(draft)),
  };
}
