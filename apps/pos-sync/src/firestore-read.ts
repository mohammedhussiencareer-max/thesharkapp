import { isRecord, isSafeDocumentId, splitDocumentName } from './decode.ts';
import type {
  FirestoreRestDocument,
  ListPage,
  ListQuery,
  PosFirestore,
} from './pos-firestore.ts';

const ORIGIN = 'https://firestore.googleapis.com';
const DOCUMENT_PATH =
  '/v1/projects/thesharkrestaurant/databases/(default)/documents';
const RUN_QUERY_PATH = `${DOCUMENT_PATH}:runQuery`;

const COLLECTIONS = new Set(['orders', 'custody_shifts']);
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

export function firestoreListUrl(
  collection: 'orders' | 'custody_shifts',
  query: ListQuery,
): string {
  const url = new URL(`${ORIGIN}${DOCUMENT_PATH}/${collection}`);
  url.searchParams.set('pageSize', String(query.pageSize));
  if (query.pageToken !== undefined) {
    url.searchParams.set('pageToken', query.pageToken);
  }
  if (query.orderBy !== undefined) {
    url.searchParams.set('orderBy', query.orderBy);
  }
  const text = url.toString();
  assertFirestoreReadAllowed('GET', text);
  return text;
}

export function firestoreGetUrl(
  collection: 'orders' | 'custody_shifts',
  id: string,
): string {
  if (!isSafeDocumentId(id)) {
    throw new Error('Firestore read refused');
  }
  const text = `${ORIGIN}${DOCUMENT_PATH}/${collection}/${encodeURIComponent(id)}`;
  assertFirestoreReadAllowed('GET', text);
  return text;
}

export function firestoreRunQueryUrl(): string {
  return `${ORIGIN}${RUN_QUERY_PATH}`;
}

export function assertFirestoreReadAllowed(
  method: string,
  url: string,
  body?: unknown,
): void {
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
  if (verb === 'POST') {
    if (parsed.pathname !== RUN_QUERY_PATH || parsed.search !== '') {
      throw new Error('Firestore read refused');
    }
    assertRunQueryBody(body);
    return;
  }
  if (parsed.pathname.includes(':')) {
    throw new Error('Firestore read refused');
  }
  if (!parsed.pathname.startsWith(`${DOCUMENT_PATH}/`)) {
    throw new Error('Firestore read refused');
  }
  const segments = parsed.pathname.slice(DOCUMENT_PATH.length + 1).split('/');
  if (segments.length === 1) {
    assertCollection(segments[0]);
    assertListParams(parsed.searchParams);
    return;
  }
  if (segments.length === 2) {
    assertCollection(segments[0]);
    const id = segments[1];
    if (id === undefined || !isSafeDocumentId(id) || parsed.search !== '') {
      throw new Error('Firestore read refused');
    }
    return;
  }
  throw new Error('Firestore read refused');
}

function assertCollection(collection: string | undefined): void {
  if (collection === undefined || !COLLECTIONS.has(collection)) {
    throw new Error('Firestore read refused');
  }
}

function assertListParams(params: URLSearchParams): void {
  for (const key of params.keys()) {
    if (key !== 'pageSize' && key !== 'pageToken' && key !== 'orderBy') {
      throw new Error('Firestore read refused');
    }
  }
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
  const orderBy = params.getAll('orderBy');
  if (orderBy.length > 1) {
    throw new Error('Firestore read refused');
  }
  const direction = orderBy[0];
  if (
    direction !== undefined &&
    direction !== 'opening_time' &&
    direction !== 'opening_time asc' &&
    direction !== 'opening_time desc'
  ) {
    throw new Error('Firestore read refused');
  }
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

function assertRunQueryBody(body: unknown): void {
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    !isRecord(body.structuredQuery)
  ) {
    throw new Error('Firestore read refused');
  }
  const query = body.structuredQuery;
  for (const key of Object.keys(query)) {
    if (key !== 'from' && key !== 'where' && key !== 'limit') {
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
    (from.collectionId !== 'orders' && from.collectionId !== 'custody_shifts')
  ) {
    throw new Error('Firestore read refused');
  }
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

export function parseListResponse(payload: unknown): ListPage {
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
      documents.push(requireDocument(entry));
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
): FirestoreRestDocument[] {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('Firestore read failed: invalid response');
  }
  const documents: FirestoreRestDocument[] = [];
  for (const entry of payload) {
    documents.push(...readRunQueryEntry(entry));
  }
  return documents;
}

function readRunQueryEntry(entry: unknown): FirestoreRestDocument[] {
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
    return [requireDocument(entry.document)];
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

function requireDocument(value: unknown): FirestoreRestDocument {
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw new Error('Firestore read failed: invalid response');
  }
  try {
    splitDocumentName(value.name);
  } catch (error) {
    throw new Error('Firestore read failed: invalid response', {
      cause: error,
    });
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

export async function firestoreFetch(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body: unknown,
  fetchImpl: FetchLike = googleFetch,
): Promise<unknown> {
  assertFirestoreReadAllowed(method, url, body);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Firestore read failed: network');
  }
  if (!response.ok) {
    try {
      await response.text();
    } catch {
      // The status is enough. Never surface the body.
    }
    throw new Error(`Firestore read failed: HTTP ${response.status}`);
  }
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    throw new Error('Firestore read failed: invalid response');
  }
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
      return parseListResponse(payload);
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
        return requireDocument(payload);
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
      const payload = await firestoreFetch(
        'POST',
        firestoreRunQueryUrl(),
        token,
        body,
        fetchImpl,
      );
      return parseRunQueryResponse(payload);
    },
  };
}
