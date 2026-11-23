import { hasCustomerShapedSchemaKey } from './catalog-refusals.ts';
import {
  isRecord,
  isSafeDocumentId,
  splitDocumentName,
  splitTransactionName,
  type PosCollection,
} from './decode.ts';
import {
  assertProjectedDocument,
  FIRESTORE_FIELD_PATHS,
  matchesProjection,
  TRANSACTION_FIELD_PATHS,
  transactionResponseKeysAllowed,
} from './firestore-projection.ts';
import type {
  FirestoreRestDocument,
  ListCollection,
  ListPage,
  ListQuery,
  PosFirestore,
  TransactionListQuery,
} from './pos-firestore.ts';

const ORIGIN = 'https://firestore.googleapis.com';
const DOCUMENT_PATH =
  '/v1/projects/thesharkrestaurant/databases/(default)/documents';
const RUN_QUERY_PATH = `${DOCUMENT_PATH}:runQuery`;

const MASK_FIELD_PATHS = 'mask.fieldPaths';
const FIELD_PATHS = new Set(['shiftId', 'timestamp', '__name__']);
const FILTER_OPS = new Set(['IN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN']);
const VALUE_KINDS = new Set([
  'stringValue',
  'integerValue',
  'doubleValue',
  'booleanValue',
  'timestampValue',
  'nullValue',
  'arrayValue',
]);

type AccountingCollection = 'orders' | 'custody_shifts';
type ReadTarget =
  | { kind: 'list'; collection: ListCollection | 'transactions' }
  | { kind: 'get' | 'query'; collection: AccountingCollection };

function isAccountingCollection(
  collection: string | undefined,
): collection is AccountingCollection {
  return collection === 'orders' || collection === 'custody_shifts';
}

function isCatalogCollection(
  collection: string | undefined,
): collection is 'items' | 'optionGroups' {
  return collection === 'items' || collection === 'optionGroups';
}

function appendMask(url: URL, fields: readonly string[]): void {
  for (const field of fields) {
    url.searchParams.append(MASK_FIELD_PATHS, field);
  }
}

export function firestoreListUrl(
  collection: ListCollection,
  query: ListQuery,
): string {
  // An allowlisted name only. URL construction would resolve `items/../orders`
  // into a permitted orders list before the path check could see the traversal.
  if (!isAccountingCollection(collection) && !isCatalogCollection(collection)) {
    throw new Error('Firestore read refused');
  }
  const url = new URL(`${ORIGIN}${DOCUMENT_PATH}/${collection}`);
  url.searchParams.set('pageSize', String(query.pageSize));
  if (query.pageToken !== undefined) {
    url.searchParams.set('pageToken', query.pageToken);
  }
  if (query.orderBy !== undefined) {
    url.searchParams.set('orderBy', query.orderBy);
  }
  appendMask(url, FIRESTORE_FIELD_PATHS[collection]);
  const text = url.toString();
  assertFirestoreReadAllowed('GET', text);
  return text;
}

export function firestoreGetUrl(
  collection: AccountingCollection,
  id: string,
): string {
  if (!isAccountingCollection(collection) || !isSafeDocumentId(id)) {
    throw new Error('Firestore read refused');
  }
  const url = new URL(
    `${ORIGIN}${DOCUMENT_PATH}/${collection}/${encodeURIComponent(id)}`,
  );
  appendMask(url, FIRESTORE_FIELD_PATHS[collection]);
  const text = url.toString();
  assertFirestoreReadAllowed('GET', text);
  return text;
}

export function firestoreRunQueryUrl(): string {
  return `${ORIGIN}${RUN_QUERY_PATH}`;
}

export function firestoreTransactionsUrl(
  shiftId: string,
  query: TransactionListQuery,
): string {
  if (!isSafeDocumentId(shiftId)) {
    throw new Error('Firestore read refused');
  }
  const url = new URL(
    `${ORIGIN}${DOCUMENT_PATH}/custody_shifts/${encodeURIComponent(shiftId)}/transactions`,
  );
  url.searchParams.set('pageSize', String(query.pageSize));
  if (query.pageToken !== undefined) {
    url.searchParams.set('pageToken', query.pageToken);
  }
  appendMask(url, TRANSACTION_FIELD_PATHS);
  const text = url.toString();
  assertFirestoreReadAllowed('GET', text);
  return text;
}

