import { readSupabaseEnv } from '@/lib/supabase';

/**
 * Reload pin phases for idempotent writers.
 *
 * - `inflight`: written to localStorage BEFORE sending the request. A reload
 *   while `inflight` restores as `unknown` and NEVER auto-sends.
 * - `unknown`: reply was lost or outcome did not prove absence. The owner
 *   must explicitly retry the exact same request id and payload.
 * - `waiting_for_sync`: server stored a count request awaiting a covering sync.
 * - `posted_reload`: write succeeded, waiting for the post-write read to
 *   succeed before unlocking. Never re-sends; clears only once a read succeeds.
 */
export type HeldWritePhase =
  'inflight' | 'unknown' | 'waiting_for_sync' | 'posted_reload';

/**
 * Extension point for future writers (e.g. `'sync'` in P7-6 and
 * `'count_closeout'` in P7-7). Existing writers store only request ids and the
 * minimal payload required to retry the exact request unchanged.
 */
export type HeldWriteKind =
  | 'action'
  | 'count'
  | 'count_stored'
  | 'purchase'
  | 'opening'
  | 'sort'
  | 'expense'
  | 'expense_void'
  | (string & {});

export type HeldWriteRecord<T = unknown> = {
  v: 1;
  subject: string;
  kind?: HeldWriteKind;
  requestId: string;
  payload: T;
  phase: HeldWritePhase;
  /**
   * Activation review reload pin: server confirmed `opening manifest changed`
   * (stored nothing), so the request id is kept but cannot send until a review
   * reload replaces the payload.
   */
  awaitingReviewReload?: boolean;
};

const KEY_PREFIX = 'theshark:held:v1:';
const FALLBACK_PROJECT = 'default';
const UNINITIALIZED_USER = '__local__';

const VALID_PHASES: ReadonlySet<string> = new Set<HeldWritePhase>([
  'inflight',
  'unknown',
  'waiting_for_sync',
  'posted_reload',
]);

type UserScopeState =
  | { mode: 'uninitialized' }
  | { mode: 'signed_out' }
  | { mode: 'active'; userId: string };

let userScope: UserScopeState = { mode: 'uninitialized' };
let hydratedScopeKey: string | null = null;
const records = new Map<string, HeldWriteRecord>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
    return null;
  } catch {
    return null;
  }
}

export function currentProjectUrl(): string {
  const url = readSupabaseEnv()?.url.trim();
  return url && url.length > 0 ? url : FALLBACK_PROJECT;
}

function activeUserId(): string | null {
  if (userScope.mode === 'signed_out') return null;
  if (userScope.mode === 'active') return userScope.userId;
  return UNINITIALIZED_USER;
}

export function userStoragePrefix(
  userId: string,
  projectUrl = currentProjectUrl(),
): string {
  return `${KEY_PREFIX}${encodeURIComponent(projectUrl)}:${encodeURIComponent(userId)}:`;
}

function entryStorageKey(
  subject: string,
  userId: string,
  projectUrl = currentProjectUrl(),
): string {
  return `${userStoragePrefix(userId, projectUrl)}${encodeURIComponent(subject)}`;
}

function safeSetItem(key: string, value: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Degrade safely to in-memory when storage throws (private mode, quota, iOS purge).
  }
}

function safeRemoveItem(key: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage removal errors.
  }
}

function safeListKeys(prefix: string): string[] {
  const storage = getStorage();
  if (!storage) return [];
  const matched: string[] = [];
  try {
    const count = storage.length;
    for (let index = 0; index < count; index += 1) {
      const key = storage.key(index);
      if (typeof key === 'string' && key.startsWith(prefix)) {
        matched.push(key);
      }
    }
  } catch {
    return [];
  }
  return matched;
}

function safeReadItem(key: string): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function parseRecord(raw: string): HeldWriteRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (row.v !== 1) return null;
  if (typeof row.subject !== 'string' || row.subject.length === 0) return null;
  if (typeof row.requestId !== 'string' || row.requestId.length === 0) {
    return null;
  }
  if (typeof row.phase !== 'string' || !VALID_PHASES.has(row.phase)) {
    return null;
  }
  const record: HeldWriteRecord = {
    v: 1,
    subject: row.subject,
    requestId: row.requestId,
    payload: row.payload,
    phase: row.phase as HeldWritePhase,
  };
  if (typeof row.kind === 'string' && row.kind.length > 0) {
    record.kind = row.kind;
  }
  if (row.awaitingReviewReload === true) {
    record.awaitingReviewReload = true;
  }
  return record;
}

