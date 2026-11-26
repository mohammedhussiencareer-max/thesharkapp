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
import {
  applyPwaUpdate,
  resetPwaState,
  setPwaAuthResolved,
  setPwaTabActive,
  setTestWaitingWorker,
} from '@/lib/pwa';

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
});
