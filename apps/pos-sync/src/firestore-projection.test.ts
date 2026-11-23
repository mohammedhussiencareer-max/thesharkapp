import { expect, it, vi } from 'vitest';
import { parseCatalog } from './catalog.ts';
import { TRANSACTION_FIELD_PATHS } from './firestore-projection.ts';
import {
  assertFirestoreReadAllowed,
  createPosFirestore,
  firestoreRunQueryUrl,
} from './firestore-read.ts';
import { mapOrderDocument } from './mapper.ts';
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

it('projects all order query variants and fetches only the name for the timestamp probe', async () => {
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
  expect(selects).toEqual([
    select,
    select,
    { fields: [{ fieldPath: '__name__' }] },
  ]);
});

const PROBE_SELECT = { fields: [{ fieldPath: '__name__' }] };
const PROBE_FILTER = {
  fieldFilter: {
    field: { fieldPath: 'timestamp' },
    op: 'GREATER_THAN_OR_EQUAL',
    value: { timestampValue: READ_TIME },
  },
};

it('requires the exact name-only select for the timestamp probe', () => {
  const query = {
    from: [{ collectionId: 'orders' }],
    where: PROBE_FILTER,
    limit: 1,
  };
  const check = (changes: Record<string, unknown>) =>
    assertFirestoreReadAllowed('POST', QUERY_URL, {
      structuredQuery: { ...query, ...changes },
    });
  expect(() => check({ select: PROBE_SELECT })).not.toThrow();
  for (const select of [
    undefined,
    { fields: [] },
    { fields: ORDER_FIELDS.map((fieldPath) => ({ fieldPath })) },
    { fields: [...PROBE_SELECT.fields, { fieldPath: 'status' }] },
    { fields: [...PROBE_SELECT.fields, ...PROBE_SELECT.fields] },
  ]) {
    expect(() => check({ select })).toThrow(/^Firestore read refused$/);
  }
  expect(() => check({ select: PROBE_SELECT, limit: 2 })).toThrow(
    /^Firestore read refused$/,
  );
  expect(() => check({ select: PROBE_SELECT, where: undefined })).toThrow(
    /^Firestore read refused$/,
  );
});

it('accepts an envelope-only probe result and refuses document fields in a probe result', async () => {
  const name = `${DOCUMENT_ROOT}/orders/order-test-probe`;
  const request = (document: unknown) =>
    createPosFirestore('test-token', async () =>
      respond([{ document, readTime: READ_TIME }]),
    ).queryOrders(timestampProbeQuery(READ_TIME));

  await expect(
    request({ name, createTime: READ_TIME, updateTime: READ_TIME }),
  ).resolves.toEqual([{ name, updateTime: READ_TIME }]);
  await expect(request({ name, fields: {} })).resolves.toEqual([
    { name, fields: {} },
  ]);
  await expect(
    request({ name, fields: { status: { stringValue: 'complete' } } }),
  ).rejects.toThrow(INVALID_RESPONSE);
  await expect(
    request({ name, fields: { __name__: { stringValue: name } } }),
  ).rejects.toThrow(INVALID_RESPONSE);
  await expect(
    request({ name, extra: { stringValue: 'synthetic-extra' } }),
  ).rejects.toThrow(INVALID_RESPONSE);
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
  ['an escaped description', '"\\u0064escrip', 'tion"'],
  ['an envelope key inside fields', '"na', 'me"'],
] as const)(
  'cancels a transaction stream on %s before reading the tail or decoding its value',
  async (_case, keyPrefix, keySuffix) => {
    const marker = 'synthetic-unread-transaction-value';
    const encoder = new TextEncoder();
    const chunks = [
      `{"documents":[{"name":"${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1","fields":{"amount":{"integerValue":"5"},`,
      keyPrefix,
      `${keySuffix}:{"stringValue":"${marker}"}`, // The forbidden value shares the key's final chunk.
      '}}]}',
    ];
    const cancel = vi.fn();
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = chunks[reads++];
          if (next === undefined) controller.close();
          else controller.enqueue(encoder.encode(next));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const client = createPosFirestore(
      'test-token',
      async () => new Response(body),
    );
    const decoder = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      const error: unknown = await client
        .listShiftTransactions('shift-test-1', { pageSize: 1 })
        .catch((reason: unknown) => reason);
      expect(error).toEqual(new Error(INVALID_RESPONSE));
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain(marker);
      expect({ reads, cancellations: cancel.mock.calls.length }).toEqual({
        reads: 3,
        cancellations: 1,
      });
      expect(
        decoder.mock.results.some(
          (result) =>
            typeof result.value === 'string' && result.value.includes(marker),
        ),
      ).toBe(false);
    } finally {
      decoder.mockRestore();
    }
  },
);

