import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginHeldWrite,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWritesForUser,
  clearPostedReload,
  createHeldWriteStore,
  getHeldWrite,
  hasAnyHeldWrite,
  hasPostedReload,
  isCurrentWriteSession,
  listHeldWritesByPrefix,
  putHeldWrite,
  rehydrateHeldWrites,
  rehydrateHeldWritesAsync,
  resetHeldWritesStore,
  setHeldWritePhase,
  setHeldWriteUser,
  updateHeldWritePayload,
  userStoragePrefix,
} from '@/lib/held-writes';
import {
  getAuthSnapshot,
  isAuthResolved,
  resetAuthStore,
  signOut,
  startAuth,
} from '@/lib/auth-store';
import {
  applyPwaUpdate,
  isPwaLogoutPending,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import { makeAuditedLocks } from '@/test/held-write-locks';

type Session = {
  user: { id: string; email: string };
  access_token?: string;
  refresh_token?: string;
} | null;

const authMock = vi.hoisted(() => ({
  session: null as Session,
  listeners: [] as Array<(event: string, session: Session) => void>,
}));

vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>();
  return {
    ...actual,
    supabase: {
      auth: {
        onAuthStateChange: (
          callback: (event: string, session: Session) => void,
        ) => {
          authMock.listeners.push(callback);
          callback('INITIAL_SESSION', authMock.session);
          return {
            data: {
              subscription: {
                unsubscribe: () => {
                  const index = authMock.listeners.indexOf(callback);
                  if (index >= 0) authMock.listeners.splice(index, 1);
                },
              },
            },
          };
        },
        signInWithPassword: () =>
          Promise.resolve({ data: { user: null, session: null }, error: null }),
        signOut: () => {
          authMock.session = null;
          for (const listener of [...authMock.listeners]) {
            listener('SIGNED_OUT', null);
          }
          return Promise.resolve({ error: null });
        },
      },
      schema: () => ({
        rpc: () => Promise.resolve({ data: true, error: null }),
      }),
    },
  };
});

