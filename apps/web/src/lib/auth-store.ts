import type { Session } from '@supabase/supabase-js';
import type { AuthStatus, LogoutPhase } from '@/lib/auth-context';
import {
  bumpSessionGeneration,
  clearResolvedHeldWritesForUser,
  isWritesLocked,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWriteUser,
  setWritesLocked,
} from '@/lib/held-writes';
import { setPwaAuthResolved, setPwaLogoutPending } from '@/lib/pwa';
import { readSupabaseEnv, supabase } from '@/lib/supabase';

const LOGOUT_COORD_KEY_PREFIX = 'theshark:auth:logout-pending:v1:';
const FALLBACK_PROJECT = 'default';
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 30_000;

let tabIdSeq = 0;

function createTabId(): string {
  tabIdSeq += 1;
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `tab-${tabIdSeq}-${crypto.randomUUID()}`;
  }
  return `tab-${tabIdSeq}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type SharedCoordState =
  'pending' | 'local_failed' | 'completed' | 'revocation_failed' | 'signed_in';

export type SharedLogoutCoord = {
  attemptId: number;
  ownerTabId: string;
  state: SharedCoordState;
  sessionKey: string | null;
};

export type AuthSnapshot = {
  status: AuthStatus;
  email: string | null;
  logoutPhase: LogoutPhase;
  logoutPending: boolean;
  logoutFailed: boolean;
  logoutRevocationFailed: boolean;
  canRetryLogoutRevocation: boolean;
};

type RetainedRevocationSession = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
};

type AuthClientInternals = {
  url?: unknown;
  headers?: unknown;
  fetch?: unknown;
  storageKey?: unknown;
  admin?: {
    url?: unknown;
    headers?: unknown;
    fetch?: unknown;
    signOut?: (
      jwt: string,
      scope?: 'global' | 'local' | 'others',
    ) => Promise<{ data: null; error: unknown }>;
  };
};

type RefreshOutcome =
  | { status: 'refreshed'; session: RetainedRevocationSession }
  | { status: 'failed' }
  | { status: 'unavailable' };

type AuthStoreDeps = {
  getClient: () => typeof supabase;
  getProjectUrl: () => string | undefined;
  getStorage: () => Storage | null;
  addStorageListener: (listener: (event: StorageEvent) => void) => () => void;
  tabId?: string;
  syncGlobalStores?: boolean;
};

type MachineState = {
  status: AuthStatus;
  email: string | null;
  session: Session | null;
  lastUserId: string | null;
  logoutPhase: LogoutPhase;
  knownSeq: number;
  activeAttemptId: number | null;
  backedByStorage: boolean;
  retainedRevocationSession: RetainedRevocationSession | null;
  revokedSessionKey: string | null;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function emailOf(session: Session): string | null {
  return session.user.email ?? null;
}

function decodeBase64UrlUtf8(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  if (typeof atob !== 'function') return null;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function extractJwtSessionId(accessToken: unknown): string | null {
  if (typeof accessToken !== 'string') return null;
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const decoded = decodeBase64UrlUtf8(parts[1]);
  if (decoded === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'session_id' in parsed &&
      typeof (parsed as { session_id?: unknown }).session_id === 'string'
    ) {
      const id = (parsed as { session_id: string }).session_id.trim();
      return id !== '' ? id : null;
    }
  } catch {
    return null;
  }
  return null;
}

function extractRevocationSession(
  source: unknown,
): RetainedRevocationSession | null {
  if (typeof source !== 'object' || source === null) return null;
  const record = source as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_at?: unknown;
    currentSession?: unknown;
  };
  if (
    typeof record.currentSession === 'object' &&
    record.currentSession !== null
  ) {
    const nested = extractRevocationSession(record.currentSession);
    if (nested) return nested;
  }
  const accessToken = nonEmptyString(record.access_token);
  const refreshToken = nonEmptyString(record.refresh_token);
  if (!accessToken && !refreshToken) return null;
  const expiresAt =
    typeof record.expires_at === 'number' && Number.isFinite(record.expires_at)
      ? record.expires_at
      : null;
  return { accessToken, refreshToken, expiresAt };
}

function sessionKeyOf(
  source: RetainedRevocationSession | Session | null | undefined,
): string | null {
  if (!source) return null;
  const accessToken =
    'accessToken' in source
      ? source.accessToken
      : nonEmptyString((source as { access_token?: unknown }).access_token);
  const refreshToken =
    'refreshToken' in source
      ? source.refreshToken
      : nonEmptyString((source as { refresh_token?: unknown }).refresh_token);
  const sid = extractJwtSessionId(accessToken);
  if (sid) return `sid:${sid}`;
  if (refreshToken) return `rt:${refreshToken}`;
  if (accessToken) return `at:${accessToken}`;
  return null;
}

function isSameAuthenticatedSession(
  previous: Session | null,
  next: Session,
  event: string,
): boolean {
  if (!previous) return false;
  if (previous.user.id !== next.user.id) return false;

  const prevSessionId = extractJwtSessionId(previous.access_token);
  const nextSessionId = extractJwtSessionId(next.access_token);
  if (prevSessionId !== null || nextSessionId !== null) {
    return prevSessionId === nextSessionId;
  }

  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
    return true;
  }

  const prevAccess = nonEmptyString(previous.access_token);
  const nextAccess = nonEmptyString(next.access_token);
  const prevRefresh = nonEmptyString(previous.refresh_token);
  const nextRefresh = nonEmptyString(next.refresh_token);
  if (
    prevAccess !== null ||
    nextAccess !== null ||
    prevRefresh !== null ||
    nextRefresh !== null
  ) {
    return prevAccess === nextAccess && prevRefresh === nextRefresh;
  }

  return true;
}

function extractHostname(url: string): string | null {
  if (typeof URL === 'function') {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)/i.exec(url);
  return match?.[1] ?? null;
}

function isBlockingLogoutPhase(phase: LogoutPhase): boolean {
  return (
    phase === 'signing_out' ||
    phase === 'local_failed' ||
    phase === 'retrying_local'
  );
}

function isPwaBlockedByLogout(phase: LogoutPhase): boolean {
  return isBlockingLogoutPhase(phase) || phase === 'retrying_revocation';
}

function isSharedCoordState(value: unknown): value is SharedCoordState {
  return (
    value === 'pending' ||
    value === 'local_failed' ||
    value === 'completed' ||
    value === 'revocation_failed' ||
    value === 'signed_in'
  );
}

function parseSharedCoord(raw: string | null): SharedLogoutCoord | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.attemptId === 'number' &&
      Number.isInteger(record.attemptId) &&
      record.attemptId > 0 &&
      typeof record.ownerTabId === 'string' &&
      record.ownerTabId.length > 0 &&
      isSharedCoordState(record.state)
    ) {
      return {
        attemptId: record.attemptId,
        ownerTabId: record.ownerTabId,
        state: record.state,
        sessionKey:
          typeof record.sessionKey === 'string' && record.sessionKey.length > 0
            ? record.sessionKey
            : null,
      };
    }
    return null;
  } catch {
    // Legacy non-JSON pending marker from an earlier build: fail closed.
    return {
      attemptId: 1,
      ownerTabId: 'legacy',
      state: 'local_failed',
      sessionKey: null,
    };
  }
}

function deriveSnapshot(state: MachineState): AuthSnapshot {
  const logoutPending =
    state.logoutPhase === 'signing_out' ||
    state.logoutPhase === 'retrying_local' ||
    state.logoutPhase === 'retrying_revocation';
  const logoutFailed =
    state.logoutPhase === 'local_failed' ||
    state.logoutPhase === 'retrying_local';
  const logoutRevocationFailed =
    state.logoutPhase === 'revocation_failed' ||
    state.logoutPhase === 'retrying_revocation';
  return {
    status: state.status,
    email: state.email,
    logoutPhase: state.logoutPhase,
    logoutPending,
    logoutFailed,
    logoutRevocationFailed,
    canRetryLogoutRevocation: state.retainedRevocationSession !== null,
  };
}

function isRetainedSessionExpired(session: RetainedRevocationSession): boolean {
  return (
    session.expiresAt !== null &&
    session.expiresAt * 1000 - Date.now() < ACCESS_TOKEN_EXPIRY_MARGIN_MS
  );
}

function errorStatusOf(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

function hasDirectRevocationTransport(
  client: NonNullable<typeof supabase>,
): boolean {
  const auth = client.auth as unknown as AuthClientInternals;
  const hasAdminSignOut = typeof auth.admin?.signOut === 'function';
  const hasUrl =
    typeof auth.url === 'string' || typeof auth.admin?.url === 'string';
  const hasFetch =
    typeof auth.fetch === 'function' || typeof auth.admin?.fetch === 'function';
  return hasAdminSignOut && hasUrl && hasFetch;
}

async function refreshRetainedSessionInMemory(
  client: NonNullable<typeof supabase>,
  session: RetainedRevocationSession,
): Promise<RefreshOutcome> {
  if (!session.refreshToken) return { status: 'unavailable' };
  const auth = client.auth as unknown as AuthClientInternals;
  const rawUrl =
    typeof auth.url === 'string'
      ? auth.url
      : typeof auth.admin?.url === 'string'
        ? auth.admin.url
        : null;
  const fetcher =
    typeof auth.fetch === 'function'
      ? (auth.fetch as typeof fetch)
      : typeof auth.admin?.fetch === 'function'
        ? (auth.admin.fetch as typeof fetch)
        : null;
  if (!rawUrl || !fetcher) return { status: 'unavailable' };

  const rawHeaders =
    typeof auth.headers === 'object' && auth.headers !== null
      ? (auth.headers as Record<string, string>)
      : typeof auth.admin?.headers === 'object' && auth.admin.headers !== null
        ? (auth.admin.headers as Record<string, string>)
        : {};
  const endpoint = `${rawUrl.replace(/\/+$/, '')}/token?grant_type=refresh_token`;

  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        ...rawHeaders,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (response.ok) {
      const payload: unknown = await response.json();
      const refreshed = extractRevocationSession(payload);
      if (refreshed?.accessToken) {
        return {
          status: 'refreshed',
          session: {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? session.refreshToken,
            expiresAt: refreshed.expiresAt,
          },
        };
      }
      return { status: 'failed' };
    }
    // Never treat a rejected refresh token (e.g. 400 refresh_token_not_found)
    // as confirmation that all other sessions were globally revoked (I2).
    return { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

/**
 * Explicitly executes POST /auth/v1/logout?scope=global without touching
 * localStorage or broadcasting SIGNED_OUT.
 *
 * Invariant I2: ONLY a confirmed HTTP 2xx response from global logout counts as
 * ok=true. Refresh failures (including 400 refresh_token_not_found) and non-2xx
 * logout responses (including 401/403/404/503) return ok=false so the UI
 * reports that global revocation was NOT confirmed and offers a retry.
 */
async function revokeSessionGlobally(
  client: NonNullable<typeof supabase>,
  session: RetainedRevocationSession,
): Promise<{ ok: boolean; session: RetainedRevocationSession | null }> {
  const auth = client.auth as unknown as AuthClientInternals;
  const adminSignOut = auth.admin?.signOut;
  if (typeof adminSignOut !== 'function') {
    return { ok: false, session };
  }

  let active = session;
  let refreshed = false;

  if (
    (!active.accessToken || isRetainedSessionExpired(active)) &&
    active.refreshToken
  ) {
    const refreshResult = await refreshRetainedSessionInMemory(client, active);
    if (refreshResult.status === 'refreshed') {
      active = refreshResult.session;
      refreshed = true;
    } else if (refreshResult.status === 'failed') {
      return { ok: false, session: active };
    }
  }

  if (!active.accessToken) {
    return { ok: false, session: active };
  }

  const callAdminSignOut = async (jwt: string): Promise<{ error: unknown }> => {
    try {
      const result = await adminSignOut.call(auth.admin, jwt, 'global');
      const err =
        result && typeof result === 'object' && 'error' in result
          ? result.error
          : null;
      return { error: err };
    } catch (error) {
      return { error };
    }
  };

  const first = await callAdminSignOut(active.accessToken);
  if (!first.error) {
    return { ok: true, session: null };
  }

  const firstStatus = errorStatusOf(first.error);
  if (
    (firstStatus === 401 || firstStatus === 403) &&
    !refreshed &&
    active.refreshToken
  ) {
    const refreshResult = await refreshRetainedSessionInMemory(client, active);
    if (refreshResult.status === 'refreshed') {
      active = refreshResult.session;
      if (!active.accessToken) {
        return { ok: false, session: active };
      }
      const retry = await callAdminSignOut(active.accessToken);
      if (!retry.error) {
        return { ok: true, session: null };
      }
      return { ok: false, session: active };
    }
    return { ok: false, session: active };
  }

  return { ok: false, session: active };
}

function defaultProjectUrl(): string | undefined {
  try {
    return typeof readSupabaseEnv === 'function'
      ? readSupabaseEnv()?.url.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

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

function defaultAddStorageListener(
  listener: (event: StorageEvent) => void,
): () => void {
  if (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    window.addEventListener('storage', listener);
    return () => {
      window.removeEventListener('storage', listener);
    };
  }
  return () => {};
}

export function getLogoutCoordStorageKey(projectUrl?: string): string {
  const url = (projectUrl ?? defaultProjectUrl())?.trim();
  const project = url && url.length > 0 ? url : FALLBACK_PROJECT;
  return `${LOGOUT_COORD_KEY_PREFIX}${encodeURIComponent(project)}`;
}

export function createAuthStore(customDeps?: Partial<AuthStoreDeps>) {
  const deps: AuthStoreDeps = {
    getClient: customDeps?.getClient ?? (() => supabase),
    getProjectUrl: customDeps?.getProjectUrl ?? defaultProjectUrl,
    getStorage: customDeps?.getStorage ?? defaultStorage,
    addStorageListener:
      customDeps?.addStorageListener ?? defaultAddStorageListener,
    tabId: customDeps?.tabId ?? createTabId(),
    syncGlobalStores: customDeps?.syncGlobalStores ?? true,
  };

  const tabId = deps.tabId ?? createTabId();
  const syncGlobal = deps.syncGlobalStores !== false;

  let machine: MachineState = {
    status: 'loading',
    email: null,
    session: null,
    lastUserId: null,
    logoutPhase: 'idle',
    knownSeq: 0,
    activeAttemptId: null,
    backedByStorage: false,
    retainedRevocationSession: null,
    revokedSessionKey: null,
  };
  let snapshot: AuthSnapshot = deriveSnapshot(machine);
  let started = false;
  let checkId = 0;
  let storeEpoch = 0;
  let signInInProgress = false;
  let pendingSignOutPromise: Promise<void> | null = null;
  let pendingRevocationPromise: Promise<void> | null = null;
  let unsubscribeAll: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function coordKey(): string {
    return getLogoutCoordStorageKey(deps.getProjectUrl());
  }

  function supabaseAuthStorageKeys(): string[] {
    const keys = new Set<string>();
    const client = deps.getClient() as
      | ({
          storageKey?: unknown;
          auth?: { storageKey?: unknown };
        } & object)
      | null;
    if (
      typeof client?.storageKey === 'string' &&
      client.storageKey.trim() !== ''
    ) {
      keys.add(client.storageKey.trim());
    }
    if (
      typeof client?.auth?.storageKey === 'string' &&
      client.auth.storageKey.trim() !== ''
    ) {
      keys.add(client.auth.storageKey.trim());
    }
    try {
      const url = deps.getProjectUrl()?.trim();
      if (url) {
        const hostname = extractHostname(url);
        const hostPrefix = hostname?.split('.')[0];
        if (hostPrefix) {
          keys.add(`sb-${hostPrefix}-auth-token`);
        }
      }
    } catch {
      // Ignore malformed env URL.
    }
    return [...keys];
  }

  function readSharedCoord(storage: Storage | null): SharedLogoutCoord | null {
    if (!storage) return null;
    try {
      return parseSharedCoord(storage.getItem(coordKey()));
    } catch {
      return null;
    }
  }

  function readPersistedSupabaseSession(
    storage: Storage | null,
  ): RetainedRevocationSession | null {
    if (!storage) return null;
    for (const key of supabaseAuthStorageKeys()) {
      try {
        const raw = storage.getItem(key);
        if (!raw) continue;
        const parsed: unknown = JSON.parse(raw);
        const extracted = extractRevocationSession(parsed);
        if (extracted) return extracted;
      } catch {
        // Ignore malformed storage entries.
      }
    }
    return null;
  }

  function hasPersistedSupabaseCredentials(storage: Storage | null): boolean {
    if (!storage) return false;
    for (const key of supabaseAuthStorageKeys()) {
      try {
        if (storage.getItem(key) !== null) return true;
      } catch {
        // Ignore storage read errors.
      }
    }
    return false;
  }

  /**
   * Fenced local credential removal: removes Supabase SDK keys ONLY when
   * storage does NOT already hold a different (newer) session.
   */
  function removePersistedSupabaseCredentials(
    storage: Storage,
    expectedSessionKey: string | null,
  ): {
    removed: boolean;
    stillPresentForTarget: boolean;
    skippedNewerSession: boolean;
  } {
    const existingSession = readPersistedSupabaseSession(storage);
    const existingKey = sessionKeyOf(existingSession);
    if (
      expectedSessionKey !== null &&
      existingKey !== null &&
      existingKey !== expectedSessionKey
    ) {
      return {
        removed: false,
        stillPresentForTarget: false,
        skippedNewerSession: true,
      };
    }

    const baseKeys = supabaseAuthStorageKeys();
    const keysToRemove = new Set<string>();
    for (const key of baseKeys) {
      keysToRemove.add(key);
      keysToRemove.add(`${key}-user`);
      keysToRemove.add(`${key}-code-verifier`);
    }
    try {
      if (
        baseKeys.length > 0 &&
        typeof storage.length === 'number' &&
        typeof storage.key === 'function'
      ) {
        for (let i = 0; i < storage.length; i += 1) {
          const existing = storage.key(i);
          if (!existing) continue;
          if (
            baseKeys.some((base) =>
              existing.startsWith(`${base}-code-verifier`),
            )
          ) {
            keysToRemove.add(existing);
          }
        }
      }
    } catch {
      // Ignore enumeration errors; still remove direct keys below.
    }

    for (const key of keysToRemove) {
      try {
        storage.removeItem(key);
      } catch {
        // Ignore individual removal errors; verified below.
      }
    }

    const afterSession = readPersistedSupabaseSession(storage);
    let stillPresentForTarget = false;
    if (afterSession !== null) {
      const afterKey = sessionKeyOf(afterSession);
      if (expectedSessionKey === null || afterKey === expectedSessionKey) {
        stillPresentForTarget = true;
      }
    } else if (hasPersistedSupabaseCredentials(storage)) {
      stillPresentForTarget = true;
    }

    return {
      removed: !stillPresentForTarget,
      stillPresentForTarget,
      skippedNewerSession: false,
    };
  }

  function nextAttemptId(storage: Storage | null): number {
    const persisted = readSharedCoord(storage);
    const base = Math.max(machine.knownSeq, persisted?.attemptId ?? 0);
    const next = base + 1;
    machine.knownSeq = next;
    return next;
  }

  function writeSharedCoord(
    storage: Storage | null,
    next: SharedLogoutCoord,
  ): { written: boolean; superseded: boolean } {
    if (!storage) return { written: false, superseded: false };
    const existing = readSharedCoord(storage);
    if (existing) {
      if (existing.attemptId > next.attemptId) {
        machine.knownSeq = Math.max(machine.knownSeq, existing.attemptId);
        return { written: false, superseded: true };
      }
      if (
        existing.attemptId === next.attemptId &&
        existing.ownerTabId !== next.ownerTabId
      ) {
        machine.knownSeq = Math.max(machine.knownSeq, existing.attemptId);
        return { written: false, superseded: true };
      }
    }
    try {
      storage.setItem(coordKey(), JSON.stringify(next));
      machine.knownSeq = Math.max(machine.knownSeq, next.attemptId);
      return { written: true, superseded: false };
    } catch {
      return { written: false, superseded: false };
    }
  }

  /**
   * Persist logout coordination record; if localStorage rejects the write
   * (e.g. QuotaExceededError), capture the stored session in memory for global
   * revocation, fenced-remove the persisted SDK credentials so reload cannot
   * restore owner access (I1), then retry writing the coord record into the
   * freed space.
   */
  function persistLogoutCoordWithQuotaFallback(
    storage: Storage | null,
    next: SharedLogoutCoord,
    expectedSessionKey: string | null,
  ): {
    written: boolean;
    superseded: boolean;
    removedLocalCredentials: boolean;
    removedSession: RetainedRevocationSession | null;
    stillPresentForTarget: boolean;
  } {
    if (!storage) {
      return {
        written: false,
        superseded: false,
        removedLocalCredentials: false,
        removedSession: null,
        stillPresentForTarget: false,
      };
    }
    const direct = writeSharedCoord(storage, next);
    if (direct.written || direct.superseded) {
      return {
        written: direct.written,
        superseded: direct.superseded,
        removedLocalCredentials: false,
        removedSession: null,
        stillPresentForTarget: false,
      };
    }

    const removedSession = readPersistedSupabaseSession(storage);
    const removal = removePersistedSupabaseCredentials(
      storage,
      expectedSessionKey,
    );
    if (removal.skippedNewerSession) {
      return {
        written: false,
        superseded: true,
        removedLocalCredentials: false,
        removedSession: null,
        stillPresentForTarget: false,
      };
    }

    const retry = writeSharedCoord(storage, next);
    return {
      written: retry.written,
      superseded: retry.superseded,
      removedLocalCredentials: removal.removed,
      removedSession,
      stillPresentForTarget: removal.stillPresentForTarget,
    };
  }

  function clearPersistedCoord(storage: Storage | null): void {
    if (!storage) return;
    try {
      storage.removeItem(coordKey());
    } catch {
      // Ignore storage cleanup errors.
    }
  }

  function syncPwaFlags(): void {
    if (!syncGlobal) return;
    const blockedByLogout = isPwaBlockedByLogout(machine.logoutPhase);
    setPwaLogoutPending(blockedByLogout);
    setPwaAuthResolved(
      !blockedByLogout &&
        machine.status !== 'loading' &&
        machine.status !== 'checking',
    );
  }

  function emit(): void {
    const next = deriveSnapshot(machine);
    const changed =
      snapshot.status !== next.status ||
      snapshot.email !== next.email ||
      snapshot.logoutPhase !== next.logoutPhase ||
      snapshot.logoutPending !== next.logoutPending ||
      snapshot.logoutFailed !== next.logoutFailed ||
      snapshot.logoutRevocationFailed !== next.logoutRevocationFailed ||
      snapshot.canRetryLogoutRevocation !== next.canRetryLogoutRevocation;
    snapshot = next;
    syncPwaFlags();
    if (!changed) return;
    for (const listener of listeners) listener();
  }

  /**
   * Lock writes, bump session generation, and clear ONLY resolved
   * (`posted_reload`) held writes while preserving unresolved per-user pins
   * across sign-out (Invariant I5).
   */
  function lockSessionForSignOut(options?: {
    clearResolvedPins?: boolean;
    retainSessionForRevocation?: boolean;
  }): void {
    const previousUserId = machine.session?.user.id ?? machine.lastUserId;
    if (options?.retainSessionForRevocation && machine.session) {
      const retained = extractRevocationSession(machine.session);
      if (retained) {
        machine.retainedRevocationSession = retained;
      }
    }
    machine.session = null;
    checkId += 1;
    if (syncGlobal) {
      setWritesLocked(true);
      bumpSessionGeneration();
      if (options?.clearResolvedPins && previousUserId) {
        clearResolvedHeldWritesForUser(previousUserId);
      }
      setHeldWriteUser(null);
    }
    machine.lastUserId = null;
  }

  function isAttemptSuperseded(
    attemptId: number,
    targetSessionKey: string | null,
  ): boolean {
    if (machine.knownSeq > attemptId) return true;
    if (machine.activeAttemptId !== attemptId) return true;
    if (machine.session !== null) return true;
    const storage = deps.getStorage();
    const shared = readSharedCoord(storage);
    if (shared) {
      if (shared.attemptId > attemptId) return true;
      if (shared.attemptId === attemptId && shared.ownerTabId !== tabId) {
        return true;
      }
    }
    if (storage && targetSessionKey !== null) {
      const stored = readPersistedSupabaseSession(storage);
      const storedKey = sessionKeyOf(stored);
      if (storedKey !== null && storedKey !== targetSessionKey) return true;
    }
    return false;
  }

  /**
   * Single reconciliation entry point from shared localStorage state into this
   * tab's state machine. Enforces monotonicity (I3) and cross-tab convergence
   * (I1, I2, I4).
   */
  function reconcileFromShared(options?: { sdkKeyRemoved?: boolean }): void {
    const storage = deps.getStorage();
    const shared = readSharedCoord(storage);

    if (shared !== null) {
      if (shared.attemptId < machine.knownSeq) {
        return;
      }
      if (
        shared.attemptId === machine.knownSeq &&
        machine.activeAttemptId === shared.attemptId &&
        shared.ownerTabId === tabId
      ) {
        return;
      }

      machine.knownSeq = shared.attemptId;
      if (
        machine.activeAttemptId !== null &&
        (shared.attemptId > machine.activeAttemptId ||
          shared.ownerTabId !== tabId)
      ) {
        machine.activeAttemptId = null;
      }

      switch (shared.state) {
        case 'pending':
        case 'local_failed': {
          lockSessionForSignOut({
            clearResolvedPins: true,
            retainSessionForRevocation: true,
          });
          machine.status = 'signed-out';
          machine.email = null;
          machine.logoutPhase = 'local_failed';
          machine.backedByStorage = true;
          machine.revokedSessionKey =
            shared.sessionKey ?? machine.revokedSessionKey;
          emit();
          return;
        }
        case 'completed': {
          if (machine.session !== null || machine.lastUserId !== null) {
            lockSessionForSignOut({ clearResolvedPins: true });
          } else {
            checkId += 1;
            if (syncGlobal) {
              setWritesLocked(true);
              setHeldWriteUser(null);
            }
          }
          machine.status = 'signed-out';
          machine.email = null;
          machine.logoutPhase = 'idle';
          machine.backedByStorage = false;
          machine.retainedRevocationSession = null;
          machine.revokedSessionKey = null;
          emit();
          return;
        }
        case 'revocation_failed': {
          if (machine.session !== null || machine.lastUserId !== null) {
            lockSessionForSignOut({
              clearResolvedPins: true,
              retainSessionForRevocation: true,
            });
          } else {
            checkId += 1;
            if (syncGlobal) {
              setWritesLocked(true);
              setHeldWriteUser(null);
            }
          }
          machine.status = 'signed-out';
          machine.email = null;
          machine.logoutPhase = 'revocation_failed';
          machine.backedByStorage = true;
          machine.revokedSessionKey =
            shared.sessionKey ?? machine.revokedSessionKey;
          emit();
          return;
        }
        case 'signed_in': {
          machine.logoutPhase = 'idle';
          machine.backedByStorage = false;
          machine.retainedRevocationSession = null;
          machine.revokedSessionKey = null;
          emit();
          return;
        }
      }
    }

    // shared === null: either never written, cleared externally, or quota-full.
    if (
      machine.activeAttemptId === null &&
      machine.backedByStorage &&
      isBlockingLogoutPhase(machine.logoutPhase)
    ) {
      machine.logoutPhase = 'idle';
      machine.backedByStorage = false;
      machine.revokedSessionKey = null;
      machine.status = 'signed-out';
      machine.email = null;
      emit();
      return;
    }

    // Under 0-byte quota fallback, another tab removed SDK credentials directly
    // without being able to write COORD_KEY. Sign out locally on that signal,
    // retaining the session in memory in case this tab initiates a global
    // revocation retry.
    if (
      options?.sdkKeyRemoved &&
      machine.activeAttemptId === null &&
      !hasPersistedSupabaseCredentials(storage)
    ) {
      if (machine.session !== null || machine.lastUserId !== null) {
        const previousKey = sessionKeyOf(machine.session);
        lockSessionForSignOut({
          clearResolvedPins: true,
          retainSessionForRevocation: true,
        });
        machine.status = 'signed-out';
        machine.email = null;
        if (previousKey) {
          machine.revokedSessionKey = previousKey;
        }
        if (machine.logoutPhase !== 'revocation_failed') {
          machine.logoutPhase = 'idle';
        }
        emit();
      }
    }
  }

  function checkOwner(
    session: Session,
    options?: { keepCurrentOwner?: boolean },
  ): void {
    const client = deps.getClient();
    if (!client) return;
    const id = ++checkId;
    const email = emailOf(session);
    machine.email = email;
    machine.status =
      options?.keepCurrentOwner && machine.status === 'owner'
        ? 'owner'
        : 'checking';
    emit();

    // The auth callback holds a lock; defer the owner lookup so it cannot deadlock.
    setTimeout(() => {
      void (async () => {
        const { data, error } = await client.schema('app').rpc('is_owner');
        if (id !== checkId) return;
        if (error || (data !== true && data !== false)) {
          machine.status = 'error';
          machine.email = email;
          emit();
          return;
        }
        if (data === false) {
          machine.status = 'denied';
          machine.email = email;
          emit();
          return;
        }
        machine.status = 'owner';
        machine.email = email;
        emit();
      })();
    }, 0);
  }

  function commitLogoutResult(
    attemptId: number,
    outcome: {
      localOk: boolean;
      revocationOk: boolean;
      retainedSession: RetainedRevocationSession | null;
      targetSessionKey: string | null;
    },
  ): void {
    if (isAttemptSuperseded(attemptId, outcome.targetSessionKey)) {
      reconcileFromShared();
      return;
    }

    const storage = deps.getStorage();
    machine.activeAttemptId = null;

    if (!outcome.localOk) {
      const retryPersist = persistLogoutCoordWithQuotaFallback(
        storage,
        {
          attemptId,
          ownerTabId: tabId,
          state: 'local_failed',
          sessionKey: outcome.targetSessionKey,
        },
        outcome.targetSessionKey,
      );
      if (retryPersist.superseded) {
        reconcileFromShared();
        return;
      }
      machine.backedByStorage = retryPersist.written;
      machine.logoutPhase = 'local_failed';
      machine.retainedRevocationSession =
        outcome.retainedSession ??
        retryPersist.removedSession ??
        machine.retainedRevocationSession;
      machine.revokedSessionKey = outcome.targetSessionKey;
      machine.session = null;
      machine.status = 'signed-out';
      machine.email = null;
      if (syncGlobal) {
        setWritesLocked(true);
        setHeldWriteUser(null);
      }
      emit();
      return;
    }

    if (outcome.revocationOk) {
      const written = writeSharedCoord(storage, {
        attemptId,
        ownerTabId: tabId,
        state: 'completed',
        sessionKey: null,
      });
      if (written.superseded) {
        reconcileFromShared();
        return;
      }
      machine.logoutPhase = 'idle';
      machine.backedByStorage = false;
      machine.retainedRevocationSession = null;
      machine.revokedSessionKey = null;
      machine.session = null;
      machine.status = 'signed-out';
      machine.email = null;
      emit();
      return;
    }

    const written = writeSharedCoord(storage, {
      attemptId,
      ownerTabId: tabId,
      state: 'revocation_failed',
      sessionKey: outcome.targetSessionKey,
    });
    if (written.superseded) {
      reconcileFromShared();
      return;
    }
    machine.logoutPhase = 'revocation_failed';
    machine.backedByStorage = written.written;
    machine.retainedRevocationSession = outcome.retainedSession;
    machine.revokedSessionKey = outcome.targetSessionKey;
    machine.session = null;
    machine.status = 'signed-out';
    machine.email = null;
    emit();
  }

  function startAuth(): void {
    if (started) return;
    const client = deps.getClient();
    if (!client) return;
    started = true;
    if (syncGlobal) {
      setHeldWriteUser(null);
    }

    // Boot reconciliation BEFORE subscribing to onAuthStateChange so
    // INITIAL_SESSION cannot reopen owner access after a failed/pending logout.
    const storage = deps.getStorage();
    const initialCoord = readSharedCoord(storage);
    if (initialCoord) {
      machine.knownSeq = Math.max(machine.knownSeq, initialCoord.attemptId);
      if (
        initialCoord.state === 'pending' ||
        initialCoord.state === 'local_failed'
      ) {
        const directTransportWithNoCreds =
          hasDirectRevocationTransport(client) &&
          !hasPersistedSupabaseCredentials(storage);
        machine.status = 'signed-out';
        machine.email = null;
        machine.session = null;
        machine.logoutPhase = directTransportWithNoCreds
          ? 'revocation_failed'
          : 'local_failed';
        machine.backedByStorage = true;
        machine.revokedSessionKey = initialCoord.sessionKey;
        if (syncGlobal) {
          setWritesLocked(true);
          setHeldWriteUser(null);
        }
        emit();
      } else if (initialCoord.state === 'revocation_failed') {
        machine.status = 'signed-out';
        machine.email = null;
        machine.session = null;
        machine.logoutPhase = 'revocation_failed';
        machine.backedByStorage = true;
        machine.revokedSessionKey = initialCoord.sessionKey;
        if (syncGlobal) {
          setWritesLocked(true);
          setHeldWriteUser(null);
        }
        emit();
      }
    }

    const onStorage = (event: StorageEvent) => {
      const storage = deps.getStorage();
      if (event.storageArea && storage && event.storageArea !== storage) return;
      const expectedCoordKey = coordKey();
      const sdkKeys = supabaseAuthStorageKeys();
      const isCoordEvent = event.key === null || event.key === expectedCoordKey;
      const isSdkRemoval =
        event.key !== null &&
        sdkKeys.includes(event.key) &&
        event.newValue === null;
      if (!isCoordEvent && !isSdkRemoval) return;
      reconcileFromShared({ sdkKeyRemoved: isSdkRemoval });
    };
    const removeStorageListener = deps.addStorageListener(onStorage);

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => {
      reconcileFromShared();
      const previousSession = machine.session;

      if (!session) {
        lockSessionForSignOut({ clearResolvedPins: event === 'SIGNED_OUT' });
        machine.status = 'signed-out';
        machine.email = null;
        if (
          event === 'SIGNED_OUT' &&
          machine.activeAttemptId === null &&
          isBlockingLogoutPhase(machine.logoutPhase) &&
          machine.backedByStorage
        ) {
          const shared = readSharedCoord(deps.getStorage());
          if (
            shared === null ||
            shared.state === 'completed' ||
            shared.state === 'signed_in'
          ) {
            machine.logoutPhase = 'idle';
            machine.backedByStorage = false;
            machine.revokedSessionKey = null;
          }
        }
        emit();
        return;
      }

      const incomingKey = sessionKeyOf(session);

      // Block incoming session callbacks while local logout is in progress or
      // failed (I1). Never reopen owner access on refocus/reload.
      if (isBlockingLogoutPhase(machine.logoutPhase)) {
        const storage = deps.getStorage();
        const attemptId = machine.activeAttemptId ?? nextAttemptId(storage);
        if (!machine.backedByStorage) {
          const targetKey = machine.revokedSessionKey ?? incomingKey;
          const fallback = persistLogoutCoordWithQuotaFallback(
            storage,
            {
              attemptId,
              ownerTabId: tabId,
              state:
                machine.activeAttemptId !== null ? 'pending' : 'local_failed',
              sessionKey: targetKey,
            },
            targetKey,
          );
          if (fallback.superseded) {
            reconcileFromShared();
          } else {
            machine.backedByStorage = fallback.written;
            if (fallback.removedLocalCredentials) {
              const retained =
                extractRevocationSession(session) ?? fallback.removedSession;
              if (retained) {
                machine.retainedRevocationSession = retained;
              }
            }
          }
        }
        if (isBlockingLogoutPhase(machine.logoutPhase)) {
          machine.session = null;
          machine.status = 'signed-out';
          machine.email = null;
          if (syncGlobal) {
            setWritesLocked(true);
            setHeldWriteUser(null);
          }
          emit();
          return;
        }
      }

      // If local logout completed with unconfirmed global revocation, block
      // stale refocus reconfirmations of the SAME revoked session (I1), while
      // allowing a deliberate sign-in (or any genuinely different session).
      if (
        machine.logoutPhase === 'revocation_failed' &&
        !signInInProgress &&
        machine.revokedSessionKey !== null &&
        incomingKey !== null &&
        incomingKey === machine.revokedSessionKey
      ) {
        const storage = deps.getStorage();
        if (storage) {
          removePersistedSupabaseCredentials(
            storage,
            machine.revokedSessionKey,
          );
        }
        machine.session = null;
        machine.status = 'signed-out';
        machine.email = null;
        if (syncGlobal) {
          setWritesLocked(true);
          setHeldWriteUser(null);
        }
        emit();
        return;
      }

      // Accept valid authenticated session.
      machine.logoutPhase = 'idle';
      machine.activeAttemptId = null;
      machine.backedByStorage = false;
      machine.retainedRevocationSession = null;
      machine.revokedSessionKey = null;
      machine.session = session;
      const wasWritesLocked = syncGlobal ? isWritesLocked() : false;
      const sameSession =
        !wasWritesLocked &&
        isSameAuthenticatedSession(previousSession, session, event);
      machine.lastUserId = session.user.id;
      if (syncGlobal) {
        if (!sameSession) {
          bumpSessionGeneration();
        }
        setWritesLocked(false);
        setHeldWriteUser(session.user.id);
        if (
          !sameSession &&
          !wasWritesLocked &&
          previousSession?.user.id === session.user.id
        ) {
          rehydrateHeldWrites();
        }
      }
      checkOwner(session, { keepCurrentOwner: sameSession });
    });

    unsubscribeAll = () => {
      subscription.unsubscribe();
      removeStorageListener();
    };
  }

  function subscribeAuth(listener: () => void): () => void {
    listeners.add(listener);
    startAuth();
    return () => {
      listeners.delete(listener);
    };
  }

  function getAuthSnapshot(): AuthSnapshot {
    return snapshot;
  }

  function isAuthResolved(): boolean {
    reconcileFromShared();
    return (
      !isPwaBlockedByLogout(machine.logoutPhase) &&
      machine.status !== 'loading' &&
      machine.status !== 'checking'
    );
  }

  async function signIn(
    email: string,
    password: string,
  ): Promise<'ok' | 'invalid'> {
    const client = deps.getClient();
    if (!client) return 'invalid';
    if (pendingSignOutPromise) {
      await pendingSignOutPromise.catch(() => {});
    }
    reconcileFromShared();
    if (isPwaBlockedByLogout(machine.logoutPhase)) {
      return 'invalid';
    }
    const storage = deps.getStorage();
    const sharedBefore = readSharedCoord(storage);
    if (
      sharedBefore?.state === 'pending' ||
      sharedBefore?.state === 'local_failed'
    ) {
      return 'invalid';
    }

    signInInProgress = true;
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return 'invalid';

      const attemptId = nextAttemptId(storage);
      const newSessionKey =
        sessionKeyOf(data?.session) ??
        sessionKeyOf(readPersistedSupabaseSession(storage));
      writeSharedCoord(storage, {
        attemptId,
        ownerTabId: tabId,
        state: 'signed_in',
        sessionKey: newSessionKey,
      });
      machine.logoutPhase = 'idle';
      machine.activeAttemptId = null;
      machine.backedByStorage = false;
      machine.retainedRevocationSession = null;
      machine.revokedSessionKey = null;
      emit();
      return 'ok';
    } finally {
      signInInProgress = false;
    }
  }

  async function retryLogoutRevocation(): Promise<void> {
    const client = deps.getClient();
    if (!client) return;
    if (pendingRevocationPromise) {
      await pendingRevocationPromise;
      return;
    }
    reconcileFromShared();
    const sessionToRevoke = machine.retainedRevocationSession;
    if (!sessionToRevoke) {
      // I2: Never clear logoutRevocationFailed or report success without
      // actually performing global revocation.
      return;
    }

    const storage = deps.getStorage();
    const attemptId = nextAttemptId(storage);
    const epoch = storeEpoch;
    const targetSessionKey =
      sessionKeyOf(sessionToRevoke) ?? machine.revokedSessionKey;
    machine.activeAttemptId = attemptId;
    machine.logoutPhase = 'retrying_revocation';
    machine.status = 'signed-out';
    machine.email = null;
    emit();

    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        const revocation = await revokeSessionGlobally(client, sessionToRevoke);
        if (epoch !== storeEpoch) return;
        commitLogoutResult(attemptId, {
          localOk: true,
          revocationOk: revocation.ok,
          retainedSession: revocation.session,
          targetSessionKey,
        });
      } finally {
        if (epoch === storeEpoch && pendingRevocationPromise === task) {
          pendingRevocationPromise = null;
        }
      }
    })();
    pendingRevocationPromise = task;
    await task;
  }

  async function signOut(): Promise<void> {
    const client = deps.getClient();
    if (!client) return;
    reconcileFromShared();

    const storage = deps.getStorage();
    const hasStoredSdkCreds = hasPersistedSupabaseCredentials(storage);
    if (
      machine.session === null &&
      machine.logoutPhase === 'revocation_failed' &&
      !hasStoredSdkCreds &&
      machine.retainedRevocationSession !== null
    ) {
      await retryLogoutRevocation();
      return;
    }

    const hadUnconfirmedRevocation =
      machine.logoutPhase === 'revocation_failed';
    const capturedSession =
      extractRevocationSession(machine.session) ??
      readPersistedSupabaseSession(storage) ??
      machine.retainedRevocationSession;
    const targetSessionKey =
      sessionKeyOf(capturedSession) ?? machine.revokedSessionKey;
    const attemptId = nextAttemptId(storage);
    const epoch = storeEpoch;

    // Persist monotonic logout attempt before any async work. On quota error,
    // remove persisted SDK credentials immediately so reload cannot restore
    // owner access (I1).
    const persistResult = persistLogoutCoordWithQuotaFallback(
      storage,
      {
        attemptId,
        ownerTabId: tabId,
        state: 'pending',
        sessionKey: targetSessionKey,
      },
      targetSessionKey,
    );
    if (persistResult.superseded) {
      reconcileFromShared();
      return;
    }

    const sessionForRevocation =
      capturedSession ?? persistResult.removedSession;
    const nextPhase: LogoutPhase =
      machine.logoutPhase === 'local_failed' ||
      machine.logoutPhase === 'retrying_local'
        ? 'retrying_local'
        : 'signing_out';

    machine.activeAttemptId = attemptId;
    machine.logoutPhase = nextPhase;
    machine.backedByStorage = persistResult.written;
    machine.revokedSessionKey = targetSessionKey;
    if (sessionForRevocation) {
      machine.retainedRevocationSession = sessionForRevocation;
    }

    // Lock writes and clear only resolved (posted_reload) pins; unresolved pins
    // stay durable per user across sign-out (I5).
    lockSessionForSignOut({ clearResolvedPins: true });
    machine.status = 'signed-out';
    machine.email = null;
    emit();

    let task: Promise<void> | null = null;
    task = (async () => {
      let localOk = false;
      let revocationOk = false;
      let retainedSession: RetainedRevocationSession | null =
        sessionForRevocation;

      try {
        if (hasDirectRevocationTransport(client)) {
          // Real GoTrueClient path:
          // 1. Synchronously fenced-remove local SDK credentials BEFORE any
          //    network wait so a slow/failed logout can NEVER delete a newer
          //    sign-in's credentials (I3) or leave owner signed in on reload
          //    (I1).
          if (storage) {
            const removal = removePersistedSupabaseCredentials(
              storage,
              targetSessionKey,
            );
            if (removal.skippedNewerSession) {
              if (epoch === storeEpoch) reconcileFromShared();
              return;
            }
            localOk = !removal.stillPresentForTarget;
          } else {
            localOk = true;
          }

          // 2. Execute global server revocation directly via admin.signOut
          //    (POST /auth/v1/logout?scope=global) without touching storage.
          if (localOk) {
            if (sessionForRevocation) {
              const revocation = await revokeSessionGlobally(
                client,
                sessionForRevocation,
              );
              revocationOk = revocation.ok;
              retainedSession = revocation.session;
            } else {
              // No session token exists to revoke: only claim success if no
              // unconfirmed session revocation was pending (I2).
              revocationOk =
                !hadUnconfirmedRevocation && targetSessionKey === null;
              retainedSession = null;
            }
          }
        } else {
          // Test/mock client path without GoTrueClient HTTP transport.
          const auth = client.auth as unknown as AuthClientInternals;
          const canUseAdminRevocation =
            persistResult.removedLocalCredentials &&
            typeof auth.admin?.signOut === 'function' &&
            sessionForRevocation !== null;

          const result = await client.auth.signOut();
          const signOutError =
            result && typeof result === 'object' && 'error' in result
              ? result.error
              : null;
          localOk = !signOutError;

          if (localOk && canUseAdminRevocation && sessionForRevocation) {
            const revocation = await revokeSessionGlobally(
              client,
              sessionForRevocation,
            );
            revocationOk = revocation.ok;
            retainedSession = revocation.session;
          } else {
            revocationOk = localOk && !hadUnconfirmedRevocation;
            if (localOk && revocationOk) {
              retainedSession = null;
            }
          }
        }
      } catch {
        localOk = false;
        revocationOk = false;
      } finally {
        if (epoch === storeEpoch) {
          if (pendingSignOutPromise === task) {
            pendingSignOutPromise = null;
          }
          commitLogoutResult(attemptId, {
            localOk,
            revocationOk,
            retainedSession,
            targetSessionKey,
          });
        }
      }
    })();

    pendingSignOutPromise = task;
    await task;
  }

  function retryOwnerCheck(): void {
    const session = machine.session;
    if (!session) return;
    checkOwner(session);
  }

  function resetAuthStore(options?: { clearStorage?: boolean }): void {
    storeEpoch += 1;
    checkId += 1;
    signInInProgress = false;
    pendingSignOutPromise = null;
    pendingRevocationPromise = null;
    if (options?.clearStorage ?? true) {
      clearPersistedCoord(deps.getStorage());
    }
    unsubscribeAll?.();
    unsubscribeAll = null;
    started = false;
    machine = {
      status: 'loading',
      email: null,
      session: null,
      lastUserId: null,
      logoutPhase: 'idle',
      knownSeq: 0,
      activeAttemptId: null,
      backedByStorage: false,
      retainedRevocationSession: null,
      revokedSessionKey: null,
    };
    snapshot = deriveSnapshot(machine);
    if (syncGlobal) {
      setPwaLogoutPending(false);
      setPwaAuthResolved(false);
      resetHeldWritesStore({ clearStorage: false, resetUser: true });
    }
    listeners.clear();
  }

  return {
    startAuth,
    subscribeAuth,
    getAuthSnapshot,
    isAuthResolved,
    signIn,
    signOut,
    retryLogoutRevocation,
    retryOwnerCheck,
    resetAuthStore,
  };
}

const defaultAuthStore = createAuthStore();

export function startAuth(): void {
  defaultAuthStore.startAuth();
}

export function subscribeAuth(listener: () => void): () => void {
  return defaultAuthStore.subscribeAuth(listener);
}

export function getAuthSnapshot(): AuthSnapshot {
  return defaultAuthStore.getAuthSnapshot();
}

export function isAuthResolved(): boolean {
  return defaultAuthStore.isAuthResolved();
}

export function signIn(
  email: string,
  password: string,
): Promise<'ok' | 'invalid'> {
  return defaultAuthStore.signIn(email, password);
}

export function signOut(): Promise<void> {
  return defaultAuthStore.signOut();
}

export function retryLogoutRevocation(): Promise<void> {
  return defaultAuthStore.retryLogoutRevocation();
}

export function retryOwnerCheck(): void {
  defaultAuthStore.retryOwnerCheck();
}

export function resetAuthStore(options?: { clearStorage?: boolean }): void {
  defaultAuthStore.resetAuthStore(options);
}
