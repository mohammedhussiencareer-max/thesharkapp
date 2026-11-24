import { PosSyncError } from './safe-error.ts';
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
} from './firestore-projection.ts';
import type {
  FirestoreRestDocument,
  ListCollection,
  ListPage,
  ListQuery,
  PosFirestore,
  TransactionListQuery,
} from './pos-firestore.ts';
import { readTransactionResponse } from './transaction-response.ts';

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
  | { kind: 'get'; collection: AccountingCollection }
  | { kind: 'query'; collection: AccountingCollection; probe: boolean };

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
    throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreReadRefused');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'firestore.googleapis.com'
  ) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new PosSyncError('firestoreReadRefused');
  }
  // Refuse dot-segment or backslash traversal even when URL normalization
  // resolves to an allowed collection path (e.g. /items/../optionGroups or
  // authority backslashes).
  const rawPathMatch = /^https:\/\/[^/?#\\\s]+(\/[^?#\\]*)(?:[?#]|$)/i.exec(
    url,
  );
  if (rawPathMatch === null || rawPathMatch[1] !== parsed.pathname) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (verb === 'POST') {
    if (parsed.pathname !== RUN_QUERY_PATH || parsed.search !== '') {
      throw new PosSyncError('firestoreReadRefused');
    }
    return assertRunQueryBody(body);
  }
  if (parsed.pathname.includes(':')) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (!parsed.pathname.startsWith(`${DOCUMENT_PATH}/`)) {
    throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreReadRefused');
  }
  if (segments.length === 2) {
    const id = segments[1];
    if (
      !isAccountingCollection(collection) ||
      id === undefined ||
      !isSafeDocumentId(id) ||
      [...parsed.searchParams.keys()].some((key) => key !== MASK_FIELD_PATHS)
    ) {
      throw new PosSyncError('firestoreReadRefused');
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
      throw new PosSyncError('firestoreReadRefused');
    }
    assertListParams(parsed.searchParams, 'transactions', false);
    return { kind: 'list', collection: 'transactions' };
  }
  throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreReadRefused');
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
      throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreReadRefused');
  }
}

function assertPageToken(params: URLSearchParams): void {
  const tokens = params.getAll('pageToken');
  const token = tokens[0];
  if (
    tokens.length > 1 ||
    (tokens.length === 1 && (token === undefined || token.length === 0))
  ) {
    throw new PosSyncError('firestoreReadRefused');
  }
}

function isOneElement(value: unknown): value is readonly [unknown] {
  return Array.isArray(value) && value.length === 1;
}

function assertRunQueryBody(
  body: unknown,
): Extract<ReadTarget, { kind: 'query' }> {
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    !isRecord(body.structuredQuery)
  ) {
    throw new PosSyncError('firestoreReadRefused');
  }
  const query = body.structuredQuery;
  for (const key of Object.keys(query)) {
    if (
      key !== 'from' &&
      key !== 'where' &&
      key !== 'limit' &&
      key !== 'select'
    ) {
      throw new PosSyncError('firestoreReadRefused');
    }
  }
  if (!isOneElement(query.from)) {
    throw new PosSyncError('firestoreReadRefused');
  }
  const from = query.from[0];
  if (
    !isRecord(from) ||
    Object.keys(from).length !== 1 ||
    typeof from.collectionId !== 'string' ||
    !isAccountingCollection(from.collectionId)
  ) {
    throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreReadRefused');
  }
  const probe = from.collectionId === 'orders' && isTimestampProbe(query);
  assertQueryProjection(
    query.select,
    probe ? ['__name__'] : FIRESTORE_FIELD_PATHS[from.collectionId],
  );
  return { kind: 'query', collection: from.collectionId, probe };
}

// The order existence check is the single lower-bound query with limit 1.
function isTimestampProbe(query: Record<string, unknown>): boolean {
  if (
    query.limit !== 1 ||
    !isRecord(query.where) ||
    !isRecord(query.where.fieldFilter)
  ) {
    return false;
  }
  const filter = query.where.fieldFilter;
  return (
    isRecord(filter.field) &&
    filter.field.fieldPath === 'timestamp' &&
    filter.op === 'GREATER_THAN_OR_EQUAL' &&
    isRecord(filter.value) &&
    typeof filter.value.timestampValue === 'string'
  );
}

function assertQueryProjection(
  projection: unknown,
  expected: readonly string[],
): void {
  if (
    !isRecord(projection) ||
    Object.keys(projection).length !== 1 ||
    !Object.hasOwn(projection, 'fields') ||
    !Array.isArray(projection.fields)
  ) {
    throw new PosSyncError('firestoreReadRefused');
  }
  const fieldPaths = projection.fields.map((field: unknown) =>
    isRecord(field) &&
    Object.keys(field).length === 1 &&
    Object.hasOwn(field, 'fieldPath')
      ? field.fieldPath
      : undefined,
  );
  if (!matchesProjection(fieldPaths, expected)) {
    throw new PosSyncError('firestoreReadRefused');
  }
}

