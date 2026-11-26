import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/auth/AuthProvider';
import { AppRoutes } from '@/App';
import {
  getAuthSnapshot,
  isAuthResolved,
  resetAuthStore,
} from '@/lib/auth-store';

type Session = {
  user: { id: string; email: string };
  access_token?: string;
  refresh_token?: string;
} | null;
type RpcResult = {
  data: boolean | null;
  error: { message: string } | null;
};

const authState = vi.hoisted(() => ({
  session: null as Session,
  isOwner: false,
  rpcError: null as { message: string } | null,
  signInError: null as { message: string } | null,
  signInThrow: null as Error | null,
  signInGate: null as Promise<{
    data: { user: null; session: null };
    error: { message: string } | null;
  }> | null,
  holdRpc: false,
  rpcHolds: [] as Array<(result: RpcResult) => void>,
  listeners: [] as Array<(event: string, session: Session) => void>,
  signOut: vi.fn(),
  signOutError: null as { message: string } | null,
  adminSignOut: vi.fn(),
  adminSignOutError: null as { message: string; status?: number } | null,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      admin: {
        signOut: (jwt: string, scope?: string) => {
          authState.adminSignOut(jwt, scope);
          if (authState.adminSignOutError) {
            return Promise.resolve({
              data: null,
              error: authState.adminSignOutError,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      },
      onAuthStateChange: (
        callback: (event: string, session: Session) => void,
      ) => {
        authState.listeners.push(callback);
        callback('INITIAL_SESSION', authState.session);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                const index = authState.listeners.indexOf(callback);
                if (index >= 0) authState.listeners.splice(index, 1);
              },
            },
          },
        };
      },
      signInWithPassword: () => {
        if (authState.signInThrow) {
          return Promise.reject(authState.signInThrow);
        }
        if (authState.signInGate) return authState.signInGate;
        if (authState.signInError) {
          return Promise.resolve({
            data: { user: null, session: null },
            error: authState.signInError,
          });
        }
        return Promise.resolve({
          data: { user: null, session: null },
          error: null,
        });
      },
      signOut: () => {
        authState.signOut();
        if (authState.signOutError) {
          return Promise.resolve({ error: authState.signOutError });
        }
        authState.session = null;
        for (const listener of [...authState.listeners]) {
          listener('SIGNED_OUT', null);
        }
        return Promise.resolve({ error: null });
      },
    },
    schema: () => ({
      rpc: () => {
        if (authState.holdRpc) {
          return new Promise<RpcResult>((resolve) => {
            authState.rpcHolds.push(resolve);
          });
        }
        if (authState.rpcError) {
          return Promise.resolve({ data: null, error: authState.rpcError });
        }
        return Promise.resolve({ data: authState.isOwner, error: null });
      },
    }),
  },
  readSupabaseEnv: () => ({
    url: 'http://127.0.0.1:55421',
    anonKey: 'anon-key',
  }),
}));

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

function resetMock() {
  authState.session = null;
  authState.isOwner = false;
  authState.rpcError = null;
  authState.signInError = null;
  authState.signInThrow = null;
  authState.signInGate = null;
  authState.holdRpc = false;
  authState.rpcHolds.splice(0, authState.rpcHolds.length);
  authState.listeners.splice(0, authState.listeners.length);
  authState.signOut.mockClear();
  authState.signOutError = null;
  authState.adminSignOut.mockClear();
  authState.adminSignOutError = null;
  resetAuthStore();
}

function notifySession(session: Session) {
  authState.session = session;
  act(() => {
    for (const listener of authState.listeners) {
      listener('SIGNED_IN', session);
    }
  });
}

