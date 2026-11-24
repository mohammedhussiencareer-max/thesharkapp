import { expect, it, vi } from 'vitest';
import { parseCatalog } from './catalog.ts';
import { TRANSACTION_FIELD_PATHS } from './firestore-projection.ts';
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
import {
  mapOrderDocument,
  mapShiftDocument,
  mapShiftTransaction,
} from './mapper.ts';
import {
  recentOrdersQuery,
  timestampProbeQuery,
  timestampRangeQuery,
} from './read-pos.ts';
import { PosSyncError, safeErrorMessage } from './safe-error.ts';
import { readTransactionResponse } from './transaction-response.ts';

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
  ['orders', 'list'],
  ['orders', 'query'],
  ['custody_shifts', 'list'],
  ['custody_shifts', 'get'],
] as const)(
  'rejects an unexpected %s document envelope key statically through %s and raw firestoreFetch',
  async (collection, operation) => {
    const marker = 'synthetic-envelope-extra-marker';
    const doc = {
      name: `${DOCUMENT_ROOT}/${collection}/doc-test-env`,
      extra: { stringValue: marker },
    };
    const badCreateTimeDoc = {
      name: `${DOCUMENT_ROOT}/${collection}/doc-test-env`,
      createTime: 12345,
    };
    const makePayload = (document: unknown) =>
      operation === 'query'
        ? [{ document, readTime: READ_TIME }]
        : operation === 'get'
          ? document
          : { documents: [document] };

    for (const candidate of [doc, badCreateTimeDoc]) {
      const transport = async () => respond(makePayload(candidate));
      const client = createPosFirestore('test-token', transport);
      const clientReq =
        operation === 'query'
          ? client.queryOrders(recentOrdersQuery(['shift-test-1']))
          : operation === 'get'
            ? client.getShift('doc-test-env')
            : client.list(collection, { pageSize: 1 });
      const clientError: unknown = await clientReq.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(clientError).toEqual(new PosSyncError('firestoreInvalidResponse'));
      expect(safeErrorMessage(clientError)).toBe(INVALID_RESPONSE);
      expect(String(clientError)).not.toContain(marker);

      const rawReq =
        operation === 'query'
          ? firestoreFetch(
              'POST',
              QUERY_URL,
              'test-token',
              recentOrdersQuery(['shift-test-1']),
              transport,
            )
          : operation === 'get'
            ? firestoreFetch(
                'GET',
                firestoreGetUrl('custody_shifts', 'doc-test-env'),
                'test-token',
                undefined,
                transport,
              )
            : firestoreFetch(
                'GET',
                firestoreListUrl(collection, { pageSize: 1 }),
                'test-token',
                undefined,
                transport,
              );
      const rawError: unknown = await rawReq.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(rawError).toEqual(new PosSyncError('firestoreInvalidResponse'));
      expect(safeErrorMessage(rawError)).toBe(INVALID_RESPONSE);
      expect(String(rawError)).not.toContain(marker);
    }

    const directParse = () =>
      operation === 'query'
        ? parseRunQueryResponse(
            [{ document: doc, readTime: READ_TIME }],
            collection,
          )
        : parseListResponse({ documents: [doc] }, collection);
    let directError: unknown;
    try {
      directParse();
    } catch (error) {
      directError = error;
    }
    expect(directError).toEqual(new PosSyncError('firestoreInvalidResponse'));
    expect(safeErrorMessage(directError)).toBe(INVALID_RESPONSE);
    expect(String(directError)).not.toContain(marker);
  },
);

