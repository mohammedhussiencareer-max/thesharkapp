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
const LOGOUT_COORD_CHANNEL_PREFIX = 'theshark:auth:coord:v1:';
const LOGOUT_LOCK_KEY_PREFIX = 'theshark:auth:logout-lock:v1:';
const FALLBACK_PROJECT = 'default';
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 30_000;
const REVOCATION_REQUEST_TIMEOUT_MS = 10_000;
const PENDING_HEARTBEAT_INTERVAL_MS = 2_000;
const PENDING_LEASE_TTL_MS = 10_000;
const PENDING_LEASE_FUTURE_TOLERANCE_MS = 1_000;
const SDK_SESSION_TOMBSTONE = '';

function monotonicNow(): number {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  ) {
    return performance.now();
  }
  return Date.now();
}

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
  heartbeatAt?: number;
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
  _sessionRemovalEpoch?: unknown;
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

type AuthBroadcastChannel = {
  postMessage: (message: unknown) => void;
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent) => void,
  ) => void;
  removeEventListener: (
    type: 'message',
    listener: (event: MessageEvent) => void,
  ) => void;
  close: () => void;
};

type AuthLockManager = {
  request<T>(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
  ): Promise<T>;
};

type RefreshOutcome =
  | { status: 'refreshed'; session: RetainedRevocationSession }
  | { status: 'failed' }
  | { status: 'unavailable' };

type AuthStoreDeps = {
  getClient: () => typeof supabase;
  getProjectUrl: () => string | undefined;
  getStorage: () => Storage | null;
  /** @deprecated Unused under the single-store localStorage model. */
  getSessionStorage?: () => Storage | null;
  addStorageListener: (listener: (event: StorageEvent) => void) => () => void;
  addVisibilityListener: (listener: () => void) => () => void;
  createBroadcastChannel: (name: string) => AuthBroadcastChannel | null;
  getLocks: () => AuthLockManager | null;
  tabId?: string;
  syncGlobalStores?: boolean;
};

type MachineState = {
  status: AuthStatus;
  email: string | null;
  session: Session | null;
  lastUserId: string | null;
  logoutPhase: LogoutPhase;
  knownCoord: SharedLogoutCoord | null;
  knownSeq: number;
  knownStateRank: number;
  knownOwnerTabId: string | null;
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

function coordStateRank(state: SharedCoordState): number {
  switch (state) {
    case 'pending':
      return 1;
    case 'local_failed':
      return 2;
    case 'revocation_failed':
      return 3;
    case 'completed':
      return 4;
    case 'signed_in':
      return 5;
  }
}

function isDistinctSidSession(
  revokedKey: string | null,
  incomingKey: string | null,
): boolean {
  return (
    revokedKey !== null &&
    incomingKey !== null &&
    revokedKey.startsWith('sid:') &&
    incomingKey.startsWith('sid:') &&
    revokedKey !== incomingKey
  );
}

function isTombstoneOrEmpty(raw: string | null): boolean {
  return raw === null || raw === SDK_SESSION_TOMBSTONE || raw === 'null';
}

function sameSessionCompletedVsUnconfirmed(
  a: SharedLogoutCoord,
  b: SharedLogoutCoord,
): number | null {
  if (
    a.sessionKey === null ||
    b.sessionKey === null ||
    a.sessionKey !== b.sessionKey
  ) {
    return null;
  }
  const aIsCompleted = a.state === 'completed';
  const bIsCompleted = b.state === 'completed';
  if (aIsCompleted === bIsCompleted) return null;
  const otherState = aIsCompleted ? b.state : a.state;
  // Keep 'local_failed' outside this fast path so active local_failed cannot
  // be dropped while sdkKey is still persisted (I1).
  if (otherState === 'pending' || otherState === 'revocation_failed') {
    return aIsCompleted ? 1 : -1;
  }
  return null;
}

/**
 * Single ordering rule for the one shared localStorage coord record:
 * - For the same non-null sessionKey, confirmed `completed` beats `pending` and
 *   `revocation_failed`.
 * - Otherwise, higher `attemptId` wins, then higher `coordStateRank(state)`.
 */
function compareSharedCoord(
  a: SharedLogoutCoord,
  b: SharedLogoutCoord,
): number {
  const sameSessionCompleted = sameSessionCompletedVsUnconfirmed(a, b);
  if (sameSessionCompleted !== null) return sameSessionCompleted;
  if (a.attemptId !== b.attemptId) return a.attemptId - b.attemptId;
  return coordStateRank(a.state) - coordStateRank(b.state);
}

function parseSharedCoordRecord(value: unknown): SharedLogoutCoord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.attemptId === 'number' &&
    Number.isInteger(record.attemptId) &&
    record.attemptId > 0 &&
    typeof record.ownerTabId === 'string' &&
    record.ownerTabId.length > 0 &&
    isSharedCoordState(record.state)
  ) {
    const parsed: SharedLogoutCoord = {
      attemptId: record.attemptId,
      ownerTabId: record.ownerTabId,
      state: record.state,
      sessionKey:
        typeof record.sessionKey === 'string' && record.sessionKey.length > 0
          ? record.sessionKey
          : null,
    };
    if (
      record.state === 'pending' &&
      typeof record.heartbeatAt === 'number' &&
      Number.isFinite(record.heartbeatAt) &&
      record.heartbeatAt > 0
    ) {
      parsed.heartbeatAt = record.heartbeatAt;
    }
    return parsed;
  }
  return null;
}

function leaseRemainingMs(coord: SharedLogoutCoord, now = Date.now()): number {
  if (coord.state !== 'pending') return 0;
  if (
    typeof coord.heartbeatAt !== 'number' ||
    !Number.isFinite(coord.heartbeatAt)
  ) {
    // Legacy or synthetic pending record without an owner lease is immediately eligible.
    return 0;
  }
  const rawRemaining = coord.heartbeatAt + PENDING_LEASE_TTL_MS - now;
  if (rawRemaining <= 0) return 0;
  // Clamp to [0, PENDING_LEASE_TTL_MS] so a backward wall-clock jump (future
  // heartbeatAt) can never wait beyond TTL or overflow 32-bit setTimeout (P2-1).
  if (coord.heartbeatAt - now > PENDING_LEASE_FUTURE_TOLERANCE_MS) {
    return PENDING_LEASE_TTL_MS;
  }
  return Math.min(PENDING_LEASE_TTL_MS, rawRemaining);
}

