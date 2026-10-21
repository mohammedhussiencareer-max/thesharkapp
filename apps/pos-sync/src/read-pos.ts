import { compareId } from './hash.ts';
import {
  mapOrderDocument,
  mapShiftDocument,
  mapShiftTransactions,
} from './mapper.ts';
import type {
  FirestoreRestDocument,
  ListQuery,
  PosFirestore,
  TransactionListQuery,
} from './pos-firestore.ts';
import { window35From } from './scope.ts';
import type {
  PosOrderIngest,
  PosShiftIngest,
  SyncMode,
  SyncScope,
} from './types.ts';

export const RECENT_SHIFT_PAGE = 4;
export const RECENT_SHIFT_LIMIT = 4;
export const RECENT_SHIFT_MAX_PAGES = 20;
export const RECENT_ORDER_LIMIT = 2000;
/** Firestore rejects an IN filter with more than 30 values. */
export const FIRESTORE_IN_LIMIT = 30;
export const RANGE_LIMIT = 300;
export const LIST_PAGE_SIZE = 300;
export const MAX_LIST_PAGES = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PosSnapshot = {
  shifts: PosShiftIngest[];
  orders: PosOrderIngest[];
  scope: SyncScope;
  missingShiftIds: string[];
};

export function recentOrdersQuery(shiftIds: string[]): unknown {
  return {
    structuredQuery: {
      from: [{ collectionId: 'orders' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'shiftId' },
          op: 'IN',
          value: {
            arrayValue: {
              values: shiftIds.map((id) => ({ stringValue: id })),
            },
          },
        },
      },
      limit: RECENT_ORDER_LIMIT,
    },
  };
}

export function timestampRangeQuery(
  start: string,
  end: string,
  limit: number,
): unknown {
  return {
    structuredQuery: {
      from: [{ collectionId: 'orders' }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: 'timestamp' },
                op: 'GREATER_THAN_OR_EQUAL',
                value: { timestampValue: start },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: 'timestamp' },
                op: 'LESS_THAN',
                value: { timestampValue: end },
              },
            },
          ],
        },
      },
      limit,
    },
  };
}

export function timestampProbeQuery(start: string): unknown {
  return {
    structuredQuery: {
      from: [{ collectionId: 'orders' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'timestamp' },
          op: 'GREATER_THAN_OR_EQUAL',
          value: { timestampValue: start },
        },
      },
      limit: 1,
    },
  };
}

export function createPosReader(firestore: PosFirestore): {
  read(mode: SyncMode, now: Date): Promise<PosSnapshot>;
} {
  return {
    read(mode, now) {
      return readPos(mode, firestore, now);
    },
  };
}

export async function readPos(
  mode: SyncMode,
  firestore: PosFirestore,
  now: Date,
): Promise<PosSnapshot> {
  const snapshot =
    mode === 'recent'
      ? await readRecent(firestore)
      : mode === 'window35'
        ? await readWindow(firestore, now)
        : await readFull(firestore);
  return {
    ...snapshot,
    shifts: await attachTransactions(firestore, snapshot.shifts),
  };
}

