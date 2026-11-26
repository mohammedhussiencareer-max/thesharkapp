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

function makeMemoryStorage(options?: {
  onMutation?: (
    key: string,
    oldValue: string | null,
    newValue: string | null,
  ) => void;
}) {
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
      const oldValue = values.get(key) ?? null;
      if (!values.delete(key)) return;
      options?.onMutation?.(key, oldValue, null);
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
      options?.onMutation?.(key, oldValue, String(value));
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

describe('auth-store real SDK logout and cross-tab coordination', () => {
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

      // Local credentials are gone so reload cannot restore owner access.
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(storage.getItem(markerKey)).toBeNull();
      expect(
        calls.filter(
          (call) =>
            call.url.includes('/auth/v1/logout') &&
            call.url.includes('scope=global'),
        ),
      ).toHaveLength(1);
      // Revocation failure is surfaced separately from local logout failure.
      expect(authStore.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        email: null,
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: true,
      });

      // Retrying global revocation uses the in-memory retained session.
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

  it('P3: older failed logout in tab A does not rewrite shared marker or re-disable login in tab B after tab B completes logout', async () => {
    const markerWrites: string[] = [];
    const storage = makeMemoryStorage({
      onMutation(key, oldValue, newValue) {
        if (key === MARKER_KEY && newValue !== null) {
          markerWrites.push(newValue);
        }
        window.dispatchEvent(
          new StorageEvent('storage', {
            key,
            oldValue,
            newValue,
          }),
        );
      },
    });
    installLocalStorage(storage);

    const session = makeSession();
    storage.setItem(SDK_STORAGE_KEY, JSON.stringify(session));

    const sdkSubscribers = new Set<
      (
        event: string,
        nextSession: ReturnType<typeof makeSession> | null,
      ) => void
    >();
    let resolveTabASignOut: (value: { error: Error | null }) => void = () => {};

    const makeMockClient = (
      signOutImpl: () => Promise<{ error: Error | null }>,
    ) => ({
      auth: {
        storageKey: SDK_STORAGE_KEY,
        onAuthStateChange(
          callback: (
            event: string,
            nextSession: ReturnType<typeof makeSession> | null,
          ) => void,
        ) {
          sdkSubscribers.add(callback);
          const stored = storage.getItem(SDK_STORAGE_KEY);
          callback(
            'INITIAL_SESSION',
            stored
              ? (JSON.parse(stored) as ReturnType<typeof makeSession>)
              : null,
          );
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
          Promise.resolve({ data: { user: null, session: null }, error: null }),
        signOut: signOutImpl,
      },
      schema: () => ({
        rpc: () => Promise.resolve({ data: true, error: null }),
      }),
    });

    vi.doMock('@/lib/supabase', () => ({
      supabase: makeMockClient(
        () =>
          new Promise<{ error: Error | null }>((resolve) => {
            resolveTabASignOut = resolve;
          }),
      ),
      readSupabaseEnv: () => ({ url: TEST_URL, anonKey: TEST_ANON_KEY }),
    }));
    const tabA = await import('@/lib/auth-store');

    vi.resetModules();
    vi.doMock('@/lib/supabase', () => ({
      supabase: makeMockClient(() => {
        storage.removeItem(SDK_STORAGE_KEY);
        for (const listener of [...sdkSubscribers]) {
          listener('SIGNED_OUT', null);
        }
        return Promise.resolve({ error: null });
      }),
      readSupabaseEnv: () => ({ url: TEST_URL, anonKey: TEST_ANON_KEY }),
    }));
    const tabB = await import('@/lib/auth-store');

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      const tabAPending = tabA.signOut();
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPending).toBe(true);
        expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');
      });

      await tabB.signOut();
      expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
      expect(tabB.isAuthResolved()).toBe(true);
      const completedCoord = JSON.parse(
        storage.getItem(MARKER_KEY) ?? 'null',
      ) as { attemptId?: number; state?: string } | null;
      expect(completedCoord).toMatchObject({
        attemptId: 2,
        state: 'completed',
      });
      const attemptIds = markerWrites.map(
        (raw) => (JSON.parse(raw) as { attemptId: number }).attemptId,
      );
      expect(attemptIds[0]).toBe(1);
      expect(attemptIds[attemptIds.length - 1]).toBe(2);

      // Tab A's earlier call now fails after Tab B already completed logout.
      resolveTabASignOut({ error: new Error('older call failed') });
      await tabAPending;

      expect(storage.getItem(SDK_STORAGE_KEY)).toBeNull();
      expect(JSON.parse(storage.getItem(MARKER_KEY) ?? 'null')).toMatchObject({
        attemptId: 2,
        state: 'completed',
      });
      expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
      expect(tabB.isAuthResolved()).toBe(true);
      expect(await tabB.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      expect(tabA.getAuthSnapshot().logoutFailed).toBe(false);
      expect(tabA.isAuthResolved()).toBe(true);
    } finally {
      tabA.resetAuthStore();
      tabB.resetAuthStore();
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
      expect(JSON.parse(storage.getItem(MARKER_KEY) ?? 'null')).toMatchObject({
        attemptId: 2,
        state: 'completed',
      });
      expect(authStore.getAuthSnapshot().logoutFailed).toBe(false);

      resolveFirst({ error: new Error('older in-tab call failed') });
      await firstPending;

      expect(JSON.parse(storage.getItem(MARKER_KEY) ?? 'null')).toMatchObject({
        attemptId: 2,
        state: 'completed',
      });
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
      // Seed the expired session directly before logout (simulating a previously
      // active session whose access token has now expired when the user signs out).
      storage.setItem(sdkKey, JSON.stringify(expiredSession));
      storage.setFull(true);
      await authStore.signOut();

      // I1: local credentials removed so reload cannot restore owner
      expect(storage.getItem(sdkKey)).toBeNull();
      // I2: refresh was attempted and failed with 400; /logout was never confirmed,
      // so remote revocation MUST be surfaced as unconfirmed.
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

  it('pr65-final6 #2 (I3): older tab A logout returning 503 after tab B completed logout and signed back in must NOT erase tab B session', async () => {
    const testUrl = 'https://example-final6-503race.test';
    const sdkKey = 'sb-example-final6-503race-auth-token';
    const storage = makeMemoryStorage({
      onMutation(key, oldValue, newValue) {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key,
            oldValue,
            newValue,
          }),
        );
      },
    });
    installLocalStorage(storage);

    const oldSession = makeSession({
      access_token: 'access-old',
      refresh_token: 'refresh-old',
    });
    const newSession = makeSession({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
    });
    storage.setItem(sdkKey, JSON.stringify(oldSession));

    let resolveTabALogout: ((res: Response) => void) | null = null;
    const fetchTabA: typeof fetch = (input) => {
      const url = requestUrlOf(input);
      if (url.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('/auth/v1/logout')) {
        return new Promise<Response>((resolve) => {
          resolveTabALogout = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const fetchTabB: typeof fetch = (input) => {
      const url = requestUrlOf(input);
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
      if (url.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(
          new Response(JSON.stringify(newSession), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const clientA = createClient(testUrl, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchTabA },
    });
    vi.doMock('@/lib/supabase', () => ({
      supabase: clientA,
      readSupabaseEnv: () => ({ url: testUrl, anonKey: TEST_ANON_KEY }),
    }));
    const tabA = await import('@/lib/auth-store');

    vi.resetModules();
    const clientB = createClient(testUrl, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchTabB },
    });
    vi.doMock('@/lib/supabase', () => ({
      supabase: clientB,
      readSupabaseEnv: () => ({ url: testUrl, anonKey: TEST_ANON_KEY }),
    }));
    const tabB = await import('@/lib/auth-store');

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      const aPending = tabA.signOut();
      await vi.waitFor(() => {
        expect(resolveTabALogout).not.toBeNull();
      });

      await tabB.signOut();
      expect(await tabB.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe('access-new');

      // Tab A's older logout now returns 503.
      resolveTabALogout!(
        new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await aPending;

      // I3: Tab B's newer session MUST survive in storage and Tab B MUST stay owner.
      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe('access-new');
      expect(tabB.getAuthSnapshot().status).toBe('owner');
      expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
    } finally {
      tabA.resetAuthStore();
      tabB.resetAuthStore();
    }
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.synthetic-sig`;
}

function createBroadcastHub() {
  const channels = new Map<string, Set<FakeBroadcastChannel>>();

  class FakeBroadcastChannel {
    readonly name: string;
    onmessage: ((event: MessageEvent) => void) | null = null;
    private listeners = new Set<(event: MessageEvent) => void>();
    private closed = false;

    constructor(name: string) {
      this.name = name;
      const set = channels.get(name) ?? new Set();
      set.add(this);
      channels.set(name, set);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === 'message') this.listeners.add(listener);
    }

    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === 'message') this.listeners.delete(listener);
    }

    postMessage(data: unknown) {
      if (this.closed) return;
      const peers = channels.get(this.name);
      if (!peers) return;
      const cloned = structuredClone(data);
      for (const peer of [...peers]) {
        if (peer === this || peer.closed) continue;
        queueMicrotask(() => {
          if (peer.closed) return;
          const event = new MessageEvent('message', { data: cloned });
          peer.onmessage?.(event);
          for (const listener of [...peer.listeners]) {
            listener(event);
          }
        });
      }
    }

    close() {
      this.closed = true;
      channels.get(this.name)?.delete(this);
    }
  }

  return {
    BroadcastChannel: FakeBroadcastChannel,
    closeAll() {
      for (const set of channels.values()) {
        for (const ch of [...set]) ch.close();
      }
      channels.clear();
    },
  };
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

type MatrixOutcome =
  | 'success'
  | 'revocation_503'
  | 'revocation_400_refresh'
  | 'revocation_401'
  | 'quota_full_success'
  | 'quota_full_503'
  | 'quota_full_400_refresh'
  | 'local_remove_failure';

type MatrixInterleaving =
  'observe_only' | 'tabB_supersedes_logout' | 'tabB_logout_then_signin';

type MatrixStorageOrder = 'immediate' | 'delayed_reversed' | 'dropped';
type MatrixPostCheck = 'reload' | 'refocus';

type MatrixRow = {
  outcome: MatrixOutcome;
  interleaving: MatrixInterleaving;
  storageOrder: MatrixStorageOrder;
  postCheck: MatrixPostCheck;
};

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
const MATRIX_INTERLEAVINGS: readonly MatrixInterleaving[] = [
  'observe_only',
  'tabB_supersedes_logout',
  'tabB_logout_then_signin',
];
const MATRIX_STORAGE_ORDERS: readonly MatrixStorageOrder[] = [
  'immediate',
  'delayed_reversed',
  'dropped',
];
const MATRIX_POST_CHECKS: readonly MatrixPostCheck[] = ['reload', 'refocus'];

const LOGOUT_STATE_MACHINE_MATRIX: MatrixRow[] = MATRIX_OUTCOMES.flatMap(
  (outcome) =>
    MATRIX_INTERLEAVINGS.flatMap((interleaving) =>
      MATRIX_STORAGE_ORDERS.flatMap((storageOrder) =>
        MATRIX_POST_CHECKS.map((postCheck) => ({
          outcome,
          interleaving,
          storageOrder,
          postCheck,
        })),
      ),
    ),
);

describe('auth-store state machine invariant matrix (I1-I5, unconditional)', () => {
  const origLocalStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'localStorage',
  );
  const origSessionStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'sessionStorage',
  );
  const origBroadcastChannelDesc = Object.getOwnPropertyDescriptor(
    globalThis,
    'BroadcastChannel',
  );

  function restoreGlobals() {
    if (origLocalStorageDesc) {
      Object.defineProperty(window, 'localStorage', origLocalStorageDesc);
      Object.defineProperty(globalThis, 'localStorage', origLocalStorageDesc);
    }
    if (origSessionStorageDesc) {
      Object.defineProperty(window, 'sessionStorage', origSessionStorageDesc);
      Object.defineProperty(
        globalThis,
        'sessionStorage',
        origSessionStorageDesc,
      );
    }
    if (origBroadcastChannelDesc) {
      Object.defineProperty(
        globalThis,
        'BroadcastChannel',
        origBroadcastChannelDesc,
      );
    } else {
      delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    restoreGlobals();
  });

  it.each(LOGOUT_STATE_MACHINE_MATRIX)(
    'outcome=$outcome | interleaving=$interleaving | storage=$storageOrder | post=$postCheck',
    async ({ outcome, interleaving, storageOrder, postCheck }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hub = createBroadcastHub();
      Object.defineProperty(globalThis, 'BroadcastChannel', {
        configurable: true,
        writable: true,
        value: hub.BroadcastChannel,
      });

      const [{ createAuthStore, getLogoutCoordStorageKey }, heldWrites] =
        await Promise.all([
          import('@/lib/auth-store'),
          import('@/lib/held-writes'),
        ]);

      const url = `https://matrix-${outcome}-${interleaving}-${storageOrder}-${postCheck}.test`;
      const sdkKey = `sb-matrix-${outcome}-${interleaving}-${storageOrder}-${postCheck}-auth-token`;
      const coordKey = getLogoutCoordStorageKey(url);

      const values = new Map<string, string>();
      const sessionStorageA = makeMemoryStorage();
      const sessionStorageB = makeMemoryStorage();
      const listeners = new Map<string, Set<(event: StorageEvent) => void>>();
      const bufferedEvents: Array<{
        sourceTab: string;
        key: string;
        oldValue: string | null;
        newValue: string | null;
      }> = [];
      let full = false;
      let failRemoveForTab: string | null = null;

      function emitStorage(
        sourceTab: string,
        key: string,
        oldValue: string | null,
        newValue: string | null,
      ) {
        if (storageOrder === 'dropped') return;
        if (storageOrder === 'delayed_reversed') {
          bufferedEvents.push({ sourceTab, key, oldValue, newValue });
          return;
        }
        for (const [tabName, fns] of listeners) {
          if (tabName === sourceTab) continue;
          const event = new StorageEvent('storage', {
            key,
            oldValue,
            newValue,
          });
          for (const fn of [...fns]) fn(event);
        }
      }

      function flushDelayedReversed() {
        if (storageOrder !== 'delayed_reversed') return;
        const batch = bufferedEvents.splice(0, bufferedEvents.length).reverse();
        for (const item of batch) {
          for (const [tabName, fns] of listeners) {
            if (tabName === item.sourceTab) continue;
            const event = new StorageEvent('storage', {
              key: item.key,
              oldValue: item.oldValue,
              newValue: item.newValue,
            });
            for (const fn of [...fns]) fn(event);
          }
        }
      }

      function makeTabStorage(tabName: string): Storage {
        return {
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
            if (failRemoveForTab === tabName && key === sdkKey) {
              throw new DOMException('StorageLocked', 'InvalidStateError');
            }
            const oldValue = values.get(key) ?? null;
            if (!values.delete(key)) return;
            emitStorage(tabName, key, oldValue, null);
          },
          setItem(key: string, value: string) {
            if (failRemoveForTab === tabName && key === sdkKey) {
              throw new DOMException('StorageLocked', 'InvalidStateError');
            }
            const oldValue = values.get(key) ?? null;
            if (full && oldValue === null) {
              throw new DOMException(
                'QuotaExceededError',
                'QuotaExceededError',
              );
            }
            values.set(key, String(value));
            emitStorage(tabName, key, oldValue, String(value));
          },
        };
      }

      function addTabStorageListener(
        tabName: string,
        listener: (event: StorageEvent) => void,
      ) {
        const set = listeners.get(tabName) ?? new Set();
        set.add(listener);
        listeners.set(tabName, set);
        return () => {
          set.delete(listener);
        };
      }

      const storageA = makeTabStorage('tabA');
      const storageB = makeTabStorage('tabB');

      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: storageA,
      });
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storageA,
      });
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: sessionStorageA,
      });
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: sessionStorageA,
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

      // Seed I5 held-write records for owner-real-sdk (one unresolved, one resolved)
      // and for a second user (other-user) to verify strict per-user isolation on EVERY row.
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

      let releaseTabARequest: (() => void) | null = null;
      let deferredTabAOnce = false;
      const shouldDeferTabA =
        interleaving !== 'observe_only' && outcome !== 'local_remove_failure';

      function respondForTabA(
        href: string,
        authorization: string | null,
        body: string | null,
      ): Response {
        switch (outcome) {
          case 'success':
          case 'quota_full_success':
            if (href.includes('/auth/v1/logout')) {
              return server.handleLogout(authorization);
            }
            return server.handleRefresh(body);
          case 'revocation_503':
          case 'quota_full_503':
            return new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
          case 'revocation_401':
            return new Response(JSON.stringify({ message: 'invalid jwt' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          case 'revocation_400_refresh':
          case 'quota_full_400_refresh':
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
          case 'local_remove_failure':
            return new Response(null, { status: 503 });
        }
      }

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
          if (shouldDeferTabA && !deferredTabAOnce) {
            deferredTabAOnce = true;
            return new Promise<Response>((resolve) => {
              releaseTabARequest = () => {
                resolve(respondForTabA(href, authorization, body));
              };
            });
          }
          return Promise.resolve(respondForTabA(href, authorization, body));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const fetchB: typeof fetch = (input, init) => {
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
        if (href.includes('/auth/v1/logout')) {
          return Promise.resolve(server.handleLogout(authorization));
        }
        if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
          return Promise.resolve(server.handleRefresh(body));
        }
        if (href.includes('/auth/v1/token?grant_type=password')) {
          return Promise.resolve(server.handlePasswordSignIn());
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const clientA = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage: storageA,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchA },
      });
      const clientB = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage: storageB,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchB },
      });

      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storageA,
        getSessionStorage: () => sessionStorageA,
        addStorageListener: (fn) => addTabStorageListener('tabA', fn),
        tabId: 'tabA',
        syncGlobalStores: true,
      });
      const tabB = createAuthStore({
        getClient: () => clientB as never,
        getProjectUrl: () => url,
        getStorage: () => storageB,
        getSessionStorage: () => sessionStorageB,
        addStorageListener: (fn) => addTabStorageListener('tabB', fn),
        tabId: 'tabB',
        syncGlobalStores: false,
      });

      let reloadedTab: ReturnType<typeof createAuthStore> | null = null;
      let clientC: ReturnType<typeof createClient> | null = null;

      try {
        tabA.startAuth();
        tabB.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('owner');
          expect(tabB.getAuthSnapshot().status).toBe('owner');
        });

        // Pre-signout I5 check: owner's held writes active, other-user isolated.
        expect(heldWrites.isWritesLocked()).toBe(false);
        expect(heldWrites.getHeldWrite('count:daily')?.requestId).toBe(
          'req-unresolved-1',
        );
        expect(heldWrites.hasPostedReload('items:reload')).toBe(true);

        // Apply outcome preconditions right before Tab A initiates sign-out.
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
        if (isQuotaOutcome) {
          full = true;
        }
        if (outcome === 'local_remove_failure') {
          failRemoveForTab = 'tabA';
        }

        const tabAPending = tabA.signOut();

        if (interleaving === 'observe_only') {
          await tabAPending;
          flushDelayedReversed();
          await Promise.resolve();
          await Promise.resolve();
        } else {
          if (shouldDeferTabA) {
            await vi.waitFor(() => {
              expect(releaseTabARequest).not.toBeNull();
            });
          } else {
            await tabAPending;
          }

          full = false;
          failRemoveForTab = null;

          // Tab B completes logout with 204 against the stateful server.
          await tabB.signOut();

          // I5 check while signed out (before any re-sign-in): writes locked,
          // resolved posted_reload cleared, unresolved pin preserved, other user isolated.
          expect(heldWrites.isWritesLocked()).toBe(true);
          expect(values.get(postedOwnerKey)).toBeUndefined();
          expect(values.get(unresolvedOwnerKey)).toBeDefined();
          expect(values.get(otherUserKey)).toBeDefined();
          expect(heldWrites.getHeldWrite('count:daily')).toBeNull();

          // I4 before sign-in: Tab B must be cleanly signed out with login enabled.
          expect(tabB.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPending: false,
            logoutFailed: false,
            logoutRevocationFailed: false,
          });
          expect(tabB.isAuthResolved()).toBe(true);

          if (interleaving === 'tabB_logout_then_signin') {
            expect(
              await tabB.signIn('owner@example.test', 'ValidPassword123'),
            ).toBe('ok');
            await vi.waitFor(() => {
              expect(tabB.getAuthSnapshot().status).toBe('owner');
            });
          }

          if (shouldDeferTabA) {
            releaseTabARequest!();
            await tabAPending;
          }
          flushDelayedReversed();
          await Promise.resolve();
          await Promise.resolve();
        }

        // --- Unconditional I5 assertions on EVERY row ---
        expect(values.get(postedOwnerKey)).toBeUndefined();
        expect(values.get(unresolvedOwnerKey)).toBeDefined();
        expect(values.get(otherUserKey)).toBeDefined();
        if (interleaving !== 'tabB_logout_then_signin') {
          expect(heldWrites.isWritesLocked()).toBe(true);
          expect(heldWrites.getHeldWrite('count:daily')).toBeNull();
        }

        // --- Unconditional I1-I4 assertions ---
        if (interleaving === 'observe_only') {
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

            // I4 + I2 on Tab B (under quota-full, revocation failure is in Tab A memory only)
            if (storageOrder === 'dropped') {
              tabB.isAuthResolved();
            }
            await vi.waitFor(() => {
              expect(tabB.getAuthSnapshot().status).toBe('signed-out');
            });
            expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
            expect(tabB.getAuthSnapshot().logoutPending).toBe(false);
            expect(tabB.getAuthSnapshot().logoutRevocationFailed).toBe(
              expectsRevocationFailure && !isQuotaOutcome,
            );
          }

          // I1 + I2 post-check: reload vs refocus unconditionally
          if (postCheck === 'reload') {
            const storageC = makeTabStorage('tabC');
            clientC = createClient(url, TEST_ANON_KEY, {
              auth: {
                storage: storageC,
                storageKey: sdkKey,
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false,
              },
              global: { fetch: fetchB },
            });
            reloadedTab = createAuthStore({
              getClient: () => clientC,
              getProjectUrl: () => url,
              getStorage: () => storageC,
              getSessionStorage: () => sessionStorageA,
              addStorageListener: (fn) => addTabStorageListener('tabC', fn),
              tabId: 'tabC',
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
            }
          } else {
            // Unconditional refocus check on ALL outcomes (including success & quota_full_success!)
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
        } else if (interleaving === 'tabB_supersedes_logout') {
          expect(values.get(sdkKey)).toBeUndefined();
          expect(server.getConfirmedGlobalLogouts()).toBe(1);
          const persisted = JSON.parse(values.get(coordKey) ?? 'null') as {
            attemptId?: number;
            ownerTabId?: string;
            state?: string;
          } | null;
          expect(persisted?.state).toBe('completed');
          expect(persisted?.ownerTabId).toBe('tabB');
          expect((persisted?.attemptId ?? 0) >= (isQuotaOutcome ? 1 : 2)).toBe(
            true,
          );
          expect(tabB.isAuthResolved()).toBe(true);
          expect(tabA.isAuthResolved()).toBe(true);
          expect(tabB.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutFailed: false,
            logoutPending: false,
            logoutRevocationFailed: false,
          });
          expect(tabA.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutFailed: false,
            logoutPending: false,
            logoutRevocationFailed: false,
          });

          if (postCheck === 'reload') {
            const storageC = makeTabStorage('tabC');
            clientC = createClient(url, TEST_ANON_KEY, {
              auth: {
                storage: storageC,
                storageKey: sdkKey,
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false,
              },
              global: { fetch: fetchB },
            });
            reloadedTab = createAuthStore({
              getClient: () => clientC,
              getProjectUrl: () => url,
              getStorage: () => storageC,
              getSessionStorage: () => sessionStorageA,
              addStorageListener: (fn) => addTabStorageListener('tabC', fn),
              tabId: 'tabC',
              syncGlobalStores: false,
            });
            reloadedTab.startAuth();
            await vi.advanceTimersByTimeAsync(20);
            expect(reloadedTab.getAuthSnapshot()).toMatchObject({
              status: 'signed-out',
              logoutFailed: false,
              logoutRevocationFailed: false,
            });
          } else {
            // Unconditional refocus event emitted on BOTH Tab A and Tab B!
            const internalsA = clientA.auth as unknown as {
              _notifyAllSubscribers: (
                event: string,
                session: unknown,
                broadcast?: boolean,
              ) => Promise<void>;
            };
            const internalsB = clientB.auth as unknown as {
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
            await internalsB._notifyAllSubscribers(
              'SIGNED_IN',
              initialSession,
              false,
            );
            await vi.advanceTimersByTimeAsync(20);
            expect(tabA.getAuthSnapshot().status).toBe('signed-out');
            expect(tabA.getAuthSnapshot().logoutFailed).toBe(false);
            expect(tabB.getAuthSnapshot().status).toBe('signed-out');
            expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
          }
        } else {
          // interleaving === 'tabB_logout_then_signin'
          expect(server.getConfirmedGlobalLogouts()).toBe(1);
          const storedAfter = JSON.parse(values.get(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null;
          expect(storedAfter?.access_token).toBeTruthy();
          expect(storedAfter?.access_token).not.toBe(
            initialSession.access_token,
          );
          const persisted = JSON.parse(values.get(coordKey) ?? 'null') as {
            attemptId?: number;
            ownerTabId?: string;
            state?: string;
          } | null;
          expect(persisted?.state).toBe('signed_in');
          expect(persisted?.ownerTabId).toBe('tabB');
          expect((persisted?.attemptId ?? 0) >= (isQuotaOutcome ? 2 : 3)).toBe(
            true,
          );
          expect(tabB.getAuthSnapshot()).toMatchObject({
            status: 'owner',
            logoutFailed: false,
            logoutPending: false,
            logoutRevocationFailed: false,
          });
          expect(tabA.isAuthResolved()).toBe(true);
          expect(tabA.getAuthSnapshot().logoutFailed).toBe(false);
          expect(tabA.getAuthSnapshot().logoutRevocationFailed).toBe(false);

          if (postCheck === 'reload') {
            const storageC = makeTabStorage('tabC');
            clientC = createClient(url, TEST_ANON_KEY, {
              auth: {
                storage: storageC,
                storageKey: sdkKey,
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false,
              },
              global: { fetch: fetchB },
            });
            reloadedTab = createAuthStore({
              getClient: () => clientC,
              getProjectUrl: () => url,
              getStorage: () => storageC,
              getSessionStorage: () => sessionStorageB,
              addStorageListener: (fn) => addTabStorageListener('tabC', fn),
              tabId: 'tabC',
              syncGlobalStores: false,
            });
            reloadedTab.startAuth();
            await vi.waitFor(() => {
              expect(reloadedTab!.getAuthSnapshot().status).toBe('owner');
            });
            expect(
              (
                JSON.parse(values.get(sdkKey) ?? 'null') as {
                  access_token?: string;
                } | null
              )?.access_token,
            ).toBe(storedAfter?.access_token);
          } else {
            const currentNewSession: unknown = JSON.parse(
              values.get(sdkKey) ?? 'null',
            );
            const internalsB = clientB.auth as unknown as {
              _notifyAllSubscribers: (
                event: string,
                session: unknown,
                broadcast?: boolean,
              ) => Promise<void>;
            };
            await internalsB._notifyAllSubscribers(
              'SIGNED_IN',
              currentNewSession,
              false,
            );
            await vi.advanceTimersByTimeAsync(20);
            expect(tabB.getAuthSnapshot().status).toBe('owner');
            expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
          }
        }
      } finally {
        await clientA.auth.stopAutoRefresh();
        await clientB.auth.stopAutoRefresh();
        await clientC?.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
        tabB.resetAuthStore({ clearStorage: false });
        reloadedTab?.resetAuthStore({ clearStorage: false });
        heldWrites.resetHeldWritesStore({
          clearStorage: false,
          resetUser: true,
        });
        hub.closeAll();
      }
    },
  );
});