function parseSharedCoord(raw: string | null): SharedLogoutCoord | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const valid = parseSharedCoordRecord(parsed);
    if (valid) return valid;
    // Legacy non-object / malformed pending marker (e.g. '1') from an earlier build: fail closed.
    return {
      attemptId: 1,
      ownerTabId: 'legacy',
      state: 'local_failed',
      sessionKey: null,
    };
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
  const canRetryLogoutRevocation =
    (state.logoutPhase === 'revocation_failed' ||
      state.logoutPhase === 'retrying_revocation') &&
    state.retainedRevocationSession !== null &&
    (state.revokedSessionKey === null ||
      sessionKeyOf(state.retainedRevocationSession) ===
        state.revokedSessionKey);
  return {
    status: state.status,
    email: state.email,
    logoutPhase: state.logoutPhase,
    logoutPending,
    logoutFailed,
    logoutRevocationFailed,
    canRetryLogoutRevocation,
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

function classifySignInError(error: unknown): 'invalid' | 'failed' {
  if (typeof error !== 'object' || error === null) return 'failed';
  const record = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (
    record.name === 'AuthRetryableFetchError' ||
    record.name === 'AuthUnknownError'
  ) {
    return 'failed';
  }
  const status = errorStatusOf(error);
  if (status !== null && status !== 400) {
    return 'failed';
  }
  if (typeof record.code === 'string' && record.code.trim().length > 0) {
    return record.code.trim() === 'invalid_credentials' ? 'invalid' : 'failed';
  }
  if (
    typeof record.message === 'string' &&
    /invalid\s+(?:login\s+)?credentials/i.test(record.message)
  ) {
    return 'invalid';
  }
  return 'failed';
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

type DirectRevocationTransport = {
  rawUrl: string;
  fetcher: typeof fetch;
  rawHeaders: Record<string, string>;
};

function readDirectRevocationTransport(
  client: NonNullable<typeof supabase>,
): DirectRevocationTransport | null {
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
  if (!rawUrl || !fetcher) return null;
  const rawHeaders =
    typeof auth.headers === 'object' && auth.headers !== null
      ? (auth.headers as Record<string, string>)
      : typeof auth.admin?.headers === 'object' && auth.admin.headers !== null
        ? (auth.admin.headers as Record<string, string>)
        : {};
  return { rawUrl, fetcher, rawHeaders };
}

function buildBearerHeaders(
  rawHeaders: Record<string, string>,
  jwt: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (key.toLowerCase() === 'authorization') continue;
    headers[key] = value;
  }
  headers.Authorization = `Bearer ${jwt}`;
  return headers;
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function refreshRetainedSessionInMemory(
  client: NonNullable<typeof supabase>,
  session: RetainedRevocationSession,
  signal?: AbortSignal,
): Promise<RefreshOutcome> {
  if (!session.refreshToken) return { status: 'unavailable' };
  if (signal?.aborted) return { status: 'failed' };
  const transport = readDirectRevocationTransport(client);
  if (!transport) return { status: 'unavailable' };

  const endpoint = `${transport.rawUrl.replace(/\/+$/, '')}/token?grant_type=refresh_token`;

  try {
    const response = await raceWithAbort(
      transport.fetcher(endpoint, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          ...transport.rawHeaders,
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
        signal,
      }),
      signal,
    );
    if (signal?.aborted) return { status: 'failed' };
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
 * Bounded by REVOCATION_REQUEST_TIMEOUT_MS (<= PENDING_LEASE_TTL_MS) via
 * AbortController so a slow in-flight global logout is aborted before any
 * no-locks lease expiry can unblock a fresh sign-in (P1-4 / I3).
 *
 * Invariant I2: ONLY a confirmed HTTP 2xx response from global logout counts as
 * ok=true. Refresh failures (including 400 refresh_token_not_found), aborts,
 * and non-2xx logout responses (including 401/403/404/503) return ok=false so
 * the UI reports that global revocation was NOT confirmed and offers a retry.
 */
async function revokeSessionGlobally(
  client: NonNullable<typeof supabase>,
  session: RetainedRevocationSession,
  externalSignal?: AbortSignal,
): Promise<{ ok: boolean; session: RetainedRevocationSession | null }> {
  const auth = client.auth as unknown as AuthClientInternals;
  const transport = readDirectRevocationTransport(client);
  const adminSignOut = auth.admin?.signOut;
  if (!transport && typeof adminSignOut !== 'function') {
    return { ok: false, session };
  }
  if (externalSignal?.aborted) {
    return { ok: false, session };
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REVOCATION_REQUEST_TIMEOUT_MS);

  let active = session;
  let refreshed = false;

  try {
    if (
      (!active.accessToken || isRetainedSessionExpired(active)) &&
      active.refreshToken
    ) {
      const refreshResult = await refreshRetainedSessionInMemory(
        client,
        active,
        controller.signal,
      );
      if (refreshResult.status === 'refreshed') {
        active = refreshResult.session;
        refreshed = true;
      } else if (refreshResult.status === 'failed') {
        return { ok: false, session: active };
      }
    }

    if (controller.signal.aborted || !active.accessToken) {
      return { ok: false, session: active };
    }

    const callGlobalLogout = async (
      jwt: string,
    ): Promise<{ error: unknown }> => {
      if (controller.signal.aborted) {
        return { error: new DOMException('Aborted', 'AbortError') };
      }
      try {
        if (transport) {
          const endpoint = `${transport.rawUrl.replace(/\/+$/, '')}/logout?scope=global`;
          const response = await raceWithAbort(
            transport.fetcher(endpoint, {
              method: 'POST',
              cache: 'no-store',
              headers: buildBearerHeaders(transport.rawHeaders, jwt),
              signal: controller.signal,
            }),
            controller.signal,
          );
          if (response.ok) {
            return { error: null };
          }
          return { error: { status: response.status } };
        }
        const result = await raceWithAbort(
          Promise.resolve(adminSignOut!.call(auth.admin, jwt, 'global')),
          controller.signal,
        );
        const err =
          result && typeof result === 'object' && 'error' in result
            ? result.error
            : null;
        return { error: err };
      } catch (error) {
        return { error };
      }
    };

    const first = await callGlobalLogout(active.accessToken);
    if (!first.error) {
      return { ok: true, session: null };
    }
    if (controller.signal.aborted) {
      return { ok: false, session: active };
    }

    const firstStatus = errorStatusOf(first.error);
    if (
      (firstStatus === 401 || firstStatus === 403) &&
      !refreshed &&
      active.refreshToken
    ) {
      const refreshResult = await refreshRetainedSessionInMemory(
        client,
        active,
        controller.signal,
      );
      if (refreshResult.status === 'refreshed') {
        active = refreshResult.session;
        if (controller.signal.aborted || !active.accessToken) {
          return { ok: false, session: active };
        }
        const retry = await callGlobalLogout(active.accessToken);
        if (!retry.error) {
          return { ok: true, session: null };
        }
        return { ok: false, session: active };
      }
      return { ok: false, session: active };
    }

    return { ok: false, session: active };
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
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

function defaultAddVisibilityListener(listener: () => void): () => void {
  if (
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        listener();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }
  return () => {};
}

function defaultCreateBroadcastChannel(
  name: string,
): AuthBroadcastChannel | null {
  try {
    if (typeof globalThis.BroadcastChannel === 'function') {
      return new globalThis.BroadcastChannel(name);
    }
    return null;
  } catch {
    return null;
  }
}

function defaultLocks(): AuthLockManager | null {
  try {
    if (typeof navigator === 'undefined') return null;
    const candidate = (navigator as unknown as { locks?: unknown }).locks;
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { request?: unknown }).request === 'function'
    ) {
      return candidate as AuthLockManager;
    }
    return null;
  } catch {
    return null;
  }
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
    addVisibilityListener:
      customDeps?.addVisibilityListener ?? defaultAddVisibilityListener,
    createBroadcastChannel:
      customDeps?.createBroadcastChannel ?? defaultCreateBroadcastChannel,
    getLocks: customDeps?.getLocks ?? defaultLocks,
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
    knownCoord: null,
    knownSeq: 0,
    knownStateRank: 0,
    knownOwnerTabId: null,
    activeAttemptId: null,
    backedByStorage: false,
    retainedRevocationSession: null,
    revokedSessionKey: null,
  };
  let snapshot: AuthSnapshot = deriveSnapshot(machine);
  let started = false;
  let checkId = 0;
  let storeEpoch = 0;
  let signInInProgressCount = 0;
  let signInRejectedOwnSession: { session: Session; error: unknown } | null =
    null;
  let watchedPendingKey: string | null = null;
  let pendingWatchedCoord: SharedLogoutCoord | null = null;
  let watchedLeaseObservedAt: number | null = null;
  let pendingLockProbeKey: string | null = null;
  let pendingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAllocatedAttemptId = 0;
  let activeAttemptRotatedSession: {
    attemptId: number;
    session: RetainedRevocationSession;
  } | null = null;
  let pendingSignOutPromise: Promise<void> | null = null;
  let activeSignOutTargetKey: string | null = null;
  let pendingRevocationPromise: Promise<void> | null = null;
  let broadcastChannel: AuthBroadcastChannel | null = null;
  const activeAttemptLockReleases = new Set<() => void>();
  const activeHeartbeatStops = new Set<() => void>();
  const activeRevocationAbortControllers = new Set<AbortController>();
  let unsubscribeAll: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function stopAllHeartbeats(): void {
    for (const stop of [...activeHeartbeatStops]) {
      stop();
    }
    activeHeartbeatStops.clear();
  }

  function abortInFlightRevocations(): void {
    for (const controller of [...activeRevocationAbortControllers]) {
      controller.abort();
    }
    activeRevocationAbortControllers.clear();
  }

  async function runBoundedRevocation(
    client: NonNullable<typeof supabase>,
    session: RetainedRevocationSession,
  ): Promise<{ ok: boolean; session: RetainedRevocationSession | null }> {
    const controller = new AbortController();
    activeRevocationAbortControllers.add(controller);
    try {
      return await revokeSessionGlobally(client, session, controller.signal);
    } finally {
      activeRevocationAbortControllers.delete(controller);
    }
  }

  function coordKey(): string {
    return getLogoutCoordStorageKey(deps.getProjectUrl());
  }

  function coordChannelName(): string {
    const url = deps.getProjectUrl()?.trim();
    const project = url && url.length > 0 ? url : FALLBACK_PROJECT;
    return `${LOGOUT_COORD_CHANNEL_PREFIX}${encodeURIComponent(project)}`;
  }

  function logoutAttemptLockKey(attemptId: number, ownerTabId: string): string {
    const url = deps.getProjectUrl()?.trim();
    const project = url && url.length > 0 ? url : FALLBACK_PROJECT;
    return `${LOGOUT_LOCK_KEY_PREFIX}${encodeURIComponent(project)}:${attemptId}:${encodeURIComponent(ownerTabId)}`;
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

  /** Stateless cross-tab nudge telling sibling tabs to re-read localStorage. */
  function postReconcileNudge(): void {
    try {
      broadcastChannel?.postMessage({ type: 'reconcile', senderTabId: tabId });
    } catch {
      // Ignore BroadcastChannel post errors.
    }
  }

  function bumpClientSessionRemovalEpoch(): void {
    const client = deps.getClient();
    if (!client) return;
    const auth = client.auth as unknown as AuthClientInternals;
    if (typeof auth._sessionRemovalEpoch === 'number') {
      auth._sessionRemovalEpoch += 1;
    }
  }

  function readPersistedSupabaseSession(
    storage: Storage | null,
  ): RetainedRevocationSession | null {
    if (!storage) return null;
    for (const key of supabaseAuthStorageKeys()) {
      try {
        const raw = storage.getItem(key);
        if (isTombstoneOrEmpty(raw)) continue;
        const parsed: unknown = JSON.parse(raw!);
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
        if (!isTombstoneOrEmpty(storage.getItem(key))) return true;
      } catch {
        // Ignore storage read errors.
      }
    }
    return false;
  }

  /**
   * Fenced local credential removal: removes Supabase SDK keys ONLY when
   * storage does NOT already hold a different (newer) session. If removeItem
   * throws, attempts to overwrite with a tiny tombstone ('') that GoTrueClient
   * treats as no session.
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
        // If removeItem throws, try shrinking/overwriting with a tiny tombstone
        // value ('') that GoTrueClient treats as no session.
        try {
          if (!isTombstoneOrEmpty(storage.getItem(key))) {
            storage.setItem(key, SDK_SESSION_TOMBSTONE);
          }
        } catch {
          // Both removeItem and tombstone overwrite failed; verified below.
        }
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

    if (!stillPresentForTarget) {
      bumpClientSessionRemovalEpoch();
    }

    return {
      removed: !stillPresentForTarget,
      stillPresentForTarget,
      skippedNewerSession: false,
    };
  }

  function nextAttemptId(storage: Storage | null): number {
    const existing = readSharedCoord(storage);
    const base = Math.max(
      lastAllocatedAttemptId,
      machine.knownSeq,
      existing?.attemptId ?? 0,
    );
    const next = base + 1;
    lastAllocatedAttemptId = next;
    return next;
  }

  function resetKnownCoord(): void {
    machine.knownCoord = null;
    machine.knownSeq = 0;
    machine.knownStateRank = 0;
    machine.knownOwnerTabId = null;
  }

  function recordKnownCoord(coord: SharedLogoutCoord): void {
    if (
      machine.knownCoord === null ||
      compareSharedCoord(coord, machine.knownCoord) >= 0
    ) {
      machine.knownCoord = coord;
      machine.knownSeq = coord.attemptId;
      machine.knownStateRank = coordStateRank(coord.state);
      machine.knownOwnerTabId = coord.ownerTabId;
    }
  }

  function writeSharedCoord(
    storage: Storage | null,
    next: SharedLogoutCoord,
  ): { written: boolean; superseded: boolean } {
    const nextRank = coordStateRank(next.state);
    if (machine.knownCoord !== null) {
      const known = machine.knownCoord;
      const cmpKnown = compareSharedCoord(known, next);
      if (
        cmpKnown > 0 ||
        (cmpKnown === 0 &&
          known.attemptId === next.attemptId &&
          known.ownerTabId !== next.ownerTabId &&
          coordStateRank(known.state) >= nextRank)
      ) {
        return { written: false, superseded: true };
      }
    }
    const existing = readSharedCoord(storage);
    if (existing !== null) {
      // P1-1: Never call recordKnownCoord(existing) on a lost write race —
      // let the caller's reconcileFromShared() observe existing and apply it.
      const cmpExisting = compareSharedCoord(existing, next);
      if (
        cmpExisting > 0 ||
        (cmpExisting === 0 &&
          existing.attemptId === next.attemptId &&
          existing.ownerTabId !== next.ownerTabId &&
          coordStateRank(existing.state) >= nextRank)
      ) {
        return { written: false, superseded: true };
      }
    }
    if (!storage) {
      postReconcileNudge();
      return { written: false, superseded: false };
    }
    try {
      storage.setItem(coordKey(), JSON.stringify(next));
      recordKnownCoord(next);
      postReconcileNudge();
      return { written: true, superseded: false };
    } catch {
      // If completed or signed_in hits quota-full while an older coord sits in
      // localStorage, remove the stale coord so tabs never observe stale state.
      if (next.state === 'completed' || next.state === 'signed_in') {
        const existingLocal = readSharedCoord(storage);
        if (
          existingLocal !== null &&
          compareSharedCoord(next, existingLocal) > 0
        ) {
          try {
            storage.removeItem(coordKey());
            resetKnownCoord();
          } catch {
            // Ignore storage removal errors.
          }
          try {
            storage.setItem(coordKey(), JSON.stringify(next));
            recordKnownCoord(next);
            postReconcileNudge();
            return { written: true, superseded: false };
          } catch {
            // Quota-full: keep stale localStorage coord removed; continue in memory.
          }
        }
      }
      postReconcileNudge();
      return { written: false, superseded: false };
    }
  }

  /**
   * Persist logout coordination record; if localStorage rejects the write
   * (e.g. QuotaExceededError), capture the stored session in memory for global
   * revocation, fenced-remove (or tombstone) the persisted SDK credentials so
   * reload cannot restore owner access (I1), then retry writing the coord
   * record into the freed space.
   */
  function persistLogoutCoordWithQuotaFallback(
    storage: Storage | null,
    next: SharedLogoutCoord,
    expectedSessionKey: string | null,
  ): {
    written: boolean;
    superseded: boolean;
    skippedNewerSession: boolean;
    removedLocalCredentials: boolean;
    removedSession: RetainedRevocationSession | null;
    stillPresentForTarget: boolean;
  } {
    if (!storage) {
      return {
        written: false,
        superseded: false,
        skippedNewerSession: false,
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
        skippedNewerSession: false,
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
      if (next.state === 'pending' && next.ownerTabId === tabId) {
        cleanupDanglingPendingCoord(storage, next.attemptId);
      }
      return {
        written: false,
        superseded: true,
        skippedNewerSession: true,
        removedLocalCredentials: false,
        removedSession: null,
        stillPresentForTarget: false,
      };
    }

    const retry = writeSharedCoord(storage, next);
    if (!retry.written && !retry.superseded) {
      const existingLocal = readSharedCoord(storage);
      if (existingLocal?.state === 'signed_in') {
        try {
          storage.removeItem(coordKey());
          resetKnownCoord();
        } catch {
          // Ignore storage removal errors.
        }
      }
      postReconcileNudge();
    }
    return {
      written: retry.written,
      superseded: retry.superseded,
      skippedNewerSession: false,
      removedLocalCredentials: removal.removed,
      removedSession,
      stillPresentForTarget: removal.stillPresentForTarget,
    };
  }

  function cleanupDanglingPendingCoord(
    storage: Storage | null,
    attemptId: number,
  ): void {
    if (!storage) return;
    const existing = readSharedCoord(storage);
    if (
      existing !== null &&
      existing.attemptId === attemptId &&
      existing.ownerTabId === tabId &&
      existing.state === 'pending'
    ) {
      try {
        storage.removeItem(coordKey());
        if (
          machine.knownCoord !== null &&
          machine.knownCoord.attemptId === attemptId &&
          machine.knownCoord.ownerTabId === tabId &&
          machine.knownCoord.state === 'pending'
        ) {
          resetKnownCoord();
        }
      } catch {
        // Ignore storage cleanup errors.
      }
    }
  }

  function refreshPendingLease(
    storage: Storage | null,
    coord: SharedLogoutCoord,
  ): boolean {
    if (!storage) return false;
    const currentLocal = readSharedCoord(storage);
    if (
      currentLocal === null ||
      currentLocal.attemptId !== coord.attemptId ||
      currentLocal.ownerTabId !== coord.ownerTabId ||
      currentLocal.state !== 'pending'
    ) {
      return false;
    }
    const updated: SharedLogoutCoord = {
      ...coord,
      heartbeatAt: Date.now(),
    };
    try {
      storage.setItem(coordKey(), JSON.stringify(updated));
    } catch {
      return true;
    }
    postReconcileNudge();
    return true;
  }

  function pendingWatchKeyOf(coord: {
    attemptId: number;
    ownerTabId: string;
  }): string {
    return `${coord.attemptId}:${coord.ownerTabId}`;
  }

  function clearPendingAbandonmentWatch(expected?: {
    attemptId: number;
    ownerTabId: string;
  }): void {
    if (
      expected !== undefined &&
      watchedPendingKey !== pendingWatchKeyOf(expected)
    ) {
      return;
    }
    if (pendingFallbackTimer !== null) {
      clearTimeout(pendingFallbackTimer);
      pendingFallbackTimer = null;
    }
    watchedPendingKey = null;
    pendingWatchedCoord = null;
    watchedLeaseObservedAt = null;
    pendingLockProbeKey = null;
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
    if (machine.activeAttemptId !== attemptId) return true;
    if (machine.session !== null) return true;
    const baseline: SharedLogoutCoord = {
      attemptId,
      ownerTabId: tabId,
      state: 'pending',
      sessionKey: targetSessionKey,
    };
    if (machine.knownCoord !== null) {
      const isOwnAttempt =
        machine.knownCoord.attemptId === attemptId &&
        machine.knownCoord.ownerTabId === tabId;
      if (
        !isOwnAttempt &&
        compareSharedCoord(machine.knownCoord, baseline) > 0
      ) {
        return true;
      }
    }
    const storage = deps.getStorage();
    const shared = readSharedCoord(storage);
    if (shared !== null) {
      if (shared.attemptId === attemptId && shared.ownerTabId !== tabId) {
        return true;
      }
      const isOwnAttempt =
        shared.attemptId === attemptId && shared.ownerTabId === tabId;
      if (!isOwnAttempt && compareSharedCoord(shared, baseline) > 0) {
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

  function hasAdvancedPastWatchedCoord(
    candidate: SharedLogoutCoord | null,
    watched: SharedLogoutCoord,
  ): boolean {
    if (!candidate) return false;
    const samePending =
      candidate.state === 'pending' &&
      candidate.attemptId === watched.attemptId &&
      candidate.ownerTabId === watched.ownerTabId &&
      candidate.sessionKey === watched.sessionKey;
    if (samePending) return false;
    return compareSharedCoord(candidate, watched) > 0;
  }

  function promoteAbandonedPending(
    coord: SharedLogoutCoord,
    epoch: number,
  ): void {
    if (epoch !== storeEpoch || coord.ownerTabId === tabId) return;
    if (
      machine.session !== null ||
      hasAdvancedPastWatchedCoord(machine.knownCoord, coord)
    ) {
      clearPendingAbandonmentWatch(coord);
      reconcileFromShared();
      return;
    }
    const latestStorage = deps.getStorage();
    const latest = readSharedCoord(latestStorage);
    if (
      latest === null &&
      machine.backedByStorage &&
      !hasPersistedSupabaseCredentials(latestStorage)
    ) {
      clearPendingAbandonmentWatch(coord);
      reconcileFromShared();
      return;
    }
    if (hasAdvancedPastWatchedCoord(latest, coord)) {
      clearPendingAbandonmentWatch(coord);
      reconcileFromShared();
      return;
    }
    const persistedKey = sessionKeyOf(
      readPersistedSupabaseSession(latestStorage),
    );
    if (
      persistedKey !== null &&
      coord.sessionKey !== null &&
      persistedKey !== coord.sessionKey
    ) {
      // P1-3: A newer session already replaced the pending logout's session.
      clearPendingAbandonmentWatch(coord);
      if (isBlockingLogoutPhase(machine.logoutPhase)) {
        machine.logoutPhase = 'idle';
        machine.backedByStorage = false;
        machine.revokedSessionKey = null;
        emit();
      }
      reconcileFromShared();
      return;
    }

    const credsStillPresent = hasPersistedSupabaseCredentials(latestStorage);
    if (credsStillPresent) {
      // P1-2 / P2-1: Promote IN PLACE at coord.attemptId to local_failed so a
      // reloaded or sibling tab is never deadlocked if creds remain/return, and
      // a delayed completed(coord.attemptId) still outranks and heals.
      clearPendingAbandonmentWatch(coord);
      const written = writeSharedCoord(latestStorage, {
        attemptId: coord.attemptId,
        ownerTabId: tabId,
        state: 'local_failed',
        sessionKey: coord.sessionKey,
      });
      if (written.superseded) {
        reconcileFromShared();
        return;
      }
      machine.status = 'signed-out';
      machine.email = null;
      machine.session = null;
      machine.activeAttemptId = null;
      machine.logoutPhase = 'local_failed';
      machine.backedByStorage = written.written;
      machine.revokedSessionKey = coord.sessionKey;
      if (syncGlobal) {
        setWritesLocked(true);
        setHeldWriteUser(null);
      }
      emit();
      return;
    }

    // P1-2: Promote IN PLACE at coord.attemptId (rank 3 < completed rank 4).
    clearPendingAbandonmentWatch(coord);
    const written = writeSharedCoord(latestStorage, {
      attemptId: coord.attemptId,
      ownerTabId: tabId,
      state: 'revocation_failed',
      sessionKey: coord.sessionKey,
    });
    if (written.superseded) {
      reconcileFromShared();
      return;
    }
    machine.status = 'signed-out';
    machine.email = null;
    machine.session = null;
    machine.activeAttemptId = null;
    machine.logoutPhase = 'revocation_failed';
    machine.backedByStorage = written.written;
    machine.revokedSessionKey = coord.sessionKey;
    if (syncGlobal) {
      setWritesLocked(true);
      setHeldWriteUser(null);
    }
    emit();
  }

  function latestPendingHeartbeatAt(
    coord: SharedLogoutCoord,
    latest: SharedLogoutCoord | null,
  ): number | undefined {
    let best = coord.heartbeatAt;
    const consider = (candidate: SharedLogoutCoord | null) => {
      if (
        candidate !== null &&
        candidate.attemptId === coord.attemptId &&
        candidate.ownerTabId === coord.ownerTabId &&
        candidate.state === 'pending' &&
        typeof candidate.heartbeatAt === 'number' &&
        Number.isFinite(candidate.heartbeatAt)
      ) {
        best =
          best === undefined
            ? candidate.heartbeatAt
            : Math.max(best, candidate.heartbeatAt);
      }
    };
    consider(pendingWatchedCoord);
    consider(latest);
    return best;
  }

  function effectiveLeaseRemainingMs(coord: SharedLogoutCoord): number {
    const wallRemaining = leaseRemainingMs(coord);
    if (wallRemaining <= 0) return 0;
    if (watchedLeaseObservedAt === null) {
      return Math.min(PENDING_LEASE_TTL_MS, wallRemaining);
    }
    const localRemaining = Math.max(
      0,
      watchedLeaseObservedAt + PENDING_LEASE_TTL_MS - monotonicNow(),
    );
    return Math.min(PENDING_LEASE_TTL_MS, wallRemaining, localRemaining);
  }

  function schedulePendingLeaseProbe(
    coord: SharedLogoutCoord,
    epoch: number,
    delayMs: number,
  ): void {
    if (pendingFallbackTimer !== null) {
      clearTimeout(pendingFallbackTimer);
      pendingFallbackTimer = null;
    }
    const watchKey = pendingWatchKeyOf(coord);
    const clampedDelay = Math.min(PENDING_LEASE_TTL_MS, Math.max(0, delayMs));
    pendingFallbackTimer = setTimeout(() => {
      pendingFallbackTimer = null;
      if (epoch !== storeEpoch || watchedPendingKey !== watchKey) {
        return;
      }
      probePendingAbandonment(coord, epoch);
    }, clampedDelay);
  }

  function probePendingAbandonment(
    coord: SharedLogoutCoord,
    epoch: number,
  ): void {
    const watchKey = pendingWatchKeyOf(coord);
    if (
      epoch !== storeEpoch ||
      coord.ownerTabId === tabId ||
      watchedPendingKey !== watchKey
    ) {
      return;
    }
    if (
      machine.session !== null ||
      hasAdvancedPastWatchedCoord(machine.knownCoord, coord)
    ) {
      clearPendingAbandonmentWatch(coord);
      reconcileFromShared();
      return;
    }
    const latestStorage = deps.getStorage();
    const latest = readSharedCoord(latestStorage);
    if (
      latest === null &&
      machine.backedByStorage &&
      !hasPersistedSupabaseCredentials(latestStorage)
    ) {
      clearPendingAbandonmentWatch(coord);
      reconcileFromShared();
      return;
    }
    if (hasAdvancedPastWatchedCoord(latest, coord)) {
      clearPendingAbandonmentWatch(coord);
      reconcileFromShared();
      return;
    }

    // If a newer session already replaced the pending logout's session,
    // unblock immediately without waiting for the abandoned lease to expire.
    const persistedKey = sessionKeyOf(
      readPersistedSupabaseSession(latestStorage),
    );
    if (
      persistedKey !== null &&
      coord.sessionKey !== null &&
      persistedKey !== coord.sessionKey
    ) {
      promoteAbandonedPending(coord, epoch);
      return;
    }

    const heartbeatAt = latestPendingHeartbeatAt(coord, latest);
    const remaining = effectiveLeaseRemainingMs({ ...coord, heartbeatAt });
    if (remaining > 0) {
      schedulePendingLeaseProbe(coord, epoch, remaining);
      return;
    }

    // Lease is stale: require acquiring the attempt lock when Web Locks are
    // available (or proceed directly when locks are unavailable).
    const locks = deps.getLocks();
    if (!locks) {
      promoteAbandonedPending(coord, epoch);
      return;
    }

    // P3-2 / DELTA11-P2-1: Dedupe concurrent lock probes per (attemptId, ownerTabId).
    if (pendingLockProbeKey === watchKey) {
      return;
    }
    pendingLockProbeKey = watchKey;

    const attemptLockName = logoutAttemptLockKey(
      coord.attemptId,
      coord.ownerTabId,
    );
    const tryPromoteAfterLock = () => {
      if (pendingLockProbeKey === watchKey) {
        pendingLockProbeKey = null;
      }
      if (epoch !== storeEpoch || watchedPendingKey !== watchKey) {
        return;
      }
      const freshStorage = deps.getStorage();
      const freshLatest = readSharedCoord(freshStorage);
      if (
        freshLatest === null &&
        machine.backedByStorage &&
        !hasPersistedSupabaseCredentials(freshStorage)
      ) {
        clearPendingAbandonmentWatch(coord);
        reconcileFromShared();
        return;
      }
      if (
        machine.session !== null ||
        hasAdvancedPastWatchedCoord(machine.knownCoord, coord) ||
        hasAdvancedPastWatchedCoord(freshLatest, coord)
      ) {
        clearPendingAbandonmentWatch(coord);
        reconcileFromShared();
        return;
      }
      const freshHeartbeat = latestPendingHeartbeatAt(coord, freshLatest);
      const freshRemaining = effectiveLeaseRemainingMs({
        ...coord,
        heartbeatAt: freshHeartbeat,
      });
      if (freshRemaining > 0) {
        schedulePendingLeaseProbe(coord, epoch, freshRemaining);
        return;
      }
      promoteAbandonedPending(coord, epoch);
    };

    try {
      void Promise.resolve(
        locks.request(
          attemptLockName,
          { mode: 'exclusive', ifAvailable: true },
          (lock) => {
            if (epoch !== storeEpoch || watchedPendingKey !== watchKey) {
              if (pendingLockProbeKey === watchKey) {
                pendingLockProbeKey = null;
              }
              return;
            }
            if (lock !== null) {
              tryPromoteAfterLock();
              return;
            }
            try {
              void Promise.resolve(
                locks.request(attemptLockName, { mode: 'exclusive' }, () => {
                  tryPromoteAfterLock();
                }),
              ).catch(() => {
                tryPromoteAfterLock();
              });
            } catch {
              tryPromoteAfterLock();
            }
          },
        ),
      ).catch(() => {
        tryPromoteAfterLock();
      });
    } catch {
      tryPromoteAfterLock();
    }
  }

  function watchPendingLogoutForAbandonment(
    coord: SharedLogoutCoord,
    epoch: number,
  ): void {
    if (epoch !== storeEpoch || coord.ownerTabId === tabId) return;
    const watchKey = pendingWatchKeyOf(coord);
    if (
      watchedPendingKey === watchKey &&
      pendingWatchedCoord !== null &&
      pendingWatchedCoord.attemptId === coord.attemptId &&
      pendingWatchedCoord.ownerTabId === coord.ownerTabId
    ) {
      if (
        typeof coord.heartbeatAt === 'number' &&
        (pendingWatchedCoord.heartbeatAt === undefined ||
          coord.heartbeatAt > pendingWatchedCoord.heartbeatAt)
      ) {
        pendingWatchedCoord = {
          ...pendingWatchedCoord,
          heartbeatAt: coord.heartbeatAt,
        };
        watchedLeaseObservedAt = monotonicNow();
      }
      return;
    }
    clearPendingAbandonmentWatch();
    watchedPendingKey = watchKey;
    pendingWatchedCoord = coord;
    watchedLeaseObservedAt = monotonicNow();
    probePendingAbandonment(coord, epoch);
  }

  function reconcileMissingDirectCredentials(
    storage: Storage | null,
    sdkKeyRemoved?: boolean,
  ): boolean {
    const client = deps.getClient();
    const missingDirectCreds =
      storage !== null &&
      client !== null &&
      hasDirectRevocationTransport(client) &&
      !hasPersistedSupabaseCredentials(storage);
    if (
      (sdkKeyRemoved || missingDirectCreds) &&
      machine.activeAttemptId === null &&
      signInInProgressCount === 0 &&
      storage !== null &&
      !hasPersistedSupabaseCredentials(storage) &&
      (machine.session !== null || machine.lastUserId !== null)
    ) {
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
      if (
        machine.logoutPhase !== 'revocation_failed' &&
        machine.logoutPhase !== 'signing_out'
      ) {
        clearPendingAbandonmentWatch();
        machine.logoutPhase = 'idle';
      }
      emit();
      return true;
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
      const rank = coordStateRank(shared.state);
      const isSameKnownState =
        machine.knownCoord !== null &&
        shared.attemptId === machine.knownCoord.attemptId &&
        shared.ownerTabId === machine.knownCoord.ownerTabId &&
        shared.state === machine.knownCoord.state &&
        shared.sessionKey === machine.knownCoord.sessionKey;
      const cmpToKnown =
        machine.knownCoord !== null
          ? compareSharedCoord(shared, machine.knownCoord)
          : 1;

      const persistedKeyForSignedIn =
        shared.state === 'signed_in' && shared.sessionKey !== null
          ? sessionKeyOf(readPersistedSupabaseSession(storage))
          : null;
      const isFreshSignedInAfterQuotaReset =
        !isSameKnownState &&
        cmpToKnown < 0 &&
        machine.activeAttemptId === null &&
        shared.state === 'signed_in' &&
        shared.sessionKey !== null &&
        persistedKeyForSignedIn === shared.sessionKey &&
        machine.knownCoord !== null &&
        machine.knownCoord.sessionKey !== null &&
        machine.knownCoord.sessionKey !== shared.sessionKey;

      if (
        !isSameKnownState &&
        cmpToKnown < 0 &&
        !isFreshSignedInAfterQuotaReset
      ) {
        reconcileMissingDirectCredentials(storage, options?.sdkKeyRemoved);
        return;
      }
      const isPendingOwnerSwitch =
        !isSameKnownState &&
        cmpToKnown === 0 &&
        shared.state === 'pending' &&
        shared.ownerTabId !== machine.knownCoord?.ownerTabId;
      const isTentativeInFlightPhase =
        machine.logoutPhase === 'signing_out' ||
        machine.logoutPhase === 'retrying_local';
      const needsBlockingPhaseRepair =
        machine.activeAttemptId === null &&
        isTentativeInFlightPhase &&
        (shared.state !== 'pending' ||
          machine.logoutPhase === 'retrying_local' ||
          (shared.ownerTabId !== tabId && pendingWatchedCoord === null));
      if ((isSameKnownState || cmpToKnown === 0) && !isPendingOwnerSwitch) {
        if (
          machine.activeAttemptId === shared.attemptId &&
          shared.ownerTabId === tabId
        ) {
          return;
        }
        if (
          (shared.state === 'pending' &&
            machine.activeAttemptId !== shared.attemptId) ||
          shared.state === 'local_failed'
        ) {
          const persistedKeyNow = sessionKeyOf(
            readPersistedSupabaseSession(storage),
          );
          if (
            shared.sessionKey !== null &&
            persistedKeyNow !== null &&
            persistedKeyNow !== shared.sessionKey
          ) {
            clearPendingAbandonmentWatch(shared);
            if (isBlockingLogoutPhase(machine.logoutPhase)) {
              machine.logoutPhase = 'idle';
              machine.backedByStorage = false;
              machine.retainedRevocationSession = null;
              machine.revokedSessionKey = null;
              emit();
            }
            return;
          }
        }
        if (!needsBlockingPhaseRepair) {
          if (shared.state === 'pending' && shared.ownerTabId !== tabId) {
            if (
              pendingWatchedCoord !== null &&
              pendingWatchedCoord.attemptId === shared.attemptId &&
              pendingWatchedCoord.ownerTabId === shared.ownerTabId
            ) {
              if (
                shared.heartbeatAt !== undefined &&
                (pendingWatchedCoord.heartbeatAt === undefined ||
                  shared.heartbeatAt > pendingWatchedCoord.heartbeatAt)
              ) {
                pendingWatchedCoord = {
                  ...pendingWatchedCoord,
                  heartbeatAt: shared.heartbeatAt,
                };
                watchedLeaseObservedAt = monotonicNow();
              }
              if (
                machine.logoutPhase === 'signing_out' &&
                effectiveLeaseRemainingMs(pendingWatchedCoord) === 0
              ) {
                probePendingAbandonment(pendingWatchedCoord, storeEpoch);
                return;
              }
            }
          }
          reconcileMissingDirectCredentials(storage, options?.sdkKeyRemoved);
          return;
        }
      }

      machine.knownCoord = shared;
      machine.knownSeq = shared.attemptId;
      machine.knownStateRank = rank;
      machine.knownOwnerTabId = shared.ownerTabId;
      if (
        machine.activeAttemptId !== null &&
        (shared.attemptId !== machine.activeAttemptId ||
          shared.ownerTabId !== tabId)
      ) {
        machine.activeAttemptId = null;
      }

      const clearMismatchedRetainedSession = (
        expectedKey: string | null,
      ): void => {
        if (
          expectedKey !== null &&
          machine.retainedRevocationSession !== null &&
          sessionKeyOf(machine.retainedRevocationSession) !== expectedKey
        ) {
          machine.retainedRevocationSession = null;
        }
      };

      switch (shared.state) {
        case 'pending': {
          lockSessionForSignOut({
            clearResolvedPins: true,
            retainSessionForRevocation: true,
          });
          clearMismatchedRetainedSession(shared.sessionKey);
          machine.status = 'signed-out';
          machine.email = null;
          machine.logoutPhase = 'signing_out';
          machine.backedByStorage = true;
          machine.revokedSessionKey =
            shared.sessionKey ?? machine.revokedSessionKey;
          emit();
          const currentClient = deps.getClient();
          if (
            shared.ownerTabId !== tabId &&
            currentClient !== null &&
            hasDirectRevocationTransport(currentClient)
          ) {
            watchPendingLogoutForAbandonment(shared, storeEpoch);
          }
          return;
        }
        case 'local_failed': {
          clearPendingAbandonmentWatch();
          lockSessionForSignOut({
            clearResolvedPins: true,
            retainSessionForRevocation: true,
          });
          clearMismatchedRetainedSession(shared.sessionKey);
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
          clearPendingAbandonmentWatch();
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
          machine.revokedSessionKey =
            shared.sessionKey ?? machine.revokedSessionKey;
          emit();
          return;
        }
        case 'revocation_failed': {
          clearPendingAbandonmentWatch();
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
          clearMismatchedRetainedSession(shared.sessionKey);
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
          clearPendingAbandonmentWatch();
          abortInFlightRevocations();
          machine.logoutPhase = 'idle';
          machine.backedByStorage = false;
          machine.retainedRevocationSession = null;
          machine.revokedSessionKey = null;
          emit();
          reconcileMissingDirectCredentials(storage, options?.sdkKeyRemoved);
          return;
        }
      }
    }

    // shared === null: either never written, cleared externally, or deleted
    // under quota cleanup. Whenever no local attempt is active, drop any stale
    // knownCoord so it can never outrank a future record allocated from 1 by a
    // fresh/reloaded tab (I1, I2, I3).
    if (machine.activeAttemptId === null && machine.knownCoord !== null) {
      resetKnownCoord();
    }
    const client = deps.getClient();
    const isDirect = client !== null && hasDirectRevocationTransport(client);
    const hasDirectCreds = isDirect && hasPersistedSupabaseCredentials(storage);
    const persistedKeyNow = sessionKeyOf(readPersistedSupabaseSession(storage));
    const hasNewerDirectSession =
      machine.revokedSessionKey !== null &&
      persistedKeyNow !== null &&
      persistedKeyNow !== machine.revokedSessionKey;
    if (hasNewerDirectSession && machine.logoutPhase === 'idle') {
      machine.revokedSessionKey = null;
    }
    const unbackedLocalFailedClearedBySibling =
      machine.logoutPhase === 'local_failed' &&
      storage !== null &&
      isDirect &&
      !hasDirectCreds;
    if (
      machine.activeAttemptId === null &&
      (machine.backedByStorage ||
        hasNewerDirectSession ||
        unbackedLocalFailedClearedBySibling) &&
      (isBlockingLogoutPhase(machine.logoutPhase) ||
        machine.logoutPhase === 'revocation_failed') &&
      (!hasDirectCreds || hasNewerDirectSession)
    ) {
      clearPendingAbandonmentWatch();
      machine.logoutPhase = 'idle';
      machine.backedByStorage = false;
      machine.retainedRevocationSession = null;
      if (hasNewerDirectSession) {
        machine.revokedSessionKey = null;
      }
      machine.status = 'signed-out';
      machine.email = null;
      emit();
      return;
    }

    reconcileMissingDirectCredentials(storage, options?.sdkKeyRemoved);
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
    const storage = deps.getStorage();
    if (isAttemptSuperseded(attemptId, outcome.targetSessionKey)) {
      // DELTA13 / final6 P2-1: Always clear activeAttemptId when this attempt
      // finishes superseded so the tab can never stay trapped in signing_out.
      if (machine.activeAttemptId === attemptId) {
        machine.activeAttemptId = null;
      }
      // P2-1: If THIS attempt received a confirmed 2xx global revocation for the
      // same session and the superseding shared record is a still-pending or
      // failed logout for that SAME session (never signed_in and never a newer
      // session in storage), advance coordKey to completed instead of discarding
      // the server's confirmation.
      if (
        outcome.localOk &&
        outcome.revocationOk &&
        outcome.targetSessionKey !== null &&
        machine.session === null
      ) {
        const shared = readSharedCoord(storage);
        const storedSessionKey = sessionKeyOf(
          readPersistedSupabaseSession(storage),
        );
        const hasNewerStoredSession =
          storedSessionKey !== null &&
          storedSessionKey !== outcome.targetSessionKey;
        const sameSessionUnconfirmedLogout =
          shared !== null &&
          (shared.state === 'pending' ||
            shared.state === 'local_failed' ||
            shared.state === 'revocation_failed') &&
          (shared.sessionKey === null ||
            shared.sessionKey === outcome.targetSessionKey);
        if (!hasNewerStoredSession && sameSessionUnconfirmedLogout) {
          let localCredsCleared = true;
          const currentClient = deps.getClient();
          if (
            storage !== null &&
            currentClient !== null &&
            hasDirectRevocationTransport(currentClient) &&
            hasPersistedSupabaseCredentials(storage)
          ) {
            const reRemoval = removePersistedSupabaseCredentials(
              storage,
              outcome.targetSessionKey,
            );
            if (
              reRemoval.skippedNewerSession ||
              reRemoval.stillPresentForTarget
            ) {
              localCredsCleared = false;
            }
          }
          if (localCredsCleared) {
            const confirmAttemptId = nextAttemptId(storage);
            const written = writeSharedCoord(storage, {
              attemptId: confirmAttemptId,
              ownerTabId: tabId,
              state: 'completed',
              sessionKey: outcome.targetSessionKey,
            });
            if (!written.superseded) {
              clearPendingAbandonmentWatch();
              machine.logoutPhase = 'idle';
              machine.backedByStorage = false;
              machine.retainedRevocationSession = null;
              machine.revokedSessionKey = outcome.targetSessionKey;
              machine.session = null;
              machine.status = 'signed-out';
              machine.email = null;
              emit();
              return;
            }
          }
        }
      }
      // P2-2: If THIS attempt rotated the refresh token before failing (e.g.
      // 503) and the superseding state is still an unconfirmed logout for the
      // SAME session, retain the rotated session so Retry uses the new token.
      if (
        !outcome.revocationOk &&
        outcome.retainedSession !== null &&
        outcome.targetSessionKey !== null &&
        machine.session === null
      ) {
        const shared = readSharedCoord(storage);
        const storedSessionKey = sessionKeyOf(
          readPersistedSupabaseSession(storage),
        );
        const hasNewerStoredSession =
          storedSessionKey !== null &&
          storedSessionKey !== outcome.targetSessionKey;
        const sameSessionUnconfirmedLogout =
          shared !== null &&
          (shared.state === 'pending' ||
            shared.state === 'local_failed' ||
            shared.state === 'revocation_failed') &&
          (shared.sessionKey === null ||
            shared.sessionKey === outcome.targetSessionKey);
        if (!hasNewerStoredSession && sameSessionUnconfirmedLogout) {
          machine.retainedRevocationSession = outcome.retainedSession;
        }
      }
      // final6 P2-1: If superseded by a newer persisted session in storage
      // while localStorage[coordKey] was not written, clean up any dangling
      // pending coord and unblock blocking/retrying phases to idle.
      const storedKey = sessionKeyOf(readPersistedSupabaseSession(storage));
      if (
        storedKey !== null &&
        outcome.targetSessionKey !== null &&
        storedKey !== outcome.targetSessionKey
      ) {
        cleanupDanglingPendingCoord(storage, attemptId);
        if (isPwaBlockedByLogout(machine.logoutPhase)) {
          clearPendingAbandonmentWatch();
          machine.logoutPhase = 'idle';
          machine.backedByStorage = false;
          machine.retainedRevocationSession = null;
          machine.revokedSessionKey = null;
        }
      }
      reconcileFromShared();
      emit();
      return;
    }

    machine.activeAttemptId = null;

    let effectiveLocalOk = outcome.localOk;
    let effectiveRetainedSession = outcome.retainedSession;
    if (
      !outcome.revocationOk &&
      activeAttemptRotatedSession !== null &&
      activeAttemptRotatedSession.attemptId === attemptId &&
      (outcome.targetSessionKey === null ||
        sessionKeyOf(activeAttemptRotatedSession.session) ===
          outcome.targetSessionKey)
    ) {
      effectiveRetainedSession = activeAttemptRotatedSession.session;
    }
    if (activeAttemptRotatedSession?.attemptId === attemptId) {
      activeAttemptRotatedSession = null;
    }

    const currentClient = deps.getClient();
    if (
      effectiveLocalOk &&
      storage !== null &&
      currentClient !== null &&
      hasDirectRevocationTransport(currentClient) &&
      hasPersistedSupabaseCredentials(storage)
    ) {
      const persistedNow = readPersistedSupabaseSession(storage);
      const persistedKeyNow = sessionKeyOf(persistedNow);
      const isTargetCreds =
        persistedKeyNow === null ||
        outcome.targetSessionKey === null ||
        persistedKeyNow === outcome.targetSessionKey;
      if (isTargetCreds) {
        const reRemoval = removePersistedSupabaseCredentials(
          storage,
          outcome.targetSessionKey,
        );
        if (!reRemoval.skippedNewerSession) {
          if (reRemoval.stillPresentForTarget) {
            effectiveLocalOk = false;
            if (persistedNow) {
              effectiveRetainedSession = persistedNow;
            }
          } else if (!outcome.revocationOk && persistedNow) {
            effectiveRetainedSession = persistedNow;
          }
        }
      }
    }

    if (!effectiveLocalOk) {
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
        effectiveRetainedSession ??
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
        sessionKey: outcome.targetSessionKey,
      });
      if (written.superseded) {
        reconcileFromShared();
        return;
      }
      clearPendingAbandonmentWatch();
      machine.logoutPhase = 'idle';
      machine.backedByStorage = false;
      machine.retainedRevocationSession = null;
      machine.revokedSessionKey =
        outcome.targetSessionKey ?? machine.revokedSessionKey;
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
      if (
        !outcome.revocationOk &&
        effectiveRetainedSession !== null &&
        outcome.targetSessionKey !== null &&
        machine.session === null
      ) {
        const shared = readSharedCoord(storage);
        const storedSessionKey = sessionKeyOf(
          readPersistedSupabaseSession(storage),
        );
        const hasNewerStoredSession =
          storedSessionKey !== null &&
          storedSessionKey !== outcome.targetSessionKey;
        const sameSessionUnconfirmedLogout =
          shared !== null &&
          (shared.state === 'pending' ||
            shared.state === 'local_failed' ||
            shared.state === 'revocation_failed') &&
          (shared.sessionKey === null ||
            shared.sessionKey === outcome.targetSessionKey);
        if (!hasNewerStoredSession && sameSessionUnconfirmedLogout) {
          machine.retainedRevocationSession = effectiveRetainedSession;
        }
      }
      reconcileFromShared();
      emit();
      return;
    }
    machine.logoutPhase = 'revocation_failed';
    machine.backedByStorage = written.written;
    machine.retainedRevocationSession = effectiveRetainedSession;
    machine.revokedSessionKey = outcome.targetSessionKey;
    machine.session = null;
    machine.status = 'signed-out';
    machine.email = null;
    emit();
  }

  function acceptAuthenticatedSession(
    session: Session,
    event: string,
    previousSession: Session | null,
  ): void {
    clearPendingAbandonmentWatch();
    abortInFlightRevocations();
    const sharedNow = readSharedCoord(deps.getStorage());
    if (sharedNow === null) {
      resetKnownCoord();
    } else if (
      sharedNow.state === 'signed_in' &&
      machine.knownCoord !== null &&
      compareSharedCoord(sharedNow, machine.knownCoord) < 0
    ) {
      resetKnownCoord();
      recordKnownCoord(sharedNow);
    }
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
    const previousUserId = previousSession?.user.id ?? machine.lastUserId;
    machine.lastUserId = session.user.id;
    if (syncGlobal) {
      if (!sameSession) {
        bumpSessionGeneration();
      }
      if (previousUserId !== null && previousUserId !== session.user.id) {
        setHeldWriteUser(null);
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
  }

  type AttemptLockHandle = {
    release: () => void;
  };

  function startAttemptLock(
    attemptId: number,
    ownerTabId: string,
    epoch: number,
  ): AttemptLockHandle {
    const locks = deps.getLocks();
    if (!locks) return { release: () => {} };
    const lockName = logoutAttemptLockKey(attemptId, ownerTabId);
    let released = false;
    let resolveHold: (() => void) | null = null;
    const release = () => {
      if (released) return;
      released = true;
      activeAttemptLockReleases.delete(release);
      if (resolveHold) {
        const done = resolveHold;
        resolveHold = null;
        done();
      }
    };
    activeAttemptLockReleases.add(release);
    try {
      void Promise.resolve(
        locks.request(lockName, { mode: 'exclusive' }, (lock) => {
          if (!lock || released || epoch !== storeEpoch) {
            release();
            return;
          }
          return new Promise<void>((resolve) => {
            resolveHold = resolve;
            if (released || epoch !== storeEpoch) {
              release();
            }
          });
        }),
      ).catch(() => {
        release();
      });
    } catch {
      release();
    }
    return { release };
  }

  function releaseAllAttemptLocks(): void {
    for (const release of [...activeAttemptLockReleases]) {
      release();
    }
    activeAttemptLockReleases.clear();
  }

  function startAuth(): void {
    if (started) return;
    const client = deps.getClient();
    if (!client) return;
    started = true;
    const epoch = storeEpoch;
    if (syncGlobal) {
      setHeldWriteUser(null);
    }

    // Stateless BroadcastChannel nudge: tells sibling tabs to re-read localStorage.
    const channel = deps.createBroadcastChannel(coordChannelName());
    broadcastChannel = channel;
    const onBroadcastMessage = (event: MessageEvent) => {
      const data = event.data as { senderTabId?: unknown } | null;
      if (data && typeof data === 'object' && data.senderTabId === tabId) {
        return;
      }
      reconcileFromShared();
    };
    channel?.addEventListener('message', onBroadcastMessage);

    // Boot reconciliation BEFORE subscribing to onAuthStateChange so
    // INITIAL_SESSION cannot reopen owner access after a failed/pending logout.
    const storage = deps.getStorage();
    const initialCoord = readSharedCoord(storage);
    if (initialCoord) {
      recordKnownCoord(initialCoord);
      if (
        initialCoord.state === 'pending' ||
        initialCoord.state === 'local_failed'
      ) {
        const persistedKey = sessionKeyOf(
          readPersistedSupabaseSession(storage),
        );
        const hasNewerPersistedSession =
          persistedKey !== null &&
          initialCoord.sessionKey !== null &&
          persistedKey !== initialCoord.sessionKey;
        const directTransportWithNoCreds =
          hasDirectRevocationTransport(client) &&
          !hasPersistedSupabaseCredentials(storage);

        if (hasNewerPersistedSession) {
          // Storage already holds a newer session than this stale coord; let
          // INITIAL_SESSION restore the newer session cleanly.
        } else if (directTransportWithNoCreds) {
          if (initialCoord.state === 'pending') {
            machine.status = 'signed-out';
            machine.email = null;
            machine.session = null;
            machine.logoutPhase = 'signing_out';
            machine.backedByStorage = true;
            machine.revokedSessionKey = initialCoord.sessionKey;
            if (syncGlobal) {
              setWritesLocked(true);
              setHeldWriteUser(null);
            }
            emit();
            watchPendingLogoutForAbandonment(initialCoord, epoch);
          } else {
            promoteAbandonedPending(initialCoord, epoch);
          }
        } else {
          machine.status = 'signed-out';
          machine.email = null;
          machine.session = null;
          machine.logoutPhase = 'local_failed';
          machine.backedByStorage = true;
          machine.revokedSessionKey = initialCoord.sessionKey;
          if (syncGlobal) {
            setWritesLocked(true);
            setHeldWriteUser(null);
          }
          emit();
        }
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
      } else if (initialCoord.state === 'completed') {
        machine.revokedSessionKey = initialCoord.sessionKey;
        if (
          hasDirectRevocationTransport(client) &&
          initialCoord.sessionKey !== null &&
          storage
        ) {
          const persistedKey = sessionKeyOf(
            readPersistedSupabaseSession(storage),
          );
          if (persistedKey === initialCoord.sessionKey) {
            removePersistedSupabaseCredentials(
              storage,
              initialCoord.sessionKey,
            );
          }
        }
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
        isTombstoneOrEmpty(event.newValue);
      if (!isCoordEvent && !isSdkRemoval) return;
      reconcileFromShared({ sdkKeyRemoved: isSdkRemoval });
    };
    const removeStorageListener = deps.addStorageListener(onStorage);
    const removeVisibilityListener = deps.addVisibilityListener(() => {
      reconcileFromShared();
    });

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
            clearPendingAbandonmentWatch();
            machine.logoutPhase = 'idle';
            machine.backedByStorage = false;
            // DELTA10-P2-3: Preserve revokedSessionKey unless a signed_in coord
            // exists so a late TOKEN_REFRESHED for the revoked session cannot
            // reopen owner access when pending vanished under 0-byte quota.
            if (shared?.state === 'signed_in') {
              machine.revokedSessionKey = null;
            }
          }
        }
        emit();
        return;
      }

      const incomingKey = sessionKeyOf(session);
      const currentStorage = deps.getStorage();
      const shared = readSharedCoord(currentStorage);
      const isOwnFreshSignIn =
        signInInProgressCount > 0 &&
        event === 'SIGNED_IN' &&
        (machine.revokedSessionKey === null ||
          incomingKey !== machine.revokedSessionKey);

      // Block incoming session callbacks while local logout is in progress or
      // failed (I1), unless this tab's own deliberate signIn just produced a
      // fresh session (P2-2). Never reopen owner access on refocus/reload.
      if (isBlockingLogoutPhase(machine.logoutPhase) && !isOwnFreshSignIn) {
        if (machine.activeAttemptId === null && !machine.backedByStorage) {
          const attemptId = nextAttemptId(currentStorage);
          const targetKey = machine.revokedSessionKey ?? incomingKey;
          const fallback = persistLogoutCoordWithQuotaFallback(
            currentStorage,
            {
              attemptId,
              ownerTabId: tabId,
              state: 'local_failed',
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
          // P2-2 / final6 P1-2: While signing_out/retrying_local is active,
          // evict any late _callRefreshToken() or replay for the revoked
          // session — NEVER evict a distinct newer sid: session (I3).
          const isDistinctNewerSid = isDistinctSidSession(
            machine.revokedSessionKey,
            incomingKey,
          );
          if (
            (machine.logoutPhase === 'signing_out' ||
              machine.logoutPhase === 'retrying_local') &&
            currentStorage &&
            incomingKey !== null &&
            !isDistinctNewerSid &&
            (incomingKey === machine.revokedSessionKey ||
              (event === 'TOKEN_REFRESHED' && shared?.state !== 'signed_in'))
          ) {
            removePersistedSupabaseCredentials(
              currentStorage,
              machine.revokedSessionKey?.startsWith('sid:')
                ? machine.revokedSessionKey
                : incomingKey,
            );
            if (
              machine.revokedSessionKey === null ||
              incomingKey === machine.revokedSessionKey
            ) {
              const rotated = extractRevocationSession(session);
              if (rotated) {
                machine.retainedRevocationSession = rotated;
                if (machine.activeAttemptId !== null) {
                  activeAttemptRotatedSession = {
                    attemptId: machine.activeAttemptId,
                    session: rotated,
                  };
                }
              }
            }
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
      }

      // P1-2 Path A: Reject stale SIGNED_IN / TOKEN_REFRESHED while global
      // revocation retry is in flight (never evicting a distinct newer sid:).
      if (machine.logoutPhase === 'retrying_revocation' && !isOwnFreshSignIn) {
        const isDistinctNewerSid = isDistinctSidSession(
          machine.revokedSessionKey,
          incomingKey,
        );
        if (
          currentStorage &&
          incomingKey !== null &&
          !isDistinctNewerSid &&
          (incomingKey === machine.revokedSessionKey ||
            (event === 'TOKEN_REFRESHED' && shared?.state !== 'signed_in'))
        ) {
          removePersistedSupabaseCredentials(
            currentStorage,
            machine.revokedSessionKey?.startsWith('sid:')
              ? machine.revokedSessionKey
              : incomingKey,
          );
          if (
            event === 'TOKEN_REFRESHED' &&
            (machine.revokedSessionKey === null ||
              incomingKey === machine.revokedSessionKey)
          ) {
            const rotated = extractRevocationSession(session);
            if (rotated) {
              machine.retainedRevocationSession = rotated;
              if (machine.activeAttemptId !== null) {
                activeAttemptRotatedSession = {
                  attemptId: machine.activeAttemptId,
                  session: rotated,
                };
              }
            }
          }
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

      // P1-2 Path B / final6 P1-2: Reject stale refocus / in-flight
      // _callRefreshToken events for the revoked session, without ever
      // treating a distinct newer sid: session's TOKEN_REFRESHED as stale (I3).
      const isDistinctNewerSid = isDistinctSidSession(
        machine.revokedSessionKey,
        incomingKey,
      );
      const isRevokedSessionReplay =
        machine.revokedSessionKey !== null &&
        incomingKey !== null &&
        incomingKey === machine.revokedSessionKey;
      const isGhostEventWithoutCreds =
        currentStorage !== null &&
        hasDirectRevocationTransport(client) &&
        !hasPersistedSupabaseCredentials(currentStorage);
      const isStaleRefreshWhileSignedOut =
        event === 'TOKEN_REFRESHED' &&
        !isDistinctNewerSid &&
        machine.session === null &&
        shared?.state !== 'signed_in' &&
        (machine.revokedSessionKey !== null || shared !== null);

      if (
        !isOwnFreshSignIn &&
        (isRevokedSessionReplay ||
          isGhostEventWithoutCreds ||
          isStaleRefreshWhileSignedOut)
      ) {
        if (
          currentStorage &&
          (isRevokedSessionReplay || isStaleRefreshWhileSignedOut) &&
          shared?.state !== 'signed_in'
        ) {
          removePersistedSupabaseCredentials(
            currentStorage,
            machine.revokedSessionKey?.startsWith('sid:')
              ? machine.revokedSessionKey
              : isRevokedSessionReplay
                ? machine.revokedSessionKey
                : incomingKey,
          );
          if (
            machine.logoutPhase === 'revocation_failed' &&
            event === 'TOKEN_REFRESHED' &&
            isRevokedSessionReplay
          ) {
            const rotated = extractRevocationSession(session);
            if (rotated) {
              machine.retainedRevocationSession = rotated;
            }
          }
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
      try {
        acceptAuthenticatedSession(session, event, previousSession);
      } catch (error) {
        if (signInInProgressCount > 0 && event === 'SIGNED_IN') {
          signInRejectedOwnSession = { session, error };
        }
        throw error;
      }
    });

    unsubscribeAll = () => {
      clearPendingAbandonmentWatch();
      subscription.unsubscribe();
      removeStorageListener();
      removeVisibilityListener();
      if (channel) {
        channel.removeEventListener('message', onBroadcastMessage);
        try {
          channel.close();
        } catch {
          // Ignore BroadcastChannel close errors.
        }
      }
      if (broadcastChannel === channel) {
        broadcastChannel = null;
      }
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

  async function executeSignOutAttempt(params: {
    client: NonNullable<typeof supabase>;
    storage: Storage | null;
    capturedSession: RetainedRevocationSession | null;
    targetSessionKey: string | null;
    hadUnconfirmedRevocation: boolean;
    clearResolvedPins: boolean;
    suppressEmitErrors?: boolean;
  }): Promise<void> {
    const {
      client,
      storage,
      capturedSession,
      targetSessionKey,
      hadUnconfirmedRevocation,
      clearResolvedPins,
      suppressEmitErrors = false,
    } = params;

    const safeEmit = () => {
      if (!suppressEmitErrors) {
        emit();
        return;
      }
      try {
        emit();
      } catch {
        // Never re-throw from subscriber during rollback.
      }
    };

    const safeReconcile = () => {
      if (!suppressEmitErrors) {
        reconcileFromShared();
        return;
      }
      try {
        reconcileFromShared();
      } catch {
        // Never re-throw from subscriber during rollback.
      }
    };

    const attemptId = nextAttemptId(storage);
    const epoch = storeEpoch;
    const nextPhase: LogoutPhase =
      machine.logoutPhase === 'local_failed' ||
      machine.logoutPhase === 'retrying_local'
        ? 'retrying_local'
        : 'signing_out';

    let settled = false;
    let resolveTask!: () => void;
    const task = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });

    // 1. Synchronously lock local session, writes, and PWA reload BEFORE any
    //    await or storage mutation so refocus can never reopen owner access (I1/I5).
    clearPendingAbandonmentWatch();
    pendingSignOutPromise = task;
    activeSignOutTargetKey = targetSessionKey;
    machine.activeAttemptId = attemptId;
    machine.logoutPhase = nextPhase;
    machine.backedByStorage = false;
    machine.revokedSessionKey = targetSessionKey;
    if (capturedSession) {
      machine.retainedRevocationSession = capturedSession;
    }
    lockSessionForSignOut({ clearResolvedPins });
    machine.status = 'signed-out';
    machine.email = null;
    safeEmit();

    const abortForNewerSession = () => {
      if (machine.activeAttemptId === attemptId) {
        machine.activeAttemptId = null;
      }
      cleanupDanglingPendingCoord(storage, attemptId);
      if (
        machine.logoutPhase === 'signing_out' ||
        machine.logoutPhase === 'retrying_local'
      ) {
        clearPendingAbandonmentWatch();
        machine.logoutPhase = 'idle';
        machine.backedByStorage = false;
        machine.retainedRevocationSession = null;
        machine.revokedSessionKey = null;
      }
      if (pendingSignOutPromise === task) {
        pendingSignOutPromise = null;
        activeSignOutTargetKey = null;
      }
      safeReconcile();
      safeEmit();
      settled = true;
      resolveTask();
    };

    const commitSafe = (outcome: {
      localOk: boolean;
      revocationOk: boolean;
      retainedSession: RetainedRevocationSession | null;
      targetSessionKey: string | null;
    }) => {
      if (suppressEmitErrors) {
        try {
          commitLogoutResult(attemptId, outcome);
        } catch {
          // Never re-throw from subscriber during rollback.
        }
      } else {
        commitLogoutResult(attemptId, outcome);
      }
    };

    // Guard against a newer persisted session before writing 'pending' (I3).
    if (storage && targetSessionKey !== null) {
      const currentPersistedKey = sessionKeyOf(
        readPersistedSupabaseSession(storage),
      );
      if (
        currentPersistedKey !== null &&
        currentPersistedKey !== targetSessionKey
      ) {
        abortForNewerSession();
        return;
      }
    }

    // 2. Synchronously try to persist 'pending' (with owner lease heartbeatAt)
    //    BEFORE removing sdkKey and WITHOUT awaiting Web Locks. If localStorage
    //    rejects the write (quota), the attempt continues in this tab's memory
    //    while sdkKey is still removed/tombstoned synchronously.
    const pendingCoord: SharedLogoutCoord = {
      attemptId,
      ownerTabId: tabId,
      state: 'pending',
      sessionKey: targetSessionKey,
      heartbeatAt: Date.now(),
    };
    const persistResult = persistLogoutCoordWithQuotaFallback(
      storage,
      pendingCoord,
      targetSessionKey,
    );
    if (persistResult.skippedNewerSession) {
      abortForNewerSession();
      return;
    }
    if (persistResult.superseded) {
      if (machine.activeAttemptId === attemptId) {
        machine.activeAttemptId = null;
      }
      if (pendingSignOutPromise === task) {
        pendingSignOutPromise = null;
        activeSignOutTargetKey = null;
      }
      safeReconcile();
      if (
        machine.activeAttemptId === null &&
        isBlockingLogoutPhase(machine.logoutPhase) &&
        readSharedCoord(storage)?.state !== 'pending'
      ) {
        clearPendingAbandonmentWatch();
        machine.logoutPhase = 'idle';
        machine.backedByStorage = false;
        safeEmit();
      }
      resolveTask();
      return;
    }

    const sessionForRevocation =
      capturedSession ?? persistResult.removedSession;
    machine.backedByStorage = persistResult.written;
    if (sessionForRevocation) {
      machine.retainedRevocationSession = sessionForRevocation;
    }

    // 3. Synchronously remove (or tombstone) sdkKey on direct-transport clients.
    const isDirect = hasDirectRevocationTransport(client);
    let localOk = false;
    if (isDirect) {
      if (storage) {
        const removal = removePersistedSupabaseCredentials(
          storage,
          targetSessionKey,
        );
        if (removal.skippedNewerSession) {
          abortForNewerSession();
          return;
        }
        localOk = !removal.stillPresentForTarget;
      } else {
        localOk = true;
      }

      if (!localOk || !sessionForRevocation) {
        const revocationOk =
          localOk && !hadUnconfirmedRevocation && targetSessionKey === null;
        if (epoch === storeEpoch) {
          commitSafe({
            localOk,
            revocationOk,
            retainedSession: localOk ? null : sessionForRevocation,
            targetSessionKey,
          });
          if (pendingSignOutPromise === task) {
            pendingSignOutPromise = null;
            activeSignOutTargetKey = null;
          }
        }
        resolveTask();
        return;
      }
    }

    // 4. Synchronously acquire per-attempt+tab lock (non-blocking, try/catch
    //    safe for P3-1) and start the 2 s owner lease heartbeat, then run async
    //    revocation / mock signOut.
    const attemptLock = startAttemptLock(attemptId, tabId, epoch);
    let heartbeatStopped = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const stopHeartbeat = () => {
      if (heartbeatStopped) return;
      heartbeatStopped = true;
      activeHeartbeatStops.delete(stopHeartbeat);
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    activeHeartbeatStops.add(stopHeartbeat);
    heartbeatTimer = setInterval(() => {
      if (
        heartbeatStopped ||
        epoch !== storeEpoch ||
        machine.activeAttemptId !== attemptId
      ) {
        stopHeartbeat();
        return;
      }
      if (!refreshPendingLease(storage, pendingCoord)) {
        stopHeartbeat();
      }
    }, PENDING_HEARTBEAT_INTERVAL_MS);

    void (async () => {
      let revocationOk = false;
      let retainedSession: RetainedRevocationSession | null =
        sessionForRevocation;
      try {
        if (isDirect) {
          if (sessionForRevocation) {
            const revocation = await runBoundedRevocation(
              client,
              sessionForRevocation,
            );
            revocationOk = revocation.ok;
            retainedSession = revocation.session;
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
            const revocation = await runBoundedRevocation(
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
        settled = true;
        stopHeartbeat();
        if (epoch === storeEpoch) {
          commitSafe({
            localOk,
            revocationOk,
            retainedSession,
            targetSessionKey,
          });
          if (pendingSignOutPromise === task) {
            pendingSignOutPromise = null;
            activeSignOutTargetKey = null;
          }
        }
        attemptLock.release();
        resolveTask();
      }
    })();

    if (!settled) {
      await task;
    }
  }

  async function signIn(
    email: string,
    password: string,
  ): Promise<'ok' | 'invalid' | 'failed'> {
    const client = deps.getClient();
    if (!client) return 'failed';
    if (pendingSignOutPromise) {
      await pendingSignOutPromise.catch(() => {});
    }
    reconcileFromShared();
    if (isPwaBlockedByLogout(machine.logoutPhase)) {
      return 'failed';
    }
    const storage = deps.getStorage();
    const sharedBefore = readSharedCoord(storage);
    const directTransportWithNoCreds =
      hasDirectRevocationTransport(client) &&
      !hasPersistedSupabaseCredentials(storage);
    if (
      !directTransportWithNoCreds &&
      (sharedBefore?.state === 'pending' ||
        sharedBefore?.state === 'local_failed')
    ) {
      return 'failed';
    }

    const preSignInMachineSession = machine.session;
    signInInProgressCount += 1;
    let decrementedSignIn = false;
    const endSignInProgress = () => {
      if (!decrementedSignIn) {
        decrementedSignIn = true;
        signInInProgressCount = Math.max(0, signInInProgressCount - 1);
      }
    };
    if (signInInProgressCount === 1) {
      signInRejectedOwnSession = null;
    }
    let acceptedSession: Session | null = null;
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return classifySignInError(error);
      acceptedSession =
        data?.session ??
        (machine.session !== preSignInMachineSession ? machine.session : null);

      const attemptId = nextAttemptId(storage);
      const newSessionKey =
        sessionKeyOf(data?.session) ??
        sessionKeyOf(readPersistedSupabaseSession(storage));
      const signedInWrite = writeSharedCoord(storage, {
        attemptId,
        ownerTabId: tabId,
        state: 'signed_in',
        sessionKey: newSessionKey,
      });
      if (signedInWrite.superseded) {
        reconcileFromShared();
        if (
          isPwaBlockedByLogout(machine.logoutPhase) ||
          machine.session === null
        ) {
          return 'failed';
        }
        return 'ok';
      }
      if (data?.session && machine.session === null) {
        acceptAuthenticatedSession(data.session, 'SIGNED_IN', null);
      } else {
        machine.logoutPhase = 'idle';
        machine.activeAttemptId = null;
        machine.backedByStorage = false;
        machine.retainedRevocationSession = null;
        machine.revokedSessionKey = null;
        emit();
      }
      return 'ok';
    } catch (caughtError) {
      endSignInProgress();
      const rejectedInCallback = signInRejectedOwnSession;
      if (rejectedInCallback && caughtError === rejectedInCallback.error) {
        signInRejectedOwnSession = null;
      }

      const currentShared = readSharedCoord(storage);
      const isPublishedByOtherTab = (key: string | null): boolean =>
        currentShared !== null &&
        currentShared.state === 'signed_in' &&
        currentShared.ownerTabId !== tabId &&
        (currentShared.sessionKey === null ||
          key === null ||
          currentShared.sessionKey === key);

      // Only roll back when THIS attempt's own session was accepted (either
      // returned by signInWithPassword or accepted inside our own
      // signInWithPassword callback that threw the exact caught error). Never
      // infer ownership from whatever session happens to be in storage now (I3).
      let ownAcceptedSession: Session | null = acceptedSession;
      if (
        ownAcceptedSession === null &&
        rejectedInCallback !== null &&
        caughtError === rejectedInCallback.error
      ) {
        const rejectedKey = sessionKeyOf(rejectedInCallback.session);
        if (!isPublishedByOtherTab(rejectedKey)) {
          ownAcceptedSession = rejectedInCallback.session;
        }
      }

      if (ownAcceptedSession !== null) {
        const retained = extractRevocationSession(ownAcceptedSession);
        const targetKey = sessionKeyOf(retained);
        await executeSignOutAttempt({
          client,
          storage,
          capturedSession: retained,
          targetSessionKey: targetKey,
          hadUnconfirmedRevocation: false,
          clearResolvedPins: false,
          suppressEmitErrors: true,
        });
      }
      return 'failed';
    } finally {
      endSignInProgress();
      if (signInInProgressCount === 0) {
        signInRejectedOwnSession = null;
      }
    }
  }

  async function retryLogoutRevocation(): Promise<void> {
    const client = deps.getClient();
    if (!client) return;
    // DELTA12-P2-2: Never dispatch global logout retry while a fresh signIn is
    // in flight in this tab so it cannot revoke the brand-new session (I3).
    if (signInInProgressCount > 0) return;
    if (pendingSignOutPromise) {
      await pendingSignOutPromise.catch(() => {});
      return;
    }
    if (pendingRevocationPromise) {
      await pendingRevocationPromise;
      return;
    }
    reconcileFromShared();
    if (machine.logoutPhase !== 'revocation_failed') {
      return;
    }
    const storage = deps.getStorage();
    const sharedBefore = readSharedCoord(storage);
    if (sharedBefore?.state === 'signed_in') {
      reconcileFromShared();
      return;
    }
    const expectedSessionKey =
      sharedBefore?.sessionKey ?? machine.revokedSessionKey;

    // P3-1: If a late cross-tab refresh re-persisted sdkKey, refuse if it is a
    // newer session, or evict same-session credentials (retaining rotated
    // tokens, or downgrading to local_failed if eviction fails).
    if (
      hasDirectRevocationTransport(client) &&
      storage &&
      hasPersistedSupabaseCredentials(storage)
    ) {
      const persisted = readPersistedSupabaseSession(storage);
      const persistedKey = sessionKeyOf(persisted);
      if (
        persistedKey !== null &&
        expectedSessionKey !== null &&
        persistedKey !== expectedSessionKey
      ) {
        machine.logoutPhase = 'idle';
        machine.backedByStorage = false;
        machine.retainedRevocationSession = null;
        machine.revokedSessionKey = null;
        reconcileFromShared();
        emit();
        return;
      }
      const removal = removePersistedSupabaseCredentials(
        storage,
        expectedSessionKey,
      );
      if (removal.skippedNewerSession) {
        reconcileFromShared();
        return;
      }
      if (removal.stillPresentForTarget) {
        const failAttemptId = nextAttemptId(storage);
        machine.activeAttemptId = failAttemptId;
        commitLogoutResult(failAttemptId, {
          localOk: false,
          revocationOk: false,
          retainedSession: persisted ?? machine.retainedRevocationSession,
          targetSessionKey: expectedSessionKey,
        });
        return;
      }
      if (persisted !== null) {
        machine.retainedRevocationSession = persisted;
      }
    }

    const sessionToRevoke = machine.retainedRevocationSession;
    if (!sessionToRevoke) {
      // I2: Never clear logoutRevocationFailed or report success without
      // actually performing global revocation.
      return;
    }
    const retainedKey = sessionKeyOf(sessionToRevoke);
    if (
      expectedSessionKey !== null &&
      retainedKey !== null &&
      retainedKey !== expectedSessionKey
    ) {
      machine.retainedRevocationSession = null;
      emit();
      return;
    }

    // P1-1: Coordinate global revocation retry across tabs via pending + lease
    // + per-attempt lock so no sibling tab can sign in concurrently and get its
    // fresh session globally revoked by our in-flight POST /logout?scope=global (I3).
    const attemptId = nextAttemptId(storage);
    const epoch = storeEpoch;
    const targetSessionKey = retainedKey ?? machine.revokedSessionKey;
    const pendingCoord: SharedLogoutCoord = {
      attemptId,
      ownerTabId: tabId,
      state: 'pending',
      sessionKey: targetSessionKey,
      heartbeatAt: Date.now(),
    };
    const pendingWrite = writeSharedCoord(storage, pendingCoord);
    if (pendingWrite.superseded) {
      reconcileFromShared();
      return;
    }

    machine.activeAttemptId = attemptId;
    machine.logoutPhase = 'retrying_revocation';
    machine.backedByStorage = pendingWrite.written;
    machine.status = 'signed-out';
    machine.email = null;
    emit();

    const attemptLock = startAttemptLock(attemptId, tabId, epoch);
    let heartbeatStopped = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const stopHeartbeat = () => {
      if (heartbeatStopped) return;
      heartbeatStopped = true;
      activeHeartbeatStops.delete(stopHeartbeat);
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    activeHeartbeatStops.add(stopHeartbeat);
    heartbeatTimer = setInterval(() => {
      if (
        heartbeatStopped ||
        epoch !== storeEpoch ||
        machine.activeAttemptId !== attemptId
      ) {
        stopHeartbeat();
        return;
      }
      if (!refreshPendingLease(storage, pendingCoord)) {
        stopHeartbeat();
      }
    }, PENDING_HEARTBEAT_INTERVAL_MS);

    let task: Promise<void> | null = null;
    task = (async () => {
      let revocationOk = false;
      let retainedSession: RetainedRevocationSession | null = sessionToRevoke;
      try {
        const revocation = await runBoundedRevocation(client, sessionToRevoke);
        revocationOk = revocation.ok;
        retainedSession = revocation.session;
      } catch {
        revocationOk = false;
      } finally {
        stopHeartbeat();
        if (epoch === storeEpoch) {
          commitLogoutResult(attemptId, {
            localOk: true,
            revocationOk,
            retainedSession,
            targetSessionKey,
          });
          if (pendingRevocationPromise === task) {
            pendingRevocationPromise = null;
          }
        }
        attemptLock.release();
      }
    })();
    pendingRevocationPromise = task;
    await task;
  }

  async function signOut(): Promise<void> {
    const client = deps.getClient();
    if (!client) return;
    const initialRevokedKey =
      machine.session === null ? machine.revokedSessionKey : null;
    reconcileFromShared();

    const storage = deps.getStorage();
    const hasStoredSdkCreds = hasPersistedSupabaseCredentials(storage);
    if (
      machine.session === null &&
      !hasStoredSdkCreds &&
      machine.logoutPhase === 'idle' &&
      (machine.knownCoord?.state === 'completed' ||
        (hasDirectRevocationTransport(client) &&
          machine.knownCoord?.state === 'signed_in'))
    ) {
      return;
    }
    const persistedSession = readPersistedSupabaseSession(storage);
    const persistedKeyNow = sessionKeyOf(persistedSession);
    const clearStaleBlockForNewerSession = (): void => {
      if (
        isBlockingLogoutPhase(machine.logoutPhase) ||
        machine.logoutPhase === 'revocation_failed'
      ) {
        clearPendingAbandonmentWatch();
        machine.logoutPhase = 'idle';
        machine.backedByStorage = false;
        machine.retainedRevocationSession = null;
        machine.revokedSessionKey = null;
      }
      reconcileFromShared();
      emit();
    };
    if (
      storage &&
      initialRevokedKey !== null &&
      persistedKeyNow !== null &&
      persistedKeyNow !== initialRevokedKey
    ) {
      clearStaleBlockForNewerSession();
      return;
    }
    // P2-1 / DELTA10-P3-4: When signed out with a known revokedSessionKey,
    // never adopt a different (newer) persisted session from storage as our
    // logout target. When signed in and storage holds a freshly rotated token
    // copy for the SAME sessionKey (not older by expiresAt), prefer the
    // persisted copy over stale in-memory machine.session so global revocation
    // and its retry use live rotated tokens instead of a consumed refresh token.
    const inMemorySession = extractRevocationSession(machine.session);
    const inMemoryKey = sessionKeyOf(inMemorySession);
    const matchingPersistedSession =
      machine.session === null && machine.revokedSessionKey !== null
        ? persistedKeyNow === machine.revokedSessionKey
          ? persistedSession
          : null
        : persistedSession;
    const persistedIsOlderByExpiry =
      inMemorySession !== null &&
      matchingPersistedSession !== null &&
      inMemorySession.expiresAt !== null &&
      matchingPersistedSession.expiresAt !== null &&
      matchingPersistedSession.expiresAt < inMemorySession.expiresAt;
    const preferPersistedForSameSession =
      inMemorySession !== null &&
      matchingPersistedSession !== null &&
      inMemoryKey !== null &&
      persistedKeyNow === inMemoryKey &&
      !persistedIsOlderByExpiry &&
      ((matchingPersistedSession.expiresAt !== null &&
        (inMemorySession.expiresAt === null ||
          matchingPersistedSession.expiresAt > inMemorySession.expiresAt)) ||
        matchingPersistedSession.accessToken !== inMemorySession.accessToken ||
        matchingPersistedSession.refreshToken !== inMemorySession.refreshToken);
    const capturedSession = preferPersistedForSameSession
      ? matchingPersistedSession
      : (inMemorySession ??
        matchingPersistedSession ??
        machine.retainedRevocationSession);
    const targetSessionKey =
      machine.session === null && machine.revokedSessionKey !== null
        ? machine.revokedSessionKey
        : (sessionKeyOf(capturedSession) ?? machine.revokedSessionKey);

    // P2-1: Coalesce duplicate in-tab signOut() calls for the same session on
    // direct transport so double-clicks never fire a second /logout request.
    if (
      pendingSignOutPromise !== null &&
      hasDirectRevocationTransport(client) &&
      (targetSessionKey === activeSignOutTargetKey || targetSessionKey === null)
    ) {
      await pendingSignOutPromise;
      return;
    }

    if (
      machine.session === null &&
      machine.logoutPhase === 'revocation_failed' &&
      !hasStoredSdkCreds &&
      machine.retainedRevocationSession !== null
    ) {
      await retryLogoutRevocation();
      return;
    }

    // NEW-4 / DELTA9-P2-2: Check for a newer persisted session BEFORE writing
    // 'pending' so a stale signOut never leaves a dangling pending coord or
    // leaves a local_failed tab permanently stuck with login disabled (I3, I4).
    if (storage && targetSessionKey !== null) {
      const persistedKey = sessionKeyOf(readPersistedSupabaseSession(storage));
      if (persistedKey !== null && persistedKey !== targetSessionKey) {
        clearStaleBlockForNewerSession();
        return;
      }
    }

    const hadUnconfirmedRevocation =
      machine.logoutPhase === 'revocation_failed';
    await executeSignOutAttempt({
      client,
      storage,
      capturedSession,
      targetSessionKey,
      hadUnconfirmedRevocation,
      clearResolvedPins: true,
    });
  }

  function retryOwnerCheck(): void {
    const session = machine.session;
    if (!session) return;
    checkOwner(session);
  }

  function resetAuthStore(options?: { clearStorage?: boolean }): void {
    storeEpoch += 1;
    checkId += 1;
    signInInProgressCount = 0;
    signInRejectedOwnSession = null;
    lastAllocatedAttemptId = 0;
    activeAttemptRotatedSession = null;
    clearPendingAbandonmentWatch();
    abortInFlightRevocations();
    stopAllHeartbeats();
    pendingSignOutPromise = null;
    activeSignOutTargetKey = null;
    pendingRevocationPromise = null;
    releaseAllAttemptLocks();
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
      knownCoord: null,
      knownSeq: 0,
      knownStateRank: 0,
      knownOwnerTabId: null,
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
): Promise<'ok' | 'invalid' | 'failed'> {
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
