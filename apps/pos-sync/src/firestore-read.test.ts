import { describe, expect, it } from 'vitest';
import { parseCatalog } from './catalog.ts';
import {
  assertFirestoreReadAllowed,
  createPosFirestore,
  firestoreFetch,
  firestoreGetUrl,
  firestoreListUrl,
  firestoreRunQueryUrl,
  firestoreTransactionsUrl,
  parseListResponse,
  parseRunQueryResponse,
} from './firestore-read.ts';
import type { ListCollection } from './pos-firestore.ts';
import { recentOrdersQuery } from './read-pos.ts';

const ROOT = firestoreRunQueryUrl().replace(':runQuery', '');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function listUrlResult(collection: string): string {
  try {
    return firestoreListUrl(collection as ListCollection, { pageSize: 1 });
  } catch (error) {
    return error instanceof Error ? error.message : 'thrown';
  }
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
    ['GET', `${ROOT}/custody_shifts/shift-test-1/orders?pageSize=1`],
    [
      'GET',
      `${ROOT}/custody_shifts/shift-test-1/transactions/tx-test-1/notes?pageSize=1`,
    ],
    ['GET', `${ROOT}/custody_shifts/shift-test-1/transactions/tx-test-1`],
    ['POST', `${ROOT}/custody_shifts/shift-test-1/transactions?pageSize=1`],
    ['PATCH', `${ROOT}/custody_shifts/shift-test-1/transactions?pageSize=1`],
    ['DELETE', `${ROOT}/custody_shifts/shift-test-1/transactions/tx-test-1`],
    ['PUT', `${ROOT}/custody_shifts/shift-test-1/transactions?pageSize=1`],
    [
      'GET',
      `${ROOT}/custody_shifts/shift-test-1/transactions?pageSize=1&orderBy=timestamp`,
    ],
    ['GET', `${ROOT}/custody_shifts/not safe/transactions?pageSize=1`],
    ['GET', `${ROOT}/items`],
    ['GET', `${ROOT}/items?pageSize=0`],
    ['GET', `${ROOT}/items?pageSize=301`],
    ['GET', `${ROOT}/items?pageSize=1&pageToken=`],
    ['GET', `${ROOT}/items?pageSize=1&orderBy=opening_time`],
    ['GET', `${ROOT}/items?pageSize=1&orderBy=name`],
    ['GET', `${ROOT}/items?pageSize=1&mask.fieldPaths=price`],
    ['GET', `${ROOT}/items/item-test-1`],
    ['GET', `${ROOT}/items/item-test-1/sub?pageSize=1`],
    ['GET', `${ROOT}/items/../customers?pageSize=1`],
    ['GET', `${ROOT}/items/../optionGroups?pageSize=1`],
    ['GET', `${ROOT}/customers/../items?pageSize=1`],
    ['GET', `${ROOT}/optionGroups/../items?pageSize=1`],
    ['GET', `${ROOT}/items/./?pageSize=1`],
    [
      'GET',
      'https://firestore.googleapis.com\\ignored\\../v1/projects/thesharkrestaurant/databases/(default)/documents/items?pageSize=1',
    ],
    [
      'GET',
      'https://firestore.googleapis.com\\..\\v1/projects/thesharkrestaurant/databases/(default)/documents/items?pageSize=1',
    ],
    ['GET', `${ROOT}/items\\..\\optionGroups?pageSize=1`],
    ['POST', `${ROOT}/items?pageSize=1`],
    ['PATCH', `${ROOT}/items/item-test-1`],
    ['DELETE', `${ROOT}/items/item-test-1`],
    ['PUT', `${ROOT}/items/item-test-1`],
    ['GET', `${ROOT}/optionGroups`],
    ['GET', `${ROOT}/optionGroups?pageSize=301`],
    ['GET', `${ROOT}/optionGroups?pageSize=1&orderBy=opening_time`],
    ['GET', `${ROOT}/optionGroups/group-test-1`],
    ['GET', `${ROOT}/optionGroups/group-test-1/values?pageSize=1`],
    ['GET', `${ROOT}/optionGroups/../customers?pageSize=1`],
    ['POST', `${ROOT}/optionGroups?pageSize=1`],
    ['PATCH', `${ROOT}/optionGroups/group-test-1`],
    ['DELETE', `${ROOT}/optionGroups/group-test-1`],
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
    expect(() =>
      assertFirestoreReadAllowed('POST', firestoreRunQueryUrl(), {
        structuredQuery: {
          from: [{ collectionId: 'items' }],
          limit: 1,
        },
      }),
    ).toThrow(/Firestore read refused/);
    expect(() =>
      assertFirestoreReadAllowed('POST', firestoreRunQueryUrl(), {
        structuredQuery: {
          from: [{ collectionId: 'optionGroups' }],
          limit: 1,
        },
      }),
    ).toThrow(/Firestore read refused/);
  });

  it('refuses a list collection that is not an allowlisted name before building the URL', () => {
    const traversed = [
      'items/../orders',
      'orders/../customers',
      'items/../items',
      'optionGroups/../items',
      'items/%2e%2e/orders',
      './orders',
      'custody_shifts/../orders',
      'items/./../optionGroups',
      'items\\../orders',
    ];
    for (const collection of traversed) {
      expect(listUrlResult(collection), collection).toBe(
        'Firestore read refused',
      );
    }
  });

  it('allows a paged list of items and optionGroups', () => {
    const itemsUrl = firestoreListUrl('items', {
      pageSize: 300,
      pageToken: 'items-page-2',
    });
    expect(itemsUrl).toBe(`${ROOT}/items?pageSize=300&pageToken=items-page-2`);
    expect(() => assertFirestoreReadAllowed('GET', itemsUrl)).not.toThrow();

    const groupsUrl = firestoreListUrl('optionGroups', {
      pageSize: 50,
    });
    expect(groupsUrl).toBe(`${ROOT}/optionGroups?pageSize=50`);
    expect(() => assertFirestoreReadAllowed('GET', groupsUrl)).not.toThrow();
  });

  it('allows a paged list of one shift transaction subcollection', () => {
    const url = firestoreTransactionsUrl('shift-test-1', {
      pageSize: 300,
      pageToken: 'page-2',
    });
    expect(url).toBe(
      `${ROOT}/custody_shifts/shift-test-1/transactions?pageSize=300&pageToken=page-2`,
    );
    expect(() => assertFirestoreReadAllowed('GET', url)).not.toThrow();
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

  it('lists items and optionGroups through createPosFirestore', async () => {
    const urls: string[] = [];
    const client = createPosFirestore('test-token', async (url) => {
      urls.push(url);
      if (url.includes('/items?')) {
        return jsonResponse({
          documents: [
            {
              name: 'projects/thesharkrestaurant/databases/(default)/documents/items/item-test-1',
              updateTime: '2026-11-20T10:00:00Z',
              fields: {},
            },
          ],
          nextPageToken: 'next-items',
        });
      }
      return jsonResponse({
        documents: [
          {
            name: 'projects/thesharkrestaurant/databases/(default)/documents/optionGroups/group-test-1',
            updateTime: '2026-11-20T09:00:00Z',
            fields: {},
          },
        ],
      });
    });
    const itemsPage = await client.list('items', { pageSize: 300 });
    expect(itemsPage.documents).toHaveLength(1);
    expect(itemsPage.nextPageToken).toBe('next-items');
    const groupsPage = await client.list('optionGroups', { pageSize: 50 });
    expect(groupsPage.documents).toHaveLength(1);
    expect(groupsPage.nextPageToken).toBeUndefined();
    expect(urls).toEqual([
      `${ROOT}/items?pageSize=300`,
      `${ROOT}/optionGroups?pageSize=50`,
    ]);
  });

  it('rejects a response document from a different collection than the one requested', async () => {
    const prefix = 'projects/thesharkrestaurant/databases/(default)/documents';
    const itemDoc = {
      name: `${prefix}/items/item-test-1`,
      updateTime: '2026-11-20T10:00:00Z',
      fields: {},
    };
    const groupDoc = {
      name: `${prefix}/optionGroups/group-test-1`,
      updateTime: '2026-11-20T09:00:00Z',
      fields: {},
    };
    const orderDoc = {
      name: orderName,
      updateTime: '2026-10-15T12:00:00Z',
      fields: {},
    };
    const shiftDoc = {
      name: `${prefix}/custody_shifts/shift-test-1`,
      updateTime: '2026-10-15T12:00:00Z',
      fields: {},
    };
    const invalid = /^Firestore read failed: invalid response$/;
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse({ documents: [itemDoc] }),
      ).list('orders', { pageSize: 1 }),
    ).rejects.toThrow(invalid);
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse({ documents: [groupDoc] }),
      ).list('custody_shifts', { pageSize: 1 }),
    ).rejects.toThrow(invalid);
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse(itemDoc),
      ).getShift('shift-test-1'),
    ).rejects.toThrow(invalid);
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse([
          { document: groupDoc, readTime: '2026-10-16T00:00:00Z' },
        ]),
      ).queryOrders(recentOrdersQuery(['shift-test-1'])),
    ).rejects.toThrow(invalid);
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse({ documents: [orderDoc] }),
      ).list('items', { pageSize: 1 }),
    ).rejects.toThrow(invalid);
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse({ documents: [shiftDoc] }),
      ).list('optionGroups', { pageSize: 1 }),
    ).rejects.toThrow(invalid);
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse({ documents: [itemDoc] }),
      ).listShiftTransactions('shift-test-1', { pageSize: 1 }),
    ).rejects.toThrow(invalid);
  });

  it('rejects a transaction whose parent shift is not the shift that was requested', async () => {
    const prefix = 'projects/thesharkrestaurant/databases/(default)/documents';
    const same = {
      name: `${prefix}/custody_shifts/shift-test-1/transactions/tx-test-1`,
      fields: {},
    };
    const other = {
      name: `${prefix}/custody_shifts/shift-test-other/transactions/tx-test-2`,
      fields: {},
    };
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse({ documents: [same, other] }),
      ).listShiftTransactions('shift-test-1', { pageSize: 2 }),
    ).rejects.toThrow(/^Firestore read failed: invalid response$/);
    await expect(
      createPosFirestore('test-token', async () =>
        jsonResponse({ documents: [same], nextPageToken: 'tx-page-2' }),
      ).listShiftTransactions('shift-test-1', { pageSize: 1 }),
    ).resolves.toEqual({
      documents: [same],
      nextPageToken: 'tx-page-2',
    });
  });

  it('validates queryOrders against the collection serialized before the request', async () => {
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        limit: 1,
      },
    };
    const orderDoc = {
      name: 'projects/thesharkrestaurant/databases/(default)/documents/orders/order-test-1',
      updateTime: '2026-10-15T12:00:00Z',
      fields: {},
    };
    const from = body.structuredQuery.from[0];
    if (from === undefined) {
      throw new Error('expected a from clause');
    }
    let sent = '';
    const docs = await createPosFirestore('test-token', async (_url, init) => {
      if (typeof init.body !== 'string') {
        throw new Error('expected a serialized query body');
      }
      sent = init.body;
      from.collectionId = 'custody_shifts';
      return jsonResponse([
        { document: orderDoc, readTime: '2026-10-16T00:00:00Z' },
      ]);
    }).queryOrders(body);
    expect(from.collectionId).toBe('custody_shifts');
    expect(sent).toBe(
      JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'orders' }],
          limit: 1,
        },
      }),
    );
    expect(docs).toEqual([orderDoc]);
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
    expect(() => parseListResponse({ documents: [null] }, 'orders')).toThrow(
      invalid,
    );
    expect(() =>
      parseListResponse({ documents: [{ readTime: 'x' }] }, 'orders'),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse({ documents: [{ name: 1 }] }, 'orders'),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse(
        {
          documents: [
            {
              name: 'projects/other/databases/(default)/documents/orders/order-test-1',
            },
          ],
        },
        'orders',
      ),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse(
        {
          documents: [
            {
              name: 'projects/thesharkrestaurant/databases/(default)/documents/customers/customer-test-1',
            },
          ],
        },
        'orders',
      ),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse(
        {
          documents: [{ name: orderName, updateTime: 1 }],
        },
        'orders',
      ),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse(
        {
          documents: [{ name: orderName, fields: 'nope' }],
        },
        'orders',
      ),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse({ error: { message: 'pii-customer-name' } }, 'orders'),
    ).toThrow(invalid);
    expect(
      parseListResponse({ documents: [{ name: orderName }] }, 'orders')
        .documents,
    ).toHaveLength(1);
    const itemName =
      'projects/thesharkrestaurant/databases/(default)/documents/items/item-test-1';
    const groupName =
      'projects/thesharkrestaurant/databases/(default)/documents/optionGroups/group-test-1';
    expect(
      parseListResponse({ documents: [{ name: itemName }] }, 'items').documents,
    ).toEqual([{ name: itemName }]);
    expect(
      parseListResponse({ documents: [{ name: groupName }] }, 'optionGroups')
        .documents,
    ).toEqual([{ name: groupName }]);
    expect(() =>
      parseListResponse({ documents: [{ name: itemName }] }, 'orders'),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse({ documents: [{ name: groupName }] }, 'custody_shifts'),
    ).toThrow(invalid);
    const txName =
      'projects/thesharkrestaurant/databases/(default)/documents/custody_shifts/shift-test-1/transactions/tx-test-1';
    expect(
      parseListResponse({ documents: [{ name: txName }] }, 'transactions')
        .documents,
    ).toEqual([{ name: txName }]);
    expect(() =>
      parseListResponse(
        {
          documents: [
            {
              name: 'projects/thesharkrestaurant/databases/(default)/documents/custody_shifts/shift-test-1/orders/order-test-1',
            },
          ],
        },
        'transactions',
      ),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse(
        {
          documents: [
            {
              name: 'projects/thesharkrestaurant/databases/(default)/documents/custody_shifts/shift-test-1/transactions/tx-test-1/extra',
            },
          ],
        },
        'transactions',
      ),
    ).toThrow(invalid);
  });

  it('records a rejected catalog id when one document has malformed metadata and keeps the rest of the page', () => {
    const prefix = 'projects/thesharkrestaurant/databases/(default)/documents';
    const good = `${prefix}/items/item-syn-good`;
    const badTime = `${prefix}/items/item-syn-bad-time`;
    const badFields = `${prefix}/items/item-syn-bad-fields`;
    const later = `${prefix}/items/item-syn-later`;
    const page = parseListResponse(
      {
        documents: [
          {
            name: good,
            updateTime: '2026-11-20T10:00:00Z',
            fields: { name: { stringValue: 'Synthetic Dish Good' } },
          },
          {
            name: badTime,
            updateTime: 1,
            fields: { name: { stringValue: 'syn-malformed-time' } },
          },
          {
            name: badFields,
            updateTime: '2026-11-20T10:00:00Z',
            fields: 'syn-malformed-fields',
          },
          {
            name: later,
            updateTime: '2026-11-20T11:00:00Z',
            fields: { name: { stringValue: 'Synthetic Dish Later' } },
          },
        ],
        nextPageToken: 'items-page-2',
      },
      'items',
    );
    expect(page.nextPageToken).toBe('items-page-2');
    expect(page.documents).toEqual([
      {
        name: good,
        updateTime: '2026-11-20T10:00:00Z',
        fields: { name: { stringValue: 'Synthetic Dish Good' } },
      },
      { name: badTime, rejected: true },
      { name: badFields, rejected: true },
      {
        name: later,
        updateTime: '2026-11-20T11:00:00Z',
        fields: { name: { stringValue: 'Synthetic Dish Later' } },
      },
    ]);
    expect(JSON.stringify(page)).not.toContain('syn-malformed-time');
    expect(JSON.stringify(page)).not.toContain('syn-malformed-fields');

    const goodGroup = `${prefix}/optionGroups/group-syn-good`;
    const badGroup = `${prefix}/optionGroups/group-syn-bad-time`;
    const laterGroup = `${prefix}/optionGroups/group-syn-later`;
    const groups = parseListResponse(
      {
        documents: [
          {
            name: goodGroup,
            updateTime: '2026-11-20T09:00:00Z',
            fields: { name: { stringValue: 'Synthetic Group Good' } },
          },
          {
            name: badGroup,
            updateTime: { seconds: 1 },
            fields: [],
          },
          {
            name: laterGroup,
            updateTime: '2026-11-20T09:30:00Z',
            fields: { name: { stringValue: 'Synthetic Group Later' } },
          },
        ],
      },
      'optionGroups',
    );
    expect(groups.documents).toEqual([
      {
        name: goodGroup,
        updateTime: '2026-11-20T09:00:00Z',
        fields: { name: { stringValue: 'Synthetic Group Good' } },
      },
      { name: badGroup, rejected: true },
      {
        name: laterGroup,
        updateTime: '2026-11-20T09:30:00Z',
        fields: { name: { stringValue: 'Synthetic Group Later' } },
      },
    ]);

    const payload = parseCatalog(page.documents, groups.documents);
    expect(payload.items.map((item) => item.pos_item_id)).toEqual([
      'item-syn-good',
      'item-syn-later',
    ]);
    expect(payload.presence).toEqual([
      { pos_item_id: 'item-syn-bad-fields', outcome: 'rejected' },
      { pos_item_id: 'item-syn-bad-time', outcome: 'rejected' },
      { pos_item_id: 'item-syn-good', outcome: 'accepted' },
      { pos_item_id: 'item-syn-later', outcome: 'accepted' },
    ]);
    expect(payload.option_groups.map((group) => group.group_id)).toEqual([
      'group-syn-good',
      'group-syn-later',
    ]);
    expect(payload.option_group_presence).toEqual([
      { group_id: 'group-syn-bad-time', outcome: 'rejected' },
      { group_id: 'group-syn-good', outcome: 'accepted' },
      { group_id: 'group-syn-later', outcome: 'accepted' },
    ]);
  });

  it('still rejects a catalog page when a document id is unsafe', () => {
    const prefix = 'projects/thesharkrestaurant/databases/(default)/documents';
    const invalid = /^Firestore read failed: invalid response$/;
    expect(() =>
      parseListResponse(
        {
          documents: [
            {
              name: `${prefix}/items/item-syn-good`,
              updateTime: '2026-11-20T10:00:00Z',
              fields: { name: { stringValue: 'Synthetic Dish Good' } },
            },
            {
              name: `${prefix}/items/not safe`,
              updateTime: '2026-11-20T10:00:00Z',
              fields: {},
            },
          ],
        },
        'items',
      ),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse(
        {
          documents: [
            {
              name: `${prefix}/optionGroups/group-syn${'\u0001'}ctrl`,
              updateTime: '2026-11-20T09:00:00Z',
              fields: {},
            },
          ],
        },
        'optionGroups',
      ),
    ).toThrow(invalid);
  });

  it('still rejects an orders or shifts page when metadata is malformed', () => {
    const prefix = 'projects/thesharkrestaurant/databases/(default)/documents';
    const invalid = /^Firestore read failed: invalid response$/;
    expect(() =>
      parseListResponse(
        {
          documents: [
            {
              name: `${prefix}/orders/order-test-1`,
              updateTime: '2026-10-15T12:00:00Z',
              fields: {},
            },
            {
              name: `${prefix}/orders/order-test-2`,
              updateTime: 1,
              fields: {},
            },
          ],
        },
        'orders',
      ),
    ).toThrow(invalid);
    expect(() =>
      parseListResponse(
        {
          documents: [
            {
              name: `${prefix}/custody_shifts/shift-test-1`,
              updateTime: '2026-10-15T12:00:00Z',
              fields: {},
            },
            {
              name: `${prefix}/custody_shifts/shift-test-2`,
              fields: 'nope',
            },
          ],
        },
        'custody_shifts',
      ),
    ).toThrow(invalid);
  });

  it('accepts only the documented list response keys', () => {
    const invalid = 'Firestore read failed: invalid response';
    expect(() => parseListResponse({ message: 'failed' }, 'orders')).toThrow(
      invalid,
    );
    expect(() =>
      parseListResponse(
        { documents: [], nextPageToken: '', extra: 1 },
        'orders',
      ),
    ).toThrow(invalid);
    expect(parseListResponse({}, 'orders')).toEqual({
      documents: [],
      nextPageToken: undefined,
    });
  });

  it('accepts a runQuery page that is only a readTime', () => {
    expect(
      parseRunQueryResponse([{ readTime: '2026-10-16T00:00:00Z' }], 'orders'),
    ).toEqual([]);
    expect(
      parseRunQueryResponse(
        [
          {
            readTime: '2026-10-16T00:00:00.123456789Z',
            skippedResults: 0,
            done: true,
            transaction: 'txn-test',
            explainMetrics: {},
          },
        ],
        'orders',
      ),
    ).toEqual([]);
  });

  it('accepts documents followed by a trailing readTime entry', () => {
    expect(
      parseRunQueryResponse(
        [
          {
            document: { name: orderName },
            readTime: '2026-10-16T00:00:00Z',
            skippedResults: 0,
          },
          { readTime: '2026-10-16T00:00:00Z' },
        ],
        'orders',
      ),
    ).toEqual([{ name: orderName }]);
  });

  it('rejects a runQuery page that is not a complete read', () => {
    const invalid = /^Firestore read failed: invalid response$/;
    expect(() => parseRunQueryResponse([], 'orders')).toThrow(invalid);
    expect(() => parseRunQueryResponse([{}], 'orders')).toThrow(invalid);
    expect(() => parseRunQueryResponse([{ readTime: 7 }], 'orders')).toThrow(
      invalid,
    );
    expect(() => parseRunQueryResponse([{ readTime: 'x' }], 'orders')).toThrow(
      invalid,
    );
    expect(() =>
      parseRunQueryResponse(
        [{ readTime: '2026-10-16T00:00:00Z', extra: 1 }],
        'orders',
      ),
    ).toThrow(invalid);
    expect(() =>
      parseRunQueryResponse(
        [{ readTime: '2026-10-16T00:00:00Z', skippedResults: 1 }],
        'orders',
      ),
    ).toThrow(invalid);
    expect(() => parseRunQueryResponse([null], 'orders')).toThrow(invalid);
    expect(() => parseRunQueryResponse([{ document: null }], 'orders')).toThrow(
      invalid,
    );
    expect(() =>
      parseRunQueryResponse(
        [{ error: { message: 'pii-customer-name' } }],
        'orders',
      ),
    ).toThrow(invalid);
  });
});
