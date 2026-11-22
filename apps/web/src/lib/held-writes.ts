import { isOnline } from '@/lib/online';
import { readSupabaseEnv } from '@/lib/supabase';

/**
 * Reload pin phases for idempotent writers.
 *
 * - `inflight`: written to localStorage BEFORE sending the request. A reload
 *   while `inflight` restores as `unknown` (once no live tab holds its Web
 *   Lock) and NEVER auto-sends.
 * - `unknown`: reply was lost or outcome did not prove absence. The owner
 *   must explicitly retry the exact same request id and payload.
 * - `waiting_for_sync`: server stored a count request awaiting a covering sync.
 * - `posted_reload`: write succeeded, waiting for the post-write read to
 *   succeed before unlocking. Never re-sends; clears only once a read covering
 *   its request id and read target succeeds.
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
   * Read target that must succeed before `posted_reload` clears (e.g. a month
   * start `2030-04-01` or a mapping/recipe subject key).
   */
  readTarget?: string;
  /**
   * Activation review reload pin: server confirmed `opening manifest changed`
   * (stored nothing), so the request id is kept but cannot send until a review
   * reload replaces the payload.
   */
  awaitingReviewReload?: boolean;
};

/**
 * Non-request-id post-write read marker for writers whose RPC has no client
 * request id (e.g. catalog update, month completion toggle). Stored separately
 * from held-write records with no `requestId`.
 */
export type ReloadMarkerRecord = {
  v: 1;
  subject: string;
  target?: string;
};

/** Captured auth identity + monotonic session generation for multi-step writes. */
export type WriteSession = {
  userId: string;
  generation: number;
};

export type HeldWriteLockManager = {
  request<T>(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
  ): Promise<T>;
  query?: () => Promise<{ held?: Array<{ name?: string }> }>;
};

export const storageWriteFailedMessage =
  'مش قادر أحفظ العملية على الجهاز، جرّب تاني';

export class HeldWriteStorageError extends Error {
  constructor() {
    super(storageWriteFailedMessage);
    this.name = 'HeldWriteStorageError';
  }
}

export type TryBeginHeldWriteResult<T> =
  | { ok: true; record: HeldWriteRecord<T>; reused: boolean }
  | { ok: false; reason: 'storage' | 'signed_out' };

export type TryPutHeldWriteResult<T> =
  | { ok: true; record: HeldWriteRecord<T> }
  | {
      ok: false;
      reason: 'storage' | 'conflict' | 'signed_out';
      existing?: HeldWriteRecord;
    };

export type ClaimHeldWriteResult<T> =
  | { ok: true; record: HeldWriteRecord<T>; release: () => void }
  | {
      ok: false;
      reason: 'locked' | 'conflict' | 'missing' | 'storage' | 'signed_out';
      existing?: HeldWriteRecord;
    };

const KEY_PREFIX = 'theshark:held:v1:';
const RELOAD_PREFIX = 'theshark:reload:v1:';
const POSTED_SEGMENT = 'posted:';
const FALLBACK_PROJECT = 'default';
const TEST_LOCAL_USER = '__local__';

const VALID_PHASES: ReadonlySet<string> = new Set<HeldWritePhase>([
  'inflight',
  'unknown',
  'waiting_for_sync',
  'posted_reload',
]);

function isUnresolvedPhase(phase: HeldWritePhase): boolean {
  return (
    phase === 'inflight' || phase === 'unknown' || phase === 'waiting_for_sync'
  );
}

type UserScopeState =
  | { mode: 'uninitialized' }
  | { mode: 'signed_out' }
  | { mode: 'active'; userId: string };

