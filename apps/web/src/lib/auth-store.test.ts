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
  const storage: Storage & { setFull: (next: boolean) => void } = {
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
      if (full && oldValue === null) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      values.set(key, String(value));
      options?.onMutation?.(key, oldValue, String(value));
    },
    setFull(next: boolean) {
      full = next;
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
        expect(tabB.getAuthSnapshot().logoutFailed).toBe(true);
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

describe('auth-store state machine invariant matrix (I1-I4)', () => {
  it.each(LOGOUT_STATE_MACHINE_MATRIX)(
    'outcome=$outcome | interleaving=$interleaving | storage=$storageOrder | post=$postCheck',
    async ({ outcome, interleaving, storageOrder, postCheck }) => {
      const { createAuthStore, getLogoutCoordStorageKey } =
        await import('@/lib/auth-store');

      const url = `https://matrix-${outcome}-${interleaving}-${storageOrder}-${postCheck}.test`;
      const sdkKey = `sb-matrix-${outcome}-${interleaving}-${storageOrder}-${postCheck}-auth-token`;
      const coordKey = getLogoutCoordStorageKey(url);

      const values = new Map<string, string>();
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

      const isExpiredOutcome =
        outcome === 'revocation_400_refresh' ||
        outcome === 'quota_full_400_refresh';
      const isQuotaOutcome =
        outcome === 'quota_full_success' ||
        outcome === 'quota_full_503' ||
        outcome === 'quota_full_400_refresh';

      const initialSession = makeSession({
        access_token: 'access-old-matrix',
        refresh_token: 'refresh-old-matrix',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      const expiredOldSession = makeSession({
        access_token: 'access-old-matrix',
        refresh_token: 'refresh-old-matrix',
        expires_at: Math.floor(Date.now() / 1000) - 60,
      });
      const newSession = makeSession({
        access_token: 'access-new-matrix',
        refresh_token: 'refresh-new-matrix',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      values.set(sdkKey, JSON.stringify(initialSession));

      let confirmedGlobalLogouts = 0;
      let releaseTabARequest: ((res: Response) => void) | null = null;
      let deferredTabAOnce = false;
      const shouldDeferTabA =
        interleaving !== 'observe_only' && outcome !== 'local_remove_failure';

      function makeTabAResponse(): Response {
        switch (outcome) {
          case 'success':
          case 'quota_full_success':
            confirmedGlobalLogouts += 1;
            return new Response(null, { status: 204 });
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
        if (
          href.includes('/auth/v1/logout') ||
          href.includes('/auth/v1/token?grant_type=refresh_token')
        ) {
          if (shouldDeferTabA && !deferredTabAOnce) {
            deferredTabAOnce = true;
            return new Promise<Response>((resolve) => {
              releaseTabARequest = resolve;
            });
          }
          return Promise.resolve(makeTabAResponse());
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
        if (href.includes('/auth/v1/logout')) {
          confirmedGlobalLogouts += 1;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...initialSession,
                access_token: 'access-refreshed-tabB',
                refresh_token: 'refresh-refreshed-tabB',
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            ),
          );
        }
        if (href.includes('/auth/v1/token?grant_type=password')) {
          return Promise.resolve(
            new Response(JSON.stringify(newSession), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const storageA = makeTabStorage('tabA');
      const storageB = makeTabStorage('tabB');

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
        addStorageListener: (fn) => addTabStorageListener('tabA', fn),
        tabId: 'tabA',
        syncGlobalStores: false,
      });
      const tabB = createAuthStore({
        getClient: () => clientB as never,
        getProjectUrl: () => url,
        getStorage: () => storageB,
        addStorageListener: (fn) => addTabStorageListener('tabB', fn),
        tabId: 'tabB',
        syncGlobalStores: false,
      });

      let reloadedTab: ReturnType<typeof createAuthStore> | null = null;

      try {
        tabA.startAuth();
        tabB.startAuth();
        await vi.waitFor(() => {
          expect(tabA.getAuthSnapshot().status).toBe('owner');
          expect(tabB.getAuthSnapshot().status).toBe('owner');
        });

        // Apply outcome preconditions right before Tab A initiates sign-out.
        if (isExpiredOutcome) {
          values.set(sdkKey, JSON.stringify(expiredOldSession));
          // Re-notify Tab A's session as expired so signOut captures the expired token.
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
        } else {
          if (shouldDeferTabA) {
            await vi.waitFor(() => {
              expect(releaseTabARequest).not.toBeNull();
            });
          } else {
            // local_remove_failure fails synchronously in Tab A before Tab B recovers.
            await tabAPending;
          }

          // Free storage/lock for Tab B's recovery + optional sign-in.
          full = false;
          failRemoveForTab = null;

          // Tab B completes logout with 204.
          await tabB.signOut();

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

          // Now release Tab A's older in-flight request (if deferred).
          if (shouldDeferTabA) {
            releaseTabARequest!(makeTabAResponse());
            await tabAPending;
          }
          flushDelayedReversed();
        }

        // --- Invariant assertions (I1-I4) ---

        if (interleaving === 'observe_only') {
          const expectsRevocationFailure =
            outcome === 'revocation_503' ||
            outcome === 'revocation_400_refresh' ||
            outcome === 'revocation_401' ||
            outcome === 'quota_full_503' ||
            outcome === 'quota_full_400_refresh';

          if (outcome === 'local_remove_failure') {
            // I1 & I2: local failure reported, login blocked, never owner
            expect(tabA.getAuthSnapshot()).toMatchObject({
              status: 'signed-out',
              logoutFailed: true,
              logoutPending: false,
            });
            expect(tabA.isAuthResolved()).toBe(false);
          } else {
            // I1: local credentials removed even on quota-full or server failure
            expect(values.get(sdkKey)).toBeUndefined();
            if (expectsRevocationFailure) {
              // I2: global revocation was NOT confirmed -> MUST report failure with retry
              expect(confirmedGlobalLogouts).toBe(0);
              expect(tabA.getAuthSnapshot()).toMatchObject({
                status: 'signed-out',
                logoutPhase: 'revocation_failed',
                logoutPending: false,
                logoutFailed: false,
                logoutRevocationFailed: true,
                canRetryLogoutRevocation: true,
              });
            } else {
              // I2: global logout WAS actually performed (204)
              expect(confirmedGlobalLogouts).toBeGreaterThanOrEqual(1);
              expect(tabA.getAuthSnapshot()).toMatchObject({
                status: 'signed-out',
                logoutPhase: 'idle',
                logoutPending: false,
                logoutFailed: false,
                logoutRevocationFailed: false,
              });
            }

            // I4: Tab B ends signed-out with login enabled (once synced/reconciled)
            if (storageOrder === 'dropped') {
              // Dropped events: Tab B reconciles from storage on check/action
              tabB.isAuthResolved();
              if (!isQuotaOutcome) {
                expect(tabB.getAuthSnapshot().status).toBe('signed-out');
                expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
                expect(tabB.getAuthSnapshot().logoutPending).toBe(false);
              }
            } else {
              expect(tabB.getAuthSnapshot().status).toBe('signed-out');
              expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
              expect(tabB.getAuthSnapshot().logoutPending).toBe(false);
            }
          }

          // I1 post-check: reload vs refocus MUST NEVER restore owner access!
          if (postCheck === 'reload') {
            const storageC = makeTabStorage('tabC');
            const clientC = createClient(url, TEST_ANON_KEY, {
              auth: {
                storage: storageC,
                storageKey: sdkKey,
                persistSession: true,
                autoRefreshToken: false,
                detectSessionInUrl: false,
              },
              global: { fetch: fetchB },
            });
            reloadedTab = createAuthStore({
              getClient: () => clientC as never,
              getProjectUrl: () => url,
              getStorage: () => storageC,
              addStorageListener: (fn) => addTabStorageListener('tabC', fn),
              tabId: 'tabC',
              syncGlobalStores: false,
            });
            reloadedTab.startAuth();
            await new Promise((resolve) => setTimeout(resolve, 15));
            expect(reloadedTab.getAuthSnapshot().status).toBe('signed-out');
            if (outcome === 'local_remove_failure') {
              expect(reloadedTab.getAuthSnapshot().logoutFailed).toBe(true);
            } else if (expectsRevocationFailure && !isQuotaOutcome) {
              expect(reloadedTab.getAuthSnapshot().logoutRevocationFailed).toBe(
                true,
              );
            }
          } else {
            // refocus: re-emit the old session on Tab A
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
            await new Promise((resolve) => setTimeout(resolve, 15));
            if (
              outcome === 'local_remove_failure' ||
              expectsRevocationFailure
            ) {
              expect(tabA.getAuthSnapshot().status).toBe('signed-out');
            }
          }
        } else if (interleaving === 'tabB_supersedes_logout') {
          // I1: local credentials removed
          expect(values.get(sdkKey)).toBeUndefined();
          // I2: Tab B actually performed global logout (204)
          expect(confirmedGlobalLogouts).toBeGreaterThanOrEqual(1);
          // I3: Tab A's older attempt NEVER overwrote Tab B's completed coord
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
          // I4: BOTH tabs end signed-out with login enabled (after reconcile if dropped)
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
            const clientC = createClient(url, TEST_ANON_KEY, {
              auth: {
                storage: storageC,
                storageKey: sdkKey,
                persistSession: true,
                autoRefreshToken: false,
                detectSessionInUrl: false,
              },
              global: { fetch: fetchB },
            });
            reloadedTab = createAuthStore({
              getClient: () => clientC as never,
              getProjectUrl: () => url,
              getStorage: () => storageC,
              addStorageListener: (fn) => addTabStorageListener('tabC', fn),
              tabId: 'tabC',
              syncGlobalStores: false,
            });
            reloadedTab.startAuth();
            await new Promise((resolve) => setTimeout(resolve, 15));
            expect(reloadedTab.getAuthSnapshot()).toMatchObject({
              status: 'signed-out',
              logoutFailed: false,
              logoutRevocationFailed: false,
            });
          } else {
            // Refocus check: Tab B remains cleanly signed out with login enabled
            expect(tabB.getAuthSnapshot().status).toBe('signed-out');
            expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
          }
        } else {
          // interleaving === 'tabB_logout_then_signin'
          // I2: Tab B actually performed global logout for the old session before sign-in
          expect(confirmedGlobalLogouts).toBeGreaterThanOrEqual(1);
          // I3: Tab A's older logout NEVER erased Tab B's newer session or coord!
          const storedAfter = JSON.parse(values.get(sdkKey) ?? 'null') as {
            access_token?: string;
          } | null;
          expect(storedAfter?.access_token).toBe('access-new-matrix');
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
          // Tab A must NOT stick in logoutFailed or logoutRevocationFailed
          expect(tabA.isAuthResolved()).toBe(true);
          expect(tabA.getAuthSnapshot().logoutFailed).toBe(false);
          expect(tabA.getAuthSnapshot().logoutRevocationFailed).toBe(false);

          if (postCheck === 'reload') {
            const storageC = makeTabStorage('tabC');
            const clientC = createClient(url, TEST_ANON_KEY, {
              auth: {
                storage: storageC,
                storageKey: sdkKey,
                persistSession: true,
                autoRefreshToken: false,
                detectSessionInUrl: false,
              },
              global: { fetch: fetchB },
            });
            reloadedTab = createAuthStore({
              getClient: () => clientC as never,
              getProjectUrl: () => url,
              getStorage: () => storageC,
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
            ).toBe('access-new-matrix');
          } else {
            // Refocus Tab B with its new session: stays owner cleanly
            const internalsB = clientB.auth as unknown as {
              _notifyAllSubscribers: (
                event: string,
                session: unknown,
                broadcast?: boolean,
              ) => Promise<void>;
            };
            await internalsB._notifyAllSubscribers(
              'SIGNED_IN',
              newSession,
              false,
            );
            await new Promise((resolve) => setTimeout(resolve, 15));
            expect(tabB.getAuthSnapshot().status).toBe('owner');
            expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
          }
        }
      } finally {
        tabA.resetAuthStore({ clearStorage: false });
        tabB.resetAuthStore({ clearStorage: false });
        reloadedTab?.resetAuthStore({ clearStorage: false });
      }
    },
  );
});