function assertFilter(filter: unknown): void {
  if (!isRecord(filter) || Object.keys(filter).length !== 1) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (isRecord(filter.fieldFilter) && Object.keys(filter).length === 1) {
    assertFieldFilter(filter.fieldFilter);
    return;
  }
  if (isRecord(filter.compositeFilter)) {
    assertComposite(filter.compositeFilter);
    return;
  }
  throw new PosSyncError('firestoreReadRefused');
}

function assertFieldFilter(filter: Record<string, unknown>): void {
  const keys = Object.keys(filter);
  if (
    keys.length !== 3 ||
    !keys.includes('field') ||
    !keys.includes('op') ||
    !keys.includes('value')
  ) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (!isRecord(filter.field) || Object.keys(filter.field).length !== 1) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (
    typeof filter.field.fieldPath !== 'string' ||
    !FIELD_PATHS.has(filter.field.fieldPath)
  ) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (typeof filter.op !== 'string' || !FILTER_OPS.has(filter.op)) {
    throw new PosSyncError('firestoreReadRefused');
  }
  assertQueryValue(filter.value);
}

function assertComposite(filter: Record<string, unknown>): void {
  if (
    filter.op !== 'AND' ||
    !Array.isArray(filter.filters) ||
    Object.keys(filter).length !== 2
  ) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (filter.filters.length === 0) {
    throw new PosSyncError('firestoreReadRefused');
  }
  for (const entry of filter.filters) {
    assertFilter(entry);
  }
}