describe('held-writes store', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55421');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    localStorage.clear();
    authMock.session = null;
    authMock.listeners.splice(0, authMock.listeners.length);
    resetAuthStore();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    localStorage.clear();
    resetAuthStore();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
  });

  it('keys records by project URL and user id', () => {
    setHeldWriteUser('user-a');
    beginHeldWrite('count:daily', (requestId) => ({ requestId, qty: '7' }), {
      kind: 'count',
    });

    setHeldWriteUser('user-b');
    expect(getHeldWrite('count:daily')).toBeNull();
    beginHeldWrite('count:daily', (requestId) => ({ requestId, qty: '3' }), {
      kind: 'count',
    });

    // Different project URL isolates storage completely.
    vi.stubEnv('VITE_SUPABASE_URL', 'https://other.supabase.co');
    rehydrateHeldWrites();
    expect(getHeldWrite('count:daily')).toBeNull();

    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55421');
    setHeldWriteUser('user-a');
    expect(getHeldWrite<{ qty: string }>('count:daily')?.payload.qty).toBe('7');
  });

  it('promotes inflight to unknown on reload without auto-sending', () => {
    setHeldWriteUser('user-a');
    const created = beginHeldWrite(
      'purchase:new',
      (requestId) => ({ requestId, supplier: 'مورد' }),
      { kind: 'purchase' },
    );
    expect(created.phase).toBe('inflight');

    // Simulate reload: wipe in-memory map and rehydrate from localStorage.
    rehydrateHeldWrites();
    const restored = getHeldWrite<{ requestId: string; supplier: string }>(
      'purchase:new',
    );
    expect(restored).not.toBeNull();
    expect(restored?.phase).toBe('unknown');
    expect(restored?.requestId).toBe(created.requestId);
    expect(restored?.payload).toEqual(created.payload);

    // Persisted value was also updated to `unknown`.
    const raw = localStorage.getItem(
      `${userStoragePrefix('user-a')}${encodeURIComponent('purchase:new')}`,
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}')).toMatchObject({
      phase: 'unknown',
      requestId: created.requestId,
    });
  });

  it('keeps waiting_for_sync and posted_reload across reloads until cleared', async () => {
    setHeldWriteUser('user-a');
    putHeldWrite('count:daily', {
      requestId: 'req-wait',
      payload: { requestId: 'req-wait', lines: [] },
      phase: 'waiting_for_sync',
      kind: 'count',
    });
    putHeldWrite('sort:new', {
      requestId: 'req-sort',
      payload: { requestId: 'req-sort', qtyTaken: '10' },
      phase: 'inflight',
      kind: 'sort',
    });
    setHeldWritePhase('sort:new', 'req-sort', 'posted_reload');

    rehydrateHeldWrites();
    expect(getHeldWrite('count:daily')?.phase).toBe('waiting_for_sync');
    expect(hasPostedReload('sort:new')).toBe(true);
    // posted_reload drops the payload so no stale data/money lingers in storage.
    expect(getHeldWrite('sort:new')?.payload).toBeNull();
    expect(hasAnyHeldWrite()).toBe(true);

    // clearPostedReload clears only posted_reload, never waiting_for_sync.
    await clearPostedReload('count:daily');
    expect(getHeldWrite('count:daily')?.phase).toBe('waiting_for_sync');

    await clearPostedReload('sort:new');
    expect(getHeldWrite('sort:new')).toBeNull();
  });

  it('sign-out removes resolved markers for that user while keeping unresolved pins durable per user and isolated from other users', async () => {
    localStorage.setItem('unrelated-key', 'keep-me');

    setHeldWriteUser('user-b');
    beginHeldWrite('count:daily', (requestId) => ({ requestId, qty: '9' }));

    authMock.session = { user: { id: 'user-a', email: 'a@theshark.test' } };
    startAuth();
    const countA = beginHeldWrite('count:daily', (requestId) => ({
      requestId,
      qty: '4',
    }));
    const expenseA = beginHeldWrite('expense:new', (requestId) => ({
      requestId,
      amount: '50',
    }));
    putHeldWrite('sort:new', {
      requestId: 'req-sort-resolved',
      payload: null,
      phase: 'posted_reload',
      kind: 'sort',
    });

    expect(
      Object.keys(localStorage).some((k) =>
        k.startsWith(userStoragePrefix('user-a')),
      ),
    ).toBe(true);
    expect(
      Object.keys(localStorage).some((k) =>
        k.startsWith(userStoragePrefix('user-b')),
      ),
    ).toBe(true);

    await signOut();

    // User A's committed posted_reload marker is removed on sign-out,
    // while unresolved pins remain durable under User A's key prefix.
    expect(
      localStorage.getItem(
        `${userStoragePrefix('user-a')}posted:${encodeURIComponent('sort:new')}:${encodeURIComponent('req-sort-resolved')}`,
      ),
    ).toBeNull();
    expect(
      JSON.parse(
        localStorage.getItem(
          `${userStoragePrefix('user-a')}${encodeURIComponent('count:daily')}`,
        ) ?? 'null',
      ),
    ).toMatchObject({ requestId: countA.requestId });
    expect(
      JSON.parse(
        localStorage.getItem(
          `${userStoragePrefix('user-a')}${encodeURIComponent('expense:new')}`,
        ) ?? 'null',
      ),
    ).toMatchObject({ requestId: expenseA.requestId });
    // User B's keys and unrelated keys remain untouched.
    expect(
      Object.keys(localStorage).some((k) =>
        k.startsWith(userStoragePrefix('user-b')),
      ),
    ).toBe(true);
    expect(localStorage.getItem('unrelated-key')).toBe('keep-me');

    // Signed-out / dead session exposes nothing and stores nothing.
    expect(getHeldWrite('count:daily')).toBeNull();
    beginHeldWrite('count:daily', (requestId) => ({ requestId, qty: '1' }));
    expect(getHeldWrite('count:daily')).toBeNull();

    // Another user signing in sees only their own pins, never User A's.
    setHeldWriteUser('user-b');
    expect(getHeldWrite<{ qty: string }>('count:daily')?.payload.qty).toBe('9');
    expect(getHeldWrite('expense:new')).toBeNull();

    // Explicit cleanup helper also isolates by user.
    clearHeldWritesForUser('user-b');
    expect(
      Object.keys(localStorage).some((k) =>
        k.startsWith(userStoragePrefix('user-b')),
      ),
    ).toBe(false);
    expect(
      localStorage.getItem(
        `${userStoragePrefix('user-a')}${encodeURIComponent('count:daily')}`,
      ),
    ).not.toBeNull();
  });

  it('P2-4: degrades safely on reads when localStorage throws or has corrupt data, and reports write failure so writers refuse to send', async () => {
    const { HeldWriteStorageError, tryPutHeldWrite } =
      await import('@/lib/held-writes');
    setHeldWriteUser('user-a');
    localStorage.setItem(
      `${userStoragePrefix('user-a')}corrupt`,
      '{not-valid-json',
    );
    localStorage.setItem(
      `${userStoragePrefix('user-a')}bad-shape`,
      JSON.stringify({ v: 99, subject: 'x' }),
    );
    expect(() => rehydrateHeldWrites()).not.toThrow();
    expect(hasAnyHeldWrite()).toBe(false);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });

    // Reads never throw.
    expect(() => getHeldWrite('count:daily')).not.toThrow();
    expect(hasAnyHeldWrite()).toBe(false);

    // Durable write creation reports failure instead of silently dropping protection.
    expect(() =>
      beginHeldWrite('count:daily', (requestId) => ({
        requestId,
        qty: '5',
      })),
    ).toThrow(HeldWriteStorageError);
    expect(
      tryPutHeldWrite('count:daily', {
        requestId: 'req-fail',
        payload: { qty: '5' },
        phase: 'inflight',
      }),
    ).toEqual({ ok: false, reason: 'storage' });
    expect(getHeldWrite('count:daily')).toBeNull();
  });

  it('P2-3: disables __local__ fallback when allowTestLocalUser is false (production build behavior)', async () => {
    const { createHeldWriteStore } = await import('@/lib/held-writes');
    const prodStore = createHeldWriteStore({ allowTestLocalUser: false });
    try {
      expect(
        prodStore.tryBeginHeldWrite('count:daily', (requestId) => ({
          requestId,
        })),
      ).toEqual({ ok: false, reason: 'signed_out' });
      expect(prodStore.getHeldWrite('count:daily')).toBeNull();
      expect(localStorage.length).toBe(0);

      prodStore.setHeldWriteUser('real-user-id');
      const started = prodStore.tryBeginHeldWrite(
        'count:daily',
        (requestId) => ({
          requestId,
        }),
      );
      expect(started.ok).toBe(true);
    } finally {
      prodStore.dispose();
    }
  });

  it('provides an extension point with kind and payload updates for future pins', () => {
    setHeldWriteUser('user-a');
    const pin = beginHeldWrite(
      'future:pin:1',
      (requestId) => ({ clientId: requestId, step: 1 }),
      { kind: 'future_extension' },
    );
    updateHeldWritePayload('future:pin:1', pin.requestId, {
      clientId: pin.requestId,
      step: 2,
    });
    rehydrateHeldWrites();
    const list = listHeldWritesByPrefix<{ clientId: string; step: number }>(
      'future:pin:',
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'future_extension',
      phase: 'unknown',
      payload: { clientId: pin.requestId, step: 2 },
    });
  });

  it('P1-1: two tabs sharing localStorage cannot overwrite or clear each other pins and sync on storage event', () => {
    const tab1 = createHeldWriteStore();
    const tab2 = createHeldWriteStore();
    const tab3 = createHeldWriteStore();
    try {
      tab1.setHeldWriteUser('user-a');
      tab2.setHeldWriteUser('user-a');

      // Tab 1 writes and marks a purchase pin unknown.
      const pin1 = tab1.putHeldWrite('purchase:new', {
        requestId: 'req-tab-1',
        payload: { requestId: 'req-tab-1', supplier: 'مورد 1' },
        phase: 'unknown',
        kind: 'purchase',
      });
      expect(pin1.requestId).toBe('req-tab-1');

      // Stale Tab 2 (not yet refreshed) tries to overwrite with a new requestId: must NOT overwrite.
      const conflict = tab2.tryPutHeldWrite('purchase:new', {
        requestId: 'req-tab-2',
        payload: { requestId: 'req-tab-2', supplier: 'مورد 2' },
        phase: 'inflight',
        kind: 'purchase',
      });
      expect(conflict).toMatchObject({ ok: false, reason: 'conflict' });

      const rawAfterPut = localStorage.getItem(
        `${userStoragePrefix('user-a')}${encodeURIComponent('purchase:new')}`,
      );
      expect(JSON.parse(rawAfterPut ?? '{}')).toMatchObject({
        requestId: 'req-tab-1',
        phase: 'unknown',
      });

      // Stale Tab 2 tries to clear with its own requestId: must NOT remove Tab 1's pin.
      tab2.clearHeldWrite('purchase:new', 'req-tab-2');
      const rawAfterClear = localStorage.getItem(
        `${userStoragePrefix('user-a')}${encodeURIComponent('purchase:new')}`,
      );
      expect(rawAfterClear).not.toBeNull();
      expect(JSON.parse(rawAfterClear ?? '{}')).toMatchObject({
        requestId: 'req-tab-1',
      });

      // Tab 3 hydrates empty, then Tab 1 writes a count pin and clears purchase pin.
      tab1.clearHeldWrite('purchase:new', 'req-tab-1');
      tab3.setHeldWriteUser('user-a');
      expect(tab3.hasAnyHeldWrite()).toBe(false);
      tab1.putHeldWrite('count:daily', {
        requestId: 'req-count-1',
        payload: { requestId: 'req-count-1' },
        phase: 'unknown',
        kind: 'count',
      });
      // Tab 3 checks hasAnyHeldWrite against storage directly even before storage event.
      expect(tab3.hasAnyHeldWrite()).toBe(true);

      // Storage event refreshes Tab 3's in-memory view without needing rehydrate.
      const listener = vi.fn();
      const unsub = tab3.subscribeHeldWritesStore(listener);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: `${userStoragePrefix('user-a')}${encodeURIComponent('count:daily')}`,
        }),
      );
      expect(listener).toHaveBeenCalled();
      expect(tab3.getHeldWrite('count:daily')?.requestId).toBe('req-count-1');
      unsub();
    } finally {
      tab1.dispose();
      tab2.dispose();
      tab3.dispose();
    }
  });

  it('P2-3: signOut locks writes immediately before async auth.signOut resolves', async () => {
    let resolveSignOut: () => void = () => undefined;
    const supabaseMod = await import('@/lib/supabase');
    const signOutSpy = vi
      .spyOn(supabaseMod.supabase!.auth, 'signOut')
      .mockImplementationOnce(
        () =>
          new Promise<{ error: null }>((resolve) => {
            resolveSignOut = () => resolve({ error: null });
          }),
      );

    authMock.session = { user: { id: 'user-a', email: 'a@theshark.test' } };
    startAuth();

    const pending = signOut();
    // Immediately after calling signOut (before Supabase resolves), auth must already be signed out and writes locked.
    expect(getAuthSnapshot().status).toBe('signed-out');
    beginHeldWrite('count:daily', (requestId) => ({ requestId, qty: '1' }));
    expect(getHeldWrite('count:daily')).toBeNull();

    resolveSignOut();
    await pending;
    signOutSpy.mockRestore();
  });

  it('R3-1a: new tab hydration does not promote another live tab inflight pin when its Web Lock is held', async () => {
    const heldLocks = new Set<string>();
    const fakeLocks = {
      async request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        if (heldLocks.has(name)) {
          if (options.ifAvailable) return await callback(null);
          throw new Error('blocking wait not expected');
        }
        heldLocks.add(name);
        try {
          return await callback({ name, mode: options.mode ?? 'exclusive' });
        } finally {
          heldLocks.delete(name);
        }
      },
      query() {
        return Promise.resolve({
          held: [...heldLocks].map((name) => ({ name, mode: 'exclusive' })),
          pending: [],
        });
      },
    };
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: fakeLocks,
    });

    const tab1 = createHeldWriteStore();
    const tab2 = createHeldWriteStore();
    try {
      tab1.setHeldWriteUser('user-a');
      const subject = 'purchase:new';
      const lockKey = `${userStoragePrefix('user-a')}${encodeURIComponent(subject)}`;
      // Simulate Tab 1 holding the subject lock while its write is inflight.
      heldLocks.add(lockKey);
      tab1.putHeldWrite(subject, {
        requestId: 'req-live-1',
        payload: { requestId: 'req-live-1' },
        phase: 'inflight',
        kind: 'purchase',
      });

      // Tab 2 opens and hydrates while Tab 1's lock is still held.
      tab2.setHeldWriteUser('user-a');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const rawWhileLive = localStorage.getItem(lockKey);
      expect(JSON.parse(rawWhileLive ?? '{}')).toMatchObject({
        requestId: 'req-live-1',
        phase: 'inflight',
      });

      // Once Tab 1 crashes/releases the lock, a fresh hydration promotes inflight -> unknown.
      heldLocks.delete(lockKey);
      tab2.rehydrateHeldWrites();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const rawAfterCrash = localStorage.getItem(lockKey);
      expect(JSON.parse(rawAfterCrash ?? '{}')).toMatchObject({
        requestId: 'req-live-1',
        phase: 'unknown',
      });
    } finally {
      tab1.dispose();
      tab2.dispose();
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks);
      } else {
        delete (navigator as unknown as { locks?: unknown }).locks;
      }
    }
  });

  it('R3-1d: clearPostedReload requires BOTH matching requestId and readTarget', async () => {
    setHeldWriteUser('user-a');
    putHeldWrite('expense:new', {
      requestId: 'req-exp-1',
      payload: { requestId: 'req-exp-1' },
      phase: 'inflight',
      kind: 'expense',
    });
    setHeldWritePhase('expense:new', 'req-exp-1', 'posted_reload', {
      readTarget: '2030-03-01',
    });

    // Clearing without target must NOT clear a targeted posted_reload pin.
    await clearPostedReload('expense:new');
    expect(hasPostedReload('expense:new', '2030-03-01')).toBe(true);

    // Clearing with wrong target must NOT clear.
    await clearPostedReload('expense:new', '2030-04-01');
    expect(hasPostedReload('expense:new', '2030-03-01')).toBe(true);

    // Clearing with matching target + WRONG requestId must NOT clear.
    await clearPostedReload('expense:new', '2030-03-01', 'req-exp-wrong');
    expect(hasPostedReload('expense:new', '2030-03-01')).toBe(true);

    // Clearing with matching target AND matching requestId clears it.
    await clearPostedReload('expense:new', '2030-03-01', 'req-exp-1');
    expect(hasPostedReload('expense:new', '2030-03-01')).toBe(false);
  });

  it('R3-3: sign-out then re-sign-in to the SAME user invalidates a captured write session', async () => {
    const mod = await import('@/lib/held-writes');
    setHeldWriteUser('user-a');
    const captured = mod.captureWriteSession();
    expect(mod.canDispatchWriteFor(captured)).toBe(true);

    // Sign out then sign back into the exact same account.
    setHeldWriteUser(null);
    setHeldWriteUser('user-a');

    // Old continuation must NOT be allowed to dispatch under the new session generation.
    expect(mod.canDispatchWriteFor(captured)).toBe(false);
  });

  it('R3-1b: Web Locks prevent concurrent cross-tab claims and missing navigator.locks falls back cleanly', async () => {
    const heldLocks = new Set<string>();
    const fakeLocks = {
      async request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        if (heldLocks.has(name)) {
          if (options.ifAvailable) return await callback(null);
          throw new Error('unexpected blocking request');
        }
        heldLocks.add(name);
        try {
          return await callback({ name, mode: options.mode ?? 'exclusive' });
        } finally {
          heldLocks.delete(name);
        }
      },
      query() {
        return Promise.resolve({
          held: [...heldLocks].map((name) => ({ name, mode: 'exclusive' })),
        });
      },
    };

    const tab1 = createHeldWriteStore({ getLocks: () => fakeLocks });
    const tab2 = createHeldWriteStore({ getLocks: () => fakeLocks });
    try {
      tab1.setHeldWriteUser('user-a');
      tab2.setHeldWriteUser('user-a');

      const [c1, c2] = await Promise.all([
        tab1.claimFreshHeldWrite('purchase:new', (requestId) => ({
          requestId,
          tab: 1,
        })),
        tab2.claimFreshHeldWrite('purchase:new', (requestId) => ({
          requestId,
          tab: 2,
        })),
      ]);

      expect(c1.ok).toBe(true);
      expect(c2.ok).toBe(false);
      if (!c2.ok) {
        expect(c2.reason).toBe('locked');
      }
      if (c1.ok) {
        // While Tab 1 holds the lock, Tab 2 cannot replay either.
        const replayWhileLocked = await tab2.claimReplayHeldWrite(
          'purchase:new',
          c1.record.requestId,
        );
        expect(replayWhileLocked.ok).toBe(false);
        if (!replayWhileLocked.ok) {
          expect(replayWhileLocked.reason).toBe('locked');
        }

        // After Tab 1 marks unknown and releases the lock, fresh claim is still refused (conflict),
        // while explicit replay succeeds with the exact same requestId.
        tab1.setHeldWritePhase('purchase:new', c1.record.requestId, 'unknown');
        c1.release();
        await Promise.resolve();

        const freshAfterRelease = await tab2.claimFreshHeldWrite(
          'purchase:new',
          (requestId) => ({ requestId, tab: 2 }),
        );
        expect(freshAfterRelease.ok).toBe(false);
        if (!freshAfterRelease.ok) {
          expect(freshAfterRelease.reason).toBe('conflict');
        }

        const replayAfterRelease = await tab2.claimReplayHeldWrite(
          'purchase:new',
          c1.record.requestId,
        );
        expect(replayAfterRelease.ok).toBe(true);
        if (replayAfterRelease.ok) {
          expect(replayAfterRelease.record.requestId).toBe(c1.record.requestId);
          replayAfterRelease.release();
        }
      }
    } finally {
      tab1.dispose();
      tab2.dispose();
    }

    // When navigator.locks is unavailable, durable claims MUST fail closed instead
    // of granting non-atomic localStorage access across tabs.
    localStorage.clear();
    const fallbackA = createHeldWriteStore({ getLocks: () => null });
    const fallbackB = createHeldWriteStore({ getLocks: () => null });
    try {
      fallbackA.setHeldWriteUser('user-a');
      const claimed = await fallbackA.claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
      );
      expect(claimed).toEqual({ ok: false, reason: 'storage' });

      fallbackB.setHeldWriteUser('user-a');
      const refused = await fallbackB.claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
      );
      expect(refused).toEqual({ ok: false, reason: 'storage' });
    } finally {
      fallbackA.dispose();
      fallbackB.dispose();
    }
  });

  it('R4-2: failed posted_reload storage write keeps the old durable inflight pin and throws HeldWriteStorageError', async () => {
    const { locks } = makeAuditedLocks();
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });
    const { HeldWriteStorageError, claimFreshHeldWrite } =
      await import('@/lib/held-writes');
    setHeldWriteUser('user-a');
    const claimed = await claimFreshHeldWrite(
      'purchase:new',
      (requestId) => ({ requestId, supplier: 'مورد' }),
      { kind: 'purchase' },
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    try {
      const reqId = claimed.record.requestId;

      const activeKey = `${userStoragePrefix('user-a')}${encodeURIComponent('purchase:new')}`;
      expect(localStorage.getItem(activeKey)).not.toBeNull();

      // Simulate quota error when writing the replacement posted_reload key.
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      expect(() =>
        setHeldWritePhase('purchase:new', reqId, 'posted_reload', {
          readTarget: 'purchase:new',
        }),
      ).toThrow(HeldWriteStorageError);

      // The old durable inflight record MUST still exist in localStorage!
      const remaining = localStorage.getItem(activeKey);
      expect(remaining).not.toBeNull();
      expect(JSON.parse(remaining ?? '{}')).toMatchObject({
        requestId: reqId,
        phase: 'inflight',
      });
    } finally {
      claimed.release();
      if (origLocks) {
        Object.defineProperty(navigator, 'locks', origLocks);
      } else {
        Reflect.deleteProperty(navigator, 'locks');
      }
    }
  });

  it('R4-4a: async claims reject if user signs out and re-signs in as same user OR goes offline during lock acquisition', async () => {
    let releaseLockGate!: () => void;
    const gatedLocks = {
      async request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        await new Promise<void>((resolve) => {
          releaseLockGate = resolve;
        });
        return await callback({ name, mode: options.mode ?? 'exclusive' });
      },
    };

    const store = createHeldWriteStore({ getLocks: () => gatedLocks });
    const origOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    try {
      store.setHeldWriteUser('user-a');

      // Case 1: sign-out and sign back in to the SAME account while awaiting lock.
      const claimPromise1 = store.claimFreshHeldWrite(
        'purchase:new',
        (requestId) => ({ requestId }),
        { kind: 'purchase' },
      );
      store.setHeldWriteUser(null);
      store.setHeldWriteUser('user-a');
      releaseLockGate();
      const res1 = await claimPromise1;
      expect(res1.ok).toBe(false);
      expect(store.getHeldWrite('purchase:new')).toBeNull();

      // Case 2: go offline while awaiting lock.
      const claimPromise2 = store.claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
        { kind: 'count' },
      );
      Object.defineProperty(navigator, 'onLine', {
        configurable: true,
        value: false,
      });
      releaseLockGate();
      const res2 = await claimPromise2;
      expect(res2.ok).toBe(false);
      expect(store.getHeldWrite('count:daily')).toBeNull();
    } finally {
      if (origOnline) {
        Object.defineProperty(navigator, 'onLine', origOnline);
      } else {
        Object.defineProperty(navigator, 'onLine', {
          configurable: true,
          value: true,
        });
      }
      store.dispose();
    }
  });

  it('R5-1b: sign-out and setWritesLocked(true) keep an already-dispatched Web Lock until its call settles', async () => {
    const heldLocks = new Set<string>();
    const sharedLocks = {
      async request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        if (options.ifAvailable && heldLocks.has(name)) {
          return await callback(null);
        }
        heldLocks.add(name);
        try {
          return await callback({ name, mode: options.mode ?? 'exclusive' });
        } finally {
          heldLocks.delete(name);
        }
      },
      query: () =>
        Promise.resolve({
          held: [...heldLocks].map((name) => ({ name })),
        }),
    };

    const tab1 = createHeldWriteStore({ getLocks: () => sharedLocks });
    const tab2 = createHeldWriteStore({ getLocks: () => sharedLocks });
    try {
      tab1.setHeldWriteUser('user-1');
      tab2.setHeldWriteUser('user-1');

      const claim1 = await tab1.claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
        { kind: 'count' },
      );
      expect(claim1.ok).toBe(true);
      if (!claim1.ok) return;
      expect(heldLocks.size).toBe(1);

      // Sign-out in Tab 1 (while its RPC is still in flight) MUST NOT release
      // the lock prematurely — Tab 2 must still see the subject as locked.
      tab1.setHeldWriteUser(null);
      expect(heldLocks.size).toBe(1);

      const blocked = await tab2.claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
        { kind: 'count' },
      );
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.reason).toBe('locked');

      // setWritesLocked(true) while another lock is held must also keep it.
      tab1.setHeldWriteUser('user-1');
      tab1.setWritesLocked(true);
      expect(heldLocks.size).toBe(1);

      // Only once Tab 1's call settles and releases the lock does it free up.
      claim1.release();
      await Promise.resolve();
      expect(heldLocks.size).toBe(0);
    } finally {
      tab1.dispose();
      tab2.dispose();
    }
  });

  it('R5-7: claimFreshHeldWrite and claimReplayHeldWrite release the Web Lock if create or storage throws', async () => {
    const heldLocks = new Set<string>();
    const locks = {
      async request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        if (options.ifAvailable && heldLocks.has(name)) {
          return await callback(null);
        }
        heldLocks.add(name);
        try {
          return await callback({ name, mode: options.mode ?? 'exclusive' });
        } finally {
          heldLocks.delete(name);
        }
      },
    };

    const store = createHeldWriteStore({ getLocks: () => locks });
    try {
      store.setHeldWriteUser('user-1');
      await expect(
        store.claimFreshHeldWrite('count:daily', () => {
          throw new Error('builder boom');
        }),
      ).rejects.toThrow('builder boom');

      // Wait a microtask for lock finally to settle, then verify no lock leaked.
      await Promise.resolve();
      expect(heldLocks.size).toBe(0);

      const next = await store.claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
      );
      expect(next.ok).toBe(true);
      if (next.ok) next.release();
      await Promise.resolve();
      expect(heldLocks.size).toBe(0);
    } finally {
      store.dispose();
    }
  });

  it('R6-3a: live claim locks keep hasAnyHeldWrite true after sign-out and notify subscribers when the last claim releases', async () => {
    const heldLocks = new Set<string>();
    const locks = {
      async request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        if (options.ifAvailable && heldLocks.has(name)) {
          return await callback(null);
        }
        heldLocks.add(name);
        try {
          return await callback({ name, mode: options.mode ?? 'exclusive' });
        } finally {
          heldLocks.delete(name);
        }
      },
    };

    const store = createHeldWriteStore({ getLocks: () => locks });
    try {
      store.setHeldWriteUser('user-1');
      const claim = await store.claimFreshHeldWrite(
        'purchase:new',
        (requestId) => ({ requestId }),
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Sign-out clears user storage and memory pins while the RPC lock is still held.
      store.setWritesLocked(true);
      store.clearHeldWritesForUser('user-1');
      store.setHeldWriteUser(null);

      // Live claim MUST still block shell updates!
      expect(store.hasAnyHeldWrite()).toBe(true);

      let notifications = 0;
      const unsub = store.subscribeHeldWritesStore(() => {
        notifications += 1;
      });
      try {
        claim.release();
        await Promise.resolve();
        expect(store.hasAnyHeldWrite()).toBe(false);
        expect(notifications).toBeGreaterThan(0);
      } finally {
        unsub();
      }
    } finally {
      store.dispose();
    }
  });

  it('R19-1b: stale claim fallback does not publish previous session pin after sign-out and sign-in without Web Locks', async () => {
    const values = new Map<string, string>();
    let failRead = false;
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      key: (index) => Array.from(values.keys())[index] ?? null,
      getItem: (key) => {
        if (failRead) throw new Error('synthetic temporary read failure');
        return values.get(key) ?? null;
      },
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const { locks } = makeAuditedLocks();
    const store = createHeldWriteStore({
      getStorage: () => storage,
      getLocks: () => locks,
      getProjectUrl: () => 'https://example.invalid',
      allowTestLocalUser: false,
    });
    const subject = 'count:stored:test-count-a';
    try {
      // Cross-user sign-out and sign-in: waiting_for_sync fallback must not leak owner-a payload into owner-b.
      store.setHeldWriteUser('owner-a');
      const claimA = await store.claimFreshHeldWrite(
        subject,
        () => ({
          request_id: 'test-count-a',
          note: 'previous-session-test-payload',
        }),
        { requestId: 'test-count-a', kind: 'count_stored' },
      );
      expect(claimA.ok).toBe(true);
      if (!claimA.ok) return;

      store.setWritesLocked(true);
      store.clearHeldWritesForUser('owner-a');
      store.setHeldWriteUser(null);
      store.setHeldWriteUser('owner-b');

      failRead = true;
      try {
        store.clearHeldWrite(subject, claimA.record.requestId, claimA.record);
      } catch {
        try {
          store.setHeldWritePhase(
            subject,
            claimA.record.requestId,
            'waiting_for_sync',
            { expected: claimA.record },
          );
        } catch {
          // Expected when storage lookup throws.
        }
      }
      try {
        store.setHeldWritePhase(
          subject,
          claimA.record.requestId,
          'waiting_for_sync',
          { expected: claimA.record },
        );
      } catch {
        // Expected when storage lookup throws.
      }
      try {
        store.setHeldWritePhase(
          subject,
          claimA.record.requestId,
          'posted_reload',
          { expected: claimA.record },
        );
      } catch {
        // Expected when storage lookup throws.
      }
      claimA.release();
      failRead = false;

      expect(values.size).toBe(0);
      expect(store.getHeldWrite(subject)).toBeNull();
      expect(store.hasPostedReload(subject, undefined, 'test-count-a')).toBe(
        false,
      );
      expect(store.hasAnyHeldWrite()).toBe(false);

      // Same-user sign-out and re-sign-in: older session generation must also not publish fallback.
      const claimB = await store.claimFreshHeldWrite(
        subject,
        () => ({
          request_id: 'test-count-b',
          note: 'older-generation-payload',
        }),
        { requestId: 'test-count-b', kind: 'count_stored' },
      );
      expect(claimB.ok).toBe(true);
      if (!claimB.ok) return;

      store.setWritesLocked(true);
      store.clearHeldWritesForUser('owner-b');
      store.setHeldWriteUser(null);
      store.setHeldWriteUser('owner-b');

      failRead = true;
      try {
        store.setHeldWritePhase(
          subject,
          claimB.record.requestId,
          'waiting_for_sync',
          { expected: claimB.record, session: claimB.session },
        );
      } catch {
        // Expected when storage lookup throws.
      }
      claimB.release();
      failRead = false;

      expect(values.size).toBe(0);
      expect(store.getHeldWrite(subject)).toBeNull();
      expect(store.hasAnyHeldWrite()).toBe(false);
    } finally {
      store.dispose();
    }
  });

  it('R20-1a: same-session SIGNED_IN reconfirmation preserves write settlement while sign-out and session switches reject late settlement', async () => {
    const { locks } = makeAuditedLocks();
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });
    const makeSyntheticJwt = (payload: Record<string, unknown>): string => {
      const encode = (value: Record<string, unknown>) =>
        btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(JSON.stringify(value)),
          ),
        )
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/g, '');
      return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`;
    };
    const emitAuth = (event: string, session: Session) => {
      authMock.session = session;
      for (const listener of [...authMock.listeners]) {
        listener(event, session);
      }
    };

    const jwtSid1A = makeSyntheticJwt({
      sub: 'owner-a',
      session_id: 'sid-1',
      exp: 2_000_000_000,
    });
    const jwtSid1Refreshed = makeSyntheticJwt({
      sub: 'owner-a',
      session_id: 'sid-1',
      exp: 2_000_003_600,
    });
    const jwtSid2 = makeSyntheticJwt({
      sub: 'owner-a',
      session_id: 'sid-2',
      exp: 2_000_007_200,
    });

    authMock.session = {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: jwtSid1A,
      refresh_token: 'rt-1',
    };
    startAuth();

    // 1. Focus reconfirmation (SIGNED_IN with identical session) must preserve settlement.
    const claim1 = await claimFreshHeldWrite(
      'count:daily',
      (requestId) => ({ requestId, qty: '10' }),
      { kind: 'count' },
    );
    expect(claim1.ok).toBe(true);
    if (!claim1.ok) return;

    emitAuth('SIGNED_IN', {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: jwtSid1A,
      refresh_token: 'rt-1',
    });

    expect(isCurrentWriteSession(claim1.session)).toBe(true);
    setHeldWritePhase('count:daily', claim1.record.requestId, 'posted_reload', {
      expected: claim1.record,
      session: claim1.session,
    });
    claim1.release();
    expect(getHeldWrite('count:daily')?.phase).toBe('posted_reload');
    expect(
      hasPostedReload('count:daily', undefined, claim1.record.requestId),
    ).toBe(true);
    await clearPostedReload('count:daily', undefined, claim1.record.requestId);
    expect(getHeldWrite('count:daily')).toBeNull();

    // 2. Focus SIGNED_IN after another tab refreshed tokens of the SAME JWT session_id also preserves settlement.
    const claim2 = await claimFreshHeldWrite(
      'count:daily',
      (requestId) => ({ requestId, qty: '11' }),
      { kind: 'count' },
    );
    expect(claim2.ok).toBe(true);
    if (!claim2.ok) return;

    emitAuth('SIGNED_IN', {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: jwtSid1Refreshed,
      refresh_token: 'rt-2',
    });

    expect(isCurrentWriteSession(claim2.session)).toBe(true);
    setHeldWritePhase('count:daily', claim2.record.requestId, 'posted_reload', {
      expected: claim2.record,
      session: claim2.session,
    });
    claim2.release();
    expect(
      hasPostedReload('count:daily', undefined, claim2.record.requestId),
    ).toBe(true);
    await clearPostedReload('count:daily', undefined, claim2.record.requestId);

    // 3. Direct same-user session switch (different JWT session_id without SIGNED_OUT) must invalidate old write.
    const claim3 = await claimFreshHeldWrite(
      'count:daily',
      (requestId) => ({ requestId, qty: '12' }),
      { kind: 'count' },
    );
    expect(claim3.ok).toBe(true);
    if (!claim3.ok) return;

    emitAuth('SIGNED_IN', {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: jwtSid2,
      refresh_token: 'rt-3',
    });

    expect(isCurrentWriteSession(claim3.session)).toBe(false);
    setHeldWritePhase('count:daily', claim3.record.requestId, 'posted_reload', {
      expected: claim3.record,
    });
    claim3.release();
    expect(
      hasPostedReload('count:daily', undefined, claim3.record.requestId),
    ).toBe(false);

    // 4. Sign-out followed by re-sign-in as the same user (even with identical token) must reject late settlement.
    await Promise.resolve();
    clearHeldWritesForUser('owner-a');
    await vi.waitFor(() => {
      expect(localStorage.length).toBe(0);
    });
    rehydrateHeldWrites();
    const claim4 = await claimFreshHeldWrite(
      'count:daily',
      (requestId) => ({ requestId, qty: '13' }),
      { kind: 'count' },
    );
    expect(claim4.ok).toBe(true);
    if (!claim4.ok) return;

    emitAuth('SIGNED_OUT', null);
    emitAuth('SIGNED_IN', {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: jwtSid2,
      refresh_token: 'rt-3',
    });

    expect(isCurrentWriteSession(claim4.session)).toBe(false);
    setHeldWritePhase('count:daily', claim4.record.requestId, 'posted_reload', {
      expected: claim4.record,
    });
    claim4.release();
    expect(
      hasPostedReload('count:daily', undefined, claim4.record.requestId),
    ).toBe(false);
    // Unresolved pin from claim4 stayed durable across sign-out; clear before case 5.
    await Promise.resolve();
    clearHeldWritesForUser('owner-a');
    await vi.waitFor(() => {
      expect(localStorage.length).toBe(0);
    });
    rehydrateHeldWrites();

    // 5. Direct cross-user SIGNED_IN must reject late settlement.
    const claim5 = await claimFreshHeldWrite(
      'count:daily',
      (requestId) => ({ requestId, qty: '14' }),
      { kind: 'count' },
    );
    expect(claim5.ok).toBe(true);
    if (!claim5.ok) return;

    emitAuth('SIGNED_IN', {
      user: { id: 'owner-b', email: 'b@theshark.test' },
      access_token: makeSyntheticJwt({
        sub: 'owner-b',
        session_id: 'sid-b1',
        exp: 2_000_010_800,
      }),
      refresh_token: 'rt-b1',
    });

    expect(isCurrentWriteSession(claim5.session)).toBe(false);
    setHeldWritePhase('count:daily', claim5.record.requestId, 'posted_reload', {
      expected: claim5.record,
    });
    claim5.release();
    expect(
      hasPostedReload('count:daily', undefined, claim5.record.requestId),
    ).toBe(false);

    // 6. Opaque tokens (no JWT session_id): TOKEN_REFRESHED then focus SIGNED_IN preserves settlement,
    //    whereas SIGNED_IN with changed opaque tokens invalidates the old session.
    emitAuth('SIGNED_IN', {
      user: { id: 'owner-opaque', email: 'opaque@theshark.test' },
      access_token: 'opaque-1',
      refresh_token: 'opaque-rt-1',
    });
    const claim6 = await claimFreshHeldWrite(
      'count:daily',
      (requestId) => ({ requestId, qty: '15' }),
      { kind: 'count' },
    );
    expect(claim6.ok).toBe(true);
    if (!claim6.ok) return;

    emitAuth('TOKEN_REFRESHED', {
      user: { id: 'owner-opaque', email: 'opaque@theshark.test' },
      access_token: 'opaque-2',
      refresh_token: 'opaque-rt-2',
    });
    emitAuth('SIGNED_IN', {
      user: { id: 'owner-opaque', email: 'opaque@theshark.test' },
      access_token: 'opaque-2',
      refresh_token: 'opaque-rt-2',
    });
    expect(isCurrentWriteSession(claim6.session)).toBe(true);
    setHeldWritePhase('count:daily', claim6.record.requestId, 'posted_reload', {
      expected: claim6.record,
      session: claim6.session,
    });
    claim6.release();
    expect(
      hasPostedReload('count:daily', undefined, claim6.record.requestId),
    ).toBe(true);
    await clearPostedReload('count:daily', undefined, claim6.record.requestId);

    const claim7 = await claimFreshHeldWrite(
      'count:daily',
      (requestId) => ({ requestId, qty: '16' }),
      { kind: 'count' },
    );
    expect(claim7.ok).toBe(true);
    if (!claim7.ok) return;

    emitAuth('SIGNED_IN', {
      user: { id: 'owner-opaque', email: 'opaque@theshark.test' },
      access_token: 'opaque-3',
      refresh_token: 'opaque-rt-3',
    });
    expect(isCurrentWriteSession(claim7.session)).toBe(false);
    setHeldWritePhase('count:daily', claim7.record.requestId, 'posted_reload', {
      expected: claim7.record,
    });
    claim7.release();
    expect(
      hasPostedReload('count:daily', undefined, claim7.record.requestId),
    ).toBe(false);
    if (origLocks) {
      Object.defineProperty(navigator, 'locks', origLocks);
    } else {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('P1: signOut keeps writes and PWA reload locked during refocus while logout is pending, and preserves unresolved pins per user across sign-out while isolating other users', async () => {
    const { locks } = makeAuditedLocks();
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });
    const emitAuth = (event: string, session: Session) => {
      authMock.session = session;
      for (const listener of [...authMock.listeners]) {
        listener(event, session);
      }
    };
    const sessionA: NonNullable<Session> = {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: 'tok-a-1',
      refresh_token: 'rt-a-1',
    };
    let resolveSignOut!: () => void;
    const supabaseMod = await import('@/lib/supabase');
    const signOutSpy = vi
      .spyOn(supabaseMod.supabase!.auth, 'signOut')
      .mockImplementationOnce(
        () =>
          new Promise<{ error: null }>((resolve) => {
            resolveSignOut = () => {
              emitAuth('SIGNED_OUT', null);
              resolve({ error: null });
            };
          }),
      );

    try {
      authMock.session = sessionA;
      startAuth();
      setPwaAuthResolved(true);
      const postMessage = vi.fn();
      const reload = vi.fn();
      setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

      // Owner A has an unresolved purchase pin and a resolved posted_reload pin.
      const purchaseClaim = await claimFreshHeldWrite(
        'purchase:new',
        (requestId) => ({ requestId, supplier: 'مورد أ' }),
        { requestId: 'req-purch-p1', kind: 'purchase' },
      );
      expect(purchaseClaim.ok).toBe(true);
      if (!purchaseClaim.ok) return;
      setHeldWritePhase('purchase:new', 'req-purch-p1', 'unknown');
      purchaseClaim.release();

      const sortClaim = await claimFreshHeldWrite(
        'sort:new',
        (requestId) => ({ requestId }),
        { requestId: 'req-sort-p1', kind: 'sort' },
      );
      expect(sortClaim.ok).toBe(true);
      if (!sortClaim.ok) return;
      setHeldWritePhase('sort:new', 'req-sort-p1', 'posted_reload');
      sortClaim.release();

      const pendingLogout = signOut();

      // While logout is pending, PWA reload MUST stay locked even if authResolved is passed.
      expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
      expect(postMessage).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();

      // A same-session refocus firing SIGNED_IN while logout is pending MUST NOT reopen writes or PWA reload.
      emitAuth('SIGNED_IN', { ...sessionA });
      expect(getAuthSnapshot().status).toBe('signed-out');
      expect(getHeldWrite('purchase:new')).toBeNull();
      const blockedDuringLogout = await claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
      );
      expect(blockedDuringLogout).toEqual({ ok: false, reason: 'signed_out' });
      expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);

      resolveSignOut();
      await pendingLogout;

      // Resolved posted_reload pin was cleared on sign-out, while unresolved purchase pin stayed durable.
      const purchaseKey = `${userStoragePrefix('owner-a')}${encodeURIComponent('purchase:new')}`;
      const sortPostedKey = `${userStoragePrefix('owner-a')}posted:${encodeURIComponent('sort:new')}:${encodeURIComponent('req-sort-p1')}`;
      expect(localStorage.getItem(sortPostedKey)).toBeNull();
      expect(
        JSON.parse(localStorage.getItem(purchaseKey) ?? 'null'),
      ).toMatchObject({
        subject: 'purchase:new',
        requestId: 'req-purch-p1',
        phase: 'unknown',
      });

      // Another user signing in cannot read owner-a's unresolved pin.
      emitAuth('SIGNED_IN', {
        user: { id: 'owner-b', email: 'b@theshark.test' },
        access_token: 'tok-b-1',
        refresh_token: 'rt-b-1',
      });
      expect(getHeldWrite('purchase:new')).toBeNull();

      // When owner-a signs back in, the original requestId is restored and blocks fresh duplicate submits.
      emitAuth('SIGNED_IN', {
        user: { id: 'owner-a', email: 'a@theshark.test' },
        access_token: 'tok-a-2',
        refresh_token: 'rt-a-2',
      });
      await rehydrateHeldWritesAsync();
      expect(getHeldWrite('purchase:new')).toMatchObject({
        requestId: 'req-purch-p1',
        phase: 'unknown',
      });
      const dupFresh = await claimFreshHeldWrite(
        'purchase:new',
        (requestId) => ({ requestId }),
        { requestId: 'req-purch-dup' },
      );
      expect(dupFresh).toMatchObject({ ok: false, reason: 'conflict' });
      const safeReplay = await claimReplayHeldWrite(
        'purchase:new',
        'req-purch-p1',
      );
      expect(safeReplay.ok).toBe(true);
      if (safeReplay.ok) safeReplay.release();
    } finally {
      signOutSpy.mockRestore();
      resetPwaState();
      if (origLocks) {
        Object.defineProperty(navigator, 'locks', origLocks);
      } else {
        Reflect.deleteProperty(navigator, 'locks');
      }
    }
  });

  it('P2: failed signOut keeps logout unresolved, blocks PWA reload and session reconfirmation, and resolves only after a successful retry', async () => {
    const { locks } = makeAuditedLocks();
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });
    const emitAuth = (event: string, session: Session) => {
      authMock.session = session;
      for (const listener of [...authMock.listeners]) {
        listener(event, session);
      }
    };
    const sessionA: NonNullable<Session> = {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: 'tok-a-1',
      refresh_token: 'rt-a-1',
    };
    const supabaseMod = await import('@/lib/supabase');
    const signOutSpy = vi
      .spyOn(supabaseMod.supabase!.auth, 'signOut')
      .mockResolvedValueOnce({
        error: new Error('session refresh failed') as never,
      })
      .mockImplementationOnce(() => {
        emitAuth('SIGNED_OUT', null);
        return Promise.resolve({ error: null });
      });

    try {
      authMock.session = sessionA;
      startAuth();
      setPwaAuthResolved(true);
      const postMessage = vi.fn();
      const reload = vi.fn();
      setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

      await signOut();

      // Failed SDK signOut must keep logout unresolved and PWA reload blocked.
      expect(getAuthSnapshot().status).toBe('signed-out');
      expect(isPwaLogoutPending()).toBe(true);
      expect(isAuthResolved()).toBe(false);
      expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
      expect(postMessage).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();

      // Reconfirming the retained session must NOT reopen owner access or unlock writes.
      emitAuth('SIGNED_IN', { ...sessionA });
      emitAuth('TOKEN_REFRESHED', { ...sessionA });
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(getAuthSnapshot().status).toBe('signed-out');
      expect(isPwaLogoutPending()).toBe(true);
      expect(isAuthResolved()).toBe(false);
      const blockedAfterFailedLogout = await claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
      );
      expect(blockedAfterFailedLogout).toEqual({
        ok: false,
        reason: 'signed_out',
      });

      // Retrying signOut and succeeding clears the unresolved logout state.
      await signOut();
      expect(isPwaLogoutPending()).toBe(false);
      expect(isAuthResolved()).toBe(true);
      expect(getAuthSnapshot().status).toBe('signed-out');

      // Once logout cleanly finished, a subsequent fresh sign-in works again.
      emitAuth('SIGNED_IN', { ...sessionA });
      await vi.waitFor(() => {
        expect(getAuthSnapshot().status).toBe('owner');
      });
    } finally {
      signOutSpy.mockRestore();
      resetPwaState();
      if (origLocks) {
        Object.defineProperty(navigator, 'locks', origLocks);
      } else {
        Reflect.deleteProperty(navigator, 'locks');
      }
    }
  });

  it('P2: persists logout intent before SDK signOut, blocks INITIAL_SESSION across reload, and clears only after local credentials are removed', async () => {
    const sessionA: NonNullable<Session> = {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: 'tok-a-reload',
      refresh_token: 'rt-a-reload',
    };
    const supabaseMod = await import('@/lib/supabase');
    let releasePendingSignOut: (value: {
      error: Error | null;
    }) => void = () => {};
    const signOutSpy = vi
      .spyOn(supabaseMod.supabase!.auth, 'signOut')
      .mockImplementationOnce(
        () =>
          new Promise<{ error: Error | null }>((resolve) => {
            releasePendingSignOut = resolve;
          }) as ReturnType<
            NonNullable<typeof supabaseMod.supabase>['auth']['signOut']
          >,
      )
      .mockResolvedValueOnce({
        error: new Error('offline refresh failed') as never,
      })
      .mockImplementationOnce(() => {
        authMock.session = null;
        for (const listener of [...authMock.listeners]) {
          listener('SIGNED_OUT', null);
        }
        return Promise.resolve({ error: null });
      });

    try {
      authMock.session = sessionA;
      startAuth();
      await vi.waitFor(() => {
        expect(getAuthSnapshot().status).toBe('owner');
      });

      // Start signOut and reload BEFORE the SDK call finishes.
      const pendingLogout = signOut();
      expect(signOutSpy).toHaveBeenCalledTimes(1);

      // Fresh document reload while SDK still retains sessionA.
      vi.resetModules();
      const [freshAuth, freshHeld, freshPwa] = await Promise.all([
        import('@/lib/auth-store'),
        import('@/lib/held-writes'),
        import('@/lib/pwa'),
      ]);
      freshAuth.startAuth();
      await new Promise((resolve) => setTimeout(resolve, 15));

      expect(freshAuth.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        email: null,
        logoutPending: false,
        logoutFailed: true,
      });
      expect(freshAuth.isAuthResolved()).toBe(false);
      expect(freshPwa.isPwaLogoutPending()).toBe(true);
      expect(freshHeld.isWritesLocked()).toBe(true);
      expect(
        await freshHeld.claimFreshHeldWrite('count:daily', (requestId) => ({
          requestId,
        })),
      ).toEqual({ ok: false, reason: 'signed_out' });

      // Release the old tab's hung SDK call with an error so no dangling promise remains.
      releasePendingSignOut({ error: new Error('tab reloaded') });
      await pendingLogout;

      // Retrying signOut while offline (returns error) must keep persisted intent intact.
      await freshAuth.signOut();
      expect(freshAuth.getAuthSnapshot().logoutFailed).toBe(true);
      expect(freshAuth.isAuthResolved()).toBe(false);

      // Even if a fresh reload receives INITIAL_SESSION(null) while offline with
      // retained credentials, persisted logout intent must stay active until signOut succeeds.
      authMock.session = null;
      vi.resetModules();
      const [offlineReloadAuth, offlineReloadPwa] = await Promise.all([
        import('@/lib/auth-store'),
        import('@/lib/pwa'),
      ]);
      offlineReloadAuth.startAuth();
      expect(offlineReloadAuth.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutFailed: true,
      });
      expect(offlineReloadAuth.isAuthResolved()).toBe(false);
      expect(offlineReloadPwa.isPwaLogoutPending()).toBe(true);

      // A later SIGNED_IN from the retained refresh token must still be rejected.
      authMock.session = sessionA;
      for (const listener of [...authMock.listeners]) {
        listener('SIGNED_IN', sessionA);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(offlineReloadAuth.getAuthSnapshot().status).toBe('signed-out');
      expect(offlineReloadAuth.isAuthResolved()).toBe(false);

      // Succeeding retry removes local credentials and clears persisted logout intent.
      await offlineReloadAuth.signOut();
      expect(offlineReloadAuth.getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPending: false,
        logoutFailed: false,
      });
      expect(offlineReloadAuth.isAuthResolved()).toBe(true);
      expect(offlineReloadPwa.isPwaLogoutPending()).toBe(false);

      // After local credentials were removed, a fresh reload accepts a new sign-in.
      authMock.session = sessionA;
      vi.resetModules();
      const postCleanAuth = await import('@/lib/auth-store');
      postCleanAuth.startAuth();
      await vi.waitFor(() => {
        expect(postCleanAuth.getAuthSnapshot().status).toBe('owner');
      });
      expect(postCleanAuth.isAuthResolved()).toBe(true);
    } finally {
      signOutSpy.mockRestore();
      resetPwaState();
    }
  });

  it('P2: removes persisted SDK credentials when localStorage rejects the logout marker on quota error so reload cannot restore owner access', async () => {
    const sdkStorageKey = 'sb-127-auth-token';
    const sessionA: NonNullable<Session> = {
      user: { id: 'owner-a', email: 'a@theshark.test' },
      access_token: 'tok-a-quota',
      refresh_token: 'rt-a-quota',
    };
    const supabaseMod = await import('@/lib/supabase');
    const authClient = supabaseMod.supabase!.auth;
    const origOnAuthStateChange = authClient.onAuthStateChange.bind(authClient);
    const onAuthSpy = vi
      .spyOn(authClient, 'onAuthStateChange')
      .mockImplementation((callback) => {
        const stored = localStorage.getItem(sdkStorageKey);
        const restored = stored
          ? (JSON.parse(stored) as NonNullable<Session>)
          : null;
        authMock.session = restored;
        return origOnAuthStateChange(callback);
      });
    const signOutSpy = vi.spyOn(authClient, 'signOut').mockResolvedValue({
      error: new Error('offline refresh failed') as never,
    });
    const setItemDesc = Object.getOwnPropertyDescriptor(
      Storage.prototype,
      'setItem',
    );
    const origSetItem = setItemDesc?.value as (
      this: Storage,
      key: string,
      value: string,
    ) => void;
    let rejectAllNewWrites = false;
    let rejectUntilSdkKeyRemoved = false;
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (rejectAllNewWrites && this.getItem(key) === null) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        if (
          rejectUntilSdkKeyRemoved &&
          this.getItem(key) === null &&
          this.getItem(sdkStorageKey) !== null
        ) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        origSetItem.call(this, key, value);
      });

    try {
      // Case 1: storage stays full even after SDK credentials are removed.
      localStorage.setItem(sdkStorageKey, JSON.stringify(sessionA));
      localStorage.setItem(
        `${sdkStorageKey}-user`,
        JSON.stringify(sessionA.user),
      );
      localStorage.setItem(`${sdkStorageKey}-code-verifier`, 'pkce-verifier-1');
      startAuth();
      await vi.waitFor(() => {
        expect(getAuthSnapshot().status).toBe('owner');
      });

      rejectAllNewWrites = true;
      await signOut();

      expect(localStorage.getItem(sdkStorageKey)).toBeNull();
      expect(localStorage.getItem(`${sdkStorageKey}-user`)).toBeNull();
      expect(localStorage.getItem(`${sdkStorageKey}-code-verifier`)).toBeNull();
      expect(getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        email: null,
        logoutPending: false,
        logoutFailed: true,
      });
      expect(isAuthResolved()).toBe(false);
      expect(isPwaLogoutPending()).toBe(true);

      // Fresh document reload must NOT restore owner access.
      vi.resetModules();
      const reloadedAuth = await import('@/lib/auth-store');
      reloadedAuth.startAuth();
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(reloadedAuth.getAuthSnapshot().status).toBe('signed-out');
      expect(reloadedAuth.getAuthSnapshot().email).toBeNull();

      // Case 2: removing the SDK session frees enough quota for the logout marker retry to succeed.
      rejectAllNewWrites = false;
      localStorage.clear();
      reloadedAuth.resetAuthStore();
      localStorage.setItem(sdkStorageKey, JSON.stringify(sessionA));
      reloadedAuth.startAuth();
      await vi.waitFor(() => {
        expect(reloadedAuth.getAuthSnapshot().status).toBe('owner');
      });

      rejectUntilSdkKeyRemoved = true;
      await reloadedAuth.signOut();

      expect(localStorage.getItem(sdkStorageKey)).toBeNull();
      expect(
        localStorage.getItem(
          `theshark:auth:logout-pending:v1:${encodeURIComponent('http://127.0.0.1:55421')}`,
        ),
      ).toBe('1');
      expect(reloadedAuth.getAuthSnapshot().logoutFailed).toBe(true);
      expect(reloadedAuth.isAuthResolved()).toBe(false);
    } finally {
      setItemSpy.mockRestore();
      signOutSpy.mockRestore();
      onAuthSpy.mockRestore();
      resetPwaState();
    }
  });

  it('P2: surviving tab queues exact-claim recheck on storage sync so inflight promotes to unknown when writer releases lock without another storage event', async () => {
    const { client } = makeAuditedLocks();
    const tab1 = createHeldWriteStore({ getLocks: () => client('writer-tab') });
    const tab2 = createHeldWriteStore({
      getLocks: () => client('surviving-tab'),
    });
    try {
      tab1.setHeldWriteUser('user-a');
      tab2.setHeldWriteUser('user-a');

      const claim = await tab1.claimFreshHeldWrite(
        'purchase:new',
        (requestId) => ({ requestId, supplier: 'مورد' }),
        { requestId: 'req-survive-1', kind: 'purchase' },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Deliver the storage event to tab2 while tab1 still holds the subject lock.
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: `${userStoragePrefix('user-a')}${encodeURIComponent('purchase:new')}`,
        }),
      );
      expect(tab2.getHeldWrite('purchase:new')).toMatchObject({
        requestId: 'req-survive-1',
        phase: 'inflight',
      });

      const listener = vi.fn();
      const unsub = tab2.subscribeHeldWritesStore(listener);
      try {
        // Writer tab closes/crashes and releases its lock WITHOUT firing another storage event.
        tab1.dispose();

        await vi.waitFor(() => {
          expect(tab2.getHeldWrite('purchase:new')).toMatchObject({
            requestId: 'req-survive-1',
            phase: 'unknown',
          });
        });
        expect(listener).toHaveBeenCalled();
      } finally {
        unsub();
      }
    } finally {
      tab1.dispose();
      tab2.dispose();
    }
  });

  it('P2: durable claims fail closed when Web Locks are unavailable instead of granting non-atomic access', async () => {
    const store = createHeldWriteStore({ getLocks: () => null });
    try {
      store.setHeldWriteUser('user-a');

      const fresh = await store.claimFreshHeldWrite(
        'purchase:new',
        (requestId) => ({ requestId }),
        { kind: 'purchase' },
      );
      expect(fresh).toEqual({ ok: false, reason: 'storage' });
      expect(store.getHeldWrite('purchase:new')).toBeNull();
      expect(localStorage.length).toBe(0);

      // Even if a pre-existing unknown pin exists in storage, replay claim fails closed without Web Locks.
      localStorage.setItem(
        `${userStoragePrefix('user-a')}${encodeURIComponent('purchase:new')}`,
        JSON.stringify({
          v: 1,
          subject: 'purchase:new',
          requestId: 'req-no-locks',
          payload: { requestId: 'req-no-locks' },
          phase: 'unknown',
        }),
      );
      store.rehydrateHeldWrites();
      const replay = await store.claimReplayHeldWrite(
        'purchase:new',
        'req-no-locks',
      );
      expect(replay).toEqual({ ok: false, reason: 'storage' });

      const lockAttempt = await store.acquireHeldWriteLock('purchase:new');
      expect(lockAttempt).toEqual({ acquired: false, reason: 'storage' });
    } finally {
      store.dispose();
    }

    // Production builds (`allowTestUnlocked: false`) fail closed on defaultLocks when navigator.locks is absent.
    const prodStore = createHeldWriteStore({ allowTestUnlocked: false });
    try {
      prodStore.setHeldWriteUser('user-a');
      expect(
        await prodStore.claimFreshHeldWrite('sort:new', (requestId) => ({
          requestId,
        })),
      ).toEqual({ ok: false, reason: 'storage' });
    } finally {
      prodStore.dispose();
    }
  });
});
