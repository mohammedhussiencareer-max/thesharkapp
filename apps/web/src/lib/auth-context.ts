import { createContext, useContext } from 'react';

export type AuthStatus =
  'loading' | 'signed-out' | 'checking' | 'owner' | 'denied' | 'error';

export type AuthValue = {
  status: AuthStatus;
  email: string | null;
  signIn: (email: string, password: string) => Promise<'ok' | 'invalid'>;
  signOut: () => Promise<void>;
  retry: () => void;
};

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return value;
}
