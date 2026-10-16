import { describe, expect, it } from 'vitest';
import {
  assertFirestoreReadAllowed,
  createPosFirestore,
  firestoreFetch,
  firestoreGetUrl,
  firestoreListUrl,
  firestoreRunQueryUrl,
  parseListResponse,
  parseRunQueryResponse,
} from './firestore-read.ts';
import { recentOrdersQuery } from './read-pos.ts';

const ROOT = firestoreRunQueryUrl().replace(':runQuery', '');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('assertFirestoreReadAllowed', () => {
  const refused = [
    ['PATCH', `${ROOT}/orders/order-test-1`],
    ['DELETE', `${ROOT}/orders/order-test-1`],
    ['PUT', `${ROOT}/orders/order-test-1`],
    ['POST', `${ROOT}:commit`],
    ['POST', `${ROOT}:batchWrite`],
    ['POST', `${ROOT}:beginTransaction`],
    ['POST', `${ROOT}:write`],
    ['POST', `${ROOT}/orders:runQuery`],
    ['GET', firestoreRunQueryUrl()],
    [
      'GET',
      'http://firestore.googleapis.com/v1/projects/thesharkrestaurant/databases/(default)/documents/orders?pageSize=1',
    ],
    [
      'GET',
      'https://firestore.googleapis.com.evil/v1/projects/thesharkrestaurant/databases/(default)/documents/orders?pageSize=1',
    ],
    [
      'GET',
      'https://firestore.googleapis.com/v1/projects/other/databases/(default)/documents/orders?pageSize=1',
    ],
    ['GET', `${ROOT}/customers?pageSize=1`],
    ['GET', `${ROOT}/orders/order-test-1/items/item-test-1`],
    ['GET', `${ROOT}/orders?pageSize=1&mask.fieldPaths=customerName`],
    ['GET', `${ROOT}/custody_shifts?pageSize=4&orderBy=customerName`],
    ['POST', `${firestoreRunQueryUrl()}?pageSize=1`],
    [
      'GET',
      'https://user:pass@firestore.googleapis.com/v1/projects/thesharkrestaurant/databases/(default)/documents/orders?pageSize=1',
    ],
    ['GET', `${ROOT}/orders/../customers?pageSize=1`],
  ] as const;

  it('refuses writes and other URLs before any request', async () => {
    for (const [method, url] of refused) {
      expect(() => assertFirestoreReadAllowed(method, url)).toThrow(
        /Firestore read refused/,
      );
      if (method !== 'GET' && method !== 'POST') {
        continue;
      }
      let called = 0;
      await expect(
        firestoreFetch(
          method,
          url,
          'test-token',
          method === 'POST' ? { writes: [] } : undefined,
          async () => {
            called += 1;
            return jsonResponse({});
          },
        ),
      ).rejects.toThrow(/Firestore read refused/);
      expect(called).toBe(0);
    }
  });

  it('refuses query bodies that mention customer fields or writes', () => {
    expect(() =>
      assertFirestoreReadAllowed('POST', firestoreRunQueryUrl(), {
        structuredQuery: {
          from: [{ collectionId: 'orders' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'customerName' },
              op: 'EQUAL',
              value: { stringValue: 'pii-customer-name' },
            },
          },
          limit: 1,
        },
      }),
    ).toThrow(/Firestore read refused/);
    expect(() =>
      assertFirestoreReadAllowed('POST', firestoreRunQueryUrl(), {
        structuredQuery: {
          from: [{ collectionId: 'orders' }],
          limit: 1,
        },
        writes: [],
      }),
    ).toThrow(/Firestore read refused/);
    expect(() =>
      assertFirestoreReadAllowed('POST', firestoreRunQueryUrl(), {
        structuredQuery: {
          from: [{ collectionId: 'customers' }],
          limit: 1,
        },
      }),
    ).toThrow(/Firestore read refused/);
  });
});

