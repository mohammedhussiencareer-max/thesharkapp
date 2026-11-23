import { expect, it, vi } from 'vitest';
import { TRANSACTION_FIELD_PATHS } from './firestore-projection.ts';
import {
  assertFirestoreReadAllowed,
  createPosFirestore,
  firestoreRunQueryUrl,
} from './firestore-read.ts';
import {
  recentOrdersQuery,
  timestampProbeQuery,
  timestampRangeQuery,
} from './read-pos.ts';

const QUERY_URL = firestoreRunQueryUrl();
const ROOT = QUERY_URL.replace(':runQuery', '');
const DOCUMENT_ROOT = new URL(ROOT).pathname.slice('/v1/'.length);
const TX_PATH = 'custody_shifts/shift-test-1/transactions';
const TRANSACTION_FIELDS = ['orderId', 'type', 'amount', 'timestamp'];
const SHIFT_FIELDS = [
  'id',
  'opening_time',
  'closingTime',
  'isActive',
  'cash_payments_net',
  'credit_payments',
];
const ORDER_FIELDS = [
  'status',
  'orderNumber',
  'shiftId',
  'orderType',
  'paymentType',
  'timestamp',
  'subtotalAmount',
  'discountAmount',
  'taxTotalAmount',
  'serviceTaxAmount',
  'deliveryDetails.deliveryFee',
  'totalAmount',
  'financialRevision',
  'lastFinancialOperationKey',
  'items',
];

const READ_TIME = '2026-11-20T12:00:00Z';
const INVALID_RESPONSE = 'Firestore read failed: invalid response';

function respond(payload: unknown): Response {
  return new Response(JSON.stringify(payload));
}

function pageQuery(nextPageToken: string | undefined) {
  return nextPageToken === undefined
    ? { pageSize: 1 }
    : { pageSize: 1, pageToken: nextPageToken };
}

it.each([
  ['transactions', TRANSACTION_FIELDS],
  ['orders', ORDER_FIELDS],
  ['custody_shifts', SHIFT_FIELDS],
  ['items', ['name', 'sizes', 'options', 'sharedOptionGroupIds']],
  ['optionGroups', ['name', 'values']],
] as const)('projects every %s list page', async (collection, fields) => {
  const requests: URL[] = [];
  const client = createPosFirestore('test-token', async (url) => {
    requests.push(new URL(url));
    return respond(requests.length === 1 ? { nextPageToken: 'next' } : {});
  });
  const read = (token?: string) =>
    collection === 'transactions'
      ? client.listShiftTransactions('shift-test-1', pageQuery(token))
      : client.list(collection, pageQuery(token));
  const firstPage = await read();
  await read(firstPage.nextPageToken);

  expect(requests.map((url) => url.searchParams.get('pageToken'))).toEqual([
    null,
    'next',
  ]);
  expect(
    requests.map((url) => url.searchParams.getAll('mask.fieldPaths').sort()),
  ).toEqual([[...fields].sort(), [...fields].sort()]);
});

it('projects a single shift read', async () => {
  const masks: string[][] = [];
  await createPosFirestore('test-token', async (url) => {
    masks.push(new URL(url).searchParams.getAll('mask.fieldPaths').sort());
    return respond({ name: `${DOCUMENT_ROOT}/custody_shifts/shift-test-1` });
  }).getShift('shift-test-1');
  expect(masks).toEqual([[...SHIFT_FIELDS].sort()]);
});

it('projects all order query variants', async () => {
  const selects: unknown[] = [];
  const client = createPosFirestore('test-token', async (_url, init) => {
    if (typeof init.body !== 'string') {
      throw new Error('expected a serialized query body');
    }
    const body = JSON.parse(init.body) as {
      structuredQuery: { select?: unknown };
    };
    selects.push(body.structuredQuery.select);
    return respond([{ readTime: READ_TIME }]);
  });
  await client.queryOrders(recentOrdersQuery(['shift-test-1']));
  await client.queryOrders(timestampRangeQuery(READ_TIME, READ_TIME, 1));
  await client.queryOrders(timestampProbeQuery(READ_TIME));

  const select = { fields: ORDER_FIELDS.map((fieldPath) => ({ fieldPath })) };
  expect(selects).toEqual([select, select, select]);
});

it.each([
  `${TX_PATH}?pageSize=1&pageToken=next`,
  'orders?pageSize=1',
  'orders/order-test-1',
  'custody_shifts?pageSize=1',
  'custody_shifts/shift-test-1',
  'items?pageSize=1',
  'optionGroups?pageSize=1',
])('refuses an unprojected GET to %s', (path) => {
  expect(() => assertFirestoreReadAllowed('GET', `${ROOT}/${path}`)).toThrow(
    /^Firestore read refused$/,
  );
});