function defaultStorage(): Storage | null {
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

function defaultLocks(): HeldWriteLockManager | null {
  try {
    if (typeof navigator === 'undefined') return null;
    const candidate = (navigator as unknown as { locks?: unknown }).locks;
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { request?: unknown }).request === 'function'
    ) {
      return candidate as HeldWriteLockManager;
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

export function userStoragePrefix(
  userId: string,
  projectUrl = currentProjectUrl(),
): string {
  return `${KEY_PREFIX}${encodeURIComponent(projectUrl)}:${encodeURIComponent(userId)}:`;
}

export function reloadMarkerPrefix(
  userId: string,
  projectUrl = currentProjectUrl(),
): string {
  return `${RELOAD_PREFIX}${encodeURIComponent(projectUrl)}:${encodeURIComponent(userId)}:`;
}

function postedMapKey(subject: string, requestId: string): string {
  return `${subject}\0${requestId}`;
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
  if (typeof row.readTarget === 'string' && row.readTarget.length > 0) {
    record.readTarget = row.readTarget;
  }
  if (row.awaitingReviewReload === true) {
    record.awaitingReviewReload = true;
  }
  return record;
}

function parseReloadMarker(raw: string): ReloadMarkerRecord | null {
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
  const marker: ReloadMarkerRecord = {
    v: 1,
    subject: row.subject,
  };
  if (typeof row.target === 'string' && row.target.length > 0) {
    marker.target = row.target;
  }
  return marker;
}

function matchesPostedTarget(
  record: HeldWriteRecord,
  expectedTarget: string | undefined,
): boolean {
  if (record.readTarget === undefined || record.readTarget === '*') {
    return true;
  }
  if (expectedTarget === undefined) {
    return false;
  }
  return record.readTarget === expectedTarget;
}

export type HeldWriteStoreOptions = {
  getStorage?: () => Storage | null;
  getProjectUrl?: () => string;
  getLocks?: () => HeldWriteLockManager | null;
  /**
   * Only enabled in Vitest (`import.meta.env.MODE === 'test'`) so unit tests
   * that mount pages without starting auth can exercise held writes. Production
   * builds never fall back to a synthetic local user.
   */
  allowTestLocalUser?: boolean;
};

export function createHeldWriteStore(options: HeldWriteStoreOptions = {}) {
  const getStorage = options.getStorage ?? defaultStorage;
  const getProjectUrl = options.getProjectUrl ?? currentProjectUrl;
  const getLocks = options.getLocks ?? defaultLocks;
  const allowTestLocalUser =
    options.allowTestLocalUser ?? import.meta.env.MODE === 'test';

  let userScope: UserScopeState = { mode: 'uninitialized' };
  let writesLocked = false;
  let sessionGeneration = 0;
  let hydratedScopeKey: string | null = null;
  let hydrationPromise: Promise<void> = Promise.resolve();
  const records = new Map<string, HeldWriteRecord>();
  const postedReloads = new Map<string, HeldWriteRecord>();
  const reloadMarkers = new Map<string, ReloadMarkerRecord>();
  const activeLockReleases = new Map<string, () => void>();
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function activeUserId(): string | null {
    if (writesLocked) return null;
    if (userScope.mode === 'signed_out') return null;
    if (userScope.mode === 'active') return userScope.userId;
    return allowTestLocalUser ? TEST_LOCAL_USER : null;
  }

  function entryStorageKey(
    subject: string,
    userId: string,
    projectUrl = getProjectUrl(),
  ): string {
    return `${userStoragePrefix(userId, projectUrl)}${encodeURIComponent(subject)}`;
  }

  function postedSubjectPrefix(
    subject: string,
    userId: string,
    projectUrl = getProjectUrl(),
  ): string {
    return `${userStoragePrefix(userId, projectUrl)}${POSTED_SEGMENT}${encodeURIComponent(subject)}:`;
  }

  function postedStorageKey(
    subject: string,
    requestId: string,
    userId: string,
    projectUrl = getProjectUrl(),
  ): string {
    return `${postedSubjectPrefix(subject, userId, projectUrl)}${encodeURIComponent(requestId)}`;
  }

  function markerStorageKey(
    subject: string,
    userId: string,
    projectUrl = getProjectUrl(),
  ): string {
    return `${reloadMarkerPrefix(userId, projectUrl)}${encodeURIComponent(subject)}`;
  }

  function safeSetItem(key: string, value: string): boolean {
    const storage = getStorage();
    if (!storage) return false;
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      return false;
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

  function strictReadItem(
    key: string,
  ): { ok: true; value: string | null } | { ok: false } {
    const storage = getStorage();
    if (!storage) return { ok: false };
    try {
      return { ok: true, value: storage.getItem(key) };
    } catch {
      return { ok: false };
    }
  }

  function writeRecordToStorage(
    record: HeldWriteRecord,
    userId: string,
  ): boolean {
    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch {
      return false;
    }
    const key =
      record.phase === 'posted_reload'
        ? postedStorageKey(record.subject, record.requestId, userId)
        : entryStorageKey(record.subject, userId);
    return safeSetItem(key, serialized);
  }

  function writeMarkerToStorage(
    marker: ReloadMarkerRecord,
    userId: string,
  ): boolean {
    let serialized: string;
    try {
      serialized = JSON.stringify(marker);
    } catch {
      return false;
    }
    return safeSetItem(markerStorageKey(marker.subject, userId), serialized);
  }

  function removeRecordFromStorage(subject: string, userId: string): void {
    safeRemoveItem(entryStorageKey(subject, userId));
  }

  function removePostedFromStorage(
    subject: string,
    requestId: string,
    userId: string,
  ): void {
    safeRemoveItem(postedStorageKey(subject, requestId, userId));
    // Also clean up any legacy active-slot posted_reload record matching requestId.
    const activeKey = entryStorageKey(subject, userId);
    const raw = safeReadItem(activeKey);
    const parsed = raw !== null ? parseRecord(raw) : null;
    if (
      parsed &&
      parsed.phase === 'posted_reload' &&
      parsed.requestId === requestId
    ) {
      safeRemoveItem(activeKey);
    }
  }

  function removeMarkerFromStorage(subject: string, userId: string): void {
    safeRemoveItem(markerStorageKey(subject, userId));
  }

  async function acquireSubjectLock(
    lockName: string,
  ): Promise<{ acquired: boolean; release: () => void }> {
    const locks = getLocks();
    if (!locks) {
      return { acquired: true, release: () => {} };
    }
    if (activeLockReleases.has(lockName)) {
      return { acquired: false, release: () => {} };
    }
    let releaseFn: () => void = () => {};
    let acquired: boolean;
    try {
      acquired = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        void Promise.resolve(
          locks.request(
            lockName,
            { mode: 'exclusive', ifAvailable: true },
            (lock) => {
              if (!lock) {
                finish(false);
                return;
              }
              return new Promise<void>((releaseLock) => {
                let released = false;
                releaseFn = () => {
                  if (released) return;
                  released = true;
                  if (activeLockReleases.get(lockName) === releaseFn) {
                    activeLockReleases.delete(lockName);
                  }
                  releaseLock();
                };
                activeLockReleases.set(lockName, releaseFn);
                finish(true);
              });
            },
          ),
        ).catch(() => {
          finish(false);
        });
      });
    } catch {
      acquired = false;
    }
    return acquired
      ? { acquired: true, release: releaseFn }
      : { acquired: false, release: () => {} };
  }

  function releaseAllLocks(): void {
    const releases = [...activeLockReleases.values()];
    activeLockReleases.clear();
    for (const release of releases) {
      release();
    }
  }

  function loadScopeFromStorage(
    userId: string,
    promoteInflightSync: boolean,
  ): string[] {
    const scopeKey = userStoragePrefix(userId, getProjectUrl());
    const markerPrefix = reloadMarkerPrefix(userId, getProjectUrl());
    records.clear();
    postedReloads.clear();
    reloadMarkers.clear();
    const inflightSubjects: string[] = [];

    for (const key of safeListKeys(scopeKey)) {
      const raw = safeReadItem(key);
      if (raw === null) continue;
      const parsed = parseRecord(raw);
      if (!parsed) continue;
      if (parsed.phase === 'posted_reload') {
        postedReloads.set(
          postedMapKey(parsed.subject, parsed.requestId),
          parsed,
        );
        continue;
      }
      if (parsed.phase === 'inflight') {
        if (promoteInflightSync) {
          // Fallback when Web Locks API is absent: promote inflight -> unknown synchronously.
          parsed.phase = 'unknown';
          writeRecordToStorage(parsed, userId);
        } else {
          inflightSubjects.push(parsed.subject);
        }
      }
      records.set(parsed.subject, parsed);
    }

    for (const key of safeListKeys(markerPrefix)) {
      const raw = safeReadItem(key);
      if (raw === null) continue;
      const parsed = parseReloadMarker(raw);
      if (!parsed) continue;
      reloadMarkers.set(parsed.subject, parsed);
    }

    return inflightSubjects;
  }

  async function promoteUnheldInflight(
    userId: string,
    projectUrl: string,
    subjects: readonly string[],
  ): Promise<void> {
    if (subjects.length === 0) return;
    const locks = getLocks();
    if (!locks) return;
    const scopeKey = userStoragePrefix(userId, projectUrl);
    let heldNames = new Set<string>();
    if (typeof locks.query === 'function') {
      try {
        const state = await locks.query();
        heldNames = new Set(
          (state.held ?? [])
            .map((entry) => entry.name)
            .filter((name): name is string => typeof name === 'string'),
        );
      } catch {
        // Fall through to per-subject ifAvailable probes.
      }
    }

    let changed = false;
    for (const subject of subjects) {
      if (activeUserId() !== userId || hydratedScopeKey !== scopeKey) return;
      const lockName = entryStorageKey(subject, userId, projectUrl);
      if (heldNames.has(lockName) || activeLockReleases.has(lockName)) {
        continue;
      }
      try {
        await locks.request(
          lockName,
          { mode: 'exclusive', ifAvailable: true },
          (lock) => {
            if (!lock) return;
            if (activeUserId() !== userId || hydratedScopeKey !== scopeKey) {
              return;
            }
            const raw = safeReadItem(lockName);
            const stored = raw !== null ? parseRecord(raw) : null;
            if (!stored || stored.phase !== 'inflight') return;
            const promoted: HeldWriteRecord = { ...stored, phase: 'unknown' };
            writeRecordToStorage(promoted, userId);
            records.set(subject, promoted);
            changed = true;
          },
        );
      } catch {
        // Ignore lock errors on best-effort promotion.
      }
    }
    if (changed) emit();
  }

  function ensureHydrated(): void {
    const userId = activeUserId();
    if (userId === null) {
      if (records.size > 0) records.clear();
      if (postedReloads.size > 0) postedReloads.clear();
      if (reloadMarkers.size > 0) reloadMarkers.clear();
      hydratedScopeKey = null;
      return;
    }
    const projectUrl = getProjectUrl();
    const scopeKey = userStoragePrefix(userId, projectUrl);
    if (hydratedScopeKey === scopeKey) return;
    hydratedScopeKey = scopeKey;
    const locksAvailable = getLocks() !== null;
    const inflightSubjects = loadScopeFromStorage(userId, !locksAvailable);
    if (locksAvailable && inflightSubjects.length > 0) {
      hydrationPromise = promoteUnheldInflight(
        userId,
        projectUrl,
        inflightSubjects,
      );
    } else {
      hydrationPromise = Promise.resolve();
    }
  }

  function syncFromStorage(): void {
    const userId = activeUserId();
    if (userId === null) return;
    hydratedScopeKey = userStoragePrefix(userId, getProjectUrl());
    // Cross-tab storage sync must NOT promote another tab's live `inflight` to `unknown`.
    loadScopeFromStorage(userId, false);
    emit();
  }

  function onStorageEvent(event: StorageEvent): void {
    if (
      event.key !== null &&
      !event.key.startsWith(KEY_PREFIX) &&
      !event.key.startsWith(RELOAD_PREFIX)
    ) {
      return;
    }
    syncFromStorage();
  }

  if (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    window.addEventListener('storage', onStorageEvent);
  }

  function dispose(): void {
    releaseAllLocks();
    if (
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      window.removeEventListener('storage', onStorageEvent);
    }
  }

  function subscribeHeldWritesStore(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function bumpSessionGeneration(): void {
    sessionGeneration += 1;
  }

  function setWritesLocked(locked: boolean): void {
    if (writesLocked === locked) return;
    writesLocked = locked;
    if (locked) {
      sessionGeneration += 1;
      releaseAllLocks();
      hydratedScopeKey = null;
      const had =
        records.size > 0 || postedReloads.size > 0 || reloadMarkers.size > 0;
      records.clear();
      postedReloads.clear();
      reloadMarkers.clear();
      if (had) emit();
    }
  }

  function isWritesLocked(): boolean {
    return writesLocked;
  }

  function captureWriteSession(): WriteSession | null {
    const userId = activeUserId();
    if (userId === null) return null;
    return { userId, generation: sessionGeneration };
  }

  function canDispatchWriteFor(session: WriteSession | null): boolean {
    if (!isOnline() || writesLocked || session === null) return false;
    const current = activeUserId();
    return (
      current !== null &&
      current === session.userId &&
      sessionGeneration === session.generation
    );
  }

  function setHeldWriteUser(userId: string | null): void {
    if (userId === null || userId.trim() === '') {
      if (userScope.mode !== 'signed_out') {
        sessionGeneration += 1;
      }
      userScope = { mode: 'signed_out' };
      releaseAllLocks();
      hydratedScopeKey = null;
      const had =
        records.size > 0 || postedReloads.size > 0 || reloadMarkers.size > 0;
      records.clear();
      postedReloads.clear();
      reloadMarkers.clear();
      if (had) emit();
      return;
    }
    const nextId = userId.trim();
    const wasSameActive =
      !writesLocked &&
      userScope.mode === 'active' &&
      userScope.userId === nextId;
    writesLocked = false;
    if (
      wasSameActive &&
      hydratedScopeKey === userStoragePrefix(nextId, getProjectUrl())
    ) {
      return;
    }
    if (!wasSameActive) {
      sessionGeneration += 1;
    }
    userScope = { mode: 'active', userId: nextId };
    hydratedScopeKey = null;
    ensureHydrated();
    emit();
  }

  function clearHeldWritesForUser(
    userId: string,
    projectUrl = getProjectUrl(),
  ): void {
    const trimmed = userId.trim();
    if (trimmed === '') return;
    const prefix = userStoragePrefix(trimmed, projectUrl);
    for (const key of safeListKeys(prefix)) {
      safeRemoveItem(key);
    }
    const markerPrefix = reloadMarkerPrefix(trimmed, projectUrl);
    for (const key of safeListKeys(markerPrefix)) {
      safeRemoveItem(key);
    }
    if (
      activeUserId() === trimmed &&
      getProjectUrl() === projectUrl &&
      (records.size > 0 || postedReloads.size > 0 || reloadMarkers.size > 0)
    ) {
      records.clear();
      postedReloads.clear();
      reloadMarkers.clear();
      emit();
    }
  }

  function rehydrateHeldWrites(): void {
    hydratedScopeKey = null;
    records.clear();
    postedReloads.clear();
    reloadMarkers.clear();
    ensureHydrated();
    emit();
  }

  async function rehydrateHeldWritesAsync(): Promise<void> {
    rehydrateHeldWrites();
    await hydrationPromise;
  }

  function getHeldWrite<T = unknown>(
    subject: string,
  ): HeldWriteRecord<T> | null {
    ensureHydrated();
    const active = records.get(subject);
    if (active) return active as HeldWriteRecord<T>;
    for (const entry of postedReloads.values()) {
      if (entry.subject === subject) {
        return entry as HeldWriteRecord<T>;
      }
    }
    return null;
  }

  function hasHeldWrite(subject: string): boolean {
    ensureHydrated();
    if (records.has(subject)) return true;
    for (const entry of postedReloads.values()) {
      if (entry.subject === subject) return true;
    }
    return false;
  }

  /**
   * True while any pin or post-write reload marker is held in storage OR
   * memory for the active user. Consults localStorage directly so another
   * tab's pin blocks a PWA shell reload even before a storage event fires.
   */
  function hasAnyHeldWrite(): boolean {
    ensureHydrated();
    if (records.size > 0 || postedReloads.size > 0 || reloadMarkers.size > 0) {
      return true;
    }
    const userId = activeUserId();
    if (userId === null) return false;
    const projectUrl = getProjectUrl();
    for (const key of safeListKeys(userStoragePrefix(userId, projectUrl))) {
      const raw = safeReadItem(key);
      if (raw !== null && parseRecord(raw) !== null) return true;
    }
    for (const key of safeListKeys(reloadMarkerPrefix(userId, projectUrl))) {
      const raw = safeReadItem(key);
      if (raw !== null && parseReloadMarker(raw) !== null) return true;
    }
    return false;
  }

  function listHeldWritesByPrefix<T = unknown>(
    prefix: string,
  ): HeldWriteRecord<T>[] {
    ensureHydrated();
    const found: HeldWriteRecord<T>[] = [];
    for (const [subject, entry] of records.entries()) {
      if (subject.startsWith(prefix)) {
        found.push(entry as HeldWriteRecord<T>);
      }
    }
    for (const entry of postedReloads.values()) {
      if (entry.subject.startsWith(prefix)) {
        found.push(entry as HeldWriteRecord<T>);
      }
    }
    return found;
  }

  function preservePayloadIdentity<T>(
    subject: string,
    stored: HeldWriteRecord,
  ): HeldWriteRecord<T> {
    const existingMem = records.get(subject);
    if (
      existingMem &&
      existingMem.requestId === stored.requestId &&
      JSON.stringify(existingMem.payload) === JSON.stringify(stored.payload)
    ) {
      return { ...stored, payload: existingMem.payload } as HeldWriteRecord<T>;
    }
    return stored as HeldWriteRecord<T>;
  }

  /**
   * Atomically claim a fresh write on `subject` using Web Locks when available.
   * Refuses if another tab holds the lock OR if any unresolved pin already
   * exists in localStorage for `subject` (never replaces an existing pin).
   * The caller MUST invoke `release()` after updating storage on completion.
   */
  async function claimFreshHeldWrite<T>(
    subject: string,
    create: (requestId: string) => T,
    opts?: { requestId?: string; kind?: HeldWriteKind },
  ): Promise<ClaimHeldWriteResult<T>> {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) {
      return { ok: false, reason: 'signed_out' };
    }
    const key = entryStorageKey(subject, userId);
    const lock = await acquireSubjectLock(key);
    if (!lock.acquired) {
      return { ok: false, reason: 'locked' };
    }
    if (activeUserId() !== userId) {
      lock.release();
      return { ok: false, reason: 'signed_out' };
    }
    const read = strictReadItem(key);
    if (!read.ok) {
      lock.release();
      return { ok: false, reason: 'storage' };
    }
    const stored = read.value !== null ? parseRecord(read.value) : null;
    if (stored && isUnresolvedPhase(stored.phase)) {
      const preserved = preservePayloadIdentity(subject, stored);
      records.set(subject, preserved);
      emit();
      lock.release();
      return { ok: false, reason: 'conflict', existing: preserved };
    }
    const requestId = opts?.requestId ?? crypto.randomUUID();
    const payload = create(requestId);
    const next: HeldWriteRecord<T> = {
      v: 1,
      subject,
      requestId,
      payload,
      phase: 'inflight',
      ...(opts?.kind ? { kind: opts.kind } : {}),
    };
    if (!writeRecordToStorage(next, userId)) {
      lock.release();
      return { ok: false, reason: 'storage' };
    }
    records.set(subject, next);
    emit();
    return { ok: true, record: next, release: lock.release };
  }

  /**
   * Atomically claim an EXPLICIT REPLAY of an existing durable pin in storage.
   * Re-reads localStorage directly inside the Web Lock and requires the exact
   * same `subject` and `requestId` to exist durably in storage before allowing
   * any retry to send.
   */
  async function claimReplayHeldWrite<T>(
    subject: string,
    requestId: string,
    opts?: { payload?: T; awaitingReviewReload?: boolean },
  ): Promise<ClaimHeldWriteResult<T>> {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) {
      return { ok: false, reason: 'signed_out' };
    }
    const key = entryStorageKey(subject, userId);
    const lock = await acquireSubjectLock(key);
    if (!lock.acquired) {
      return { ok: false, reason: 'locked' };
    }
    if (activeUserId() !== userId) {
      lock.release();
      return { ok: false, reason: 'signed_out' };
    }
    const read = strictReadItem(key);
    if (!read.ok) {
      lock.release();
      return { ok: false, reason: 'storage' };
    }
    const stored = read.value !== null ? parseRecord(read.value) : null;
    if (
      !stored ||
      stored.subject !== subject ||
      stored.requestId !== requestId ||
      !isUnresolvedPhase(stored.phase)
    ) {
      if (stored && isUnresolvedPhase(stored.phase)) {
        records.set(subject, stored);
        emit();
      } else if (records.has(subject)) {
        records.delete(subject);
        emit();
      }
      lock.release();
      return {
        ok: false,
        reason: 'missing',
        ...(stored ? { existing: stored } : {}),
      };
    }
    const preserved = preservePayloadIdentity<T>(subject, stored);
    const next: HeldWriteRecord<T> = {
      ...preserved,
      payload: opts?.payload !== undefined ? opts.payload : preserved.payload,
      phase: 'inflight',
    };
    if (opts?.awaitingReviewReload === false) {
      delete next.awaitingReviewReload;
    }
    if (!writeRecordToStorage(next, userId)) {
      lock.release();
      return { ok: false, reason: 'storage' };
    }
    records.set(subject, next);
    emit();
    return { ok: true, record: next, release: lock.release };
  }

  function tryBeginHeldWrite<T>(
    subject: string,
    create: (requestId: string) => T,
    opts?: { requestId?: string; kind?: HeldWriteKind },
  ): TryBeginHeldWriteResult<T> {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) {
      return { ok: false, reason: 'signed_out' };
    }
    const key = entryStorageKey(subject, userId);
    const read = strictReadItem(key);
    if (!read.ok) {
      return { ok: false, reason: 'storage' };
    }
    const stored = read.value !== null ? parseRecord(read.value) : null;
    if (stored && isUnresolvedPhase(stored.phase)) {
      const preserved = preservePayloadIdentity<T>(subject, stored);
      records.set(subject, preserved);
      emit();
      return {
        ok: true,
        record: preserved,
        reused: true,
      };
    }
    const requestId = opts?.requestId ?? crypto.randomUUID();
    const payload = create(requestId);
    const next: HeldWriteRecord<T> = {
      v: 1,
      subject,
      requestId,
      payload,
      phase: 'inflight',
      ...(opts?.kind ? { kind: opts.kind } : {}),
    };
    if (!writeRecordToStorage(next, userId)) {
      return { ok: false, reason: 'storage' };
    }
    records.set(subject, next);
    emit();
    return { ok: true, record: next, reused: false };
  }

  function beginHeldWrite<T>(
    subject: string,
    create: (requestId: string) => T,
    opts?: { requestId?: string; kind?: HeldWriteKind },
  ): HeldWriteRecord<T> {
    const result = tryBeginHeldWrite(subject, create, opts);
    if (result.ok) return result.record;
    if (result.reason === 'storage') {
      throw new HeldWriteStorageError();
    }
    const requestId = opts?.requestId ?? crypto.randomUUID();
    return {
      v: 1,
      subject,
      requestId,
      payload: create(requestId),
      phase: 'inflight',
      ...(opts?.kind ? { kind: opts.kind } : {}),
    };
  }

  function tryPutHeldWrite<T>(
    subject: string,
    input: {
      requestId: string;
      payload: T;
      phase: HeldWritePhase;
      kind?: HeldWriteKind;
      readTarget?: string;
      awaitingReviewReload?: boolean;
    },
  ): TryPutHeldWriteResult<T> {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) {
      return { ok: false, reason: 'signed_out' };
    }
    const key = entryStorageKey(subject, userId);
    const read = strictReadItem(key);
    if (!read.ok && input.phase !== 'posted_reload') {
      return { ok: false, reason: 'storage' };
    }
    const stored =
      read.ok && read.value !== null ? parseRecord(read.value) : null;
    if (
      stored &&
      isUnresolvedPhase(stored.phase) &&
      stored.requestId !== input.requestId
    ) {
      records.set(subject, stored);
      emit();
      return { ok: false, reason: 'conflict', existing: stored };
    }
    const next: HeldWriteRecord<T> = {
      v: 1,
      subject,
      requestId: input.requestId,
      payload: (input.phase === 'posted_reload' ? null : input.payload) as T,
      phase: input.phase,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.phase === 'posted_reload' && input.readTarget
        ? { readTarget: input.readTarget }
        : {}),
      ...(input.awaitingReviewReload ? { awaitingReviewReload: true } : {}),
    };
    const wrote = writeRecordToStorage(next, userId);
    if (!wrote && input.phase !== 'posted_reload') {
      return { ok: false, reason: 'storage' };
    }
    if (input.phase === 'posted_reload') {
      if (stored && stored.requestId === input.requestId) {
        removeRecordFromStorage(subject, userId);
      }
      if (records.get(subject)?.requestId === input.requestId) {
        records.delete(subject);
      }
      postedReloads.set(postedMapKey(subject, input.requestId), next);
    } else {
      records.set(subject, next);
    }
    emit();
    return { ok: true, record: next };
  }

  function putHeldWrite<T>(
    subject: string,
    input: {
      requestId: string;
      payload: T;
      phase: HeldWritePhase;
      kind?: HeldWriteKind;
      readTarget?: string;
      awaitingReviewReload?: boolean;
    },
  ): HeldWriteRecord<T> {
    const result = tryPutHeldWrite(subject, input);
    if (result.ok) return result.record;
    if (result.reason === 'storage') {
      throw new HeldWriteStorageError();
    }
    if (result.reason === 'conflict' && result.existing) {
      return result.existing as HeldWriteRecord<T>;
    }
    return {
      v: 1,
      subject,
      requestId: input.requestId,
      payload: (input.phase === 'posted_reload' ? null : input.payload) as T,
      phase: input.phase,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.phase === 'posted_reload' && input.readTarget
        ? { readTarget: input.readTarget }
        : {}),
      ...(input.awaitingReviewReload ? { awaitingReviewReload: true } : {}),
    };
  }

  function setHeldWritePhase(
    subject: string,
    requestId: string,
    phase: HeldWritePhase,
    phaseOptions?: { readTarget?: string },
  ): void {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    const raw = safeReadItem(entryStorageKey(subject, userId));
    const stored = raw !== null ? parseRecord(raw) : null;
    const inMemory = records.get(subject) ?? null;
    const current = stored ?? inMemory;
    if (!current || current.requestId !== requestId) {
      if (stored && isUnresolvedPhase(stored.phase)) {
        records.set(subject, stored);
        emit();
      }
      return;
    }
    const preservedPayload =
      inMemory &&
      inMemory.requestId === current.requestId &&
      JSON.stringify(inMemory.payload) === JSON.stringify(current.payload)
        ? inMemory.payload
        : current.payload;
    const next: HeldWriteRecord = {
      ...current,
      payload: phase === 'posted_reload' ? null : preservedPayload,
      phase,
    };
    if (phase === 'posted_reload' && phaseOptions?.readTarget) {
      next.readTarget = phaseOptions.readTarget;
    } else if (phase !== 'posted_reload') {
      delete next.readTarget;
    }
    if (phase !== 'unknown') {
      delete next.awaitingReviewReload;
    }
    const wrote = writeRecordToStorage(next, userId);
    if (!wrote && phase === 'inflight') {
      throw new HeldWriteStorageError();
    }
    if (phase === 'posted_reload') {
      removeRecordFromStorage(subject, userId);
      records.delete(subject);
      postedReloads.set(postedMapKey(subject, requestId), next);
    } else {
      records.set(subject, next);
    }
    emit();
  }

  function updateHeldWritePayload<T>(
    subject: string,
    requestId: string,
    payload: T,
    extra?: { phase?: HeldWritePhase; awaitingReviewReload?: boolean },
  ): void {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    const raw = safeReadItem(entryStorageKey(subject, userId));
    const stored = raw !== null ? parseRecord(raw) : null;
    const current = stored ?? records.get(subject) ?? null;
    if (!current || current.requestId !== requestId) {
      if (stored && isUnresolvedPhase(stored.phase)) {
        records.set(subject, stored);
        emit();
      }
      return;
    }
    const nextPhase = extra?.phase ?? current.phase;
    const next: HeldWriteRecord<T> = {
      v: 1,
      subject: current.subject,
      requestId: current.requestId,
      payload,
      phase: nextPhase,
      ...(current.kind ? { kind: current.kind } : {}),
    };
    const awaiting =
      extra?.awaitingReviewReload !== undefined
        ? extra.awaitingReviewReload
        : current.awaitingReviewReload;
    if (awaiting === true) {
      next.awaitingReviewReload = true;
    }
    const wrote = writeRecordToStorage(next, userId);
    if (!wrote && nextPhase === 'inflight') {
      throw new HeldWriteStorageError();
    }
    records.set(subject, next);
    emit();
  }

  function clearHeldWrite(subject: string, requestId?: string): void {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    let changed = false;

    const raw = safeReadItem(entryStorageKey(subject, userId));
    const stored = raw !== null ? parseRecord(raw) : null;
    if (stored) {
      if (requestId !== undefined && stored.requestId !== requestId) {
        if (isUnresolvedPhase(stored.phase)) {
          records.set(subject, stored);
          emit();
        }
      } else {
        records.delete(subject);
        removeRecordFromStorage(subject, userId);
        changed = true;
      }
    } else {
      const current = records.get(subject);
      if (
        current &&
        (requestId === undefined || current.requestId === requestId)
      ) {
        records.delete(subject);
        removeRecordFromStorage(subject, userId);
        changed = true;
      }
    }

    if (requestId !== undefined) {
      const pKey = postedMapKey(subject, requestId);
      if (postedReloads.has(pKey)) {
        postedReloads.delete(pKey);
        removePostedFromStorage(subject, requestId, userId);
        changed = true;
      } else if (
        safeReadItem(postedStorageKey(subject, requestId, userId)) !== null
      ) {
        removePostedFromStorage(subject, requestId, userId);
        changed = true;
      }
    }

    if (changed) emit();
  }

  function hasPostedReload(
    subject: string,
    expectedTarget?: string,
    expectedRequestId?: string,
  ): boolean {
    ensureHydrated();
    for (const entry of postedReloads.values()) {
      if (entry.subject !== subject || entry.phase !== 'posted_reload') {
        continue;
      }
      if (
        expectedRequestId !== undefined &&
        entry.requestId !== expectedRequestId
      ) {
        continue;
      }
      if (
        expectedTarget === undefined ||
        matchesPostedTarget(entry, expectedTarget)
      ) {
        return true;
      }
    }
    return false;
  }

  function clearPostedReload(
    subject: string,
    expectedTarget?: string,
    expectedRequestId?: string,
  ): void {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    let changed = false;

    const candidates = new Map<string, HeldWriteRecord>();
    for (const [k, entry] of postedReloads.entries()) {
      if (entry.subject === subject) {
        candidates.set(k, entry);
      }
    }
    for (const key of safeListKeys(postedSubjectPrefix(subject, userId))) {
      const raw = safeReadItem(key);
      const parsed = raw !== null ? parseRecord(raw) : null;
      if (parsed && parsed.phase === 'posted_reload') {
        candidates.set(postedMapKey(parsed.subject, parsed.requestId), parsed);
      }
    }
    const legacyRaw = safeReadItem(entryStorageKey(subject, userId));
    const legacyParsed = legacyRaw !== null ? parseRecord(legacyRaw) : null;
    if (legacyParsed && legacyParsed.phase === 'posted_reload') {
      candidates.set(
        postedMapKey(legacyParsed.subject, legacyParsed.requestId),
        legacyParsed,
      );
    }

    for (const [k, entry] of candidates.entries()) {
      if (
        expectedRequestId !== undefined &&
        entry.requestId !== expectedRequestId
      ) {
        continue;
      }
      if (!matchesPostedTarget(entry, expectedTarget)) {
        continue;
      }
      postedReloads.delete(k);
      removePostedFromStorage(entry.subject, entry.requestId, userId);
      changed = true;
    }

    if (changed) emit();
  }

  function setReloadMarker(subject: string, target?: string): void {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    const marker: ReloadMarkerRecord = {
      v: 1,
      subject,
      ...(target ? { target } : {}),
    };
    reloadMarkers.set(subject, marker);
    writeMarkerToStorage(marker, userId);
    emit();
  }

  function getReloadMarker(subject: string): ReloadMarkerRecord | null {
    ensureHydrated();
    return reloadMarkers.get(subject) ?? null;
  }

  function hasReloadMarker(subject: string, expectedTarget?: string): boolean {
    const marker = getReloadMarker(subject);
    if (!marker) return false;
    if (marker.target === undefined || marker.target === '*') {
      return true;
    }
    if (expectedTarget === undefined) return false;
    return marker.target === expectedTarget;
  }

  function clearReloadMarker(subject: string, expectedTarget?: string): void {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    const raw = safeReadItem(markerStorageKey(subject, userId));
    const stored = raw !== null ? parseReloadMarker(raw) : null;
    const current = stored ?? reloadMarkers.get(subject) ?? null;
    if (!current) return;
    if (
      current.target !== undefined &&
      current.target !== '*' &&
      current.target !== expectedTarget
    ) {
      return;
    }
    reloadMarkers.delete(subject);
    removeMarkerFromStorage(subject, userId);
    emit();
  }

  function resetHeldWritesStore(resetOptions?: {
    clearStorage?: boolean;
    resetUser?: boolean;
  }): void {
    releaseAllLocks();
    const shouldClearStorage = resetOptions?.clearStorage !== false;
    if (shouldClearStorage) {
      const userId = activeUserId();
      if (userId !== null) {
        const projectUrl = getProjectUrl();
        for (const key of safeListKeys(userStoragePrefix(userId, projectUrl))) {
          safeRemoveItem(key);
        }
        for (const key of safeListKeys(
          reloadMarkerPrefix(userId, projectUrl),
        )) {
          safeRemoveItem(key);
        }
      }
    }
    const had =
      records.size > 0 || postedReloads.size > 0 || reloadMarkers.size > 0;
    records.clear();
    postedReloads.clear();
    reloadMarkers.clear();
    hydratedScopeKey = null;
    writesLocked = false;
    if (resetOptions?.resetUser) {
      userScope = { mode: 'uninitialized' };
      sessionGeneration += 1;
    }
    if (had) emit();
  }

  return {
    subscribeHeldWritesStore,
    bumpSessionGeneration,
    setWritesLocked,
    isWritesLocked,
    captureWriteSession,
    canDispatchWriteFor,
    setHeldWriteUser,
    clearHeldWritesForUser,
    rehydrateHeldWrites,
    rehydrateHeldWritesAsync,
    getHeldWrite,
    hasHeldWrite,
    hasAnyHeldWrite,
    listHeldWritesByPrefix,
    claimFreshHeldWrite,
    claimReplayHeldWrite,
    tryBeginHeldWrite,
    beginHeldWrite,
    tryPutHeldWrite,
    putHeldWrite,
    setHeldWritePhase,
    updateHeldWritePayload,
    clearHeldWrite,
    hasPostedReload,
    clearPostedReload,
    setReloadMarker,
    getReloadMarker,
    hasReloadMarker,
    clearReloadMarker,
    resetHeldWritesStore,
    dispose,
  };
}

