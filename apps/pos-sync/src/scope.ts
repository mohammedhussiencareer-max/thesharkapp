import type { PosOrderIngest, PosShiftIngest, SyncScope } from './types.ts';

export const ORDER_BATCH_SIZE = 200;

export function window35From(now: Date): string {
  return new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString();
}

export function scopeForMode(
  mode: 'recent' | 'window35' | 'full',
  input: { shiftIds: string[]; from: string },
): SyncScope {
  if (mode === 'recent') {
    return { shift_ids: input.shiftIds };
  }
  if (mode === 'window35') {
    return { from: input.from };
  }
  return { all: true };
}

export function planIngestCalls(input: {
  shifts: PosShiftIngest[];
  orders: PosOrderIngest[];
  scope: SyncScope;
  batchSize?: number;
}): Array<{
  shifts: PosShiftIngest[];
  orders: PosOrderIngest[];
  scope: SyncScope | null;
}> {
  const batchSize = input.batchSize ?? ORDER_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batch size must be positive');
  }
  const chunks: PosOrderIngest[][] = [];
  for (let index = 0; index < input.orders.length; index += batchSize) {
    chunks.push(input.orders.slice(index, index + batchSize));
  }
  if (chunks.length === 0) {
    chunks.push([]);
  }
  return chunks.map((orders, index) => ({
    shifts: index === 0 ? input.shifts : [],
    orders,
    scope: index === chunks.length - 1 ? input.scope : null,
  }));
}
