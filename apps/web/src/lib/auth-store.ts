import type { Session } from '@supabase/supabase-js';
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
import type { AuthStatus } from '@/lib/auth-context';

const LOGOUT_PENDING_KEY_PREFIX = 'theshark:auth:logout-pending:v1:';
const FALLBACK_PROJECT = 'default';
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 30_000;
let logoutAttemptSeq = 0;

function createLogoutAttemptId(): string {
  logoutAttemptSeq += 1;
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `logout-${logoutAttemptSeq}-${crypto.randomUUID()}`;
  }
  return `logout-${logoutAttemptSeq}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function logoutPendingStorageKey(): string {
  let url: string | undefined;
  try {
    url =
      typeof readSupabaseEnv === 'function'
        ? readSupabaseEnv()?.url.trim()
        : undefined;
  } catch {
    url = undefined;
  }
  const project = url && url.length > 0 ? url : FALLBACK_PROJECT;
  return `${LOGOUT_PENDING_KEY_PREFIX}${encodeURIComponent(project)}`;
}

function logoutStorage(): Storage | null {
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

function readPersistedLogoutAttemptId(): string | null {
  const storage = logoutStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(logoutPendingStorageKey());
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function hasPersistedLogoutIntent(): boolean {
  return readPersistedLogoutAttemptId() !== null;
}

type RetainedRevocationSession = {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
};

type PersistLogoutResult = {
  backedByStorage: boolean;
  removedLocalCredentials: boolean;
  removedSession: RetainedRevocationSession | null;
};

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

function supabaseAuthStorageKeys(): string[] {
  const keys = new Set<string>();
  const client = supabase as
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
    const url =
      typeof readSupabaseEnv === 'function'
        ? readSupabaseEnv()?.url.trim()
        : undefined;
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

function readPersistedSupabaseSession(
  storage: Storage,
): RetainedRevocationSession | null {
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

function removePersistedSupabaseCredentials(storage: Storage): void {
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
          baseKeys.some((base) => existing.startsWith(`${base}-code-verifier`))
        ) {
          keysToRemove.add(existing);
        }
      }
    }
  } catch {
    // Ignore storage enumeration errors; still remove direct keys below.
  }
  for (const key of keysToRemove) {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore individual removal errors so remaining keys are still cleared.
    }
  }
}

function persistLogoutIntent(attemptId: string): PersistLogoutResult {
  const storage = logoutStorage();
  if (!storage) {
    return {
      backedByStorage: false,
      removedLocalCredentials: false,
      removedSession: null,
    };
  }
  const key = logoutPendingStorageKey();
  try {
    storage.setItem(key, attemptId);
    return {
      backedByStorage: true,
      removedLocalCredentials: false,
      removedSession: null,
    };
  } catch {
    // Storage rejected the logout marker (e.g. QuotaExceededError). Capture
    // any persisted session in memory for server-side global revocation,
    // remove the persisted Supabase SDK credentials directly so a reload
    // cannot restore the owner session, then retry writing the marker into
    // the freed space.
    const removedSession = readPersistedSupabaseSession(storage);
    removePersistedSupabaseCredentials(storage);
    try {
      storage.setItem(key, attemptId);
      return {
        backedByStorage: true,
        removedLocalCredentials: true,
        removedSession,
      };
    } catch {
      // Keep the in-memory logoutUnresolved guard active even if storage still refuses writes.
      return {
        backedByStorage: readPersistedLogoutAttemptId() === attemptId,
        removedLocalCredentials: true,
        removedSession,
      };
    }
  }
}

function clearPersistedLogoutIntent(expectedAttemptId?: string): void {
  const storage = logoutStorage();
  if (!storage) return;
  const key = logoutPendingStorageKey();
  try {
    if (expectedAttemptId !== undefined) {
      const current = readPersistedLogoutAttemptId();
      if (current !== expectedAttemptId) return;
    }
    storage.removeItem(key);
  } catch {
    // Ignore storage cleanup errors.
  }
}

function isRetainedSessionExpired(session: RetainedRevocationSession): boolean {
  return (
    session.expiresAt !== null &&
    session.expiresAt * 1000 - Date.now() < ACCESS_TOKEN_EXPIRY_MARGIN_MS
  );
}

type AuthClientInternals = {
  url?: unknown;
  headers?: unknown;
  fetch?: unknown;
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
  | { status: 'already_revoked' }
  | { status: 'failed' }
  | { status: 'unavailable' };

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
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    ) {
      return { status: 'already_revoked' };
    }
    return { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
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

function errorNameOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as { name?: unknown }).name === 'string'
  ) {
    return (error as { name: string }).name;
  }
  return '';
}

function isIgnorableServerRevocationError(error: unknown): boolean {
  const status = errorStatusOf(error);
  const name = errorNameOf(error);
  return (
    status === 404 ||
    status === 401 ||
    status === 403 ||
    name === 'AuthSessionMissingError'
  );
}

async function revokeRetainedSessionGlobally(
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
    } else if (refreshResult.status === 'already_revoked') {
      return { ok: true, session: null };
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
      if (!retry.error || isIgnorableServerRevocationError(retry.error)) {
        return { ok: true, session: null };
      }
      return { ok: false, session: active };
    }
    if (refreshResult.status === 'already_revoked') {
      return { ok: true, session: null };
    }
    if (refreshResult.status === 'failed') {
      return { ok: false, session: active };
    }
  }

  if (isIgnorableServerRevocationError(first.error)) {
    return { ok: true, session: null };
  }
  return { ok: false, session: active };
}

type Snapshot = {
  status: AuthStatus;
  email: string | null;
  logoutPending: boolean;
  logoutFailed: boolean;
  logoutRevocationFailed: boolean;
};

let snapshot: Snapshot = {
  status: 'loading',
  email: null,
  logoutPending: false,
  logoutFailed: false,
  logoutRevocationFailed: false,
};
let started = false;
let checkId = 0;
let currentSession: Session | null = null;
let lastUserId: string | null = null;
let pendingSignOuts = 0;
let logoutUnresolved = false;
let logoutBackedByStorage = false;
let logoutRevocationFailed = false;
let pendingRevocationSession: RetainedRevocationSession | null = null;
let signOutRunId = 0;
let activeSignOutAttemptId: string | null = null;
let activeSignOutBackedByStorage = false;
let activeSignOutSuperseded = false;
let storeEpoch = 0;
let pendingSignOutPromise: Promise<void> | null = null;
let pendingRevocationPromise: Promise<void> | null = null;
let unsubscribeAuth: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(
  next: Pick<Snapshot, 'status' | 'email'> &
    Partial<
      Pick<
        Snapshot,
        'logoutPending' | 'logoutFailed' | 'logoutRevocationFailed'
      >
    >,
) {
  const full: Snapshot = {
    status: next.status,
    email: next.email,
    logoutPending: next.logoutPending ?? false,
    logoutFailed: next.logoutFailed ?? false,
    logoutRevocationFailed: next.logoutRevocationFailed ?? false,
  };
  if (
    snapshot.status === full.status &&
    snapshot.email === full.email &&
    snapshot.logoutPending === full.logoutPending &&
    snapshot.logoutFailed === full.logoutFailed &&
    snapshot.logoutRevocationFailed === full.logoutRevocationFailed
  ) {
    return;
  }
  snapshot = full;
  setPwaAuthResolved(
    !logoutUnresolved &&
      !hasPersistedLogoutIntent() &&
      pendingSignOuts === 0 &&
      full.status !== 'loading' &&
      full.status !== 'checking',
  );
  for (const listener of listeners) listener();
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
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

function checkOwner(
  session: Session,
  options?: { keepCurrentOwner?: boolean },
) {
  const client = supabase;
  if (!client) return;
  const id = ++checkId;
  const email = emailOf(session);
  if (options?.keepCurrentOwner && snapshot.status === 'owner') {
    emit({ status: 'owner', email });
  } else {
    emit({ status: 'checking', email });
  }

  // The auth callback holds a lock; defer the owner lookup so it cannot deadlock.
  setTimeout(() => {
    void (async () => {
      const { data, error } = await client.schema('app').rpc('is_owner');
      if (id !== checkId) return;
      if (error || (data !== true && data !== false)) {
        emit({ status: 'error', email });
        return;
      }
      if (data === false) {
        emit({ status: 'denied', email });
        return;
      }
      emit({ status: 'owner', email });
    })();
  }, 0);
}

function reconcileClearedLogoutMarker(): void {
  if (pendingSignOuts > 0) return;
  if (!logoutUnresolved && !snapshot.logoutFailed) return;
  if (!logoutBackedByStorage) return;
  if (hasPersistedLogoutIntent()) return;
  logoutUnresolved = false;
  logoutBackedByStorage = false;
  setPwaLogoutPending(false);
  emit({
    status: 'signed-out',
    email: null,
    logoutPending: pendingRevocationPromise !== null,
    logoutFailed: false,
    logoutRevocationFailed,
  });
  setPwaAuthResolved(
    snapshot.status !== 'loading' && snapshot.status !== 'checking',
  );
}

function reconcilePersistedLogoutFromStorage(): void {
  if (pendingSignOuts > 0) return;
  if (hasPersistedLogoutIntent()) {
    const previousUserId = currentSession?.user.id ?? lastUserId;
    logoutUnresolved = true;
    logoutBackedByStorage = true;
    currentSession = null;
    checkId += 1;
    setWritesLocked(true);
    bumpSessionGeneration();
    if (previousUserId) {
      clearResolvedHeldWritesForUser(previousUserId);
    }
    lastUserId = null;
    setHeldWriteUser(null);
    setPwaLogoutPending(true);
    setPwaAuthResolved(false);
    emit({
      status: 'signed-out',
      email: null,
      logoutPending: false,
      logoutFailed: true,
      logoutRevocationFailed,
    });
    return;
  }
  reconcileClearedLogoutMarker();
}

export function startAuth() {
  if (started) return;
  const client = supabase;
  if (!client) return;
  started = true;
  setHeldWriteUser(null);

  if (hasPersistedLogoutIntent()) {
    // Honor an unfinished or failed logout from a previous document before
    // registering the auth listener so INITIAL_SESSION cannot restore access.
    logoutUnresolved = true;
    logoutBackedByStorage = true;
    currentSession = null;
    setWritesLocked(true);
    setHeldWriteUser(null);
    setPwaLogoutPending(true);
    setPwaAuthResolved(false);
    emit({
      status: 'signed-out',
      email: null,
      logoutPending: false,
      logoutFailed: true,
      logoutRevocationFailed,
    });
  }

  const onStorage = (event: StorageEvent) => {
    const expectedKey = logoutPendingStorageKey();
    if (event.key !== null && event.key !== expectedKey) return;
    const storage = logoutStorage();
    if (event.storageArea && storage && event.storageArea !== storage) return;
    const currentPersistedId = readPersistedLogoutAttemptId();
    if (
      activeSignOutAttemptId !== null &&
      currentPersistedId !== activeSignOutAttemptId
    ) {
      activeSignOutSuperseded = true;
    }
    reconcilePersistedLogoutFromStorage();
  };
  if (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    window.addEventListener('storage', onStorage);
  }

  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((event, session) => {
    const previousSession = currentSession;
    const previousUserId = previousSession?.user.id ?? lastUserId;
    if (!session) {
      currentSession = null;
      setWritesLocked(true);
      bumpSessionGeneration();
      if (event === 'SIGNED_OUT' && previousUserId) {
        // Preserve unresolved per-user pins (inflight/unknown/waiting_for_sync)
        // across sign-out so the same user can verify or replay with the original
        // request id on next sign-in, while other users stay isolated by userId
        // key prefix. Clear only already-committed posted_reload markers.
        clearResolvedHeldWritesForUser(previousUserId);
      }
      lastUserId = null;
      setHeldWriteUser(null);
      checkId += 1;
      const persistedLogout = hasPersistedLogoutIntent();
      if (event === 'SIGNED_OUT' && pendingSignOuts === 0 && !persistedLogout) {
        logoutUnresolved = false;
        logoutBackedByStorage = false;
        setPwaLogoutPending(false);
      } else if (persistedLogout) {
        logoutUnresolved = true;
        logoutBackedByStorage = true;
        setPwaLogoutPending(true);
        if (event === 'SIGNED_OUT' && pendingSignOuts === 0) {
          const epoch = storeEpoch;
          void Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => {
              if (epoch === storeEpoch) {
                reconcileClearedLogoutMarker();
              }
            });
        }
      } else if (pendingSignOuts === 0 && logoutBackedByStorage) {
        logoutUnresolved = false;
        logoutBackedByStorage = false;
        setPwaLogoutPending(false);
      }
      emit({
        status: 'signed-out',
        email: null,
        logoutPending: pendingSignOuts > 0 || pendingRevocationPromise !== null,
        logoutFailed:
          pendingSignOuts === 0 ? logoutUnresolved : snapshot.logoutFailed,
        logoutRevocationFailed,
      });
      setPwaAuthResolved(
        !logoutUnresolved &&
          !hasPersistedLogoutIntent() &&
          pendingSignOuts === 0 &&
          snapshot.status !== 'loading' &&
          snapshot.status !== 'checking',
      );
      return;
    }
    if (
      pendingSignOuts === 0 &&
      logoutBackedByStorage &&
      !hasPersistedLogoutIntent()
    ) {
      // Another tab completed logout and cleared the persisted marker before
      // this tab received a storage event; accept the new session cleanly.
      logoutUnresolved = false;
      logoutBackedByStorage = false;
      setPwaLogoutPending(false);
    }
    const persistedLogout = hasPersistedLogoutIntent();
    if (pendingSignOuts > 0 || logoutUnresolved || persistedLogout) {
      // Local logout has not completed yet: ignore any initial or refocus
      // session event so writes and PWA reload stay locked until logout finishes.
      logoutUnresolved = true;
      const supersededInFlight =
        pendingSignOuts > 0 &&
        (activeSignOutSuperseded ||
          (activeSignOutBackedByStorage && !persistedLogout));
      if (persistedLogout) {
        logoutBackedByStorage = true;
      } else if (!supersededInFlight) {
        const attemptId = activeSignOutAttemptId ?? createLogoutAttemptId();
        const persistResult = persistLogoutIntent(attemptId);
        logoutBackedByStorage = persistResult.backedByStorage;
        if (persistResult.removedLocalCredentials) {
          const retained =
            extractRevocationSession(session) ?? persistResult.removedSession;
          if (retained) {
            pendingRevocationSession = retained;
          }
        }
      }
      currentSession = null;
      setWritesLocked(true);
      setHeldWriteUser(null);
      setPwaLogoutPending(true);
      setPwaAuthResolved(false);
      emit({
        status: 'signed-out',
        email: null,
        logoutPending: pendingSignOuts > 0,
        logoutFailed: pendingSignOuts === 0 ? true : snapshot.logoutFailed,
        logoutRevocationFailed,
      });
      return;
    }
    pendingRevocationSession = null;
    logoutRevocationFailed = false;
    currentSession = session;
    const wasWritesLocked = isWritesLocked();
    const sameSession =
      !wasWritesLocked &&
      isSameAuthenticatedSession(previousSession, session, event);
    lastUserId = session.user.id;
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
    checkOwner(session, { keepCurrentOwner: sameSession });
  });

  unsubscribeAuth = () => {
    subscription.unsubscribe();
    if (
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export function subscribeAuth(listener: () => void) {
  listeners.add(listener);
  startAuth();
  return () => {
    listeners.delete(listener);
  };
}

export function getAuthSnapshot(): Snapshot {
  return snapshot;
}

export function isAuthResolved(): boolean {
  const unresolvedLogout =
    logoutUnresolved && (!logoutBackedByStorage || hasPersistedLogoutIntent());
  return (
    !unresolvedLogout &&
    !hasPersistedLogoutIntent() &&
    pendingSignOuts === 0 &&
    snapshot.status !== 'loading' &&
    snapshot.status !== 'checking'
  );
}

export async function signIn(
  email: string,
  password: string,
): Promise<'ok' | 'invalid'> {
  const client = supabase;
  if (!client) return 'invalid';
  if (pendingSignOutPromise) {
    await pendingSignOutPromise.catch(() => {});
  }
  reconcileClearedLogoutMarker();
  if (logoutUnresolved || hasPersistedLogoutIntent()) {
    return 'invalid';
  }
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return 'invalid';
  return 'ok';
}

export async function retryLogoutRevocation(): Promise<void> {
  const client = supabase;
  if (!client) return;
  if (pendingRevocationPromise) {
    await pendingRevocationPromise;
    return;
  }
  const sessionToRevoke = pendingRevocationSession;
  if (!sessionToRevoke) {
    if (logoutRevocationFailed) {
      logoutRevocationFailed = false;
      emit({
        status: snapshot.status,
        email: snapshot.email,
        logoutPending: snapshot.logoutPending,
        logoutFailed: snapshot.logoutFailed,
        logoutRevocationFailed: false,
      });
    }
    return;
  }
  const epoch = storeEpoch;
  emit({
    status: 'signed-out',
    email: null,
    logoutPending: true,
    logoutFailed: snapshot.logoutFailed,
    logoutRevocationFailed: true,
  });
  let task: Promise<void> | null = null;
  task = (async () => {
    try {
      const revocation = await revokeRetainedSessionGlobally(
        client,
        sessionToRevoke,
      );
      if (epoch !== storeEpoch) return;
      if (revocation.ok) {
        if (pendingRevocationSession === sessionToRevoke) {
          pendingRevocationSession = null;
        }
        logoutRevocationFailed = false;
      } else {
        pendingRevocationSession = revocation.session;
        logoutRevocationFailed = true;
      }
      if (currentSession !== null) {
        return;
      }
      emit({
        status: 'signed-out',
        email: null,
        logoutPending: pendingSignOuts > 0,
        logoutFailed: snapshot.logoutFailed,
        logoutRevocationFailed,
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

export async function signOut() {
  const client = supabase;
  if (!client) return;
  const storage = logoutStorage();
  const hasStoredSdkCreds = hasPersistedSupabaseCredentials(storage);
  if (
    currentSession === null &&
    !logoutUnresolved &&
    !hasPersistedLogoutIntent() &&
    !hasStoredSdkCreds &&
    pendingSignOuts === 0 &&
    pendingRevocationSession !== null
  ) {
    await retryLogoutRevocation();
    return;
  }

  const userId = currentSession?.user.id ?? lastUserId;
  const capturedSession =
    extractRevocationSession(currentSession) ??
    (storage ? readPersistedSupabaseSession(storage) : null) ??
    pendingRevocationSession;

  // Lock all writes and PWA reload immediately and keep them locked until local
  // logout completes without error, ignoring any refocus session callbacks in
  // the interim (including if the SDK fails to remove a retained refresh token).
  // Privacy trade-off: unresolved pins (inflight/unknown/waiting_for_sync) stay
  // durable in localStorage scoped to `(projectUrl, userId)` across sign-out so
  // the same user can verify or replay an ambiguous write with the same request
  // id instead of double-posting it; other users cannot read them through the
  // store because keys are partitioned per user. Only committed `posted_reload`
  // markers are removed on sign-out.
  const runId = ++signOutRunId;
  const attemptId = createLogoutAttemptId();
  const epoch = storeEpoch;
  pendingSignOuts += 1;
  logoutUnresolved = true;
  activeSignOutAttemptId = attemptId;
  activeSignOutSuperseded = false;
  const persistResult = persistLogoutIntent(attemptId);
  logoutBackedByStorage = persistResult.backedByStorage;
  activeSignOutBackedByStorage = persistResult.backedByStorage;

  const sessionForRevocation = capturedSession ?? persistResult.removedSession;
  if (persistResult.removedLocalCredentials && sessionForRevocation) {
    pendingRevocationSession = sessionForRevocation;
  }

  setWritesLocked(true);
  setPwaLogoutPending(true);
  setPwaAuthResolved(false);
  currentSession = null;
  checkId += 1;
  emit({
    status: 'signed-out',
    email: null,
    logoutPending: true,
    logoutFailed: snapshot.logoutFailed,
    logoutRevocationFailed,
  });
  if (userId) {
    clearResolvedHeldWritesForUser(userId);
  }
  lastUserId = null;
  setHeldWriteUser(null);
  let task: Promise<void> | null = null;
  task = (async () => {
    let localSucceeded = false;
    let revocationFailed = false;
    const shouldRunServerRevocation =
      (persistResult.removedLocalCredentials ||
        pendingRevocationSession !== null) &&
      sessionForRevocation !== null;
    try {
      const result = await client.auth.signOut();
      const signOutError =
        result && typeof result === 'object' && 'error' in result
          ? result.error
          : null;
      localSucceeded = !signOutError;
      if (
        !localSucceeded &&
        hasStoredSdkCreds &&
        !hasPersistedSupabaseCredentials(logoutStorage()) &&
        sessionForRevocation
      ) {
        // GoTrueClient removed local credentials even though server logout failed;
        // retain the session in memory so a subsequent retry still revokes globally.
        pendingRevocationSession = sessionForRevocation;
      }
      if (localSucceeded && shouldRunServerRevocation && sessionForRevocation) {
        const revocation = await revokeRetainedSessionGlobally(
          client,
          sessionForRevocation,
        );
        if (epoch === storeEpoch) {
          if (revocation.ok) {
            if (pendingRevocationSession === sessionForRevocation) {
              pendingRevocationSession = null;
            }
            revocationFailed = false;
          } else {
            pendingRevocationSession = revocation.session;
            revocationFailed = true;
          }
        }
      } else if (localSucceeded && epoch === storeEpoch) {
        pendingRevocationSession = null;
        revocationFailed = false;
      }
    } catch {
      localSucceeded = false;
    } finally {
      if (epoch === storeEpoch) {
        pendingSignOuts = Math.max(0, pendingSignOuts - 1);
        if (pendingSignOutPromise === task) {
          pendingSignOutPromise = null;
        }
        const isLatestRun = runId === signOutRunId;
        if (isLatestRun) {
          const currentPersistedId = readPersistedLogoutAttemptId();
          const supersededByStorage =
            activeSignOutSuperseded ||
            (persistResult.backedByStorage &&
              currentPersistedId !== attemptId) ||
            (currentPersistedId !== null && currentPersistedId !== attemptId);
          activeSignOutAttemptId = null;
          activeSignOutBackedByStorage = false;
          activeSignOutSuperseded = false;

          if (localSucceeded) {
            clearPersistedLogoutIntent(attemptId);
            logoutRevocationFailed = revocationFailed;
            const remainingPersistedId = readPersistedLogoutAttemptId();
            if (remainingPersistedId !== null) {
              logoutUnresolved = true;
              logoutBackedByStorage = true;
              setPwaLogoutPending(true);
              setPwaAuthResolved(false);
              emit({
                status: 'signed-out',
                email: null,
                logoutPending: false,
                logoutFailed: true,
                logoutRevocationFailed,
              });
            } else {
              logoutUnresolved = false;
              logoutBackedByStorage = false;
              setPwaLogoutPending(false);
              emit({
                status: 'signed-out',
                email: null,
                logoutPending: false,
                logoutFailed: false,
                logoutRevocationFailed,
              });
              setPwaAuthResolved(isAuthResolved());
            }
          } else if (supersededByStorage) {
            // Another tab's newer attempt already superseded this call; never
            // rewrite the shared marker from an older failed logout.
            if (currentPersistedId === null) {
              logoutUnresolved = false;
              logoutBackedByStorage = false;
              setPwaLogoutPending(false);
              emit({
                status: 'signed-out',
                email: null,
                logoutPending: false,
                logoutFailed: false,
                logoutRevocationFailed,
              });
              setPwaAuthResolved(isAuthResolved());
            } else {
              logoutUnresolved = true;
              logoutBackedByStorage = true;
              setPwaLogoutPending(true);
              setPwaAuthResolved(false);
              emit({
                status: 'signed-out',
                email: null,
                logoutPending: false,
                logoutFailed: true,
                logoutRevocationFailed,
              });
            }
          } else {
            const retryPersist = persistLogoutIntent(attemptId);
            logoutBackedByStorage = retryPersist.backedByStorage;
            if (
              retryPersist.removedLocalCredentials &&
              (sessionForRevocation ?? retryPersist.removedSession)
            ) {
              pendingRevocationSession =
                sessionForRevocation ?? retryPersist.removedSession;
            }
            logoutUnresolved = true;
            currentSession = null;
            setWritesLocked(true);
            setHeldWriteUser(null);
            setPwaLogoutPending(true);
            setPwaAuthResolved(false);
            emit({
              status: 'signed-out',
              email: null,
              logoutPending: false,
              logoutFailed: true,
              logoutRevocationFailed,
            });
          }
        } else if (pendingSignOuts === 0) {
          setPwaAuthResolved(isAuthResolved());
        }
      }
    }
  })();
  pendingSignOutPromise = task;
  await task;
}

export function retryOwnerCheck() {
  const session = currentSession;
  if (!session) return;
  checkOwner(session);
}

export function resetAuthStore(options?: { clearStorage?: boolean }) {
  storeEpoch += 1;
  checkId += 1;
  currentSession = null;
  lastUserId = null;
  pendingSignOuts = 0;
  logoutUnresolved = false;
  logoutBackedByStorage = false;
  logoutRevocationFailed = false;
  pendingRevocationSession = null;
  signOutRunId = 0;
  activeSignOutAttemptId = null;
  activeSignOutBackedByStorage = false;
  activeSignOutSuperseded = false;
  pendingSignOutPromise = null;
  pendingRevocationPromise = null;
  if (options?.clearStorage ?? true) {
    clearPersistedLogoutIntent();
  }
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  started = false;
  snapshot = {
    status: 'loading',
    email: null,
    logoutPending: false,
    logoutFailed: false,
    logoutRevocationFailed: false,
  };
  setPwaLogoutPending(false);
  setPwaAuthResolved(false);
  listeners.clear();
  resetHeldWritesStore({ clearStorage: false, resetUser: true });
}
