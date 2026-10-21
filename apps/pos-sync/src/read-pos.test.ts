import { describe, expect, it } from 'vitest';
import {
  assertFirestoreReadAllowed,
  firestoreRunQueryUrl,
} from './firestore-read.ts';
import type { FirestoreRestDocument, PosFirestore } from './pos-firestore.ts';
import {
  FIRESTORE_IN_LIMIT,
  LIST_PAGE_SIZE,
  MAX_LIST_PAGES,
  RANGE_LIMIT,
  RECENT_ORDER_LIMIT,
  RECENT_SHIFT_MAX_PAGES,
  collectTimestampRange,
  readPos,
  recentOrdersQuery,
  timestampProbeQuery,
  timestampRangeQuery,
} from './read-pos.ts';
import { window35From } from './scope.ts';

const DOC = 'projects/thesharkrestaurant/databases/(default)/documents';

function orderDoc(
  id: string,
  shiftId: string,
  timestamp = '2026-10-15T12:00:00Z',
): FirestoreRestDocument {
  return {
    name: `${DOC}/orders/${id}`,
    updateTime: '2026-10-15T13:00:00Z',
    fields: {
      status: { stringValue: 'complete' },
      shiftId: { stringValue: shiftId },
      timestamp: { timestampValue: timestamp },
      subtotalAmount: { integerValue: '1' },
      discountAmount: { integerValue: '0' },
      taxTotalAmount: { integerValue: '0' },
      serviceTaxAmount: { integerValue: '0' },
      totalAmount: { integerValue: '1' },
    },
  };
}

function shiftDoc(
  id: string,
  opening = '2026-10-15T09:00:00Z',
): FirestoreRestDocument {
  return {
    name: `${DOC}/custody_shifts/${id}`,
    updateTime: '2026-10-15T18:00:00Z',
    fields: {
      id: { stringValue: id },
      opening_time: { timestampValue: opening },
      isActive: { booleanValue: true },
    },
  };
}

describe('query builders', () => {
  it('stay inside the read allowlist', () => {
    for (const body of [
      recentOrdersQuery(['shift-test-1', 'shift-test-2']),
      timestampRangeQuery(
        '2026-09-11T00:00:00.000Z',
        '2026-10-18T00:00:00.000Z',
        RANGE_LIMIT,
      ),
      timestampProbeQuery('2026-10-18T00:00:00.000Z'),
    ]) {
      expect(() =>
        assertFirestoreReadAllowed('POST', firestoreRunQueryUrl(), body),
      ).not.toThrow();
    }
  });
});