it.each(['orders', 'custody_shifts'])(
  'refuses an unprojected %s query',
  (collectionId) => {
    expect(() =>
      assertFirestoreReadAllowed('POST', QUERY_URL, {
        structuredQuery: { from: [{ collectionId }], limit: 1 },
      }),
    ).toThrow(/^Firestore read refused$/);
  },
);

it.each([
  ['a missing field', (fields: readonly string[]) => fields.slice(1)],
  [
    'a duplicate field',
    (fields: readonly string[]) => [fields[1], ...fields.slice(1)],
  ],
  ['an extra field', (fields: readonly string[]) => [...fields, 'extra']],
  [
    'a replaced field',
    (fields: readonly string[]) => ['extra', ...fields.slice(1)],
  ],
] as const)('refuses a mask or select with %s', (_case, change) => {
  const txUrl = new URL(`${ROOT}/${TX_PATH}?pageSize=1`);
  for (const field of change(TRANSACTION_FIELD_PATHS)) {
    txUrl.searchParams.append('mask.fieldPaths', String(field));
  }
  expect(() => assertFirestoreReadAllowed('GET', txUrl.toString())).toThrow(
    /^Firestore read refused$/,
  );

  expect(() =>
    assertFirestoreReadAllowed('POST', QUERY_URL, {
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        limit: 1,
        select: {
          fields: change(ORDER_FIELDS).map((fieldPath) => ({ fieldPath })),
        },
      },
    }),
  ).toThrow(/^Firestore read refused$/);
});

it('refuses a transaction description before JSON decoding and keeps it out of errors and logs', async () => {
  const marker = 'synthetic-forbidden-transaction-description';
  const client = createPosFirestore('test-token', async () => {
    // Escaped key spelling must be recognized the same way as a literal key.
    const body = JSON.stringify({
      documents: [
        {
          name: `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1`,
          fields: {
            amount: { integerValue: '5' },
            description: { stringValue: marker },
          },
        },
      ],
    }).replace('"description"', '"\\u0064escription"');
    return new Response(body);
  });
  const parse = vi.spyOn(JSON, 'parse');
  const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (level) => vi.spyOn(console, level).mockImplementation(() => {}),
  );
  try {
    const error: unknown = await client
      .listShiftTransactions('shift-test-1', { pageSize: 1 })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(error).toEqual(new Error(INVALID_RESPONSE));
    expect(error).not.toHaveProperty('cause');
    expect(parse.mock.calls.some(([text]) => text.includes(marker))).toBe(
      false,
    );
    expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(
      marker,
    );
    expect(String(error)).not.toContain(marker);
  } finally {
    parse.mockRestore();
    for (const log of logs) {
      log.mockRestore();
    }
  }
});

it.each([
  ['orders', 'list'],
  ['orders', 'query'],
  ['custody_shifts', 'list'],
  ['custody_shifts', 'get'],
  ['items', 'list'],
  ['optionGroups', 'list'],
] as const)(
  'refuses an extra %s response field through %s',
  async (collection, operation) => {
    const document = {
      name: `${DOCUMENT_ROOT}/${collection}/doc-test-1`,
      fields: { extra: { stringValue: 'synthetic-extra' } },
    };
    const client = createPosFirestore('test-token', async () =>
      respond(
        operation === 'query'
          ? [{ document }]
          : operation === 'get'
            ? document
            : { documents: [document] },
      ),
    );
    const request =
      operation === 'query'
        ? client.queryOrders(recentOrdersQuery(['shift-test-1']))
        : operation === 'get'
          ? client.getShift('doc-test-1')
          : client.list(collection, { pageSize: 1 });
    const error: unknown = await request.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toEqual(new Error(INVALID_RESPONSE));
  },
);

it('refuses a sibling of the projected delivery fee', async () => {
  const client = createPosFirestore('test-token', async () =>
    respond([
      {
        document: {
          name: `${DOCUMENT_ROOT}/orders/order-test-1`,
          fields: {
            deliveryDetails: {
              mapValue: {
                fields: {
                  deliveryFee: { integerValue: '5' },
                  extra: { stringValue: 'synthetic-extra' },
                },
              },
            },
          },
        },
      },
    ]),
  );
  const error: unknown = await client
    .queryOrders(recentOrdersQuery(['shift-test-1']))
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
  expect(error).toEqual(new Error(INVALID_RESPONSE));
});
