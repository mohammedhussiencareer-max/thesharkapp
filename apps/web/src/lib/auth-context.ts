import { createContext, useContext } from 'react';

export type AuthStatus =
  'loading' | 'signed-out' | 'checking' | 'owner' | 'denied' | 'error';

export type AuthValue = {
  status: AuthStatus;
  email: string | null;
  logoutPending?: boolean;
  logoutFailed?: boolean;
  logoutRevocationFailed?: boolean;
  signIn: (email: string, password: string) => Promise<'ok' | 'invalid'>;
  signOut: () => Promise<void>;
  retryLogoutRevocation?: () => Promise<void>;
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