function assertQueryValue(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new PosSyncError('firestoreReadRefused');
  }
  const kind = Object.keys(value)[0];
  if (kind === undefined || !VALUE_KINDS.has(kind)) {
    throw new PosSyncError('firestoreReadRefused');
  }
  if (kind === 'stringValue' || kind === 'timestampValue') {
    if (typeof value[kind] !== 'string') {
      throw new PosSyncError('firestoreReadRefused');
    }
    return;
  }
  if (kind === 'integerValue') {
    if (
      typeof value.integerValue !== 'string' ||
      !/^-?\d+$/.test(value.integerValue)
    ) {
      throw new PosSyncError('firestoreReadRefused');
    }
    return;
  }
  if (kind === 'doubleValue') {
    if (
      typeof value.doubleValue !== 'number' ||
      !Number.isFinite(value.doubleValue)
    ) {
      throw new PosSyncError('firestoreReadRefused');
    }
    return;
  }
  if (kind === 'booleanValue') {
    if (typeof value.booleanValue !== 'boolean') {
      throw new PosSyncError('firestoreReadRefused');
    }
    return;
  }
  if (kind === 'nullValue') {
    return;
  }
  if (!isRecord(value.arrayValue)) {
    throw new PosSyncError('firestoreReadRefused');
  }
  const values = value.arrayValue.values;
  if (values === undefined) {
    return;
  }
  if (
    !Array.isArray(values) ||
    Object.keys(value.arrayValue).some((key) => key !== 'values')
  ) {
    throw new PosSyncError('firestoreReadRefused');
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
    throw new PosSyncError('firestoreInvalidResponse');
  }
  for (const key of Object.keys(payload)) {
    if (!LIST_KEYS.has(key)) {
      throw new PosSyncError('firestoreInvalidResponse');
    }
  }
  const documents: FirestoreRestDocument[] = [];
  if (payload.documents !== undefined) {
    if (!Array.isArray(payload.documents)) {
      throw new PosSyncError('firestoreInvalidResponse');
    }
    for (const entry of payload.documents) {
      documents.push(requireDocument(entry, expected));
    }
  }
  if (
    payload.nextPageToken !== undefined &&
    typeof payload.nextPageToken !== 'string'
  ) {
    throw new PosSyncError('firestoreInvalidResponse');
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
const DOCUMENT_ENVELOPE_KEYS = new Set([
  'name',
  'fields',
  'createTime',
  'updateTime',
]);

export function parseRunQueryResponse(
  payload: unknown,
  expected: 'orders' | 'custody_shifts',
): FirestoreRestDocument[] {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new PosSyncError('firestoreInvalidResponse');
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
    throw new PosSyncError('firestoreInvalidResponse');
  }
  for (const key of Object.keys(entry)) {
    if (!RUN_QUERY_KEYS.has(key)) {
      throw new PosSyncError('firestoreInvalidResponse');
    }
  }
  if ('readTime' in entry && !isRfc3339(entry.readTime)) {
    throw new PosSyncError('firestoreInvalidResponse');
  }
  if ('transaction' in entry && typeof entry.transaction !== 'string') {
    throw new PosSyncError('firestoreInvalidResponse');
  }
  if ('done' in entry && typeof entry.done !== 'boolean') {
    throw new PosSyncError('firestoreInvalidResponse');
  }
  if ('explainMetrics' in entry && !isRecord(entry.explainMetrics)) {
    throw new PosSyncError('firestoreInvalidResponse');
  }
  if ('skippedResults' in entry) {
    const skipped = entry.skippedResults;
    if (
      typeof skipped !== 'number' ||
      !Number.isInteger(skipped) ||
      skipped < 0
    ) {
      throw new PosSyncError('firestoreInvalidResponse');
    }
    if (skipped > 0) {
      throw new PosSyncError('firestoreInvalidResponse');
    }
  }
  if ('document' in entry) {
    return [requireDocument(entry.document, expected)];
  }
  if (!isRfc3339(entry.readTime)) {
    throw new PosSyncError('firestoreInvalidResponse');
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

function assertAccountingDocumentEnvelope(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    Object.keys(value).some((key) => !DOCUMENT_ENVELOPE_KEYS.has(key)) ||
    (value.createTime !== undefined && typeof value.createTime !== 'string') ||
    (value.updateTime !== undefined && typeof value.updateTime !== 'string') ||
    (value.fields !== undefined && !isRecord(value.fields))
  ) {
    throw new PosSyncError('firestoreInvalidResponse');
  }
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
  catalogProjection?: readonly string[],
): FirestoreRestDocument {
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw new PosSyncError('firestoreInvalidResponse');
  }
  let collection: PosCollection | 'transactions';
  try {
    collection = assertKnownDocumentName(value.name);
  } catch (error) {
    throw new PosSyncError('firestoreInvalidResponse', {
      cause: error,
    });
  }
  if (collection !== expected) {
    throw new PosSyncError('firestoreInvalidResponse');
  }
  if (isCatalogCollection(collection)) {
    // Keep rejection rows for safe ids only, including projection failures.
    if (value.rejected === true || catalogEnvelopeMalformed(value)) {
      return { name: value.name, rejected: true };
    }
    if (catalogProjection !== undefined) {
      try {
        assertProjectedDocument(value, catalogProjection);
      } catch {
        return { name: value.name, rejected: true };
      }
    }
    if (hasCustomerShapedSchemaKey(value, collection)) {
      return { name: value.name, rejected: true };
    }
  } else {
    assertAccountingDocumentEnvelope(value);
  }
  const document: FirestoreRestDocument = { name: value.name };
  if (value.updateTime !== undefined) {
    if (typeof value.updateTime !== 'string') {
      throw new PosSyncError('firestoreInvalidResponse');
    }
    document.updateTime = value.updateTime;
  }
  if (value.fields !== undefined) {
    if (!isRecord(value.fields)) {
      throw new PosSyncError('firestoreInvalidResponse');
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
    if (typeof text === 'string') {
      return { serialized: text, value: JSON.parse(text) as unknown };
    }
  } catch (error) {
    throw new PosSyncError('firestoreReadRefused', { cause: error });
  }
  throw new PosSyncError('firestoreReadRefused');
}

function assertResponseProjection(payload: unknown, target: ReadTarget): void {
  const fields = FIRESTORE_FIELD_PATHS[target.collection];
  if (target.kind === 'get') {
    assertAccountingDocumentEnvelope(payload);
    assertProjectedDocument(payload, fields);
  } else if (target.kind === 'list') {
    if (isRecord(payload) && Array.isArray(payload.documents)) {
      const collection = target.collection;
      if (isCatalogCollection(collection)) {
        payload.documents = payload.documents.map((document: unknown) =>
          requireDocument(document, collection, fields),
        );
      } else {
        for (const document of payload.documents) {
          assertAccountingDocumentEnvelope(document);
          assertProjectedDocument(document, fields);
        }
      }
    }
  } else if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (isRecord(entry) && 'document' in entry) {
        assertAccountingDocumentEnvelope(entry.document);
        assertProjectedDocument(entry.document, target.probe ? [] : fields);
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
    throw new PosSyncError('firestoreNetwork');
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The status is enough. Never surface the body.
    }
    throw new PosSyncError('firestoreHttp', response.status);
  }
  try {
    const payload: unknown =
      target.collection === 'transactions'
        ? await readTransactionResponse(response)
        : JSON.parse(await response.text());
    assertResponseProjection(payload, target);
    return payload;
  } catch {
    throw new PosSyncError('firestoreInvalidResponse');
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
          throw new PosSyncError('firestoreInvalidResponse');
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
        if (PosSyncError.hasHttpStatus(error, 404)) {
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
        throw new PosSyncError('firestoreReadRefused');
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
