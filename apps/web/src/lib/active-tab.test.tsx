import { createClient } from '@supabase/supabase-js';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InactiveTabNotice } from '@/auth/InactiveTabNotice';
import {
  createActiveTabController,
  getActiveTabLockName,
  type ActiveTabLockManager,
} from '@/lib/active-tab';
import { createAuthStore, getLogoutCoordStorageKey } from '@/lib/auth-store';
import { createHeldWriteStore, userStoragePrefix } from '@/lib/held-writes';
import {
  applyPwaUpdate,
  resetPwaState,
  setPwaAuthResolved,
  setPwaTabActive,
  setTestWaitingWorker,
} from '@/lib/pwa';
import { createManagedSupabaseClient } from '@/lib/supabase';

/**
 * Spec-faithful in-memory Web Locks manager supporting `ifAvailable` and
 * `steal: true` (which aborts previous holders with AbortError).
 */
function createStealableLockManager() {
  type HeldEntry = {
    abort: () => void;
    released: boolean;
  };
  const heldByName = new Map<string, Set<HeldEntry>>();
  const requestedCalls: Array<{
    name: string;
    options: { mode?: string; ifAvailable?: boolean; steal?: boolean };
  }> = [];

  const locks: ActiveTabLockManager = {
    request<T>(
      name: string,
      options: {
        mode?: 'exclusive' | 'shared';
        ifAvailable?: boolean;
        steal?: boolean;
      },
      callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
    ): Promise<T> {
      requestedCalls.push({ name, options });
      const currentSet = heldByName.get(name);
      const hasHeld = Boolean(currentSet && currentSet.size > 0);

      if (options.steal) {
        if (currentSet) {
          const toAbort = [...currentSet];
          currentSet.clear();
          heldByName.delete(name);
          for (const entry of toAbort) {
            entry.abort();
          }
        }
      } else if (hasHeld && options.ifAvailable) {
        return Promise.resolve().then(() => callback(null));
      }

      return new Promise<T>((resolveOuter, rejectOuter) => {
        let settled = false;
        const entry: HeldEntry = {
          released: false,
          abort: () => {
            if (settled) return;
            settled = true;
            entry.released = true;
            rejectOuter(
              new DOMException(
                "Lock broken by another request with the 'steal' option.",
                'AbortError',
              ),
            );
          },
        };
        let group = heldByName.get(name);
        if (!group) {
          group = new Set();
          heldByName.set(name, group);
        }
        group.add(entry);

        void Promise.resolve()
          .then(() =>
            callback({
              name,
              mode: options.mode ?? 'exclusive',
            }),
          )
          .then(
            (value) => {
              const g = heldByName.get(name);
              g?.delete(entry);
              if (g && g.size === 0) heldByName.delete(name);
              entry.released = true;
              if (!settled) {
                settled = true;
                resolveOuter(value);
              }
            },
            (err) => {
              const g = heldByName.get(name);
              g?.delete(entry);
              if (g && g.size === 0) heldByName.delete(name);
              entry.released = true;
              if (!settled) {
                settled = true;
                rejectOuter(
                  err instanceof Error ? err : new Error(String(err)),
                );
              }
            },
          );
      });
    },
  };

  return {
    locks,
    requestedCalls,
    heldCount: (name: string) => heldByName.get(name)?.size ?? 0,
  };
}