const defaultStore = createHeldWriteStore();

export const subscribeHeldWritesStore = defaultStore.subscribeHeldWritesStore;
export const bumpSessionGeneration = defaultStore.bumpSessionGeneration;
export const setWritesLocked = defaultStore.setWritesLocked;
export const isWritesLocked = defaultStore.isWritesLocked;
export const captureWriteSession = defaultStore.captureWriteSession;
export const canDispatchWriteFor = defaultStore.canDispatchWriteFor;
export const setHeldWriteUser = defaultStore.setHeldWriteUser;
export const clearHeldWritesForUser = defaultStore.clearHeldWritesForUser;
export const rehydrateHeldWrites = defaultStore.rehydrateHeldWrites;
export const rehydrateHeldWritesAsync = defaultStore.rehydrateHeldWritesAsync;
export const getHeldWrite = defaultStore.getHeldWrite;
export const hasHeldWrite = defaultStore.hasHeldWrite;
export const hasAnyHeldWrite = defaultStore.hasAnyHeldWrite;
export const listHeldWritesByPrefix = defaultStore.listHeldWritesByPrefix;
export const claimFreshHeldWrite = defaultStore.claimFreshHeldWrite;
export const claimReplayHeldWrite = defaultStore.claimReplayHeldWrite;
export const tryBeginHeldWrite = defaultStore.tryBeginHeldWrite;
export const beginHeldWrite = defaultStore.beginHeldWrite;
export const tryPutHeldWrite = defaultStore.tryPutHeldWrite;
export const putHeldWrite = defaultStore.putHeldWrite;
export const setHeldWritePhase = defaultStore.setHeldWritePhase;
export const updateHeldWritePayload = defaultStore.updateHeldWritePayload;
export const clearHeldWrite = defaultStore.clearHeldWrite;
export const hasPostedReload = defaultStore.hasPostedReload;
export const clearPostedReload = defaultStore.clearPostedReload;
export const setReloadMarker = defaultStore.setReloadMarker;
export const getReloadMarker = defaultStore.getReloadMarker;
export const hasReloadMarker = defaultStore.hasReloadMarker;
export const clearReloadMarker = defaultStore.clearReloadMarker;
export const resetHeldWritesStore = defaultStore.resetHeldWritesStore;