describe('auth-store review gap coverage (P1-1, P1-2, P1-3, P2-1, P2-2, P2-3, P3-1, I5)', () => {
  const origLocalStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'localStorage',
  );
  const origSessionStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'sessionStorage',
  );
  const origBroadcastChannelDesc = Object.getOwnPropertyDescriptor(
    globalThis,
    'BroadcastChannel',
  );

  afterEach(() => {
    vi.useRealTimers();
    if (origLocalStorageDesc) {
      Object.defineProperty(window, 'localStorage', origLocalStorageDesc);
      Object.defineProperty(globalThis, 'localStorage', origLocalStorageDesc);
    }
    if (origSessionStorageDesc) {
      Object.defineProperty(window, 'sessionStorage', origSessionStorageDesc);
      Object.defineProperty(
        globalThis,
        'sessionStorage',
        origSessionStorageDesc,
      );
    }
    if (origBroadcastChannelDesc) {
      Object.defineProperty(
        globalThis,
        'BroadcastChannel',
        origBroadcastChannelDesc,
      );
    } else {
      delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    }
  });

  const RELOAD_PENDING_CASES = (
    ['normal', 'quota_full', 'legacy_marker'] as const
  ).flatMap((mode) =>
    (['immediate', 'dropped'] as const).map((storageOrder) => ({
      mode,
      storageOrder,
    })),
  );

  it.each(RELOAD_PENDING_CASES)(
    'P1-1: reload while state=pending ($mode, storage=$storageOrder) surfaces revocation_failed without deadlocking signIn()',
    async ({ mode, storageOrder }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hub = createBroadcastHub();
      Object.defineProperty(globalThis, 'BroadcastChannel', {
        configurable: true,
        writable: true,
        value: hub.BroadcastChannel,
      });

      const { createAuthStore, getLogoutCoordStorageKey } =
        await import('@/lib/auth-store');
      const url = `https://p1-1-${mode}-${storageOrder}.test`;
      const sdkKey = `sb-p1-1-${mode}-${storageOrder}-auth-token`;
      const coordKey = getLogoutCoordStorageKey(url);
      const storage = makeMemoryStorage();
      const sessionStorageA = makeMemoryStorage();
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
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });
      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        getSessionStorage: () => sessionStorageA,
        addStorageListener: () => () => {},
        tabId: 'tabA',
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
          // Simulate tab reload before /logout resolves: old JS context dies.
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
            autoRefreshToken: true,
            detectSessionInUrl: false,
          },
          global: { fetch: fetchFn },
        });
        reloadedTab = createAuthStore({
          getClient: () => clientReloaded,
          getProjectUrl: () => url,
          getStorage: () => storage,
          getSessionStorage: () => sessionStorageA,
          addStorageListener: () => () => {},
          tabId: 'tabReloaded',
          syncGlobalStores: false,
        });

        reloadedTab.startAuth();
        if (mode === 'normal') {
          // P3-2: Without navigator.locks, a fresh pending lease stays in
          // signing_out until the owner's lease expires (10s).
          await vi.advanceTimersByTimeAsync(10_500);
        } else {
          await vi.advanceTimersByTimeAsync(20);
        }

        if (mode === 'quota_full') {
          // DELTA 13 Item 5: Under quota-full, pending lives in memory only
          // and disappears on reload; sdkKey is gone so reload boots cleanly to idle.
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

        // Owner follows LoginPage's recovery instruction and signs in: MUST succeed!
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
        hub.closeAll();
      }
    },
  );

  const RETRY_REVOCATION_CASES = (
    ['revocation_503', 'revocation_401', 'quota_full_503'] as const
  ).flatMap((outcome) =>
    (['immediate', 'delayed_reversed', 'dropped'] as const).map(
      (storageOrder) => ({ outcome, storageOrder }),
    ),
  );

  it.each(RETRY_REVOCATION_CASES)(
    'P1-2 Path A: retryLogoutRevocation() rejects refocus SIGNED_IN during retrying_revocation and converges ($outcome, storage=$storageOrder)',
    async ({ outcome, storageOrder }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hub = createBroadcastHub();
      Object.defineProperty(globalThis, 'BroadcastChannel', {
        configurable: true,
        writable: true,
        value: hub.BroadcastChannel,
      });

      const { createAuthStore } = await import('@/lib/auth-store');
      const url = `https://retry-rev-${outcome}-${storageOrder}.test`;
      const sdkKey = `sb-retry-rev-${outcome}-${storageOrder}-auth-token`;
      const listeners = new Map<string, Set<(e: StorageEvent) => void>>();
      const values = new Map<string, string>();
      const sessionStorageA = makeMemoryStorage();
      const sessionStorageB = makeMemoryStorage();
      let full = false;

      const makeStorage = (tabName: string): Storage => ({
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
          const oldValue = values.get(k) ?? null;
          if (!values.delete(k)) return;
          if (storageOrder === 'immediate') {
            for (const [t, set] of listeners) {
              if (t === tabName) continue;
              const ev = new StorageEvent('storage', {
                key: k,
                oldValue,
                newValue: null,
              });
              for (const fn of [...set]) fn(ev);
            }
          }
        },
        setItem(k: string, v: string) {
          const oldValue = values.get(k) ?? null;
          if (full && oldValue === null) {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
          }
          values.set(k, String(v));
          if (storageOrder === 'immediate') {
            for (const [t, set] of listeners) {
              if (t === tabName) continue;
              const ev = new StorageEvent('storage', {
                key: k,
                oldValue,
                newValue: String(v),
              });
              for (const fn of [...set]) fn(ev);
            }
          }
        },
      });

      const storageA = makeStorage('tabA');
      const storageB = makeStorage('tabB');
      const server = createStatefulAuthServer();
      const initialSession = server.issueSession();
      values.set(sdkKey, JSON.stringify(initialSession));

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
          storage: storageA,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });
      const clientB = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage: storageB,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });

      const addListener = (t: string, fn: (e: StorageEvent) => void) => {
        const set = listeners.get(t) ?? new Set();
        set.add(fn);
        listeners.set(t, set);
        return () => set.delete(fn);
      };

      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storageA,
        getSessionStorage: () => sessionStorageA,
        addStorageListener: (fn) => addListener('tabA', fn),
        tabId: 'tabA',
        syncGlobalStores: false,
      });
      const tabB = createAuthStore({
        getClient: () => clientB as never,
        getProjectUrl: () => url,
        getStorage: () => storageB,
        getSessionStorage: () => sessionStorageB,
        addStorageListener: (fn) => addListener('tabB', fn),
        tabId: 'tabB',
        syncGlobalStores: false,
      });

      try {
        tabA.startAuth();
        tabB.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('owner');
          expect(tabB.getAuthSnapshot().status).toBe('owner');
        });

        if (outcome === 'quota_full_503') full = true;
        await tabA.signOut();
        expect(tabA.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'revocation_failed',
          logoutRevocationFailed: true,
          canRetryLogoutRevocation: true,
        });

        // Start retryLogoutRevocation() and emit stale refocus SIGNED_IN while in flight!
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

        // Must NOT reopen owner access during retrying_revocation!
        expect(tabA.getAuthSnapshot().status).toBe('signed-out');
        expect(tabA.getAuthSnapshot().logoutPhase).toBe('retrying_revocation');

        // Release 204 and confirm both tabs converge cleanly to idle.
        releaseRetryLogout!();
        await retryPromise;
        await Promise.resolve();
        await Promise.resolve();

        expect(server.getConfirmedGlobalLogouts()).toBe(1);
        expect(tabA.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'idle',
          logoutRevocationFailed: false,
        });
        await vi.waitFor(() => {
          expect(tabB.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'idle',
            logoutRevocationFailed: false,
          });
        });
      } finally {
        await clientA.auth.stopAutoRefresh();
        await clientB.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
        tabB.resetAuthStore({ clearStorage: false });
        hub.closeAll();
      }
    },
  );

  it('P1-2 Path B: in-flight autoRefreshToken (_callRefreshToken) resolving after completed signOut does NOT reopen owner or persist rotated token', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p1-2-autorefresh-race.test';
    const sdkKey = 'sb-p1-2-autorefresh-race-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer({ initialExpiresInSec: 100 });
    const initialSession = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(initialSession));

    let releaseRefresh: (() => void) | null = null;
    const fetchB: typeof fetch = (input, init) => {
      const href = requestUrlOf(input);
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
        // Compute the rotated 200 response BEFORE Tab A revokes, then hold in transit!
        const rotatedResponse = server.handleRefresh(body);
        return new Promise<Response>((resolve) => {
          releaseRefresh = () => resolve(rotatedResponse);
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const fetchA: typeof fetch = (input, init) => {
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
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchB },
    });

    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Advance fake timers so clientB's autoRefreshToken tick fires inside the 90s margin.
      await vi.advanceTimersByTimeAsync(35_000);
      await vi.waitFor(() => {
        expect(releaseRefresh).not.toBeNull();
      });

      // While Tab B's refresh is in flight, Tab A completes sign-out (204).
      await tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(tabA.getAuthSnapshot().status).toBe('signed-out');

      // Release Tab B's in-flight refresh response AND also simulate a late TOKEN_REFRESHED
      // broadcast + storage write (covering the TOCTOU window between storage check and _saveSession).
      releaseRefresh!();
      await vi.advanceTimersByTimeAsync(50);

      // Even if a late _callRefreshToken wrote a rotated token for the SAME revoked sid:
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
      const internalsB = clientB.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsB._notifyAllSubscribers(
        'TOKEN_REFRESHED',
        rotatedSession,
        true,
      );
      await vi.advanceTimersByTimeAsync(50);

      expect(tabA.getAuthSnapshot().status).toBe('signed-out');
      expect(tabB.getAuthSnapshot().status).toBe('signed-out');
      expect(storage.getItem(sdkKey)).toBeNull();
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('P1-3 fallback: quota-full + dropped StorageEvent + NO BroadcastChannel still signs out Tab B on reconcile/isAuthResolved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Explicitly remove BroadcastChannel to test pure storage-absence fallback.
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p1-3-no-bc.test';
    const sdkKey = 'sb-p1-3-no-bc-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

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

    const clientA = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });

    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      storage.setFull(true);
      await tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();

      // StorageEvent was dropped and BroadcastChannel is absent; Tab B reconciles on check.
      expect(tabB.isAuthResolved()).toBe(true);
      expect(tabB.getAuthSnapshot().status).toBe('signed-out');
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  const P2_1_CASES = [
    'same_tab_double_click',
    'tabA_204_commits_before_tabB_403',
    'tabB_403_commits_before_tabA_204',
  ] as const;

  it.each(P2_1_CASES)(
    'P2-1: concurrent signOut against stateful server never strands UI in revocation_failed (%s)',
    async (scenario) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hub = createBroadcastHub();
      Object.defineProperty(globalThis, 'BroadcastChannel', {
        configurable: true,
        writable: true,
        value: hub.BroadcastChannel,
      });

      const { createAuthStore } = await import('@/lib/auth-store');
      const url = `https://p2-1-${scenario}.test`;
      const sdkKey = `sb-p2-1-${scenario}-auth-token`;
      const storage = makeMemoryStorage();
      const server = createStatefulAuthServer();
      storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

      let logoutRequests = 0;
      let releaseTabAResponse: (() => void) | null = null;
      let releaseTabBResponse: (() => void) | null = null;

      const makeFetch =
        (who: 'A' | 'B'): typeof fetch =>
        (input, init) => {
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
            // Hit the stateful server NOW (Tab A hits first -> 204, Tab B hits second -> 403)
            const res = server.handleLogout(headers.get('authorization'));
            if (scenario === 'same_tab_double_click') {
              return new Promise<Response>((resolve) => {
                releaseTabAResponse = () => resolve(res);
              });
            }
            if (who === 'A') {
              return new Promise<Response>((resolve) => {
                releaseTabAResponse = () => resolve(res);
              });
            }
            return new Promise<Response>((resolve) => {
              releaseTabBResponse = () => resolve(res);
            });
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
        global: { fetch: makeFetch('A') },
      });
      const clientB = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: { fetch: makeFetch('B') },
      });

      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        addStorageListener: () => () => {},
        tabId: 'tabA',
        syncGlobalStores: false,
      });
      const tabB = createAuthStore({
        getClient: () => clientB as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        addStorageListener: () => () => {},
        tabId: 'tabB',
        syncGlobalStores: false,
      });

      try {
        tabA.startAuth();
        tabB.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('owner');
          expect(tabB.getAuthSnapshot().status).toBe('owner');
        });

        if (scenario === 'same_tab_double_click') {
          const p1 = tabA.signOut();
          const p2 = tabA.signOut();
          await vi.waitFor(() => {
            expect(releaseTabAResponse).not.toBeNull();
          });
          expect(logoutRequests).toBe(1);
          releaseTabAResponse!();
          await Promise.all([p1, p2]);
        } else {
          const pA = tabA.signOut();
          await vi.waitFor(() => {
            expect(releaseTabAResponse).not.toBeNull();
          });
          const pB = tabB.signOut();
          await vi.waitFor(() => {
            expect(releaseTabBResponse).not.toBeNull();
          });

          if (scenario === 'tabA_204_commits_before_tabB_403') {
            releaseTabAResponse!();
            await pA;
            releaseTabBResponse!();
            await pB;
          } else {
            releaseTabBResponse!();
            await pB;
            releaseTabAResponse!();
            await pA;
          }
        }

        await Promise.resolve();
        await Promise.resolve();
        expect(server.getConfirmedGlobalLogouts()).toBe(1);
        expect(tabA.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'idle',
          logoutFailed: false,
          logoutRevocationFailed: false,
        });
        await vi.waitFor(() => {
          expect(tabB.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'idle',
            logoutFailed: false,
            logoutRevocationFailed: false,
          });
        });
      } finally {
        await clientA.auth.stopAutoRefresh();
        await clientB.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
        tabB.resetAuthStore({ clearStorage: false });
        hub.closeAll();
      }
    },
  );

  it('P2-2: concurrent cross-tab signOut while signInWithPassword is in flight does not leave signIn returning ok with status signed-out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p2-2-concurrent-signin.test';
    const sdkKey = 'sb-p2-2-concurrent-signin-auth-token';
    const values = new Map<string, string>();
    const listeners = new Map<string, Set<(e: StorageEvent) => void>>();
    const makeStorage = (tabName: string): Storage => ({
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
        const oldValue = values.get(k) ?? null;
        if (!values.delete(k)) return;
        for (const [t, set] of listeners) {
          if (t === tabName) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: null,
          });
          for (const fn of [...set]) fn(ev);
        }
      },
      setItem(k: string, v: string) {
        const oldValue = values.get(k) ?? null;
        values.set(k, String(v));
        for (const [t, set] of listeners) {
          if (t === tabName) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: String(v),
          });
          for (const fn of [...set]) fn(ev);
        }
      },
    });
    const addListener = (t: string, fn: (e: StorageEvent) => void) => {
      const set = listeners.get(t) ?? new Set();
      set.add(fn);
      listeners.set(t, set);
      return () => set.delete(fn);
    };

    const storageA = makeStorage('tabA');
    const storageB = makeStorage('tabB');
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    const failLogout = true;
    const secondLogout: { release: (() => void) | null } = { release: null };
    let holdSecondLogout = false;
    let releaseSignIn: (() => void) | null = null;
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
      if (href.includes('/auth/v1/logout')) {
        if (holdSecondLogout) {
          return new Promise<Response>((resolve) => {
            secondLogout.release = () =>
              resolve(
                new Response(JSON.stringify({ message: '503' }), {
                  status: 503,
                  headers: { 'content-type': 'application/json' },
                }),
              );
          });
        }
        if (failLogout) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: '503' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return new Promise<Response>((resolve) => {
          releaseSignIn = () => resolve(server.handlePasswordSignIn());
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const clientA = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageA,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageB,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });

    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      addStorageListener: (fn) => addListener('tabA', fn),
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      addStorageListener: (fn) => addListener('tabB', fn),
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Put Tab B in revocation_failed (login enabled) via Tab B signOut while
      // Tab A did not yet observe revocation_failed (or still has its session) and
      // calls signOut() while Tab B's signInWithPassword is in flight so Tab A writes
      // state:'pending' (attemptId: 2) and holds /logout in flight while signIn resolves!
      await tabB.signOut();
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });

      // Tab B starts signIn(), held in flight.
      const signInPromise = tabB.signIn(
        'owner@example.test',
        'ValidPassword123',
      );
      await vi.waitFor(() => {
        expect(releaseSignIn).not.toBeNull();
      });

      // While Tab B's signIn is in flight, Tab A (or another tab) writes state:'pending'
      // (attemptId: 2) to coordKey — e.g. from a concurrent signOut() whose /logout is in flight!
      holdSecondLogout = true;
      const pendingCoord = JSON.stringify({
        attemptId: 2,
        ownerTabId: 'tabA',
        state: 'pending',
        sessionKey: 'sid:sid-1',
      });
      storageA.setItem(
        `theshark:auth:logout-pending:v1:${encodeURIComponent(url)}`,
        pendingCoord,
      );

      // Now Tab B's signInWithPassword resolves with a fresh session2 while Tab B saw pending!
      releaseSignIn!();
      expect(await signInPromise).toBe('ok');
      secondLogout.release?.();

      await vi.advanceTimersByTimeAsync(30);
      expect(tabB.getAuthSnapshot().status).toBe('owner');
      expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
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
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });

    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      tabId: 'tab-i5',
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

      // Sign out User A: unresolved pin stays in storage, posted_reload clears, writes lock.
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

      // Sign in as User B: User A's pin MUST NOT be readable by User B!
      nextLoginUser = { userId: 'user-b', email: 'b@example.test' };
      expect(await store.signIn('b@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
        expect(store.getAuthSnapshot().email).toBe('b@example.test');
      });
      expect(heldWrites.getHeldWrite('count:daily')).toBeNull();

      // Sign out User B and sign back in as User A: User A's unresolved pin is restored!
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
});

