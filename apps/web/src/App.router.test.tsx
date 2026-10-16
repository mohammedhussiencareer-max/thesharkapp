import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { resetAuthStore } from '@/lib/auth-store';

type Session = { user: { id: string; email: string } } | null;

const authState = vi.hoisted(() => ({
  session: null as Session,
  isOwner: false,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (
        callback: (event: string, session: Session) => void,
      ) => {
        callback('INITIAL_SESSION', authState.session);
        return {
          data: {
            subscription: {
              unsubscribe: () => undefined,
            },
          },
        };
      },
      signInWithPassword: () =>
        Promise.resolve({
          data: { user: null, session: null },
          error: null,
        }),
      signOut: () => Promise.resolve({ error: null }),
    },
    schema: () => ({
      rpc: () => Promise.resolve({ data: authState.isOwner, error: null }),
    }),
  },
  readSupabaseEnv: () => ({
    url: 'http://127.0.0.1:55421',
    anonKey: 'anon-key',
  }),
}));

describe('app router', () => {
  beforeEach(() => {
    authState.session = null;
    authState.isOwner = false;
    resetAuthStore();
    window.history.replaceState(null, '', '/');
  });

  it('renders /login and /', async () => {
    window.history.replaceState(null, '', '/login');
    const login = render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'تسجيل الدخول' }),
    ).toBeInTheDocument();

    login.unmount();
    resetAuthStore();

    authState.session = {
      user: { id: 'owner', email: 'owner@theshark.test' },
    };
    authState.isOwner = true;
    window.history.replaceState(null, '', '/');
    render(<App />);

    expect(await screen.findByText('owner@theshark.test')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'The Shark' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'تسجيل الخروج' }),
    ).toBeInTheDocument();
  });
});