describe('firestoreFetch', () => {
  it('lists, gets, and queries with redirect blocked', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      url: string,
      init: RequestInit,
    ): Promise<Response> => {
      calls.push({ url, init });
      if (init.method === 'POST') {
        return jsonResponse([
          { readTime: '2026-10-15T00:00:00Z' },
          {
            document: {
              name: 'projects/thesharkrestaurant/databases/(default)/documents/orders/order-test-1',
              updateTime: '2026-10-15T12:00:00Z',
              fields: {},
            },
          },
        ]);
      }
      if (url.includes('/custody_shifts/shift-test-1')) {
        return jsonResponse({
          name: 'projects/thesharkrestaurant/databases/(default)/documents/custody_shifts/shift-test-1',
          updateTime: '2026-10-15T12:00:00Z',
          fields: {},
        });
      }
      return jsonResponse({
        documents: [
          {
            name: 'projects/thesharkrestaurant/databases/(default)/documents/custody_shifts/shift-test-1',
          },
        ],
        nextPageToken: '',
      });
    };
    const client = createPosFirestore('test-token', fetchImpl);
    const listed = await client.list('custody_shifts', {
      pageSize: 4,
      orderBy: 'opening_time desc',
    });
    expect(listed.documents).toHaveLength(1);
    expect(listed.nextPageToken).toBeUndefined();
    const got = await client.getShift('shift-test-1');
    expect(got?.name).toContain('custody_shifts/shift-test-1');
    const queried = await client.queryOrders(
      recentOrdersQuery(['shift-test-1']),
    );
    expect(queried).toHaveLength(1);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init.redirect).toBe('error');
      expect(new Headers(call.init.headers).get('Authorization')).toBe(
        'Bearer test-token',
      );
    }
    expect(calls[0]?.url).toContain('pageSize=4');
    expect(calls[0]?.url).toContain('orderBy=opening_time+desc');
    expect(
      firestoreListUrl('custody_shifts', {
        pageSize: 4,
        orderBy: 'opening_time desc',
      }),
    ).toBe(calls[0]?.url);
    expect(firestoreGetUrl('custody_shifts', 'shift-test-1')).toBe(
      calls[1]?.url,
    );
  });

  it('hides error bodies and treats 404 as a missing shift', async () => {
    const missing = createPosFirestore(
      'test-token',
      async () => new Response('pii-customer-name', { status: 404 }),
    );
    await expect(missing.getShift('shift-test-1')).resolves.toBeNull();

    const failed = createPosFirestore(
      'test-token',
      async () =>
        new Response('pii-customer-name ya29.SECRET', { status: 500 }),
    );
    await expect(failed.getShift('shift-test-1')).rejects.toThrow(
      /^Firestore read failed: HTTP 500$/,
    );
    await expect(
      createPosFirestore('test-token', async () => {
        throw new Error('ya29.SECRET');
      }).list('orders', { pageSize: 1 }),
    ).rejects.toThrow(/^Firestore read failed: network$/);
  });
});

const orderName =
  'projects/thesharkrestaurant/databases/(default)/documents/orders/order-test-1';

describe('parsers', () => {
  it('rejects a malformed list document instead of skipping it', () => {
    const invalid = /^Firestore read failed: invalid response$/;
    expect(() => parseListResponse({ documents: [null] })).toThrow(invalid);
    expect(() => parseListResponse({ documents: [{ readTime: 'x' }] })).toThrow(
      invalid,
    );
    expect(() => parseListResponse({ documents: [{ name: 1 }] })).toThrow(
      invalid,
    );
    expect(() =>
      parseListResponse({
        documents: [
          {
            name: 'projects/other/databases/(default)/documents/orders/order-test-1',
          },
        ],
      }),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse({
        documents: [
          {
            name: 'projects/thesharkrestaurant/databases/(default)/documents/customers/customer-test-1',
          },
        ],
      }),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse({
        documents: [{ name: orderName, updateTime: 1 }],
      }),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse({
        documents: [{ name: orderName, fields: 'nope' }],
      }),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse({ error: { message: 'pii-customer-name' } }),
    ).toThrow(invalid);
    expect(
      parseListResponse({ documents: [{ name: orderName }] }).documents,
    ).toHaveLength(1);
  });

  it('accepts only the documented list response keys', () => {
    const invalid = 'Firestore read failed: invalid response';
    expect(() => parseListResponse({ message: 'failed' })).toThrow(invalid);
    expect(() =>
      parseListResponse({ documents: [], nextPageToken: '', extra: 1 }),
    ).toThrow(invalid);
    expect(parseListResponse({})).toEqual({
      documents: [],
      nextPageToken: undefined,
    });
  });

  it('accepts a runQuery page that is only a readTime', () => {
    expect(
      parseRunQueryResponse([{ readTime: '2026-10-16T00:00:00Z' }]),
    ).toEqual([]);
    expect(
      parseRunQueryResponse([
        {
          readTime: '2026-10-16T00:00:00.123456789Z',
          skippedResults: 0,
          done: true,
          transaction: 'txn-test',
          explainMetrics: {},
        },
      ]),
    ).toEqual([]);
  });

  it('accepts documents followed by a trailing readTime entry', () => {
    expect(
      parseRunQueryResponse([
        {
          document: { name: orderName },
          readTime: '2026-10-16T00:00:00Z',
          skippedResults: 0,
        },
        { readTime: '2026-10-16T00:00:00Z' },
      ]),
    ).toEqual([{ name: orderName }]);
  });

  it('rejects a runQuery page that is not a complete read', () => {
    const invalid = /^Firestore read failed: invalid response$/;
    expect(() => parseRunQueryResponse([])).toThrow(invalid);
    expect(() => parseRunQueryResponse([{}])).toThrow(invalid);
    expect(() => parseRunQueryResponse([{ readTime: 7 }])).toThrow(invalid);
    expect(() => parseRunQueryResponse([{ readTime: 'x' }])).toThrow(invalid);
    expect(() =>
      parseRunQueryResponse([{ readTime: '2026-10-16T00:00:00Z', extra: 1 }]),
    ).toThrow(invalid);
    expect(() =>
      parseRunQueryResponse([
        { readTime: '2026-10-16T00:00:00Z', skippedResults: 1 },
      ]),
    ).toThrow(invalid);
    expect(() => parseRunQueryResponse([null])).toThrow(invalid);
    expect(() => parseRunQueryResponse([{ document: null }])).toThrow(invalid);
    expect(() =>
      parseRunQueryResponse([{ error: { message: 'pii-customer-name' } }]),
    ).toThrow(invalid);
  });
});
