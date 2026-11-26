import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_URL = 'https://example.test';
const TEST_ANON_KEY = 'anon-key-synthetic-test';
const SDK_STORAGE_KEY = 'sb-example-auth-token';
const MARKER_KEY = `theshark:auth:logout-pending:v1:${encodeURIComponent(TEST_URL)}`;

type MockFetchCall = {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
};

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function makeSession(overrides?: {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}) {
  return {
    access_token: overrides?.access_token ?? 'access-token-synthetic-1',
    refresh_token: overrides?.refresh_token ?? 'refresh-token-synthetic-1',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: overrides?.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: 'owner-real-sdk',
      email: 'owner@example.test',
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  };
}

function makeMemoryStorage() {
  const values = new Map<string, string>();
  let full = false;
  let zeroByteQuota = false;
  const storage: Storage & {
    setFull: (next: boolean) => void;
    setZeroByteQuota: (next: boolean) => void;
  } = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      const oldValue = values.get(key) ?? null;
      if (zeroByteQuota) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      if (full && oldValue === null) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      values.set(key, String(value));
    },
    setFull(next: boolean) {
      full = next;
    },
    setZeroByteQuota(next: boolean) {
      zeroByteQuota = next;
    },
  };
  return storage;
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.synthetic-sig`;
}

type StatefulServerSession = {
  sessionId: string;
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  revoked: boolean;
};

function createStatefulAuthServer(options?: {
  initialUserId?: string;
  initialEmail?: string;
  initialExpiresInSec?: number;
}) {
  const userId = options?.initialUserId ?? 'owner-real-sdk';
  const email = options?.initialEmail ?? 'owner@example.test';
  let seq = 0;
  let rotationSeq = 0;
  const sessionsById = new Map<string, StatefulServerSession>();
  const sessionIdByAccessToken = new Map<string, string>();
  const sessionIdByRefreshToken = new Map<string, string>();
  let confirmedGlobalLogouts = 0;

  function toSdkSession(record: StatefulServerSession) {
    return {
      access_token: record.accessToken,
      refresh_token: record.refreshToken,
      token_type: 'bearer',
      expires_in: Math.max(1, record.expiresAt - Math.floor(Date.now() / 1000)),
      expires_at: record.expiresAt,
      user: {
        id: record.userId,
        email: record.email,
        aud: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      },
    };
  }

  function issueSession(params?: {
    userId?: string;
    email?: string;
    expiresInSec?: number;
  }) {
    seq += 1;
    const sessionId = `sid-${seq}`;
    const uid = params?.userId ?? userId;
    const mail = params?.email ?? email;
    const expiresIn =
      params?.expiresInSec ?? options?.initialExpiresInSec ?? 3600;
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const accessToken = makeJwt({
      sub: uid,
      email: mail,
      session_id: sessionId,
      exp: expiresAt,
      jti: `at-${seq}-0`,
    });
    const refreshToken = `rt-${sessionId}-0`;
    const record: StatefulServerSession = {
      sessionId,
      userId: uid,
      email: mail,
      accessToken,
      refreshToken,
      expiresAt,
      revoked: false,
    };
    sessionsById.set(sessionId, record);
    sessionIdByAccessToken.set(accessToken, sessionId);
    sessionIdByRefreshToken.set(refreshToken, sessionId);
    return toSdkSession(record);
  }

  function expireSession(sessionId: string) {
    const record = sessionsById.get(sessionId);
    if (!record) return null;
    record.expiresAt = Math.floor(Date.now() / 1000) - 60;
    return toSdkSession(record);
  }

  function handleLogout(authorization: string | null): Response {
    const token = authorization?.replace(/^Bearer\s+/i, '').trim() ?? '';
    const sid = sessionIdByAccessToken.get(token);
    const record = sid ? sessionsById.get(sid) : undefined;
    if (!record || record.revoked) {
      return new Response(
        JSON.stringify({
          error_code: 'session_not_found',
          msg: 'Session from session_id claim in JWT does not exist',
        }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    record.revoked = true;
    confirmedGlobalLogouts += 1;
    return new Response(null, { status: 204 });
  }

  function handleRefresh(body: string | null): Response {
    let refreshToken = '';
    if (body) {
      try {
        refreshToken =
          (JSON.parse(body) as { refresh_token?: string }).refresh_token ?? '';
      } catch {
        refreshToken = '';
      }
    }
    const sid = sessionIdByRefreshToken.get(refreshToken);
    const record = sid ? sessionsById.get(sid) : undefined;
    if (!record || record.revoked || record.refreshToken !== refreshToken) {
      return new Response(
        JSON.stringify({
          error_code: 'refresh_token_not_found',
          msg: 'Invalid Refresh Token: Refresh Token Not Found',
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    rotationSeq += 1;
    record.expiresAt = Math.floor(Date.now() / 1000) + 3600;
    record.accessToken = makeJwt({
      sub: record.userId,
      email: record.email,
      session_id: record.sessionId,
      exp: record.expiresAt,
      jti: `at-${record.sessionId}-${rotationSeq}`,
    });
    record.refreshToken = `rt-${record.sessionId}-${rotationSeq}`;
    sessionIdByAccessToken.set(record.accessToken, record.sessionId);
    sessionIdByRefreshToken.set(record.refreshToken, record.sessionId);
    return new Response(JSON.stringify(toSdkSession(record)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function handlePasswordSignIn(params?: {
    userId?: string;
    email?: string;
  }): Response {
    const next = issueSession(params);
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return {
    issueSession,
    expireSession,
    handleLogout,
    handleRefresh,
    handlePasswordSignIn,
    isRevoked(sessionId: string) {
      return sessionsById.get(sessionId)?.revoked ?? false;
    },
    getConfirmedGlobalLogouts() {
      return confirmedGlobalLogouts;
    },
  };
}

describe('auth-store real SDK logout (single active tab)', () => {
  const origLocalStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'localStorage',
  );

  function installLocalStorage(storage: Storage) {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.doUnmock('@/lib/supabase');
    vi.resetModules();
    vi.restoreAllMocks();
    if (origLocalStorageDesc) {
      Object.defineProperty(window, 'localStorage', origLocalStorageDesc);
      Object.defineProperty(globalThis, 'localStorage', origLocalStorageDesc);
    }
  });

  it('P2: quota fallback removes persisted SDK credentials and still sends global /logout?scope=global via retained session', async () => {
    const storage = makeMemoryStorage();
    installLocalStorage(storage);
    const session = makeSession();
    storage.setItem(SDK_STORAGE_KEY, JSON.stringify(session));

    const calls: MockFetchCall[] = [];
    const mockFetch: typeof fetch = (input, init) => {
      const url = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (url.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('/auth/v1/logout')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(TEST_URL, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: SDK_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: mockFetch },
    });

    vi.doMock('@/lib/supabase', () => ({
      supabase: client,
      readSupabaseEnv: () => ({ url: TEST_URL, anonKey: TEST_ANON_KEY }),
    }));

    const authStore = await import('@/lib/auth-store');
    try {
      authStore.startAuth();
      await vi.waitFor(() => {
        expect(authStore.getAuthSnapshot().status).toBe('owner');
      });

      storage.setFull(true);
      await authStore.signOut();

      expect(storage.getItem(SDK_STORAGE_KEY)).toBeNull();
      const logoutCalls = calls.filter(
        (call) =>
          call.url.includes('/auth/v1/logout') &&
          call.url.includes('scope=global'),
      );
      expect(logoutCalls).toHaveLength(1);
      expect(logoutCalls[0]?.authorization).toBe(
        `Bearer ${session.access_token}`,
      );
      expect(authStore.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        email: null,
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
      expect(authStore.isAuthResolved()).toBe(true);
    } finally {
      authStore.resetAuthStore();
    }
  });

  it('P2: quota fallback preserves local credential removal, retains session in memory when global revocation fails, surfaces revocation failure separately, and succeeds on retry', async () => {
    const testUrl = 'https://example-revoke-retry.test';
    const sdkKey = 'sb-example-revoke-retry-auth-token';
    const markerKey = `theshark:auth:logout-pending:v1:${encodeURIComponent(testUrl)}`;
    const storage = makeMemoryStorage();
    installLocalStorage(storage);
    const session = makeSession({
      access_token: 'access-token-revocation-retry',
    });
    storage.setItem(sdkKey, JSON.stringify(session));

    let failLogout = true;
    const calls: MockFetchCall[] = [];
    const mockFetch: typeof fetch = (input, init) => {
      const url = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (url.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('/auth/v1/logout')) {
        if (failLogout) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'service unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(testUrl, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: mockFetch },
    });

    vi.doMock('@/lib/supabase', () => ({
      supabase: client,
      readSupabaseEnv: () => ({ url: testUrl, anonKey: TEST_ANON_KEY }),
    }));

    const authStore = await import('@/lib/auth-store');
    try {
      authStore.startAuth();
      await vi.waitFor(() => {
        expect(authStore.getAuthSnapshot().status).toBe('owner');
      });

      storage.setFull(true);
      await authStore.signOut();

      expect(storage.getItem(sdkKey)).toBeNull();
      expect(storage.getItem(markerKey)).toBeNull();
      expect(
        calls.filter(
          (call) =>
            call.url.includes('/auth/v1/logout') &&
            call.url.includes('scope=global'),
        ),
      ).toHaveLength(1);
      expect(authStore.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        email: null,
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });

      failLogout = false;
      await authStore.signOut();

      const logoutCalls = calls.filter(
        (call) =>
          call.url.includes('/auth/v1/logout') &&
          call.url.includes('scope=global'),
      );
      expect(logoutCalls).toHaveLength(2);
      expect(logoutCalls[1]?.authorization).toBe(
        `Bearer ${session.access_token}`,
      );
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(authStore.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        email: null,
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
    } finally {
      authStore.resetAuthStore();
    }
  });

  it('P2: quota fallback refreshes an expired access token in memory without rewriting localStorage before global revocation', async () => {
    const testUrl = 'https://example-revoke-refresh.test';
    const sdkKey = 'sb-example-revoke-refresh-auth-token';
    const storage = makeMemoryStorage();
    installLocalStorage(storage);
    const expiredSession = makeSession({
      access_token: 'expired-access-token',
      refresh_token: 'valid-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });
    storage.setItem(sdkKey, JSON.stringify(expiredSession));

    const calls: MockFetchCall[] = [];
    const mockFetch: typeof fetch = (input, init) => {
      const url = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...expiredSession,
              access_token: 'fresh-access-token-for-revoke',
              refresh_token: 'rotated-refresh-token',
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      if (url.includes('/auth/v1/logout')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(testUrl, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: mockFetch },
    });

    vi.doMock('@/lib/supabase', () => ({
      supabase: client,
      readSupabaseEnv: () => ({ url: testUrl, anonKey: TEST_ANON_KEY }),
    }));

    const authStore = await import('@/lib/auth-store');
    try {
      authStore.startAuth();
      storage.setFull(true);
      await authStore.signOut();

      expect(storage.getItem(sdkKey)).toBeNull();
      expect(
        calls.some((call) =>
          call.url.includes('/auth/v1/token?grant_type=refresh_token'),
        ),
      ).toBe(true);
      const logoutCalls = calls.filter(
        (call) =>
          call.url.includes('/auth/v1/logout') &&
          call.url.includes('scope=global'),
      );
      expect(logoutCalls).toHaveLength(1);
      expect(logoutCalls[0]?.authorization).toBe(
        'Bearer fresh-access-token-for-revoke',
      );
      expect(authStore.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
    } finally {
      authStore.resetAuthStore();
    }
  });

  it('P3: older failed logout in the same tab does not rewrite marker or clobber a newer successful logout', async () => {
    const storage = makeMemoryStorage();
    installLocalStorage(storage);
    const session = makeSession();
    storage.setItem(SDK_STORAGE_KEY, JSON.stringify(session));

    const sdkSubscribers = new Set<
      (
        event: string,
        nextSession: ReturnType<typeof makeSession> | null,
      ) => void
    >();
    let resolveFirst: (value: { error: Error | null }) => void = () => {};
    let callCount = 0;

    vi.doMock('@/lib/supabase', () => ({
      supabase: {
        auth: {
          storageKey: SDK_STORAGE_KEY,
          onAuthStateChange(
            callback: (
              event: string,
              nextSession: ReturnType<typeof makeSession> | null,
            ) => void,
          ) {
            sdkSubscribers.add(callback);
            callback('INITIAL_SESSION', session);
            return {
              data: {
                subscription: {
                  unsubscribe() {
                    sdkSubscribers.delete(callback);
                  },
                },
              },
            };
          },
          signInWithPassword: () =>
            Promise.resolve({
              data: { user: null, session: null },
              error: null,
            }),
          signOut() {
            callCount += 1;
            if (callCount === 1) {
              return new Promise<{ error: Error | null }>((resolve) => {
                resolveFirst = resolve;
              });
            }
            storage.removeItem(SDK_STORAGE_KEY);
            for (const listener of [...sdkSubscribers]) {
              listener('SIGNED_OUT', null);
            }
            return Promise.resolve({ error: null });
          },
        },
        schema: () => ({
          rpc: () => Promise.resolve({ data: true, error: null }),
        }),
      },
      readSupabaseEnv: () => ({ url: TEST_URL, anonKey: TEST_ANON_KEY }),
    }));

    const authStore = await import('@/lib/auth-store');
    try {
      authStore.startAuth();
      await vi.waitFor(() => {
        expect(authStore.getAuthSnapshot().status).toBe('owner');
      });

      const firstPending = authStore.signOut();
      const firstMarker = JSON.parse(storage.getItem(MARKER_KEY) ?? 'null') as {
        attemptId?: number;
        state?: string;
      } | null;
      expect(firstMarker).toMatchObject({ attemptId: 1, state: 'pending' });

      await authStore.signOut();
      expect(storage.getItem(MARKER_KEY)).toBeNull();
      expect(authStore.getAuthSnapshot().logoutFailed).toBe(false);

      resolveFirst({ error: new Error('older in-tab call failed') });
      await firstPending;

      expect(storage.getItem(MARKER_KEY)).toBeNull();
      expect(authStore.getAuthSnapshot().logoutFailed).toBe(false);
      expect(authStore.isAuthResolved()).toBe(true);
    } finally {
      authStore.resetAuthStore();
    }
  });

  it('pr65-final6 #1 (I2): quota fallback with expired token and 400 refresh_token_not_found must NOT report global logout success', async () => {
    const testUrl = 'https://example-final6-refresh400.test';
    const sdkKey = 'sb-example-final6-refresh400-auth-token';
    const storage = makeMemoryStorage();
    installLocalStorage(storage);
    const expiredSession = makeSession({
      access_token: 'expired-access-token',
      refresh_token: 'revoked-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });

    const calls: MockFetchCall[] = [];
    const mockFetch: typeof fetch = (input, init) => {
      const url = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error_code: 'refresh_token_not_found',
              msg: 'Invalid Refresh Token: Refresh Token Not Found',
            }),
            {
              status: 400,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      if (url.includes('/auth/v1/logout')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(testUrl, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: mockFetch },
    });

    vi.doMock('@/lib/supabase', () => ({
      supabase: client,
      readSupabaseEnv: () => ({ url: testUrl, anonKey: TEST_ANON_KEY }),
    }));

    const authStore = await import('@/lib/auth-store');
    try {
      authStore.startAuth();
      storage.setItem(sdkKey, JSON.stringify(expiredSession));
      storage.setFull(true);
      await authStore.signOut();

      expect(storage.getItem(sdkKey)).toBeNull();
      expect(
        calls.some((call) =>
          call.url.includes('/auth/v1/token?grant_type=refresh_token'),
        ),
      ).toBe(true);
      expect(
        calls.filter((call) => call.url.includes('/auth/v1/logout')),
      ).toHaveLength(0);
      expect(authStore.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
    } finally {
      authStore.resetAuthStore();
    }
  });
});

type MatrixOutcome =
  | 'success'
  | 'revocation_503'
  | 'revocation_400_refresh'
  | 'revocation_401'
  | 'quota_full_success'
  | 'quota_full_503'
  | 'quota_full_400_refresh'
  | 'local_remove_failure';

type MatrixPostCheck = 'reload' | 'refocus';

const MATRIX_OUTCOMES: readonly MatrixOutcome[] = [
  'success',
  'revocation_503',
  'revocation_400_refresh',
  'revocation_401',
  'quota_full_success',
  'quota_full_503',
  'quota_full_400_refresh',
  'local_remove_failure',
];
const MATRIX_POST_CHECKS: readonly MatrixPostCheck[] = ['reload', 'refocus'];

const SINGLE_TAB_LOGOUT_MATRIX = MATRIX_OUTCOMES.flatMap((outcome) =>
  MATRIX_POST_CHECKS.map((postCheck) => ({ outcome, postCheck })),
);

describe('auth-store single-active-tab state machine invariant matrix (I1-I5)', () => {
  const origLocalStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'localStorage',
  );

  afterEach(() => {
    vi.useRealTimers();
    if (origLocalStorageDesc) {
      Object.defineProperty(window, 'localStorage', origLocalStorageDesc);
      Object.defineProperty(globalThis, 'localStorage', origLocalStorageDesc);
    }
  });

  it.each(SINGLE_TAB_LOGOUT_MATRIX)(
    'outcome=$outcome | post=$postCheck',
    async ({ outcome, postCheck }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const [{ createAuthStore }, heldWrites] = await Promise.all([
        import('@/lib/auth-store'),
        import('@/lib/held-writes'),
      ]);

      const url = `https://matrix-${outcome}-${postCheck}.test`;
      const sdkKey = `sb-matrix-${outcome}-${postCheck}-auth-token`;

      const values = new Map<string, string>();
      let full = false;
      let failRemove = false;

      const storage: Storage = {
        get length() {
          return values.size;
        },
        clear() {
          values.clear();
        },
        getItem(key: string) {
          return values.get(key) ?? null;
        },
        key(index: number) {
          return [...values.keys()][index] ?? null;
        },
        removeItem(key: string) {
          if (failRemove && key === sdkKey) {
            throw new DOMException('StorageLocked', 'InvalidStateError');
          }
          values.delete(key);
        },
        setItem(key: string, value: string) {
          if (failRemove && key === sdkKey) {
            throw new DOMException('StorageLocked', 'InvalidStateError');
          }
          const oldValue = values.get(key) ?? null;
          if (full && oldValue === null) {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
          }
          values.set(key, String(value));
        },
      };

      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: storage,
      });
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storage,
      });

      const isExpiredOutcome =
        outcome === 'revocation_400_refresh' ||
        outcome === 'quota_full_400_refresh';
      const isQuotaOutcome =
        outcome === 'quota_full_success' ||
        outcome === 'quota_full_503' ||
        outcome === 'quota_full_400_refresh';

      const server = createStatefulAuthServer();
      const initialSession = server.issueSession();
      values.set(sdkKey, JSON.stringify(initialSession));

      heldWrites.resetHeldWritesStore({ clearStorage: false, resetUser: true });
      const ownerPrefix = heldWrites.userStoragePrefix('owner-real-sdk');
      const otherPrefix = heldWrites.userStoragePrefix('other-user');
      const unresolvedOwnerKey = `${ownerPrefix}${encodeURIComponent('count:daily')}`;
      const postedOwnerKey = `${ownerPrefix}posted:${encodeURIComponent('items:reload')}:${encodeURIComponent('req-posted-1')}`;
      const otherUserKey = `${otherPrefix}${encodeURIComponent('count:daily')}`;
      values.set(
        unresolvedOwnerKey,
        JSON.stringify({
          v: 1,
          subject: 'count:daily',
          requestId: 'req-unresolved-1',
          payload: { qty: 3 },
          phase: 'unknown',
        }),
      );
      values.set(
        postedOwnerKey,
        JSON.stringify({
          v: 1,
          subject: 'items:reload',
          requestId: 'req-posted-1',
          payload: {},
          phase: 'posted_reload',
        }),
      );
      values.set(
        otherUserKey,
        JSON.stringify({
          v: 1,
          subject: 'count:daily',
          requestId: 'req-other-user-1',
          payload: { qty: 99 },
          phase: 'unknown',
        }),
      );

      const fetchA: typeof fetch = (input, init) => {
        const href = requestUrlOf(input);
        const headers = new Headers(init?.headers);
        const authorization = headers.get('authorization');
        const body = typeof init?.body === 'string' ? init.body : null;
        if (href.includes('/rest/v1/rpc/is_owner')) {
          return Promise.resolve(
            new Response(JSON.stringify(true), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (
          href.includes('/auth/v1/logout') ||
          href.includes('/auth/v1/token?grant_type=refresh_token')
        ) {
          switch (outcome) {
            case 'success':
            case 'quota_full_success':
              return Promise.resolve(
                href.includes('/auth/v1/logout')
                  ? server.handleLogout(authorization)
                  : server.handleRefresh(body),
              );
            case 'revocation_503':
            case 'quota_full_503':
              return Promise.resolve(
                new Response(JSON.stringify({ message: 'unavailable' }), {
                  status: 503,
                  headers: { 'content-type': 'application/json' },
                }),
              );
            case 'revocation_401':
              return Promise.resolve(
                new Response(JSON.stringify({ message: 'invalid jwt' }), {
                  status: 401,
                  headers: { 'content-type': 'application/json' },
                }),
              );
            case 'revocation_400_refresh':
            case 'quota_full_400_refresh':
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    error_code: 'refresh_token_not_found',
                    msg: 'Invalid Refresh Token: Refresh Token Not Found',
                  }),
                  {
                    status: 400,
                    headers: { 'content-type': 'application/json' },
                  },
                ),
              );
            case 'local_remove_failure':
              return Promise.resolve(new Response(null, { status: 503 }));
          }
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const clientA = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchA },
      });

      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        syncGlobalStores: true,
      });

      let reloadedTab: ReturnType<typeof createAuthStore> | null = null;
      let clientC: ReturnType<typeof createClient> | null = null;

      try {
        tabA.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('owner');
        });

        expect(heldWrites.isWritesLocked()).toBe(false);
        expect(heldWrites.getHeldWrite('count:daily')?.requestId).toBe(
          'req-unresolved-1',
        );
        expect(heldWrites.hasPostedReload('items:reload')).toBe(true);

        let expiredOldSession = initialSession;
        if (isExpiredOutcome) {
          expiredOldSession = server.expireSession('sid-1')!;
          values.set(sdkKey, JSON.stringify(expiredOldSession));
          const internalsA = clientA.auth as unknown as {
            _notifyAllSubscribers: (
              event: string,
              session: unknown,
              broadcast?: boolean,
            ) => Promise<void>;
          };
          await internalsA._notifyAllSubscribers(
            'TOKEN_REFRESHED',
            expiredOldSession,
            false,
          );
        }
        if (isQuotaOutcome) full = true;
        if (outcome === 'local_remove_failure') failRemove = true;

        await tabA.signOut();

        // Unconditional I5 assertions on every row.
        expect(values.get(postedOwnerKey)).toBeUndefined();
        expect(values.get(unresolvedOwnerKey)).toBeDefined();
        expect(values.get(otherUserKey)).toBeDefined();
        expect(heldWrites.isWritesLocked()).toBe(true);
        expect(heldWrites.getHeldWrite('count:daily')).toBeNull();

        const expectsRevocationFailure =
          outcome === 'revocation_503' ||
          outcome === 'revocation_400_refresh' ||
          outcome === 'revocation_401' ||
          outcome === 'quota_full_503' ||
          outcome === 'quota_full_400_refresh';

        if (outcome === 'local_remove_failure') {
          expect(tabA.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutFailed: true,
            logoutPending: false,
          });
          expect(tabA.isAuthResolved()).toBe(false);
        } else {
          expect(values.get(sdkKey)).toBeUndefined();
          if (expectsRevocationFailure) {
            expect(server.getConfirmedGlobalLogouts()).toBe(0);
            expect(tabA.getAuthSnapshot()).toMatchObject({
              status: 'signed-out',
              logoutPhase: 'revocation_failed',
              logoutPending: false,
              logoutFailed: false,
              logoutRevocationFailed: true,
              canRetryLogoutRevocation: true,
            });
          } else {
            expect(server.getConfirmedGlobalLogouts()).toBe(1);
            expect(tabA.getAuthSnapshot()).toMatchObject({
              status: 'signed-out',
              logoutPhase: 'idle',
              logoutPending: false,
              logoutFailed: false,
              logoutRevocationFailed: false,
            });
          }
        }

        if (postCheck === 'reload') {
          await clientA.auth.stopAutoRefresh();
          tabA.resetAuthStore({ clearStorage: false });
          clientC = createClient(url, TEST_ANON_KEY, {
            auth: {
              storage,
              storageKey: sdkKey,
              persistSession: true,
              autoRefreshToken: false,
              detectSessionInUrl: false,
            },
            global: { fetch: fetchA },
          });
          reloadedTab = createAuthStore({
            getClient: () => clientC,
            getProjectUrl: () => url,
            getStorage: () => storage,
            syncGlobalStores: false,
          });
          reloadedTab.startAuth();
          await vi.advanceTimersByTimeAsync(20);
          expect(reloadedTab.getAuthSnapshot().status).toBe('signed-out');
          if (outcome === 'local_remove_failure') {
            expect(reloadedTab.getAuthSnapshot().logoutFailed).toBe(true);
          } else {
            expect(reloadedTab.getAuthSnapshot().logoutRevocationFailed).toBe(
              expectsRevocationFailure && !isQuotaOutcome,
            );
            expect(reloadedTab.getAuthSnapshot().canRetryLogoutRevocation).toBe(
              false,
            );
          }
        } else {
          const internalsA = clientA.auth as unknown as {
            _notifyAllSubscribers: (
              event: string,
              session: unknown,
              broadcast?: boolean,
            ) => Promise<void>;
          };
          await internalsA._notifyAllSubscribers(
            'SIGNED_IN',
            isExpiredOutcome ? expiredOldSession : initialSession,
            false,
          );
          await vi.advanceTimersByTimeAsync(20);
          expect(tabA.getAuthSnapshot().status).toBe('signed-out');
        }
      } finally {
        await clientA.auth.stopAutoRefresh();
        await clientC?.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
        reloadedTab?.resetAuthStore({ clearStorage: false });
        heldWrites.resetHeldWritesStore({
          clearStorage: false,
          resetUser: true,
        });
      }
    },
  );
});

