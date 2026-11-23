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
  /** Changes on every dispatch claim, including a replay of the same request. */
  claimId?: string;
  payload: T;
  phase: HeldWritePhase;
  /**
   * Read target that must succeed before `posted_reload` clears (e.g. a month
   * start `2030-04-01` or an item id).
   */
  readTarget?: string;
  /**
   * Activation review reload pin: server confirmed `opening manifest changed`
   * (stored nothing), so the request id is kept but cannot send until a review
   * reload replaces the payload.
   */
  awaitingReviewReload?: boolean;
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

export class HeldWriteLockError extends Error {
  constructor() {
    super('Subject Web Lock is required for durable held-write updates');
    this.name = 'HeldWriteLockError';
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
  | {
      ok: true;
      record: HeldWriteRecord<T>;
      release: () => void;
      session: WriteSession;
    }
  | {
      ok: false;
      reason:
        | 'locked'
        | 'conflict'
        | 'missing'
        | 'storage'
        | 'signed_out'
        | 'session_invalid';
      existing?: HeldWriteRecord;
    };

export type PostedReloadSnapshotItem = {
  subject: string;
  requestId: string;
  claimId?: string;
  readTarget?: string;
};

export type PostedReloadSnapshot = ReadonlyArray<PostedReloadSnapshotItem>;

const KEY_PREFIX = 'theshark:held:v1:';
const LEGACY_RELOAD_PREFIX = 'theshark:reload:v1:';
const POSTED_SEGMENT = 'posted:';
const FALLBACK_PROJECT = 'default';
const TEST_LOCAL_USER = '__local__';

const RETIRED_REQUESTLESS_KINDS: ReadonlySet<string> = new Set([
  'item_details',
  'expense_complete',
  'expense_category',
]);

const RETIRED_REQUESTLESS_SUBJECT_PREFIXES = [
  'item:details:',
  'expense:complete:',
  'expense:category:',
] as const;

function isRetiredRequestlessRecord(record: HeldWriteRecord): boolean {
  if (record.kind && RETIRED_REQUESTLESS_KINDS.has(record.kind)) {
    return true;
  }
  return RETIRED_REQUESTLESS_SUBJECT_PREFIXES.some((prefix) =>
    record.subject.startsWith(prefix),
  );
}

function legacyReloadMarkerPrefix(
  userId: string,
  projectUrl = currentProjectUrl(),
): string {
  return `${LEGACY_RELOAD_PREFIX}${encodeURIComponent(projectUrl)}:${encodeURIComponent(userId)}:`;
}

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
  if (typeof row.claimId === 'string') record.claimId = row.claimId;
  if (typeof row.readTarget === 'string' && row.readTarget.length > 0) {
    record.readTarget = row.readTarget;
  }
  if (row.awaitingReviewReload === true) {
    record.awaitingReviewReload = true;
  }
  return record;
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

function sameClaim(
  stored: HeldWriteRecord,
  expected: HeldWriteRecord,
): boolean {
  return (
    stored.subject === expected.subject &&
    stored.requestId === expected.requestId &&
    stored.phase === expected.phase &&
    stored.claimId === expected.claimId &&
    stored.awaitingReviewReload === expected.awaitingReviewReload
  );
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
  // Tracks commits whose RPC succeeded but whose `posted_reload` storage write
  // failed, so the original durable `inflight` pin stays intact AND read-only
  // recovery can still settle that exact request id once its combined read wins.
  const acknowledgedInflight = new Map<
    string,
    { record: HeldWriteRecord; requestId: string; readTarget?: string }
  >();
  const activeLockReleases = new Map<string, () => void>();
  let liveClaimCount = 0;
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

  function safeListKeys(prefix: string, strict = false): string[] {
    const storage = getStorage();
    if (!storage) {
      if (strict) throw new HeldWriteStorageError();
      return [];
    }
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
      if (strict) throw new HeldWriteStorageError();
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

  function readDurableRecord(key: string): HeldWriteRecord | null {
    const read = strictReadItem(key);
    if (!read.ok) throw new HeldWriteStorageError();
    if (read.value === null) return null;
    const record = parseRecord(read.value);
    if (record === null) throw new HeldWriteStorageError();
    return record;
  }

  function removeDurableRecord(key: string): void {
    const storage = getStorage();
    if (!storage) throw new HeldWriteStorageError();
    try {
      storage.removeItem(key);
    } catch {
      throw new HeldWriteStorageError();
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

  function removeRecordFromStorage(subject: string, userId: string): void {
    safeRemoveItem(entryStorageKey(subject, userId));
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

  function wrapClaimRelease(lockRelease: () => void): () => void {
    liveClaimCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lockRelease();
      liveClaimCount = Math.max(0, liveClaimCount - 1);
      if (liveClaimCount === 0) {
        emit();
      }
    };
  }

  function releaseAllLocks(): void {
    const releases = [...activeLockReleases.values()];
    activeLockReleases.clear();
    liveClaimCount = 0;
    for (const release of releases) {
      release();
    }
  }

  function pruneStoredSnapshot(
    key: string,
    expectedRaw: string,
    subjectLock: string,
    stillCurrent?: () => boolean,
  ): void {
    const prune = () => {
      if (stillCurrent && !stillCurrent()) return;
      const current = strictReadItem(key);
      if (current.ok && current.value === expectedRaw) safeRemoveItem(key);
    };
    const locks = getLocks();
    if (!locks || activeLockReleases.has(subjectLock)) {
      prune();
      return;
    }
    // Hydration and sign-out cleanup must leave a competing tab's live pin alone.
    void locks
      .request(
        subjectLock,
        { mode: 'exclusive', ifAvailable: true },
        (lock) => {
          if (lock) prune();
        },
      )
      .catch(() => {});
  }

  function loadScopeFromStorage(
    userId: string,
    promoteInflightSync: boolean,
  ): HeldWriteRecord[] {
    const projectUrl = getProjectUrl();
    const scopeKey = userStoragePrefix(userId, projectUrl);
    records.clear();
    postedReloads.clear();
    const inflightRecords: HeldWriteRecord[] = [];

    for (const key of safeListKeys(scopeKey)) {
      const raw = safeReadItem(key);
      if (raw === null) continue;
      const parsed = parseRecord(raw);
      if (!parsed) continue;
      // Discard orphaned pins left by retired request-less writers in earlier builds.
      if (isRetiredRequestlessRecord(parsed)) {
        pruneStoredSnapshot(
          key,
          raw,
          entryStorageKey(parsed.subject, userId, projectUrl),
          () => activeUserId() === userId && hydratedScopeKey === scopeKey,
        );
        continue;
      }
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
          inflightRecords.push(parsed);
        }
      }
      records.set(parsed.subject, parsed);
    }

    // Discard legacy reload markers written by earlier builds for this user scope.
    for (const key of safeListKeys(
      legacyReloadMarkerPrefix(userId, projectUrl),
    )) {
      safeRemoveItem(key);
    }

    return inflightRecords;
  }

  async function promoteUnheldInflight(
    userId: string,
    projectUrl: string,
    expectedRecords: readonly HeldWriteRecord[],
  ): Promise<void> {
    if (expectedRecords.length === 0) return;
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
    for (const expected of expectedRecords) {
      const { subject } = expected;
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
            const stored = readDurableRecord(lockName);
            if (!stored || !sameClaim(stored, expected)) return;
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
      hydratedScopeKey = null;
      return;
    }
    const projectUrl = getProjectUrl();
    const scopeKey = userStoragePrefix(userId, projectUrl);
    if (hydratedScopeKey === scopeKey) return;
    hydratedScopeKey = scopeKey;
    const locksAvailable = getLocks() !== null;
    const inflightRecords = loadScopeFromStorage(userId, !locksAvailable);
    if (locksAvailable && inflightRecords.length > 0) {
      hydrationPromise = promoteUnheldInflight(
        userId,
        projectUrl,
        inflightRecords,
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
    if (event.key !== null && !event.key.startsWith(KEY_PREFIX)) {
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
      // Keep any already-dispatched Web Lock held until its RPC settles;
      // locking writes blocks NEW dispatches only.
      hydratedScopeKey = null;
      const had =
        records.size > 0 ||
        postedReloads.size > 0 ||
        acknowledgedInflight.size > 0;
      records.clear();
      postedReloads.clear();
      acknowledgedInflight.clear();
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
      // Do NOT release already-dispatched Web Locks on sign-out; each live
      // writer releases its lock when its HTTP call settles. Sign-out blocks
      // NEW dispatches via userScope + sessionGeneration.
      hydratedScopeKey = null;
      const had =
        records.size > 0 ||
        postedReloads.size > 0 ||
        acknowledgedInflight.size > 0;
      records.clear();
      postedReloads.clear();
      acknowledgedInflight.clear();
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
    const signedOutGeneration = sessionGeneration;
    for (const key of safeListKeys(prefix)) {
      const current = strictReadItem(key);
      if (!current.ok || current.value === null) continue;
      const record = parseRecord(current.value);
      pruneStoredSnapshot(
        key,
        current.value,
        record ? entryStorageKey(record.subject, trimmed, projectUrl) : key,
        () =>
          activeUserId() !== trimmed ||
          sessionGeneration === signedOutGeneration,
      );
    }
    for (const key of safeListKeys(
      legacyReloadMarkerPrefix(trimmed, projectUrl),
    )) {
      safeRemoveItem(key);
    }
    if (
      activeUserId() === trimmed &&
      getProjectUrl() === projectUrl &&
      (records.size > 0 ||
        postedReloads.size > 0 ||
        acknowledgedInflight.size > 0)
    ) {
      records.clear();
      postedReloads.clear();
      acknowledgedInflight.clear();
      emit();
    }
  }

  function rehydrateHeldWrites(): void {
    hydratedScopeKey = null;
    records.clear();
    postedReloads.clear();
    acknowledgedInflight.clear();
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

  /** True while any dispatched write still holds a live claim / Web Lock in this tab. */
  function hasLiveHeldWriteClaims(): boolean {
    return liveClaimCount > 0 || activeLockReleases.size > 0;
  }

  /**
   * True while any pin or live claim lock is held in storage OR memory.
   * Consults live claims even after sign-out clears user keys, and consults
   * localStorage directly so another tab's pin blocks a PWA shell reload even
   * before a storage event fires.
   */
  function hasAnyHeldWrite(): boolean {
    if (hasLiveHeldWriteClaims()) {
      return true;
    }
    ensureHydrated();
    if (
      records.size > 0 ||
      postedReloads.size > 0 ||
      acknowledgedInflight.size > 0
    ) {
      return true;
    }
    const userId = activeUserId();
    if (userId === null) return false;
    const projectUrl = getProjectUrl();
    for (const key of safeListKeys(userStoragePrefix(userId, projectUrl))) {
      const raw = safeReadItem(key);
      const parsed = raw !== null ? parseRecord(raw) : null;
      if (parsed !== null && !isRetiredRequestlessRecord(parsed)) return true;
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
   * Captures (or uses) the write session before awaiting the lock, then under
   * the lock rechecks session generation + user + `navigator.onLine`, refuses
   * if any unresolved pin exists in localStorage, and persists `inflight`.
   * The caller MUST invoke `release()` after updating storage on completion.
   */
  async function claimFreshHeldWrite<T>(
    subject: string,
    create: (requestId: string) => T,
    opts?: {
      requestId?: string;
      kind?: HeldWriteKind;
      session?: WriteSession | null;
    },
  ): Promise<ClaimHeldWriteResult<T>> {
    ensureHydrated();
    const session =
      opts?.session !== undefined ? opts.session : captureWriteSession();
    if (session === null) {
      return { ok: false, reason: 'signed_out' };
    }
    if (!canDispatchWriteFor(session)) {
      return { ok: false, reason: 'session_invalid' };
    }
    const userId = session.userId;
    const key = entryStorageKey(subject, userId);
    const lock = await acquireSubjectLock(key);
    if (!lock.acquired) {
      return { ok: false, reason: 'locked' };
    }
    let handedOff = false;
    try {
      if (!canDispatchWriteFor(session)) {
        return { ok: false, reason: 'session_invalid' };
      }
      const read = strictReadItem(key);
      if (!read.ok) {
        return { ok: false, reason: 'storage' };
      }
      const stored = read.value !== null ? parseRecord(read.value) : null;
      if (read.value !== null && (!stored || stored.subject !== subject)) {
        return { ok: false, reason: 'storage' };
      }
      if (stored) {
        const preserved = preservePayloadIdentity(subject, stored);
        if (isUnresolvedPhase(stored.phase)) records.set(subject, preserved);
        emit();
        return { ok: false, reason: 'conflict', existing: preserved };
      }
      const requestId = opts?.requestId ?? crypto.randomUUID();
      const payload = create(requestId);
      const next: HeldWriteRecord<T> = {
        v: 1,
        subject,
        requestId,
        claimId: crypto.randomUUID(),
        payload,
        phase: 'inflight',
        ...(opts?.kind ? { kind: opts.kind } : {}),
      };
      if (!writeRecordToStorage(next, userId)) {
        return { ok: false, reason: 'storage' };
      }
      records.set(subject, next);
      const release = wrapClaimRelease(lock.release);
      emit();
      handedOff = true;
      return { ok: true, record: next, release, session };
    } finally {
      if (!handedOff) {
        lock.release();
      }
    }
  }

  /**
   * Atomically claim an EXPLICIT REPLAY of an existing durable pin in storage.
   * Re-reads localStorage directly inside the Web Lock, rechecks session
   * generation + user + `navigator.onLine`, and requires the exact same
   * `subject` and `requestId` to exist durably in storage before allowing any
   * retry to send.
   */
  async function claimReplayHeldWrite<T>(
    subject: string,
    requestId: string,
    opts?: {
      payload?: T;
      awaitingReviewReload?: boolean;
      session?: WriteSession | null;
    },
  ): Promise<ClaimHeldWriteResult<T>> {
    ensureHydrated();
    const session =
      opts?.session !== undefined ? opts.session : captureWriteSession();
    if (session === null) {
      return { ok: false, reason: 'signed_out' };
    }
    if (!canDispatchWriteFor(session)) {
      return { ok: false, reason: 'session_invalid' };
    }
    const userId = session.userId;
    const key = entryStorageKey(subject, userId);
    const expected = records.get(subject);
    const lock = await acquireSubjectLock(key);
    if (!lock.acquired) {
      return { ok: false, reason: 'locked' };
    }
    let handedOff = false;
    try {
      if (!canDispatchWriteFor(session)) {
        return { ok: false, reason: 'session_invalid' };
      }
      const read = strictReadItem(key);
      if (!read.ok) {
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
        return {
          ok: false,
          reason: 'missing',
          ...(stored ? { existing: stored } : {}),
        };
      }
      const preserved = preservePayloadIdentity<T>(subject, stored);
      if (
        stored.awaitingReviewReload ||
        (opts?.payload !== undefined &&
          (!expected ||
            !sameClaim(stored, expected) ||
            stored.phase !== 'inflight'))
      ) {
        records.set(subject, preserved);
        emit();
        return { ok: false, reason: 'conflict', existing: preserved };
      }
      const next: HeldWriteRecord<T> = {
        ...preserved,
        claimId: crypto.randomUUID(),
        payload: opts?.payload !== undefined ? opts.payload : preserved.payload,
        phase: 'inflight',
      };
      if (opts?.awaitingReviewReload === false) {
        delete next.awaitingReviewReload;
      }
      if (!writeRecordToStorage(next, userId)) {
        return { ok: false, reason: 'storage' };
      }
      records.set(subject, next);
      const release = wrapClaimRelease(lock.release);
      emit();
      handedOff = true;
      return { ok: true, record: next, release, session };
    } finally {
      if (!handedOff) {
        lock.release();
      }
    }
  }

  function hasDurableHeldWrite(subject: string, requestId: string): boolean {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return false;
    const read = strictReadItem(entryStorageKey(subject, userId));
    if (!read.ok || read.value === null) return false;
    const stored = parseRecord(read.value);
    return (
      stored !== null &&
      stored.subject === subject &&
      stored.requestId === requestId &&
      isUnresolvedPhase(stored.phase)
    );
  }

  /**
   * Combined pre-dispatch guard: requires valid session generation + user +
   * `navigator.onLine` AND that `(subject, requestId)` still exists durably
   * in localStorage right before the mutation RPC fires.
   */
  function canDispatchHeldWrite(
    subject: string,
    requestId: string,
    session: WriteSession | null,
  ): boolean {
    return (
      canDispatchWriteFor(session) && hasDurableHeldWrite(subject, requestId)
    );
  }

  /**
   * Clean up a claimed write on ANY early exit before the RPC is dispatched:
   * removes an unsent fresh `inflight` pin or restores a replay's prior phase,
   * and always releases the Web Lock.
   */
  function abortClaimBeforeDispatch(
    subject: string,
    requestId: string,
    priorPhase: 'inflight' | 'unknown' | 'waiting_for_sync' | null,
    release: () => void,
  ): void {
    try {
      if (priorPhase !== null) {
        setHeldWritePhase(subject, requestId, priorPhase);
      } else {
        clearHeldWrite(subject, requestId);
      }
    } catch {
      // If storage is unavailable or user signed out, never leak the lock.
    } finally {
      release();
    }
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
    if (
      read.value !== null &&
      (!stored ||
        stored.subject !== subject ||
        !isUnresolvedPhase(stored.phase))
    ) {
      return { ok: false, reason: 'storage' };
    }
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
    if (!read.ok) {
      return { ok: false, reason: 'storage' };
    }
    const stored = read.value !== null ? parseRecord(read.value) : null;
    if (read.value !== null && !stored) {
      return { ok: false, reason: 'storage' };
    }
    if (
      stored &&
      isUnresolvedPhase(stored.phase) &&
      stored.requestId !== input.requestId
    ) {
      records.set(subject, stored);
      emit();
      return { ok: false, reason: 'conflict', existing: stored };
    }
    const expected = records.get(subject);
    if (
      stored &&
      (stored.subject !== subject ||
        !expected ||
        !sameClaim(stored, expected) ||
        (getLocks() !== null && !activeLockReleases.has(key)))
    ) {
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
    if (!wrote) {
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

  async function acquireHeldWriteLock(
    subject: string,
  ): Promise<
    | { acquired: true; release: () => void }
    | { acquired: false; reason: 'signed_out' | 'locked' }
  > {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) {
      return { acquired: false, reason: 'signed_out' };
    }
    const key = entryStorageKey(subject, userId);
    const lock = await acquireSubjectLock(key);
    if (!lock.acquired) {
      return { acquired: false, reason: 'locked' };
    }
    return { acquired: true, release: wrapClaimRelease(lock.release) };
  }

  function mutateUnderSubjectLock(
    subject: string,
    userId: string,
    mutate: () => void,
  ): void | Promise<void> {
    const key = entryStorageKey(subject, userId);
    if (getLocks() === null || activeLockReleases.has(key)) {
      mutate();
      return;
    }
    const session = captureWriteSession();
    return acquireSubjectLock(key).then((lock) => {
      if (!lock.acquired) return;
      try {
        if (
          session &&
          activeUserId() === session.userId &&
          session.generation === sessionGeneration
        )
          mutate();
      } finally {
        lock.release();
      }
    });
  }

  function readLockedHeldWrite<T = unknown>(
    subject: string,
    options?: { refresh?: boolean },
  ): HeldWriteRecord<T> | null {
    const userId = activeUserId();
    if (userId === null) return null;
    const key = entryStorageKey(subject, userId);
    if (getLocks() !== null && !activeLockReleases.has(key)) {
      throw new HeldWriteLockError();
    }
    const stored = readDurableRecord(key);
    if (stored && stored.subject !== subject) throw new HeldWriteStorageError();
    if (options?.refresh) {
      const current = records.get(subject);
      if (stored && isUnresolvedPhase(stored.phase)) {
        if (!current || !sameClaim(stored, current)) {
          records.set(subject, stored);
          emit();
        }
      } else if (records.delete(subject)) {
        emit();
      }
    }
    return stored as HeldWriteRecord<T> | null;
  }

  function setHeldWritePhase(
    subject: string,
    requestId: string,
    phase: HeldWritePhase,
    phaseOptions?: { readTarget?: string; expected?: HeldWriteRecord },
  ): void {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    const expected = phaseOptions?.expected ?? records.get(subject);
    const acknowledge = () => {
      if (phase !== 'posted_reload' || expected?.requestId !== requestId)
        return;
      acknowledgedInflight.set(subject, {
        record: expected,
        requestId,
        ...(phaseOptions?.readTarget
          ? { readTarget: phaseOptions.readTarget }
          : {}),
      });
      emit();
    };

    let stored: HeldWriteRecord | null;
    try {
      stored = readLockedHeldWrite(subject);
    } catch (error) {
      if (error instanceof HeldWriteStorageError) acknowledge();
      throw error;
    }
    if (!stored) {
      if (
        expected?.requestId === requestId &&
        records.get(subject) === expected
      ) {
        records.delete(subject);
        acknowledgedInflight.delete(subject);
        emit();
      }
      return;
    }
    if (
      !expected ||
      expected.requestId !== requestId ||
      !sameClaim(stored, expected)
    )
      return;

    const preserved = preservePayloadIdentity(subject, stored);
    const next: HeldWriteRecord = {
      ...preserved,
      payload: phase === 'posted_reload' ? null : preserved.payload,
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
    if (!writeRecordToStorage(next, userId)) {
      acknowledge();
      if (phase === 'unknown' && stored.phase === 'inflight') {
        // Keep the exact durable inflight claim recoverable while allowing
        // an explicit retry of its payload in this tab.
        records.set(subject, next);
        emit();
      } else {
        throw new HeldWriteStorageError();
      }
      return;
    }
    if (phase === 'posted_reload') {
      postedReloads.set(postedMapKey(subject, requestId), next);
      try {
        removeDurableRecord(entryStorageKey(subject, userId));
      } catch (error) {
        acknowledge();
        throw error;
      }
      records.delete(subject);
      acknowledgedInflight.delete(subject);
    } else {
      records.set(subject, next);
    }
    emit();
  }

  function updateHeldWritePayload<T>(
    subject: string,
    requestId: string,
    payload: T | undefined,
    extra?: {
      phase?: HeldWritePhase;
      awaitingReviewReload?: boolean;
      expected?: HeldWriteRecord;
    },
  ): boolean {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return false;
    const expected = extra?.expected ?? records.get(subject);
    const stored = readLockedHeldWrite(subject);
    if (
      !stored ||
      !expected ||
      expected.requestId !== requestId ||
      !sameClaim(stored, expected)
    )
      return false;
    const next: HeldWriteRecord = {
      ...stored,
      payload: payload !== undefined ? payload : stored.payload,
      phase: extra?.phase ?? stored.phase,
    };
    if (extra?.awaitingReviewReload === true) {
      next.awaitingReviewReload = true;
    } else if (extra?.awaitingReviewReload === false) {
      delete next.awaitingReviewReload;
    }
    if (!writeRecordToStorage(next, userId)) {
      throw new HeldWriteStorageError();
    }
    records.set(subject, next);
    emit();
    return true;
  }

  function clearHeldWrite(
    subject: string,
    requestId?: string,
    expected?: HeldWriteRecord,
  ): void {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    const captured = expected ?? records.get(subject);
    if (
      !captured ||
      (requestId !== undefined && captured.requestId !== requestId)
    )
      return;
    const stored = readLockedHeldWrite(subject);
    if (stored && !sameClaim(stored, captured)) return;
    if (stored) removeDurableRecord(entryStorageKey(subject, userId));
    const current = records.get(subject);
    if (current && sameClaim(current, captured)) records.delete(subject);
    const ack = acknowledgedInflight.get(subject);
    if (ack && sameClaim(ack.record, captured))
      acknowledgedInflight.delete(subject);
    emit();
  }

  async function clearVerifiedHeldWrite(
    record: HeldWriteRecord,
  ): Promise<void> {
    const userId = activeUserId();
    if (userId === null) return;
    await mutateUnderSubjectLock(record.subject, userId, () => {
      clearHeldWrite(record.subject, record.requestId, record);
    });
  }

  function matchesAckTarget(
    readTarget: string | undefined,
    expectedTarget: string | undefined,
  ): boolean {
    if (readTarget === undefined || readTarget === '*') return true;
    if (expectedTarget === undefined) return false;
    return readTarget === expectedTarget;
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
    const ack = acknowledgedInflight.get(subject);
    if (
      ack &&
      (expectedRequestId === undefined ||
        ack.requestId === expectedRequestId) &&
      (expectedTarget === undefined ||
        matchesAckTarget(ack.readTarget, expectedTarget))
    ) {
      return true;
    }
    return false;
  }

  function clearPostedReload(
    subject: string,
    expectedTarget?: string,
    expectedRequestId?: string,
    snapshot?: PostedReloadSnapshotItem,
    shouldClear?: () => boolean,
  ): void | Promise<void> {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return;
    const ack = acknowledgedInflight.get(subject);
    const matchesRequest = (requestId: string) =>
      expectedRequestId === undefined || expectedRequestId === requestId;
    const matchesSnapshot = (record: HeldWriteRecord) =>
      !snapshot || record.claimId === snapshot.claimId;
    const matchesAck = Boolean(
      ack &&
      matchesRequest(ack.requestId) &&
      matchesSnapshot(ack.record) &&
      matchesAckTarget(ack.readTarget, expectedTarget),
    );
    const activeKey = entryStorageKey(subject, userId);
    return mutateUnderSubjectLock(subject, userId, () => {
      if (shouldClear && !shouldClear()) return;
      const candidates =
        expectedRequestId !== undefined
          ? [postedStorageKey(subject, expectedRequestId, userId)]
          : safeListKeys(postedSubjectPrefix(subject, userId), true);
      let changed = false;
      try {
        const active = readDurableRecord(activeKey);
        for (const key of [...candidates, activeKey]) {
          const stored = key === activeKey ? active : readDurableRecord(key);
          if (
            !stored ||
            stored.subject !== subject ||
            stored.phase !== 'posted_reload' ||
            !matchesRequest(stored.requestId) ||
            !matchesSnapshot(stored) ||
            !matchesPostedTarget(stored, expectedTarget) ||
            (key !== activeKey &&
              key !== postedStorageKey(subject, stored.requestId, userId))
          )
            continue;
          removeDurableRecord(key);
          postedReloads.delete(postedMapKey(subject, stored.requestId));
          changed = true;
        }

        if (ack && matchesAck && acknowledgedInflight.get(subject) === ack) {
          if (active && sameClaim(active, ack.record)) {
            removeDurableRecord(activeKey);
          }
          // A different claim owns the active slot. Retire only this tab's
          // acknowledgement so it cannot settle that claim on a later read.
          acknowledgedInflight.delete(subject);
          const current = records.get(subject);
          if (current && sameClaim(current, ack.record)) {
            if (
              active &&
              !sameClaim(active, ack.record) &&
              isUnresolvedPhase(active.phase)
            ) {
              records.set(subject, active);
            } else {
              records.delete(subject);
            }
          }
          changed = true;
        }
      } finally {
        if (changed) emit();
      }
    });
  }

  function hasPostedReloadForTarget(target: string): boolean {
    ensureHydrated();
    for (const entry of postedReloads.values()) {
      if (entry.phase === 'posted_reload' && entry.readTarget === target) {
        return true;
      }
    }
    for (const ack of acknowledgedInflight.values()) {
      if (ack.readTarget === target) {
        return true;
      }
    }
    const userId = activeUserId();
    if (userId === null) return false;
    for (const key of safeListKeys(
      `${userStoragePrefix(userId)}${POSTED_SEGMENT}`,
    )) {
      const raw = safeReadItem(key);
      const parsed = raw !== null ? parseRecord(raw) : null;
      if (
        parsed &&
        parsed.phase === 'posted_reload' &&
        parsed.readTarget === target
      ) {
        return true;
      }
    }
    return false;
  }

  function listPostedReloadRecords(prefix = ''): PostedReloadSnapshot {
    return snapshotPostedReloads(prefix ? { prefix } : {});
  }

  function snapshotPostedReloads(filter: {
    subject?: string;
    prefix?: string;
    readTarget?: string;
  }): PostedReloadSnapshot {
    ensureHydrated();
    const userId = activeUserId();
    if (userId === null) return [];
    const seen = new Map<string, PostedReloadSnapshotItem>();

    const considerItem = (
      subject: string,
      requestId: string,
      readTarget?: string,
      claimId?: string,
    ) => {
      if (filter.subject !== undefined && subject !== filter.subject) {
        return;
      }
      if (filter.prefix !== undefined && !subject.startsWith(filter.prefix)) {
        return;
      }
      if (filter.readTarget !== undefined && readTarget !== filter.readTarget) {
        return;
      }
      seen.set(postedMapKey(subject, requestId), {
        subject,
        requestId,
        ...(readTarget !== undefined ? { readTarget } : {}),
        ...(claimId !== undefined ? { claimId } : {}),
      });
    };

    const consider = (entry: HeldWriteRecord) => {
      if (entry.phase !== 'posted_reload') return;
      considerItem(
        entry.subject,
        entry.requestId,
        entry.readTarget,
        entry.claimId,
      );
    };

    for (const entry of postedReloads.values()) {
      consider(entry);
    }
    for (const [subject, ack] of acknowledgedInflight.entries()) {
      considerItem(subject, ack.requestId, ack.readTarget, ack.record.claimId);
    }
    const listPrefix =
      filter.subject !== undefined
        ? postedSubjectPrefix(filter.subject, userId)
        : `${userStoragePrefix(userId)}${POSTED_SEGMENT}`;
    for (const key of safeListKeys(listPrefix)) {
      const raw = safeReadItem(key);
      const parsed = raw !== null ? parseRecord(raw) : null;
      if (parsed) consider(parsed);
    }
    if (filter.subject !== undefined) {
      const legacyRaw = safeReadItem(entryStorageKey(filter.subject, userId));
      const legacyParsed = legacyRaw !== null ? parseRecord(legacyRaw) : null;
      if (legacyParsed) consider(legacyParsed);
    }

    return [...seen.values()];
  }

  async function clearPostedReloadSnapshot(
    snapshot: PostedReloadSnapshot,
    loadedTarget?: string,
    shouldClear?: () => boolean,
  ): Promise<void> {
    for (const item of snapshot) {
      await clearPostedReload(
        item.subject,
        loadedTarget ?? item.readTarget,
        item.requestId,
        item,
        shouldClear,
      );
    }
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
      }
    }
    const had =
      records.size > 0 ||
      postedReloads.size > 0 ||
      acknowledgedInflight.size > 0;
    records.clear();
    postedReloads.clear();
    acknowledgedInflight.clear();
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
    hasLiveHeldWriteClaims,
    hasAnyHeldWrite,
    listHeldWritesByPrefix,
    claimFreshHeldWrite,
    claimReplayHeldWrite,
    acquireHeldWriteLock,
    hasDurableHeldWrite,
    readLockedHeldWrite,
    canDispatchHeldWrite,
    abortClaimBeforeDispatch,
    tryBeginHeldWrite,
    beginHeldWrite,
    tryPutHeldWrite,
    putHeldWrite,
    setHeldWritePhase,
    updateHeldWritePayload,
    clearHeldWrite,
    clearVerifiedHeldWrite,
    hasPostedReload,
    hasPostedReloadForTarget,
    listPostedReloadRecords,
    clearPostedReload,
    snapshotPostedReloads,
    clearPostedReloadSnapshot,
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
export const hasLiveHeldWriteClaims = defaultStore.hasLiveHeldWriteClaims;
export const hasAnyHeldWrite = defaultStore.hasAnyHeldWrite;
export const listHeldWritesByPrefix = defaultStore.listHeldWritesByPrefix;
export const claimFreshHeldWrite = defaultStore.claimFreshHeldWrite;
export const claimReplayHeldWrite = defaultStore.claimReplayHeldWrite;
export const acquireHeldWriteLock = defaultStore.acquireHeldWriteLock;
export const hasDurableHeldWrite = defaultStore.hasDurableHeldWrite;
export const readLockedHeldWrite = defaultStore.readLockedHeldWrite;
export const canDispatchHeldWrite = defaultStore.canDispatchHeldWrite;
export const abortClaimBeforeDispatch = defaultStore.abortClaimBeforeDispatch;
export const tryBeginHeldWrite = defaultStore.tryBeginHeldWrite;
export const beginHeldWrite = defaultStore.beginHeldWrite;
export const tryPutHeldWrite = defaultStore.tryPutHeldWrite;
export const putHeldWrite = defaultStore.putHeldWrite;
export const setHeldWritePhase = defaultStore.setHeldWritePhase;
export const updateHeldWritePayload = defaultStore.updateHeldWritePayload;
export const clearHeldWrite = defaultStore.clearHeldWrite;
export const clearVerifiedHeldWrite = defaultStore.clearVerifiedHeldWrite;
export const hasPostedReload = defaultStore.hasPostedReload;
export const hasPostedReloadForTarget = defaultStore.hasPostedReloadForTarget;
export const listPostedReloadRecords = defaultStore.listPostedReloadRecords;
export const clearPostedReload = defaultStore.clearPostedReload;
export const snapshotPostedReloads = defaultStore.snapshotPostedReloads;
export const clearPostedReloadSnapshot = defaultStore.clearPostedReloadSnapshot;
export const resetHeldWritesStore = defaultStore.resetHeldWritesStore;