function makeJwt(sid: string, sub = 'owner-1', email = 'owner@example.test') {
  const enc = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
    sub,
    email,
    session_id: sid,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.sig`;
}

function makeSession(
  sid: string,
  sub = 'owner-1',
  email = 'owner@example.test',
) {
  return {
    access_token: makeJwt(sid, sub, email),
    refresh_token: `rt-${sid}`,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: sub,
      email,
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  };
}

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('active-tab leadership and InactiveTabNotice', () => {
  afterEach(() => {
    resetPwaState();
    vi.restoreAllMocks();
  });

  it('first tab acquires the exclusive lock with ifAvailable and becomes active; second tab becomes inactive; steal takes over and demotes the first tab', async () => {
    const projectUrl = 'https://leadership-test.example.test';
    const expectedLockName = getActiveTabLockName(projectUrl);
    expect(expectedLockName).toBe(
      `theshark:app:active-tab:v1:${encodeURIComponent(projectUrl)}`,
    );

    const { locks, requestedCalls, heldCount } = createStealableLockManager();
    const events: string[] = [];

    const tabA = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => projectUrl,
    });
    tabA.registerLifecycle({
      onBecomeActive: () => events.push('A:active'),
      onBecomeInactive: () => events.push('A:inactive'),
    });

    const tabB = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => projectUrl,
    });
    tabB.registerLifecycle({
      onBecomeActive: () => events.push('B:active'),
      onBecomeInactive: () => events.push('B:inactive'),
    });

    try {
      tabA.start();
      await vi.waitFor(() => {
        expect(tabA.getSnapshot().status).toBe('active');
      });
      expect(requestedCalls[0]).toEqual({
        name: expectedLockName,
        options: { mode: 'exclusive', ifAvailable: true },
      });
      expect(heldCount(expectedLockName)).toBe(1);

      tabB.start();
      await vi.waitFor(() => {
        expect(tabB.getSnapshot().status).toBe('inactive');
      });
      expect(tabA.isActive()).toBe(true);
      expect(tabB.isActive()).toBe(false);

      // Explicit takeover on Tab B uses { steal: true }.
      const tookOver = await tabB.takeOver();
      expect(tookOver).toBe(true);
      await vi.waitFor(() => {
        expect(tabA.getSnapshot().status).toBe('inactive');
        expect(tabB.getSnapshot().status).toBe('active');
      });
      expect(requestedCalls.at(-1)).toEqual({
        name: expectedLockName,
        options: { steal: true },
      });
      expect(heldCount(expectedLockName)).toBe(1);
      expect(events).toEqual([
        'A:active',
        'B:inactive',
        'A:inactive',
        'B:active',
      ]);

      // Tab A can take over back from Tab B.
      expect(await tabA.takeOver()).toBe(true);
      await vi.waitFor(() => {
        expect(tabA.getSnapshot().status).toBe('active');
        expect(tabB.getSnapshot().status).toBe('inactive');
      });
    } finally {
      tabA.dispose();
      tabB.dispose();
    }
  });

  it('runs as active when navigator.locks is unavailable or rejects before granting', async () => {
    const noLocks = createActiveTabController({
      getLocks: () => null,
      getProjectUrl: () => 'https://no-locks.example.test',
    });
    noLocks.start();
    expect(noLocks.getSnapshot().status).toBe('active');
    noLocks.dispose();

    const rejectingLocks: ActiveTabLockManager = {
      request: () =>
        Promise.reject(new DOMException('Denied', 'SecurityError')),
    };
    const rejected = createActiveTabController({
      getLocks: () => rejectingLocks,
      getProjectUrl: () => 'https://rejected-locks.example.test',
    });
    rejected.start();
    await vi.waitFor(() => {
      expect(rejected.getSnapshot().status).toBe('active');
    });
    rejected.dispose();
  });

  it('renders InactiveTabNotice with the exact Arabic text and takeover button', () => {
    const onTakeOver = vi.fn();
    render(<InactiveTabNotice onTakeOver={onTakeOver} />);

    expect(
      screen.getByRole('heading', { name: 'التطبيق مفتوح في تبويب تاني' }),
    ).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'استخدمه هنا' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onTakeOver).toHaveBeenCalledTimes(1);
  });

  it('blocks PWA update reload while tab is inactive and re-enables only when active', () => {
    const postMessage = vi.fn();
    const reload = vi.fn();
    setPwaAuthResolved(true);
    setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

    setPwaTabActive(false);
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    setPwaTabActive(true);
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });
});

describe('I6 real createClient path and takeover during auth operations', () => {
  const origLocksDesc = Object.getOwnPropertyDescriptor(navigator, 'locks');

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  afterEach(() => {
    if (origLocksDesc) {
      Object.defineProperty(navigator, 'locks', origLocksDesc);
    } else {
      Reflect.deleteProperty(navigator, 'locks');
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    resetPwaState();
  });

  it('I6 on real App + production supabase.ts: inactive tab never instantiates Supabase, makes zero fetch/storage writes, and takeover demotes the old tab immediately', async () => {
    const url = 'https://i6-real-client.example.test';
    const anonKey = 'anon-key-i6';
    const sdkKey = 'sb-i6-real-client-auth-token';
    vi.stubEnv('VITE_SUPABASE_URL', url);
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', anonKey);

    const { locks } = createStealableLockManager();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });

    // Simulate another tab already holding the active-tab lock before this tab boots.
    let releaseOtherTab: () => void = () => {};
    let otherTabBroken = false;
    const otherTabLockPromise = locks
      .request(
        getActiveTabLockName(url),
        { mode: 'exclusive', ifAvailable: true },
        (lock) => {
          expect(lock).not.toBeNull();
          return new Promise<void>((resolve) => {
            releaseOtherTab = resolve;
          });
        },
      )
      .catch(() => {
        otherTabBroken = true;
      });
    await Promise.resolve();

    // Seed a valid session in localStorage: the INACTIVE tab must NOT read/write it or fetch is_owner!
    const session = makeSession('sid-i6-1');
    localStorage.setItem(sdkKey, JSON.stringify(session));

    const fetchSpy = vi.fn<typeof fetch>((input) => {
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
    });
    vi.stubGlobal('fetch', fetchSpy);

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');

    const [supabaseMod, activeTabMod, authStoreMod, appMod] = await Promise.all(
      [
        import('@/lib/supabase'),
        import('@/lib/active-tab'),
        import('@/lib/auth-store'),
        import('@/App'),
      ],
    );

    try {
      // Importing App + supabase MUST NOT eagerly call createClient.
      expect(supabaseMod.hasInstantiatedSupabaseClient()).toBe(false);

      const view = render(<appMod.App />);

      // Tab boots INACTIVE: shows ONLY the full-screen notice and button.
      expect(
        await screen.findByRole('heading', {
          name: 'التطبيق مفتوح في تبويب تاني',
        }),
      ).toBeInTheDocument();
      const takeOverBtn = screen.getByRole('button', { name: 'استخدمه هنا' });
      expect(takeOverBtn).toBeEnabled();
      expect(
        screen.queryByRole('heading', { name: 'تسجيل الدخول' }),
      ).toBeNull();
      expect(screen.queryByText('owner@example.test')).toBeNull();

      // I6: ZERO Supabase client created, ZERO fetch calls, ZERO storage writes while inactive!
      expect(supabaseMod.hasInstantiatedSupabaseClient()).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(removeItemSpy).not.toHaveBeenCalled();

      // Click "استخدمه هنا" -> steals lock, aborts other tab, activates Supabase, loads owner home!
      fireEvent.click(takeOverBtn);
      await vi.waitFor(() => {
        expect(otherTabBroken).toBe(true);
      });
      await otherTabLockPromise;

      expect(await screen.findByText('owner@example.test')).toBeInTheDocument();
      expect(supabaseMod.hasInstantiatedSupabaseClient()).toBe(true);
      expect(fetchSpy).toHaveBeenCalled();

      // Now simulate another tab stealing the lock back -> THIS tab becomes inactive immediately!
      const staleClientRef = supabaseMod.activateSupabaseClient()!;
      const stopRefreshSpy = vi.spyOn(staleClientRef.auth, 'stopAutoRefresh');
      fetchSpy.mockClear();
      setItemSpy.mockClear();
      removeItemSpy.mockClear();

      let releaseNewOwner: () => void = () => {};
      const stealPromise = locks.request(
        getActiveTabLockName(url),
        { steal: true },
        (lock) => {
          expect(lock).not.toBeNull();
          return new Promise<void>((resolve) => {
            releaseNewOwner = resolve;
          });
        },
      );

      expect(
        await screen.findByRole('heading', {
          name: 'التطبيق مفتوح في تبويب تاني',
        }),
      ).toBeInTheDocument();
      expect(screen.queryByText('owner@example.test')).toBeNull();
      expect(stopRefreshSpy).toHaveBeenCalled();
      expect(supabaseMod.hasInstantiatedSupabaseClient()).toBe(false);
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(removeItemSpy).not.toHaveBeenCalled();

      // Even if a lingering reference tries to call fetch via the demoted client, I6 blocks it!
      const staleRpc = await staleClientRef.schema('app').rpc('is_owner');
      expect(staleRpc.error).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(setItemSpy).not.toHaveBeenCalled();
      expect(removeItemSpy).not.toHaveBeenCalled();

      view.unmount();
      releaseNewOwner();
      await stealPromise;
    } finally {
      releaseOtherTab();
      activeTabMod.resetActiveTab();
      authStoreMod.resetAuthStore();
      supabaseMod.deactivateSupabaseClient();
    }
  });

  it('takeover during sign-out (creds gone) stops the old tab without further writes and boots the new active tab in revocation_failed', async () => {
    const url = 'https://takeover-signout.example.test';
    const anonKey = 'anon-key-takeover-signout';
    const sdkKey = 'sb-takeover-signout-auth-token';
    const recordKey = getLogoutCoordStorageKey(url);
    const { locks } = createStealableLockManager();

    // Shared backing storage with per-tab write tracking.
    const backing = new Map<string, string>();
    const makeTrackedStorage = (
      isAllowed: () => boolean,
      onWrite: (op: string, k: string) => void,
    ): Storage => ({
      get length() {
        return backing.size;
      },
      clear() {
        if (!isAllowed()) return;
        backing.clear();
      },
      getItem(k: string) {
        return backing.get(k) ?? null;
      },
      key(i: number) {
        return [...backing.keys()][i] ?? null;
      },
      removeItem(k: string) {
        onWrite('removeItem', k);
        backing.delete(k);
      },
      setItem(k: string, v: string) {
        onWrite('setItem', k);
        backing.set(k, String(v));
      },
    });

    const session1 = makeSession('sid-so-1');
    backing.set(sdkKey, JSON.stringify(session1));

    let resolveTabALogout!: (res: Response) => void;
    let tabALogoutAborted = false;
    const tabAFetches: string[] = [];
    const tabAWritesAfterDemotion: string[] = [];
    let tabADemoted = false;

    const tabACtrl = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => url,
    });
    const tabBCtrl = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => url,
    });

    const tabAStorage = makeTrackedStorage(
      () => tabACtrl.isActive(),
      (op, k) => {
        if (tabADemoted) tabAWritesAfterDemotion.push(`${op}:${k}`);
      },
    );
    const tabBStorage = makeTrackedStorage(
      () => tabBCtrl.isActive(),
      () => {},
    );

    const clientA = createClient(url, anonKey, {
      auth: {
        storage: tabAStorage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input, init) => {
          const href = requestUrlOf(input);
          tabAFetches.push(href);
          if (href.includes('/rest/v1/rpc/is_owner')) {
            return Promise.resolve(
              new Response(JSON.stringify(true), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          if (href.includes('/auth/v1/logout')) {
            return new Promise<Response>((resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                tabALogoutAborted = true;
                reject(new DOMException('Aborted', 'AbortError'));
              });
              resolveTabALogout = resolve;
            });
          }
          return Promise.resolve(new Response(null, { status: 404 }));
        },
      },
    });

    const clientB = createClient(url, anonKey, {
      auth: {
        storage: tabBStorage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input) => {
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
              new Response(JSON.stringify(makeSession('sid-so-2')), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          return Promise.resolve(new Response(null, { status: 404 }));
        },
      },
    });

    const storeA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => tabAStorage,
      syncGlobalStores: false,
      initiallyActive: false,
    });
    const storeB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => tabBStorage,
      syncGlobalStores: false,
      initiallyActive: false,
    });

    tabACtrl.registerLifecycle({
      onBecomeActive: () => {
        storeA.activate();
        storeA.startAuth();
      },
      onBecomeInactive: () => {
        tabADemoted = true;
        storeA.deactivate();
      },
    });
    tabBCtrl.registerLifecycle({
      onBecomeActive: () => {
        storeB.activate();
        storeB.startAuth();
      },
      onBecomeInactive: () => {
        storeB.deactivate();
      },
    });

    try {
      tabACtrl.start();
      await vi.waitFor(() => {
        expect(storeA.getAuthSnapshot().status).toBe('owner');
      });
      tabBCtrl.start();
      await vi.waitFor(() => {
        expect(tabBCtrl.getSnapshot().status).toBe('inactive');
      });

      // Tab A initiates sign-out -> writes pending, removes sdkKey, holds /logout in flight.
      const signOutP = storeA.signOut();
      await vi.waitFor(() => {
        expect(tabAFetches.some((u) => u.includes('/auth/v1/logout'))).toBe(
          true,
        );
      });
      expect(backing.get(sdkKey)).toBeUndefined();
      expect(JSON.parse(backing.get(recordKey) ?? 'null')).toMatchObject({
        state: 'pending',
        sessionKey: 'sid:sid-so-1',
      });

      // Tab B takes over mid-sign-out!
      expect(await tabBCtrl.takeOver()).toBe(true);
      await vi.waitFor(() => {
        expect(tabACtrl.getSnapshot().status).toBe('inactive');
      });

      // Old tab's revocation is aborted, and even settling the promise causes ZERO storage writes!
      expect(tabALogoutAborted).toBe(true);
      resolveTabALogout(new Response(null, { status: 204 }));
      await signOutP;
      expect(tabAWritesAfterDemotion).toEqual([]);

      // New active tab sees pending + creds gone -> immediately revocation_failed (no retry token, login enabled)!
      expect(storeB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'revocation_failed',
        logoutFailed: false,
        logoutRevocationFailed: true,
        canRetryLogoutRevocation: false,
      });
      expect(storeB.isAuthResolved()).toBe(true);

      // New active tab can sign in cleanly.
      expect(
        await storeB.signIn('owner@example.test', 'ValidPassword123'),
      ).toBe('ok');
      await vi.waitFor(() => {
        expect(storeB.getAuthSnapshot().status).toBe('owner');
      });
      expect(backing.get(recordKey)).toBeUndefined();
    } finally {
      tabACtrl.dispose();
      tabBCtrl.dispose();
      storeA.resetAuthStore();
      storeB.resetAuthStore();
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
    }
  });

  it('takeover during sign-out (creds still present) boots the new active tab in local_failed and retries cleanly once storage recovers', async () => {
    const url = 'https://takeover-signout-creds.example.test';
    const anonKey = 'anon-key-takeover-signout-creds';
    const sdkKey = 'sb-takeover-signout-creds-auth-token';
    const recordKey = getLogoutCoordStorageKey(url);
    const { locks } = createStealableLockManager();

    const backing = new Map<string, string>();
    let blockSdkErase = true;
    const tabAWritesAfterDemotion: string[] = [];
    let tabADemoted = false;

    const makeStorage = (trackDemoted: boolean): Storage => ({
      get length() {
        return backing.size;
      },
      clear() {
        backing.clear();
      },
      getItem(k: string) {
        return backing.get(k) ?? null;
      },
      key(i: number) {
        return [...backing.keys()][i] ?? null;
      },
      removeItem(k: string) {
        if (trackDemoted && tabADemoted) {
          tabAWritesAfterDemotion.push(`removeItem:${k}`);
        }
        if (blockSdkErase && k === sdkKey) {
          throw new DOMException('Blocked remove', 'QuotaExceededError');
        }
        backing.delete(k);
      },
      setItem(k: string, v: string) {
        if (trackDemoted && tabADemoted) {
          tabAWritesAfterDemotion.push(`setItem:${k}`);
        }
        if (blockSdkErase && k === sdkKey) {
          throw new DOMException('Blocked overwrite', 'QuotaExceededError');
        }
        backing.set(k, String(v));
      },
    });

    backing.set(sdkKey, JSON.stringify(makeSession('sid-so-creds-1')));

    const tabACtrl = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => url,
    });
    const tabBCtrl = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => url,
    });
    const tabAStorage = makeStorage(true);
    const tabBStorage = makeStorage(false);

    let logoutCountB = 0;
    const makeClient = (storage: Storage, onLogout?: () => void) =>
      createClient(url, anonKey, {
        auth: {
          storage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          fetch: (input) => {
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
              onLogout?.();
              return Promise.resolve(new Response(null, { status: 204 }));
            }
            return Promise.resolve(new Response(null, { status: 404 }));
          },
        },
      });

    const clientA = makeClient(tabAStorage);
    const clientB = makeClient(tabBStorage, () => {
      logoutCountB += 1;
    });

    const storeA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => tabAStorage,
      syncGlobalStores: false,
      initiallyActive: false,
    });
    const storeB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => tabBStorage,
      syncGlobalStores: false,
      initiallyActive: false,
    });

    tabACtrl.registerLifecycle({
      onBecomeActive: () => {
        storeA.activate();
        storeA.startAuth();
      },
      onBecomeInactive: () => {
        tabADemoted = true;
        storeA.deactivate();
      },
    });
    tabBCtrl.registerLifecycle({
      onBecomeActive: () => {
        storeB.activate();
        storeB.startAuth();
      },
      onBecomeInactive: () => {
        storeB.deactivate();
      },
    });

    try {
      tabACtrl.start();
      await vi.waitFor(() => {
        expect(storeA.getAuthSnapshot().status).toBe('owner');
      });
      tabBCtrl.start();
      await vi.waitFor(() => {
        expect(tabBCtrl.getSnapshot().status).toBe('inactive');
      });

      // Tab A tries to sign out, writes durable pending/local_failed, but browser refuses erasing sdkKey.
      await storeA.signOut();
      expect(storeA.getAuthSnapshot().logoutPhase).toBe('local_failed');
      // Simulate pending still durable with credentials present (e.g., crash or takeover right before local_failed commit).
      backing.set(
        recordKey,
        JSON.stringify({
          attemptId: 1,
          state: 'pending',
          sessionKey: 'sid:sid-so-creds-1',
        }),
      );

      // Tab B takes over -> sees pending + credentials present -> conservative local_failed (never owner!).
      expect(await tabBCtrl.takeOver()).toBe(true);
      await vi.waitFor(() => {
        expect(tabACtrl.getSnapshot().status).toBe('inactive');
      });
      expect(tabAWritesAfterDemotion).toEqual([]);
      expect(storeB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
        logoutPending: false,
      });

      // Storage recovers -> owner retries sign-out in Tab B -> clears sdkKey + durable record and reaches clean login!
      blockSdkErase = false;
      await storeB.signOut();
      expect(logoutCountB).toBeGreaterThanOrEqual(1);
      expect(backing.get(sdkKey)).toBeUndefined();
      expect(backing.get(recordKey)).toBeUndefined();
      expect(storeB.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'idle',
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
      expect(storeB.isAuthResolved()).toBe(true);
    } finally {
      tabACtrl.dispose();
      tabBCtrl.dispose();
      storeA.resetAuthStore();
      storeB.resetAuthStore();
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
    }
  });

  it('takeover during sign-in stops the old tab so its late sign-in response never writes storage or revokes the new active tab session', async () => {
    const url = 'https://takeover-signin.example.test';
    const anonKey = 'anon-key-takeover-signin';
    const sdkKey = 'sb-takeover-signin-auth-token';
    const { locks } = createStealableLockManager();

    const backing = new Map<string, string>();
    const tabAWritesAfterDemotion: string[] = [];
    let tabADemoted = false;
    let resolveTabASignIn!: (res: Response) => void;
    let logoutCalledByA = false;

    const tabACtrl = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => url,
    });
    const tabBCtrl = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => url,
    });

    // Gate Tab A's storage just like production supabase.ts does.
    const tabAStorage: Storage = {
      get length() {
        return tabACtrl.isActive() ? backing.size : 0;
      },
      clear() {
        if (!tabACtrl.isActive()) return;
        backing.clear();
      },
      getItem(k: string) {
        return tabACtrl.isActive() ? (backing.get(k) ?? null) : null;
      },
      key(i: number) {
        return tabACtrl.isActive() ? ([...backing.keys()][i] ?? null) : null;
      },
      removeItem(k: string) {
        if (!tabACtrl.isActive()) return;
        if (tabADemoted) tabAWritesAfterDemotion.push(`removeItem:${k}`);
        backing.delete(k);
      },
      setItem(k: string, v: string) {
        if (!tabACtrl.isActive()) return;
        if (tabADemoted) tabAWritesAfterDemotion.push(`setItem:${k}`);
        backing.set(k, String(v));
      },
    };
    const tabBStorage: Storage = {
      get length() {
        return backing.size;
      },
      clear() {
        backing.clear();
      },
      getItem(k: string) {
        return backing.get(k) ?? null;
      },
      key(i: number) {
        return [...backing.keys()][i] ?? null;
      },
      removeItem(k: string) {
        backing.delete(k);
      },
      setItem(k: string, v: string) {
        backing.set(k, String(v));
      },
    };

    const clientA = createClient(url, anonKey, {
      auth: {
        storage: tabAStorage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input) => {
          const href = requestUrlOf(input);
          if (href.includes('/auth/v1/token?grant_type=password')) {
            return new Promise<Response>((resolve) => {
              resolveTabASignIn = resolve;
            });
          }
          if (href.includes('/auth/v1/logout')) {
            logoutCalledByA = true;
            return Promise.resolve(new Response(null, { status: 204 }));
          }
          return Promise.resolve(new Response(null, { status: 404 }));
        },
      },
    });
    const clientB = createClient(url, anonKey, {
      auth: {
        storage: tabBStorage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: (input) => {
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
              new Response(JSON.stringify(makeSession('sid-si-B')), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }
          return Promise.resolve(new Response(null, { status: 404 }));
        },
      },
    });

    const storeA = createAuthStore({
      getClient: () => clientA as never,
      getProjectUrl: () => url,
      getStorage: () => tabAStorage,
      syncGlobalStores: false,
      initiallyActive: false,
    });
    const storeB = createAuthStore({
      getClient: () => clientB as never,
      getProjectUrl: () => url,
      getStorage: () => tabBStorage,
      syncGlobalStores: false,
      initiallyActive: false,
    });

    tabACtrl.registerLifecycle({
      onBecomeActive: () => {
        storeA.activate();
        storeA.startAuth();
      },
      onBecomeInactive: () => {
        tabADemoted = true;
        storeA.deactivate();
      },
    });
    tabBCtrl.registerLifecycle({
      onBecomeActive: () => {
        storeB.activate();
        storeB.startAuth();
      },
      onBecomeInactive: () => {
        storeB.deactivate();
      },
    });

    try {
      tabACtrl.start();
      await vi.waitFor(() => {
        expect(storeA.getAuthSnapshot().status).toBe('signed-out');
      });
      tabBCtrl.start();
      await vi.waitFor(() => {
        expect(tabBCtrl.getSnapshot().status).toBe('inactive');
      });

      // Tab A starts sign-in (in flight).
      const signInAP = storeA.signIn('owner@example.test', 'ValidPassword123');
      await vi.waitFor(() => {
        expect(resolveTabASignIn).toBeDefined();
      });

      // Tab B takes over mid-sign-in and signs in cleanly as sid-si-B.
      expect(await tabBCtrl.takeOver()).toBe(true);
      await vi.waitFor(() => {
        expect(tabACtrl.getSnapshot().status).toBe('inactive');
      });
      expect(
        await storeB.signIn('owner@example.test', 'ValidPassword123'),
      ).toBe('ok');
      await vi.waitFor(() => {
        expect(storeB.getAuthSnapshot().status).toBe('owner');
      });

      // Now Tab A's stale sign-in response resolves -> MUST return 'failed',
      // write NOTHING to storage, never overwrite sid-si-B, and never call /logout!
      act(() => {
        resolveTabASignIn(
          new Response(JSON.stringify(makeSession('sid-si-A')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });
      expect(await signInAP).toBe('failed');
      expect(tabAWritesAfterDemotion).toEqual([]);
      expect(logoutCalledByA).toBe(false);
      expect(JSON.parse(backing.get(sdkKey) ?? '{}')).toMatchObject({
        refresh_token: 'rt-sid-si-B',
      });
      expect(storeB.getAuthSnapshot().status).toBe('owner');
    } finally {
      tabACtrl.dispose();
      tabBCtrl.dispose();
      storeA.resetAuthStore();
      storeB.resetAuthStore();
      await clientA.auth.stopAutoRefresh();
      await clientB.auth.stopAutoRefresh();
    }
  });

  it('DELTA-OT1 P1-1: demotion aborts in-flight refresh fetch and closes BroadcastChannel so a failing refresh in inactive Tab A never signs out active Tab B', async () => {
    const url = 'https://delta-ot1-p1-1-refresh.example.test';
    const anonKey = 'anon-key-delta-ot1-p1-1';
    const sdkKey = 'sb-delta-ot1-p1-1-refresh-auth-token';
    const { locks } = createStealableLockManager();

    // Real in-memory BroadcastChannel hub so undisposed GoTrueClients actually
    // broadcast SIGNED_OUT / SIGNED_IN across tabs!
    type BcListener = (ev: { data: unknown }) => void;
    const channelsByName = new Map<string, Set<FakeBc>>();
    const postedBroadcasts: Array<{ name: string; data: unknown }> = [];
    class FakeBc {
      readonly name: string;
      private readonly listeners = new Set<BcListener>();
      closed = false;
      constructor(name: string) {
        this.name = name;
        let group = channelsByName.get(name);
        if (!group) {
          group = new Set();
          channelsByName.set(name, group);
        }
        group.add(this);
      }
      addEventListener(type: string, fn: BcListener) {
        if (type === 'message') this.listeners.add(fn);
      }
      removeEventListener(type: string, fn: BcListener) {
        if (type === 'message') this.listeners.delete(fn);
      }
      postMessage(data: unknown) {
        if (this.closed) return;
        postedBroadcasts.push({ name: this.name, data });
        const group = channelsByName.get(this.name);
        if (!group) return;
        for (const peer of [...group]) {
          if (peer === this || peer.closed) continue;
          for (const fn of [...peer.listeners]) fn({ data });
        }
      }
      close() {
        this.closed = true;
        channelsByName.get(this.name)?.delete(this);
      }
    }
    const origBc = globalThis.BroadcastChannel;
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: FakeBc,
    });

    const backing = new Map<string, string>();
    backing.set(sdkKey, JSON.stringify(makeSession('sid-p1-1-A')));

    let tabADemoted = false;
    const tabAWritesAfterDemotion: string[] = [];
    const tabAStorage: Storage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k) => backing.get(k) ?? null,
      key: (i) => [...backing.keys()][i] ?? null,
      removeItem: (k) => {
        if (tabADemoted) tabAWritesAfterDemotion.push(`removeItem:${k}`);
        backing.delete(k);
      },
      setItem: (k, v) => {
        if (tabADemoted) tabAWritesAfterDemotion.push(`setItem:${k}`);
        backing.set(k, String(v));
      },
    };
    const tabBStorage: Storage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k) => backing.get(k) ?? null,
      key: (i) => [...backing.keys()][i] ?? null,
      removeItem: (k) => {
        backing.delete(k);
      },
      setItem: (k, v) => {
        backing.set(k, String(v));
      },
    };

    let tabARefreshSignal: AbortSignal | undefined;
    let resolveTabARefresh!: (res: Response) => void;
    const rawFetchA: typeof fetch = (input, init) => {
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
        tabARefreshSignal = init?.signal ?? undefined;
        // Intentionally do NOT auto-reject on abort so we ALSO prove that even
        // a late HTTP 400 response arriving after demotion is blocked by the
        // generation fetch wrapper and never triggers SIGNED_OUT broadcast!
        return new Promise<Response>((resolve) => {
          resolveTabARefresh = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const rawFetchB: typeof fetch = (input) => {
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
          new Response(JSON.stringify(makeSession('sid-p1-1-B')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const managedA = createManagedSupabaseClient({
      url,
      anonKey,
      storageKey: sdkKey,
      getStorage: () => tabAStorage,
      getFetch: () => rawFetchA,
    });
    managedA.deactivate();
    const managedB = createManagedSupabaseClient({
      url,
      anonKey,
      storageKey: sdkKey,
      getStorage: () => tabBStorage,
      getFetch: () => rawFetchB,
    });
    managedB.deactivate();

    const storeA = createAuthStore({
      getClient: () => managedA.getClient(),
      getProjectUrl: () => url,
      getStorage: () => tabAStorage,
      storageKey: sdkKey,
      syncGlobalStores: false,
      initiallyActive: false,
    });
    const storeB = createAuthStore({
      getClient: () => managedB.getClient(),
      getProjectUrl: () => url,
      getStorage: () => tabBStorage,
      storageKey: sdkKey,
      syncGlobalStores: false,
      initiallyActive: false,
    });

    const tabACtrl = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => url,
    });
    const tabBCtrl = createActiveTabController({
      getLocks: () => locks,
      getProjectUrl: () => url,
    });

    tabACtrl.registerLifecycle({
      onBecomeActive: () => {
        managedA.enable();
        storeA.activate();
        storeA.startAuth();
      },
      onBecomeInactive: () => {
        tabADemoted = true;
        storeA.deactivate();
        managedA.deactivate();
      },
    });
    tabBCtrl.registerLifecycle({
      onBecomeActive: () => {
        managedB.enable();
        storeB.activate();
        storeB.startAuth();
      },
      onBecomeInactive: () => {
        storeB.deactivate();
        managedB.deactivate();
      },
    });

    try {
      tabACtrl.start();
      await vi.waitFor(() => {
        expect(storeA.getAuthSnapshot().status).toBe('owner');
      });
      tabBCtrl.start();
      await vi.waitFor(() => {
        expect(tabBCtrl.getSnapshot().status).toBe('inactive');
      });

      // Start an in-flight token refresh in Tab A on the production managed client.
      const clientA = managedA.getClient()!;
      const refreshPromise = clientA.auth.refreshSession();
      await vi.waitFor(() => {
        expect(resolveTabARefresh).toBeDefined();
      });
      expect(tabARefreshSignal?.aborted).toBe(false);

      // Tab B takes over and signs in as a brand-new session sid-p1-1-B!
      expect(await tabBCtrl.takeOver()).toBe(true);
      await vi.waitFor(() => {
        expect(tabACtrl.getSnapshot().status).toBe('inactive');
      });

      // P1-1 assertion 1: Tab A's in-flight refresh fetch AbortSignal MUST be aborted!
      expect(tabARefreshSignal?.aborted).toBe(true);
      // P1-1 assertion 2: Tab A's BroadcastChannel MUST be closed & nulled!
      const authA = clientA.auth as unknown as { broadcastChannel: unknown };
      expect(authA.broadcastChannel).toBeNull();

      expect(
        await storeB.signIn('owner@example.test', 'ValidPassword123'),
      ).toBe('ok');
      await vi.waitFor(() => {
        expect(storeB.getAuthSnapshot().status).toBe('owner');
      });

      postedBroadcasts.length = 0;

      // Now Tab A's stale refresh resolves with HTTP 400 refresh_token_not_found!
      resolveTabARefresh(
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'refresh_token_not_found',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
      await refreshPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 30));

      // P1-1 assertion 3: ZERO SIGNED_OUT broadcast from inactive Tab A,
      // ZERO storage writes after demotion, and Tab B stays owner on sid-p1-1-B!
      expect(
        postedBroadcasts.some(
          (m) => (m.data as { event?: string })?.event === 'SIGNED_OUT',
        ),
      ).toBe(false);
      expect(tabAWritesAfterDemotion).toEqual([]);
      expect(storeB.getAuthSnapshot().status).toBe('owner');
      expect(JSON.parse(backing.get(sdkKey) ?? '{}')).toMatchObject({
        refresh_token: 'rt-sid-p1-1-B',
      });
    } finally {
      tabACtrl.dispose();
      tabBCtrl.dispose();
      storeA.resetAuthStore();
      storeB.resetAuthStore();
      managedA.deactivate();
      managedB.deactivate();
      Object.defineProperty(globalThis, 'BroadcastChannel', {
        configurable: true,
        writable: true,
        value: origBc,
      });
    }
  });

  it('DELTA-OT1 P2-1: queued Web Lock clearResolvedHeldWritesForUser never writes/removes storage after Tab A is demoted by takeover', async () => {
    const url = 'https://delta-ot1-p2-1.example.test';
    const userId = 'owner-p2-1';
    const postedKey = `${userStoragePrefix(userId, url)}posted:purchase%3Anew:req-1`;
    const subjectLockName = `${userStoragePrefix(userId, url)}purchase%3Anew`;

    // Lock manager supporting BOTH stealable leadership lock AND queued exclusive subject locks!
    type QueuedWaiter = { grant: () => void };
    const subjectHeld = new Set<string>();
    const subjectWaiters = new Map<string, QueuedWaiter[]>();
    const { locks: activeTabLocks } = createStealableLockManager();

    const combinedLocks = {
      request<T>(
        name: string,
        options: {
          mode?: 'exclusive' | 'shared';
          ifAvailable?: boolean;
          steal?: boolean;
        },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        if (name.startsWith('theshark:app:active-tab:')) {
          return activeTabLocks.request(name, options, callback);
        }
        const run = async (): Promise<T> => {
          try {
            return await callback({ name, mode: options.mode ?? 'exclusive' });
          } finally {
            subjectHeld.delete(name);
            const q = subjectWaiters.get(name);
            const next = q?.shift();
            if (next) {
              subjectHeld.add(name);
              next.grant();
            }
          }
        };
        if (!subjectHeld.has(name)) {
          subjectHeld.add(name);
          return run();
        }
        if (options.ifAvailable) {
          return Promise.resolve().then(() => callback(null));
        }
        return new Promise<T>((resolve, reject) => {
          let q = subjectWaiters.get(name);
          if (!q) {
            q = [];
            subjectWaiters.set(name, q);
          }
          q.push({
            grant: () => {
              run().then(resolve, reject);
            },
          });
        });
      },
    };

    const backing = new Map<string, string>();
    backing.set(
      postedKey,
      JSON.stringify({
        v: 1,
        subject: 'purchase:new',
        requestId: 'req-1',
        claimId: 'claim-1',
        phase: 'posted_reload',
        payload: {},
      }),
    );

    let tabADemoted = false;
    const tabAStorageWritesAfterDemotion: string[] = [];
    const tabAStorage: Storage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k) => backing.get(k) ?? null,
      key: (i) => [...backing.keys()][i] ?? null,
      removeItem: (k) => {
        if (tabADemoted) {
          tabAStorageWritesAfterDemotion.push(`removeItem:${k}`);
        }
        backing.delete(k);
      },
      setItem: (k, v) => {
        if (tabADemoted) {
          tabAStorageWritesAfterDemotion.push(`setItem:${k}`);
        }
        backing.set(k, String(v));
      },
    };

    const hwA = createHeldWriteStore({
      getStorage: () => tabAStorage,
      getProjectUrl: () => url,
      getLocks: () => combinedLocks,
    });
    const tabACtrl = createActiveTabController({
      getLocks: () => combinedLocks,
      getProjectUrl: () => url,
    });
    const tabBCtrl = createActiveTabController({
      getLocks: () => combinedLocks,
      getProjectUrl: () => url,
    });

    tabACtrl.registerLifecycle({
      onBecomeActive: () => hwA.setHeldWritesTabActive(true),
      onBecomeInactive: () => {
        tabADemoted = true;
        hwA.setHeldWritesTabActive(false);
      },
    });

    let releaseSubjectBlocker!: () => void;
    const blockerP = combinedLocks.request(
      subjectLockName,
      { mode: 'exclusive' },
      () =>
        new Promise<void>((resolve) => {
          releaseSubjectBlocker = resolve;
        }),
    );

    try {
      tabACtrl.start();
      await vi.waitFor(() => {
        expect(tabACtrl.isActive()).toBe(true);
      });
      tabBCtrl.start();
      await vi.waitFor(() => {
        expect(tabBCtrl.getSnapshot().status).toBe('inactive');
      });

      hwA.setHeldWriteUser(userId);
      // Tab A signs out -> queues pruneUnderSubjectLock behind the held subject lock.
      hwA.setWritesLocked(true);
      hwA.bumpSessionGeneration();
      hwA.clearResolvedHeldWritesForUser(userId, url);
      hwA.setHeldWriteUser(null);

      // Before the subject lock releases, Tab B takes over -> Tab A becomes inactive!
      expect(await tabBCtrl.takeOver()).toBe(true);
      await vi.waitFor(() => {
        expect(tabACtrl.getSnapshot().status).toBe('inactive');
      });

      // Now release the subject lock so Tab A's queued prune callback fires while Tab A is INACTIVE!
      releaseSubjectBlocker();
      await blockerP;
      await new Promise((r) => setTimeout(r, 20));

      // P2-1 / I6: Inactive Tab A MUST NOT remove postedKey from localStorage!
      expect(tabAStorageWritesAfterDemotion).toEqual([]);
      expect(backing.has(postedKey)).toBe(true);
    } finally {
      tabACtrl.dispose();
      tabBCtrl.dispose();
      hwA.dispose();
    }
  });

  it('DELTA-OT1 P2-2: boot reconciles durable logout records BEFORE GoTrueClient refreshes expired tokens, and auto-refresh stays stopped in local_failed', async () => {
    vi.useFakeTimers();
    const url = 'https://delta-ot1-p2-2.example.test';
    const anonKey = 'anon-key-delta-ot1-p2-2';
    const sdkKey = 'sb-delta-ot1-p2-2-auth-token';
    const recordKey = getLogoutCoordStorageKey(url);

    // Expired access token (past EXPIRY_MARGIN_MS) that GoTrueClient WOULD try
    // to refresh if constructed with autoRefreshToken: true before reconciliation!
    const expiredSession = {
      ...makeSession('sid-p2-2-expired'),
      expires_at: Math.floor(Date.now() / 1000) - 60,
    };

    const backing = new Map<string, string>();
    let blockSdkErase = true;
    const storage: Storage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k) => backing.get(k) ?? null,
      key: (i) => [...backing.keys()][i] ?? null,
      removeItem: (k) => {
        if (blockSdkErase && k === sdkKey) {
          throw new DOMException('Blocked remove', 'QuotaExceededError');
        }
        backing.delete(k);
      },
      setItem: (k, v) => {
        if (blockSdkErase && k === sdkKey) {
          throw new DOMException('Blocked overwrite', 'QuotaExceededError');
        }
        backing.set(k, String(v));
      },
    };

    let refreshFetchCount = 0;
    const rawFetch: typeof fetch = (input) => {
      const href = requestUrlOf(input);
      if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
        refreshFetchCount += 1;
        return Promise.resolve(
          new Response(JSON.stringify(makeSession('sid-p2-2-expired')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
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

    // Part A: Boot with durable `local_failed` + unremovable expired sdkKey.
    backing.set(sdkKey, JSON.stringify(expiredSession));
    backing.set(
      recordKey,
      JSON.stringify({
        attemptId: 1,
        state: 'local_failed',
        sessionKey: 'sid:sid-p2-2-expired',
      }),
    );

    const managedA = createManagedSupabaseClient({
      url,
      anonKey,
      storageKey: sdkKey,
      getStorage: () => storage,
      getFetch: () => rawFetch,
    });
    const storeA = createAuthStore({
      getClient: () => managedA.getClient(),
      getProjectUrl: () => url,
      getStorage: () => storage,
      storageKey: sdkKey,
      syncGlobalStores: false,
    });

    try {
      storeA.startAuth();
      expect(storeA.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPhase: 'local_failed',
        logoutFailed: true,
      });
      // Client was NOT eagerly constructed before reconciliation!
      expect(managedA.hasInstantiatedClient()).toBe(false);

      // Advance fake timers 95 seconds (3× the 30 s auto-refresh ticker) -> ZERO refresh fetches!
      await vi.advanceTimersByTimeAsync(95_000);
      expect(refreshFetchCount).toBe(0);

      // Part B: Boot with durable `revocation_failed` + removable expired sdkKey.
      storeA.resetAuthStore({ clearStorage: false });
      managedA.deactivate();
      blockSdkErase = false;
      backing.set(sdkKey, JSON.stringify(expiredSession));
      backing.set(
        recordKey,
        JSON.stringify({
          attemptId: 2,
          state: 'revocation_failed',
          sessionKey: 'sid:sid-p2-2-expired',
        }),
      );

      const managedB = createManagedSupabaseClient({
        url,
        anonKey,
        storageKey: sdkKey,
        getStorage: () => storage,
        getFetch: () => rawFetch,
      });
      const storeB = createAuthStore({
        getClient: () => managedB.getClient(),
        getProjectUrl: () => url,
        getStorage: () => storage,
        storageKey: sdkKey,
        syncGlobalStores: false,
      });

      try {
        storeB.startAuth();
        // sdkKey was evicted BEFORE GoTrueClient initialized -> ZERO refresh fetches!
        expect(backing.get(sdkKey)).toBeUndefined();
        expect(storeB.getAuthSnapshot()).toMatchObject({
          status: 'signed-out',
          logoutPhase: 'revocation_failed',
          logoutRevocationFailed: true,
        });
        await vi.advanceTimersByTimeAsync(95_000);
        expect(refreshFetchCount).toBe(0);
      } finally {
        storeB.resetAuthStore({ clearStorage: false });
        managedB.deactivate();
      }

      // Part C: Mid-session sign-out landing in local_failed stops running auto-refresh!
      backing.clear();
      const nearExpirySession = {
        ...makeSession('sid-p2-2-live'),
        expires_at: Math.floor(Date.now() / 1000) + 120,
      };
      backing.set(sdkKey, JSON.stringify(nearExpirySession));

      const managedC = createManagedSupabaseClient({
        url,
        anonKey,
        storageKey: sdkKey,
        getStorage: () => storage,
        getFetch: () => rawFetch,
      });
      const storeC = createAuthStore({
        getClient: () => managedC.getClient(),
        getProjectUrl: () => url,
        getStorage: () => storage,
        storageKey: sdkKey,
        syncGlobalStores: false,
      });

      try {
        storeC.startAuth();
        await vi.advanceTimersByTimeAsync(50);
        expect(storeC.getAuthSnapshot().status).toBe('owner');

        // Block erase and attempt sign-out -> lands in local_failed and stops auto-refresh!
        blockSdkErase = true;
        await storeC.signOut();
        expect(storeC.getAuthSnapshot().logoutPhase).toBe('local_failed');
        refreshFetchCount = 0;

        // Advance past expiry + multiple 30 s ticker intervals -> ZERO refresh fetches!
        await vi.advanceTimersByTimeAsync(150_000);
        expect(refreshFetchCount).toBe(0);
      } finally {
        storeC.resetAuthStore({ clearStorage: false });
        managedC.deactivate();
      }
    } finally {
      storeA.resetAuthStore({ clearStorage: false });
      managedA.deactivate();
      vi.useRealTimers();
    }
  });
});
