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
      expect(storage.getItem(MARKER_KEY)).toBeNull();
      expect(markerWrites).toHaveLength(2);
      expect(markerWrites[0]).not.toBe(markerWrites[1]);

      // Tab A's earlier call now fails after Tab B already completed logout.
      resolveTabASignOut({ error: new Error('older call failed') });
      await tabAPending;

      expect(storage.getItem(SDK_STORAGE_KEY)).toBeNull();
      expect(storage.getItem(MARKER_KEY)).toBeNull();
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
      const firstMarker = storage.getItem(MARKER_KEY);
      expect(firstMarker).toMatch(/^logout-\d+-.+/);

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
});