function writeRecordToStorage(record: HeldWriteRecord): void {
  const userId = activeUserId();
  if (userId === null) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return;
  }
  safeSetItem(entryStorageKey(record.subject, userId), serialized);
}

function removeRecordFromStorage(subject: string): void {
  const userId = activeUserId();
  if (userId === null) return;
  safeRemoveItem(entryStorageKey(subject, userId));
}

function ensureHydrated(): void {
  const userId = activeUserId();
  if (userId === null) {
    if (records.size > 0) records.clear();
    hydratedScopeKey = null;
    return;
  }
  const scopeKey = userStoragePrefix(userId);
  if (hydratedScopeKey === scopeKey) return;
  hydratedScopeKey = scopeKey;
  records.clear();

  const keys = safeListKeys(scopeKey);
  for (const key of keys) {
    const raw = safeReadItem(key);
    if (raw === null) continue;
    const parsed = parseRecord(raw);
    if (!parsed) continue;
    // A reload of an in-flight write restores it as `unknown` and NEVER auto-sends.
    if (parsed.phase === 'inflight') {
      parsed.phase = 'unknown';
      writeRecordToStorage(parsed);
    }
    records.set(parsed.subject, parsed);
  }
}

export function subscribeHeldWritesStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Bind the store to the active Supabase auth user. Passing `null` enters the
 * signed-out state: in-memory pins are cleared and nothing reads or writes
 * localStorage until a valid session is active.
 */
export function setHeldWriteUser(userId: string | null): void {
  if (userId === null || userId.trim() === '') {
    userScope = { mode: 'signed_out' };
    hydratedScopeKey = null;
    if (records.size > 0) {
      records.clear();
      emit();
    }
    return;
  }
  const nextId = userId.trim();
  if (
    userScope.mode === 'active' &&
    userScope.userId === nextId &&
    hydratedScopeKey === userStoragePrefix(nextId)
  ) {
    return;
  }
  userScope = { mode: 'active', userId: nextId };
  hydratedScopeKey = null;
  ensureHydrated();
  emit();
}

/**
 * Remove all persisted held-write keys for a specific user on the current
 * project URL. Other users' keys and unrelated storage keys are untouched.
 */
export function clearHeldWritesForUser(
  userId: string,
  projectUrl = currentProjectUrl(),
): void {
  if (userId.trim() === '') return;
  const prefix = userStoragePrefix(userId.trim(), projectUrl);
  for (const key of safeListKeys(prefix)) {
    safeRemoveItem(key);
  }
  if (
    activeUserId() === userId.trim() &&
    currentProjectUrl() === projectUrl &&
    records.size > 0
  ) {
    records.clear();
    emit();
  }
}

/**
 * Re-read the active scope from localStorage, promoting any `inflight` record
 * to `unknown`. Used on reload boundaries and in reload tests.
 */
export function rehydrateHeldWrites(): void {
  hydratedScopeKey = null;
  records.clear();
  ensureHydrated();
  emit();
}

export function getHeldWrite<T = unknown>(
  subject: string,
): HeldWriteRecord<T> | null {
  ensureHydrated();
  return (records.get(subject) as HeldWriteRecord<T> | undefined) ?? null;
}

export function hasHeldWrite(subject: string): boolean {
  ensureHydrated();
  return records.has(subject);
}

/** True while any pin is held in any phase (blocks PWA shell reload). */
export function hasAnyHeldWrite(): boolean {
  ensureHydrated();
  return records.size > 0;
}

export function listHeldWritesByPrefix<T = unknown>(
  prefix: string,
): HeldWriteRecord<T>[] {
  ensureHydrated();
  const found: HeldWriteRecord<T>[] = [];
  for (const [subject, entry] of records.entries()) {
    if (subject.startsWith(prefix)) {
      found.push(entry as HeldWriteRecord<T>);
    }
  }
  return found;
}

/**
 * At most one outstanding action per subject. Writes `phase: 'inflight'` to
 * localStorage BEFORE returning so a reload mid-request restores `unknown`.
 */
