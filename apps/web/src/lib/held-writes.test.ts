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
});
