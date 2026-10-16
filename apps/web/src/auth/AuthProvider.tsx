import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { AuthContext, type AuthValue } from '@/lib/auth-context';
import {
  getAuthSnapshot,
  signIn,
  signOut,
  subscribeAuth,
} from '@/lib/auth-store';

export function AuthProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribeAuth,
    getAuthSnapshot,
    getAuthSnapshot,
  );
  const value = useMemo<AuthValue>(
    () => ({
      status: snapshot.status,
      email: snapshot.email,
      signIn,
      signOut,
    }),
    [snapshot],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