export function assertFirestoreReadAllowed(
  method: string,
  url: string,
  body?: unknown,
): void {
  firestoreReadTarget(method, url, body);
}

function firestoreReadTarget(
  method: string,
  url: string,
  body?: unknown,
): ReadTarget {
  const verb = method.trim().toUpperCase();
  if (verb !== 'GET' && verb !== 'POST') {
    throw new Error('Firestore read refused');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Firestore read refused');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new Error('Firestore read refused');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'firestore.googleapis.com'
  ) {
    throw new Error('Firestore read refused');
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new Error('Firestore read refused');
  }
  // Refuse dot-segment or backslash traversal even when URL normalization
  // resolves to an allowed collection path (e.g. /items/../optionGroups or
  // authority backslashes).
  const rawPathMatch = /^https:\/\/[^/?#\\\s]+(\/[^?#\\]*)(?:[?#]|$)/i.exec(
    url,
  );
  if (rawPathMatch === null || rawPathMatch[1] !== parsed.pathname) {
    throw new Error('Firestore read refused');
  }
  if (verb === 'POST') {
    if (parsed.pathname !== RUN_QUERY_PATH || parsed.search !== '') {
      throw new Error('Firestore read refused');
    }
    return { kind: 'query', collection: assertRunQueryBody(body) };
  }
  if (parsed.pathname.includes(':')) {
    throw new Error('Firestore read refused');
  }
  if (!parsed.pathname.startsWith(`${DOCUMENT_PATH}/`)) {
    throw new Error('Firestore read refused');
  }
  const segments = parsed.pathname.slice(DOCUMENT_PATH.length + 1).split('/');
  const collection = segments[0];
  if (segments.length === 1) {
    // List only: top-level catalog collections `items` and `optionGroups`.
    // Single-document GETs, subcollections, orderBy, and runQuery stay refused.
    if (isAccountingCollection(collection) || isCatalogCollection(collection)) {
      assertListParams(
        parsed.searchParams,
        collection,
        isAccountingCollection(collection),
      );
      return { kind: 'list', collection };
    }
    throw new Error('Firestore read refused');
  }
  if (segments.length === 2) {
    const id = segments[1];
    if (
      !isAccountingCollection(collection) ||
      id === undefined ||
      !isSafeDocumentId(id) ||
      [...parsed.searchParams.keys()].some((key) => key !== MASK_FIELD_PATHS)
    ) {
      throw new Error('Firestore read refused');
    }
    assertMask(parsed.searchParams, collection);
    return { kind: 'get', collection };
  }
  // List only: custody_shifts/{shiftId}/transactions. A single transaction
  // document, any other subcollection, and anything deeper are refused.
  if (segments.length === 3) {
    const shiftId = segments[1];
    if (
      segments[0] !== 'custody_shifts' ||
      segments[2] !== 'transactions' ||
      shiftId === undefined ||
      !isSafeDocumentId(shiftId)
    ) {
      throw new Error('Firestore read refused');
    }
    assertListParams(parsed.searchParams, 'transactions', false);
    return { kind: 'list', collection: 'transactions' };
  }
  throw new Error('Firestore read refused');
}

function assertMask(
  params: URLSearchParams,
  collection: ReadTarget['collection'],
): void {
  if (
    !matchesProjection(
      params.getAll(MASK_FIELD_PATHS),
      FIRESTORE_FIELD_PATHS[collection],
    )
  ) {
    throw new Error('Firestore read refused');
  }
}

