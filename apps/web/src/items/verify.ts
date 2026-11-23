import {
  getItemById,
  listConversions,
  listCostingSchedule,
  type ConversionList,
} from '@/items/api';
import { genericCatalogError } from '@/items/errors';
import type { CatalogItem, CostingSchedule } from '@/items/types';
import type { PostedReloadSnapshot } from '@/lib/held-writes';

export type ItemSyncedData = {
  version: number;
  schedule?: CostingSchedule;
  conversions?: ConversionList;
};

export type ItemReadRequest =
  | { kind: 'loss'; snapshots?: PostedReloadSnapshot }
  | { kind: 'conversion'; snapshots?: PostedReloadSnapshot }
  | { kind: 'schedule' }
  | { kind: 'conversions_open' };

export type ItemReadOutcome =
  | {
      status: 'applied';
      item?: CatalogItem;
      schedule?: CostingSchedule;
      conversions?: ConversionList;
    }
  | { status: 'superseded' };

export type RunItemRead = (
  itemId: string,
  request: ItemReadRequest,
) => Promise<ItemReadOutcome>;

export type VerifiedLossItem = {
  schedule: CostingSchedule;
  item: CatalogItem;
};

export type VerifiedConversionItem = {
  conversions: ConversionList;
  schedule: CostingSchedule;
  item: CatalogItem;
};

/**
 * Combined verification read for a loss write: reads BOTH the item's costing
 * schedule AND the item row by ID (never the 1,000-row capped catalog list).
 * Succeeds only if both succeed and the item row exists.
 */
export async function verifyLossItem(
  itemId: string,
): Promise<VerifiedLossItem> {
  const [schedule, item] = await Promise.all([
    listCostingSchedule(itemId),
    getItemById(itemId),
  ]);
  if (!item) {
    throw new Error(genericCatalogError);
  }
  return { schedule, item };
}

/**
 * Combined verification read for a conversion write: reads the item's
 * conversions, its costing schedule, AND the item row by ID (never the
 * 1,000-row capped catalog list). Succeeds only if all succeed and the item
 * row exists.
 */
export async function verifyConversionItem(
  itemId: string,
): Promise<VerifiedConversionItem> {
  const [conversions, schedule, item] = await Promise.all([
    listConversions(itemId),
    listCostingSchedule(itemId),
    getItemById(itemId),
  ]);
  if (!item) {
    throw new Error(genericCatalogError);
  }
  return { conversions, schedule, item };
}
