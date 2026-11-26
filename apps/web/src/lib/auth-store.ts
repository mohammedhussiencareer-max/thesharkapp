import type { Session } from '@supabase/supabase-js';
import type { AuthStatus, LogoutPhase } from '@/lib/auth-context';
import {
  bumpSessionGeneration,
  clearResolvedHeldWritesForUser,
  isWritesLocked,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWriteUser,
  setHeldWritesTabActive,
  setWritesLocked,
} from '@/lib/held-writes';
import { setPwaAuthResolved, setPwaLogoutPending } from '@/lib/pwa';
import { readSupabaseEnv, supabase } from '@/lib/supabase';

const LOGOUT_RECORD_KEY_PREFIX = 'theshark:auth:logout-pending:v1:';
const FALLBACK_PROJECT = 'default';
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 30_000;
const REVOCATION_REQUEST_TIMEOUT_MS = 10_000;
const SDK_SESSION_TOMBSTONE = '';

export type DurableLogoutState =
  'pending' | 'local_failed' | 'revocation_failed';

export type DurableLogoutRecord = {
  attemptId: number;
  state: DurableLogoutState;
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
  _sessionRemovalEpoch?: unknown;
  autoRefreshToken?: unknown;
  __thesharkManagedAutoRefresh?: unknown;
  initializePromise?: Promise<unknown> | null;
  broadcastChannel?: { close?: () => void } | null;
  stateChangeEmitters?: { clear?: () => void } | null;
  startAutoRefresh?: () => Promise<void> | void;
  stopAutoRefresh?: () => Promise<void> | void;
  dispose?: () => Promise<void> | void;
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

type HeldWritesAdapter = {
  bumpSessionGeneration: typeof bumpSessionGeneration;
  clearResolvedHeldWritesForUser: typeof clearResolvedHeldWritesForUser;
  isWritesLocked: typeof isWritesLocked;
  rehydrateHeldWrites: typeof rehydrateHeldWrites;
  resetHeldWritesStore: typeof resetHeldWritesStore;
  setHeldWriteUser: typeof setHeldWriteUser;
  setHeldWritesTabActive: typeof setHeldWritesTabActive;
  setWritesLocked: typeof setWritesLocked;
};

type AuthStoreDeps = {
  getClient: () => typeof supabase;
  getProjectUrl: () => string | undefined;
  getStorage: () => Storage | null;
  storageKey?: string;
  heldWrites?: HeldWritesAdapter;
  syncGlobalStores?: boolean;
  initiallyActive?: boolean;
};

type MachineState = {
  status: AuthStatus;
  email: string | null;
  session: Session | null;
  lastUserId: string | null;
  logoutPhase: LogoutPhase;
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

function isDurableLogoutState(value: unknown): value is DurableLogoutState {
  return (
    value === 'pending' ||
    value === 'local_failed' ||
    value === 'revocation_failed'
  );
}

function parseDurableLogoutRecord(
  raw: string | null,
): DurableLogoutRecord | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (record.state === 'completed' || record.state === 'signed_in') {
        // Legacy completed/signed_in record from earlier multi-tab builds: no unfinished sign-out.
        return null;
      }
      if (isDurableLogoutState(record.state)) {
        const attemptId =
          typeof record.attemptId === 'number' &&
          Number.isInteger(record.attemptId) &&
          record.attemptId > 0
            ? record.attemptId
            : 1;
        const sessionKey =
          typeof record.sessionKey === 'string' && record.sessionKey.length > 0
            ? record.sessionKey
            : null;
        return { attemptId, state: record.state, sessionKey };
      }
    }
    // Malformed / legacy non-object marker (e.g. '1'): fail closed.
    return { attemptId: 1, state: 'local_failed', sessionKey: null };
  } catch {
    // Legacy non-JSON marker: fail closed.
    return { attemptId: 1, state: 'local_failed', sessionKey: null };
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
    // I2: Never treat a rejected refresh token (e.g. 400 refresh_token_not_found)
    // as confirmation that all other sessions were globally revoked.
    return { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

/**
 * Executes POST /auth/v1/logout?scope=global without writing to localStorage.
 *
 * Bounded by REVOCATION_REQUEST_TIMEOUT_MS (10 s) via AbortController.
 * Invariant I2: ONLY a confirmed HTTP 2xx response from global logout counts as
 * ok=true; refresh failures, aborts, and non-2xx responses return ok=false so
 * the UI surfaces that remote revocation was not confirmed and offers a retry.
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

export function getLogoutCoordStorageKey(projectUrl?: string): string {
  const url = (projectUrl ?? defaultProjectUrl())?.trim();
  const project = url && url.length > 0 ? url : FALLBACK_PROJECT;
  return `${LOGOUT_RECORD_KEY_PREFIX}${encodeURIComponent(project)}`;
}

function initialMachineState(): MachineState {
  return {
    status: 'loading',
    email: null,
    session: null,
    lastUserId: null,
    logoutPhase: 'idle',
    activeAttemptId: null,
    backedByStorage: false,
    retainedRevocationSession: null,
    revokedSessionKey: null,
  };
}

/**
 * Single-active-tab auth store.
 *
 * At most one browser tab is active at a time (enforced by `active-tab.ts` via
 * Web Locks). This store keeps only a small durable per-browser localStorage
 * record of an unfinished or failed sign-out so the next active tab after
 * reload, crash, or takeover always boots into a safe conservative state:
 * - pending + credentials present -> `local_failed` (login blocked, retry sign-out)
 * - pending + credentials gone -> `revocation_failed` (amber notice, login enabled,
 *   retry only when a token is retained in memory)
 */
export function createAuthStore(customDeps?: Partial<AuthStoreDeps>) {
  const deps: AuthStoreDeps = {
    getClient: customDeps?.getClient ?? (() => supabase),
    getProjectUrl: customDeps?.getProjectUrl ?? defaultProjectUrl,
    getStorage: customDeps?.getStorage ?? defaultStorage,
    storageKey: customDeps?.storageKey,
    heldWrites: customDeps?.heldWrites,
    syncGlobalStores: customDeps?.syncGlobalStores ?? true,
    initiallyActive: customDeps?.initiallyActive ?? true,
  };

  const syncGlobal = deps.syncGlobalStores !== false;
  const hw: HeldWritesAdapter = deps.heldWrites ?? {
    bumpSessionGeneration,
    clearResolvedHeldWritesForUser,
    isWritesLocked,
    rehydrateHeldWrites,
    resetHeldWritesStore,
    setHeldWriteUser,
    setHeldWritesTabActive,
    setWritesLocked,
  };

  let active = deps.initiallyActive !== false;
  let machine: MachineState = initialMachineState();
  let snapshot: AuthSnapshot = deriveSnapshot(machine);
  let started = false;
  let activeClient: typeof supabase = null;
  let checkId = 0;
  let storeEpoch = 0;
  let lastAttemptId = 0;
  let signOutEpoch = 0;
  let latestSignInStartSignOutEpoch = -1;
  let signInInProgressCount = 0;
  let signInRejectedOwnSession: { session: Session; error: unknown } | null =
    null;
  let activeAttemptRotatedSession: {
    attemptId: number;
    session: RetainedRevocationSession;
  } | null = null;
  let pendingSignOutPromise: Promise<void> | null = null;
  let activeSignOutTargetKey: string | null = null;
  let pendingRevocationPromise: Promise<void> | null = null;
  const activeRevocationAbortControllers = new Set<AbortController>();
  const revokedSessionKeys = new Set<string>();
  let unsubscribeAll: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function rememberRevokedSessionKey(key: string | null): void {
    if (key === null || key.length === 0) return;
    revokedSessionKeys.add(key);
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

  function recordKey(): string {
    return getLogoutCoordStorageKey(deps.getProjectUrl());
  }

  function readDurableLogoutRecord(
    storage: Storage | null,
  ): DurableLogoutRecord | null {
    if (!storage) return null;
    try {
      return parseDurableLogoutRecord(storage.getItem(recordKey()));
    } catch {
      return null;
    }
  }

  function writeDurableLogoutRecord(
    storage: Storage | null,
    record: DurableLogoutRecord,
  ): boolean {
    if (!storage || !active) return false;
    try {
      storage.setItem(recordKey(), JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  function clearDurableLogoutRecord(storage: Storage | null): void {
    if (!storage || !active) return;
    try {
      storage.removeItem(recordKey());
    } catch {
      // Ignore storage cleanup errors.
    }
  }

  function nextAttemptId(storage: Storage | null): number {
    const existing = readDurableLogoutRecord(storage);
    const next = Math.max(lastAttemptId, existing?.attemptId ?? 0) + 1;
    lastAttemptId = next;
    return next;
  }

  function supabaseAuthStorageKeys(): string[] {
    const keys = new Set<string>();
    if (typeof deps.storageKey === 'string' && deps.storageKey.trim() !== '') {
      keys.add(deps.storageKey.trim());
    }
    const client = activeClient as
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

  function disposeAuthClient(
    client: NonNullable<typeof supabase> | null | undefined,
  ): void {
    const auth = client?.auth as unknown as AuthClientInternals | undefined;
    if (!auth) return;
    const tearDown = () => {
      try {
        auth.broadcastChannel?.close?.();
        if ('broadcastChannel' in auth) {
          auth.broadcastChannel = null;
        }
        auth.stateChangeEmitters?.clear?.();
      } catch {
        // Ignore on mock or frozen auth objects.
      }
      try {
        if (typeof auth.stopAutoRefresh === 'function') {
          void Promise.resolve(auth.stopAutoRefresh()).catch(() => {});
        }
        if (typeof auth.dispose === 'function') {
          void Promise.resolve(auth.dispose()).catch(() => {});
        }
      } catch {
        // Ignore teardown errors on demoted clients.
      }
    };
    tearDown();
    if (
      auth.initializePromise &&
      typeof auth.initializePromise.then === 'function'
    ) {
      void auth.initializePromise.then(
        () => tearDown(),
        () => tearDown(),
      );
    }
  }

  function startClientAutoRefresh(
    client: NonNullable<typeof supabase> | null | undefined,
  ): void {
    if (!client || !active) return;
    if (machine.logoutPhase !== 'idle' || machine.session === null) return;
    const auth = client.auth as unknown as AuthClientInternals;
    const autoRefreshManaged =
      auth.__thesharkManagedAutoRefresh === true ||
      auth.autoRefreshToken === true;
    if (!autoRefreshManaged) return;
    if (typeof auth.startAutoRefresh === 'function') {
      void Promise.resolve(auth.startAutoRefresh()).catch(() => {});
    }
  }

  function stopClientAutoRefresh(
    client: NonNullable<typeof supabase> | null | undefined,
  ): void {
    if (!client) return;
    const auth = client.auth as unknown as AuthClientInternals;
    const stop = () => {
      if (typeof auth.stopAutoRefresh === 'function') {
        void Promise.resolve(auth.stopAutoRefresh()).catch(() => {});
      }
    };
    stop();
    if (
      auth.initializePromise &&
      typeof auth.initializePromise.then === 'function'
    ) {
      const epoch = storeEpoch;
      void auth.initializePromise.then(
        () => {
          if (
            epoch !== storeEpoch ||
            !active ||
            machine.logoutPhase !== 'idle' ||
            machine.session === null
          ) {
            stop();
          }
        },
        () => stop(),
      );
    }
  }

  function bumpClientSessionRemovalEpoch(): void {
    const client = activeClient;
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
   * throws, overwrites with an empty tombstone ('') that GoTrueClient treats
   * as no session. Reports failure only if both fail and credentials remain.
   */
  function removePersistedSupabaseCredentials(
    storage: Storage,
    expectedSessionKey: string | null,
  ): {
    removed: boolean;
    stillPresentForTarget: boolean;
    skippedNewerSession: boolean;
  } {
    if (!active) {
      return {
        removed: false,
        stillPresentForTarget: false,
        skippedNewerSession: false,
      };
    }
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
        // If removeItem throws, overwrite with an empty tombstone ('') that
        // GoTrueClient treats as no session.
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
      rememberRevokedSessionKey(existingKey ?? expectedSessionKey);
      bumpClientSessionRemovalEpoch();
    }

    return {
      removed: !stillPresentForTarget,
      stillPresentForTarget,
      skippedNewerSession: false,
    };
  }

  /**
   * Persist a durable logout record; if localStorage rejects the write (quota),
   * capture the stored session in memory for global revocation, fenced-remove
   * (or tombstone) the SDK credentials so reload cannot restore owner access
   * (I1), then retry persisting the durable record into the freed space.
   */
  function persistDurableLogoutWithQuotaFallback(
    storage: Storage | null,
    record: DurableLogoutRecord,
    expectedSessionKey: string | null,
  ): {
    written: boolean;
    skippedNewerSession: boolean;
    removedLocalCredentials: boolean;
    removedSession: RetainedRevocationSession | null;
    stillPresentForTarget: boolean;
  } {
    if (!storage || !active) {
      return {
        written: false,
        skippedNewerSession: false,
        removedLocalCredentials: false,
        removedSession: null,
        stillPresentForTarget: false,
      };
    }
    if (writeDurableLogoutRecord(storage, record)) {
      return {
        written: true,
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
      return {
        written: false,
        skippedNewerSession: true,
        removedLocalCredentials: false,
        removedSession: null,
        stillPresentForTarget: false,
      };
    }

    const writtenOnRetry = writeDurableLogoutRecord(storage, record);
    return {
      written: writtenOnRetry,
      skippedNewerSession: false,
      removedLocalCredentials: removal.removed,
      removedSession,
      stillPresentForTarget: removal.stillPresentForTarget,
    };
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
      hw.setWritesLocked(true);
      hw.bumpSessionGeneration();
      if (options?.clearResolvedPins && previousUserId && active) {
        hw.clearResolvedHeldWritesForUser(previousUserId);
      }
      hw.setHeldWriteUser(null);
    }
    machine.lastUserId = null;
  }

  function checkOwner(
    session: Session,
    options?: { keepCurrentOwner?: boolean },
  ): void {
    if (!active) return;
    const client = activeClient ?? deps.getClient();
    if (!client) return;
    const id = ++checkId;
    const epoch = storeEpoch;
    const email = emailOf(session);
    machine.email = email;
    machine.status =
      options?.keepCurrentOwner && machine.status === 'owner'
        ? 'owner'
        : 'checking';
    emit();

    // The auth callback holds a lock; defer the owner lookup so it cannot deadlock.
    setTimeout(() => {
      if (id !== checkId || epoch !== storeEpoch || !active) return;
      void (async () => {
        const { data, error } = await client.schema('app').rpc('is_owner');
        if (id !== checkId || epoch !== storeEpoch || !active) return;
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

  function acceptAuthenticatedSession(
    session: Session,
    event: string,
    previousSession: Session | null,
  ): void {
    const incomingKey = sessionKeyOf(session);
    if (
      machine.revokedSessionKey !== null &&
      machine.revokedSessionKey !== incomingKey
    ) {
      rememberRevokedSessionKey(machine.revokedSessionKey);
    }
    abortInFlightRevocations();
    machine.logoutPhase = 'idle';
    machine.activeAttemptId = null;
    machine.backedByStorage = false;
    machine.retainedRevocationSession = null;
    machine.revokedSessionKey = null;
    machine.session = session;
    const wasWritesLocked = syncGlobal ? hw.isWritesLocked() : false;
    const sameSession =
      !wasWritesLocked &&
      isSameAuthenticatedSession(previousSession, session, event);
    const previousUserId = previousSession?.user.id ?? machine.lastUserId;
    machine.lastUserId = session.user.id;
    if (syncGlobal) {
      if (!sameSession) {
        hw.bumpSessionGeneration();
      }
      if (previousUserId !== null && previousUserId !== session.user.id) {
        hw.setHeldWriteUser(null);
      }
      hw.setWritesLocked(false);
      hw.setHeldWriteUser(session.user.id);
      if (
        !sameSession &&
        !wasWritesLocked &&
        previousSession?.user.id === session.user.id
      ) {
        hw.rehydrateHeldWrites();
      }
    }
    startClientAutoRefresh(activeClient);
    checkOwner(session, { keepCurrentOwner: sameSession });
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
    if (!active) return;
    if (machine.activeAttemptId !== attemptId || machine.session !== null) {
      // I3: Superseded by a later attempt or a later sign-in; never override.
      return;
    }

    const storage = deps.getStorage();
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

    const currentClient = activeClient ?? deps.getClient();
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
      const persisted = persistDurableLogoutWithQuotaFallback(
        storage,
        {
          attemptId,
          state: 'local_failed',
          sessionKey: outcome.targetSessionKey,
        },
        outcome.targetSessionKey,
      );
      if (persisted.skippedNewerSession) {
        return;
      }
      machine.backedByStorage = persisted.written;
      machine.logoutPhase = 'local_failed';
      machine.retainedRevocationSession =
        effectiveRetainedSession ??
        persisted.removedSession ??
        machine.retainedRevocationSession;
      machine.revokedSessionKey = outcome.targetSessionKey;
      machine.session = null;
      machine.status = 'signed-out';
      machine.email = null;
      if (syncGlobal) {
        hw.setWritesLocked(true);
        hw.setHeldWriteUser(null);
      }
      stopClientAutoRefresh(currentClient);
      emit();
      return;
    }

    if (outcome.revocationOk) {
      clearDurableLogoutRecord(storage);
      rememberRevokedSessionKey(outcome.targetSessionKey);
      machine.logoutPhase = 'idle';
      machine.backedByStorage = false;
      machine.retainedRevocationSession = null;
      machine.revokedSessionKey =
        outcome.targetSessionKey ?? machine.revokedSessionKey;
      machine.session = null;
      machine.status = 'signed-out';
      machine.email = null;
      stopClientAutoRefresh(currentClient);
      ensureAuthSubscribed(currentClient);
      emit();
      return;
    }

    const wroteRevFailed = writeDurableLogoutRecord(storage, {
      attemptId,
      state: 'revocation_failed',
      sessionKey: outcome.targetSessionKey,
    });
    machine.logoutPhase = 'revocation_failed';
    machine.backedByStorage = wroteRevFailed;
    machine.retainedRevocationSession = effectiveRetainedSession;
    machine.revokedSessionKey = outcome.targetSessionKey;
    machine.session = null;
    machine.status = 'signed-out';
    machine.email = null;
    stopClientAutoRefresh(currentClient);
    ensureAuthSubscribed(currentClient);
    emit();
  }

  function ensureAuthSubscribed(
    client: NonNullable<typeof supabase> | null,
  ): void {
    if (!client || !active || unsubscribeAll !== null) return;
    activeClient = client;
    const epoch = storeEpoch;

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => {
      if (epoch !== storeEpoch || !active) return;
      const previousSession = machine.session;

      if (!session) {
        const currentStorage = deps.getStorage();
        if (
          event === 'SIGNED_OUT' &&
          machine.session !== null &&
          currentStorage !== null &&
          hasDirectRevocationTransport(client)
        ) {
          const currentKey = sessionKeyOf(machine.session);
          const persistedKey = sessionKeyOf(
            readPersistedSupabaseSession(currentStorage),
          );
          if (currentKey !== null && persistedKey === currentKey) {
            // Defensively ignore a spurious SIGNED_OUT broadcast that did not
            // clear this active tab's live session in localStorage (P1-1 / I3).
            return;
          }
        }
        lockSessionForSignOut({ clearResolvedPins: event === 'SIGNED_OUT' });
        machine.status = 'signed-out';
        machine.email = null;
        stopClientAutoRefresh(client);
        emit();
        return;
      }

      const incomingKey = sessionKeyOf(session);
      const currentStorage = deps.getStorage();
      const isRevokedSessionReplay =
        incomingKey !== null &&
        (incomingKey === machine.revokedSessionKey ||
          revokedSessionKeys.has(incomingKey));
      const isStaleSupersededSignIn =
        event === 'SIGNED_IN' &&
        signInInProgressCount > 0 &&
        latestSignInStartSignOutEpoch !== signOutEpoch;
      const isOwnFreshSignIn =
        signInInProgressCount > 0 &&
        latestSignInStartSignOutEpoch === signOutEpoch &&
        event === 'SIGNED_IN' &&
        !isRevokedSessionReplay;

      // I3: An earlier in-flight signIn superseded by a later signOut must
      // never be accepted or leave its session persisted.
      if (isStaleSupersededSignIn) {
        if (currentStorage !== null && incomingKey !== null) {
          rememberRevokedSessionKey(incomingKey);
          removePersistedSupabaseCredentials(currentStorage, incomingKey);
          if (
            machine.logoutPhase === 'local_failed' &&
            !hasPersistedSupabaseCredentials(currentStorage)
          ) {
            // Persisted credentials are now gone; move from local_failed to
            // revocation_failed so login is not left blocked with empty storage (I4).
            const attemptId = nextAttemptId(currentStorage);
            const wrote = writeDurableLogoutRecord(currentStorage, {
              attemptId,
              state: 'revocation_failed',
              sessionKey: machine.revokedSessionKey,
            });
            machine.logoutPhase = 'revocation_failed';
            machine.backedByStorage = wrote;
            machine.status = 'signed-out';
            machine.email = null;
            machine.session = null;
            emit();
          }
        }
        stopClientAutoRefresh(client);
        return;
      }

      // Block incoming session callbacks while local logout is in progress or
      // failed (I1), unless this tab's own deliberate signIn produced a fresh
      // session. Never reopen owner access on refocus/reload.
      if (isBlockingLogoutPhase(machine.logoutPhase) && !isOwnFreshSignIn) {
        stopClientAutoRefresh(client);
        if (machine.activeAttemptId === null && !machine.backedByStorage) {
          const attemptId = nextAttemptId(currentStorage);
          const targetKey = machine.revokedSessionKey ?? incomingKey;
          const fallback = persistDurableLogoutWithQuotaFallback(
            currentStorage,
            {
              attemptId,
              state: 'local_failed',
              sessionKey: targetKey,
            },
            targetKey,
          );
          machine.backedByStorage = fallback.written;
          if (fallback.removedLocalCredentials) {
            const retained =
              extractRevocationSession(session) ?? fallback.removedSession;
            if (retained) {
              machine.retainedRevocationSession = retained;
            }
            if (!fallback.stillPresentForTarget) {
              // Local creds were removed without global revocation; move to
              // revocation_failed with Retry so we never silently flip to idle (I2).
              machine.logoutPhase = 'revocation_failed';
              machine.revokedSessionKey = targetKey;
              if (fallback.written) {
                machine.backedByStorage = writeDurableLogoutRecord(
                  currentStorage,
                  {
                    attemptId,
                    state: 'revocation_failed',
                    sessionKey: targetKey,
                  },
                );
              }
            }
          }
        }
        if (isBlockingLogoutPhase(machine.logoutPhase)) {
          const isDistinctNewerSid = isDistinctSidSession(
            machine.revokedSessionKey,
            incomingKey,
          );
          if (
            (machine.logoutPhase === 'signing_out' ||
              machine.logoutPhase === 'retrying_local') &&
            currentStorage !== null &&
            incomingKey !== null &&
            (isRevokedSessionReplay ||
              (!isDistinctNewerSid &&
                (incomingKey === machine.revokedSessionKey ||
                  event === 'TOKEN_REFRESHED')))
          ) {
            removePersistedSupabaseCredentials(
              currentStorage,
              isRevokedSessionReplay
                ? incomingKey
                : machine.revokedSessionKey?.startsWith('sid:')
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
            hw.setWritesLocked(true);
            hw.setHeldWriteUser(null);
          }
          emit();
          return;
        }
      }

      // Reject stale callbacks while global revocation retry is in flight.
      if (machine.logoutPhase === 'retrying_revocation' && !isOwnFreshSignIn) {
        stopClientAutoRefresh(client);
        const isDistinctNewerSid = isDistinctSidSession(
          machine.revokedSessionKey,
          incomingKey,
        );
        if (
          currentStorage !== null &&
          incomingKey !== null &&
          (isRevokedSessionReplay ||
            (!isDistinctNewerSid &&
              (incomingKey === machine.revokedSessionKey ||
                event === 'TOKEN_REFRESHED')))
        ) {
          removePersistedSupabaseCredentials(
            currentStorage,
            isRevokedSessionReplay
              ? incomingKey
              : machine.revokedSessionKey?.startsWith('sid:')
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
        if (machine.session !== null || machine.lastUserId !== null) {
          lockSessionForSignOut({ clearResolvedPins: true });
        } else {
          checkId += 1;
          if (syncGlobal) {
            hw.setWritesLocked(true);
            hw.setHeldWriteUser(null);
          }
        }
        machine.session = null;
        machine.status = 'signed-out';
        machine.email = null;
        emit();
        return;
      }

      // Reject stale refocus / late TOKEN_REFRESHED for a revoked session or
      // unpersisted direct-transport session without touching a distinct newer sid.
      const isDistinctNewerSid = isDistinctSidSession(
        machine.revokedSessionKey,
        incomingKey,
      );
      const isDirectTransport =
        currentStorage !== null && hasDirectRevocationTransport(client);
      const persistedKeyInStorage = isDirectTransport
        ? sessionKeyOf(readPersistedSupabaseSession(currentStorage))
        : null;
      const hasPersistedDirectCreds =
        isDirectTransport && hasPersistedSupabaseCredentials(currentStorage);
      const isUnpersistedDirectSession =
        isDirectTransport &&
        (!hasPersistedDirectCreds ||
          (incomingKey !== null &&
            persistedKeyInStorage !== null &&
            persistedKeyInStorage !== incomingKey));
      const isStaleRefreshWhileSignedOut =
        event === 'TOKEN_REFRESHED' &&
        !isDistinctNewerSid &&
        machine.session === null &&
        machine.revokedSessionKey !== null;

      if (
        !isOwnFreshSignIn &&
        (isRevokedSessionReplay ||
          isUnpersistedDirectSession ||
          isStaleRefreshWhileSignedOut)
      ) {
        if (
          currentStorage !== null &&
          (isRevokedSessionReplay || isStaleRefreshWhileSignedOut)
        ) {
          removePersistedSupabaseCredentials(
            currentStorage,
            isRevokedSessionReplay
              ? incomingKey
              : machine.revokedSessionKey?.startsWith('sid:')
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
        // Keep the live newer session intact if we merely ignored a stale
        // event for an older revoked session.
        if (
          hasPersistedDirectCreds &&
          machine.session !== null &&
          persistedKeyInStorage !== null &&
          persistedKeyInStorage !== incomingKey &&
          sessionKeyOf(machine.session) === persistedKeyInStorage
        ) {
          return;
        }
        if (machine.session !== null || machine.lastUserId !== null) {
          lockSessionForSignOut({ clearResolvedPins: true });
        } else {
          checkId += 1;
          if (syncGlobal) {
            hw.setWritesLocked(true);
            hw.setHeldWriteUser(null);
          }
        }
        machine.session = null;
        machine.status = 'signed-out';
        machine.email = null;
        stopClientAutoRefresh(client);
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
      subscription.unsubscribe();
    };
  }

  function startAuth(): void {
    if (started || !active) return;

    // Step 1 (P2-2): Reconcile durable logout storage BEFORE touching
    // deps.getClient() so GoTrueClient cannot be constructed or fire a token
    // refresh for a logged-out / blocked session on boot or takeover.
    const storage = deps.getStorage();
    const initialRecord = readDurableLogoutRecord(storage);

    if (initialRecord !== null) {
      started = true;
      if (syncGlobal) {
        hw.setHeldWritesTabActive(true);
        hw.setHeldWriteUser(null);
      }
      lastAttemptId = Math.max(lastAttemptId, initialRecord.attemptId);
      const persistedKey = sessionKeyOf(readPersistedSupabaseSession(storage));
      const isStaleForOlderSession =
        initialRecord.sessionKey !== null &&
        persistedKey !== null &&
        initialRecord.sessionKey !== persistedKey;

      if (isStaleForOlderSession) {
        // Storage already holds a newer distinct session; discard stale logout record.
        clearDurableLogoutRecord(storage);
      } else {
        rememberRevokedSessionKey(initialRecord.sessionKey);
        if (
          initialRecord.state === 'pending' ||
          initialRecord.state === 'local_failed'
        ) {
          if (hasPersistedSupabaseCredentials(storage)) {
            // Credentials are still persisted: stay blocked in local_failed
            // WITHOUT instantiating GoTrueClient or starting auto-refresh (P2-2).
            const wrote =
              initialRecord.state === 'local_failed'
                ? true
                : writeDurableLogoutRecord(storage, {
                    attemptId: initialRecord.attemptId,
                    state: 'local_failed',
                    sessionKey: initialRecord.sessionKey,
                  });
            machine.status = 'signed-out';
            machine.email = null;
            machine.session = null;
            machine.logoutPhase = 'local_failed';
            machine.backedByStorage = wrote || true;
            machine.retainedRevocationSession = null;
            machine.revokedSessionKey = initialRecord.sessionKey;
            if (syncGlobal) {
              hw.setWritesLocked(true);
              hw.setHeldWriteUser(null);
            }
            emit();
            return;
          }

          // Credentials are absent in storage -> safe to obtain client to
          // check direct vs mock transport (no stored session to refresh).
          const client = deps.getClient();
          if (!client) {
            started = false;
            return;
          }
          activeClient = client;
          stopClientAutoRefresh(client);
          const isDirect = hasDirectRevocationTransport(client);
          if (isDirect) {
            const wrote = writeDurableLogoutRecord(storage, {
              attemptId: initialRecord.attemptId,
              state: 'revocation_failed',
              sessionKey: initialRecord.sessionKey,
            });
            machine.status = 'signed-out';
            machine.email = null;
            machine.session = null;
            machine.logoutPhase = 'revocation_failed';
            machine.backedByStorage = wrote || true;
            machine.retainedRevocationSession = null;
            machine.revokedSessionKey = initialRecord.sessionKey;
          } else {
            const wrote =
              initialRecord.state === 'local_failed'
                ? true
                : writeDurableLogoutRecord(storage, {
                    attemptId: initialRecord.attemptId,
                    state: 'local_failed',
                    sessionKey: initialRecord.sessionKey,
                  });
            machine.status = 'signed-out';
            machine.email = null;
            machine.session = null;
            machine.logoutPhase = 'local_failed';
            machine.backedByStorage = wrote || true;
            machine.retainedRevocationSession = null;
            machine.revokedSessionKey = initialRecord.sessionKey;
          }
          if (syncGlobal) {
            hw.setWritesLocked(true);
            hw.setHeldWriteUser(null);
          }
          emit();
          ensureAuthSubscribed(client);
          return;
        }

        if (initialRecord.state === 'revocation_failed') {
          let blockedLocally = false;
          if (storage !== null && hasPersistedSupabaseCredentials(storage)) {
            // Evict re-persisted sdkKey BEFORE instantiating GoTrueClient (P2-2).
            const removal = removePersistedSupabaseCredentials(
              storage,
              initialRecord.sessionKey,
            );
            if (removal.stillPresentForTarget) {
              blockedLocally = true;
            }
          }
          if (blockedLocally) {
            writeDurableLogoutRecord(storage, {
              attemptId: initialRecord.attemptId,
              state: 'local_failed',
              sessionKey: initialRecord.sessionKey,
            });
            machine.logoutPhase = 'local_failed';
            machine.status = 'signed-out';
            machine.email = null;
            machine.session = null;
            machine.backedByStorage = true;
            machine.retainedRevocationSession = null;
            machine.revokedSessionKey = initialRecord.sessionKey;
            if (syncGlobal) {
              hw.setWritesLocked(true);
              hw.setHeldWriteUser(null);
            }
            emit();
            return;
          }
          machine.logoutPhase = 'revocation_failed';
          machine.status = 'signed-out';
          machine.email = null;
          machine.session = null;
          machine.backedByStorage = true;
          machine.retainedRevocationSession = null;
          machine.revokedSessionKey = initialRecord.sessionKey;
          if (syncGlobal) {
            hw.setWritesLocked(true);
            hw.setHeldWriteUser(null);
          }
          emit();
          const client = deps.getClient();
          if (!client) {
            started = false;
            return;
          }
          activeClient = client;
          stopClientAutoRefresh(client);
          ensureAuthSubscribed(client);
          return;
        }
      }
    }

    const client = deps.getClient();
    if (!client) {
      started = false;
      return;
    }
    started = true;
    if (syncGlobal) {
      hw.setHeldWritesTabActive(true);
      hw.setHeldWriteUser(null);
    }
    ensureAuthSubscribed(client);
  }

  function subscribeAuth(listener: () => void): () => void {
    listeners.add(listener);
    if (active) {
      startAuth();
    }
    return () => {
      listeners.delete(listener);
    };
  }

  function getAuthSnapshot(): AuthSnapshot {
    return snapshot;
  }

  function isAuthResolved(): boolean {
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
    if (!active) return;
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

    const attemptId = nextAttemptId(storage);
    signOutEpoch += 1;
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
    //    await or storage mutation (I1/I5).
    pendingSignOutPromise = task;
    activeSignOutTargetKey = targetSessionKey;
    machine.activeAttemptId = attemptId;
    machine.logoutPhase = nextPhase;
    machine.backedByStorage = false;
    machine.revokedSessionKey = targetSessionKey;
    rememberRevokedSessionKey(targetSessionKey);
    if (capturedSession) {
      machine.retainedRevocationSession = capturedSession;
    }
    lockSessionForSignOut({ clearResolvedPins });
    stopClientAutoRefresh(client);
    machine.status = 'signed-out';
    machine.email = null;
    safeEmit();

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
        if (machine.activeAttemptId === attemptId) {
          machine.activeAttemptId = null;
        }
        machine.logoutPhase = 'idle';
        machine.backedByStorage = false;
        machine.retainedRevocationSession = null;
        machine.revokedSessionKey = null;
        if (pendingSignOutPromise === task) {
          pendingSignOutPromise = null;
          activeSignOutTargetKey = null;
        }
        safeEmit();
        resolveTask();
        return;
      }
    }

    // 2. Synchronously persist durable 'pending' BEFORE removing sdkKey.
    //    Under quota, fenced-remove/tombstone sdkKey first and retry writing.
    const persistResult = persistDurableLogoutWithQuotaFallback(
      storage,
      {
        attemptId,
        state: 'pending',
        sessionKey: targetSessionKey,
      },
      targetSessionKey,
    );
    if (persistResult.skippedNewerSession) {
      if (machine.activeAttemptId === attemptId) {
        machine.activeAttemptId = null;
      }
      machine.logoutPhase = 'idle';
      machine.backedByStorage = false;
      machine.retainedRevocationSession = null;
      machine.revokedSessionKey = null;
      if (pendingSignOutPromise === task) {
        pendingSignOutPromise = null;
        activeSignOutTargetKey = null;
      }
      safeEmit();
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
          if (machine.activeAttemptId === attemptId) {
            machine.activeAttemptId = null;
          }
          clearDurableLogoutRecord(storage);
          machine.logoutPhase = 'idle';
          machine.backedByStorage = false;
          machine.retainedRevocationSession = null;
          machine.revokedSessionKey = null;
          if (pendingSignOutPromise === task) {
            pendingSignOutPromise = null;
            activeSignOutTargetKey = null;
          }
          safeEmit();
          resolveTask();
          return;
        }
        localOk = !removal.stillPresentForTarget;
      } else {
        localOk = true;
      }

      if (!localOk || !sessionForRevocation) {
        const revocationOk =
          localOk && !hadUnconfirmedRevocation && targetSessionKey === null;
        if (epoch === storeEpoch && active) {
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

    // 4. Run bounded 10 s global revocation (or mock client signOut).
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
        if (epoch === storeEpoch && active) {
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
    if (!active) return 'failed';
    const client = activeClient ?? deps.getClient();
    if (!client) return 'failed';
    ensureAuthSubscribed(client);
    const epoch = storeEpoch;
    if (pendingSignOutPromise) {
      await pendingSignOutPromise.catch(() => {});
      if (epoch !== storeEpoch || !active) return 'failed';
    }
    if (isPwaBlockedByLogout(machine.logoutPhase)) {
      return 'failed';
    }
    const storage = deps.getStorage();
    const durableBefore = readDurableLogoutRecord(storage);
    const persistedKeyBefore = sessionKeyOf(
      readPersistedSupabaseSession(storage),
    );
    const isStaleRecordForOlderSession =
      durableBefore?.sessionKey != null &&
      persistedKeyBefore !== null &&
      durableBefore.sessionKey !== persistedKeyBefore;
    const directTransportWithNoCreds =
      hasDirectRevocationTransport(client) &&
      !hasPersistedSupabaseCredentials(storage);
    if (
      !isStaleRecordForOlderSession &&
      !directTransportWithNoCreds &&
      (durableBefore?.state === 'pending' ||
        durableBefore?.state === 'local_failed')
    ) {
      return 'failed';
    }

    const preSignInMachineSession = machine.session;
    const capturedSignOutEpoch = signOutEpoch;
    latestSignInStartSignOutEpoch = capturedSignOutEpoch;
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
      if (epoch !== storeEpoch || !active) return 'failed';
      if (signOutEpoch !== capturedSignOutEpoch) {
        // I3: A later signOut() ran while this earlier signIn() was in flight.
        // Never override the later sign-out or leave this stale session persisted.
        if (data?.session && storage) {
          const staleKey = sessionKeyOf(data.session);
          if (staleKey) {
            rememberRevokedSessionKey(staleKey);
            removePersistedSupabaseCredentials(storage, staleKey);
          }
        }
        return 'failed';
      }
      if (error) return classifySignInError(error);
      acceptedSession =
        data?.session ??
        (machine.session !== preSignInMachineSession ? machine.session : null);

      clearDurableLogoutRecord(storage);
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
      if (epoch !== storeEpoch || !active) return 'failed';
      const rejectedInCallback = signInRejectedOwnSession;
      if (rejectedInCallback && caughtError === rejectedInCallback.error) {
        signInRejectedOwnSession = null;
      }

      // Only roll back when THIS signIn's own session was accepted (either
      // returned by signInWithPassword or accepted inside our own SIGNED_IN
      // callback that threw the exact caught error).
      let ownAcceptedSession: Session | null = acceptedSession;
      if (
        ownAcceptedSession === null &&
        rejectedInCallback !== null &&
        caughtError === rejectedInCallback.error
      ) {
        ownAcceptedSession = rejectedInCallback.session;
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
    if (!active) return;
    const client = activeClient ?? deps.getClient();
    if (!client) return;
    // I3: Never dispatch global logout retry while a fresh signIn is in flight.
    if (signInInProgressCount > 0) return;
    if (pendingSignOutPromise) {
      await pendingSignOutPromise.catch(() => {});
      return;
    }
    if (pendingRevocationPromise) {
      await pendingRevocationPromise;
      return;
    }
    if (machine.logoutPhase !== 'revocation_failed') {
      return;
    }

    const epoch = storeEpoch;
    const storage = deps.getStorage();
    const expectedSessionKey = machine.revokedSessionKey;

    // If a late refresh re-persisted same-session credentials, evict them
    // (retaining rotated tokens, or downgrading to local_failed if removal fails).
    if (
      hasDirectRevocationTransport(client) &&
      storage !== null &&
      hasPersistedSupabaseCredentials(storage)
    ) {
      const persisted = readPersistedSupabaseSession(storage);
      const persistedKey = sessionKeyOf(persisted);
      if (
        persistedKey !== null &&
        expectedSessionKey !== null &&
        persistedKey !== expectedSessionKey
      ) {
        clearDurableLogoutRecord(storage);
        machine.logoutPhase = 'idle';
        machine.backedByStorage = false;
        machine.retainedRevocationSession = null;
        machine.revokedSessionKey = null;
        emit();
        return;
      }
      const removal = removePersistedSupabaseCredentials(
        storage,
        expectedSessionKey,
      );
      if (removal.skippedNewerSession) {
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

    const attemptId = nextAttemptId(storage);
    const targetSessionKey = retainedKey ?? machine.revokedSessionKey;
    const wrotePending = writeDurableLogoutRecord(storage, {
      attemptId,
      state: 'pending',
      sessionKey: targetSessionKey,
    });
    machine.activeAttemptId = attemptId;
    machine.logoutPhase = 'retrying_revocation';
    machine.backedByStorage = wrotePending;
    machine.status = 'signed-out';
    machine.email = null;
    stopClientAutoRefresh(client);
    emit();

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
        if (epoch === storeEpoch && active) {
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
      }
    })();
    pendingRevocationPromise = task;
    await task;
  }

  async function signOut(): Promise<void> {
    if (!active) return;
    const client = activeClient ?? deps.getClient();
    if (!client) return;

    const storage = deps.getStorage();
    const isDirect = hasDirectRevocationTransport(client);
    const hasStoredSdkCreds = hasPersistedSupabaseCredentials(storage);
    const persistedSession = readPersistedSupabaseSession(storage);
    const persistedKeyNow = sessionKeyOf(persistedSession);

    if (
      isDirect &&
      machine.session === null &&
      !hasStoredSdkCreds &&
      machine.logoutPhase === 'idle' &&
      machine.retainedRevocationSession === null
    ) {
      return;
    }

    // Prefer freshest tokens between in-memory session and persisted sdkKey
    // (e.g. after auto-refresh rotated tokens in localStorage).
    const inMemorySession = extractRevocationSession(machine.session);
    const inMemoryKey = sessionKeyOf(inMemorySession);
    const isSignedInTab = machine.session !== null;
    const matchingPersistedSession =
      !isSignedInTab && machine.revokedSessionKey !== null
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
      !isSignedInTab && machine.revokedSessionKey !== null
        ? machine.revokedSessionKey
        : (sessionKeyOf(capturedSession) ?? machine.revokedSessionKey);

    // Coalesce duplicate in-tab signOut() calls for the same session on direct transport.
    if (
      pendingSignOutPromise !== null &&
      isDirect &&
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

    if (!isSignedInTab && storage && targetSessionKey !== null) {
      const persistedKey = sessionKeyOf(readPersistedSupabaseSession(storage));
      if (persistedKey !== null && persistedKey !== targetSessionKey) {
        clearDurableLogoutRecord(storage);
        machine.logoutPhase = 'idle';
        machine.backedByStorage = false;
        machine.retainedRevocationSession = null;
        machine.revokedSessionKey = null;
        emit();
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
    if (!active) return;
    const session = machine.session;
    if (!session) return;
    checkOwner(session);
  }

  /**
   * Immediately stop all auth activity when this tab becomes inactive (I6).
   * Writes nothing to storage and makes no network calls.
   */
  function deactivate(): void {
    active = false;
    storeEpoch += 1;
    checkId += 1;
    signInInProgressCount = 0;
    signOutEpoch += 1;
    latestSignInStartSignOutEpoch = -1;
    signInRejectedOwnSession = null;
    activeAttemptRotatedSession = null;
    abortInFlightRevocations();
    pendingSignOutPromise = null;
    activeSignOutTargetKey = null;
    pendingRevocationPromise = null;
    unsubscribeAll?.();
    unsubscribeAll = null;
    const previousClient = activeClient;
    activeClient = null;
    if (previousClient) {
      disposeAuthClient(previousClient);
    }
    started = false;
    machine = initialMachineState();
    snapshot = deriveSnapshot(machine);
    if (syncGlobal) {
      hw.setHeldWritesTabActive(false);
      hw.setWritesLocked(true);
      hw.bumpSessionGeneration();
      hw.setHeldWriteUser(null);
      setPwaLogoutPending(false);
      setPwaAuthResolved(false);
    }
    for (const listener of listeners) listener();
  }

  function activate(): void {
    if (active) return;
    active = true;
    if (syncGlobal) {
      hw.setHeldWritesTabActive(true);
    }
    if (listeners.size > 0) {
      startAuth();
    }
  }

  function resetAuthStore(options?: { clearStorage?: boolean }): void {
    const storage = deps.getStorage();
    const shouldClearStorage = options?.clearStorage ?? true;
    storeEpoch += 1;
    checkId += 1;
    signInInProgressCount = 0;
    signOutEpoch += 1;
    latestSignInStartSignOutEpoch = -1;
    signInRejectedOwnSession = null;
    lastAttemptId = 0;
    activeAttemptRotatedSession = null;
    abortInFlightRevocations();
    pendingSignOutPromise = null;
    activeSignOutTargetKey = null;
    pendingRevocationPromise = null;
    revokedSessionKeys.clear();
    if (shouldClearStorage && storage) {
      try {
        storage.removeItem(recordKey());
      } catch {
        // Ignore storage cleanup errors.
      }
    }
    unsubscribeAll?.();
    unsubscribeAll = null;
    const previousClient = activeClient;
    activeClient = null;
    if (previousClient) {
      disposeAuthClient(previousClient);
    }
    started = false;
    active = deps.initiallyActive !== false;
    machine = initialMachineState();
    snapshot = deriveSnapshot(machine);
    if (syncGlobal) {
      setPwaLogoutPending(false);
      setPwaAuthResolved(false);
      hw.resetHeldWritesStore({ clearStorage: false, resetUser: true });
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
    activate,
    deactivate,
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

export function activateAuthStore(): void {
  defaultAuthStore.activate();
}

export function deactivateAuthStore(): void {
  defaultAuthStore.deactivate();
}

export function resetAuthStore(options?: { clearStorage?: boolean }): void {
  defaultAuthStore.resetAuthStore(options);
}