function assertListParams(
  params: URLSearchParams,
  collection: ReadTarget['collection'],
  allowOrderBy: boolean,
): void {
  for (const key of params.keys()) {
    if (
      key !== 'pageSize' &&
      key !== 'pageToken' &&
      key !== MASK_FIELD_PATHS &&
      !(allowOrderBy && key === 'orderBy')
    ) {
      throw new Error('Firestore read refused');
    }
  }
  assertPageSize(params);
  assertPageToken(params);
  assertMask(params, collection);
  const orderBy = params.getAll('orderBy');
  const direction = orderBy[0];
  if (
    orderBy.length > 1 ||
    (direction !== undefined &&
      direction !== 'opening_time' &&
      direction !== 'opening_time asc' &&
      direction !== 'opening_time desc')
  ) {
    throw new Error('Firestore read refused');
  }
}

function assertPageSize(params: URLSearchParams): void {
  const pageSizes = params.getAll('pageSize');
  const pageSize = pageSizes[0];
  if (
    pageSizes.length !== 1 ||
    pageSize === undefined ||
    !/^[1-9]\d*$/.test(pageSize) ||
    Number(pageSize) > 300
  ) {
    throw new Error('Firestore read refused');
  }
}

function assertPageToken(params: URLSearchParams): void {
  const tokens = params.getAll('pageToken');
  const token = tokens[0];
  if (
    tokens.length > 1 ||
    (tokens.length === 1 && (token === undefined || token.length === 0))
  ) {
    throw new Error('Firestore read refused');
  }
}

function isOneElement(value: unknown): value is readonly [unknown] {
  return Array.isArray(value) && value.length === 1;
}

function assertRunQueryBody(body: unknown): AccountingCollection {
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    !isRecord(body.structuredQuery)
  ) {
    throw new Error('Firestore read refused');
  }
  const query = body.structuredQuery;
  for (const key of Object.keys(query)) {
    if (
      key !== 'from' &&
      key !== 'where' &&
      key !== 'limit' &&
      key !== 'select'
    ) {
      throw new Error('Firestore read refused');
    }
  }
  if (!isOneElement(query.from)) {
    throw new Error('Firestore read refused');
  }
  const from = query.from[0];
  if (
    !isRecord(from) ||
    Object.keys(from).length !== 1 ||
    typeof from.collectionId !== 'string' ||
    !isAccountingCollection(from.collectionId)
  ) {
    throw new Error('Firestore read refused');
  }
  assertQueryProjection(query.select, from.collectionId);
  if (query.where !== undefined) {
    assertFilter(query.where);
  }
  if (
    typeof query.limit !== 'number' ||
    !Number.isInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 2000
  ) {
    throw new Error('Firestore read refused');
  }
  return from.collectionId;
}

function assertQueryProjection(
  projection: unknown,
  collection: AccountingCollection,
): void {
  if (
    !isRecord(projection) ||
    Object.keys(projection).length !== 1 ||
    !Object.hasOwn(projection, 'fields') ||
    !Array.isArray(projection.fields)
  ) {
    throw new Error('Firestore read refused');
  }
  const fieldPaths = projection.fields.map((field: unknown) =>
    isRecord(field) &&
    Object.keys(field).length === 1 &&
    Object.hasOwn(field, 'fieldPath')
      ? field.fieldPath
      : undefined,
  );
  if (!matchesProjection(fieldPaths, FIRESTORE_FIELD_PATHS[collection])) {
    throw new Error('Firestore read refused');
  }
}

function assertFilter(filter: unknown): void {
  if (!isRecord(filter) || Object.keys(filter).length !== 1) {
    throw new Error('Firestore read refused');
  }
  if (isRecord(filter.fieldFilter) && Object.keys(filter).length === 1) {
    assertFieldFilter(filter.fieldFilter);
    return;
  }
  if (isRecord(filter.compositeFilter)) {
    assertComposite(filter.compositeFilter);
    return;
  }
  throw new Error('Firestore read refused');
}

