import { createHash } from 'node:crypto';
import { isRecord } from './decode.ts';
import type { StoredOrder } from './types.ts';

export function compareId(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new Error('invalid hash value');
  }
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new Error('invalid hash value');
    }
    return text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (!isRecord(value)) {
    throw new Error('invalid hash value');
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => {
      const child = value[key];
      if (child === undefined) {
        throw new Error('invalid hash value');
      }
      return `${JSON.stringify(key)}:${canonicalJson(child)}`;
    })
    .join(',')}}`;
}

function hashBody(order: StoredOrder): unknown {
  const lines = [...order.lines].sort((left, right) =>
    compareId(left.line_id, right.line_id),
  );
  return {
    delivery_fee: order.delivery_fee,
    discount: order.discount,
    financial_revision: order.financial_revision,
    id: order.id,
    last_financial_operation_key: order.last_financial_operation_key,
    lines,
    order_number: order.order_number,
    order_type: order.order_type,
    ordered_at: order.ordered_at,
    payment_type: order.payment_type,
    service_tax: order.service_tax,
    shift_id: order.shift_id,
    status: order.status,
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
  };
}

/** SHA-256 of the stored accounting shape. Update time is compared separately. */
export function contentHash(order: StoredOrder): string {
  return createHash('sha256')
    .update(canonicalJson(hashBody(order)))
    .digest('hex');
}