function createFakeLockManager() {
  type HeldLock = {
    name: string;
    holderId: number;
    release: () => void;
  };
  type Waiter = {
    run: () => void;
  };
  let nextHolderId = 0;
  const held = new Map<string, HeldLock>();
  const queues = new Map<string, Waiter[]>();
  const requestLog: Array<{ name: string; ifAvailable: boolean }> = [];

  function acquire(name: string): () => void {
    const holderId = ++nextHolderId;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (held.get(name)?.holderId !== holderId) return;
      const q = queues.get(name);
      const next = q?.shift();
      if (q && q.length === 0) queues.delete(name);
      if (next) {
        // Atomically transfer ownership to the next queued waiter so no new
        // request can jump the queue during lock handoff.
        next.run();
      } else {
        held.delete(name);
      }
    };
    held.set(name, { name, holderId, release });
    return release;
  }

  return {
    request<T>(
      name: string,
      options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
      callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
    ): Promise<T> {
      requestLog.push({ name, ifAvailable: Boolean(options.ifAvailable) });
      if (options.ifAvailable) {
        if (held.has(name)) {
          return Promise.resolve().then(() => callback(null));
        }
        const release = acquire(name);
        return Promise.resolve()
          .then(() => callback({ name, mode: options.mode ?? 'exclusive' }))
          .finally(release);
      }
      if (!held.has(name)) {
        const release = acquire(name);
        return Promise.resolve()
          .then(() => callback({ name, mode: options.mode ?? 'exclusive' }))
          .finally(release);
      }
      return new Promise<T>((resolve, reject) => {
        const q = queues.get(name) ?? [];
        q.push({
          run() {
            const release = acquire(name);
            Promise.resolve()
              .then(() => callback({ name, mode: options.mode ?? 'exclusive' }))
              .finally(release)
              .then(resolve, reject);
          },
        });
        queues.set(name, q);
      });
    },
    isHeld(name: string): boolean {
      return held.has(name);
    },
    hasAnyHeld(prefix?: string): boolean {
      if (!prefix) return held.size > 0;
      for (const key of held.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },
    getHolderId(name: string): number | null {
      return held.get(name)?.holderId ?? null;
    },
    getRequestLog() {
      return requestLog;
    },
  };
}