function assertFieldFilter(filter: Record<string, unknown>): void {
  const keys = Object.keys(filter);
  if (
    keys.length !== 3 ||
    !keys.includes('field') ||
    !keys.includes('op') ||
    !keys.includes('value')
  ) {
    throw new Error('Firestore read refused');
  }
  if (!isRecord(filter.field) || Object.keys(filter.field).length !== 1) {
    throw new Error('Firestore read refused');
  }
  if (
    typeof filter.field.fieldPath !== 'string' ||
    !FIELD_PATHS.has(filter.field.fieldPath)
  ) {
    throw new Error('Firestore read refused');
  }
  if (typeof filter.op !== 'string' || !FILTER_OPS.has(filter.op)) {
    throw new Error('Firestore read refused');
  }
  assertQueryValue(filter.value);
}

function assertComposite(filter: Record<string, unknown>): void {
  if (
    filter.op !== 'AND' ||
    !Array.isArray(filter.filters) ||
    Object.keys(filter).length !== 2
  ) {
    throw new Error('Firestore read refused');
  }
  if (filter.filters.length === 0) {
    throw new Error('Firestore read refused');
  }
  for (const entry of filter.filters) {
    assertFilter(entry);
  }
}

function assertQueryValue(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new Error('Firestore read refused');
  }
  const kind = Object.keys(value)[0];
  if (kind === undefined || !VALUE_KINDS.has(kind)) {
    throw new Error('Firestore read refused');
  }
  if (kind === 'stringValue' || kind === 'timestampValue') {
    if (typeof value[kind] !== 'string') {
      throw new Error('Firestore read refused');
    }
    return;
  }
  if (kind === 'integerValue') {
    if (
      typeof value.integerValue !== 'string' ||
      !/^-?\d+$/.test(value.integerValue)
    ) {
      throw new Error('Firestore read refused');
    }
    return;
  }
  if (kind === 'doubleValue') {
    if (
      typeof value.doubleValue !== 'number' ||
      !Number.isFinite(value.doubleValue)
    ) {
      throw new Error('Firestore read refused');
    }
    return;
  }
  if (kind === 'booleanValue') {
    if (typeof value.booleanValue !== 'boolean') {
      throw new Error('Firestore read refused');
    }
    return;
  }
  if (kind === 'nullValue') {
    return;
  }
  if (!isRecord(value.arrayValue)) {
    throw new Error('Firestore read refused');
  }
  const values = value.arrayValue.values;
  if (values === undefined) {
    return;
  }
  if (
    !Array.isArray(values) ||
    Object.keys(value.arrayValue).some((key) => key !== 'values')
  ) {
    throw new Error('Firestore read refused');
  }
  for (const entry of values) {
    assertQueryValue(entry);
  }
}

// ListDocumentsResponse has only these keys; an empty page is `{}`.
const LIST_KEYS = new Set(['documents', 'nextPageToken']);

export function parseListResponse(
  payload: unknown,
  expected: PosCollection | 'transactions',
): ListPage {
  if (!isRecord(payload)) {
    throw new Error('Firestore read failed: invalid response');
  }
  for (const key of Object.keys(payload)) {
    if (!LIST_KEYS.has(key)) {
      throw new Error('Firestore read failed: invalid response');
    }
  }
  const documents: FirestoreRestDocument[] = [];
  if (payload.documents !== undefined) {
    if (!Array.isArray(payload.documents)) {
      throw new Error('Firestore read failed: invalid response');
    }
    for (const entry of payload.documents) {
      documents.push(requireDocument(entry, expected));
    }
  }
  if (
    payload.nextPageToken !== undefined &&
    typeof payload.nextPageToken !== 'string'
  ) {
    throw new Error('Firestore read failed: invalid response');
  }
  const nextPageToken =
    typeof payload.nextPageToken === 'string' &&
    payload.nextPageToken.length > 0
      ? payload.nextPageToken
      : undefined;
  return { documents, nextPageToken };
}

const RUN_QUERY_KEYS = new Set([
  'document',
  'readTime',
  'transaction',
  'skippedResults',
  'done',
  'explainMetrics',
]);

