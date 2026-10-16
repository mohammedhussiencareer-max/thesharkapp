import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/auth/AuthProvider';
import { AppRoutes } from '@/App';
import { getAuthSnapshot, resetAuthStore } from '@/lib/auth-store';

type Session = { user: { id: string; email: string } } | null;
type RpcResult = {
  data: boolean | null;
  error: { message: string } | null;
};

const authState = vi.hoisted(() => ({
  session: null as Session,
  isOwner: false,
  rpcError: null as { message: string } | null,
  signInError: null as { message: string } | null,
  signInGate: null as Promise<{
    data: { user: null; session: null };
    error: { message: string } | null;
  }> | null,
  holdRpc: false,
  rpcHolds: [] as Array<(result: RpcResult) => void>,
  listeners: [] as Array<(event: string, session: Session) => void>,
  signOut: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
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
  authState.signInGate = null;
  authState.holdRpc = false;
  authState.rpcHolds.splice(0, authState.rpcHolds.length);
  authState.listeners.splice(0, authState.listeners.length);
  authState.signOut.mockClear();
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
});