describe('readPos', () => {
  it('follows shift pages until four shifts are collected', async () => {
    const lists: unknown[] = [];
    const queries: unknown[] = [];
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list(_collection, query) {
        lists.push(query);
        if (lists.length === 1) {
          return {
            documents: [shiftDoc('shift-test-d')],
            nextPageToken: 'page-2',
          };
        }
        return {
          documents: [
            shiftDoc('shift-test-a'),
            shiftDoc('shift-test-c'),
            shiftDoc('shift-test-b'),
            shiftDoc('shift-test-extra'),
          ],
          nextPageToken: 'page-3',
        };
      },
      async getShift() {
        throw new Error('get should not be called');
      },
      async queryOrders(body) {
        queries.push(body);
        return [orderDoc('order-test-1', 'shift-test-a')];
      },
    };
    const snapshot = await readPos(
      'recent',
      firestore,
      new Date('2026-10-16T00:00:00Z'),
    );
    expect(lists).toEqual([
      { pageSize: 4, orderBy: 'opening_time desc' },
      { pageSize: 4, orderBy: 'opening_time desc', pageToken: 'page-2' },
    ]);
    expect(queries).toHaveLength(1);
    expect(snapshot.scope).toEqual({
      shift_ids: [
        'shift-test-a',
        'shift-test-b',
        'shift-test-c',
        'shift-test-d',
      ],
    });
    expect(snapshot.orders.map((order) => order.id)).toEqual(['order-test-1']);
    expect(snapshot.missingShiftIds).toEqual([]);
  });

  it('stops paging shifts when there is no next page', async () => {
    const lists: unknown[] = [];
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list(_collection, query) {
        lists.push(query);
        if (lists.length === 1) {
          return {
            documents: [shiftDoc('shift-test-1')],
            nextPageToken: 'page-2',
          };
        }
        return { documents: [] };
      },
      async getShift() {
        throw new Error('get should not be called');
      },
      async queryOrders() {
        return [];
      },
    };
    const snapshot = await readPos('recent', firestore, new Date());
    expect(lists).toHaveLength(2);
    expect(snapshot.scope).toEqual({ shift_ids: ['shift-test-1'] });
  });

  it('fails closed when shift pages exceed the cap', async () => {
    let calls = 0;
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        calls += 1;
        return { documents: [], nextPageToken: `tok-${calls}` };
      },
      async getShift() {
        throw new Error('get should not be called');
      },
      async queryOrders() {
        throw new Error('query should not be called');
      },
    };
    await expect(readPos('recent', firestore, new Date())).rejects.toThrow(
      /page limit/,
    );
    expect(calls).toBe(RECENT_SHIFT_MAX_PAGES);
  });

  it('fails closed when a shift page token repeats', async () => {
    let calls = 0;
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        calls += 1;
        return { documents: [shiftDoc('shift-test-1')], nextPageToken: 'same' };
      },
      async getShift() {
        throw new Error('get should not be called');
      },
      async queryOrders() {
        throw new Error('query should not be called');
      },
    };
    await expect(readPos('recent', firestore, new Date())).rejects.toThrow(
      /repeated Firestore page token/,
    );
    expect(calls).toBe(2);
  });

  it('skips the order query when there are no shifts', async () => {
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        return { documents: [] };
      },
      async getShift() {
        throw new Error('get should not be called');
      },
      async queryOrders() {
        throw new Error('query should not be called');
      },
    };
    const snapshot = await readPos('recent', firestore, new Date());
    expect(snapshot.scope).toEqual({ shift_ids: [] });
    expect(snapshot.orders).toEqual([]);
  });

  it('fails closed when the recent order page is full', async () => {
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        return { documents: [shiftDoc('shift-test-1')] };
      },
      async getShift() {
        return null;
      },
      async queryOrders() {
        return Array.from({ length: RECENT_ORDER_LIMIT }, (_, index) => ({
          name: `${DOC}/orders/order-test-${index}`,
        }));
      },
    };
    await expect(readPos('recent', firestore, new Date())).rejects.toThrow(
      /truncated/,
    );
  });

  it('marks a missing shift without dropping its orders', async () => {
    const now = new Date('2026-10-16T00:00:00.000Z');
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        throw new Error('list should not be called');
      },
      async getShift(id) {
        return id === 'shift-test-absent' ? null : shiftDoc(id);
      },
      async queryOrders(body) {
        const text = JSON.stringify(body);
        if ((text.match(/timestampValue/g) ?? []).length < 2) {
          return [];
        }
        return [orderDoc('order-test-1', 'shift-test-absent')];
      },
    };
    const snapshot = await readPos('window35', firestore, now);
    expect(snapshot.scope).toEqual({ from: window35From(now) });
    expect(snapshot.orders).toHaveLength(1);
    expect(snapshot.shifts).toEqual([]);
    expect(snapshot.missingShiftIds).toEqual(['shift-test-absent']);
  });

  it('fails closed when an order is newer than the scan window', async () => {
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        return { documents: [] };
      },
      async getShift() {
        return null;
      },
      async queryOrders(body) {
        const text = JSON.stringify(body);
        if ((text.match(/timestampValue/g) ?? []).length < 2) {
          return [orderDoc('order-test-future', 'shift-test-1')];
        }
        return [];
      },
    };
    await expect(
      readPos('window35', firestore, new Date('2026-10-16T00:00:00Z')),
    ).rejects.toThrow(/scan window/);
  });

  it('reads pre-window orders once when that shift also has an order inside the window', async () => {
    const now = new Date('2026-10-16T00:00:00.000Z');
    const inside = orderDoc(
      'order-inside',
      'shift-early',
      '2026-10-15T12:00:00Z',
    );
    const before = orderDoc(
      'order-before',
      'shift-early',
      '2026-09-10T09:00:00Z',
    );
    const queries: unknown[] = [];
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        throw new Error('list should not be called');
      },
      async getShift(id) {
        return shiftDoc(
          id,
          id === 'shift-early'
            ? '2026-09-10T08:01:00Z'
            : '2026-10-15T09:00:00Z',
        );
      },
      async queryOrders(body) {
        queries.push(body);
        const ids = inShiftIds(body);
        if (ids !== null) {
          return [inside, before];
        }
        if (timestampCount(body) < 2) return [];
        return [
          inside,
          orderDoc('order-later', 'shift-later', '2026-10-15T13:00:00Z'),
        ];
      },
    };
    const snapshot = await readPos('window35', firestore, now);
    expect(snapshot.scope).toEqual({ from: window35From(now) });
    expect(inShiftIds(queries.at(-1))).toEqual(['shift-early']);
    expect(snapshot.orders.map((order) => order.id)).toEqual([
      'order-before',
      'order-inside',
      'order-later',
    ]);
  });

  it('chunks a pre-window shift read at the Firestore IN limit', async () => {
    const now = new Date('2026-10-16T00:00:00.000Z');
    const ids = Array.from(
      { length: FIRESTORE_IN_LIMIT + 1 },
      (_, index) => `shift-early-${String(index + 1).padStart(2, '0')}`,
    );
    const queries: unknown[] = [];
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        throw new Error('list should not be called');
      },
      async getShift(id) {
        return shiftDoc(id, '2026-09-10T08:01:00Z');
      },
      async queryOrders(body) {
        queries.push(body);
        const requested = inShiftIds(body);
        if (requested !== null) return [];
        if (timestampCount(body) < 2) return [];
        return ids.map((id) => orderDoc(`order-${id}`, id));
      },
    };
    const snapshot = await readPos('window35', firestore, now);
    const inQueries = queries.filter((body) => inShiftIds(body) !== null);
    expect(inQueries.map((body) => inShiftIds(body))).toEqual([
      ids.slice(0, FIRESTORE_IN_LIMIT),
      ids.slice(FIRESTORE_IN_LIMIT),
    ]);
    expect(snapshot.scope).toEqual({ from: window35From(now) });
    expect(snapshot.orders).toHaveLength(ids.length);
    for (const body of inQueries) {
      expect(() =>
        assertFirestoreReadAllowed('POST', firestoreRunQueryUrl(), body),
      ).not.toThrow();
    }
  });

  it('fails closed when a pre-window order page is full', async () => {
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        throw new Error('list should not be called');
      },
      async getShift(id) {
        return shiftDoc(id, '2026-09-10T08:01:00Z');
      },
      async queryOrders(body) {
        if (inShiftIds(body) !== null) {
          return Array.from({ length: RECENT_ORDER_LIMIT }, (_, index) => ({
            name: `${DOC}/orders/order-full-${index}`,
          }));
        }
        if (timestampCount(body) < 2) return [];
        return [orderDoc('order-inside', 'shift-early')];
      },
    };
    await expect(
      readPos('window35', firestore, new Date('2026-10-16T00:00:00.000Z')),
    ).rejects.toThrow(/truncated/);
  });

  it('pages a full read and rejects a repeated token', async () => {
    let shiftCalls = 0;
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list(collection, query) {
        expect(query.pageSize).toBe(LIST_PAGE_SIZE);
        if (collection === 'orders') {
          return { documents: [orderDoc('order-test-1', 'shift-test-1')] };
        }
        shiftCalls += 1;
        if (shiftCalls === 1) {
          return {
            documents: [shiftDoc('shift-test-1')],
            nextPageToken: 'page-2',
          };
        }
        return { documents: [shiftDoc('shift-test-2')] };
      },
      async getShift() {
        return null;
      },
      async queryOrders() {
        throw new Error('query should not be called');
      },
    };
    const snapshot = await readPos('full', firestore, new Date());
    expect(snapshot.scope).toEqual({ all: true });
    expect(snapshot.shifts.map((shift) => shift.id)).toEqual([
      'shift-test-1',
      'shift-test-2',
    ]);
    expect(snapshot.orders).toHaveLength(1);

    let repeated = 0;
    const looping: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        repeated += 1;
        return { documents: [], nextPageToken: 'again' };
      },
      async getShift() {
        return null;
      },
      async queryOrders() {
        return [];
      },
    };
    await expect(readPos('full', looping, new Date())).rejects.toThrow(
      /repeated Firestore page token/,
    );
    expect(repeated).toBe(2);
  });

  it('stops after the page cap', async () => {
    let calls = 0;
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        calls += 1;
        return { documents: [], nextPageToken: `page-${calls}` };
      },
      async getShift() {
        return null;
      },
      async queryOrders() {
        return [];
      },
    };
    await expect(readPos('full', firestore, new Date())).rejects.toThrow(
      /page limit/,
    );
    expect(calls).toBe(MAX_LIST_PAGES);
  });
});

