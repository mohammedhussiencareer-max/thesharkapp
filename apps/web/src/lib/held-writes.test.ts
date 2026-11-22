import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginHeldWrite,
  clearHeldWritesForUser,
  clearPostedReload,
  createHeldWriteStore,
  getHeldWrite,
  hasAnyHeldWrite,
  hasPostedReload,
  listHeldWritesByPrefix,
  putHeldWrite,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWritePhase,
  setHeldWriteUser,
  updateHeldWritePayload,
  userStoragePrefix,
} from '@/lib/held-writes';
import {
  getAuthSnapshot,
  resetAuthStore,
  signOut,
  startAuth,
} from '@/lib/auth-store';

type Session = { user: { id: string; email: string } } | null;

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

  it('keeps waiting_for_sync and posted_reload across reloads until cleared', () => {
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
    clearPostedReload('count:daily');
    expect(getHeldWrite('count:daily')?.phase).toBe('waiting_for_sync');

    clearPostedReload('sort:new');
    expect(getHeldWrite('sort:new')).toBeNull();
  });

  it('sign-out removes only that user keys and leaves other users and unrelated keys untouched', async () => {
    localStorage.setItem('unrelated-key', 'keep-me');

    setHeldWriteUser('user-b');
    beginHeldWrite('count:daily', (requestId) => ({ requestId, qty: '9' }));

    authMock.session = { user: { id: 'user-a', email: 'a@theshark.test' } };
    startAuth();
    beginHeldWrite('count:daily', (requestId) => ({ requestId, qty: '4' }));
    beginHeldWrite('expense:new', (requestId) => ({ requestId, amount: '50' }));

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

    // User A's keys are completely removed.
    expect(
      Object.keys(localStorage).some((k) =>
        k.startsWith(userStoragePrefix('user-a')),
      ),
    ).toBe(false);
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

    // Explicit cleanup helper also isolates by user.
    clearHeldWritesForUser('user-b');
    expect(
      Object.keys(localStorage).some((k) =>
        k.startsWith(userStoragePrefix('user-b')),
      ),
    ).toBe(false);
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

  it('R3-1d: clearPostedReload requires BOTH matching requestId and readTarget', () => {
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
    clearPostedReload('expense:new');
    expect(hasPostedReload('expense:new', '2030-03-01')).toBe(true);

    // Clearing with wrong target must NOT clear.
    clearPostedReload('expense:new', '2030-04-01');
    expect(hasPostedReload('expense:new', '2030-03-01')).toBe(true);

    // Clearing with matching target + WRONG requestId must NOT clear.
    clearPostedReload('expense:new', '2030-03-01', 'req-exp-wrong');
    expect(hasPostedReload('expense:new', '2030-03-01')).toBe(true);

    // Clearing with matching target AND matching requestId clears it.
    clearPostedReload('expense:new', '2030-03-01', 'req-exp-1');
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

    // Fallback when navigator.locks is missing: inflight promotes to unknown on hydration,
    // and claimFreshHeldWrite still refuses an existing unresolved pin via storage re-read.
    localStorage.clear();
    const fallbackA = createHeldWriteStore({ getLocks: () => null });
    const fallbackB = createHeldWriteStore({ getLocks: () => null });
    try {
      fallbackA.setHeldWriteUser('user-a');
      const claimed = await fallbackA.claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
      );
      expect(claimed.ok).toBe(true);
      if (claimed.ok) claimed.release();

      fallbackB.setHeldWriteUser('user-a');
      expect(fallbackB.getHeldWrite('count:daily')?.phase).toBe('unknown');

      const refused = await fallbackB.claimFreshHeldWrite(
        'count:daily',
        (requestId) => ({ requestId }),
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toBe('conflict');
    } finally {
      fallbackA.dispose();
      fallbackB.dispose();
    }
  });

  it('R4-2: failed posted_reload storage write keeps the old durable inflight pin and throws HeldWriteStorageError', async () => {
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
    const reqId = claimed.record.requestId;
    claimed.release();

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

  it('R5-2c: an older read in Tab 1 cannot clear a newer reload marker written by Tab 2', () => {
    const tab1 = createHeldWriteStore();
    const tab2 = createHeldWriteStore();
    try {
      tab1.setHeldWriteUser('user-1');
      tab2.setHeldWriteUser('user-1');

      tab1.setReloadMarker('expense:reload', '2026-11-01');
      const snapBeforeTab1Read = tab1.snapshotPostedReloads({
        subject: 'expense:reload',
      });

      // Tab 2 performs a newer write and sets a newer reload marker while Tab 1's read is in flight.
      tab2.setReloadMarker('expense:reload', '2026-11-01');

      // Tab 1's older read finishes and attempts to clear its snapshot.
      tab1.clearPostedReloadSnapshot(snapBeforeTab1Read, '2026-11-01');

      // Tab 2's newer marker MUST still be held in storage!
      tab2.rehydrateHeldWrites();
      expect(tab2.hasReloadMarker('expense:reload', '2026-11-01')).toBe(true);
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
});