async function readRecent(firestore: PosFirestore): Promise<PosSnapshot> {
  const collected: FirestoreRestDocument[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let complete = false;
  for (let page = 0; page < RECENT_SHIFT_MAX_PAGES; page += 1) {
    if (pageToken !== undefined) {
      if (seenTokens.has(pageToken)) {
        throw new Error('repeated Firestore page token');
      }
      seenTokens.add(pageToken);
    }
    const query: ListQuery = {
      pageSize: RECENT_SHIFT_PAGE,
      orderBy: 'opening_time desc',
    };
    if (pageToken !== undefined) {
      query.pageToken = pageToken;
    }
    const result = await firestore.list('custody_shifts', query);
    const room = RECENT_SHIFT_LIMIT - collected.length;
    collected.push(...result.documents.slice(0, room));
    if (
      collected.length >= RECENT_SHIFT_LIMIT ||
      result.nextPageToken === undefined
    ) {
      complete = true;
      break;
    }
    pageToken = result.nextPageToken;
  }
  if (!complete) {
    throw new Error('Firestore page limit exceeded');
  }
  const shifts = uniqueById(
    collected.map((document) => mapShiftDocument(document)),
    'shift',
  );
  const shiftIds = shifts.map((shift) => shift.id);
  let documents: FirestoreRestDocument[] = [];
  if (shiftIds.length > 0) {
    documents = await firestore.queryOrders(recentOrdersQuery(shiftIds));
    if (documents.length >= RECENT_ORDER_LIMIT) {
      throw new Error('recent orders page was truncated');
    }
  }
  return {
    shifts,
    orders: mapOrders(documents),
    scope: { shift_ids: shiftIds },
    missingShiftIds: [],
  };
}

async function readWindow(
  firestore: PosFirestore,
  now: Date,
): Promise<PosSnapshot> {
  const from = window35From(now);
  const scanEnd = new Date(now.getTime() + 2 * DAY_MS).toISOString();
  const documents = await collectTimestampRange(firestore, from, scanEnd);
  const probe = await firestore.queryOrders(timestampProbeQuery(scanEnd));
  if (probe.length > 0) {
    throw new Error('orders exist after the scan window');
  }
  // Map the window once. A shift that opened earlier still owns orders from
  // before `from`; those orders are in the drawer. Read them too, or the
  // sales summary shows a false drawer difference. Each document is mapped
  // once. Scope stays {from}, so orders before `from` are never marked missing.
  const windowOrders = mapOrders(documents);
  const shiftIds = [
    ...new Set(windowOrders.map((order) => order.shift_id)),
  ].sort(compareId);
  const shifts: PosShiftIngest[] = [];
  const missingShiftIds: string[] = [];
  for (const shiftId of shiftIds) {
    const document = await firestore.getShift(shiftId);
    if (document === null) {
      missingShiftIds.push(shiftId);
      continue;
    }
    shifts.push(mapShiftDocument(document));
  }
  const uniqueShifts = uniqueById(shifts, 'shift');
  const fromMs = Date.parse(from);
  const earlyShiftIds = uniqueShifts
    .filter((shift) => openedBefore(shift.opened_at, fromMs))
    .map((shift) => shift.id);
  const backfill = await readOrdersForShifts(firestore, earlyShiftIds);
  const seenNames = new Set(documents.map((document) => document.name));
  const fresh = backfill.filter((document) => !seenNames.has(document.name));
  return {
    shifts: uniqueShifts,
    orders: uniqueById([...windowOrders, ...mapOrders(fresh)], 'order'),
    scope: { from },
    missingShiftIds,
  };
}

function openedBefore(openedAt: string, fromMs: number): boolean {
  const openedMs = Date.parse(openedAt);
  if (!Number.isFinite(openedMs) || !Number.isFinite(fromMs)) {
    throw new Error('invalid timestamp');
  }
  return openedMs < fromMs;
}

async function readOrdersForShifts(
  firestore: PosFirestore,
  shiftIds: string[],
): Promise<FirestoreRestDocument[]> {
  const documents: FirestoreRestDocument[] = [];
  const sorted = [...shiftIds].sort(compareId);
  for (let index = 0; index < sorted.length; index += FIRESTORE_IN_LIMIT) {
    const chunk = sorted.slice(index, index + FIRESTORE_IN_LIMIT);
    const page = await firestore.queryOrders(recentOrdersQuery(chunk));
    if (page.length >= RECENT_ORDER_LIMIT) {
      throw new Error('recent orders page was truncated');
    }
    documents.push(...page);
  }
  return documents;
}

async function readFull(firestore: PosFirestore): Promise<PosSnapshot> {
  const shiftDocuments = await listAll(firestore, 'custody_shifts');
  const orderDocuments = await listAll(firestore, 'orders');
  return {
    shifts: uniqueById(
      shiftDocuments.map((document) => mapShiftDocument(document)),
      'shift',
    ),
    orders: mapOrders(orderDocuments),
    scope: { all: true },
    missingShiftIds: [],
  };
}

async function attachTransactions(
  firestore: PosFirestore,
  shifts: PosShiftIngest[],
): Promise<PosShiftIngest[]> {
  const next: PosShiftIngest[] = [];
  for (const shift of shifts) {
    const documents = await listShiftTransactions(firestore, shift.id);
    next.push({
      ...shift,
      transactions: mapShiftTransactions(shift.id, documents),
    });
  }
  return next;
}

async function listShiftTransactions(
  firestore: PosFirestore,
  shiftId: string,
): Promise<FirestoreRestDocument[]> {
  const documents: FirestoreRestDocument[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    if (pageToken !== undefined) {
      if (seenTokens.has(pageToken)) {
        throw new Error('repeated Firestore page token');
      }
      seenTokens.add(pageToken);
    }
    const query: TransactionListQuery = { pageSize: LIST_PAGE_SIZE };
    if (pageToken !== undefined) {
      query.pageToken = pageToken;
    }
    const result = await firestore.listShiftTransactions(shiftId, query);
    documents.push(...result.documents);
    if (result.nextPageToken === undefined) {
      return documents;
    }
    pageToken = result.nextPageToken;
  }
  throw new Error('Firestore page limit exceeded');
}

async function listAll(
  firestore: PosFirestore,
  collection: 'orders' | 'custody_shifts',
): Promise<FirestoreRestDocument[]> {
  const documents: FirestoreRestDocument[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    if (pageToken !== undefined) {
      if (seenTokens.has(pageToken)) {
        throw new Error('repeated Firestore page token');
      }
      seenTokens.add(pageToken);
    }
    const result = await firestore.list(collection, {
      pageSize: LIST_PAGE_SIZE,
      pageToken,
    });
    documents.push(...result.documents);
    if (result.nextPageToken === undefined) {
      return documents;
    }
    pageToken = result.nextPageToken;
  }
  throw new Error('Firestore page limit exceeded');
}

export async function collectTimestampRange(
  firestore: PosFirestore,
  startIso: string,
  endIso: string,
): Promise<FirestoreRestDocument[]> {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return [];
  }
  const documents = await firestore.queryOrders(
    timestampRangeQuery(startIso, endIso, RANGE_LIMIT),
  );
  if (documents.length < RANGE_LIMIT) {
    return documents;
  }
  if (endMs - startMs <= 1) {
    throw new Error('timestamp range is still full');
  }
  const mid = new Date(
    startMs + Math.floor((endMs - startMs) / 2),
  ).toISOString();
  const left = await collectTimestampRange(firestore, startIso, mid);
  const right = await collectTimestampRange(firestore, mid, endIso);
  return [...left, ...right];
}

function mapOrders(documents: FirestoreRestDocument[]): PosOrderIngest[] {
  const seenNames = new Set<string>();
  for (const document of documents) {
    if (seenNames.has(document.name)) {
      throw new Error('duplicate order id');
    }
    seenNames.add(document.name);
  }
  return uniqueById(
    documents.map((document) => mapOrderDocument(document)),
    'order',
  );
}

function uniqueById<T extends { id: string }>(rows: T[], label: string): T[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new Error(`duplicate ${label} id`);
    }
    seen.add(row.id);
  }
  return [...rows].sort((left, right) => compareId(left.id, right.id));
}