it('cancels a transaction stream before consuming a later chunk holding the forbidden value', async () => {
  const marker = 'synthetic-later-chunk-transaction-value';
  const encoder = new TextEncoder();
  const chunks = [
    `{"documents":[{"name":"${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1","fields":{"amount":{"integerValue":"5"},`,
    '"description":',
    `{"stringValue":"${marker}"}}}]}`,
  ];
  const cancel = vi.fn();
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[reads++];
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const client = createPosFirestore(
    'test-token',
    async () => new Response(body),
  );
  const decoder = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    const error: unknown = await client
      .listShiftTransactions('shift-test-1', { pageSize: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toEqual(new Error(INVALID_RESPONSE));
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain(marker);
    expect({ reads, cancellations: cancel.mock.calls.length }).toEqual({
      reads: 2,
      cancellations: 1,
    });
    expect(
      decoder.mock.results.some(
        (result) =>
          typeof result.value === 'string' && result.value.includes(marker),
      ),
    ).toBe(false);
  } finally {
    decoder.mockRestore();
  }
});

it('cancels a transaction stream on missing comma after string value before reading a later chunk', async () => {
  const marker = 'synthetic-missing-comma-transaction-value';
  const encoder = new TextEncoder();
  const chunks = [
    `{"documents":[{"name":"${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1" "description":`,
    `{"stringValue":"${marker}"}}]}`,
  ];
  const cancel = vi.fn();
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[reads++];
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const client = createPosFirestore(
    'test-token',
    async () => new Response(body),
  );
  const decoder = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    const error: unknown = await client
      .listShiftTransactions('shift-test-1', { pageSize: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toEqual(new Error(INVALID_RESPONSE));
    expect({ reads, cancellations: cancel.mock.calls.length }).toEqual({
      reads: 1,
      cancellations: 1,
    });
    expect(
      decoder.mock.results.some(
        (result) =>
          typeof result.value === 'string' && result.value.includes(marker),
      ),
    ).toBe(false);
  } finally {
    decoder.mockRestore();
  }
});

it('accepts a transaction response with keys and UTF-8 values split across chunks', async () => {
  const expectedToken = 'page-é';
  const bytes = new TextEncoder().encode(
    `{"docu\\u006dents":[{"name":"${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1","fields":{"orderId":{"stringValue":"quotes \\"description\\" and café"}}}],"nextPageToken":"${expectedToken}"}`,
  );
  let offset = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    },
    { highWaterMark: 0 },
  );
  const client = createPosFirestore(
    'test-token',
    async () => new Response(body),
  );
  await expect(
    client.listShiftTransactions('shift-test-1', { pageSize: 1 }),
  ).resolves.toEqual({
    documents: [
      {
        name: `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1`,
        fields: { orderId: { stringValue: 'quotes "description" and café' } },
      },
    ],
    nextPageToken: expectedToken,
  });
});

