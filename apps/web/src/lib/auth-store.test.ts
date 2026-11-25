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

            // I4 + I2 unconditionally on Tab B (NO isQuotaOutcome skip!)
            if (storageOrder === 'dropped') {
              tabB.isAuthResolved();
            }
            await vi.waitFor(() => {
              expect(tabB.getAuthSnapshot().status).toBe('signed-out');
            });
            expect(tabB.getAuthSnapshot().logoutFailed).toBe(false);
            expect(tabB.getAuthSnapshot().logoutPending).toBe(false);
            expect(tabB.getAuthSnapshot().logoutRevocationFailed).toBe(
              expectsRevocationFailure,
            );
          }

          // I1 + I2 post-check: reload vs refocus unconditionally (NO skips!)
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
              // Same-tab reload preserves sessionStorageA!
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
                expectsRevocationFailure,
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
        await vi.advanceTimersByTimeAsync(20);

        expect(reloadedTab.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'revocation_failed',
          logoutPending: false,
          logoutFailed: false,
          logoutRevocationFailed: true,
          canRetryLogoutRevocation: false,
        });
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