describe('auth-store single-active-tab edge cases and regression coverage', () => {
  const origLocalStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'localStorage',
  );

  afterEach(() => {
    vi.useRealTimers();
    if (origLocalStorageDesc) {
      Object.defineProperty(window, 'localStorage', origLocalStorageDesc);
      Object.defineProperty(globalThis, 'localStorage', origLocalStorageDesc);
    }
  });

  it.each(['normal', 'quota_full', 'legacy_marker'] as const)(
    'P1-1: reload while state=pending (%s) surfaces conservative state immediately without deadlocking signIn()',
    async (mode) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { createAuthStore, getLogoutCoordStorageKey } =
        await import('@/lib/auth-store');
      const url = `https://p1-1-${mode}.test`;
      const sdkKey = `sb-p1-1-${mode}-auth-token`;
      const coordKey = getLogoutCoordStorageKey(url);
      const storage = makeMemoryStorage();
      const server = createStatefulAuthServer();
      const initialSession = server.issueSession();
      storage.setItem(sdkKey, JSON.stringify(initialSession));

      let releasePendingLogout: (() => void) | null = null;
      const fetchFn: typeof fetch = (input, init) => {
        const href = requestUrlOf(input);
        const headers = new Headers(init?.headers);
        if (href.includes('/rest/v1/rpc/is_owner')) {
          return Promise.resolve(
            new Response(JSON.stringify(true), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (href.includes('/auth/v1/logout')) {
          return new Promise<Response>((resolve) => {
            releasePendingLogout = () =>
              resolve(server.handleLogout(headers.get('authorization')));
          });
        }
        if (href.includes('/auth/v1/token?grant_type=password')) {
          return Promise.resolve(server.handlePasswordSignIn());
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const clientA = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });
      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        syncGlobalStores: false,
      });

      let clientReloaded: ReturnType<typeof createClient> | null = null;
      let reloadedTab: ReturnType<typeof createAuthStore> | null = null;

      try {
        if (mode === 'legacy_marker') {
          storage.removeItem(sdkKey);
          storage.setItem(coordKey, '1');
        } else {
          tabA.startAuth();
          await vi.waitFor(() => {
            expect(tabA.getAuthSnapshot().status).toBe('owner');
          });
          if (mode === 'quota_full') storage.setFull(true);
          const pendingPromise = tabA.signOut();
          await vi.waitFor(() => {
            expect(releasePendingLogout).not.toBeNull();
          });
          expect(storage.getItem(sdkKey)).toBeNull();
          await clientA.auth.stopAutoRefresh();
          tabA.resetAuthStore({ clearStorage: false });
          releasePendingLogout!();
          await pendingPromise;
          storage.setFull(false);
        }

        clientReloaded = createClient(url, TEST_ANON_KEY, {
          auth: {
            storage,
            storageKey: sdkKey,
            persistSession: true,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
          global: { fetch: fetchFn },
        });
        reloadedTab = createAuthStore({
          getClient: () => clientReloaded,
          getProjectUrl: () => url,
          getStorage: () => storage,
          syncGlobalStores: false,
        });

        reloadedTab.startAuth();
        await vi.advanceTimersByTimeAsync(20);

        if (mode === 'quota_full') {
          expect(reloadedTab.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'idle',
            logoutPending: false,
            logoutFailed: false,
            logoutRevocationFailed: false,
            canRetryLogoutRevocation: false,
          });
        } else {
          expect(reloadedTab.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'revocation_failed',
            logoutPending: false,
            logoutFailed: false,
            logoutRevocationFailed: true,
            canRetryLogoutRevocation: false,
          });
        }
        expect(reloadedTab.isAuthResolved()).toBe(true);

        expect(
          await reloadedTab.signIn('owner@example.test', 'ValidPassword123'),
        ).toBe('ok');
        await vi.waitFor(() => {
          expect(reloadedTab!.getAuthSnapshot().status).toBe('owner');
        });
        expect(reloadedTab.getAuthSnapshot().logoutRevocationFailed).toBe(
          false,
        );
      } finally {
        await clientA.auth.stopAutoRefresh();
        await clientReloaded?.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
        reloadedTab?.resetAuthStore({ clearStorage: false });
      }
    },
  );

  it.each(['revocation_503', 'revocation_401', 'quota_full_503'] as const)(
    'P1-2 Path A: retryLogoutRevocation() rejects refocus SIGNED_IN during retrying_revocation and converges (%s)',
    async (outcome) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { createAuthStore } = await import('@/lib/auth-store');
      const url = `https://retry-rev-${outcome}.test`;
      const sdkKey = `sb-retry-rev-${outcome}-auth-token`;
      const storage = makeMemoryStorage();
      const server = createStatefulAuthServer();
      const initialSession = server.issueSession();
      storage.setItem(sdkKey, JSON.stringify(initialSession));

      let failFirstLogout = true;
      let releaseRetryLogout: (() => void) | null = null;
      const fetchFn: typeof fetch = (input, init) => {
        const href = requestUrlOf(input);
        const headers = new Headers(init?.headers);
        if (href.includes('/rest/v1/rpc/is_owner')) {
          return Promise.resolve(
            new Response(JSON.stringify(true), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (href.includes('/auth/v1/logout')) {
          if (failFirstLogout) {
            failFirstLogout = false;
            return Promise.resolve(
              new Response(JSON.stringify({ message: 'err' }), {
                status: outcome === 'revocation_401' ? 401 : 503,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          return new Promise<Response>((resolve) => {
            releaseRetryLogout = () =>
              resolve(server.handleLogout(headers.get('authorization')));
          });
        }
        if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error_code: 'refresh_token_not_found' }),
              {
                status: 400,
                headers: { 'content-type': 'application/json' },
              },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const clientA = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });
      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        syncGlobalStores: false,
      });

      try {
        tabA.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('owner');
        });

        if (outcome === 'quota_full_503') storage.setFull(true);
        await tabA.signOut();
        expect(tabA.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'revocation_failed',
          logoutRevocationFailed: true,
          canRetryLogoutRevocation: true,
        });

        const retryPromise = tabA.retryLogoutRevocation();
        await vi.waitFor(() => {
          expect(releaseRetryLogout).not.toBeNull();
        });
        expect(tabA.getAuthSnapshot().logoutPhase).toBe('retrying_revocation');

        const internalsA = clientA.auth as unknown as {
          _notifyAllSubscribers: (
            event: string,
            session: unknown,
            broadcast?: boolean,
          ) => Promise<void>;
        };
        await internalsA._notifyAllSubscribers(
          'SIGNED_IN',
          initialSession,
          false,
        );
        await vi.advanceTimersByTimeAsync(20);

        expect(tabA.getAuthSnapshot().status).toBe('signed-out');
        expect(tabA.getAuthSnapshot().logoutPhase).toBe('retrying_revocation');

        releaseRetryLogout!();
        await retryPromise;

        expect(server.getConfirmedGlobalLogouts()).toBe(1);
        expect(tabA.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'idle',
          logoutRevocationFailed: false,
        });
      } finally {
        await clientA.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
      }
    },
  );

  it('P1-2 Path B: in-flight autoRefreshToken (_callRefreshToken) resolving after completed signOut does NOT reopen owner or persist rotated token', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p1-2-autorefresh-race.test';
    const sdkKey = 'sb-p1-2-autorefresh-race-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer({ initialExpiresInSec: 100 });
    const initialSession = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(initialSession));

    let releaseRefresh: (() => void) | null = null;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : null;
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
        const rotatedResponse = server.handleRefresh(body);
        return new Promise<Response>((resolve) => {
          releaseRefresh = () => resolve(rotatedResponse);
        });
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      await vi.advanceTimersByTimeAsync(35_000);
      await vi.waitFor(() => {
        expect(releaseRefresh).not.toBeNull();
      });

      await tab.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(tab.getAuthSnapshot().status).toBe('signed-out');

      releaseRefresh!();
      await vi.advanceTimersByTimeAsync(50);

      // Even if a late _callRefreshToken wrote a rotated token for the revoked sid:
      const rotatedSession = {
        ...initialSession,
        access_token: makeJwt({
          sub: 'owner-real-sdk',
          session_id: 'sid-1',
          exp: Math.floor(Date.now() / 1000) + 3600,
          jti: 'late-rotated',
        }),
        refresh_token: 'late-rotated-rt',
      };
      storage.setItem(sdkKey, JSON.stringify(rotatedSession));
      const internals = client.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internals._notifyAllSubscribers(
        'TOKEN_REFRESHED',
        rotatedSession,
        false,
      );
      await vi.advanceTimersByTimeAsync(50);

      expect(tab.getAuthSnapshot().status).toBe('signed-out');
      expect(storage.getItem(sdkKey)).toBeNull();
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('P2-1: duplicate same-tab signOut calls coalesce into one /logout request and converge to idle', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p2-1-same-tab-double-click.test';
    const sdkKey = 'sb-p2-1-same-tab-double-click-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let logoutRequests = 0;
    let releaseResponse: (() => void) | null = null;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        logoutRequests += 1;
        const res = server.handleLogout(headers.get('authorization'));
        return new Promise<Response>((resolve) => {
          releaseResponse = () => resolve(res);
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      const p1 = tab.signOut();
      const p2 = tab.signOut();
      await vi.waitFor(() => {
        expect(releaseResponse).not.toBeNull();
      });
      expect(logoutRequests).toBe(1);
      releaseResponse!();
      await Promise.all([p1, p2]);

      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('I5: syncGlobalStores preserves unresolved held writes across signOut for the same user and isolates them from another user', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const [{ createAuthStore }, heldWrites] = await Promise.all([
      import('@/lib/auth-store'),
      import('@/lib/held-writes'),
    ]);

    const url = 'https://i5-user-isolation.test';
    const sdkKey = 'sb-i5-user-isolation-auth-token';
    const storage = makeMemoryStorage();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });

    const server = createStatefulAuthServer({
      initialUserId: 'user-a',
      initialEmail: 'a@example.test',
    });
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let nextLoginUser: { userId: string; email: string } = {
      userId: 'user-b',
      email: 'b@example.test',
    };
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn(nextLoginUser));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: true,
    });

    try {
      heldWrites.resetHeldWritesStore({ clearStorage: false, resetUser: true });
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
      });

      const userAPrefix = heldWrites.userStoragePrefix('user-a');
      storage.setItem(
        `${userAPrefix}${encodeURIComponent('count:daily')}`,
        JSON.stringify({
          v: 1,
          subject: 'count:daily',
          requestId: 'req-user-a-unresolved',
          payload: { qty: 7 },
          phase: 'unknown',
        }),
      );
      storage.setItem(
        `${userAPrefix}posted:${encodeURIComponent('items:reload')}:${encodeURIComponent('req-user-a-posted')}`,
        JSON.stringify({
          v: 1,
          subject: 'items:reload',
          requestId: 'req-user-a-posted',
          payload: {},
          phase: 'posted_reload',
        }),
      );
      heldWrites.rehydrateHeldWrites();
      expect(heldWrites.getHeldWrite('count:daily')?.requestId).toBe(
        'req-user-a-unresolved',
      );

      await store.signOut();
      expect(heldWrites.isWritesLocked()).toBe(true);
      expect(heldWrites.getHeldWrite('count:daily')).toBeNull();
      expect(
        storage.getItem(`${userAPrefix}${encodeURIComponent('count:daily')}`),
      ).not.toBeNull();
      expect(
        storage.getItem(
          `${userAPrefix}posted:${encodeURIComponent('items:reload')}:${encodeURIComponent('req-user-a-posted')}`,
        ),
      ).toBeNull();

      nextLoginUser = { userId: 'user-b', email: 'b@example.test' };
      expect(await store.signIn('b@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
        expect(store.getAuthSnapshot().email).toBe('b@example.test');
      });
      expect(heldWrites.getHeldWrite('count:daily')).toBeNull();

      await store.signOut();
      nextLoginUser = { userId: 'user-a', email: 'a@example.test' };
      expect(await store.signIn('a@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
        expect(store.getAuthSnapshot().email).toBe('a@example.test');
      });
      expect(heldWrites.getHeldWrite('count:daily')?.requestId).toBe(
        'req-user-a-unresolved',
      );
    } finally {
      await client.auth.stopAutoRefresh();
      store.resetAuthStore({ clearStorage: false });
      heldWrites.resetHeldWritesStore({ clearStorage: false, resetUser: true });
    }
  });

  it('P1-1: real GoTrueClient local_remove_failure clears pendingSignOutPromise so retry signOut removes creds, revokes, and completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p1-1-local-remove-retry.test';
    const sdkKey = 'sb-p1-1-local-remove-retry-auth-token';

    const values = new Map<string, string>();
    let failRemoveSdkKey = true;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        if (failRemoveSdkKey && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (failRemoveSdkKey && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        values.set(k, String(v));
      },
    };

    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
      });

      await store.signOut();
      expect(store.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
        logoutPending: false,
      });
      expect(values.get(sdkKey)).toBeDefined();
      expect(server.getConfirmedGlobalLogouts()).toBe(0);

      // signIn while blocked in local_failed returns 'failed' without sending credentials.
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      // Storage recovers: retrying signOut removes creds, revokes globally, and completes.
      failRemoveSdkKey = false;
      await store.signOut();

      expect(values.get(sdkKey)).toBeUndefined();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(store.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
        logoutPending: false,
        logoutRevocationFailed: false,
      });
      expect(store.isAuthResolved()).toBe(true);
    } finally {
      await client.auth.stopAutoRefresh();
      store.resetAuthStore({ clearStorage: false });
    }
  });

  it('P1-1: real GoTrueClient signOut skips removing credentials when storage already holds a newer session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://p1-1-skip-newer.test';
    const sdkKey = 'sb-p1-1-skip-newer-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let injectSession2OnCoordRead = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        if (injectSession2OnCoordRead && k === coordKey) {
          injectSession2OnCoordRead = false;
          values.set(sdkKey, JSON.stringify(session2));
        }
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        values.delete(k);
      },
      setItem(k: string, v: string) {
        values.set(k, String(v));
      },
    };

    const server = createStatefulAuthServer();
    const session1 = server.issueSession();
    const session2 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(session1));

    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
      });

      injectSession2OnCoordRead = true;
      await store.signOut();

      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(session2.access_token);
      expect(storage.getItem(coordKey)).toBeNull();
      expect(store.getAuthSnapshot()).toMatchObject({
        logoutPhase: 'idle',
        logoutPending: false,
        logoutFailed: false,
      });
      expect(store.isAuthResolved()).toBe(true);
    } finally {
      await client.auth.stopAutoRefresh();
      store.resetAuthStore({ clearStorage: false });
    }
  });

  it.each(['revocation_204', 'revocation_503'] as const)(
    'P1-2(B) + NEW-2(a): post-accept signIn throw rolls back session, persists durable record, and survives reload (%s)',
    async (mode) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { createAuthStore, getLogoutCoordStorageKey } =
        await import('@/lib/auth-store');
      const url = `https://p1-2b-post-accept-${mode}.test`;
      const sdkKey = `sb-p1-2b-post-accept-${mode}-auth-token`;
      const coordKey = getLogoutCoordStorageKey(url);
      const storage = makeMemoryStorage();
      const server = createStatefulAuthServer();
      let failLogout = mode === 'revocation_503';

      const fetchFn: typeof fetch = (input, init) => {
        const href = requestUrlOf(input);
        const headers = new Headers(init?.headers);
        if (href.includes('/rest/v1/rpc/is_owner')) {
          return Promise.resolve(
            new Response(JSON.stringify(true), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (href.includes('/auth/v1/token?grant_type=password')) {
          return Promise.resolve(server.handlePasswordSignIn());
        }
        if (href.includes('/auth/v1/logout')) {
          if (failLogout) {
            return Promise.resolve(
              new Response(JSON.stringify({ message: 'unavailable' }), {
                status: 503,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          return Promise.resolve(
            server.handleLogout(headers.get('authorization')),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const clientA = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });
      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        syncGlobalStores: false,
      });

      let reloadedClient: ReturnType<typeof createClient> | null = null;
      let reloadedTab: ReturnType<typeof createAuthStore> | null = null;

      try {
        tabA.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('signed-out');
        });

        let throwOnce = true;
        const unsub = tabA.subscribeAuth(() => {
          if (throwOnce && tabA.getAuthSnapshot().status === 'checking') {
            throwOnce = false;
            throw new Error('post-accept subscriber boom');
          }
        });

        const result = await tabA.signIn(
          'owner@example.test',
          'ValidPassword123',
        );
        unsub();
        await vi.advanceTimersByTimeAsync(20);

        expect(result).toBe('failed');
        expect(storage.getItem(sdkKey)).toBeNull();

        if (mode === 'revocation_204') {
          expect(server.getConfirmedGlobalLogouts()).toBe(1);
          expect(storage.getItem(coordKey)).toBeNull();
          expect(tabA.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'idle',
            logoutRevocationFailed: false,
          });
        } else {
          expect(server.getConfirmedGlobalLogouts()).toBe(0);
          expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject(
            {
              state: 'revocation_failed',
            },
          );
          expect(tabA.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'revocation_failed',
            logoutRevocationFailed: true,
            canRetryLogoutRevocation: true,
          });

          // Reload before retry preserves the revocation_failed notice (without retry token).
          reloadedClient = createClient(url, TEST_ANON_KEY, {
            auth: {
              storage,
              storageKey: sdkKey,
              persistSession: true,
              autoRefreshToken: false,
              detectSessionInUrl: false,
            },
            global: { fetch: fetchFn },
          });
          reloadedTab = createAuthStore({
            getClient: () => reloadedClient,
            getProjectUrl: () => url,
            getStorage: () => storage,
            syncGlobalStores: false,
          });
          reloadedTab.startAuth();
          await vi.advanceTimersByTimeAsync(20);
          expect(reloadedTab.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'revocation_failed',
            logoutRevocationFailed: true,
            canRetryLogoutRevocation: false,
          });

          // Retry on running tab succeeds once server recovers.
          failLogout = false;
          await tabA.retryLogoutRevocation();
          expect(server.getConfirmedGlobalLogouts()).toBe(1);
          expect(tabA.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'idle',
            logoutRevocationFailed: false,
          });
        }
      } finally {
        await clientA.auth.stopAutoRefresh();
        await reloadedClient?.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
        reloadedTab?.resetAuthStore({ clearStorage: false });
      }
    },
  );

  it('P1-3: real GoTrueClient signInWithPassword returns failed for network error, 503, and 429, and invalid only for 400 invalid_credentials', async () => {
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p1-3-signin-errors.test';
    const sdkKey = 'sb-p1-3-signin-errors-auth-token';
    const storage = makeMemoryStorage();

    type FetchMode = 'network_reject' | 'http_503' | 'http_429' | 'http_400';
    let mode: FetchMode = 'network_reject';

    const fetchFn: typeof fetch = () => {
      switch (mode) {
        case 'network_reject':
          return Promise.reject(new TypeError('Failed to fetch'));
        case 'http_503':
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'Service Unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          );
        case 'http_429':
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error_code: 'over_request_rate_limit',
                msg: 'Too many requests',
              }),
              {
                status: 429,
                headers: { 'content-type': 'application/json' },
              },
            ),
          );
        case 'http_400':
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error_code: 'invalid_credentials',
                msg: 'Invalid login credentials',
              }),
              {
                status: 400,
                headers: { 'content-type': 'application/json' },
              },
            ),
          );
      }
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      store.startAuth();

      mode = 'network_reject';
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      mode = 'http_503';
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      mode = 'http_429';
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      mode = 'http_400';
      expect(await store.signIn('owner@example.test', 'WrongPassword123')).toBe(
        'invalid',
      );
    } finally {
      await client.auth.stopAutoRefresh();
      store.resetAuthStore({ clearStorage: false });
    }
  });

  it('P3-3: direct user switch without signOut clears previous user acknowledgedInflight entries (I5)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const [{ createAuthStore }, heldWrites] = await Promise.all([
      import('@/lib/auth-store'),
      import('@/lib/held-writes'),
    ]);

    const url = 'https://p3-3-user-switch.test';
    const sdkKey = 'sb-p3-3-user-switch-auth-token';
    const storage = makeMemoryStorage();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });

    const server = createStatefulAuthServer({
      initialUserId: 'user-a',
      initialEmail: 'a@example.test',
    });
    const sessionA = server.issueSession();
    const sessionB = server.issueSession({
      userId: 'user-b',
      email: 'b@example.test',
    });
    storage.setItem(sdkKey, JSON.stringify(sessionA));

    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: true,
    });

    try {
      heldWrites.resetHeldWritesStore({ clearStorage: false, resetUser: true });
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
        expect(store.getAuthSnapshot().email).toBe('a@example.test');
      });

      const claim = await heldWrites.claimFreshHeldWrite(
        'count:daily',
        () => ({ qty: 5 }),
        { requestId: 'req-user-a-ack' },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error('expected claim');

      storage.setFull(true);
      expect(() => {
        heldWrites.setHeldWritePhase(
          'count:daily',
          'req-user-a-ack',
          'posted_reload',
          {
            readTarget: '2030-04-01',
            expected: claim.record,
            session: claim.session,
          },
        );
      }).toThrow();
      claim.release();
      storage.setFull(false);

      expect(heldWrites.hasPostedReload('count:daily')).toBe(true);
      expect(heldWrites.hasPostedReloadForTarget('2030-04-01')).toBe(true);

      storage.setItem(sdkKey, JSON.stringify(sessionB));
      const internals = client.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internals._notifyAllSubscribers('SIGNED_IN', sessionB, false);
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
        expect(store.getAuthSnapshot().email).toBe('b@example.test');
      });

      expect(heldWrites.hasPostedReload('count:daily')).toBe(false);
      expect(heldWrites.hasPostedReloadForTarget('2030-04-01')).toBe(false);
      expect(heldWrites.listPostedReloadRecords()).toEqual([]);
      expect(
        storage.getItem(
          `${heldWrites.userStoragePrefix('user-a')}${encodeURIComponent('count:daily')}`,
        ),
      ).not.toBeNull();
    } finally {
      await client.auth.stopAutoRefresh();
      store.resetAuthStore({ clearStorage: false });
      heldWrites.resetHeldWritesStore({ clearStorage: false, resetUser: true });
    }
  });

  it('NEW-4: signOut skippedNewerSession race after pending write resets phase to idle, clears dangling pending record, and lets reload boot cleanly on newer session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://new-4-skip-race.test';
    const sdkKey = 'sb-new-4-skip-race-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const server = createStatefulAuthServer();
    const session1 = server.issueSession();
    const session2 = server.issueSession();

    const values = new Map<string, string>();
    values.set(sdkKey, JSON.stringify(session1));
    let injectNewerSessionOnPendingWrite = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        values.delete(k);
      },
      setItem(k: string, v: string) {
        values.set(k, String(v));
        if (injectNewerSessionOnPendingWrite && k === coordKey) {
          injectNewerSessionOnPendingWrite = false;
          values.set(sdkKey, JSON.stringify(session2));
        }
      },
    };

    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    let reloadedClient: ReturnType<typeof createClient> | null = null;
    let reloadedStore: ReturnType<typeof createAuthStore> | null = null;

    try {
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
      });

      injectNewerSessionOnPendingWrite = true;
      await store.signOut();

      expect(
        (
          JSON.parse(values.get(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(session2.access_token);
      expect(values.get(coordKey)).toBeUndefined();
      expect(store.getAuthSnapshot()).toMatchObject({
        logoutPhase: 'idle',
        logoutPending: false,
        logoutFailed: false,
      });
      expect(store.isAuthResolved()).toBe(true);

      reloadedClient = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });
      reloadedStore = createAuthStore({
        getClient: () => reloadedClient,
        getProjectUrl: () => url,
        getStorage: () => storage,
        syncGlobalStores: false,
      });
      reloadedStore.startAuth();
      await vi.waitFor(() => {
        expect(reloadedStore!.getAuthSnapshot().status).toBe('owner');
      });
      expect(reloadedStore.getAuthSnapshot().logoutFailed).toBe(false);
    } finally {
      await client.auth.stopAutoRefresh();
      await reloadedClient?.auth.stopAutoRefresh();
      store.resetAuthStore({ clearStorage: false });
      reloadedStore?.resetAuthStore({ clearStorage: false });
    }
  });

  it('NEW-5: real GoTrueClient classifySignInError returns invalid only for credential rejections and failed for 401, 403, 404, and non-credential 400 codes', async () => {
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://new-5-signin-4xx.test';
    const sdkKey = 'sb-new-5-signin-4xx-auth-token';
    const storage = makeMemoryStorage();

    type ResponseSpec = { status: number; body: Record<string, unknown> };
    let nextResponse: ResponseSpec = {
      status: 401,
      body: { message: 'Invalid API key' },
    };

    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(nextResponse.body), {
          status: nextResponse.status,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      store.startAuth();

      nextResponse = { status: 401, body: { msg: 'Invalid API key' } };
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      nextResponse = { status: 403, body: { msg: 'Forbidden by WAF' } };
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      nextResponse = { status: 404, body: { msg: 'Not Found' } };
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      nextResponse = {
        status: 400,
        body: { error_code: 'unexpected_failure', msg: 'Unexpected failure' },
      };
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      nextResponse = {
        status: 400,
        body: { error_code: 'captcha_failed', msg: 'Captcha failed' },
      };
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      nextResponse = { status: 400, body: { msg: 'Bad request' } };
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      nextResponse = {
        status: 400,
        body: { msg: 'Invalid login credentials' },
      };
      expect(await store.signIn('owner@example.test', 'WrongPassword123')).toBe(
        'invalid',
      );

      nextResponse = {
        status: 400,
        body: {
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        },
      };
      expect(await store.signIn('owner@example.test', 'WrongPassword123')).toBe(
        'invalid',
      );
    } finally {
      await client.auth.stopAutoRefresh();
      store.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA3-P1-4: slow global /logout aborts at 10 s timeout via AbortSignal, surfaces revocation_failed, and retryLogoutRevocation coalesces with in-flight signOut', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta3-p1-4-abort-timeout.test';
    const sdkKey = 'sb-delta3-p1-4-abort-timeout-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let logoutCalls = 0;
    let capturedLogoutSignal: AbortSignal | undefined;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      if (href.includes('/auth/v1/logout')) {
        logoutCalls += 1;
        capturedLogoutSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      const signOutP = tab.signOut();
      await vi.waitFor(() => {
        expect(logoutCalls).toBe(1);
      });

      const coalescedRetry = tab.retryLogoutRevocation();
      expect(logoutCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(10_500);
      await signOutP;
      await coalescedRetry;

      expect(capturedLogoutSignal?.aborted).toBe(true);
      expect(logoutCalls).toBe(1);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: true,
      });

      expect(await tab.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA3-P3-2: signIn catch does not roll back when subscriber threw a different error than the error caught from signInWithPassword', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta3-p3-2-different-error.test';
    const sdkKey = 'sb-delta3-p3-2-different-error-auth-token';
    const values = new Map<string, string>();
    let throwQuota = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (throwQuota && k === sdkKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();

    let releaseSignIn: (() => void) | null = null;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return new Promise<Response>((resolve) => {
          releaseSignIn = () => resolve(server.handlePasswordSignIn());
        });
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      const signInPromise = tab.signIn(
        'owner@example.test',
        'ValidPassword123',
      );
      await vi.waitFor(() => {
        expect(releaseSignIn).not.toBeNull();
      });

      const sessionOther = server.issueSession();
      values.set(sdkKey, JSON.stringify(sessionOther));
      let throwOnce = true;
      const unsub = tab.subscribeAuth(() => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('unrelated-subscriber-error');
        }
      });
      const internals = client.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internals
        ._notifyAllSubscribers('SIGNED_IN', sessionOther, false)
        .catch(() => {});
      unsub();

      throwQuota = true;
      releaseSignIn!();
      expect(await signInPromise).toBe('failed');

      expect(
        (
          JSON.parse(values.get(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sessionOther.access_token);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA6-P1-2: signOut persists pending synchronously BEFORE removing sdkKey so reload never boots as owner (I1) or silent idle (I2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');

    const urlA = 'https://delta6-p1-2-normal.test';
    const sdkKeyA = 'sb-delta6-p1-2-normal-auth-token';
    const coordKeyA = getLogoutCoordStorageKey(urlA);
    const serverA = createStatefulAuthServer();
    const valuesA = new Map<string, string>([
      [sdkKeyA, JSON.stringify(serverA.issueSession())],
    ]);
    const opsA: string[] = [];
    const storageA: Storage = {
      get length() {
        return valuesA.size;
      },
      clear() {
        valuesA.clear();
      },
      getItem(k: string) {
        return valuesA.get(k) ?? null;
      },
      key(i: number) {
        return [...valuesA.keys()][i] ?? null;
      },
      removeItem(k: string) {
        opsA.push(`remove:${k}`);
        valuesA.delete(k);
      },
      setItem(k: string, v: string) {
        opsA.push(`set:${k}`);
        valuesA.set(k, String(v));
      },
    };
    const fetchA: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const clientA = createClient(urlA, TEST_ANON_KEY, {
      auth: {
        storage: storageA,
        storageKey: sdkKeyA,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchA },
    });
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => urlA,
      getStorage: () => storageA,
      syncGlobalStores: false,
    });

    const urlB = 'https://delta6-p1-2-remove-fail.test';
    const sdkKeyB = 'sb-delta6-p1-2-remove-fail-auth-token';
    const coordKeyB = getLogoutCoordStorageKey(urlB);
    const serverB = createStatefulAuthServer();
    const valuesB = new Map<string, string>([
      [sdkKeyB, JSON.stringify(serverB.issueSession())],
    ]);
    const storageB: Storage = {
      get length() {
        return valuesB.size;
      },
      clear() {
        valuesB.clear();
      },
      getItem(k: string) {
        return valuesB.get(k) ?? null;
      },
      key(i: number) {
        return [...valuesB.keys()][i] ?? null;
      },
      removeItem(k: string) {
        if (k === sdkKeyB) {
          throw new DOMException('InvalidStateError', 'InvalidStateError');
        }
        valuesB.delete(k);
      },
      setItem(k: string, v: string) {
        if (k === sdkKeyB) {
          throw new DOMException('InvalidStateError', 'InvalidStateError');
        }
        valuesB.set(k, String(v));
      },
    };
    const clientB = createClient(urlB, TEST_ANON_KEY, {
      auth: {
        storage: storageB,
        storageKey: sdkKeyB,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchA },
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => urlB,
      getStorage: () => storageB,
      syncGlobalStores: false,
    });

    let reloadedClientA: ReturnType<typeof createClient> | null = null;
    let reloadedTabA: ReturnType<typeof createAuthStore> | null = null;
    let reloadedClientB: ReturnType<typeof createClient> | null = null;
    let reloadedTabB: ReturnType<typeof createAuthStore> | null = null;

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      opsA.length = 0;
      void tabA.signOut();
      // Synchronously BEFORE any await: pending persisted BEFORE sdkKey removed!
      expect(opsA.indexOf(`set:${coordKeyA}`)).toBeGreaterThanOrEqual(0);
      expect(opsA.indexOf(`remove:${sdkKeyA}`)).toBeGreaterThan(
        opsA.indexOf(`set:${coordKeyA}`),
      );
      expect(valuesA.get(sdkKeyA)).toBeUndefined();
      expect(JSON.parse(valuesA.get(coordKeyA) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'pending',
      });

      // Reload immediately resolves pending + creds gone -> revocation_failed (I2).
      tabA.resetAuthStore({ clearStorage: false });
      reloadedClientA = createClient(urlA, TEST_ANON_KEY, {
        auth: {
          storage: storageA,
          storageKey: sdkKeyA,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchA },
      });
      reloadedTabA = createAuthStore({
        getClient: () => reloadedClientA,
        getProjectUrl: () => urlA,
        getStorage: () => storageA,
        syncGlobalStores: false,
      });
      reloadedTabA.startAuth();
      expect(reloadedTabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: false,
      });

      // Part B: removeItem + tombstone fail -> reload boots to local_failed, NEVER owner (I1).
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
      await tabB.signOut();
      expect(valuesB.get(sdkKeyB)).toBeDefined();
      expect(JSON.parse(valuesB.get(coordKeyB) ?? 'null')).toMatchObject({
        state: 'local_failed',
      });

      tabB.resetAuthStore({ clearStorage: false });
      reloadedClientB = createClient(urlB, TEST_ANON_KEY, {
        auth: {
          storage: storageB,
          storageKey: sdkKeyB,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchA },
      });
      reloadedTabB = createAuthStore({
        getClient: () => reloadedClientB,
        getProjectUrl: () => urlB,
        getStorage: () => storageB,
        syncGlobalStores: false,
      });
      reloadedTabB.startAuth();
      await vi.advanceTimersByTimeAsync(20);
      expect(reloadedTabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      await reloadedClientA?.auth.stopAutoRefresh();
      await reloadedClientB?.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      reloadedTabA?.resetAuthStore({ clearStorage: false });
      reloadedTabB?.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA6-P2-2: retryLogoutRevocation requires logoutPhase === revocation_failed and a retained token (no-op after reload)', async () => {
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta6-p2-2-retry-guard.test';
    const sdkKey = 'sb-delta6-p2-2-retry-guard-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();

    let logoutCalls = 0;
    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/auth/v1/logout')) {
        logoutCalls += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 3,
          state: 'revocation_failed',
          sessionKey: 'sid:sid-2',
        }),
      );
      tab.startAuth();
      expect(tab.getAuthSnapshot()).toMatchObject({
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: false,
      });
      await tab.retryLogoutRevocation();
      expect(logoutCalls).toBe(0);
      expect(tab.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA7-P2-2: late _callRefreshToken during signing_out is evicted from sdkKey and its fresh rotated tokens are retained so Retry succeeds after 503', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta7-p2-2-late-refresh-evict.test';
    const sdkKey = 'sb-delta7-p2-2-late-refresh-evict-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const session1 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(session1));

    let logoutCount = 0;
    let lastLogoutAuth: string | null = null;
    let releaseFirstLogout: ((resp: Response) => void) | null = null;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        logoutCount += 1;
        lastLogoutAuth = headers.get('authorization');
        if (logoutCount === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstLogout = resolve;
          });
        }
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const clientA = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(releaseFirstLogout).not.toBeNull();
      });
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('signing_out');
      expect(storage.getItem(sdkKey)).toBeNull();

      const refreshResp = server.handleRefresh(
        JSON.stringify({ refresh_token: session1.refresh_token }),
      );
      const rotatedSession = (await refreshResp.json()) as typeof session1;
      storage.setItem(sdkKey, JSON.stringify(rotatedSession));

      const internalsA = clientA.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsA._notifyAllSubscribers(
        'TOKEN_REFRESHED',
        rotatedSession,
        false,
      );

      expect(storage.getItem(sdkKey)).toBeNull();

      storage.setItem(sdkKey, JSON.stringify(rotatedSession));
      releaseFirstLogout!(
        new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await signOutA;

      expect(storage.getItem(sdkKey)).toBeNull();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: true,
      });

      await tabA.retryLogoutRevocation();
      expect(lastLogoutAuth).toBe(`Bearer ${rotatedSession.access_token}`);
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA8-P2-1: startAuth and signOut never block or revoke a newer persisted session when durable record holds local_failed for an older sessionKey', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta8-p2-1-session-guard.test';
    const sdkKey = 'sb-delta8-p2-1-session-guard-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();

    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const clientC = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    const clientD = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabD = createAuthStore({
      getClient: () => clientD as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      const sessionNewer = server.issueSession();
      storage.setItem(sdkKey, JSON.stringify(sessionNewer));
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 2,
          state: 'local_failed',
          sessionKey: 'sid:older-session',
        }),
      );
      tabC.startAuth();
      await vi.waitFor(() => {
        expect(tabC.getAuthSnapshot().status).toBe('owner');
      });
      expect(tabC.getAuthSnapshot().logoutFailed).toBe(false);

      const sessionOld = server.issueSession();
      storage.setItem(sdkKey, JSON.stringify(sessionOld));
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 3,
          state: 'local_failed',
          sessionKey: 'sid:sid-2',
        }),
      );
      tabD.startAuth();
      expect(tabD.getAuthSnapshot().logoutPhase).toBe('local_failed');

      storage.setItem(sdkKey, JSON.stringify(sessionNewer));
      const logoutsBeforeD = server.getConfirmedGlobalLogouts();
      await tabD.signOut();
      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sessionNewer.access_token);
      expect(server.getConfirmedGlobalLogouts()).toBe(logoutsBeforeD);
    } finally {
      await clientC.auth.stopAutoRefresh();
      await clientD.auth.stopAutoRefresh();
      tabC.resetAuthStore({ clearStorage: false });
      tabD.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA8-P3-1: retryLogoutRevocation evicts same-session sdkKey re-persisted by a late refresh and retries with rotated tokens (or downgrades to local_failed if removal throws)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta8-p3-1-retry-evict-sdk.test';
    const sdkKey = 'sb-delta8-p3-1-retry-evict-sdk-auth-token';
    const values = new Map<string, string>();
    let failRemoveSdk = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        if (failRemoveSdk && k === sdkKey) {
          throw new DOMException('InvalidStateError', 'InvalidStateError');
        }
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (failRemoveSdk && k === sdkKey) {
          throw new DOMException('InvalidStateError', 'InvalidStateError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();
    const session1 = server.issueSession();
    values.set(sdkKey, JSON.stringify(session1));

    let failLogout = true;
    let lastLogoutAuth: string | null = null;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        lastLogoutAuth = headers.get('authorization');
        if (failLogout) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const clientA = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      await tabA.signOut();
      expect(values.get(sdkKey)).toBeUndefined();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: true,
      });

      const refreshResp = server.handleRefresh(
        JSON.stringify({ refresh_token: session1.refresh_token }),
      );
      const rotatedSession = (await refreshResp.json()) as typeof session1;
      values.set(sdkKey, JSON.stringify(rotatedSession));

      failLogout = false;
      failRemoveSdk = true;
      await tabA.retryLogoutRevocation();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });

      failRemoveSdk = false;
      failLogout = true;
      await tabA.signOut();
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('revocation_failed');

      const refreshResp2 = server.handleRefresh(
        JSON.stringify({ refresh_token: rotatedSession.refresh_token }),
      );
      const rotatedSession2 = (await refreshResp2.json()) as typeof session1;
      values.set(sdkKey, JSON.stringify(rotatedSession2));

      failLogout = false;
      await tabA.retryLogoutRevocation();
      expect(values.get(sdkKey)).toBeUndefined();
      expect(lastLogoutAuth).toBe(`Bearer ${rotatedSession2.access_token}`);
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA9-P2-2: signOut unblocks a local_failed tab when storage holds a newer session without removing it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta9-p2-2-local-failed-newer-session.test';
    const sdkKey = 'sb-delta9-p2-2-local-failed-newer-session-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let zeroByteQuota = false;
    let failSdkRemoval = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        if (failSdkRemoval && k === sdkKey) {
          throw new DOMException('removeItem blocked', 'SecurityError');
        }
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (failSdkRemoval && k === sdkKey) {
          throw new DOMException('setItem blocked', 'SecurityError');
        }
        if (zeroByteQuota) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();
    const sid1 = server.issueSession();
    const sid2 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(sid1));

    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      zeroByteQuota = true;
      failSdkRemoval = true;
      await tab.signOut();
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });
      expect(storage.getItem(coordKey)).toBeNull();

      zeroByteQuota = false;
      failSdkRemoval = false;
      storage.setItem(sdkKey, JSON.stringify(sid2));

      await tab.signOut();
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
      });
      expect(tab.isAuthResolved()).toBe(true);
      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sid2.access_token);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA9-P3-3: blocked localStorage (getStorage returns null) does not falsely sign out an active in-memory session on TOKEN_REFRESHED', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta9-p3-3-blocked-storage.test';
    const server = createStatefulAuthServer();
    const initialSession = server.issueSession();

    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(
          new Response(JSON.stringify(initialSession), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
        return Promise.resolve(
          server.handleRefresh(
            typeof init?.body === 'string' ? init.body : null,
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => null,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('signed-out');
      });

      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      expect(tab.isAuthResolved()).toBe(true);
      const refreshed = await client.auth.refreshSession({
        refresh_token: initialSession.refresh_token,
      });
      expect(refreshed.error).toBeNull();
      await vi.advanceTimersByTimeAsync(20);
      expect(tab.getAuthSnapshot().status).toBe('owner');
      expect(tab.isAuthResolved()).toBe(true);
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA10-P2-3: preserving revokedSessionKey when no durable record exists under 0-byte quota blocks late TOKEN_REFRESHED from reopening owner access', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta10-p2-3-preserve-revoked-key.test';
    const sdkKey = 'sb-delta10-p2-3-preserve-revoked-key-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const initialSession = server.issueSession();
    const preRotatedResponse = server.handleRefresh(
      JSON.stringify({ refresh_token: initialSession.refresh_token }),
    );
    const preRotatedBody = await preRotatedResponse.text();
    const preRotatedParsed = JSON.parse(preRotatedBody) as {
      access_token: string;
      refresh_token: string;
    };
    storage.setItem(sdkKey, preRotatedBody);

    let resolveRefresh: ((res: Response) => void) | null = null;
    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      const refreshPromise = client.auth.refreshSession({
        refresh_token: preRotatedParsed.refresh_token,
      });
      await vi.waitFor(() => {
        expect(resolveRefresh).not.toBeNull();
      });

      storage.setZeroByteQuota(true);
      await tab.signOut();
      expect(storage.getItem(coordKey)).toBeNull();
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
      });

      storage.setZeroByteQuota(false);
      resolveRefresh!(
        new Response(preRotatedBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await refreshPromise;
      await vi.advanceTimersByTimeAsync(20);

      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
      });
      expect(storage.getItem(sdkKey)).toBeNull();
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA10-P3-4: signOut prefers freshly rotated same-session tokens in localStorage over stale in-memory machine.session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta10-p3-4-prefer-rotated-storage-token.test';
    const sdkKey = 'sb-delta10-p3-4-prefer-rotated-storage-token-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer({ initialExpiresInSec: 3600 });
    const initialSession = server.issueSession({ expiresInSec: 3600 });
    storage.setItem(sdkKey, JSON.stringify(initialSession));

    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
        return Promise.resolve(
          server.handleRefresh(
            typeof init?.body === 'string' ? init.body : null,
          ),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      await vi.advanceTimersByTimeAsync(3_590_000);

      const rotatedRes = server.handleRefresh(
        JSON.stringify({ refresh_token: initialSession.refresh_token }),
      );
      expect(rotatedRes.status).toBe(200);
      storage.setItem(sdkKey, await rotatedRes.text());

      await tab.signOut();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA11-P2-2: fresh signIn clears stale durable logout record from localStorage so reload never kicks out the new owner', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta11-p2-2-signin-cleanup.test';
    const sdkKey = 'sb-delta11-p2-2-signin-cleanup-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let blockCoordWrites = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (blockCoordWrites && k === coordKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();

    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          state: 'revocation_failed',
          sessionKey: 'sid:sid-old',
        }),
      );
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });

      blockCoordWrites = true;
      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      expect(storage.getItem(coordKey)).toBeNull();
      expect(tab.isAuthResolved()).toBe(true);
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'owner',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA12-P2-2: retryLogoutRevocation is a no-op while signIn is in flight so it cannot revoke the brand-new session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta12-p2-2-retry-during-signin.test';
    const sdkKey = 'sb-delta12-p2-2-retry-during-signin-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let logoutCalls = 0;
    let resolveSignIn: ((res: Response) => void) | null = null;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        logoutCalls += 1;
        if (logoutCalls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return new Promise<Response>((resolve) => {
          resolveSignIn = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      await tab.signOut();
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
      expect(logoutCalls).toBe(1);

      const signInPromise = tab.signIn('owner@test.local', 'ValidPassword123');
      await vi.waitFor(() => {
        expect(resolveSignIn).not.toBeNull();
      });

      await tab.retryLogoutRevocation();
      expect(logoutCalls).toBe(1);
      expect(tab.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'revocation_failed',
      });

      resolveSignIn!(server.handlePasswordSignIn());
      expect(await signInPromise).toBe('ok');
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });
      expect(tab.getAuthSnapshot().logoutPhase).toBe('idle');
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA13-FINAL6-P1-1: signIn under partial quota followed by signOut under partial quota lands in revocation_failed instead of deadlocking in signing_out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta13-final6-p1-1.test';
    const sdkKey = 'sb-delta13-final6-p1-1-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let blockCoordWrites = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (blockCoordWrites && k === coordKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();

    let failLogout = true;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      if (href.includes('/auth/v1/logout')) {
        if (failLogout) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          state: 'revocation_failed',
          sessionKey: 'sid:sid-old',
        }),
      );
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });

      blockCoordWrites = true;
      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      await tab.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutPending: false,
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
      expect(tab.isAuthResolved()).toBe(true);

      failLogout = false;
      await tab.retryLogoutRevocation();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA13-FINAL6-P1-2: late TOKEN_REFRESHED for a distinct newer sid does NOT evict the new session from localStorage after partial-quota signIn', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta13-final6-p1-2.test';
    const sdkKey = 'sb-delta13-final6-p1-2-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let blockCoordWrites = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (blockCoordWrites && k === coordKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      await tab.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();

      blockCoordWrites = true;
      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });
      const sid2 = JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
        access_token: string;
        refresh_token: string;
      };

      const internals = client.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internals._notifyAllSubscribers('TOKEN_REFRESHED', sid2, false);
      await vi.advanceTimersByTimeAsync(20);

      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sid2.access_token);
      expect(tab.getAuthSnapshot().status).toBe('owner');
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA13-TOMBSTONE: overwrites sdkKey with empty tombstone when removeItem throws so reload converges to signed-out idle, and enters local_failed only when both removeItem and setItem throw', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta13-tombstone.test';
    const sdkKey = 'sb-delta13-tombstone-auth-token';
    const values = new Map<string, string>();
    let failRemoveSdk = false;
    let failOverwriteSdk = false;

    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        if (failRemoveSdk && k === sdkKey) {
          throw new DOMException('removeItem blocked', 'InvalidStateError');
        }
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (failOverwriteSdk && k === sdkKey) {
          throw new DOMException('setItem blocked', 'InvalidStateError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const makeClient = () =>
      createClient(url, TEST_ANON_KEY, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });

    const clientA = makeClient();
    const clientReload = makeClient();
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });
    const tabReload = createAuthStore({
      getClient: () => clientReload as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // Part A: removeItem throws, tombstone setItem('') succeeds -> completes cleanly.
      failRemoveSdk = true;
      failOverwriteSdk = false;
      await tabA.signOut();

      expect(values.get(sdkKey)).toBe('');
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
      expect(tabA.isAuthResolved()).toBe(true);

      tabReload.startAuth();
      await vi.advanceTimersByTimeAsync(20);
      expect(tabReload.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
      });
      expect(tabReload.isAuthResolved()).toBe(true);

      // Part B: Sign in again; now BOTH removeItem and setItem throw -> local_failed (I1).
      failRemoveSdk = false;
      expect(await tabA.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      failRemoveSdk = true;
      failOverwriteSdk = true;
      await tabA.signOut();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
        logoutPending: false,
      });
      expect(tabA.isAuthResolved()).toBe(false);
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientReload.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabReload.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA13-QUOTA-IN-MEMORY-REVOCATION: under 0-byte quota, revocation failure stays visible with Retry in the running tab while reload converges to signed-out idle', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta13-quota-in-memory.test';
    const sdkKey = 'sb-delta13-quota-in-memory-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let failLogout = true;
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        if (failLogout) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const makeClient = () =>
      createClient(url, TEST_ANON_KEY, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });

    const clientA = makeClient();
    const clientC = makeClient();
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      storage.setZeroByteQuota(true);
      await tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(storage.getItem(coordKey)).toBeNull();

      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
      expect(tabA.isAuthResolved()).toBe(true);

      // Reloaded tab boots cleanly to signed-out idle (I2 full-storage rule).
      tabC.startAuth();
      await vi.advanceTimersByTimeAsync(20);
      expect(tabC.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
        logoutFailed: false,
      });
      expect(tabC.isAuthResolved()).toBe(true);

      // Retry in running tab succeeds even while still under 0-byte quota.
      failLogout = false;
      await tabA.retryLogoutRevocation();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
        canRetryLogoutRevocation: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA15-P2-1: onAuthStateChange quota fallback that removes sdkKey without global revocation moves to revocation_failed with Retry instead of silently flipping to idle (I2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta15-p2-1-refocus-fallback-revocation.test';
    const sdkKey = 'sb-delta15-p2-1-refocus-fallback-revocation-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let zeroByteQuota = false;
    let failSdkRemove = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        if (failSdkRemove && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (failSdkRemove && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        if (zeroByteQuota) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();
    const sid1 = server.issueSession();
    values.set(sdkKey, JSON.stringify(sid1));

    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      zeroByteQuota = true;
      failSdkRemove = true;
      await tab.signOut();
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
      expect(values.get(sdkKey)).toBeDefined();
      expect(values.get(coordKey)).toBeUndefined();
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });

      failSdkRemove = false;
      const internals = client.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internals._notifyAllSubscribers('SIGNED_IN', sid1, false);

      expect(values.get(sdkKey)).toBeUndefined();
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutFailed: false,
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });

      expect(tab.isAuthResolved()).toBe(true);
      await tab.retryLogoutRevocation();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA15-P2-2: production supabase.ts binds window.localStorage explicitly under boot-time quota and signOut never early-returns while an active session is unrevoked (I2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const valuesProd = new Map<string, string>();
    let fullAtBoot = true;
    const bootQuotaStorage: Storage = {
      get length() {
        return valuesProd.size;
      },
      clear() {
        valuesProd.clear();
      },
      getItem(k: string) {
        return valuesProd.get(k) ?? null;
      },
      key(i: number) {
        return [...valuesProd.keys()][i] ?? null;
      },
      removeItem(k: string) {
        valuesProd.delete(k);
      },
      setItem(k: string, v: string) {
        if (fullAtBoot) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        valuesProd.set(k, String(v));
      },
    };
    const origFetch = globalThis.fetch;
    const serverProd = createStatefulAuthServer();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://delta15-p2-2-prod.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', TEST_ANON_KEY);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: bootQuotaStorage,
    });
    globalThis.fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(serverProd.handlePasswordSignIn());
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    try {
      vi.resetModules();
      const supabaseMod = await import('@/lib/supabase');
      expect(supabaseMod.supabase).not.toBeNull();
      // Even if createClient runs while localStorage throws QuotaExceededError,
      // explicit storage binding prevents silent fallback to memoryStorage.
      supabaseMod.activateSupabaseClient();
      fullAtBoot = false;
      const signInRes = await supabaseMod.supabase!.auth.signInWithPassword({
        email: 'owner@test.local',
        password: 'ValidPassword123',
      });
      expect(signInRes.error).toBeNull();
      expect(valuesProd.get('sb-delta15-p2-2-prod-auth-token')).toBeDefined();
      supabaseMod.deactivateSupabaseClient();
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
      if (origLocalStorageDesc) {
        Object.defineProperty(window, 'localStorage', origLocalStorageDesc);
      }
      vi.resetModules();
    }

    // Part B: Active in-memory session with missing sdkKey still sends global /logout.
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta15-p2-2-signout-guard.test';
    const sdkKey = 'sb-delta15-p2-2-signout-guard-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      storage.removeItem(sdkKey);
      await tab.signOut();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA18-P1-2: retryLogoutRevocation evicts re-persisted revoked session and retries global revocation even when legacy signed_in record sits in storage under quota (I1, I2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta18-p1-2-retry-signed-in-coord.test';
    const sdkKey = 'sb-delta18-p1-2-retry-signed-in-coord-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let blockCoordWrites = false;
    let logoutFails = false;
    let lastLogoutAuth: string | null = null;

    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (blockCoordWrites && k === coordKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };

    const server = createStatefulAuthServer();
    const fetchFn: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      if (href.includes('/auth/v1/logout')) {
        lastLogoutAuth = headers.get('authorization');
        if (logoutFails) {
          return Promise.resolve(new Response('unavailable', { status: 503 }));
        }
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });
      const initialSession = JSON.parse(values.get(sdkKey) ?? 'null') as {
        refresh_token: string;
      };

      // Seed a legacy signed_in record and block coord writes while /logout fails 503.
      values.set(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          ownerTabId: 'legacy',
          state: 'signed_in',
          sessionKey: 'sid:sid-1',
        }),
      );
      blockCoordWrites = true;
      logoutFails = true;
      await tab.signOut();
      expect(values.get(sdkKey)).toBeUndefined();
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });

      const rotatedRes = server.handleRefresh(
        JSON.stringify({ refresh_token: initialSession.refresh_token }),
      );
      const rotated = (await rotatedRes.json()) as { access_token: string };
      values.set(sdkKey, JSON.stringify(rotated));

      logoutFails = false;
      blockCoordWrites = false;
      await tab.retryLogoutRevocation();

      expect(values.get(sdkKey)).toBeUndefined();
      expect(lastLogoutAuth).toBe(`Bearer ${rotated.access_token}`);
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(values.get(coordKey)).toBeUndefined();
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA19-P2-1: empty-storage signOut or legacy completed(sessionKey: null) never evicts a later concrete sid: session on TOKEN_REFRESHED under coord_blocked quota (I3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta19-p2-1-null-completed-wildcard.test';
    const sdkKey = 'sb-delta19-p2-1-null-completed-wildcard-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let blockCoordWrites = false;

    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (blockCoordWrites && k === coordKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };

    const server = createStatefulAuthServer();
    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      values.set(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          ownerTabId: 'legacy',
          state: 'completed',
          sessionKey: null,
        }),
      );
      blockCoordWrites = true;
      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('signed-out');
      });

      const sid1 = server.issueSession();
      values.set(sdkKey, JSON.stringify(sid1));

      const internals = client.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internals._notifyAllSubscribers('TOKEN_REFRESHED', sid1, false);
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });
      expect(values.get(sdkKey)).toBeDefined();
    } finally {
      blockCoordWrites = false;
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA20-P1: late in-flight TOKEN_REFRESHED for a revoked session after a newer sign-in never reopens revoked user, evicts revoked session if re-persisted, and preserves held-writes isolation (I1, I3, I5)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const {
      resetHeldWritesStore,
      setHeldWriteUser,
      beginHeldWrite,
      getHeldWrite,
      clearHeldWrite,
    } = await import('@/lib/held-writes');
    const url = 'https://delta20-p1-late-refresh-after-signin.test';
    const sdkKey = 'sb-delta20-p1-late-refresh-after-signin-auth-token';
    const storage = makeMemoryStorage();

    const nowSec = Math.floor(Date.now() / 1000);
    const makeUserSession = (
      userId: string,
      email: string,
      sid: string,
      refreshToken: string,
    ) => ({
      access_token: makeJwt({
        sub: userId,
        email,
        session_id: sid,
        exp: nowSec + 3600,
      }),
      refresh_token: refreshToken,
      token_type: 'bearer' as const,
      expires_in: 3600,
      expires_at: nowSec + 3600,
      user: {
        id: userId,
        email,
        aud: 'authenticated',
        role: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      },
    });

    const sid1Initial = makeUserSession(
      'user-a',
      'a@test.local',
      'sid-1',
      'rt-1',
    );
    const sid1Rotated = makeUserSession(
      'user-a',
      'a@test.local',
      'sid-1',
      'rt-1-rotated',
    );
    const sid2UserB = makeUserSession(
      'user-b',
      'b@test.local',
      'sid-2',
      'rt-2',
    );
    storage.setItem(sdkKey, JSON.stringify(sid1Initial));

    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(
          new Response(JSON.stringify(sid2UserB), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: true,
    });

    try {
      resetHeldWritesStore({ clearStorage: true, resetUser: true });
      setHeldWriteUser('user-a');
      beginHeldWrite('op-a', () => ({ qty: 1 }), { requestId: 'req-a' });
      setHeldWriteUser('user-b');
      beginHeldWrite('op-b', () => ({ qty: 2 }), { requestId: 'req-b' });
      setHeldWriteUser(null);

      tab.startAuth();
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
        expect(tab.getAuthSnapshot().email).toBe('a@test.local');
      });

      // Sign out user-a (sid-1), then sign in as user-b (sid-2).
      await tab.signOut();
      expect(await tab.signIn('b@test.local', 'ValidPassword123')).toBe('ok');
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
        expect(tab.getAuthSnapshot().email).toBe('b@test.local');
      });

      // Late TOKEN_REFRESHED for revoked sid-1 arrives without overwriting sdkKey:
      // user-b stays owner and user-a's held write never leaks!
      const internals = client.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internals._notifyAllSubscribers(
        'TOKEN_REFRESHED',
        sid1Rotated,
        false,
      );
      await vi.advanceTimersByTimeAsync(20);

      expect(tab.getAuthSnapshot().status).toBe('owner');
      expect(tab.getAuthSnapshot().email).toBe('b@test.local');
      expect(getHeldWrite('op-a')).toBeNull();
      expect(getHeldWrite('op-b')?.requestId).toBe('req-b');
      expect(storage.getItem(sdkKey)).toContain('rt-2');
    } finally {
      clearHeldWrite('op-a');
      clearHeldWrite('op-b');
      resetHeldWritesStore({ clearStorage: true, resetUser: true });
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA20-P2-1: signOut() on a signed-in tab never early-returns clean idle when legacy completed(null) exists and sdkKey was removed without global revocation (I2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta20-p2-1-null-completed-signout.test';
    const sdkKey = 'sb-delta20-p2-1-null-completed-signout-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();

    let logoutCalls = 0;
    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      if (href.includes('/auth/v1/logout')) {
        logoutCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'offline' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          ownerTabId: 'legacy',
          state: 'completed',
          sessionKey: null,
        }),
      );
      tab.startAuth();
      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });

      // Even if sdkKey was removed externally without global revocation, signOut()
      // must still dispatch global /logout and surface revocation_failed on 503!
      storage.removeItem(sdkKey);
      await tab.signOut();
      expect(logoutCalls).toBe(1);
      expect(tab.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA-OT1 P3-1: isOwnFreshSignIn rejects an older revoked session in revokedSessionKeys during a later in-flight signIn', async () => {
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta-ot1-p3-1.test';
    const sdkKey = 'sb-delta-ot1-p3-1-auth-token';
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (k) => values.get(k) ?? null,
      key: (i) => [...values.keys()][i] ?? null,
      removeItem: (k) => {
        values.delete(k);
      },
      setItem: (k, v) => {
        values.set(k, String(v));
      },
    };

    let signInStep = 0;
    let resolveThirdSignIn!: (res: Response) => void;
    const makeSidSession = (sid: string) => ({
      access_token: makeJwt({
        sub: 'owner-1',
        email: 'owner@test.local',
        session_id: sid,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      refresh_token: `rt-${sid}`,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id: 'owner-1',
        email: 'owner@test.local',
        aud: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      },
    });
    const session1 = makeSidSession('p31-sid-1');
    const session2 = makeSidSession('p31-sid-2');
    const session3 = makeSidSession('p31-sid-3');

    const fetchFn: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/auth/v1/token?grant_type=password')) {
        signInStep += 1;
        if (signInStep === 1) {
          return Promise.resolve(
            new Response(JSON.stringify(session1), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (signInStep === 2) {
          return Promise.resolve(
            new Response(JSON.stringify(session2), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return new Promise<Response>((resolve) => {
          resolveThirdSignIn = resolve;
        });
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tab = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      syncGlobalStores: false,
    });

    try {
      tab.startAuth();
      // 1. Sign in as sid-1 and revoke sid-1 (sid-1 recorded in revokedSessionKeys).
      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });
      await tab.signOut();
      expect(tab.getAuthSnapshot().status).toBe('signed-out');

      // 2. Sign in as sid-2 and revoke sid-2 (machine.revokedSessionKey is now sid-2,
      //    while sid-1 lives only in revokedSessionKeys).
      expect(await tab.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });
      await tab.signOut();
      expect(tab.getAuthSnapshot().status).toBe('signed-out');

      // 3. Start a third signIn (signInInProgressCount === 1). While in flight,
      //    deliver a stale SIGNED_IN callback for sid-1 -> MUST be rejected!
      const thirdSignInP = tab.signIn('owner@test.local', 'ValidPassword123');
      await vi.waitFor(() => {
        expect(resolveThirdSignIn).toBeDefined();
      });

      const clientAuth = client.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
        ) => Promise<void>;
      };
      await clientAuth._notifyAllSubscribers('SIGNED_IN', session1);
      await new Promise((r) => setTimeout(r, 20));
      // Stale revoked sid-1 must NEVER be accepted as owner!
      expect(tab.getAuthSnapshot().status).toBe('signed-out');

      // Complete the genuine third sign-in as sid-3 -> accepted cleanly!
      resolveThirdSignIn(
        new Response(JSON.stringify(session3), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      expect(await thirdSignInP).toBe('ok');
      await vi.waitFor(() => {
        expect(tab.getAuthSnapshot().status).toBe('owner');
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tab.resetAuthStore({ clearStorage: false });
    }
  });
});
