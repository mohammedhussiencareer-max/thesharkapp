import { describe, expect, it } from 'vitest';
import {
  assertFirestoreReadAllowed,
  firestoreRunQueryUrl,
} from './firestore-read.ts';
import type { FirestoreRestDocument, PosFirestore } from './pos-firestore.ts';
import {
  LIST_PAGE_SIZE,
  MAX_LIST_PAGES,
  RANGE_LIMIT,
  RECENT_ORDER_LIMIT,
  collectTimestampRange,
  readPos,
  recentOrdersQuery,
  timestampProbeQuery,
  timestampRangeQuery,
} from './read-pos.ts';
import { window35From } from './scope.ts';

const DOC = 'projects/thesharkrestaurant/databases/(default)/documents';

function orderDoc(id: string, shiftId: string): FirestoreRestDocument {
  return {
    name: `${DOC}/orders/${id}`,
    updateTime: '2026-10-15T13:00:00Z',
    fields: {
      status: { stringValue: 'complete' },
      shiftId: { stringValue: shiftId },
      timestamp: { timestampValue: '2026-10-15T12:00:00Z' },
      subtotalAmount: { integerValue: '1' },
      discountAmount: { integerValue: '0' },
      taxTotalAmount: { integerValue: '0' },
      serviceTaxAmount: { integerValue: '0' },
      totalAmount: { integerValue: '1' },
    },
  };
}

function shiftDoc(id: string): FirestoreRestDocument {
  return {
    name: `${DOC}/custody_shifts/${id}`,
    updateTime: '2026-10-15T18:00:00Z',
    fields: {
      id: { stringValue: id },
      opening_time: { timestampValue: '2026-10-15T09:00:00Z' },
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
  it('reads four shifts and does not follow the next page', async () => {
    const lists: unknown[] = [];
    const queries: unknown[] = [];
    const firestore: PosFirestore = {
      async list(_collection, query) {
        lists.push(query);
        return {
          documents: [shiftDoc('shift-test-b'), shiftDoc('shift-test-a')],
          nextPageToken: 'do-not-follow',
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
    expect(lists).toEqual([{ pageSize: 4, orderBy: 'opening_time desc' }]);
    expect(queries).toHaveLength(1);
    expect(snapshot.scope).toEqual({
      shift_ids: ['shift-test-a', 'shift-test-b'],
    });
    expect(snapshot.orders.map((order) => order.id)).toEqual(['order-test-1']);
    expect(snapshot.missingShiftIds).toEqual([]);
  });

  it('skips the order query when there are no shifts', async () => {
    const firestore: PosFirestore = {
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

  it('pages a full read and rejects a repeated token', async () => {
    let shiftCalls = 0;
    const firestore: PosFirestore = {
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