it.each([
  ['orders', 'list'],
  ['orders', 'query'],
  ['custody_shifts', 'list'],
  ['custody_shifts', 'get'],
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

it.each(['items', 'optionGroups'] as const)(
  'keeps good %s documents and rejects only the document with an unexpected field',
  async (collection) => {
    const marker = 'synthetic-catalog-unexpected-value';
    const document = (id: string, fields: Record<string, unknown>) => ({
      name: `${DOCUMENT_ROOT}/${collection}/${id}`,
      updateTime: READ_TIME,
      fields: { name: { stringValue: 'Synthetic Catalog Name' }, ...fields },
    });
    const bad = document('doc-test-bad', { extra: { stringValue: marker } });
    const first = document('doc-test-first', {});
    const last = document('doc-test-last', {});
    const client = createPosFirestore('test-token', async () =>
      respond({
        documents: [first, bad, last],
        nextPageToken: 'next-catalog-page',
      }),
    );
    const page = await client.list(collection, { pageSize: 3 });
    expect(page).toEqual({
      documents: [first, { name: bad.name, rejected: true }, last],
      nextPageToken: 'next-catalog-page',
    });
    const presence =
      collection === 'items'
        ? parseCatalog(page.documents, []).presence.map((row) => ({
            id: row.pos_item_id,
            outcome: row.outcome,
          }))
        : parseCatalog([], page.documents).option_group_presence.map((row) => ({
            id: row.group_id,
            outcome: row.outcome,
          }));
    expect(presence).toEqual([
      { id: 'doc-test-bad', outcome: 'rejected' },
      { id: 'doc-test-first', outcome: 'accepted' },
      { id: 'doc-test-last', outcome: 'accepted' },
    ]);
    expect(JSON.stringify(page)).not.toContain(marker);
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

it('rejects a map under projected status without decoding the nested customer field', async () => {
  const marker = 'synthetic-forbidden-status-leaf';
  const readNested = vi.fn(() => {
    throw new Error(marker);
  });
  const forbiddenMap = {
    mapValue: {
      fields: {
        get customerName() {
          return readNested();
        },
      },
    },
  };
  const document = {
    name: `${DOCUMENT_ROOT}/orders/order-test-scalar`,
    fields: { status: forbiddenMap },
  };
  const body = 'synthetic-guard-fixture';
  const parseJson = JSON.parse;
  const parse = vi
    .spyOn(JSON, 'parse')
    .mockImplementation((text, reviver) =>
      text === body ? [{ document }] : (parseJson(text, reviver) as unknown),
    );
  try {
    const client = createPosFirestore(
      'test-token',
      async () => new Response(body),
    );
    const mapOrder = vi.fn(mapOrderDocument);
    const error: unknown = await client
      .queryOrders(recentOrdersQuery(['shift-test-1']))
      .then((documents) => documents.map(mapOrder))
      .catch((reason: unknown) => reason);
    expect(error).toEqual(new Error(INVALID_RESPONSE));
    expect(mapOrder).not.toHaveBeenCalled();
    expect(readNested).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(marker);
  } finally {
    parse.mockRestore();
  }
});

it.each([
  ['orders', { timestamp: { stringValue: READ_TIME } }],
  ['orders', { totalAmount: { booleanValue: true } }],
  ['orders', { orderNumber: { integerValue: 'one' } }],
  [
    'orders',
    {
      deliveryDetails: {
        mapValue: { fields: { deliveryFee: { arrayValue: {} } } },
      },
    },
  ],
  ['orders', { items: { arrayValue: { values: [], customerName: 'bad' } } }],
  ['custody_shifts', { isActive: { stringValue: 'true' } }],
] as const)(
  'rejects the wrong value kind at a projected %s scalar (%j)',
  async (collection, fields) => {
    const client = createPosFirestore('test-token', async () =>
      respond({
        documents: [
          { name: `${DOCUMENT_ROOT}/${collection}/doc-test-scalar`, fields },
        ],
      }),
    );
    await expect(client.list(collection, { pageSize: 1 })).rejects.toThrow(
      INVALID_RESPONSE,
    );
  },
);