describe('owner access', () => {
  beforeEach(() => {
    resetMock();
  });

  it('redirects to login when signed out', async () => {
    renderApp('/');

    expect(
      await screen.findByRole('heading', { name: 'تسجيل الدخول' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تسجيل الخروج' })).toBeNull();
  });

  it('shows home when the signed-in user is the owner', async () => {
    authState.session = {
      user: { id: 'owner', email: 'owner@theshark.test' },
    };
    authState.isOwner = true;

    renderApp('/');

    expect(await screen.findByText('owner@theshark.test')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'The Shark' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'تسجيل الخروج' }),
    ).toBeInTheDocument();
    expect(authState.signOut).not.toHaveBeenCalled();
  });

  it('shows a denied screen and signs out only when asked', async () => {
    authState.session = {
      user: { id: 'intruder', email: 'intruder@theshark.test' },
    };
    authState.isOwner = false;

    renderApp('/');

    expect(
      await screen.findByRole('heading', {
        name: 'الحساب ده مش مسموح له يدخل',
      }),
    ).toBeInTheDocument();
    expect(getAuthSnapshot().status).toBe('denied');
    expect(authState.session?.user.email).toBe('intruder@theshark.test');
    expect(authState.signOut).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));

    expect(authState.signOut).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole('heading', { name: 'تسجيل الدخول' }),
    ).toBeInTheDocument();
    expect(getAuthSnapshot().status).toBe('signed-out');
  });

  it('keeps the session when the owner check cannot be completed', async () => {
    authState.session = {
      user: { id: 'owner', email: 'owner@theshark.test' },
    };
    authState.rpcError = { message: 'network down' };

    renderApp('/');

    expect(
      await screen.findByText('تعذر التحقق من صلاحية الحساب'),
    ).toBeInTheDocument();
    expect(authState.signOut).not.toHaveBeenCalled();
    expect(screen.queryByText('network down')).toBeNull();

    authState.rpcError = null;
    authState.isOwner = true;
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('owner@theshark.test')).toBeInTheDocument();
    expect(getAuthSnapshot().status).toBe('owner');
    expect(authState.signOut).not.toHaveBeenCalled();
  });

  it('ignores a stale owner check from an older session', async () => {
    authState.holdRpc = true;
    authState.session = {
      user: { id: 'intruder', email: 'intruder@theshark.test' },
    };
    authState.isOwner = false;
    renderApp('/');

    await vi.waitFor(() => {
      expect(authState.rpcHolds).toHaveLength(1);
    });

    authState.holdRpc = false;
    authState.isOwner = true;
    notifySession({ user: { id: 'owner', email: 'owner@theshark.test' } });

    expect(await screen.findByText('owner@theshark.test')).toBeInTheDocument();

    const stale = authState.rpcHolds[0];
    await act(async () => {
      stale?.({ data: false, error: null });
      await Promise.resolve();
    });

    expect(getAuthSnapshot().status).toBe('owner');
    expect(screen.getByText('owner@theshark.test')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'الحساب ده مش مسموح له يدخل' }),
    ).toBeNull();
    expect(authState.signOut).not.toHaveBeenCalled();
  });

  it('keeps the owner view mounted during same-session refocus recheck while still revoking if ownership is denied', async () => {
    const payload = btoa(JSON.stringify({ session_id: 'sid-owner-refocus' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const session = {
      user: { id: 'owner', email: 'owner@theshark.test' },
      access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`,
      refresh_token: 'rt-owner-1',
    };
    authState.session = session;
    authState.isOwner = true;

    renderApp('/');
    expect(await screen.findByText('owner@theshark.test')).toBeInTheDocument();

    authState.holdRpc = true;
    notifySession({ ...session });

    expect(getAuthSnapshot().status).toBe('owner');
    expect(screen.getByText('owner@theshark.test')).toBeInTheDocument();
    expect(screen.queryByText('جاري التحقق…')).toBeNull();

    await vi.waitFor(() => {
      expect(authState.rpcHolds).toHaveLength(1);
    });

    await act(async () => {
      authState.rpcHolds[0]?.({ data: false, error: null });
      await Promise.resolve();
    });

    expect(
      await screen.findByRole('heading', {
        name: 'الحساب ده مش مسموح له يدخل',
      }),
    ).toBeInTheDocument();
    expect(getAuthSnapshot().status).toBe('denied');
  });

  it('keeps logout unresolved and surfaces a retry button on /login when signOut returns an error', async () => {
    const session = {
      user: { id: 'owner', email: 'owner@theshark.test' },
      access_token: 'tok-owner',
      refresh_token: 'rt-owner',
    };
    authState.session = session;
    authState.isOwner = true;
    authState.signOutError = { message: 'session refresh failed' };

    renderApp('/');
    expect(await screen.findByText('owner@theshark.test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));

    const retryLogoutBtn = await screen.findByRole('button', {
      name: 'إعادة محاولة تسجيل الخروج',
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(authState.signOut).toHaveBeenCalledTimes(1);

    // Reconfirming the retained session must NOT reopen owner access.
    notifySession({ ...session });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(getAuthSnapshot().status).toBe('signed-out');
    expect(screen.queryByText('owner@theshark.test')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'إعادة محاولة تسجيل الخروج' }),
    ).toBeInTheDocument();

    // Retrying after connectivity returns completes logout and clears the alert.
    authState.signOutError = null;
    fireEvent.click(retryLogoutBtn);
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(authState.signOut).toHaveBeenCalledTimes(2);
    expect(isAuthResolved()).toBe(true);
    expect(screen.getByRole('button', { name: 'تسجيل الدخول' })).toBeEnabled();
  });

  it('blocks a retained SDK session after a failed logout even across a document reload until retry succeeds', async () => {
    const session = {
      user: { id: 'owner', email: 'owner@theshark.test' },
      access_token: 'tok-owner-reload',
      refresh_token: 'rt-owner-reload',
    };
    authState.session = session;
    authState.isOwner = true;
    authState.signOutError = { message: 'session refresh failed' };

    const firstView = renderApp('/');
    expect(await screen.findByText('owner@theshark.test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    expect(
      await screen.findByRole('button', { name: 'إعادة محاولة تسجيل الخروج' }),
    ).toBeInTheDocument();
    expect(authState.signOut).toHaveBeenCalledTimes(1);
    firstView.unmount();

    // Simulate a fresh document reload while the SDK still retains the session.
    vi.resetModules();
    const [freshAuthStore, freshProviderMod, freshAppMod] = await Promise.all([
      import('@/lib/auth-store'),
      import('@/auth/AuthProvider'),
      import('@/App'),
    ]);

    const reloadedView = render(
      <MemoryRouter initialEntries={['/']}>
        <freshProviderMod.AuthProvider>
          <freshAppMod.AppRoutes />
        </freshProviderMod.AuthProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('button', { name: 'إعادة محاولة تسجيل الخروج' }),
    ).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(freshAuthStore.getAuthSnapshot()).toMatchObject({
      status: 'signed-out',
      email: null,
      logoutPending: false,
      logoutFailed: true,
    });
    expect(freshAuthStore.isAuthResolved()).toBe(false);
    expect(screen.queryByText('owner@theshark.test')).toBeNull();
    expect(screen.getByRole('button', { name: 'تسجيل الدخول' })).toBeDisabled();
    expect(
      await freshAuthStore.signIn('owner@theshark.test', 'ValidPassword123'),
    ).toBe('failed');

    // Retrying logout after connectivity returns removes local credentials and clears the guard.
    authState.signOutError = null;
    fireEvent.click(
      screen.getByRole('button', { name: 'إعادة محاولة تسجيل الخروج' }),
    );
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(authState.signOut).toHaveBeenCalledTimes(2);
    expect(freshAuthStore.isAuthResolved()).toBe(true);
    expect(screen.getByRole('button', { name: 'تسجيل الدخول' })).toBeEnabled();
    reloadedView.unmount();
    freshAuthStore.resetAuthStore({ clearStorage: false });

    // A subsequent reload after local credentials were removed starts cleanly signed out.
    vi.resetModules();
    const [cleanAuthStore, cleanProviderMod, cleanAppMod] = await Promise.all([
      import('@/lib/auth-store'),
      import('@/auth/AuthProvider'),
      import('@/App'),
    ]);
    const cleanView = render(
      <MemoryRouter initialEntries={['/']}>
        <cleanProviderMod.AuthProvider>
          <cleanAppMod.AppRoutes />
        </cleanProviderMod.AuthProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'تسجيل الدخول' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(cleanAuthStore.getAuthSnapshot()).toMatchObject({
      status: 'signed-out',
      logoutFailed: false,
    });
    expect(cleanAuthStore.isAuthResolved()).toBe(true);
    cleanView.unmount();
    cleanAuthStore.resetAuthStore();
  });

  it('surfaces global revocation failure separately on /login after quota fallback removes local credentials and clears it on retry', async () => {
    const sdkStorageKey = 'sb-127-auth-token';
    const session = {
      user: { id: 'owner', email: 'owner@theshark.test' },
      access_token: 'tok-owner-quota-ui',
      refresh_token: 'rt-owner-quota-ui',
    };
    const setItemDesc = Object.getOwnPropertyDescriptor(
      Storage.prototype,
      'setItem',
    );
    const origSetItem = setItemDesc?.value as (
      this: Storage,
      key: string,
      value: string,
    ) => void;
    let rejectNewWrites = false;
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (rejectNewWrites && this.getItem(key) === null) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        origSetItem.call(this, key, value);
      });

    try {
      localStorage.setItem(sdkStorageKey, JSON.stringify(session));
      authState.session = session;
      authState.isOwner = true;
      authState.adminSignOutError = {
        message: 'service unavailable',
        status: 503,
      };

      renderApp('/');
      expect(
        await screen.findByText('owner@theshark.test'),
      ).toBeInTheDocument();

      rejectNewWrites = true;
      fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));

      const retryRevokeBtn = await screen.findByRole('button', {
        name: 'إعادة محاولة إنهاء الجلسات الأخرى',
      });
      expect(localStorage.getItem(sdkStorageKey)).toBeNull();
      expect(authState.adminSignOut).toHaveBeenCalledWith(
        'tok-owner-quota-ui',
        'global',
      );
      expect(
        screen.queryByRole('button', { name: 'إعادة محاولة تسجيل الخروج' }),
      ).toBeNull();
      expect(getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: true,
      });
      expect(
        screen.getByRole('button', { name: 'تسجيل الدخول' }),
      ).toBeEnabled();

      // Retry global revocation after connectivity returns.
      authState.adminSignOutError = null;
      fireEvent.click(retryRevokeBtn);
      await vi.waitFor(() => {
        expect(screen.queryByRole('alert')).toBeNull();
      });
      expect(authState.adminSignOut).toHaveBeenCalledTimes(2);
      expect(getAuthSnapshot()).toMatchObject({
        status: 'signed-out',
        logoutPending: false,
        logoutFailed: false,
        logoutRevocationFailed: false,
      });
    } finally {
      setItemSpy.mockRestore();
      localStorage.removeItem(sdkStorageKey);
    }
  });

  it('I2: keeps unconfirmed global revocation notice across reload without offering a fake retry when no retained token exists', async () => {
    const markerKey = `theshark:auth:logout-pending:v1:${encodeURIComponent('http://127.0.0.1:55421')}`;
    localStorage.setItem(
      markerKey,
      JSON.stringify({
        attemptId: 4,
        ownerTabId: 'previous-tab',
        state: 'revocation_failed',
        sessionKey: 'rt:old-token',
      }),
    );

    renderApp('/login');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'تم تسجيل الخروج من هذا الجهاز، لكن تعذر تأكيد إنهاء الجلسة على الأجهزة الأخرى',
    );
    expect(
      screen.queryByRole('button', {
        name: 'إعادة محاولة إنهاء الجلسات الأخرى',
      }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'تسجيل الدخول' })).toBeEnabled();
    expect(getAuthSnapshot()).toMatchObject({
      status: 'signed-out',
      logoutPhase: 'revocation_failed',
      logoutFailed: false,
      logoutRevocationFailed: true,
      canRetryLogoutRevocation: false,
    });
  });
});

describe('login', () => {
  beforeEach(() => {
    resetMock();
  });

  function fillForm() {
    fireEvent.change(screen.getByLabelText('البريد'), {
      target: { value: 'owner@theshark.test' },
    });
    fireEvent.change(screen.getByLabelText('كلمة السر'), {
      target: { value: 'WrongPassword123' },
    });
  }

  it('shows a generic error and no signup or reset link', async () => {
    authState.signInError = { message: 'Invalid login credentials' };
    renderApp('/login');

    expect(
      await screen.findByRole('heading', { name: 'تسجيل الدخول' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();

    fillForm();
    fireEvent.submit(
      screen.getByRole('button', { name: 'تسجيل الدخول' }).closest('form')!,
    );

    expect(
      await screen.findByText('البريد أو كلمة السر غلط'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Invalid login credentials')).toBeNull();
  });

  it('shows a loading state while sign-in is in progress', async () => {
    let release: (value: {
      data: { user: null; session: null };
      error: { message: string } | null;
    }) => void = () => {};
    authState.signInGate = new Promise((resolve) => {
      release = resolve;
    });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'تسجيل الدخول' });

    fillForm();
    fireEvent.submit(
      screen.getByRole('button', { name: 'تسجيل الدخول' }).closest('form')!,
    );

    expect(
      await screen.findByRole('button', { name: 'جاري الدخول…' }),
    ).toBeDisabled();

    release({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    });
    expect(
      await screen.findByText('البريد أو كلمة السر غلط'),
    ).toBeInTheDocument();
  });

  it('P2-3: recovers from a QuotaExceededError thrown during signInWithPassword without permanently locking the submit button', async () => {
    authState.signInThrow = new DOMException(
      'QuotaExceededError',
      'QuotaExceededError',
    );
    try {
      renderApp('/login');
      await screen.findByRole('heading', { name: 'تسجيل الدخول' });

      fillForm();
      fireEvent.submit(
        screen.getByRole('button', { name: 'تسجيل الدخول' }).closest('form')!,
      );

      expect(
        await screen.findByText('تعذر تسجيل الدخول، حاول مرة أخرى'),
      ).toBeInTheDocument();
      expect(screen.queryByText('البريد أو كلمة السر غلط')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'تسجيل الدخول' }),
      ).toBeEnabled();
    } finally {
      authState.signInThrow = null;
    }
  });

  it('item 8a: signIn returns failed and LoginPage shows neutral Arabic error for thrown network/storage errors while keeping wrong credentials as invalid', async () => {
    authState.signInThrow = new TypeError('Failed to fetch');
    try {
      renderApp('/login');
      await screen.findByRole('heading', { name: 'تسجيل الدخول' });

      fillForm();
      fireEvent.submit(
        screen.getByRole('button', { name: 'تسجيل الدخول' }).closest('form')!,
      );

      expect(
        await screen.findByText('تعذر تسجيل الدخول، حاول مرة أخرى'),
      ).toBeInTheDocument();
      expect(screen.queryByText('البريد أو كلمة السر غلط')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'تسجيل الدخول' }),
      ).toBeEnabled();
    } finally {
      authState.signInThrow = null;
    }
  });

  it('item 8b: throw after server accepted sign-in returns failed and leaves a consistent signed-out state with server session revoked', async () => {
    const { createAuthStore } = await import('@/lib/auth-store');
    type StoreClient = ReturnType<
      NonNullable<
        NonNullable<Parameters<typeof createAuthStore>[0]>['getClient']
      >
    >;
    const acceptedUser = {
      id: 'owner-post-throw',
      email: 'owner@theshark.test',
    };
    const acceptedSession: NonNullable<Session> = {
      access_token: 'tok-accepted',
      refresh_token: 'rt-accepted',
      user: acceptedUser,
    };
    const listeners = new Set<
      (event: string, session: Session | null) => void
    >();
    const signOutMock = vi.fn(() => Promise.resolve({ error: null }));
    const fakeClient = {
      auth: {
        getSession: vi.fn(() =>
          Promise.resolve({ data: { session: null }, error: null }),
        ),
        onAuthStateChange: vi.fn(
          (cb: (event: string, session: Session | null) => void) => {
            listeners.add(cb);
            return {
              data: {
                subscription: {
                  unsubscribe: () => {
                    listeners.delete(cb);
                  },
                },
              },
            };
          },
        ),
        signInWithPassword: vi.fn(() => {
          // Server accepted sign-in and SDK emitted SIGNED_IN.
          for (const cb of listeners) cb('SIGNED_IN', acceptedSession);
          return Promise.resolve({
            data: { user: acceptedUser, session: acceptedSession },
            error: null,
          });
        }),
        signOut: signOutMock,
      },
      schema: vi.fn(() => ({
        rpc: vi.fn(() => Promise.resolve({ data: true, error: null })),
      })),
    };

    let throwOnSubscribe = false;
    const store = createAuthStore({
      getClient: () => fakeClient as unknown as StoreClient,
      getStorage: () => window.localStorage,
      getProjectUrl: () => 'https://post-throw.example.test',
      syncGlobalStores: false,
    });
    try {
      store.startAuth();
      const unsub = store.subscribeAuth(() => {
        if (throwOnSubscribe) {
          throw new Error('post-accept failure');
        }
      });
      throwOnSubscribe = true;
      const result = await store.signIn(
        'owner@theshark.test',
        'ValidPassword123',
      );
      unsub();

      // Must return 'failed' (not 'invalid') AND leave a consistent state:
      // if failed, session must be rolled back (signed-out) and server session revoked.
      expect(result).toBe('failed');
      expect(store.getAuthSnapshot().status).toBe('signed-out');
      expect(signOutMock).toHaveBeenCalled();
    } finally {
      store.resetAuthStore();
    }
  });
});

describe('production GoTrueClient UI integration (hasDirectRevocationTransport === true)', () => {
  it('P1-1 + P2-1: exercises LoginPage + AuthProvider against real GoTrueClient for reload-while-pending recovery and coalesced sign-out', async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const url = 'https://prod-ui-test.example.test';
    const anonKey = 'anon-key-prod-ui';
    const sdkKey = 'sb-prod-ui-test-auth-token';
    const coordKey = `theshark:auth:logout-pending:v1:${encodeURIComponent(url)}`;

    const makeJwt = (sid: string) => {
      const enc = (o: Record<string, unknown>) =>
        btoa(JSON.stringify(o))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/g, '');
      return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
        sub: 'owner-ui',
        session_id: sid,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}.sig`;
    };

    const session1 = {
      access_token: makeJwt('sid-ui-1'),
      refresh_token: 'rt-ui-1',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id: 'owner-ui',
        email: 'owner-ui@theshark.test',
        aud: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      },
    };
    const session2 = {
      ...session1,
      access_token: makeJwt('sid-ui-2'),
      refresh_token: 'rt-ui-2',
    };

    let logoutCallCount = 0;
    const logoutControl: { release: ((r: Response) => void) | null } = {
      release: null,
    };
    const prodFetch: typeof fetch = (input) => {
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/logout')) {
        logoutCallCount += 1;
        return new Promise<Response>((resolve) => {
          logoutControl.release = resolve;
        });
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        return Promise.resolve(
          new Response(JSON.stringify(session2), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    const client = createClient(url, anonKey, {
      auth: {
        storage: window.localStorage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: { fetch: prodFetch },
    });

    vi.resetModules();
    vi.doMock('@/lib/supabase', () => ({
      supabase: client,
      readSupabaseEnv: () => ({ url, anonKey }),
    }));

    try {
      window.localStorage.setItem(sdkKey, JSON.stringify(session1));

      const [storeMod1, providerMod1, appMod1] = await Promise.all([
        import('@/lib/auth-store'),
        import('@/auth/AuthProvider'),
        import('@/App'),
      ]);

      const view1 = render(
        <MemoryRouter initialEntries={['/']}>
          <providerMod1.AuthProvider>
            <appMod1.AppRoutes />
          </providerMod1.AuthProvider>
        </MemoryRouter>,
      );

      expect(
        await screen.findByText('owner-ui@theshark.test'),
      ).toBeInTheDocument();

      // Click sign-out -> writes pending, removes sdkKey, holds /logout in flight.
      const signOutBtn = screen.getByRole('button', { name: 'تسجيل الخروج' });
      fireEvent.click(signOutBtn);
      await vi.waitFor(() => {
        expect(logoutControl.release).not.toBeNull();
      });
      // P2-1: calling signOut again while in flight coalesces and does not fire a second /logout.
      void storeMod1.signOut();
      expect(logoutCallCount).toBe(1);
      expect(storeMod1.getAuthSnapshot().logoutPending).toBe(true);
      expect(window.localStorage.getItem(sdkKey)).toBeNull();
      expect(
        JSON.parse(window.localStorage.getItem(coordKey) ?? 'null'),
      ).toMatchObject({ state: 'pending' });
      view1.unmount();
      storeMod1.resetAuthStore({ clearStorage: false });

      // Simulate reload while durable logout record is still state:'pending' (P1-1).
      // Under the one-active-tab model, pending from a gone tab immediately resolves
      // conservatively on boot (creds gone -> revocation_failed with login enabled).
      vi.resetModules();
      const clientReloaded = createClient(url, anonKey, {
        auth: {
          storage: window.localStorage,
          storageKey: sdkKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: { fetch: prodFetch },
      });
      vi.doMock('@/lib/supabase', () => ({
        supabase: clientReloaded,
        readSupabaseEnv: () => ({ url, anonKey }),
      }));

      const [storeMod2, providerMod2, appMod2] = await Promise.all([
        import('@/lib/auth-store'),
        import('@/auth/AuthProvider'),
        import('@/App'),
      ]);

      const view2 = render(
        <MemoryRouter initialEntries={['/']}>
          <providerMod2.AuthProvider>
            <appMod2.AppRoutes />
          </providerMod2.AuthProvider>
        </MemoryRouter>,
      );

      // Should show amber revocation notice, NO red local failure banner, login form ENABLED!
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'تم تسجيل الخروج من هذا الجهاز، لكن تعذر تأكيد إنهاء الجلسة على الأجهزة الأخرى',
      );
      expect(
        screen.queryByRole('button', { name: 'إعادة محاولة تسجيل الخروج' }),
      ).toBeNull();
      const loginButton = screen.getByRole('button', { name: 'تسجيل الدخول' });
      expect(loginButton).toBeEnabled();

      // Owner signs in following the recovery prompt -> MUST succeed and land on owner home!
      fireEvent.change(screen.getByLabelText('البريد'), {
        target: { value: 'owner-ui@theshark.test' },
      });
      fireEvent.change(screen.getByLabelText('كلمة السر'), {
        target: { value: 'ValidPassword123' },
      });
      fireEvent.submit(loginButton.closest('form')!);

      expect(
        await screen.findByText('owner-ui@theshark.test'),
      ).toBeInTheDocument();

      view2.unmount();
      await clientReloaded.auth.stopAutoRefresh();
      storeMod2.resetAuthStore();
    } finally {
      logoutControl.release?.(new Response(null, { status: 204 }));
      await client.auth.stopAutoRefresh();
      window.localStorage.removeItem(sdkKey);
      window.localStorage.removeItem(coordKey);
      vi.doUnmock('@/lib/supabase');
      vi.resetModules();
    }
  });

  it('DELTA9-P3-1: LoginPage ignores synchronous double-submit before React re-renders submitting state', async () => {
    let resolveSignIn!: (result: 'ok' | 'invalid' | 'failed') => void;
    const signInMock = vi.fn(
      () =>
        new Promise<'ok' | 'invalid' | 'failed'>((resolve) => {
          resolveSignIn = resolve;
        }),
    );
    const { AuthContext } = await import('@/lib/auth-context');
    const { LoginPage } = await import('@/pages/LoginPage');

    const view = render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthContext.Provider
          value={{
            status: 'signed-out',
            email: null,
            logoutPending: false,
            logoutFailed: false,
            logoutRevocationFailed: false,
            canRetryLogoutRevocation: false,
            signIn: signInMock,
            signOut: vi.fn(async () => {}),
            retryLogoutRevocation: vi.fn(async () => {}),
            retry: vi.fn(),
          }}
        >
          <LoginPage />
        </AuthContext.Provider>
      </MemoryRouter>,
    );

    try {
      fireEvent.change(screen.getByLabelText('البريد'), {
        target: { value: 'owner@theshark.test' },
      });
      fireEvent.change(screen.getByLabelText('كلمة السر'), {
        target: { value: 'ValidPassword123' },
      });
      const form = screen
        .getByRole('button', { name: 'تسجيل الدخول' })
        .closest('form')!;

      // Dispatch two form submissions synchronously in the same tick.
      act(() => {
        fireEvent.submit(form);
        fireEvent.submit(form);
      });

      expect(signInMock).toHaveBeenCalledTimes(1);

      // Once the first attempt finishes with 'invalid', a new submit works again.
      await act(async () => {
        resolveSignIn('invalid');
        await Promise.resolve();
      });
      expect(
        await screen.findByText('البريد أو كلمة السر غلط'),
      ).toBeInTheDocument();

      act(() => {
        fireEvent.submit(form);
      });
      expect(signInMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        resolveSignIn('ok');
        await Promise.resolve();
      });
    } finally {
      view.unmount();
    }
  });

  it('DELTA12-P2-2: LoginPage disables and synchronously guards the revocation retry button while signIn is submitting', async () => {
    let resolveSignIn!: (result: 'ok' | 'invalid' | 'failed') => void;
    const signInMock = vi.fn(
      () =>
        new Promise<'ok' | 'invalid' | 'failed'>((resolve) => {
          resolveSignIn = resolve;
        }),
    );
    const retryRevocationMock = vi.fn(async () => {});
    const { AuthContext } = await import('@/lib/auth-context');
    const { LoginPage } = await import('@/pages/LoginPage');

    const view = render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthContext.Provider
          value={{
            status: 'signed-out',
            email: null,
            logoutPending: false,
            logoutFailed: false,
            logoutRevocationFailed: true,
            canRetryLogoutRevocation: true,
            signIn: signInMock,
            signOut: vi.fn(async () => {}),
            retryLogoutRevocation: retryRevocationMock,
            retry: vi.fn(),
          }}
        >
          <LoginPage />
        </AuthContext.Provider>
      </MemoryRouter>,
    );

    try {
      fireEvent.change(screen.getByLabelText('البريد'), {
        target: { value: 'owner@theshark.test' },
      });
      fireEvent.change(screen.getByLabelText('كلمة السر'), {
        target: { value: 'ValidPassword123' },
      });
      const form = screen
        .getByRole('button', { name: 'تسجيل الدخول' })
        .closest('form')!;
      const retryButton = screen.getByRole('button', {
        name: 'إعادة محاولة إنهاء الجلسات الأخرى',
      });
      expect(retryButton).toBeEnabled();

      // Synchronously submit sign-in AND click the retry button in the same tick:
      // submittingRef MUST block retryLogoutRevocation immediately.
      act(() => {
        fireEvent.submit(form);
        fireEvent.click(retryButton);
      });
      expect(signInMock).toHaveBeenCalledTimes(1);
      expect(retryRevocationMock).not.toHaveBeenCalled();

      // While signIn is in flight, the retry button MUST also be disabled.
      expect(retryButton).toBeDisabled();
      fireEvent.click(retryButton);
      expect(retryRevocationMock).not.toHaveBeenCalled();

      // Once signIn resolves with 'invalid', the retry button re-enables and works.
      await act(async () => {
        resolveSignIn('invalid');
        await Promise.resolve();
      });
      expect(retryButton).toBeEnabled();
      fireEvent.click(retryButton);
      expect(retryRevocationMock).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it('DELTA14-P2-4: LoginPage local_failed banner instructs the owner to retry or close all tabs while keeping login disabled (I1)', async () => {
    const { AuthContext } = await import('@/lib/auth-context');
    const { LoginPage } = await import('@/pages/LoginPage');
    const signOutMock = vi.fn(async () => {});

    const view = render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthContext.Provider
          value={{
            status: 'signed-out',
            email: null,
            logoutPending: false,
            logoutFailed: true,
            logoutRevocationFailed: false,
            canRetryLogoutRevocation: false,
            signIn: vi.fn(() => Promise.resolve('failed' as const)),
            signOut: signOutMock,
            retryLogoutRevocation: vi.fn(() => Promise.resolve()),
            retry: vi.fn(),
          }}
        >
          <LoginPage />
        </AuthContext.Provider>
      </MemoryRouter>,
    );

    try {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(
        'تعذر إنهاء تسجيل الخروج على هذا الجهاز — أعد المحاولة أو أغلق كل التبويبات',
      );
      expect(
        screen.getByRole('button', { name: 'تسجيل الدخول' }),
      ).toBeDisabled();
      const retryLogoutBtn = screen.getByRole('button', {
        name: 'إعادة محاولة تسجيل الخروج',
      });
      expect(retryLogoutBtn).toBeEnabled();
      fireEvent.click(retryLogoutBtn);
      expect(signOutMock).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });
});