it('rejects an unexpected transaction document envelope key in parseListResponse', () => {
  const marker = 'synthetic-tx-envelope-marker';
  let caught: unknown;
  try {
    parseListResponse(
      {
        documents: [
          {
            name: `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-env`,
            extra: { stringValue: marker },
          },
        ],
      },
      'transactions',
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(new PosSyncError('firestoreInvalidResponse'));
  expect(safeErrorMessage(caught)).toBe(INVALID_RESPONSE);
  expect(String(caught)).not.toContain(marker);
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
    expect(error).toEqual(new PosSyncError('firestoreInvalidResponse'));
    expect(safeErrorMessage(error)).toBe(INVALID_RESPONSE);
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
      expect(error).toEqual(new PosSyncError('firestoreInvalidResponse'));
      expect(safeErrorMessage(error)).toBe(INVALID_RESPONSE);
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
    expect(error).toEqual(new PosSyncError('firestoreInvalidResponse'));
    expect(safeErrorMessage(error)).toBe(INVALID_RESPONSE);
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
    expect(error).toEqual(new PosSyncError('firestoreInvalidResponse'));
    expect(safeErrorMessage(error)).toBe(INVALID_RESPONSE);
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

it('copies each transaction chunk into an owned buffer before scanning so a reused buffer cannot smuggle description into decoding', async () => {
  const marker = 'synthetic-reused-buffer-description';
  const safeValue = 'safe-placeholder-value-000000000000';
  expect(safeValue.length).toBe(marker.length);
  const encoder = new TextEncoder();
  const initialText = `{"documents":[{"name":"${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1","fields":{"orderId":    {"stringValue":"${safeValue}"}}}`;
  const mutatedText = `{"documents":[{"name":"${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1","fields":{"description":{"stringValue":"${marker}"}}}`;
  const initialBytes = encoder.encode(initialText);
  const mutatedBytes = encoder.encode(mutatedText);
  expect(mutatedBytes.length).toBe(initialBytes.length);

  const makeReusedBufferStream = () => {
    const shared = new Uint8Array(initialBytes.length);
    let step = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (step === 0) {
            step = 1;
            shared.set(initialBytes);
            controller.enqueue(shared);
          } else if (step === 1) {
            step = 2;
            shared.set(mutatedBytes);
            controller.enqueue(encoder.encode(']}'));
          } else {
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
  };

  const expected = {
    documents: [
      {
        name: `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-1`,
        fields: { orderId: { stringValue: safeValue } },
      },
    ],
  };

  const decoder = vi.spyOn(TextDecoder.prototype, 'decode');
  try {
    const direct = await readTransactionResponse(
      new Response(makeReusedBufferStream()),
    );
    expect(direct).toEqual(expected);

    const client = createPosFirestore(
      'test-token',
      async () => new Response(makeReusedBufferStream()),
    );
    await expect(
      client.listShiftTransactions('shift-test-1', { pageSize: 1 }),
    ).resolves.toEqual(expected);

    const decodedTexts = decoder.mock.results
      .map((result) => (typeof result.value === 'string' ? result.value : ''))
      .join('');
    expect(decodedTexts).not.toContain('description');
    expect(decodedTexts).not.toContain(marker);
  } finally {
    decoder.mockRestore();
  }
});

it('rejects duplicate documents and nextPageToken keys in a transaction response before JSON decoding', async () => {
  const txName = `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-dup`;
  const validDoc = `{"name":"${txName}","fields":{"amount":{"integerValue":"5"}}}`;
  const cases = [
    [
      'escaped duplicate documents',
      `{"documents":[${validDoc}],"docu\\u006dents":[]}`,
    ],
    [
      'literal duplicate documents',
      `{"documents":[${validDoc}],"documents":[]}`,
    ],
    [
      'literal duplicate nextPageToken',
      `{"documents":[${validDoc}],"nextPageToken":"page-2","nextPageToken":""}`,
    ],
    [
      'escaped duplicate nextPageToken',
      `{"documents":[${validDoc}],"nextPageToken":"page-2","next\\u0050ageToken":""}`,
    ],
    [
      'duplicate document field key',
      `{"documents":[{"name":"${txName}","fields":{"amount":{"integerValue":"5"},"am\\u006funt":{"integerValue":"0"}}}]}`,
    ],
  ] as const;

  for (const [label, body] of cases) {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const directError: unknown = await readTransactionResponse(
        new Response(body),
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(directError, `${label} (direct)`).toEqual(
        new PosSyncError('firestoreInvalidResponse'),
      );
      expect(safeErrorMessage(directError), `${label} (direct)`).toBe(
        INVALID_RESPONSE,
      );
      expect(directError, `${label} (direct)`).not.toHaveProperty('cause');

      const client = createPosFirestore(
        'test-token',
        async () => new Response(body),
      );
      const clientError: unknown = await client
        .listShiftTransactions('shift-test-1', { pageSize: 1 })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );
      expect(clientError, `${label} (client)`).toEqual(
        new PosSyncError('firestoreInvalidResponse'),
      );
      expect(safeErrorMessage(clientError), `${label} (client)`).toBe(
        INVALID_RESPONSE,
      );
      expect(clientError, `${label} (client)`).not.toHaveProperty('cause');
      expect(
        parse.mock.calls.some(([text]) => text.includes(txName)),
        `${label} must reject before parsing full body`,
      ).toBe(false);
    } finally {
      parse.mockRestore();
    }
  }
});

it('converts raw stream errors to firestoreInvalidResponse in readTransactionResponse', async () => {
  const marker = 'synthetic-stream-source-error';
  const raw = new Error(marker);
  const brokenStream = new ReadableStream<Uint8Array>(
    {
      pull() {
        throw raw;
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(brokenStream);
  const error: unknown = await readTransactionResponse(response).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(PosSyncError.is(error)).toBe(true);
  expect(error).toEqual(new PosSyncError('firestoreInvalidResponse'));
  expect(safeErrorMessage(error)).toBe(INVALID_RESPONSE);
  expect(error).not.toHaveProperty('cause');
  expect(String(error)).not.toContain(marker);
  expect(response.body?.locked).toBe(false);
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
    expect(error).toEqual(new PosSyncError('firestoreInvalidResponse'));
    expect(safeErrorMessage(error)).toBe(INVALID_RESPONSE);
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
  expect(error).toEqual(new PosSyncError('firestoreInvalidResponse'));
  expect(safeErrorMessage(error)).toBe(INVALID_RESPONSE);
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
    expect(error).toEqual(new PosSyncError('firestoreInvalidResponse'));
    expect(safeErrorMessage(error)).toBe(INVALID_RESPONSE);
    expect(mapOrder).not.toHaveBeenCalled();
    expect(readNested).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(marker);
  } finally {
    parse.mockRestore();
  }
});

it.each([
  ['orders', { timestamp: { integerValue: '1' } }],
  ['orders', { timestamp: { stringValue: 'not-a-timestamp' } }],
  ['orders', { timestamp: { timestampValue: 'not-a-timestamp' } }],
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
  ['custody_shifts', { opening_time: { stringValue: 'not-a-timestamp' } }],
  ['custody_shifts', { closingTime: { stringValue: 'not-a-timestamp' } }],
] as const)(
  'rejects the wrong value kind or invalid timestamp text at a projected %s scalar (%j)',
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

it('accepts valid RFC 3339 timestamps stored as stringValue for orders, shifts, and transactions', async () => {
  const orderDoc = {
    name: `${DOCUMENT_ROOT}/orders/order-test-str-ts`,
    updateTime: READ_TIME,
    fields: {
      status: { stringValue: 'complete' },
      shiftId: { stringValue: 'shift-test-1' },
      timestamp: { stringValue: '2026-11-20T12:00:00Z' },
      subtotalAmount: { integerValue: '10' },
      discountAmount: { integerValue: '0' },
      taxTotalAmount: { integerValue: '0' },
      serviceTaxAmount: { integerValue: '0' },
      totalAmount: { integerValue: '10' },
    },
  };
  const shiftDoc = {
    name: `${DOCUMENT_ROOT}/custody_shifts/shift-test-1`,
    updateTime: READ_TIME,
    fields: {
      id: { stringValue: 'shift-test-1' },
      opening_time: { stringValue: '2026-11-20T09:00:00Z' },
      closingTime: { stringValue: '2026-11-20T18:00:00Z' },
      isActive: { booleanValue: false },
    },
  };
  const txDoc = {
    name: `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-str-ts`,
    fields: {
      orderId: { stringValue: 'order-test-str-ts' },
      type: { integerValue: '0' },
      amount: { integerValue: '10' },
      timestamp: { stringValue: '2026-11-20T15:04:05Z' },
    },
  };

  const orderPage = await createPosFirestore('test-token', async () =>
    respond({ documents: [orderDoc] }),
  ).list('orders', { pageSize: 1 });
  expect(mapOrderDocument(orderPage.documents[0]!).ordered_at).toBe(
    '2026-11-20T12:00:00.000000Z',
  );

  const shift = await createPosFirestore('test-token', async () =>
    respond(shiftDoc),
  ).getShift('shift-test-1');
  expect(mapShiftDocument(shift!)).toMatchObject({
    opened_at: '2026-11-20T09:00:00.000000Z',
    closed_at: '2026-11-20T18:00:00.000000Z',
  });

  const txPage = await createPosFirestore('test-token', async () =>
    respond({ documents: [txDoc] }),
  ).listShiftTransactions('shift-test-1', { pageSize: 1 });
  expect(
    mapShiftTransaction('shift-test-1', txPage.documents[0]!).occurred_at,
  ).toBe('2026-11-20T15:04:05.000000Z');
});

it.each([
  { stringValue: 'not-a-timestamp' },
  { timestampValue: 'not-a-timestamp' },
  { stringValue: '' },
  { integerValue: '1' },
] as const)(
  'rejects invalid transaction timestamp encoding or text (%j)',
  async (timestamp) => {
    const client = createPosFirestore('test-token', async () =>
      respond({
        documents: [
          {
            name: `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-bad-ts`,
            fields: {
              type: { integerValue: '0' },
              amount: { integerValue: '10' },
              timestamp,
            },
          },
        ],
      }),
    );
    await expect(
      client.listShiftTransactions('shift-test-1', { pageSize: 1 }),
    ).rejects.toThrow(INVALID_RESPONSE);
  },
);

it.each(['stringValue', 'timestampValue'] as const)(
  'accepts whitespace-padded legacy timestamps as %s through the transport for orders, shifts, and transactions',
  async (kind) => {
    const orderDoc = {
      name: `${DOCUMENT_ROOT}/orders/order-test-padded-ts`,
      updateTime: READ_TIME,
      fields: {
        status: { stringValue: 'complete' },
        shiftId: { stringValue: 'shift-test-1' },
        timestamp: { [kind]: '  2026-11-20T12:00:00Z  ' },
        subtotalAmount: { integerValue: '10' },
        discountAmount: { integerValue: '0' },
        taxTotalAmount: { integerValue: '0' },
        serviceTaxAmount: { integerValue: '0' },
        totalAmount: { integerValue: '10' },
      },
    };
    const shiftDoc = {
      name: `${DOCUMENT_ROOT}/custody_shifts/shift-test-1`,
      updateTime: READ_TIME,
      fields: {
        id: { stringValue: 'shift-test-1' },
        opening_time: { [kind]: '\t2026-11-20T09:00:00Z\n' },
        closingTime: { [kind]: ' 2026-11-20T18:00:00Z ' },
        isActive: { booleanValue: false },
      },
    };
    const txDoc = {
      name: `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-padded-ts`,
      fields: {
        orderId: { stringValue: 'order-test-padded-ts' },
        type: { integerValue: '0' },
        amount: { integerValue: '10' },
        timestamp: { [kind]: ' 2026-11-20T15:04:05Z ' },
      },
    };

    const orderPage = await createPosFirestore('test-token', async () =>
      respond({ documents: [orderDoc] }),
    ).list('orders', { pageSize: 1 });
    expect(mapOrderDocument(orderPage.documents[0]!).ordered_at).toBe(
      '2026-11-20T12:00:00.000000Z',
    );

    const queriedOrders = await createPosFirestore('test-token', async () =>
      respond([{ document: orderDoc, readTime: READ_TIME }]),
    ).queryOrders(recentOrdersQuery(['shift-test-1']));
    expect(mapOrderDocument(queriedOrders[0]!).ordered_at).toBe(
      '2026-11-20T12:00:00.000000Z',
    );

    const shiftPage = await createPosFirestore('test-token', async () =>
      respond({ documents: [shiftDoc] }),
    ).list('custody_shifts', { pageSize: 1 });
    expect(mapShiftDocument(shiftPage.documents[0]!)).toMatchObject({
      opened_at: '2026-11-20T09:00:00.000000Z',
      closed_at: '2026-11-20T18:00:00.000000Z',
    });

    const shift = await createPosFirestore('test-token', async () =>
      respond(shiftDoc),
    ).getShift('shift-test-1');
    expect(mapShiftDocument(shift!)).toMatchObject({
      opened_at: '2026-11-20T09:00:00.000000Z',
      closed_at: '2026-11-20T18:00:00.000000Z',
    });

    const txPage = await createPosFirestore('test-token', async () =>
      respond({ documents: [txDoc] }),
    ).listShiftTransactions('shift-test-1', { pageSize: 1 });
    expect(
      mapShiftTransaction('shift-test-1', txPage.documents[0]!).occurred_at,
    ).toBe('2026-11-20T15:04:05.000000Z');
  },
);

it('accepts blank optional closingTime text through the transport and rejects blank required timestamps', async () => {
  for (const closingTime of [
    { stringValue: '' },
    { stringValue: '   ' },
    { timestampValue: '' },
    { timestampValue: ' \t ' },
  ] as const) {
    const shiftDoc = {
      name: `${DOCUMENT_ROOT}/custody_shifts/shift-test-1`,
      updateTime: READ_TIME,
      fields: {
        id: { stringValue: 'shift-test-1' },
        opening_time: { timestampValue: '2026-11-20T09:00:00Z' },
        closingTime,
        isActive: { booleanValue: true },
      },
    };
    const shift = await createPosFirestore('test-token', async () =>
      respond(shiftDoc),
    ).getShift('shift-test-1');
    expect(mapShiftDocument(shift!).closed_at).toBeNull();

    const shiftPage = await createPosFirestore('test-token', async () =>
      respond({ documents: [shiftDoc] }),
    ).list('custody_shifts', { pageSize: 1 });
    expect(mapShiftDocument(shiftPage.documents[0]!).closed_at).toBeNull();
  }

  for (const badClosing of [
    { stringValue: '  not-a-timestamp  ' },
    { timestampValue: '  not-a-timestamp  ' },
  ] as const) {
    await expect(
      createPosFirestore('test-token', async () =>
        respond({
          name: `${DOCUMENT_ROOT}/custody_shifts/shift-test-1`,
          updateTime: READ_TIME,
          fields: {
            opening_time: { timestampValue: '2026-11-20T09:00:00Z' },
            closingTime: badClosing,
            isActive: { booleanValue: false },
          },
        }),
      ).getShift('shift-test-1'),
    ).rejects.toThrow(INVALID_RESPONSE);
  }

  for (const blank of [
    { stringValue: '' },
    { stringValue: '   ' },
    { timestampValue: '' },
    { timestampValue: '   ' },
  ] as const) {
    await expect(
      createPosFirestore('test-token', async () =>
        respond({
          documents: [
            {
              name: `${DOCUMENT_ROOT}/orders/order-test-blank-ts`,
              fields: { timestamp: blank },
            },
          ],
        }),
      ).list('orders', { pageSize: 1 }),
    ).rejects.toThrow(INVALID_RESPONSE);

    await expect(
      createPosFirestore('test-token', async () =>
        respond([
          {
            document: {
              name: `${DOCUMENT_ROOT}/orders/order-test-blank-ts`,
              fields: { timestamp: blank },
            },
            readTime: READ_TIME,
          },
        ]),
      ).queryOrders(recentOrdersQuery(['shift-test-1'])),
    ).rejects.toThrow(INVALID_RESPONSE);

    await expect(
      createPosFirestore('test-token', async () =>
        respond({
          name: `${DOCUMENT_ROOT}/custody_shifts/shift-test-1`,
          fields: { opening_time: blank },
        }),
      ).getShift('shift-test-1'),
    ).rejects.toThrow(INVALID_RESPONSE);

    await expect(
      createPosFirestore('test-token', async () =>
        respond({
          documents: [
            {
              name: `${DOCUMENT_ROOT}/${TX_PATH}/tx-test-blank-ts`,
              fields: {
                type: { integerValue: '0' },
                amount: { integerValue: '10' },
                timestamp: blank,
              },
            },
          ],
        }),
      ).listShiftTransactions('shift-test-1', { pageSize: 1 }),
    ).rejects.toThrow(INVALID_RESPONSE);
  }
});