describe('collectTimestampRange', () => {
  it('splits a full page and throws when one millisecond is still full', async () => {
    const start = '2026-10-15T00:00:00.000Z';
    const end = new Date(Date.parse(start) + 4).toISOString();
    const firestore: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        return { documents: [] };
      },
      async getShift() {
        return null;
      },
      async queryOrders(body) {
        const text = JSON.stringify(body);
        const times = [...text.matchAll(/"timestampValue":"([^"]+)"/g)].map(
          (match) => match[1],
        );
        const rangeStart = times[0];
        const rangeEnd = times[1];
        if (rangeStart === undefined || rangeEnd === undefined) {
          return [];
        }
        const width = Date.parse(rangeEnd) - Date.parse(rangeStart);
        if (width <= 1) {
          return [orderDoc(`order-${rangeStart}`, 'shift-test-1')];
        }
        return Array.from({ length: RANGE_LIMIT }, (_, index) => ({
          name: `${DOC}/orders/full-${width}-${index}`,
        }));
      },
    };
    const documents = await collectTimestampRange(firestore, start, end);
    expect(documents).toHaveLength(4);

    const full: PosFirestore = {
      async listShiftTransactions() {
        return { documents: [] };
      },
      async list() {
        return { documents: [] };
      },
      async getShift() {
        return null;
      },
      async queryOrders() {
        return Array.from({ length: RANGE_LIMIT }, (_, index) => ({
          name: `${DOC}/orders/ms-${index}`,
        }));
      },
    };
    await expect(
      collectTimestampRange(
        full,
        start,
        new Date(Date.parse(start) + 1).toISOString(),
      ),
    ).rejects.toThrow(/still full/);
  });
});

