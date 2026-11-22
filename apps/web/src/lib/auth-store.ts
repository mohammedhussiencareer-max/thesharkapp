import type { Session } from '@supabase/supabase-js';
import {
  clearHeldWritesForUser,
  resetHeldWritesStore,
  setHeldWriteUser,
  setWritesLocked,
} from '@/lib/held-writes';
import { setPwaAuthResolved } from '@/lib/pwa';
import { supabase } from '@/lib/supabase';
import type { AuthStatus } from '@/lib/auth-context';

type Snapshot = {
  status: AuthStatus;
  email: string | null;
};

let snapshot: Snapshot = { status: 'loading', email: null };
let started = false;
let checkId = 0;
let currentSession: Session | null = null;
let lastUserId: string | null = null;
let unsubscribeAuth: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(next: Snapshot) {
  if (snapshot.status === next.status && snapshot.email === next.email) return;
  snapshot = next;
  setPwaAuthResolved(next.status !== 'loading' && next.status !== 'checking');
  for (const listener of listeners) listener();
}

function emailOf(session: Session): string | null {
  return session.user.email ?? null;
}

function checkOwner(session: Session) {
  const client = supabase;
  if (!client) return;
  const id = ++checkId;
  const email = emailOf(session);
  emit({ status: 'checking', email });

  // The auth callback holds a lock; defer the owner lookup so it cannot deadlock.
  setTimeout(() => {
    void (async () => {
      const { data, error } = await client.schema('app').rpc('is_owner');
      if (id !== checkId) return;
      if (error || (data !== true && data !== false)) {
        emit({ status: 'error', email });
        return;
      }
      if (data === false) {
        emit({ status: 'denied', email });
        return;
      }
      emit({ status: 'owner', email });
    })();
  }, 0);
}

export function startAuth() {
  if (started) return;
  const client = supabase;
  if (!client) return;
  started = true;
  setHeldWriteUser(null);

  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((event, session) => {
    const previousUserId = currentSession?.user.id ?? lastUserId;
    currentSession = session;
    if (!session) {
      setWritesLocked(true);
      if (event === 'SIGNED_OUT' && previousUserId) {
        clearHeldWritesForUser(previousUserId);
      }
      lastUserId = null;
      setHeldWriteUser(null);
      checkId += 1;
      emit({ status: 'signed-out', email: null });
      return;
    }
    lastUserId = session.user.id;
    setWritesLocked(false);
    setHeldWriteUser(session.user.id);
    checkOwner(session);
  });

  unsubscribeAuth = () => subscription.unsubscribe();
}

export function subscribeAuth(listener: () => void) {
  listeners.add(listener);
  startAuth();
  return () => {
    listeners.delete(listener);
  };
}

export function getAuthSnapshot(): Snapshot {
  return snapshot;
}

export function isAuthResolved(): boolean {
  return snapshot.status !== 'loading' && snapshot.status !== 'checking';
}

export async function signIn(
  email: string,
  password: string,
): Promise<'ok' | 'invalid'> {
  const client = supabase;
  if (!client) return 'invalid';
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return 'invalid';
  return 'ok';
}

export async function signOut() {
  const client = supabase;
  if (!client) return;
  const userId = currentSession?.user.id ?? lastUserId;
  // Lock all writes and drop active session immediately, BEFORE clearing keys
  // or awaiting the network sign-out call.
  setWritesLocked(true);
  currentSession = null;
  checkId += 1;
  emit({ status: 'signed-out', email: null });
  if (userId) {
    clearHeldWritesForUser(userId);
  }
  lastUserId = null;
  setHeldWriteUser(null);
  await client.auth.signOut();
}

export function retryOwnerCheck() {
  const session = currentSession;
  if (!session) return;
  checkOwner(session);
}

export function resetAuthStore() {
  checkId += 1;
  currentSession = null;
  lastUserId = null;
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  started = false;
  snapshot = { status: 'loading', email: null };
  setPwaAuthResolved(false);
  listeners.clear();
  resetHeldWritesStore({ clearStorage: false, resetUser: true });
}