describe('auth-store PR 65 verified findings (P1-1..P3-4)', () => {
  const origLocalStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'localStorage',
  );
  const origSessionStorageDesc = Object.getOwnPropertyDescriptor(
    window,
    'sessionStorage',
  );
  const origBroadcastChannelDesc = Object.getOwnPropertyDescriptor(
    globalThis,
    'BroadcastChannel',
  );
  const origVisibilityStateDesc = Object.getOwnPropertyDescriptor(
    document,
    'visibilityState',
  );

  afterEach(() => {
    vi.useRealTimers();
    if (origLocalStorageDesc) {
      Object.defineProperty(window, 'localStorage', origLocalStorageDesc);
      Object.defineProperty(globalThis, 'localStorage', origLocalStorageDesc);
    }
    if (origSessionStorageDesc) {
      Object.defineProperty(window, 'sessionStorage', origSessionStorageDesc);
      Object.defineProperty(
        globalThis,
        'sessionStorage',
        origSessionStorageDesc,
      );
    }
    if (origBroadcastChannelDesc) {
      Object.defineProperty(
        globalThis,
        'BroadcastChannel',
        origBroadcastChannelDesc,
      );
    } else {
      delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    }
    if (origVisibilityStateDesc) {
      Object.defineProperty(
        document,
        'visibilityState',
        origVisibilityStateDesc,
      );
    } else {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('P1-1: real GoTrueClient local_remove_failure clears pendingSignOutPromise and releases lock so retry signOut removes creds, revokes, and completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p1-1-local-remove-retry.test';
    const sdkKey = 'sb-p1-1-local-remove-retry-auth-token';
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;

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
    const initialSession = server.issueSession();
    values.set(sdkKey, JSON.stringify(initialSession));

    const fakeLocks = createFakeLockManager();
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tab-p1-1-retry',
      syncGlobalStores: false,
    });

    try {
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
      });

      // First signOut fails local credential removal synchronously (never awaits).
      await store.signOut();
      await Promise.resolve();
      expect(store.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
        logoutPending: false,
      });
      expect(values.get(sdkKey)).toBeDefined();
      expect(fakeLocks.hasAnyHeld(lockKey)).toBe(false);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);

      // P3-4: signIn while blocked in local_failed returns 'failed' without sending credentials.
      expect(await store.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );

      // Storage recovers: retrying signOut MUST NOT coalesce onto stale promise.
      failRemoveSdkKey = false;
      await store.signOut();
      await Promise.resolve();

      expect(values.get(sdkKey)).toBeUndefined();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(fakeLocks.hasAnyHeld(lockKey)).toBe(false);
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

  it('P1-1: real GoTrueClient signOut skips commitLogoutResult and releases lock when storage already holds a newer session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://p1-1-skip-newer.test';
    const sdkKey = 'sb-p1-1-skip-newer-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();

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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tab-p1-1-skip',
      syncGlobalStores: false,
    });

    try {
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
      });

      // Another tab replaced sdkKey with session2 (before writing signed_in coord).
      storage.setItem(sdkKey, JSON.stringify(session2));

      await store.signOut();
      await Promise.resolve();

      // Must NOT delete session2, must NOT leave a dangling pending coord, must stay idle/resolved, and must release lock.
      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(session2.access_token);
      expect(storage.getItem(coordKey)).toBeNull();
      expect(fakeLocks.hasAnyHeld(lockKey)).toBe(false);
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

  it('P1-2(A): pre-accept signIn throw does NOT delete or globally revoke another tab newer session (I3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p1-2a-pre-accept-throw.test';
    const sdkKey = 'sb-p1-2a-pre-accept-throw-auth-token';
    const values = new Map<string, string>();
    let throwQuotaForTabA = false;
    const makeTabStorage = (who: 'A' | 'B'): Storage => ({
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
        if (who === 'A' && throwQuotaForTabA && k === sdkKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    });
    const storageA = makeTabStorage('A');
    const storageB = makeTabStorage('B');
    const server = createStatefulAuthServer();

    let releaseTabASignIn: (() => void) | null = null;
    const fetchA: typeof fetch = (input, init) => {
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
          releaseTabASignIn = () => resolve(server.handlePasswordSignIn());
        });
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const fetchB: typeof fetch = (input) => {
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

    const clientA = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageA,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchA },
    });
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageB,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchB },
    });
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('signed-out');
        expect(tabB.getAuthSnapshot().status).toBe('signed-out');
      });

      // Tab A starts sign-in; before it resolves, Tab B completes a sign-in.
      const signInAPromise = tabA.signIn(
        'owner@example.test',
        'ValidPassword123',
      );
      await vi.waitFor(() => {
        expect(releaseTabASignIn).not.toBeNull();
      });

      expect(await tabB.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
      const tabBSession = JSON.parse(values.get(sdkKey) ?? 'null') as {
        access_token?: string;
      } | null;
      expect(tabBSession?.access_token).toBeTruthy();

      // Tab A's signInWithPassword now throws QuotaExceededError before accepting!
      throwQuotaForTabA = true;
      releaseTabASignIn!();
      expect(await signInAPromise).toBe('failed');
      await Promise.resolve();

      // I3: Tab B's session MUST remain in storage, unrevoked, and Tab B stays owner!
      expect(
        (
          JSON.parse(values.get(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(tabBSession?.access_token);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
      expect(tabB.getAuthSnapshot().status).toBe('owner');
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it.each(['revocation_204', 'revocation_503'] as const)(
    'P1-2(B): post-accept signIn throw advances coord so sibling tab reconciles to login and surfaces revocation failure on 503 (%s)',
    async (mode) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hub = createBroadcastHub();
      Object.defineProperty(globalThis, 'BroadcastChannel', {
        configurable: true,
        writable: true,
        value: hub.BroadcastChannel,
      });

      const { createAuthStore, getLogoutCoordStorageKey } =
        await import('@/lib/auth-store');
      const url = `https://p1-2b-post-accept-${mode}.test`;
      const sdkKey = `sb-p1-2b-post-accept-${mode}-auth-token`;
      const coordKey = getLogoutCoordStorageKey(url);
      const values = new Map<string, string>();
      const storageListeners = new Map<
        string,
        Set<(e: StorageEvent) => void>
      >();
      const makeTabStorage = (who: string): Storage => ({
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
          const oldValue = values.get(k) ?? null;
          if (!values.delete(k)) return;
          for (const [t, set] of storageListeners) {
            if (t === who) continue;
            const ev = new StorageEvent('storage', {
              key: k,
              oldValue,
              newValue: null,
            });
            for (const fn of [...set]) fn(ev);
          }
        },
        setItem(k: string, v: string) {
          const oldValue = values.get(k) ?? null;
          values.set(k, String(v));
          for (const [t, set] of storageListeners) {
            if (t === who) continue;
            const ev = new StorageEvent('storage', {
              key: k,
              oldValue,
              newValue: String(v),
            });
            for (const fn of [...set]) fn(ev);
          }
        },
      });
      const addListener = (who: string, fn: (e: StorageEvent) => void) => {
        const set = storageListeners.get(who) ?? new Set();
        set.add(fn);
        storageListeners.set(who, set);
        return () => set.delete(fn);
      };

      const storageA = makeTabStorage('tabA');
      const storageB = makeTabStorage('tabB');
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
          storage: storageA,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });
      const clientB = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage: storageB,
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
        getStorage: () => storageA,
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: (fn) => addListener('tabA', fn),
        tabId: 'tabA',
        syncGlobalStores: false,
      });
      const tabB = createAuthStore({
        getClient: () => clientB as never,
        getProjectUrl: () => url,
        getStorage: () => storageB,
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: (fn) => addListener('tabB', fn),
        tabId: 'tabB',
        syncGlobalStores: false,
      });

      try {
        tabA.startAuth();
        tabB.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('signed-out');
          expect(tabB.getAuthSnapshot().status).toBe('signed-out');
        });

        // Trigger a real post-accept throw AFTER writeSharedCoord writes 'signed_in':
        // 1. When tabA first accepts SIGNED_IN inside signInWithPassword, simulate a
        //    concurrent sibling 'pending' coord arriving (like the P2-2 race) so
        //    tabA's machine.session is cleared before signInWithPassword returns.
        // 2. signIn() then writes attemptId=2 state='signed_in' to coordKey (while
        //    tabB becomes owner via BroadcastChannel), then calls acceptAuthenticatedSession
        //    -> emit(), where our subscriber throws!
        let injectedConcurrentPending = false;
        let throwOnceAfterSignedInCoord = true;
        const unsub = tabA.subscribeAuth(() => {
          const currentCoord = JSON.parse(values.get(coordKey) ?? 'null') as {
            state?: string;
          } | null;
          if (
            !injectedConcurrentPending &&
            tabA.getAuthSnapshot().status === 'checking' &&
            currentCoord === null
          ) {
            injectedConcurrentPending = true;
            const pendingPayload = JSON.stringify({
              attemptId: 1,
              ownerTabId: 'tabC',
              state: 'pending',
              sessionKey: null,
            });
            values.set(coordKey, pendingPayload);
            for (const fn of [...(storageListeners.get('tabA') ?? [])]) {
              fn(
                new StorageEvent('storage', {
                  key: coordKey,
                  oldValue: null,
                  newValue: pendingPayload,
                }),
              );
            }
            return;
          }
          if (
            throwOnceAfterSignedInCoord &&
            currentCoord?.state === 'signed_in'
          ) {
            throwOnceAfterSignedInCoord = false;
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
        expect(values.get(sdkKey)).toBeUndefined();
        const finalCoord = JSON.parse(values.get(coordKey) ?? 'null') as {
          attemptId?: number;
          state?: string;
        } | null;

        if (mode === 'revocation_204') {
          expect(server.getConfirmedGlobalLogouts()).toBe(1);
          expect(finalCoord).toMatchObject({
            attemptId: 3,
            state: 'completed',
          });
          expect(tabA.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'idle',
            logoutRevocationFailed: false,
          });
          await vi.waitFor(() => {
            expect(tabB.getAuthSnapshot()).toMatchObject({
              status: 'signed-out',
              logoutPhase: 'idle',
              logoutRevocationFailed: false,
            });
          });
        } else {
          expect(server.getConfirmedGlobalLogouts()).toBe(0);
          expect(finalCoord).toMatchObject({
            attemptId: 3,
            state: 'revocation_failed',
          });
          expect(tabA.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'revocation_failed',
            logoutRevocationFailed: true,
            canRetryLogoutRevocation: true,
          });
          await vi.waitFor(() => {
            expect(tabB.getAuthSnapshot()).toMatchObject({
              status: 'signed-out',
              logoutPhase: 'revocation_failed',
              logoutRevocationFailed: true,
            });
          });

          // Retry revocation after server recovers -> both tabs converge to idle.
          failLogout = false;
          await tabA.retryLogoutRevocation();
          await Promise.resolve();
          expect(server.getConfirmedGlobalLogouts()).toBe(1);
          expect(tabA.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'idle',
            logoutRevocationFailed: false,
          });
          await vi.waitFor(() => {
            expect(tabB.getAuthSnapshot()).toMatchObject({
              status: 'signed-out',
              logoutPhase: 'idle',
              logoutRevocationFailed: false,
            });
          });
        }
      } finally {
        await clientA.auth.stopAutoRefresh();
        await clientB.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
        tabB.resetAuthStore({ clearStorage: false });
        hub.closeAll();
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tab-p1-3',
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

  it('P2-1: fake navigator.locks releases after commitLogoutResult and prevents waiting tab from promoting completed logout to revocation_failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://p2-1-web-locks.test';
    const sdkKey = 'sb-p2-1-web-locks-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let releaseLogout: (() => void) | null = null;
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
          releaseLogout = () =>
            resolve(server.handleLogout(headers.get('authorization')));
        });
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
    const clientB = createClient(url, TEST_ANON_KEY, {
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      const signOutPromise = tabA.signOut();
      await vi.waitFor(() => {
        expect(releaseLogout).not.toBeNull();
      });
      await Promise.resolve();
      expect(fakeLocks.isHeld(`${lockKey}:1:tabA`)).toBe(true);
      expect(storage.getItem(sdkKey)).toBeNull();

      // Tab B boots while Tab A holds the logout Web Lock -> waits on lock in signing_out.
      tabB.startAuth();
      await Promise.resolve();
      await Promise.resolve();
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'signing_out',
        logoutRevocationFailed: false,
      });

      // Make localStorage quota-full before Tab A commits so Tab B relies on
      // BroadcastChannel + machine.knownSeq/knownStateRank when lock releases!
      storage.setFull(true);
      storage.removeItem(coordKey);
      // Re-seed pending in localStorage (already deleted, so quota blocks new write).
      releaseLogout!();
      await signOutPromise;
      await vi.advanceTimersByTimeAsync(20);

      // Lock must be released and Tab B MUST converge to idle (NOT bogus revocation_failed).
      expect(fakeLocks.hasAnyHeld(lockKey)).toBe(false);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });

      // Now verify true abandonment: Tab C holds lock with pending coord and dies without committing.
      storage.setFull(false);
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 10,
          ownerTabId: 'tabC',
          state: 'pending',
          sessionKey: 'sid:abandoned',
        }),
      );
      let releaseAbandonedLock!: () => void;
      const abandonedLockHeld = fakeLocks.request(
        `${lockKey}:10:tabC`,
        { mode: 'exclusive' },
        () =>
          new Promise<void>((resolve) => {
            releaseAbandonedLock = resolve;
          }),
      );
      await Promise.resolve();
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
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: () => () => {},
        getLocks: () => fakeLocks,
        tabId: 'tabD',
        syncGlobalStores: false,
      });
      try {
        tabD.startAuth();
        await Promise.resolve();
        expect(tabD.getAuthSnapshot().logoutPhase).toBe('signing_out');

        // Abandoned owner releases lock without committing -> Tab D promotes to revocation_failed.
        releaseAbandonedLock();
        await abandonedLockHeld;
        await vi.waitFor(() => {
          expect(tabD.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
        });
        expect(tabD.isAuthResolved()).toBe(true);
      } finally {
        await clientD.auth.stopAutoRefresh();
        tabD.resetAuthStore({ clearStorage: false });
      }
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('P2-2: frozen background tab reconciles to signed-out on real visibilitychange event and cleans up listener on reset', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://p2-2-visibilitychange.test';
    const sdkKey = 'sb-p2-2-visibilitychange-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

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
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });

    const removeListenerSpy = vi.spyOn(document, 'removeEventListener');
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Tab B is hidden and misses both BroadcastChannel and StorageEvent (quota-full).
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      storage.setFull(true);
      await tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(tabB.getAuthSnapshot().status).toBe('owner');

      // Firing visibilitychange while still hidden does not reconcile.
      document.dispatchEvent(new Event('visibilitychange'));
      expect(tabB.getAuthSnapshot().status).toBe('owner');

      // Tab B returns to foreground -> real visibilitychange reconciles to signed-out!
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
        logoutPending: false,
      });
      expect(tabB.isAuthResolved()).toBe(true);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      expect(
        removeListenerSpy.mock.calls.some(
          ([type]) => type === 'visibilitychange',
        ),
      ).toBe(true);
      removeListenerSpy.mockRestore();
    }
  });

  it('P3-1: superseded signOut with targetSessionKey=null does not overwrite a newer tab unconfirmed logout', async () => {
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://p3-1-null-target-rescue.test';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();

    let resolveNullKeySignOut: ((v: { error: null }) => void) | null = null;
    const mockClientA = {
      auth: {
        onAuthStateChange(cb: (event: string, session: null) => void) {
          cb('INITIAL_SESSION', null);
          return { data: { subscription: { unsubscribe() {} } } };
        },
        signInWithPassword: () =>
          Promise.resolve({ data: { user: null, session: null }, error: null }),
        signOut: () =>
          new Promise<{ error: null }>((resolve) => {
            resolveNullKeySignOut = resolve;
          }),
      },
      schema: () => ({
        rpc: () => Promise.resolve({ data: true, error: null }),
      }),
    };

    const tabA = createAuthStore({
      getClient: () => mockClientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      // Start a sessionless signOut (targetSessionKey === null).
      const pendingA = tabA.signOut();
      await vi.waitFor(() => {
        expect(resolveNullKeySignOut).not.toBeNull();
      });

      // Another tab records a newer unconfirmed revocation_failed for a real session.
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 2,
          ownerTabId: 'tabB',
          state: 'revocation_failed',
          sessionKey: 'sid:real-session',
        }),
      );

      // Tab A's older sessionless signOut completes with localOk=true, revocationOk=true.
      resolveNullKeySignOut!({ error: null });
      await pendingA;

      // Rescue path MUST NOT overwrite tabB's revocation_failed with completed!
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 2,
        ownerTabId: 'tabB',
        state: 'revocation_failed',
        sessionKey: 'sid:real-session',
      });
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
    } finally {
      tabA.resetAuthStore({ clearStorage: false });
    }
  });

  it('P3-2: revocation_failed outranks local_failed for the same attemptId and local_failed cannot regress revocation_failed', async () => {
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://p3-2-rank.test';
    const sdkKey = 'sb-p3-2-rank-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify(true), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          ),
      },
    });

    const listenerHolder: { fn: ((e: StorageEvent) => void) | null } = {
      fn: null,
    };
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: (fn) => {
        listenerHolder.fn = fn;
        return () => {
          listenerHolder.fn = null;
        };
      },
      tabId: 'tab-p3-2',
      syncGlobalStores: false,
    });

    try {
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
      });

      const localFailed = JSON.stringify({
        attemptId: 5,
        ownerTabId: 'other-tab',
        state: 'local_failed',
        sessionKey: 'sid:sid-1',
      });
      storage.setItem(coordKey, localFailed);
      listenerHolder.fn?.(
        new StorageEvent('storage', { key: coordKey, newValue: localFailed }),
      );
      expect(store.getAuthSnapshot().logoutPhase).toBe('local_failed');

      // Same attemptId advancing from local_failed (rank 2) -> revocation_failed (rank 3).
      const revocationFailed = JSON.stringify({
        attemptId: 5,
        ownerTabId: 'other-tab',
        state: 'revocation_failed',
        sessionKey: 'sid:sid-1',
      });
      storage.setItem(coordKey, revocationFailed);
      listenerHolder.fn?.(
        new StorageEvent('storage', {
          key: coordKey,
          newValue: revocationFailed,
        }),
      );
      expect(store.getAuthSnapshot().logoutPhase).toBe('revocation_failed');

      // Stale local_failed (rank 2) on same attemptId must NOT regress revocation_failed (rank 3).
      storage.setItem(coordKey, localFailed);
      listenerHolder.fn?.(
        new StorageEvent('storage', { key: coordKey, newValue: localFailed }),
      );
      expect(store.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
    } finally {
      await client.auth.stopAutoRefresh();
      store.resetAuthStore({ clearStorage: false });
      hub.closeAll();
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tab-p3-3',
      syncGlobalStores: true,
    });

    try {
      heldWrites.resetHeldWritesStore({ clearStorage: false, resetUser: true });
      store.startAuth();
      await vi.waitFor(() => {
        expect(store.getAuthSnapshot().status).toBe('owner');
        expect(store.getAuthSnapshot().email).toBe('a@example.test');
      });

      // Create an inflight held write for user-a, then fail durable posted_reload write
      // so user-a has an in-memory acknowledgedInflight entry.
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

      // Direct user switch to user-b without signing out first.
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

      // I5: user-a's in-memory acknowledgedInflight MUST NOT leak to user-b!
      expect(heldWrites.hasPostedReload('count:daily')).toBe(false);
      expect(heldWrites.hasPostedReloadForTarget('2030-04-01')).toBe(false);
      expect(heldWrites.listPostedReloadRecords()).toEqual([]);
      // And user-a's durable unresolved pin stays in storage under user-a's prefix.
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

  it('NEW-1: open sibling tab watching logout Web Lock promotes abandoned pending to revocation_failed (creds gone) or local_failed (creds present) when owner tab dies', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://new-1-sibling-lock-watch.test';
    const sdkKey = 'sb-new-1-sibling-lock-watch-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const sessionStorageA = makeMemoryStorage();
    const sessionStorageB = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let releaseLogout: (() => void) | null = null;
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
          releaseLogout = () =>
            resolve(server.handleLogout(headers.get('authorization')));
        });
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
    const clientB = createClient(url, TEST_ANON_KEY, {
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
      getSessionStorage: () => sessionStorageA,
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => sessionStorageB,
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Part 1: Durable logout where Tab A removes sdkKey, writes pending,
      // nudges Tab B via BroadcastChannel, holds lock, then dies mid-logout ->
      // open Tab B MUST promote to revocation_failed.
      const signOutPromise = tabA.signOut();
      await vi.waitFor(() => {
        expect(releaseLogout).not.toBeNull();
      });
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');
      });
      expect(fakeLocks.isHeld(`${lockKey}:1:tabA`)).toBe(true);
      expect(storage.getItem(sdkKey)).toBeNull();

      // Tab A crashes/closes mid-logout -> releases lock and stops heartbeating.
      tabA.resetAuthStore({ clearStorage: false });
      releaseLogout!();
      await signOutPromise;

      // Once Tab A's owner lease goes stale (10s) and lock is acquired, Tab B promotes.
      await vi.advanceTimersByTimeAsync(10_500);
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: true,
      });
      expect(tabB.isAuthResolved()).toBe(true);

      // Part 2: Owner tab dies while sdkKey is STILL present -> open sibling
      // Tab C MUST promote to local_failed (renders retry-logout button).
      storage.setFull(false);
      storage.removeItem(coordKey);
      const session2 = server.issueSession();
      storage.setItem(sdkKey, JSON.stringify(session2));

      let releaseDeadOwnerLock!: () => void;
      const deadOwnerLock = fakeLocks.request(
        `${lockKey}:20:deadTab`,
        { mode: 'exclusive' },
        () =>
          new Promise<void>((resolve) => {
            releaseDeadOwnerLock = resolve;
          }),
      );
      await Promise.resolve();

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
      let listenerC: ((e: StorageEvent) => void) | null = null;
      const tabC = createAuthStore({
        getClient: () => clientC as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: (fn) => {
          listenerC = fn;
          return () => {
            listenerC = null;
          };
        },
        getLocks: () => fakeLocks,
        tabId: 'tabC',
        syncGlobalStores: false,
      });
      try {
        tabC.startAuth();
        await vi.waitFor(() => {
          expect(tabC.getAuthSnapshot().status).toBe('owner');
        });

        const pendingJson = JSON.stringify({
          attemptId: 20,
          ownerTabId: 'deadTab',
          state: 'pending',
          sessionKey: `sid:sid-2`,
        });
        storage.setItem(coordKey, pendingJson);
        const invokeC = listenerC as ((e: StorageEvent) => void) | null;
        invokeC?.(
          new StorageEvent('storage', { key: coordKey, newValue: pendingJson }),
        );
        expect(tabC.getAuthSnapshot().logoutPhase).toBe('signing_out');

        // Dead tab drops the lock while sdkKey is still in storage.
        releaseDeadOwnerLock();
        await deadOwnerLock;
        await vi.waitFor(() => {
          expect(tabC.getAuthSnapshot().logoutPhase).toBe('local_failed');
        });
        expect(tabC.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'local_failed',
          logoutFailed: true,
          logoutPending: false,
        });
      } finally {
        await clientC.auth.stopAutoRefresh();
        tabC.resetAuthStore({ clearStorage: false });
      }
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('NEW-2(a+b): post-accept signIn rollback writes pending + acquires lock before revocation, survives reload, and prevents attemptId collision with sibling signOut', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://new-2-rollback-lock-coord.test';
    const sdkKey = 'sb-new-2-rollback-lock-coord-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const fakeLocks = createFakeLockManager();
    const values = new Map<string, string>();
    const storageListeners = new Map<string, Set<(e: StorageEvent) => void>>();
    const makeTabStorage = (who: string): Storage => ({
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
        const oldValue = values.get(k) ?? null;
        if (!values.delete(k)) return;
        for (const [t, set] of storageListeners) {
          if (t === who) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: null,
          });
          for (const fn of [...set]) fn(ev);
        }
      },
      setItem(k: string, v: string) {
        const oldValue = values.get(k) ?? null;
        values.set(k, String(v));
        for (const [t, set] of storageListeners) {
          if (t === who) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: String(v),
          });
          for (const fn of [...set]) fn(ev);
        }
      },
    });
    const addListener = (who: string, fn: (e: StorageEvent) => void) => {
      const set = storageListeners.get(who) ?? new Set();
      set.add(fn);
      storageListeners.set(who, set);
      return () => set.delete(fn);
    };

    const storageA = makeTabStorage('tabA');
    const storageB = makeTabStorage('tabB');
    const server = createStatefulAuthServer();

    let releaseTabARollbackLogout: ((res: Response) => void) | null = null;
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
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      if (href.includes('/auth/v1/logout')) {
        return new Promise<Response>((resolve) => {
          releaseTabARollbackLogout = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const fetchB: typeof fetch = (input, init) => {
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

    const clientA = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageA,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchA },
    });
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageB,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchB },
    });
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: (fn) => addListener('tabA', fn),
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: (fn) => addListener('tabB', fn),
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('signed-out');
        expect(tabB.getAuthSnapshot().status).toBe('signed-out');
      });

      let injectedConcurrentPending = false;
      let throwOnceAfterSignedInCoord = true;
      const unsub = tabA.subscribeAuth(() => {
        const currentCoord = JSON.parse(values.get(coordKey) ?? 'null') as {
          state?: string;
        } | null;
        if (
          !injectedConcurrentPending &&
          tabA.getAuthSnapshot().status === 'checking' &&
          currentCoord === null
        ) {
          injectedConcurrentPending = true;
          const pendingPayload = JSON.stringify({
            attemptId: 1,
            ownerTabId: 'tabC',
            state: 'pending',
            sessionKey: null,
          });
          values.set(coordKey, pendingPayload);
          for (const fn of [...(storageListeners.get('tabA') ?? [])]) {
            fn(
              new StorageEvent('storage', {
                key: coordKey,
                oldValue: null,
                newValue: pendingPayload,
              }),
            );
          }
          return;
        }
        if (
          throwOnceAfterSignedInCoord &&
          currentCoord?.state === 'signed_in'
        ) {
          throwOnceAfterSignedInCoord = false;
          const persisted = JSON.parse(values.get(sdkKey) ?? 'null') as unknown;
          const internalsB = clientB.auth as unknown as {
            _notifyAllSubscribers: (
              event: string,
              session: unknown,
              broadcast?: boolean,
            ) => Promise<void>;
          };
          void internalsB._notifyAllSubscribers('SIGNED_IN', persisted, false);
          throw new Error('post-accept subscriber boom');
        }
      });

      const signInPromise = tabA.signIn(
        'owner@example.test',
        'ValidPassword123',
      );
      await vi.waitFor(() => {
        expect(releaseTabARollbackLogout).not.toBeNull();
      });
      unsub();
      await vi.advanceTimersByTimeAsync(10);

      // While rollback /logout is in flight:
      // (a) coordKey MUST already be 'pending' (attemptId=3), lock MUST be held
      //     by tabA's attempt, sdkKey removed, and sibling Tab B MUST already
      //     be signed-out/signing_out!
      const rollbackLockKey = `${lockKey}:3:tabA`;
      expect(values.get(sdkKey)).toBeUndefined();
      expect(fakeLocks.isHeld(rollbackLockKey)).toBe(true);
      const rollbackLockHolder = fakeLocks.getHolderId(rollbackLockKey);
      expect(rollbackLockHolder).not.toBeNull();
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 3,
        ownerTabId: 'tabA',
        state: 'pending',
      });
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'signing_out',
        });
      });

      // (b) Concurrent sibling signOut gets attemptId=4 (no collision with 3).
      //     Because Tab A persisted pending(3) synchronously before removing
      //     sdkKey, Tab B retained session1 when locked by pending(3), so Tab B's
      //     signOut genuinely revokes session1 on the server (HTTP 204, I2) and
      //     commits completed(4).
      await tabB.signOut();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 4,
        ownerTabId: 'tabB',
        state: 'completed',
      });
      expect(fakeLocks.getHolderId(rollbackLockKey)).toBe(rollbackLockHolder);

      releaseTabARollbackLogout!(
        new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
      expect(await signInPromise).toBe('failed');
      await vi.advanceTimersByTimeAsync(20);

      // Tab A's delayed 503 for attempt 3 must not regress the coord from
      // attempt 4 (completed), and both tabs converge cleanly to idle (I2/I3/I4).
      expect(fakeLocks.isHeld(rollbackLockKey)).toBe(false);
      expect(fakeLocks.hasAnyHeld(lockKey)).toBe(false);
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 4,
        ownerTabId: 'tabB',
        state: 'completed',
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('NEW-2(c): pre-accept signIn throw does NOT delete or revoke another tab session even before signed_in coord is written', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://new-2c-pre-coord-race.test';
    const sdkKey = 'sb-new-2c-pre-coord-race-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let throwQuotaForTabA = false;
    const makeTabStorage = (who: 'A' | 'B'): Storage => ({
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
        if (who === 'A' && throwQuotaForTabA && k === sdkKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    });
    const storageA = makeTabStorage('A');
    const storageB = makeTabStorage('B');
    const server = createStatefulAuthServer();

    let releaseTabASignIn: (() => void) | null = null;
    const fetchA: typeof fetch = (input, init) => {
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
          releaseTabASignIn = () => resolve(server.handlePasswordSignIn());
        });
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const clientA = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageA,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchA },
    });
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageB,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchA },
    });
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('signed-out');
        expect(tabB.getAuthSnapshot().status).toBe('signed-out');
      });

      const signInAPromise = tabA.signIn(
        'owner@example.test',
        'ValidPassword123',
      );
      await vi.waitFor(() => {
        expect(releaseTabASignIn).not.toBeNull();
      });

      // Tab B writes sessionB to sdkKey and broadcasts SIGNED_IN BEFORE coordKey
      // has any signed_in record!
      const sessionB = server.issueSession();
      storageB.setItem(sdkKey, JSON.stringify(sessionB));
      const internalsB = clientB.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsB._notifyAllSubscribers('SIGNED_IN', sessionB, true);
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });
      expect(values.get(coordKey)).toBeUndefined();

      // Tab A's own signInWithPassword now throws QuotaExceededError pre-accept!
      throwQuotaForTabA = true;
      releaseTabASignIn!();
      expect(await signInAPromise).toBe('failed');
      await Promise.resolve();

      // I3: Tab B's session MUST survive in storage and remain unrevoked!
      expect(
        (
          JSON.parse(values.get(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sessionB.access_token);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
      expect(tabB.getAuthSnapshot().status).toBe('owner');
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('NEW-3: true 0-byte quota after normal signIn (stale signed_in coord) still signs out frozen sibling tab on refocus and clears stale signed_in coord', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://new-3-zero-byte-signedin.test';
    const sdkKey = 'sb-new-3-zero-byte-signedin-auth-token';
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
    const clientB = createClient(url, TEST_ANON_KEY, {
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      expect(await tabA.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
      const signedInCoordRaw = storage.getItem(coordKey);
      expect(JSON.parse(signedInCoordRaw ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'signed_in',
      });

      // True 0-byte quota: even overwriting existing coordKey throws QuotaExceededError!
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      storage.setZeroByteQuota(true);

      await tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      // DELTA 15 Rule A: coordKey is never removed on quota failure, so stale
      // signed_in stays in localStorage; saved credentials (sdkKey gone) still
      // sign out the frozen sibling tab on refocus.
      expect(storage.getItem(coordKey)).toBe(signedInCoordRaw);

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
      });
      expect(tabB.isAuthResolved()).toBe(true);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  it('NEW-4: signOut skippedNewerSession race after pending write resets phase to idle, clears dangling pending coord, and lets reload boot cleanly on newer session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://new-4-skip-race.test';
    const sdkKey = 'sb-new-4-skip-race-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const fakeLocks = createFakeLockManager();
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
          // Simulate a concurrent tab writing session2 right after pending was written!
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tab-new-4',
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
      await Promise.resolve();

      // Must NOT strand in signing_out, must overwrite dangling pending with
      // signed_in for session2 (Rule A: never delete coordKey), and keep session2.
      expect(
        (
          JSON.parse(values.get(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(session2.access_token);
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'signed_in',
        sessionKey: 'sid:sid-2',
      });
      expect(fakeLocks.hasAnyHeld(lockKey)).toBe(false);
      expect(store.getAuthSnapshot()).toMatchObject({
        logoutPhase: 'idle',
        logoutPending: false,
        logoutFailed: false,
      });
      expect(store.isAuthResolved()).toBe(true);

      // Reloading MUST boot cleanly as owner on session2 (NOT local_failed!).
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
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: () => () => {},
        getLocks: () => fakeLocks,
        tabId: 'tab-new-4-reload',
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tab-new-5',
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

  it('DELTA3-P1-1: signOut locks local state and removes sdkKey synchronously before awaiting Web Lock, scopes lock by ownerTabId, and prevents concurrent sign-out from regressing completed to revocation_failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta3-p1-1-sync-lock.test';
    const sdkKey = 'sb-delta3-p1-1-sync-lock-auth-token';
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    const session1 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(session1));

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
    let releaseLockA!: () => void;
    const lockAGate = new Promise<void>((resolve) => {
      releaseLockA = resolve;
    });
    const locksA = {
      request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        return lockAGate.then(() => fakeLocks.request(name, options, callback));
      },
    };
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => locksA,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    // Part B setup: quota-full concurrent sign-out on same attemptId=1.
    const urlB = 'https://delta3-p1-1-quota-concurrent.test';
    const sdkKeyB = 'sb-delta3-p1-1-quota-concurrent-auth-token';
    const storageB = makeMemoryStorage();
    const serverB = createStatefulAuthServer();
    const session2 = serverB.issueSession();
    storageB.setItem(sdkKeyB, JSON.stringify(session2));
    let logoutCallsB = 0;
    const fetchFnB: typeof fetch = (input, init) => {
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
        logoutCallsB += 1;
        return Promise.resolve(
          serverB.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const locksC = createFakeLockManager();
    let releaseLockD!: () => void;
    const lockDGate = new Promise<void>((resolve) => {
      releaseLockD = resolve;
    });
    const locksD = {
      request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        return lockDGate.then(() => locksC.request(name, options, callback));
      },
    };
    const clientC = createClient(urlB, TEST_ANON_KEY, {
      auth: {
        storage: storageB,
        storageKey: sdkKeyB,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFnB },
    });
    const clientD = createClient(urlB, TEST_ANON_KEY, {
      auth: {
        storage: storageB,
        storageKey: sdkKeyB,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFnB },
    });
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => urlB,
      getStorage: () => storageB,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => locksC,
      tabId: 'tabC',
      syncGlobalStores: false,
    });
    const tabD = createAuthStore({
      getClient: () => clientD as never,
      getProjectUrl: () => urlB,
      getStorage: () => storageB,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => locksD,
      tabId: 'tabD',
      syncGlobalStores: false,
    });

    let releaseFrozenSibling!: () => void;
    const frozenSiblingLock = fakeLocks.request(
      `${lockKey}:1:tabFrozen`,
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseFrozenSibling = resolve;
        }),
    );

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // Part A: Call signOut() synchronously while tabFrozen holds attemptId=1's lock.
      const signOutA = tabA.signOut();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'signing_out',
        logoutPending: true,
      });
      expect(tabA.isAuthResolved()).toBe(false);
      expect(storage.getItem(sdkKey)).toBeNull();

      // Same-session refocus SIGNED_IN before lock grant must NOT reopen owner/checking.
      const internalsA = clientA.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsA._notifyAllSubscribers('SIGNED_IN', session1, false);
      expect(tabA.getAuthSnapshot().status).toBe('signed-out');
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Per-tab lock key lets tabA complete even while tabFrozen holds :1:tabFrozen.
      releaseLockA();
      await signOutA;
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      expect(fakeLocks.isHeld(`${lockKey}:1:tabA`)).toBe(false);

      // Part B: Concurrent sign-out where Tab C completes before Tab D's lock is granted.
      tabC.startAuth();
      tabD.startAuth();
      await vi.waitFor(() => {
        expect(tabC.getAuthSnapshot().status).toBe('owner');
        expect(tabD.getAuthSnapshot().status).toBe('owner');
      });

      const signOutC = tabC.signOut();
      const signOutD = tabD.signOut();
      await signOutC;
      expect(tabC.getAuthSnapshot().logoutPhase).toBe('idle');
      expect(tabD.getAuthSnapshot().logoutPhase).toBe('idle');

      releaseLockD();
      await signOutD;
      await vi.advanceTimersByTimeAsync(20);

      expect(serverB.getConfirmedGlobalLogouts()).toBe(1);
      expect(logoutCallsB).toBeGreaterThanOrEqual(1);
      expect(tabC.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      expect(tabD.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      releaseFrozenSibling();
      await frozenSiblingLock;
      await clientA.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      await clientD.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
      tabD.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA3-P1-2: promoteAbandonedPending promotes in-place at coord.attemptId so delayed completed(1) heals sibling without regressing already-completed tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta3-p1-2-inplace-promote.test';
    const sdkKey = 'sb-delta3-p1-2-inplace-promote-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let blockHeartbeats = false;
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
        if (blockHeartbeats && k === coordKey) {
          const parsed = JSON.parse(v) as { state?: string };
          if (parsed.state === 'pending') {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
          }
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();
    const session1 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(session1));

    let releaseLogout: (() => void) | null = null;
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
          releaseLogout = () =>
            resolve(server.handleLogout(headers.get('authorization')));
        });
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
    const clientB = createClient(url, TEST_ANON_KEY, {
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(releaseLogout).not.toBeNull();
      });

      // Backdate pending(1)'s heartbeatAt by 2s and pause heartbeat writes BEFORE
      // Tab B observes pending(1), so Tab B promotes pending(1) in-place to
      // revocation_failed(1) at t=8.5s while Tab A's slow /logout is still within
      // its 10s request timeout.
      const pendingRaw = JSON.parse(storage.getItem(coordKey) ?? 'null') as {
        attemptId: number;
        ownerTabId: string;
        state: string;
        sessionKey: string | null;
        heartbeatAt?: number;
      };
      values.set(
        coordKey,
        JSON.stringify({
          ...pendingRaw,
          heartbeatAt: (pendingRaw.heartbeatAt ?? Date.now()) - 2_000,
        }),
      );
      blockHeartbeats = true;

      tabB.startAuth();
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Advance 8.5s so Tab B sees stale lease (10s) and promotes in-place at attemptId=1.
      await vi.advanceTimersByTimeAsync(8_500);
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'revocation_failed',
      });

      // Tab A's delayed 204 resolves: because Tab B promoted in-place at attemptId=1
      // for the same sessionKey, Tab A writes completed, stays idle, and heals Tab B!
      blockHeartbeats = false;
      releaseLogout!();
      await signOutA;
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        state: 'completed',
        sessionKey: 'sid:sid-1',
      });
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'idle',
          logoutRevocationFailed: false,
        });
      });
      expect(tabB.isAuthResolved()).toBe(true);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA3-P1-3: multi-tab skippedNewerSession unblocks sibling tab from signing_out under both normal storage and quota-full', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const runScenario = async (quotaFull: boolean, suffix: string) => {
      const url = `https://delta3-p1-3-${suffix}.test`;
      const sdkKey = `sb-delta3-p1-3-${suffix}-auth-token`;
      const coordKey = getLogoutCoordStorageKey(url);
      const fakeLocks = createFakeLockManager();
      const server = createStatefulAuthServer();
      const session1 = server.issueSession();
      const session2 = server.issueSession();
      const values = new Map<string, string>();
      values.set(sdkKey, JSON.stringify(session1));

      const listenersC: Array<(e: StorageEvent) => void> = [];
      let injectOnPending = false;
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
          const oldValue = values.get(k) ?? null;
          values.delete(k);
          if (k === coordKey) {
            for (const fn of [...listenersC]) {
              fn(
                new StorageEvent('storage', {
                  key: k,
                  oldValue,
                  newValue: null,
                }),
              );
            }
          }
        },
        setItem(k: string, v: string) {
          if (k === coordKey && injectOnPending) {
            injectOnPending = false;
            values.set(sdkKey, JSON.stringify(session2));
            if (quotaFull) {
              throw new DOMException(
                'QuotaExceededError',
                'QuotaExceededError',
              );
            }
            values.set(k, String(v));
            for (const fn of [...listenersC]) {
              fn(
                new StorageEvent('storage', {
                  key: k,
                  oldValue: null,
                  newValue: String(v),
                }),
              );
            }
            return;
          }
          if (quotaFull && k === coordKey) {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
          }
          values.set(k, String(v));
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
      const sessionStorageC = makeMemoryStorage();
      const tabA = createAuthStore({
        getClient: () => clientA as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: () => () => {},
        getLocks: () => fakeLocks,
        tabId: 'tabA',
        syncGlobalStores: false,
      });
      const tabC = createAuthStore({
        getClient: () => clientC as never,
        getProjectUrl: () => url,
        getStorage: () => storage,
        getSessionStorage: () => sessionStorageC,
        addStorageListener: (fn) => {
          listenersC.push(fn);
          return () => {
            const idx = listenersC.indexOf(fn);
            if (idx >= 0) listenersC.splice(idx, 1);
          };
        },
        getLocks: () => fakeLocks,
        tabId: 'tabC',
        syncGlobalStores: false,
      });

      try {
        tabA.startAuth();
        tabC.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('owner');
          expect(tabC.getAuthSnapshot().status).toBe('owner');
        });

        injectOnPending = true;
        await tabA.signOut();
        await vi.advanceTimersByTimeAsync(20);

        expect(
          (
            JSON.parse(values.get(sdkKey) ?? 'null') as {
              access_token?: string;
            } | null
          )?.access_token,
        ).toBe(session2.access_token);
        expect(tabA.getAuthSnapshot().logoutPhase).toBe('idle');
        expect(tabC.getAuthSnapshot().logoutPhase).toBe('idle');
        expect(tabC.isAuthResolved()).toBe(true);
        expect(sessionStorageC.getItem(coordKey)).toBeNull();
      } finally {
        await clientA.auth.stopAutoRefresh();
        await clientC.auth.stopAutoRefresh();
        tabA.resetAuthStore({ clearStorage: false });
        tabC.resetAuthStore({ clearStorage: false });
      }
    };

    try {
      await runScenario(false, 'normal');
      await runScenario(true, 'quota');
    } finally {
      hub.closeAll();
    }
  });

  it('DELTA3-P1-4: no-locks slow logout aborts via AbortSignal before 15s fallback so fresh sign-in is not revoked, and retryLogoutRevocation coalesces with in-flight signOut', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta3-p1-4-abort-timeout.test';
    const sdkKey = 'sb-delta3-p1-4-abort-timeout-auth-token';
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const session1 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(session1));

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
    const clientB = createClient(url, TEST_ANON_KEY, {
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(logoutCalls).toBe(1);
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');
      });

      // Clicking retryLogoutRevocation while signOut is in flight MUST coalesce.
      const coalescedRetry = tabA.retryLogoutRevocation();
      expect(logoutCalls).toBe(1);

      // Advance past 10s request timeout (strictly before 15s fallback timer).
      await vi.advanceTimersByTimeAsync(10_500);
      await signOutA;
      await coalescedRetry;

      expect(capturedLogoutSignal?.aborted).toBe(true);
      expect(logoutCalls).toBe(1);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: true,
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
      });

      // Fresh sign-in on Tab B succeeds and is never revoked by the aborted logout.
      expect(await tabB.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tabB.getAuthSnapshot().status).toBe('owner');
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA3-P2-1: stale attempt-1 lock watcher releasing after attempt-2 starts does not clear attempt-2 watch state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta3-p2-1-watcher-clobber.test';
    const sdkKey = 'sb-delta3-p2-1-watcher-clobber-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let storageListenerC: ((e: StorageEvent) => void) | null = null;
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: (fn) => {
        storageListenerC = fn;
        return () => {
          storageListenerC = null;
        };
      },
      getLocks: () => fakeLocks,
      tabId: 'tabC',
      syncGlobalStores: false,
    });

    let releaseLock1!: () => void;
    let releaseLock2!: () => void;
    const lock1 = fakeLocks.request(
      `${lockKey}:1:tabA`,
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseLock1 = resolve;
        }),
    );
    const lock2 = fakeLocks.request(
      `${lockKey}:2:tabB`,
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseLock2 = resolve;
        }),
    );
    await Promise.resolve();

    try {
      tabC.startAuth();
      await vi.waitFor(() => {
        expect(tabC.getAuthSnapshot().status).toBe('owner');
      });

      const pending1 = JSON.stringify({
        attemptId: 1,
        ownerTabId: 'tabA',
        state: 'pending',
        sessionKey: 'sid:sid-1',
      });
      storage.setItem(coordKey, pending1);
      const notifyC = storageListenerC as ((e: StorageEvent) => void) | null;
      notifyC?.(
        new StorageEvent('storage', { key: coordKey, newValue: pending1 }),
      );
      await Promise.resolve();
      expect(tabC.getAuthSnapshot().logoutPhase).toBe('signing_out');

      const pending2 = JSON.stringify({
        attemptId: 2,
        ownerTabId: 'tabB',
        state: 'pending',
        sessionKey: 'sid:sid-1',
      });
      storage.setItem(coordKey, pending2);
      notifyC?.(
        new StorageEvent('storage', { key: coordKey, newValue: pending2 }),
      );
      await Promise.resolve();
      expect(tabC.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Attempt 1 releases its lock while attempt 2 is live -> must NOT promote
      // and must NOT wipe attempt 2's watcher!
      releaseLock1();
      await lock1;
      await vi.advanceTimersByTimeAsync(20);
      expect(tabC.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Now attempt 2's owner crashes after removing sdkKey -> attempt 2 watcher promotes!
      storage.removeItem(sdkKey);
      releaseLock2();
      await lock2;
      await vi.waitFor(() => {
        expect(tabC.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });
      expect(tabC.isAuthResolved()).toBe(true);
    } finally {
      releaseLock1();
      releaseLock2();
      await Promise.all([lock1, lock2]);
      await clientC.auth.stopAutoRefresh();
      tabC.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA3-P2-2: superseded commitLogoutResult retains freshly rotated refresh token after 503 so retryLogoutRevocation succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta3-p2-2-rotated-retain.test';
    const sdkKey = 'sb-delta3-p2-2-rotated-retain-auth-token';
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    // Issue with a full 3600s TTL so GoTrueClient boot (_recoverAndRefresh,
    // 90s expiry margin) does NOT refresh on startAuth; we advance the clock
    // past expiry right before signOut so revokeSessionGlobally performs the
    // single refresh rotation rt-sid-1-0 -> { at2, rt2 }.
    const session1 = server.issueSession({ expiresInSec: 3600 });
    storage.setItem(sdkKey, JSON.stringify(session1));

    let refreshCount = 0;
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
      if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
        refreshCount += 1;
        return Promise.resolve(
          server.handleRefresh(
            typeof init?.body === 'string' ? init.body : null,
          ),
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
    const clientB = createClient(url, TEST_ANON_KEY, {
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
      expect(refreshCount).toBe(0);

      // Expire session1 right before signOut so revokeSessionGlobally must
      // rotate rt-sid-1-0 -> { at2, rt2 } before calling POST /logout.
      vi.setSystemTime(Date.now() + 3_610_000);

      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(refreshCount).toBe(1);
        expect(releaseFirstLogout).not.toBeNull();
      });

      // Concurrent Tab B (no token since sdkKey was removed) supersedes attempt 1
      // with revocation_failed(2).
      await tabB.signOut();
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');

      // Tab A's first /logout fails with 503 after rotating the refresh token.
      releaseFirstLogout!(
        new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await signOutA;
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: true,
      });

      // Retry MUST use the retained rotated access token directly (0 additional
      // refreshes — never retrying the consumed rt1) and succeed!
      const refreshesBeforeRetry = refreshCount;
      await tabA.retryLogoutRevocation();
      expect(lastLogoutAuth).not.toBe(`Bearer ${session1.access_token}`);
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(refreshCount).toBe(refreshesBeforeRetry);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA3-P3-1: reconcileFromShared case signed_in immediately signs out on first refocus when persisted SDK credentials are already absent', async () => {
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta3-p3-1-signed-in-missing-creds.test';
    const sdkKey = 'sb-delta3-p3-1-signed-in-missing-creds-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let visibilityCallback: (() => void) | null = null;
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

    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      addVisibilityListener: (fn) => {
        visibilityCallback = fn;
        return () => {
          visibilityCallback = null;
        };
      },
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // While Tab B is hidden, another tab wrote signed_in(1) and then signed out
      // under 0-byte quota leaving stale signed_in(1) in coordKey and sdkKey absent.
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          ownerTabId: 'tabA',
          state: 'signed_in',
          sessionKey: 'sid:sid-1',
        }),
      );
      storage.removeItem(sdkKey);

      // On Tab B's VERY FIRST refocus, it must transition immediately to signed-out.
      const triggerVisibility = visibilityCallback as (() => void) | null;
      triggerVisibility?.();
      expect(tabB.getAuthSnapshot().status).toBe('signed-out');
    } finally {
      await clientB.auth.stopAutoRefresh();
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA3-P3-2: signIn catch does not roll back another tab session when subscriber threw a different error than the error caught from signInWithPassword', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta3-p3-2-different-error.test';
    const sdkKey = 'sb-delta3-p3-2-different-error-auth-token';
    const values = new Map<string, string>();
    let throwQuotaForTabA = false;
    const storageA: Storage = {
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
        if (throwQuotaForTabA && k === sdkKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };
    const server = createStatefulAuthServer();

    let releaseTabASignIn: (() => void) | null = null;
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
          releaseTabASignIn = () => resolve(server.handlePasswordSignIn());
        });
      }
      if (href.includes('/auth/v1/logout')) {
        return Promise.resolve(
          server.handleLogout(headers.get('authorization')),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const clientA = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage: storageA,
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
      getStorage: () => storageA,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      const signInPromise = tabA.signIn(
        'owner@example.test',
        'ValidPassword123',
      );
      await vi.waitFor(() => {
        expect(releaseTabASignIn).not.toBeNull();
      });

      // While Tab A has signInInProgress=true, another tab writes sessionB to sdkKey
      // (before writing signed_in coord) and broadcasts SIGNED_IN(sessionB), causing
      // a subscriber in Tab A to throw a DIFFERENT error than Tab A's own QuotaExceededError.
      const sessionB = server.issueSession();
      values.set(sdkKey, JSON.stringify(sessionB));
      let throwOnce = true;
      const unsub = tabA.subscribeAuth(() => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('subscriber-error-on-tabB-session');
        }
      });
      const internalsA = clientA.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsA
        ._notifyAllSubscribers('SIGNED_IN', sessionB, false)
        .catch(() => {});
      unsub();

      // Now Tab A's own signInWithPassword fails with a different error (QuotaExceededError).
      throwQuotaForTabA = true;
      releaseTabASignIn!();
      expect(await signInPromise).toBe('failed');

      // Tab A MUST NOT delete or globally revoke Tab B's sessionB!
      expect(
        (
          JSON.parse(values.get(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sessionB.access_token);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
    } finally {
      await clientA.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA6-P1-1: writeSharedCoord lost write race does not advance knownSeq/knownStateRank before reconcileFromShared, preventing signing_out deadlock under normal localStorage', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');

    // Scenario A: Tab B loses write race to Tab A's completed(1) in localStorage ->
    // MUST transition cleanly to idle (NOT deadlock in signing_out).
    const runRace = async (
      winnerState: 'completed' | 'pending',
      suffix: string,
    ) => {
      const url = `https://delta6-p1-1-${suffix}.test`;
      const sdkKey = `sb-delta6-p1-1-${suffix}-auth-token`;
      const coordKey = getLogoutCoordStorageKey(url);
      const fakeLocks = createFakeLockManager();
      const server = createStatefulAuthServer();
      const session1 = server.issueSession();
      const values = new Map<string, string>();
      values.set(sdkKey, JSON.stringify(session1));

      // Inject winner record into localStorage right when Tab B's writeSharedCoord
      // checks existing (after nextAttemptId already read coordKey=null and computed attemptId=1).
      let coordReadsDuringSignOut = 0;
      let injectOnWriteCheck = false;
      const storageB: Storage = {
        get length() {
          return values.size;
        },
        clear() {
          values.clear();
        },
        getItem(k: string) {
          if (k === coordKey && injectOnWriteCheck) {
            coordReadsDuringSignOut += 1;
            // Read 1: reconcileFromShared in signOut(); Read 2: nextAttemptId();
            // Read 3: writeSharedCoord() existing check!
            if (coordReadsDuringSignOut === 3) {
              injectOnWriteCheck = false;
              values.delete(sdkKey);
              values.set(
                coordKey,
                JSON.stringify({
                  attemptId: 1,
                  ownerTabId: 'tabA',
                  state: winnerState,
                  sessionKey: 'sid:sid-1',
                  ...(winnerState === 'pending'
                    ? { heartbeatAt: Date.now() }
                    : {}),
                }),
              );
            }
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

      const clientB = createClient(url, TEST_ANON_KEY, {
        auth: {
          storage: storageB,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: { fetch: fetchFn },
      });
      const tabB = createAuthStore({
        getClient: () => clientB as never,
        getProjectUrl: () => url,
        getStorage: () => storageB,
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: () => () => {},
        getLocks: () => fakeLocks,
        tabId: 'tabB',
        syncGlobalStores: false,
      });

      try {
        tabB.startAuth();
        await vi.waitFor(() => {
          expect(tabB.getAuthSnapshot().status).toBe('owner');
        });

        injectOnWriteCheck = true;
        await tabB.signOut();

        if (winnerState === 'completed') {
          expect(tabB.getAuthSnapshot()).toMatchObject({
            status: 'signed-out',
            logoutPhase: 'idle',
            logoutPending: false,
            logoutRevocationFailed: false,
          });
          expect(tabB.isAuthResolved()).toBe(true);
        } else {
          // Tab B MUST have entered case 'pending' and armed abandonment watch.
          expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');
          // Tab A crashed (no heartbeats, lock free) -> after 10s lease expires,
          // Tab B promotes to revocation_failed instead of deadlocking forever.
          await vi.advanceTimersByTimeAsync(10_500);
          await vi.waitFor(() => {
            expect(tabB.getAuthSnapshot().logoutPhase).toBe(
              'revocation_failed',
            );
          });
          expect(tabB.isAuthResolved()).toBe(true);
        }
      } finally {
        await clientB.auth.stopAutoRefresh();
        tabB.resetAuthStore({ clearStorage: false });
      }
    };

    await runRace('completed', 'completed');
    await runRace('pending', 'pending');
  });

  it('DELTA6-P1-2: signOut persists pending synchronously BEFORE removing sdkKey and without awaiting Web Lock so reload never boots as owner (I1) or silent idle (I2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');

    // Part A: normal removeItem(sdkKey) succeeds while Web Lock grant is delayed.
    const urlA = 'https://delta6-p1-2-normal.test';
    const sdkKeyA = 'sb-delta6-p1-2-normal-auth-token';
    const coordKeyA = getLogoutCoordStorageKey(urlA);
    const serverA = createStatefulAuthServer();
    const sessionA = serverA.issueSession();
    const valuesA = new Map<string, string>([
      [sdkKeyA, JSON.stringify(sessionA)],
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
    const neverGrantingLocks = {
      request<T>(): Promise<T> {
        return new Promise<T>(() => {});
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => neverGrantingLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    // Part B: removeItem(sdkKey) throws while setItem(coordKey) succeeds and lock grant is delayed.
    const urlB = 'https://delta6-p1-2-remove-fail.test';
    const sdkKeyB = 'sb-delta6-p1-2-remove-fail-auth-token';
    const coordKeyB = getLogoutCoordStorageKey(urlB);
    const serverB = createStatefulAuthServer();
    const sessionB = serverB.issueSession();
    const valuesB = new Map<string, string>([
      [sdkKeyB, JSON.stringify(sessionB)],
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => neverGrantingLocks,
      tabId: 'tabB',
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
      const pendingRecordA = JSON.parse(valuesA.get(coordKeyA) ?? 'null') as {
        attemptId?: number;
        ownerTabId?: string;
        state?: string;
        heartbeatAt?: number;
      } | null;
      expect(pendingRecordA).toMatchObject({
        attemptId: 1,
        ownerTabId: 'tabA',
        state: 'pending',
      });
      expect(typeof pendingRecordA?.heartbeatAt).toBe('number');

      // Immediate reload during delayed lock grant MUST NOT boot to silent idle (I2).
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
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: () => () => {},
        getLocks: () => createFakeLockManager(),
        tabId: 'tabA-reloaded',
        syncGlobalStores: false,
      });
      reloadedTabA.startAuth();
      expect(reloadedTabA.getAuthSnapshot().logoutPhase).toBe('signing_out');
      await vi.advanceTimersByTimeAsync(10_500);
      await vi.waitFor(() => {
        expect(reloadedTabA!.getAuthSnapshot().logoutPhase).toBe(
          'revocation_failed',
        );
      });

      // Part B: removeItem(sdkKey) fails -> reload MUST boot to local_failed, NEVER owner (I1).
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
        getSessionStorage: () => makeMemoryStorage(),
        addStorageListener: () => () => {},
        getLocks: () => createFakeLockManager(),
        tabId: 'tabB-reloaded',
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

  it('DELTA6-P2-1: startAuth watching pending promotes to local_failed instead of deadlocking in signing_out if a stale refresh writes the same session back before abandonment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta6-p2-1-stale-refresh-return.test';
    const sdkKey = 'sb-delta6-p2-1-stale-refresh-return-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    const session1 = server.issueSession();

    // Pending coord with sdkKey absent and owner tab holding the attempt lock.
    storage.setItem(
      coordKey,
      JSON.stringify({
        attemptId: 1,
        ownerTabId: 'tabA',
        state: 'pending',
        sessionKey: 'sid:sid-1',
      }),
    );
    let releaseOwnerLock!: () => void;
    const ownerLock = fakeLocks.request(
      `${lockKey}:1:tabA`,
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseOwnerLock = resolve;
        }),
    );
    await Promise.resolve();

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

    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabB.startAuth();
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'signing_out',
      });

      // Late _callRefreshToken writes the SAME session (sid-1) back to sdkKey,
      // then owner Tab A crashes and releases lock :1:tabA.
      storage.setItem(sdkKey, JSON.stringify(session1));
      releaseOwnerLock();
      await ownerLock;

      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('local_failed');
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
        logoutPending: false,
      });
    } finally {
      releaseOwnerLock();
      await ownerLock;
      await clientB.auth.stopAutoRefresh();
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA6-P2-2: reconcileFromShared clears stale retainedRevocationSession on newer session coord, and retryLogoutRevocation requires logoutPhase === revocation_failed and matching sessionKey', async () => {
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta6-p2-2-cross-user-retry.test';
    const sdkKey = 'sb-delta6-p2-2-cross-user-retry-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const session1 = server.issueSession({
      userId: 'user-1',
      email: 'u1@example.test',
    });
    const session2 = server.issueSession({
      userId: 'user-2',
      email: 'u2@example.test',
    });
    storage.setItem(sdkKey, JSON.stringify(session1));

    let failLogout = true;
    let logoutCalls = 0;
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
    let triggerVisibility: (() => void) | null = null;
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      addVisibilityListener: (fn) => {
        triggerVisibility = fn;
        return () => {
          triggerVisibility = null;
        };
      },
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // User 1 fails global revocation -> Tab A retains session1.
      await tabA.signOut();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: true,
      });

      // Part A: While Tab A is hidden, User 2 signed in and failed revocation (sid-2).
      failLogout = false;
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 3,
          ownerTabId: 'tabB',
          state: 'revocation_failed',
          sessionKey: 'sid:sid-2',
        }),
      );
      const notifyVisible = triggerVisibility as (() => void) | null;
      notifyVisible?.();

      // Tab A MUST clear stale session1 so Retry is disabled and calling
      // retryLogoutRevocation() cannot clear User 2's revocation_failed!
      expect(tabA.getAuthSnapshot()).toMatchObject({
        logoutPhase: 'revocation_failed',
        canRetryLogoutRevocation: false,
      });
      const callsBeforeA = logoutCalls;
      await tabA.retryLogoutRevocation();
      expect(logoutCalls).toBe(callsBeforeA);
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 3,
        state: 'revocation_failed',
        sessionKey: 'sid:sid-2',
      });

      // Part B: Stale retryLogoutRevocation() over local_failed MUST NOT commit localOk:true.
      storage.setItem(sdkKey, JSON.stringify(session2));
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 4,
          ownerTabId: 'tabB',
          state: 'local_failed',
          sessionKey: 'sid:sid-2',
        }),
      );
      await tabA.retryLogoutRevocation();
      expect(logoutCalls).toBe(callsBeforeA);
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('local_failed');
      expect(storage.getItem(sdkKey)).not.toBeNull();
    } finally {
      await clientA.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA6-P3-1: synchronous throw from navigator.locks.request does not hang signOut or escape watchPendingLogoutForAbandonment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta6-p3-1-sync-throw-locks.test';
    const sdkKey = 'sb-delta6-p3-1-sync-throw-locks-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    const throwingLocks = {
      request<T>(): Promise<T> {
        throw new DOMException('SecurityError', 'SecurityError');
      },
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => throwingLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => throwingLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      // Part A: signOut completes cleanly even when locks.request throws synchronously.
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });
      await tabA.signOut();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });

      // Part B: watchPendingLogoutForAbandonment handles sync throw from locks.request
      // without escaping startAuth() and still promotes once lease is stale.
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 10,
          ownerTabId: 'deadTab',
          state: 'pending',
          sessionKey: 'sid:dead',
        }),
      );
      expect(() => tabB.startAuth()).not.toThrow();
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      expect(tabB.isAuthResolved()).toBe(true);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA6-P3-2: without navigator.locks, a newly opened tab respects the owner lease heartbeat and does not immediately promote a live in-flight logout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta6-p3-2-no-locks-lease.test';
    const sdkKey = 'sb-delta6-p3-2-no-locks-lease-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let releaseLogout: (() => void) | null = null;
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
          releaseLogout = () =>
            resolve(server.handleLogout(headers.get('authorization')));
        });
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
    const clientB = createClient(url, TEST_ANON_KEY, {
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(releaseLogout).not.toBeNull();
      });
      const initialHeartbeat = (
        JSON.parse(storage.getItem(coordKey) ?? 'null') as {
          heartbeatAt?: number;
        }
      ).heartbeatAt;
      expect(typeof initialHeartbeat).toBe('number');

      // At t = 1s, Tab B opens without navigator.locks -> MUST NOT immediately promote!
      await vi.advanceTimersByTimeAsync(1_000);
      tabB.startAuth();
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'signing_out',
        logoutRevocationFailed: false,
      });
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'pending',
      });

      // Advance to t = 6s: Tab A's 2s heartbeats refresh heartbeatAt so Tab B stays
      // in signing_out and never interrupts Tab A's live logout.
      await vi.advanceTimersByTimeAsync(5_000);
      const refreshedHeartbeat = (
        JSON.parse(storage.getItem(coordKey) ?? 'null') as {
          heartbeatAt?: number;
        }
      ).heartbeatAt;
      expect(refreshedHeartbeat).toBeGreaterThan(initialHeartbeat!);
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Tab A finishes (204) -> both tabs converge cleanly to idle.
      releaseLogout!();
      await signOutA;
      await vi.advanceTimersByTimeAsync(20);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA7-P2-1: backward wall-clock jump (including >24.85-day 32-bit setTimeout overflow) never deadlocks abandoned pending past PENDING_LEASE_TTL_MS', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta7-p2-1-clock-jump.test';
    const sdkKey = 'sb-delta7-p2-1-clock-jump-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

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
      if (href.includes('/auth/v1/logout')) {
        return new Promise<Response>(() => {});
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    const recordedDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (typeof timeout === 'number') {
          recordedDelays.push(timeout);
        }
        return origSetTimeout(handler, timeout, ...args);
      }) as typeof setTimeout);

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      const writeTime = Date.now();
      void tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'pending',
      });

      // Tab A crashes/reloads, releasing its lock.
      tabA.resetAuthStore({ clearStorage: false });

      // Step system wall-clock backward by 30 days (> 24.85-day 32-bit int32 max!).
      vi.setSystemTime(writeTime - 30 * 24 * 60 * 60 * 1000);
      recordedDelays.length = 0;

      tabB.startAuth();
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');
      // No timer delay may exceed PENDING_LEASE_TTL_MS (10_000 ms).
      expect(recordedDelays.length).toBeGreaterThan(0);
      expect(Math.max(...recordedDelays)).toBeLessThanOrEqual(10_000);

      // Even though wall-clock Date.now() is still ~30 days behind heartbeatAt,
      // local monotonic elapsed time bounds the wait to 10s!
      await vi.advanceTimersByTimeAsync(10_500);
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });
      expect(tabB.isAuthResolved()).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabA',
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

      // Simulate an in-flight _callRefreshToken() resolving 200 during signing_out,
      // rotating rt-sid-1-0 -> { at2, rt2 } and writing rotated session1' back to sdkKey.
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

      // Late rotated session MUST be evicted immediately during signing_out!
      expect(storage.getItem(sdkKey)).toBeNull();

      // Even if a silent storage write put rotatedSession back right before 503 commit,
      // commitLogoutResult MUST evict it before committing revocation_failed.
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

      // Clicking Retry MUST NOT be a no-op and MUST revoke using the rotated token!
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

  it('DELTA7-P3-1: tryPromoteAfterLock reconciles immediately when storage already advanced to completed(1) despite a fresher cached heartbeatAt', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta7-p3-1-completed-after-lock.test';
    const sdkKey = 'sb-delta7-p3-1-completed-after-lock-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();

    const startTime = Date.now();
    storage.setItem(
      coordKey,
      JSON.stringify({
        attemptId: 1,
        ownerTabId: 'tabA',
        state: 'pending',
        sessionKey: 'sid:sid-1',
        heartbeatAt: startTime,
      }),
    );
    let releaseOwnerLock!: () => void;
    const ownerLock = fakeLocks.request(
      `${lockKey}:1:tabA`,
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseOwnerLock = resolve;
        }),
    );
    await Promise.resolve();

    const fetchFn: typeof fetch = () =>
      Promise.resolve(new Response(null, { status: 404 }));
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    const senderChannel = new hub.BroadcastChannel(
      `theshark:auth:coord:v1:${encodeURIComponent(url)}`,
    );

    try {
      tabB.startAuth();
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Advance past 10s lease so Tab B queues a blocking wait on :1:tabA.
      await vi.advanceTimersByTimeAsync(10_500);
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Simulate throttled owner waking up: sends fresh heartbeat (updating Tab B's
      // cached pendingWatchedCoord.heartbeatAt), then writes completed(1) to storage
      // and releases :1:tabA before any StorageEvent/BroadcastChannel reaches Tab B.
      senderChannel.postMessage({
        attemptId: 1,
        ownerTabId: 'tabA',
        state: 'pending',
        sessionKey: 'sid:sid-1',
        heartbeatAt: Date.now(),
      });
      await Promise.resolve();
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          ownerTabId: 'tabA',
          state: 'completed',
          sessionKey: 'sid:sid-1',
        }),
      );

      releaseOwnerLock();
      await ownerLock;
      await Promise.resolve();
      await Promise.resolve();

      // Tab B MUST reconcile immediately to idle without waiting another 10s!
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      expect(tabB.isAuthResolved()).toBe(true);
    } finally {
      senderChannel.close();
      releaseOwnerLock();
      await ownerLock;
      await clientB.auth.stopAutoRefresh();
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA7-P3-2: refreshPendingLease stops broadcasting after storage supersedes pending, and repeated visibilitychange calls do not stack duplicate lock waiters', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta7-p3-2-lease-hygiene.test';
    const sdkKey = 'sb-delta7-p3-2-lease-hygiene-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let releaseLogout: (() => void) | null = null;
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
          releaseLogout = () =>
            resolve(server.handleLogout(headers.get('authorization')));
        });
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    const observedBroadcasts: Array<{ attemptId?: number; state?: string }> =
      [];
    const spyChannel = new hub.BroadcastChannel(
      `theshark:auth:coord:v1:${encodeURIComponent(url)}`,
    );
    spyChannel.addEventListener('message', (ev) => {
      observedBroadcasts.push(
        ev.data as { attemptId?: number; state?: string },
      );
    });

    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    let triggerVisibilityB: (() => void) | null = null;
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      addVisibilityListener: (fn) => {
        triggerVisibilityB = fn;
        return () => {
          triggerVisibilityB = null;
        };
      },
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    let releaseLockC!: () => void;
    let lockC: Promise<void> | null = null;

    try {
      // Part A: Supersede pending(1) in storage without notifying tabA -> tabA's
      // heartbeat interval MUST stop without broadcasting stale pending(1).
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(releaseLogout).not.toBeNull();
      });
      await Promise.resolve();
      observedBroadcasts.length = 0;

      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 2,
          ownerTabId: 'tabOther',
          state: 'completed',
          sessionKey: 'sid:sid-1',
        }),
      );
      await vi.advanceTimersByTimeAsync(4_500);
      expect(observedBroadcasts).toHaveLength(0);

      releaseLogout!();
      await signOutA;

      // Part B: Repeated visibilitychange / isAuthResolved while already queued
      // on an attempt lock MUST NOT stack duplicate lock requests.
      const attempt10Lock = `${lockKey}:10:tabC`;
      lockC = fakeLocks.request(
        attempt10Lock,
        { mode: 'exclusive' },
        () =>
          new Promise<void>((resolve) => {
            releaseLockC = resolve;
          }),
      );
      await Promise.resolve();

      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 10,
          ownerTabId: 'tabC',
          state: 'pending',
          sessionKey: 'sid:abandoned',
        }),
      );
      tabB.startAuth();
      await Promise.resolve();
      await Promise.resolve();

      const requestsBefore = fakeLocks
        .getRequestLog()
        .filter((entry) => entry.name === attempt10Lock).length;

      const notifyVisibleB = triggerVisibilityB as (() => void) | null;
      for (let i = 0; i < 5; i += 1) {
        notifyVisibleB?.();
        tabB.isAuthResolved();
      }
      await Promise.resolve();

      const requestsAfter = fakeLocks
        .getRequestLog()
        .filter((entry) => entry.name === attempt10Lock).length;
      expect(requestsAfter).toBe(requestsBefore);
    } finally {
      spyChannel.close();
      releaseLockC?.();
      if (lockC) await lockC;
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA8-P1-1: retryLogoutRevocation publishes pending + lease + attempt lock so sibling tabs block signIn while global revocation retry is in flight (I3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hub = createBroadcastHub();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: hub.BroadcastChannel,
    });

    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta8-p1-1-retry-pending.test';
    const sdkKey = 'sb-delta8-p1-1-retry-pending-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const lockKey = `theshark:auth:logout-lock:v1:${encodeURIComponent(url)}`;
    const storage = makeMemoryStorage();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    storage.setItem(sdkKey, JSON.stringify(server.issueSession()));

    let logoutCalls = 0;
    let passwordSignInCalls = 0;
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
      if (href.includes('/auth/v1/token?grant_type=password')) {
        passwordSignInCalls += 1;
        return Promise.resolve(server.handlePasswordSignIn());
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
        return new Promise<Response>((resolve) => {
          releaseRetryLogout = () =>
            resolve(server.handleLogout(headers.get('authorization')));
        });
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
    const clientB = createClient(url, TEST_ANON_KEY, {
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // First sign-out fails global revocation (503) -> both tabs in revocation_failed.
      await tabA.signOut();
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });
      expect(tabA.getAuthSnapshot().canRetryLogoutRevocation).toBe(true);

      // Tab A clicks Retry -> MUST publish pending(2, tabA) + lease + hold lock :2:tabA.
      const retryPromise = tabA.retryLogoutRevocation();
      await vi.waitFor(() => {
        expect(releaseRetryLogout).not.toBeNull();
      });
      await Promise.resolve();

      const pendingRetryCoord = JSON.parse(
        storage.getItem(coordKey) ?? 'null',
      ) as {
        attemptId?: number;
        ownerTabId?: string;
        state?: string;
        sessionKey?: string;
        heartbeatAt?: number;
      } | null;
      expect(pendingRetryCoord).toMatchObject({
        attemptId: 2,
        ownerTabId: 'tabA',
        state: 'pending',
        sessionKey: 'sid:sid-1',
      });
      expect(typeof pendingRetryCoord?.heartbeatAt).toBe('number');
      expect(fakeLocks.isHeld(`${lockKey}:2:tabA`)).toBe(true);
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('retrying_revocation');

      // Sibling Tab B MUST enter signing_out and BLOCK concurrent signIn (I3)!
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');
      });
      expect(tabB.isAuthResolved()).toBe(false);
      expect(await tabB.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'failed',
      );
      expect(passwordSignInCalls).toBe(0);

      // Complete Tab A's retry (204) -> lock released, both tabs converge to idle.
      releaseRetryLogout!();
      await retryPromise;
      await vi.advanceTimersByTimeAsync(20);

      expect(fakeLocks.hasAnyHeld(lockKey)).toBe(false);
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });

      // Once retry completed, fresh sign-in in Tab B succeeds cleanly.
      expect(await tabB.signIn('owner@example.test', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      hub.closeAll();
    }
  });

  it('DELTA8-P2-1: startAuth and signOut never block or revoke a newer persisted session when coordKey holds local_failed for an older sessionKey', async () => {
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
      addStorageListener: () => () => {},
      tabId: 'tabC',
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
      addStorageListener: () => () => {},
      tabId: 'tabD',
      syncGlobalStores: false,
    });

    try {
      // Part B1: Tab C boots while localStorage holds stale local_failed(2, sid-1)
      // alongside newer persisted session3 (sid-1 vs sid-2).
      const sessionNewer = server.issueSession();
      storage.setItem(sdkKey, JSON.stringify(sessionNewer));
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 2,
          ownerTabId: 'tabPrev',
          state: 'local_failed',
          sessionKey: 'sid:older-session',
        }),
      );
      tabC.startAuth();
      await vi.waitFor(() => {
        expect(tabC.getAuthSnapshot().status).toBe('owner');
      });
      expect(tabC.getAuthSnapshot().logoutFailed).toBe(false);

      // Part B2: Tab D is signed out in local_failed for sid-2 while sdkKey is
      // subsequently replaced by sessionNewer -> tabD.signOut() MUST NOT delete or revoke sessionNewer!
      const sessionOld = server.issueSession();
      storage.setItem(sdkKey, JSON.stringify(sessionOld));
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 3,
          ownerTabId: 'tabD',
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

  it('DELTA8-P3-1: retryLogoutRevocation evicts same-session sdkKey re-persisted by a late cross-tab refresh and retries with rotated tokens (or downgrades to local_failed if removal throws)', async () => {
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      tabId: 'tabA',
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

      // Simulate a late cross-tab _callRefreshToken writing rotated session1'
      // directly into sdkKey without delivering TOKEN_REFRESHED to Tab A.
      const refreshResp = server.handleRefresh(
        JSON.stringify({ refresh_token: session1.refresh_token }),
      );
      const rotatedSession = (await refreshResp.json()) as typeof session1;
      values.set(sdkKey, JSON.stringify(rotatedSession));

      // Part A: If removal fails, retryLogoutRevocation downgrades to local_failed (not a silent no-op).
      failLogout = false;
      failRemoveSdk = true;
      await tabA.retryLogoutRevocation();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });

      // Part B: Now test successful eviction + retry with rotated tokens from revocation_failed.
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

  it('DELTA9-P1-1: superseded commitLogoutResult does not write completed over local_failed while sdkKey remains persisted under 0-byte quota, and evicts sdkKey when removable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta9-p1-1-superseded-local-failed.test';
    const sdkKey = 'sb-delta9-p1-1-superseded-local-failed-auth-token';
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
    storage.setItem(sdkKey, JSON.stringify(sid1));

    let resolveTabALogout: ((res: Response) => void) | null = null;
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
        if (resolveTabALogout === null) {
          return new Promise<Response>((resolve) => {
            resolveTabALogout = resolve;
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabC',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Tab A starts signOut (attempt 1): removes sdkKey and sends /logout (held).
      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(resolveTabALogout).not.toBeNull();
      });
      expect(storage.getItem(sdkKey)).toBeNull();

      // Late refresh re-persists sid-1 into sdkKey, removeItem fails, and Tab B
      // hits local_failed(2, tabB, sid-1) while sdkKey remains populated.
      storage.setItem(sdkKey, JSON.stringify(sid1));
      failSdkRemoval = true;
      await tabB.signOut();
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('local_failed');
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 2,
        ownerTabId: 'tabB',
        state: 'local_failed',
      });
      expect(storage.getItem(sdkKey)).not.toBeNull();

      // localStorage enters 0-byte quota and Tab A's /logout returns 204.
      zeroByteQuota = true;
      resolveTabALogout!(new Response(null, { status: 204 }));
      await signOutA;

      // P1-1: Superseded commitLogoutResult MUST NOT write completed or delete
      // local_failed(2) while sdkKey still holds sid-1.
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 2,
        ownerTabId: 'tabB',
        state: 'local_failed',
      });
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });

      // Reloading Tab C MUST NOT boot to owner (preserves I1).
      tabC.startAuth();
      await vi.advanceTimersByTimeAsync(20);
      expect(tabC.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });

      // Part B: When removeItem works again, a superseded revocationOk evicts
      // sdkKey and advances local_failed to completed cleanly.
      zeroByteQuota = false;
      failSdkRemoval = false;
      await tabB.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        state: 'completed',
      });
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA9-P2-2: signOut and reconcileFromShared unblock a local_failed tab when storage holds a newer session without a signed_in coord', async () => {
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
    const sessionStorageD = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const sid4 = server.issueSession();
    const sid3 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(sid4));

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
      getSessionStorage: () => sessionStorageD,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabD',
      syncGlobalStores: false,
    });

    try {
      tabD.startAuth();
      await vi.waitFor(() => {
        expect(tabD.getAuthSnapshot().status).toBe('owner');
      });

      // Tab D enters in-memory local_failed for sid-4 under 0-byte quota + blocked sdkKey writes.
      zeroByteQuota = true;
      failSdkRemoval = true;
      await tabD.signOut();
      expect(tabD.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });
      expect(storage.getItem(coordKey)).toBeNull();

      // Another tab writes newer session sid-3 into sdkKey while coordKey stays null.
      zeroByteQuota = false;
      failSdkRemoval = false;
      storage.setItem(sdkKey, JSON.stringify(sid3));

      // Clicking "Retry Sign Out" (tabD.signOut()) MUST clear local_failed and
      // re-enable login WITHOUT revoking or removing sid-3!
      await tabD.signOut();
      expect(tabD.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
      });
      expect(tabD.isAuthResolved()).toBe(true);
      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sid3.access_token);
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
    } finally {
      await clientD.auth.stopAutoRefresh();
      tabD.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA9-P3-1: overlapping in-tab signIn calls keep signInInProgress active via counter so the second fresh session is accepted despite sibling pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta9-p3-1-overlapping-signin.test';
    const sdkKey = 'sb-delta9-p3-1-overlapping-signin-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const freshSession = server.issueSession();

    const pendingSignInResolvers: Array<(res: Response) => void> = [];
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
        return new Promise<Response>((resolve) => {
          pendingSignInResolvers.push(resolve);
        });
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('signed-out');
      });

      // Fire two overlapping signIn() calls concurrently.
      const firstSignIn = tabA.signIn('owner@test.local', 'WrongPassword123');
      const secondSignIn = tabA.signIn('owner@test.local', 'ValidPassword123');
      await vi.waitFor(() => {
        expect(pendingSignInResolvers).toHaveLength(2);
      });

      // Sibling writes pending(1) while both signIn calls are in flight.
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          ownerTabId: 'tabB',
          state: 'pending',
          sessionKey: 'sid:old-session',
          heartbeatAt: Date.now(),
        }),
      );
      expect(tabA.isAuthResolved()).toBe(false);
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // First call finishes (invalid credentials) while second is still in flight.
      pendingSignInResolvers[0]!(
        new Response(
          JSON.stringify({ error_description: 'Invalid login credentials' }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
      expect(await firstSignIn).toBe('invalid');

      // Second call succeeds with a fresh session: signInInProgressCount MUST
      // still be > 0 so GoTrueClient's SIGNED_IN is accepted as isOwnFreshSignIn.
      pendingSignInResolvers[1]!(
        new Response(JSON.stringify(freshSession), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      expect(await secondSignIn).toBe('ok');
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('idle');
    } finally {
      await clientA.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA9-P3-3: blocked localStorage (getStorage returns null) does not falsely sign out an active in-memory session on refocus or TOKEN_REFRESHED', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta9-p3-3-blocked-storage.test';
    const server = createStatefulAuthServer();
    const initialSession = server.issueSession();
    const visibilityListeners = new Set<() => void>();

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

    // Real GoTrueClient running in-memory (no localStorage available).
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
      getSessionStorage: () => null,
      addStorageListener: () => () => {},
      addVisibilityListener: (listener) => {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
      createBroadcastChannel: () => null,
      tabId: 'tab-null-storage',
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

      // Trigger refocus (visibilitychange) and isAuthResolved(): MUST stay owner!
      for (const listener of visibilityListeners) {
        listener();
      }
      expect(tab.isAuthResolved()).toBe(true);
      expect(tab.getAuthSnapshot().status).toBe('owner');

      // Trigger real TOKEN_REFRESHED via refreshSession(): MUST stay owner!
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

  it('DELTA10-P2-2: delayed completed from an older session never wipes a newer session revocation_failed in localStorage on reconcile or reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta10-p2-2-delayed-completed-older-session.test';
    const sdkKey = 'sb-delta10-p2-2-delayed-completed-older-session-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const bcHub = createBroadcastHub();
    const sessionStorageA = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const sid1 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(sid1));

    let resolveTabASignIn: ((res: Response) => void) | null = null;
    let resolveTabCRetryLogout: ((res: Response) => void) | null = null;
    let logoutCallSeq = 0;
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
        return new Promise<Response>((resolve) => {
          resolveTabASignIn = resolve;
        });
      }
      if (href.includes('/auth/v1/logout')) {
        logoutCallSeq += 1;
        if (logoutCallSeq === 1) {
          // Tab A's initial sign-out of sid-1 fails with 503.
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'unavailable' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (logoutCallSeq === 2) {
          // Tab C's retry for sid-1 is delayed in transit.
          return new Promise<Response>((resolve) => {
            resolveTabCRetryLogout = resolve;
          });
        }
        // Tab A's sign-out of sid-2 fails with 503.
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
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
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => sessionStorageA,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const clientC = makeClient();
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabC',
      syncGlobalStores: false,
    });
    const clientReloadA = makeClient();
    const tabReloadA = createAuthStore({
      getClient: () => clientReloadA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => sessionStorageA,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA-reloaded',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabC.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabC.getAuthSnapshot().status).toBe('owner');
      });

      // Step 1: Tab A signs out sid-1 -> 503 -> revocation_failed(1, tabA, sid-1).
      await tabA.signOut();
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      expect(tabC.isAuthResolved()).toBe(true);
      expect(tabC.getAuthSnapshot().logoutPhase).toBe('revocation_failed');

      // Step 2 (t=1): Tab A begins signing in (racing before observing Tab C's pending(2)),
      // and Tab C starts retryLogoutRevocation (attempt 2, sid-1); 204 held in transit.
      await vi.advanceTimersByTimeAsync(50);
      const signInAPromise = tabA.signIn(
        'owner@test.local',
        'ValidPassword123',
      );
      await vi.waitFor(() => {
        expect(resolveTabASignIn).not.toBeNull();
      });
      const retryCPromise = tabC.retryLogoutRevocation();
      await vi.waitFor(() => {
        expect(resolveTabCRetryLogout).not.toBeNull();
      });

      // Step 3 (t=2): Tab A's sign-in resolves with sid-2 -> writes signed_in(3, tabA, sid-2) and sdkKey = sid-2.
      await vi.advanceTimersByTimeAsync(50);
      resolveTabASignIn!(server.handlePasswordSignIn());
      expect(await signInAPromise).toBe('ok');
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // Step 4 (t=3): Tab A signs out sid-2 (attempt 4) -> 503 -> durable revocation_failed(4, sid-2).
      await vi.advanceTimersByTimeAsync(50);
      await tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 4,
        ownerTabId: 'tabA',
        state: 'revocation_failed',
        sessionKey: 'sid:sid-2',
      });

      // Step 5 (t=4): Tab C's delayed 204 for sid-1 (attempt 2) resolves.
      // Because sessionKey sid-1 !== sid-2 and attemptId 2 < 4, it MUST be superseded!
      await vi.advanceTimersByTimeAsync(50);
      resolveTabCRetryLogout!(new Response(null, { status: 204 }));
      await retryCPromise;

      // Step 6: Live Tab A reconcile MUST preserve revocation_failed(4, sid-2) — NOT wipe to idle!
      expect(tabA.isAuthResolved()).toBe(true);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
      });
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 4,
        state: 'revocation_failed',
        sessionKey: 'sid:sid-2',
      });

      // Reloading Tab A MUST also keep revocation_failed(4, sid-2) (I2, I3).
      tabReloadA.startAuth();
      await vi.advanceTimersByTimeAsync(20);
      expect(tabReloadA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      await clientReloadA.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
      tabReloadA.resetAuthStore({ clearStorage: false });
      bcHub.closeAll();
    }
  });

  it('DELTA10-P2-3: preserving revokedSessionKey when pending disappears under 0-byte quota blocks late TOKEN_REFRESHED from reopening owner access', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta10-p2-3-preserve-revoked-key.test';
    const sdkKey = 'sb-delta10-p2-3-preserve-revoked-key-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    const storageListenersB = new Set<(event: StorageEvent) => void>();
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
        const oldValue = values.get(k) ?? null;
        values.delete(k);
        if (oldValue !== null) {
          for (const listener of storageListenersB) {
            listener(
              new StorageEvent('storage', {
                key: k,
                oldValue,
                newValue: null,
              }),
            );
          }
        }
      },
      setItem(k: string, v: string) {
        const oldValue = values.get(k) ?? null;
        values.set(k, String(v));
        for (const listener of storageListenersB) {
          listener(
            new StorageEvent('storage', {
              key: k,
              oldValue,
              newValue: String(v),
            }),
          );
        }
      },
    };
    const server = createStatefulAuthServer();
    const initialSession = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(initialSession));

    // Pre-rotate on server BEFORE logout so the delayed refresh response carries valid rotated sid-1 tokens.
    const preRotatedResponse = server.handleRefresh(
      JSON.stringify({ refresh_token: initialSession.refresh_token }),
    );
    const preRotatedBody = await preRotatedResponse.text();
    const preRotatedParsed = JSON.parse(preRotatedBody) as {
      access_token: string;
      refresh_token: string;
    };
    storage.setItem(sdkKey, preRotatedBody);

    let resolveTabBRefresh: ((res: Response) => void) | null = null;
    let resolveTabALogout: ((res: Response) => void) | null = null;
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
          resolveTabBRefresh = resolve;
        });
      }
      if (href.includes('/auth/v1/logout')) {
        return new Promise<Response>((resolve) => {
          resolveTabALogout = resolve;
        });
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const clientB = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: (listener) => {
        storageListenersB.add(listener);
        return () => storageListenersB.delete(listener);
      },
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Start an in-flight token refresh in Tab B before sign-out.
      const refreshBPromise = clientB.auth.refreshSession({
        refresh_token: preRotatedParsed.refresh_token,
      });
      await vi.waitFor(() => {
        expect(resolveTabBRefresh).not.toBeNull();
      });

      // Tab A signs out -> writes pending(1), removes sdkKey, holds /logout.
      const signOutAPromise = tabA.signOut();
      await vi.waitFor(() => {
        expect(resolveTabALogout).not.toBeNull();
      });
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Tab A's /logout returns 204 (writing completed(1)); even if coordKey is
      // subsequently cleared externally (shared === null), Tab B MUST preserve
      // revokedSessionKey so late TOKEN_REFRESHED cannot reopen owner access.
      resolveTabALogout!(new Response(null, { status: 204 }));
      await signOutAPromise;
      storage.removeItem(coordKey);
      expect(storage.getItem(coordKey)).toBeNull();
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
      });

      // Tab B's late in-flight refresh completes with rotated sid-1 tokens,
      // writes them back to sdkKey, and emits TOKEN_REFRESHED.
      resolveTabBRefresh!(
        new Response(preRotatedBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await refreshBPromise;
      await vi.advanceTimersByTimeAsync(20);

      // P2-3: Tab B MUST stay signed-out (never reopen owner!) and evict sdkKey (I1, I3).
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
      });
      expect(storage.getItem(sdkKey)).toBeNull();
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // Advance time until Tab A's in-memory token is within 10s of expiry
      // (so isRetainedSessionExpired is true for Tab A's machine.session).
      await vi.advanceTimersByTimeAsync(3_590_000);

      // Sibling Tab B rotates sid-1's refresh token on the server and writes the
      // fresh { at_1, rt_1, expires_at: now + 3600 } to localStorage[sdkKey].
      // Tab A's in-memory machine.session still holds the expiring { at_0, rt_0 }
      // whose rt_0 is now consumed on the server!
      const rotatedRes = server.handleRefresh(
        JSON.stringify({ refresh_token: initialSession.refresh_token }),
      );
      expect(rotatedRes.status).toBe(200);
      const rotatedBody = await rotatedRes.text();
      storage.setItem(sdkKey, rotatedBody);

      // Tab A signs out -> MUST pick rotated { at_1, rt_1 } from localStorage
      // instead of trying to refresh consumed rt_0 (which would return 400).
      await tabA.signOut();
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

  it('DELTA11-P2-1: abandonment watch keys on (attemptId, ownerTabId) so switching from pending(1, tabA) to live pending(1, tabB) in localStorage tracks tabB heartbeats and lock', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta11-p2-1-watch-owner-key.test';
    const sdkKey = 'sb-delta11-p2-1-watch-owner-key-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let hideCoordUntilTabBWrites = false;
    const storageListenersC = new Set<(event: StorageEvent) => void>();
    const makeTabStorage = (who: 'A' | 'B' | 'C'): Storage => ({
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        if (who === 'B' && hideCoordUntilTabBWrites && k === coordKey) {
          return null;
        }
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        const oldValue = values.get(k) ?? null;
        values.delete(k);
        if (oldValue !== null) {
          for (const listener of storageListenersC) {
            listener(
              new StorageEvent('storage', {
                key: k,
                oldValue,
                newValue: null,
              }),
            );
          }
        }
      },
      setItem(k: string, v: string) {
        if (who === 'B' && k === coordKey) {
          hideCoordUntilTabBWrites = false;
        }
        const oldValue = values.get(k) ?? null;
        values.set(k, String(v));
        for (const listener of storageListenersC) {
          listener(
            new StorageEvent('storage', {
              key: k,
              oldValue,
              newValue: String(v),
            }),
          );
        }
      },
    });
    const storageA = makeTabStorage('A');
    const storageB = makeTabStorage('B');
    const storageC = makeTabStorage('C');
    const bcHub = createBroadcastHub();
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    let logoutSeq = 0;
    let resolveTabALogout: ((res: Response) => void) | null = null;
    let resolveTabBLogout: ((res: Response) => void) | null = null;
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
      if (href.includes('/auth/v1/logout')) {
        logoutSeq += 1;
        if (logoutSeq === 1) {
          return new Promise<Response>((resolve) => {
            resolveTabALogout = resolve;
          });
        }
        return new Promise<Response>((resolve) => {
          resolveTabBLogout = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const makeClient = (storage: Storage) =>
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

    const clientA = makeClient(storageA);
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      addStorageListener: () => () => {},
      createBroadcastChannel: (name) => new bcHub.BroadcastChannel(name),
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const clientB = makeClient(storageB);
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });
    const clientC = makeClient(storageC);
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => url,
      getStorage: () => storageC,
      addStorageListener: (listener) => {
        storageListenersC.add(listener);
        return () => storageListenersC.delete(listener);
      },
      createBroadcastChannel: (name) => new bcHub.BroadcastChannel(name),
      getLocks: () => fakeLocks,
      tabId: 'tabC',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      tabC.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
        expect(tabC.getAuthSnapshot().status).toBe('owner');
      });

      // Step 1 (T1): Tab A calls signOut -> durable pending(1, tabA) in localStorage, acquires :1:tabA.
      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(resolveTabALogout).not.toBeNull();
      });
      await vi.waitFor(() => {
        expect(tabC.getAuthSnapshot().logoutPhase).toBe('signing_out');
      });
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        ownerTabId: 'tabA',
        state: 'pending',
      });

      // Step 2 (T2 = T1 + 3s): Tab B races with same attemptId=1, writes durable
      // pending(1, tabB) to localStorage and acquires :1:tabB.
      await vi.advanceTimersByTimeAsync(3_000);
      hideCoordUntilTabBWrites = true;
      const signOutB = tabB.signOut();
      await vi.waitFor(() => {
        expect(resolveTabBLogout).not.toBeNull();
      });
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        ownerTabId: 'tabB',
        state: 'pending',
      });

      // Step 3: Tab A fails with 503 (superseded) and releases lock :1:tabA.
      resolveTabALogout!(
        new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await signOutA;

      // Step 4: Advance past T1 + 10s (to T1 + 10.5s, while Tab B is still alive,
      // heartbeating every 2s, holding :1:tabB, and within its 10s request timeout).
      await vi.advanceTimersByTimeAsync(7_500);

      // Tab C MUST have switched its watch to (1, tabB), so it MUST NOT probe
      // Tab A's released lock :1:tabA or overwrite Tab B's live pending with revocation_failed!
      expect(tabC.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'signing_out',
        logoutRevocationFailed: false,
      });
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        ownerTabId: 'tabB',
        state: 'pending',
      });

      // Step 5: Tab B's /logout returns 204 -> Tab B and Tab C both finish cleanly to idle.
      resolveTabBLogout!(new Response(null, { status: 204 }));
      await signOutB;
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('idle');
      expect(tabC.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
      bcHub.closeAll();
    }
  });

  it('DELTA11-P2-2: writeSharedCoord quota cleanup removes stale legacy/future-clamped logout coord from localStorage on fresh signIn so refocus never kicks out the new owner', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta11-p2-2-signin-quota-cleanup.test';
    const sdkKey = 'sb-delta11-p2-2-signin-quota-cleanup-auth-token';
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
    const visibilityListeners = new Set<() => void>();
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      addVisibilityListener: (listener) => {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      // Seed localStorage with a legacy revocation_failed(1, sid-old) record without writtenAt.
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          ownerTabId: 'tabPrev',
          state: 'revocation_failed',
          sessionKey: 'sid:sid-old',
        }),
      );
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });

      // Simulate localStorage having just enough space for sdkKey, so writing
      // signed_in(2, sid-1) into coordKey hits QuotaExceededError.
      blockCoordWrites = true;
      expect(await tabA.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // DELTA 15 Rules A + B: coordKey is never removed under quota (stale
      // revocation_failed(1, sid-old) stays in localStorage), yet refocus and
      // isAuthResolved() MUST keep the newer persisted owner (sid-1) signed in!
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'revocation_failed',
        sessionKey: 'sid:sid-old',
      });

      // Refocus (visibilitychange) and isAuthResolved() MUST keep the new owner signed in!
      for (const listener of visibilityListeners) {
        listener();
      }
      expect(tabA.isAuthResolved()).toBe(true);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'owner',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA12-P2-1: confirmed completed for the same sessionKey beats a higher-attemptId revocation_failed in localStorage and heals sibling tabs and reloads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta12-p2-1-same-session-completed-wins.test';
    const sdkKey = 'sb-delta12-p2-1-same-session-completed-wins-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const server = createStatefulAuthServer();
    const sid1 = server.issueSession();
    storage.setItem(sdkKey, JSON.stringify(sid1));

    let logoutSeq = 0;
    let resolveTabALogout: ((res: Response) => void) | null = null;
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
        logoutSeq += 1;
        if (logoutSeq === 1) {
          // Server revokes sid-1 immediately, but Tab A's 204 response is delayed in transit.
          const realRes = server.handleLogout(headers.get('authorization'));
          return new Promise<Response>((resolve) => {
            resolveTabALogout = () => resolve(realRes);
          });
        }
        // Tab B's concurrent /logout hits the already-revoked sid-1 -> 403 session_not_found.
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
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const clientB = makeClient();
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });
    const clientReloadB = makeClient();
    const tabReloadB = createAuthStore({
      getClient: () => clientReloadB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabB-reload',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Tab A calls signOut -> durable pending(1, tabA, sid:1), removes sdkKey, 204 delayed.
      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(resolveTabALogout).not.toBeNull();
      });
      expect(storage.getItem(sdkKey)).toBeNull();

      // Tab B calls signOut -> attemptId=2, gets 403/400 because sid-1 is already revoked ->
      // durable revocation_failed(2, tabB, sid:1) in localStorage.
      await tabB.signOut();
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 2,
        state: 'revocation_failed',
        sessionKey: 'sid:sid-1',
      });

      // Tab A's delayed 204 resolves -> advances localStorage to completed for sid-1.
      resolveTabALogout!(new Response(null, { status: 204 }));
      await signOutA;
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        state: 'completed',
        sessionKey: 'sid:sid-1',
      });

      // Tab B reconciles -> confirmed completed beats revocation_failed(2) and heals to idle!
      expect(tabB.isAuthResolved()).toBe(true);
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });

      // Reloading also boots cleanly to idle (and even a lower-attemptId completed for the
      // same sessionKey dominates revocation_failed via compareSharedCoord).
      tabReloadB.startAuth();
      await vi.advanceTimersByTimeAsync(20);
      expect(tabReloadB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      await clientReloadB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      tabReloadB.resetAuthStore({ clearStorage: false });
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
      getSessionStorage: () => makeMemoryStorage(),
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // Sign out gets 503 -> lands in revocation_failed with retry offered.
      await tabA.signOut();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
      expect(logoutCalls).toBe(1);

      // Start signIn (signInWithPassword held in flight).
      const signInPromise = tabA.signIn('owner@test.local', 'ValidPassword123');
      await vi.waitFor(() => {
        expect(resolveSignIn).not.toBeNull();
      });

      // Calling retryLogoutRevocation() while signIn is in flight MUST be a no-op!
      await tabA.retryLogoutRevocation();
      expect(logoutCalls).toBe(1);
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'revocation_failed',
      });

      // signIn resolves cleanly with a brand-new session that was NEVER revoked.
      resolveSignIn!(server.handlePasswordSignIn());
      expect(await signInPromise).toBe('ok');
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('idle');
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
    } finally {
      await clientA.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA13-FINAL6-P1-1: signIn under partial quota resets knownCoord so subsequent signOut under partial quota lands in revocation_failed instead of deadlocking in signing_out', async () => {
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
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      // Seed localStorage with stale revocation_failed(1, sid-old).
      storage.setItem(
        coordKey,
        JSON.stringify({
          attemptId: 1,
          ownerTabId: 'tabPrev',
          state: 'revocation_failed',
          sessionKey: 'sid:sid-old',
        }),
      );
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().logoutPhase).toBe('revocation_failed');
      });

      // Under partial quota (sdkKey fits, coordKey throws): signIn succeeds;
      // under Rule A stale coordKey stays in localStorage, while Rule B keeps
      // the newer persisted session signed in and lets signOut allocate attemptId=2.
      blockCoordWrites = true;
      expect(await tabA.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'revocation_failed',
        sessionKey: 'sid:sid-old',
      });

      // Still under partial quota: signOut gets 503 -> MUST land in revocation_failed
      // with Retry offered (NOT deadlocked in signing_out)!
      await tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutPending: false,
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
      expect(tabA.isAuthResolved()).toBe(true);

      // Retry succeeds when server recovers.
      failLogout = false;
      await tabA.retryLogoutRevocation();
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
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const clientB = makeClient();
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Tab A signs out sid-1 cleanly -> Tab A holds revokedSessionKey='sid:sid-1'.
      await tabA.signOut();
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        state: 'completed',
        sessionKey: 'sid:sid-1',
      });

      // Under partial quota: Tab B signs in sid-2 -> sdkKey holds sid-2 while
      // stale completed(1, sid-1) stays in coordKey (Rule A: never remove coordKey).
      blockCoordWrites = true;
      expect(await tabB.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        state: 'completed',
        sessionKey: 'sid:sid-1',
      });
      const sid2 = JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
        access_token: string;
        refresh_token: string;
      };
      expect(sid2.access_token).toBeTruthy();

      // TOKEN_REFRESHED fires in Tab A for the distinct newer session sid-2:
      // Tab A MUST NOT evict sid-2 from localStorage (I3)!
      const internalsA = clientA.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsA._notifyAllSubscribers('TOKEN_REFRESHED', sid2, false);
      await vi.advanceTimersByTimeAsync(20);

      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sid2.access_token);
      expect(tabB.getAuthSnapshot().status).toBe('owner');
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA13-FINAL6-P2-1: superseded quota-full signOut clears activeAttemptId and unblocks signing_out when another tab signs in a newer session', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta13-final6-p2-1.test';
    const sdkKey = 'sb-delta13-final6-p2-1-auth-token';
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
    const sid1 = server.issueSession();
    values.set(sdkKey, JSON.stringify(sid1));

    let resolveTabALogout: ((res: Response) => void) | null = null;
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
        const res = server.handleLogout(headers.get('authorization'));
        return new Promise<Response>((resolve) => {
          resolveTabALogout = () => resolve(res);
        });
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
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const clientB = makeClient();
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Partial quota: coordKey cannot be written. Tab A starts signOut of sid-1,
      // removes sdkKey, and /logout is held in flight.
      blockCoordWrites = true;
      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(resolveTabALogout).not.toBeNull();
      });
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(storage.getItem(coordKey)).toBeNull();
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Tab B signs in sid-2 (sdkKey = sid-2, coordKey stays null due to quota).
      expect(await tabB.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });
      const sid2 = JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
        access_token: string;
      };
      expect(storage.getItem(coordKey)).toBeNull();

      // Tab A's /logout resolves (superseded by newer persisted sid-2):
      // Tab A MUST clear activeAttemptId and unblock from signing_out to idle,
      // leaving sid-2 intact in localStorage!
      resolveTabALogout!(new Response(null, { status: 204 }));
      await signOutA;

      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutPending: false,
        logoutFailed: false,
      });
      expect(tabA.isAuthResolved()).toBe(true);
      expect(
        (
          JSON.parse(storage.getItem(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null
        )?.access_token,
      ).toBe(sid2.access_token);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA13-TOMBSTONE: overwrites sdkKey with empty tombstone when removeItem throws so reload and sibling converge to signed-out idle, and enters local_failed only when both removeItem and setItem throw', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore } = await import('@/lib/auth-store');
    const url = 'https://delta13-tombstone.test';
    const sdkKey = 'sb-delta13-tombstone-auth-token';
    const values = new Map<string, string>();
    const listeners = new Map<string, Set<(e: StorageEvent) => void>>();
    let failRemoveSdk = false;
    let failOverwriteSdk = false;

    const makeTabStorage = (who: string): Storage => ({
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
        const oldValue = values.get(k) ?? null;
        if (!values.delete(k)) return;
        for (const [tab, set] of listeners) {
          if (tab === who) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: null,
          });
          for (const fn of [...set]) fn(ev);
        }
      },
      setItem(k: string, v: string) {
        if (failOverwriteSdk && k === sdkKey) {
          throw new DOMException('setItem blocked', 'InvalidStateError');
        }
        const oldValue = values.get(k) ?? null;
        values.set(k, String(v));
        for (const [tab, set] of listeners) {
          if (tab === who) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: String(v),
          });
          for (const fn of [...set]) fn(ev);
        }
      },
    });
    const addListener = (who: string, fn: (e: StorageEvent) => void) => {
      const set = listeners.get(who) ?? new Set();
      set.add(fn);
      listeners.set(who, set);
      return () => set.delete(fn);
    };

    const storageA = makeTabStorage('tabA');
    const storageB = makeTabStorage('tabB');
    const storageReload = makeTabStorage('tabReload');
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

    const makeClient = (storage: Storage) =>
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

    const clientA = makeClient(storageA);
    const clientB = makeClient(storageB);
    const clientReload = makeClient(storageReload);
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      addStorageListener: (fn) => addListener('tabA', fn),
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      addStorageListener: (fn) => addListener('tabB', fn),
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });
    const tabReload = createAuthStore({
      getClient: () => clientReload as never,
      getProjectUrl: () => url,
      getStorage: () => storageReload,
      addStorageListener: (fn) => addListener('tabReload', fn),
      createBroadcastChannel: () => null,
      tabId: 'tabReload',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Part A: removeItem(sdkKey) throws, but tombstone setItem(sdkKey, '') succeeds.
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

      // Open sibling Tab B sees the tombstone StorageEvent and converges to signed-out idle.
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'idle',
          logoutFailed: false,
        });
      });

      // Reloaded tab with real GoTrueClient treats '' as signed-out without throwing.
      tabReload.startAuth();
      await vi.advanceTimersByTimeAsync(20);
      expect(tabReload.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
      });
      expect(tabReload.isAuthResolved()).toBe(true);

      // Part B: Sign in again; now BOTH removeItem(sdkKey) and setItem(sdkKey, '') throw ->
      // tab enters local_failed and stays blocked (I1).
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
      await clientB.auth.stopAutoRefresh();
      await clientReload.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      tabReload.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA13-QUOTA-IN-MEMORY-REVOCATION: under 0-byte quota, revocation failure stays visible with Retry in the running tab only while sibling and reload converge to signed-out idle', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta13-quota-in-memory.test';
    const sdkKey = 'sb-delta13-quota-in-memory-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    const listeners = new Map<string, Set<(e: StorageEvent) => void>>();
    const visibilityA = new Set<() => void>();
    let zeroByteQuota = false;

    const makeTabStorage = (who: string): Storage => ({
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
        const oldValue = values.get(k) ?? null;
        if (!values.delete(k)) return;
        for (const [tab, set] of listeners) {
          if (tab === who) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: null,
          });
          for (const fn of [...set]) fn(ev);
        }
      },
      setItem(k: string, v: string) {
        if (zeroByteQuota) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        const oldValue = values.get(k) ?? null;
        values.set(k, String(v));
        for (const [tab, set] of listeners) {
          if (tab === who) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: String(v),
          });
          for (const fn of [...set]) fn(ev);
        }
      },
    });
    const addListener = (who: string, fn: (e: StorageEvent) => void) => {
      const set = listeners.get(who) ?? new Set();
      set.add(fn);
      listeners.set(who, set);
      return () => set.delete(fn);
    };

    const storageA = makeTabStorage('tabA');
    const storageB = makeTabStorage('tabB');
    const storageC = makeTabStorage('tabC');
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

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

    const makeClient = (storage: Storage) =>
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

    const clientA = makeClient(storageA);
    const clientB = makeClient(storageB);
    const clientC = makeClient(storageC);
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      addStorageListener: (fn) => addListener('tabA', fn),
      addVisibilityListener: (fn) => {
        visibilityA.add(fn);
        return () => visibilityA.delete(fn);
      },
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      addStorageListener: (fn) => addListener('tabB', fn),
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => url,
      getStorage: () => storageC,
      addStorageListener: (fn) => addListener('tabC', fn),
      createBroadcastChannel: () => null,
      tabId: 'tabC',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Under 0-byte quota, Tab A signs out -> sdkKey removed, coordKey unwritten, /logout returns 503.
      zeroByteQuota = true;
      await tabA.signOut();
      expect(values.get(sdkKey)).toBeUndefined();
      expect(values.get(coordKey)).toBeUndefined();

      // Running Tab A keeps revocation_failed + Retry in memory, including across refocus.
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
      for (const fn of visibilityA) fn();
      expect(tabA.isAuthResolved()).toBe(true);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });

      // Sibling Tab B sees sdkKey removed and converges cleanly to signed-out idle (login enabled).
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'idle',
          logoutRevocationFailed: false,
          logoutFailed: false,
        });
      });
      expect(tabB.isAuthResolved()).toBe(true);

      // Reloaded Tab C boots cleanly to signed-out idle (notice disappears on reload under quota).
      tabC.startAuth();
      await vi.advanceTimersByTimeAsync(20);
      expect(tabC.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
        logoutFailed: false,
      });
      expect(tabC.isAuthResolved()).toBe(true);

      // Clicking Retry in running Tab A succeeds once network recovers (even still under 0-byte quota).
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
      await clientB.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA14-P1-1: signOut after same-session completed is in localStorage does not deadlock in signing_out and keeps login enabled (I4)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta14-p1-1-completed-signout.test';
    const sdkKey = 'sb-delta14-p1-1-completed-signout-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let injectCompletedOnPendingWrite = false;
    const makeTabStorage = (): Storage => ({
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
        if (injectCompletedOnPendingWrite && k === coordKey) {
          const parsed = JSON.parse(v) as { state?: string };
          if (parsed.state === 'pending') {
            injectCompletedOnPendingWrite = false;
            values.set(
              coordKey,
              JSON.stringify({
                attemptId: 1,
                ownerTabId: 'tabB',
                state: 'completed',
                sessionKey: 'sid:sid-2',
              }),
            );
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
          }
        }
        values.set(k, String(v));
      },
    });
    const storageA = makeTabStorage();
    const storageB = makeTabStorage();
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    let failLogout = false;
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
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const makeClient = (storage: Storage) =>
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

    const clientA = makeClient(storageA);
    const clientB = makeClient(storageB);
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Part A: Tab B finishes signing out sid-1 (writes completed(1, tabB, sid:sid-1)).
      // Tab A missed the StorageEvent and clicks Sign Out -> MUST NOT deadlock in signing_out!
      await tabB.signOut();
      expect(values.get(sdkKey)).toBeUndefined();
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 1,
        ownerTabId: 'tabB',
        state: 'completed',
        sessionKey: 'sid:sid-1',
      });

      await tabA.signOut();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
      expect(tabA.isAuthResolved()).toBe(true);

      // Login MUST remain enabled and succeed immediately!
      expect(await tabA.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // Part B: Exercise executeSignOutAttempt's superseded branch directly when
      // completed(1, tabB, sid:sid-2) races in right during pending write.
      values.delete(coordKey);
      failLogout = true;
      injectCompletedOnPendingWrite = true;
      await tabA.signOut();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
      expect(tabA.isAuthResolved()).toBe(true);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA14-P1-2: open sibling resets stale knownCoord when coordKey is deleted under quota so later lower-attemptId pending, revocation_failed, and local_failed from a fresh tab are adopted (I1, I2, I3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta14-p1-2-stale-known-coord.test';
    const sdkKey = 'sb-delta14-p1-2-stale-known-coord-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let zeroByteQuota = false;
    let failSdkForTabD = false;
    const makeTabStorage = (who: string): Storage => ({
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
        if (who === 'tabD' && failSdkForTabD && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (who === 'tabD' && failSdkForTabD && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        if (zeroByteQuota) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    });
    const storageA = makeTabStorage('tabA');
    const storageB = makeTabStorage('tabB');
    const storageC = makeTabStorage('tabC');
    const storageD = makeTabStorage('tabD');
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    let failLogout = true;
    let holdNextLogout = false;
    let resolveHeldLogout: ((res: Response) => void) | null = null;
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
        if (holdNextLogout) {
          holdNextLogout = false;
          return new Promise<Response>((resolve) => {
            resolveHeldLogout = resolve;
          });
        }
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

    const makeClient = (storage: Storage) =>
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

    const clientA = makeClient(storageA);
    const clientB = makeClient(storageB);
    const clientC = makeClient(storageC);
    const clientD = makeClient(storageD);
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => url,
      getStorage: () => storageC,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabC',
      syncGlobalStores: false,
    });
    const tabD = createAuthStore({
      getClient: () => clientD as never,
      getProjectUrl: () => url,
      getStorage: () => storageD,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabD',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Step 1: Tab A accumulates revocation_failed(attemptId=3, sid:sid-1); Tab B adopts it.
      await tabA.signOut();
      await tabA.retryLogoutRevocation();
      await tabA.retryLogoutRevocation();
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 3,
        state: 'revocation_failed',
      });
      expect(tabB.isAuthResolved()).toBe(true);
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');

      // Step 2: 0-byte quota hits; Tab A retries (attemptId=4) -> 204.
      // Under Rule A, coordKey is NEVER deleted (remains attemptId=3) so fresh
      // tabs never restart attemptIds at 1!
      zeroByteQuota = true;
      failLogout = false;
      await tabA.retryLogoutRevocation();
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 3,
        state: 'revocation_failed',
      });

      // Step 3: Space recovers; fresh Tab C signs in sid-2 -> signed_in(attemptId=4 > 3).
      // Tab B adopts signed_in(4) and becomes owner for sid-2.
      zeroByteQuota = false;
      tabC.startAuth();
      expect(await tabC.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabC.getAuthSnapshot().status).toBe('owner');
      });
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 4,
        state: 'signed_in',
      });
      const sid2: unknown = JSON.parse(values.get(sdkKey) ?? 'null');
      const internalsB = clientB.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsB._notifyAllSubscribers('SIGNED_IN', sid2, false);
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Step 4 (I3 + I2): Tab C signs out sid-2 (attemptId=5):
      // while /logout is in flight (pending(5)), Tab B MUST enter signing_out;
      // when /logout returns 503 (revocation_failed(5)), Tab B MUST show revocation_failed!
      holdNextLogout = true;
      const signOutC = tabC.signOut();
      await vi.waitFor(() => {
        expect(resolveHeldLogout).not.toBeNull();
      });
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 5,
        state: 'pending',
      });
      expect(tabB.isAuthResolved()).toBe(false);
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'signing_out',
        logoutPending: true,
      });

      resolveHeldLogout!(
        new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await signOutC;
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 5,
        state: 'revocation_failed',
      });
      expect(tabB.isAuthResolved()).toBe(true);
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
      });

      // Step 5 (I1): Another quota-full retry + fresh Tab D signs in sid-3 (attemptId=6)
      // and hits local_failed(attemptId=7) while Tab B is owner for sid-3 ->
      // Tab B MUST leave owner and enter local_failed!
      zeroByteQuota = true;
      failLogout = false;
      await tabC.retryLogoutRevocation();
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 5,
        state: 'revocation_failed',
      });

      zeroByteQuota = false;
      tabD.startAuth();
      expect(await tabD.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabD.getAuthSnapshot().status).toBe('owner');
      });
      const sid3: unknown = JSON.parse(values.get(sdkKey) ?? 'null');
      await internalsB._notifyAllSubscribers('SIGNED_IN', sid3, false);
      await vi.waitFor(() => {
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      failSdkForTabD = true;
      await tabD.signOut();
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 7,
        state: 'local_failed',
      });
      expect(tabB.isAuthResolved()).toBe(false);
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      await clientD.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
      tabD.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA14-P2-3: superseded 2xx rescue path clears pending-abandonment watch so an already-completed tab does not flip back to revocation_failed 10s later (I3, I4)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta14-p2-3-rescue-clears-watch.test';
    const sdkKey = 'sb-delta14-p2-3-rescue-clears-watch-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let zeroByteQuota = false;
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
        if (zeroByteQuota) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    };
    const fakeLocks = createFakeLockManager();
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    let logoutSeq = 0;
    let resolveTabALogout: ((res: Response) => void) | null = null;
    let resolveTabBLogout: ((res: Response) => void) | null = null;
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
        logoutSeq += 1;
        if (logoutSeq === 1) {
          const res = server.handleLogout(headers.get('authorization'));
          return new Promise<Response>((resolve) => {
            resolveTabALogout = () => resolve(res);
          });
        }
        return new Promise<Response>((resolve) => {
          resolveTabBLogout = resolve;
        });
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
    const clientB = makeClient();
    const clientC = makeClient();
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      getLocks: () => fakeLocks,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      getLocks: () => fakeLocks,
      tabId: 'tabB',
      syncGlobalStores: false,
    });
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      getLocks: () => fakeLocks,
      tabId: 'tabC',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Step 1: Tab A calls signOut (attempt 1), removes sdkKey, 204 held in transit.
      const signOutA = tabA.signOut();
      await vi.waitFor(() => {
        expect(resolveTabALogout).not.toBeNull();
      });
      expect(values.get(sdkKey)).toBeUndefined();

      // Step 2: Tab B calls signOut (attempt 2) -> writes pending(2, tabB, sid:sid-1).
      const signOutB = tabB.signOut();
      await vi.waitFor(() => {
        expect(resolveTabBLogout).not.toBeNull();
      });
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 2,
        ownerTabId: 'tabB',
        state: 'pending',
      });

      // Step 3: Tab A reconciles pending(2, tabB), arming the 10s abandonment watch.
      expect(tabA.isAuthResolved()).toBe(false);
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('signing_out');

      // Step 4: 0-byte quota hits; Tab A's delayed 204 arrives -> rescue path
      // transitions Tab A to idle and MUST clear the abandonment watch!
      // (Under Rule A, pending(2, tabB) stays in localStorage under quota.)
      zeroByteQuota = true;
      resolveTabALogout!(new Response(null, { status: 204 }));
      await signOutA;
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });

      // Step 5: Tab B finishes and releases lock :2:tabB; space recovers.
      resolveTabBLogout!(
        new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await signOutB;
      zeroByteQuota = false;

      // Step 6: Advance 11s past the 10s lease TTL: Tab A MUST stay idle and MUST NOT
      // promote the cleared watch to revocation_failed!
      await vi.advanceTimersByTimeAsync(11_000);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
        logoutFailed: false,
      });
      expect(tabA.isAuthResolved()).toBe(true);

      // Reloaded Tab C boots with login enabled (not deadlocked).
      tabC.startAuth();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(tabC.getAuthSnapshot().status).toBe('signed-out');
      expect(tabC.isAuthResolved()).toBe(true);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA14-P3-5: unbacked in-memory local_failed unblocks to idle when a sibling removes sdkKey under 0-byte quota while in-memory revocation_failed stays visible (I2, I4)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta14-p3-5-unbacked-local-failed.test';
    const sdkKey = 'sb-delta14-p3-5-unbacked-local-failed-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    const listeners = new Map<string, Set<(e: StorageEvent) => void>>();
    let zeroByteQuota = false;
    let failSdkForTabB = false;

    const makeTabStorage = (who: string): Storage => ({
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
        if (who === 'tabB' && failSdkForTabB && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        const oldValue = values.get(k) ?? null;
        if (!values.delete(k)) return;
        for (const [tab, set] of listeners) {
          if (tab === who) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: null,
          });
          for (const fn of [...set]) fn(ev);
        }
      },
      setItem(k: string, v: string) {
        if (who === 'tabB' && failSdkForTabB && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        if (zeroByteQuota) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        const oldValue = values.get(k) ?? null;
        values.set(k, String(v));
        for (const [tab, set] of listeners) {
          if (tab === who) continue;
          const ev = new StorageEvent('storage', {
            key: k,
            oldValue,
            newValue: String(v),
          });
          for (const fn of [...set]) fn(ev);
        }
      },
    });
    const addListener = (who: string, fn: (e: StorageEvent) => void) => {
      const set = listeners.get(who) ?? new Set();
      set.add(fn);
      listeners.set(who, set);
      return () => set.delete(fn);
    };

    const storageA = makeTabStorage('tabA');
    const storageB = makeTabStorage('tabB');
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    let failLogout = false;
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
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(server.handlePasswordSignIn());
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const makeClient = (storage: Storage) =>
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

    const clientA = makeClient(storageA);
    const clientB = makeClient(storageB);
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      addStorageListener: (fn) => addListener('tabA', fn),
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      addStorageListener: (fn) => addListener('tabB', fn),
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Under 0-byte quota, Tab B fails both removeItem and tombstone setItem on sdkKey ->
      // unbacked in-memory local_failed (backedByStorage === false).
      zeroByteQuota = true;
      failSdkForTabB = true;
      await tabB.signOut();
      expect(values.get(coordKey)).toBeUndefined();
      expect(values.get(sdkKey)).toBeDefined();
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });
      expect(tabB.isAuthResolved()).toBe(false);

      // Sibling Tab A removes sdkKey and finishes signOut under 0-byte quota ->
      // Tab B MUST unblock cleanly to signed-out / idle (I4)!
      await tabA.signOut();
      expect(values.get(sdkKey)).toBeUndefined();
      expect(values.get(coordKey)).toBeUndefined();
      expect(tabA.getAuthSnapshot().logoutPhase).toBe('idle');
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
        logoutPending: false,
      });
      expect(tabB.isAuthResolved()).toBe(true);

      // Contrast: in-memory revocation_failed (backedByStorage === false) MUST stay visible
      // even though sdkKey is gone (I2).
      zeroByteQuota = false;
      failSdkForTabB = false;
      expect(await tabA.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });
      zeroByteQuota = true;
      failLogout = true;
      await tabA.signOut();
      expect(values.get(sdkKey)).toBeUndefined();
      expect(tabA.isAuthResolved()).toBe(true);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
    }
  });

  it('DELTA15-P1: never deleting coordKey keeps attemptIds monotonic so a backgrounded open tab that misses a quota window still adopts fresh-tab local_failed, pending, and completed (I1, I2, I3, I4)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta15-p1-never-delete-coord.test';
    const sdkKey = 'sb-delta15-p1-never-delete-coord-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const values = new Map<string, string>();
    let zeroByteQuota = false;
    let failSdkForTabC = false;
    const makeTabStorage = (who: string): Storage => ({
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
        if (who === 'tabC' && failSdkForTabC && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        values.delete(k);
      },
      setItem(k: string, v: string) {
        if (who === 'tabC' && failSdkForTabC && k === sdkKey) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        if (zeroByteQuota) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        values.set(k, String(v));
      },
    });
    const storageA = makeTabStorage('tabA');
    const storageB = makeTabStorage('tabB');
    const storageC = makeTabStorage('tabC');
    const storageD = makeTabStorage('tabD');
    const server = createStatefulAuthServer();
    values.set(sdkKey, JSON.stringify(server.issueSession()));

    let failLogout = true;
    let holdNextLogout = false;
    let resolveHeldLogout: ((res: Response) => void) | null = null;
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
        if (holdNextLogout) {
          holdNextLogout = false;
          const res = server.handleLogout(headers.get('authorization'));
          return new Promise<Response>((resolve) => {
            resolveHeldLogout = () => resolve(res);
          });
        }
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

    const makeClient = (storage: Storage) =>
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

    const clientA = makeClient(storageA);
    const clientB = makeClient(storageB);
    const clientC = makeClient(storageC);
    const clientD = makeClient(storageD);
    const visibilityB = new Set<() => void>();
    const tabA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => storageA,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });
    const tabB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => storageB,
      addStorageListener: () => () => {},
      addVisibilityListener: (fn) => {
        visibilityB.add(fn);
        return () => visibilityB.delete(fn);
      },
      createBroadcastChannel: () => null,
      tabId: 'tabB',
      syncGlobalStores: false,
    });
    const tabC = createAuthStore({
      getClient: () => clientC as never,
      getProjectUrl: () => url,
      getStorage: () => storageC,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabC',
      syncGlobalStores: false,
    });
    const tabD = createAuthStore({
      getClient: () => clientD as never,
      getProjectUrl: () => url,
      getStorage: () => storageD,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabD',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      tabB.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
        expect(tabB.getAuthSnapshot().status).toBe('owner');
      });

      // Step 1: Tab A accumulates revocation_failed(3, sid:sid-1); Tab B adopts it.
      await tabA.signOut();
      await tabA.retryLogoutRevocation();
      await tabA.retryLogoutRevocation();
      expect(tabB.isAuthResolved()).toBe(true);
      expect(tabB.getAuthSnapshot().logoutPhase).toBe('revocation_failed');

      // Step 2: Tab B is backgrounded and DOES NOT reconcile during steps 3-5!
      // Step 3: 0-byte quota hits; Tab A retries (attempt 4) -> 204.
      // Under Rule A, coordKey stays at attemptId=3 (NOT deleted).
      zeroByteQuota = true;
      failLogout = false;
      await tabA.retryLogoutRevocation();

      // Step 4: Space frees up; fresh Tab C signs in sid-2 (attemptId=4 > 3),
      // then fails both removeItem and tombstone setItem on signOut -> local_failed(5, sid:sid-2).
      zeroByteQuota = false;
      tabC.startAuth();
      expect(await tabC.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabC.getAuthSnapshot().status).toBe('owner');
      });
      const sid2: unknown = JSON.parse(values.get(sdkKey) ?? 'null');
      failSdkForTabC = true;
      await tabC.signOut();
      expect(JSON.parse(values.get(coordKey) ?? 'null')).toMatchObject({
        attemptId: 5,
        state: 'local_failed',
        sessionKey: 'sid:sid-2',
      });

      // Step 5 (I1): Backgrounded Tab B wakes up ONLY NOW (missed both quota window
      // and signed_in(4)) and GoTrueClient emits SIGNED_IN(sid-2) on refocus:
      // Tab B MUST adopt local_failed(5) and NEVER reopen status: 'owner'!
      for (const fn of visibilityB) fn();
      const internalsB = clientB.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsB._notifyAllSubscribers('SIGNED_IN', sid2, false);
      await vi.advanceTimersByTimeAsync(20);
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });
      expect(tabB.isAuthResolved()).toBe(false);

      // Step 6 (I3 + I4): Tab C recovers and completes sign-out of sid-2; fresh Tab D
      // signs in sid-3 and starts signOut (pending -> completed) while Tab B misses
      // signed_in: Tab B MUST adopt pending (login disabled) and then completed (idle)!
      failSdkForTabC = false;
      await tabC.signOut();
      tabD.startAuth();
      expect(await tabD.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabD.getAuthSnapshot().status).toBe('owner');
      });
      holdNextLogout = true;
      const signOutD = tabD.signOut();
      await vi.waitFor(() => {
        expect(resolveHeldLogout).not.toBeNull();
      });

      // Backgrounded Tab B wakes while Tab D's logout is in flight -> MUST be signing_out!
      for (const fn of visibilityB) fn();
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'signing_out',
        logoutPending: true,
      });
      expect(tabB.isAuthResolved()).toBe(false);

      // Tab D finishes -> Tab B reconciles cleanly to signed-out / idle (login enabled).
      resolveHeldLogout!(new Response(null, { status: 204 }));
      await signOutD;
      for (const fn of visibilityB) fn();
      expect(tabB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
        logoutFailed: false,
      });
      expect(tabB.isAuthResolved()).toBe(true);
    } finally {
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
      await clientC.auth.stopAutoRefresh();
      await clientD.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
      tabB.resetAuthStore({ clearStorage: false });
      tabC.resetAuthStore({ clearStorage: false });
      tabD.resetAuthStore({ clearStorage: false });
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
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });

      // Step 1: Under 0-byte quota + blocked sdkKey removal/overwrite, signOut enters
      // unbacked local_failed with 0 /logout requests sent.
      zeroByteQuota = true;
      failSdkRemove = true;
      await tabA.signOut();
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
      expect(values.get(sdkKey)).toBeDefined();
      expect(values.get(coordKey)).toBeUndefined();
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });

      // Step 2: removeItem recovers while 0-byte quota persists; refocus fires SIGNED_IN(sid1).
      // onAuthStateChange's quota fallback removes sdkKey -> MUST transition to
      // revocation_failed with Retry available (NOT stay in local_failed!).
      failSdkRemove = false;
      const internalsA = clientA.auth as unknown as {
        _notifyAllSubscribers: (
          event: string,
          session: unknown,
          broadcast?: boolean,
        ) => Promise<void>;
      };
      await internalsA._notifyAllSubscribers('SIGNED_IN', sid1, false);

      expect(values.get(sdkKey)).toBeUndefined();
      expect(server.getConfirmedGlobalLogouts()).toBe(0);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutFailed: false,
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });

      // Step 3: Subsequent reconcileFromShared / isAuthResolved MUST keep revocation_failed
      // and MUST NOT silently flip Tab A to clean idle!
      expect(tabA.isAuthResolved()).toBe(true);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: true,
      });

      // Step 4: Clicking Retry revokes sid-1 globally (204) and converges to idle.
      await tabA.retryLogoutRevocation();
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

  it('DELTA15-P2-2: production supabase.ts binds window.localStorage explicitly under boot-time quota and signOut never early-returns while an active session is unrevoked (I2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Part A: Production supabase.ts passes window.localStorage explicitly so
    // GoTrueClient does NOT fall back to private memoryStorage when localStorage
    // throws QuotaExceededError at module load time.
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
    const origLocalStorage = Object.getOwnPropertyDescriptor(
      window,
      'localStorage',
    );
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
      // Even though localStorage threw QuotaExceededError during createClient(),
      // GoTrueClient's storage MUST be window.localStorage (not memoryStorage):
      // when space frees up, signInWithPassword writes directly into bootQuotaStorage!
      fullAtBoot = false;
      const signInRes = await supabaseMod.supabase!.auth.signInWithPassword({
        email: 'owner@test.local',
        password: 'ValidPassword123',
      });
      expect(signInRes.error).toBeNull();
      expect(valuesProd.get('sb-delta15-p2-2-prod-auth-token')).toBeDefined();
      await supabaseMod.supabase!.auth.stopAutoRefresh();
    } finally {
      globalThis.fetch = origFetch;
      vi.unstubAllEnvs();
      if (origLocalStorage) {
        Object.defineProperty(window, 'localStorage', origLocalStorage);
      }
      vi.resetModules();
    }

    // Part B: Even if a direct-transport tab holds an active in-memory session
    // while localStorage[sdkKey] is missing and coordKey holds signed_in(1),
    // signOut() MUST NOT early-return — it MUST send POST /auth/v1/logout?scope=global!
    const { createAuthStore, getLogoutCoordStorageKey } =
      await import('@/lib/auth-store');
    const url = 'https://delta15-p2-2-signout-guard.test';
    const sdkKey = 'sb-delta15-p2-2-signout-guard-auth-token';
    const coordKey = getLogoutCoordStorageKey(url);
    const storage = makeMemoryStorage();
    const memoryOnlySdkStorage = makeMemoryStorage();
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
        storage: memoryOnlySdkStorage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchFn },
    });
    const tabA = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: () => () => {},
      createBroadcastChannel: () => null,
      tabId: 'tabA',
      syncGlobalStores: false,
    });

    try {
      tabA.startAuth();
      expect(await tabA.signIn('owner@test.local', 'ValidPassword123')).toBe(
        'ok',
      );
      await vi.waitFor(() => {
        expect(tabA.getAuthSnapshot().status).toBe('owner');
      });
      expect(storage.getItem(sdkKey)).toBeNull();
      expect(JSON.parse(storage.getItem(coordKey) ?? 'null')).toMatchObject({
        state: 'signed_in',
      });

      await tabA.signOut();
      expect(server.getConfirmedGlobalLogouts()).toBe(1);
      expect(tabA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutRevocationFailed: false,
      });
    } finally {
      await client.auth.stopAutoRefresh();
      tabA.resetAuthStore({ clearStorage: false });
    }
  });
});