function timestampCount(body: unknown): number {
  return JSON.stringify(body).match(/timestampValue/g)?.length ?? 0;
}

function inShiftIds(body: unknown): string[] | null {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('structuredQuery' in body)
  ) {
    return null;
  }
  const where = (
    body as {
      structuredQuery?: {
        where?: {
          fieldFilter?: {
            op?: string;
            value?: {
              arrayValue?: { values?: Array<{ stringValue?: string }> };
            };
          };
        };
      };
    }
  ).structuredQuery?.where?.fieldFilter;
  if (where?.op !== 'IN') return null;
  return (where.value?.arrayValue?.values ?? []).map(
    (entry) => entry.stringValue ?? '',
  );
}

function txDoc(shiftId: string, txId: string): FirestoreRestDocument {
  return {
    name: `${DOC}/custody_shifts/${shiftId}/transactions/${txId}`,
    fields: {
      type: { integerValue: '3' },
      amount: { doubleValue: 12.5 },
      timestamp: { timestampValue: '2026-10-15T15:00:00Z' },
      description: { stringValue: 'pii-tx-description' },
    },
  };
}

describe('shift transactions', () => {
  it('pages every shift in the snapshot and drops non-accounting fields', async () => {
    const queries: unknown[] = [];
    const firestore: PosFirestore = {
      async list() {
        return {
          documents: [shiftDoc('shift-test-b'), shiftDoc('shift-test-a')],
        };
      },
      async listShiftTransactions(shiftId, query) {
        queries.push({ shiftId, query });
        if (query.pageToken === undefined) {
          return {
            documents: [txDoc(shiftId, 'tx-b')],
            nextPageToken: 'page-2',
          };
        }
        return { documents: [txDoc(shiftId, 'tx-a')] };
      },
      async getShift() {
        throw new Error('get should not be called');
      },
      async queryOrders() {
        return [];
      },
    };
    const snapshot = await readPos('recent', firestore, new Date());
    expect(queries).toEqual([
      { shiftId: 'shift-test-a', query: { pageSize: LIST_PAGE_SIZE } },
      {
        shiftId: 'shift-test-a',
        query: { pageSize: LIST_PAGE_SIZE, pageToken: 'page-2' },
      },
      { shiftId: 'shift-test-b', query: { pageSize: LIST_PAGE_SIZE } },
      {
        shiftId: 'shift-test-b',
        query: { pageSize: LIST_PAGE_SIZE, pageToken: 'page-2' },
      },
    ]);
    expect(
      snapshot.shifts.map((shift) => shift.transactions.map((tx) => tx.tx_id)),
    ).toEqual([
      ['tx-a', 'tx-b'],
      ['tx-a', 'tx-b'],
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('pii-tx-description');
  });

  it('fails closed when transaction pages exceed the cap', async () => {
    let calls = 0;
    const firestore: PosFirestore = {
      async list() {
        return { documents: [shiftDoc('shift-test-1')] };
      },
      async listShiftTransactions() {
        calls += 1;
        return { documents: [], nextPageToken: `tok-${calls}` };
      },
      async getShift() {
        return null;
      },
      async queryOrders() {
        return [];
      },
    };
    await expect(readPos('recent', firestore, new Date())).rejects.toThrow(
      /page limit/,
    );
    expect(calls).toBe(MAX_LIST_PAGES);
  });

  it('fails when a transaction document names another shift', async () => {
    let queried = false;
    const firestore: PosFirestore = {
      async list() {
        return { documents: [shiftDoc('shift-test-1')] };
      },
      async listShiftTransactions() {
        return { documents: [txDoc('shift-test-other', 'tx-a')] };
      },
      async getShift() {
        return null;
      },
      async queryOrders() {
        queried = true;
        return [];
      },
    };
    await expect(readPos('recent', firestore, new Date())).rejects.toThrow(
      /invalid response/,
    );
    expect(queried).toBe(true);
  });
});
