import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/auth/AuthProvider';
import { AppRoutes } from '@/App';
import { resetAuthStore } from '@/lib/auth-store';

type Session = { user: { id: string; email: string } } | null;

const authState = vi.hoisted(() => ({
  session: null as Session,
  isOwner: false,
  rpcError: null as { message: string } | null,
  signInError: null as { message: string } | null,
  signInGate: null as Promise<{
    data: { user: null; session: null };
    error: { message: string } | null;
  }> | null,
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

describe('owner access', () => {
  beforeEach(() => {
    authState.session = null;
    authState.isOwner = false;
    authState.rpcError = null;
    authState.signInError = null;
    authState.signInGate = null;
    authState.listeners.splice(0, authState.listeners.length);
    authState.signOut.mockClear();
    resetAuthStore();
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
  });

  it('signs out a non-owner and shows the Arabic rejection', async () => {
    authState.session = {
      user: { id: 'intruder', email: 'intruder@theshark.test' },
    };
    authState.isOwner = false;

    renderApp('/');

    expect(
      await screen.findByText('الحساب ده مش مسموح له يدخل'),
    ).toBeInTheDocument();
    expect(authState.signOut).toHaveBeenCalledOnce();
    expect(screen.queryByText('intruder@theshark.test')).toBeNull();
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
  });
});

describe('login', () => {
  beforeEach(() => {
    authState.session = null;
    authState.isOwner = false;
    authState.rpcError = null;
    authState.signInError = null;
    authState.signInGate = null;
    authState.listeners.splice(0, authState.listeners.length);
    authState.signOut.mockClear();
    resetAuthStore();
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