export function parseRunQueryResponse(
  payload: unknown,
  expected: 'orders' | 'custody_shifts',
): FirestoreRestDocument[] {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Firestore read failed: invalid response');
  }
  const documents: FirestoreRestDocument[] = [];
  for (const entry of payload) {
    documents.push(...readRunQueryEntry(entry, expected));
  }
  return documents;
}

function readRunQueryEntry(
  entry: unknown,
  expected: 'orders' | 'custody_shifts',
): FirestoreRestDocument[] {
  if (!isRecord(entry)) {
    throw new Error('Firestore read failed: invalid response');
  }
  for (const key of Object.keys(entry)) {
    if (!RUN_QUERY_KEYS.has(key)) {
      throw new Error('Firestore read failed: invalid response');
    }
  }
  if ('readTime' in entry && !isRfc3339(entry.readTime)) {
    throw new Error('Firestore read failed: invalid response');
  }
  if ('transaction' in entry && typeof entry.transaction !== 'string') {
    throw new Error('Firestore read failed: invalid response');
  }
  if ('done' in entry && typeof entry.done !== 'boolean') {
    throw new Error('Firestore read failed: invalid response');
  }
  if ('explainMetrics' in entry && !isRecord(entry.explainMetrics)) {
    throw new Error('Firestore read failed: invalid response');
  }
  if ('skippedResults' in entry) {
    const skipped = entry.skippedResults;
    if (
      typeof skipped !== 'number' ||
      !Number.isInteger(skipped) ||
      skipped < 0
    ) {
      throw new Error('Firestore read failed: invalid response');
    }
    if (skipped > 0) {
      throw new Error('Firestore read failed: invalid response');
    }
  }
  if ('document' in entry) {
    return [requireDocument(entry.document, expected)];
  }
  if (!isRfc3339(entry.readTime)) {
    throw new Error('Firestore read failed: invalid response');
  }
  return [];
}

function isRfc3339(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (match === null) {
    return false;
  }
  const date = match[1];
  const time = match[2];
  const fraction = match[4] ?? '';
  const offset = match[5];
  if (date === undefined || time === undefined || offset === undefined) {
    return false;
  }
  const millis = fraction.slice(0, 3).padEnd(3, '0');
  return Number.isFinite(Date.parse(`${date}T${time}.${millis}${offset}`));
}

function assertKnownDocumentName(name: string): PosCollection | 'transactions' {
  const rest = name.startsWith(
    'projects/thesharkrestaurant/databases/(default)/documents/',
  )
    ? name.slice(
        'projects/thesharkrestaurant/databases/(default)/documents/'.length,
      )
    : '';
  const depth = rest === '' ? 0 : rest.split('/').length;
  if (depth === 4) {
    splitTransactionName(name);
    return 'transactions';
  }
  return splitDocumentName(name).collection;
}

function catalogEnvelopeMalformed(value: Record<string, unknown>): boolean {
  return (
    (value.updateTime !== undefined && typeof value.updateTime !== 'string') ||
    (value.fields !== undefined && !isRecord(value.fields))
  );
}

function requireDocument(
  value: unknown,
  expected: PosCollection | 'transactions',
): FirestoreRestDocument {
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw new Error('Firestore read failed: invalid response');
  }
  let collection: PosCollection | 'transactions';
  try {
    collection = assertKnownDocumentName(value.name);
  } catch {
    throw new Error('Firestore read failed: invalid response');
  }
  if (collection !== expected) {
    throw new Error('Firestore read failed: invalid response');
  }
  // Scan the raw catalog document (including any extra envelope properties)
  // before projection so customer-shaped keys cannot be stripped silently.
  // A valid catalog id with a bad updateTime or fields type is a rejected
  // presence entry (id only). An unsafe id already threw above.
  if (
    (collection === 'items' || collection === 'optionGroups') &&
    (hasCustomerShapedSchemaKey(value, collection) ||
      catalogEnvelopeMalformed(value))
  ) {
    return { name: value.name, rejected: true };
  }
  const document: FirestoreRestDocument = { name: value.name };
  if (value.updateTime !== undefined) {
    if (typeof value.updateTime !== 'string') {
      throw new Error('Firestore read failed: invalid response');
    }
    document.updateTime = value.updateTime;
  }
  if (value.fields !== undefined) {
    if (!isRecord(value.fields)) {
      throw new Error('Firestore read failed: invalid response');
    }
    document.fields = value.fields;
  }
  return document;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function googleFetch(
  input: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}