export function beginHeldWrite<T>(
  subject: string,
  create: (requestId: string) => T,
  options?: { requestId?: string; kind?: HeldWriteKind },
): HeldWriteRecord<T> {
  ensureHydrated();
  const existing = records.get(subject);
  if (existing) {
    return existing as HeldWriteRecord<T>;
  }
  const requestId = options?.requestId ?? crypto.randomUUID();
  const payload = create(requestId);
  const next: HeldWriteRecord<T> = {
    v: 1,
    subject,
    requestId,
    payload,
    phase: 'inflight',
    ...(options?.kind ? { kind: options.kind } : {}),
  };
  if (userScope.mode !== 'signed_out') {
    records.set(subject, next);
    writeRecordToStorage(next);
    emit();
  }
  return next;
}

/**
 * Write or update a held-write record before a request or phase transition.
 * When `phase === 'posted_reload'`, payload is cleared so no money or stale
 * form data remains cached while waiting for the post-write read.
 */
export function putHeldWrite<T>(
  subject: string,
  input: {
    requestId: string;
    payload: T;
    phase: HeldWritePhase;
    kind?: HeldWriteKind;
    awaitingReviewReload?: boolean;
  },
): HeldWriteRecord<T> {
  ensureHydrated();
  const next: HeldWriteRecord<T> = {
    v: 1,
    subject,
    requestId: input.requestId,
    payload: (input.phase === 'posted_reload' ? null : input.payload) as T,
    phase: input.phase,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.awaitingReviewReload ? { awaitingReviewReload: true } : {}),
  };
  if (userScope.mode !== 'signed_out') {
    records.set(subject, next);
    writeRecordToStorage(next);
    emit();
  }
  return next;
}

export function setHeldWritePhase(
  subject: string,
  requestId: string,
  phase: HeldWritePhase,
): void {
  ensureHydrated();
  const current = records.get(subject);
  if (!current || current.requestId !== requestId) return;
  const next: HeldWriteRecord = {
    ...current,
    phase,
    ...(phase === 'posted_reload' ? { payload: null } : {}),
  };
  if (phase !== 'unknown') {
    delete next.awaitingReviewReload;
  }
  records.set(subject, next);
  writeRecordToStorage(next);
  emit();
}

export function updateHeldWritePayload<T>(
  subject: string,
  requestId: string,
  payload: T,
  extra?: { phase?: HeldWritePhase; awaitingReviewReload?: boolean },
): void {
  ensureHydrated();
  const current = records.get(subject);
  if (!current || current.requestId !== requestId) return;
  const next: HeldWriteRecord<T> = {
    v: 1,
    subject: current.subject,
    requestId: current.requestId,
    payload,
    phase: extra?.phase ?? current.phase,
    ...(current.kind ? { kind: current.kind } : {}),
  };
  const awaiting =
    extra?.awaitingReviewReload !== undefined
      ? extra.awaitingReviewReload
      : current.awaitingReviewReload;
  if (awaiting === true) {
    next.awaitingReviewReload = true;
  }
  records.set(subject, next);
  writeRecordToStorage(next);
  emit();
}

export function clearHeldWrite(subject: string, requestId?: string): void {
  ensureHydrated();
  const current = records.get(subject);
  if (!current) return;
  if (requestId !== undefined && current.requestId !== requestId) return;
  records.delete(subject);
  removeRecordFromStorage(subject);
  emit();
}

export function hasPostedReload(subject: string): boolean {
  const current = getHeldWrite(subject);
  return current?.phase === 'posted_reload';
}

export function clearPostedReload(subject: string): void {
  ensureHydrated();
  const current = records.get(subject);
  if (!current || current.phase !== 'posted_reload') return;
  records.delete(subject);
  removeRecordFromStorage(subject);
  emit();
}

/** Test isolation. Clears in-memory records and active-user persisted keys. */
export function resetHeldWritesStore(options?: {
  clearStorage?: boolean;
  resetUser?: boolean;
}): void {
  const shouldClearStorage = options?.clearStorage !== false;
  if (shouldClearStorage) {
    const userId = activeUserId();
    if (userId !== null) {
      const prefix = userStoragePrefix(userId);
      for (const key of safeListKeys(prefix)) {
        safeRemoveItem(key);
      }
    }
  }
  const hadRecords = records.size > 0;
  records.clear();
  hydratedScopeKey = null;
  if (options?.resetUser) {
    userScope = { mode: 'uninitialized' };
  }
  if (hadRecords) emit();
}