function snapshotJson(body: unknown): { serialized: string; value: unknown } {
  try {
    const text = JSON.stringify(body);
    if (typeof text !== 'string') {
      throw new Error('Firestore read refused');
    }
    return { serialized: text, value: JSON.parse(text) as unknown };
  } catch {
    throw new Error('Firestore read refused');
  }
}

function assertResponseProjection(payload: unknown, target: ReadTarget): void {
  const fields = FIRESTORE_FIELD_PATHS[target.collection];
  if (target.kind === 'get') {
    assertProjectedDocument(payload, fields);
  } else if (target.kind === 'list') {
    if (isRecord(payload) && Array.isArray(payload.documents)) {
      for (const document of payload.documents) {
        assertProjectedDocument(document, fields);
      }
    }
  } else if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (isRecord(entry)) {
        assertProjectedDocument(entry.document, fields);
      }
    }
  }
}

async function readFirestoreResponse(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  requestBody: string | undefined,
  fetchImpl: FetchLike,
  target: ReadTarget,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: requestBody,
    });
  } catch {
    throw new Error('Firestore read failed: network');
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The status is enough. Never surface the body.
    }
    throw new Error(`Firestore read failed: HTTP ${response.status}`);
  }
  try {
    const text = await response.text();
    if (
      target.collection === 'transactions' &&
      !transactionResponseKeysAllowed(text)
    ) {
      throw new Error('Firestore read failed: invalid response');
    }
    const payload: unknown = JSON.parse(text);
    assertResponseProjection(payload, target);
    return payload;
  } catch {
    throw new Error('Firestore read failed: invalid response');
  }
}

export async function firestoreFetch(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body: unknown,
  fetchImpl: FetchLike = googleFetch,
): Promise<unknown> {
  const snapshot = method === 'POST' ? snapshotJson(body) : undefined;
  const target = firestoreReadTarget(method, url, snapshot?.value);
  return readFirestoreResponse(
    method,
    url,
    token,
    snapshot?.serialized,
    fetchImpl,
    target,
  );
}

export function createPosFirestore(
  token: string,
  fetchImpl: FetchLike = googleFetch,
): PosFirestore {
  return {
    async list(collection, query) {
      const payload = await firestoreFetch(
        'GET',
        firestoreListUrl(collection, query),
        token,
        undefined,
        fetchImpl,
      );
      return parseListResponse(payload, collection);
    },
    async listShiftTransactions(shiftId, query) {
      const payload = await firestoreFetch(
        'GET',
        firestoreTransactionsUrl(shiftId, query),
        token,
        undefined,
        fetchImpl,
      );
      const page = parseListResponse(payload, 'transactions');
      for (const document of page.documents) {
        if (splitTransactionName(document.name).shiftId !== shiftId) {
          throw new Error('Firestore read failed: invalid response');
        }
      }
      return page;
    },
    async getShift(id) {
      try {
        const payload = await firestoreFetch(
          'GET',
          firestoreGetUrl('custody_shifts', id),
          token,
          undefined,
          fetchImpl,
        );
        return requireDocument(payload, 'custody_shifts');
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Firestore read failed: HTTP 404'
        ) {
          return null;
        }
        throw error;
      }
    },
    async queryOrders(body) {
      const snapshot = snapshotJson(body);
      const url = firestoreRunQueryUrl();
      const target = firestoreReadTarget('POST', url, snapshot.value);
      if (target.kind !== 'query') {
        throw new Error('Firestore read refused');
      }
      const payload = await readFirestoreResponse(
        'POST',
        url,
        token,
        snapshot.serialized,
        fetchImpl,
        target,
      );
      return parseRunQueryResponse(payload, target.collection);
    },
  };
}
