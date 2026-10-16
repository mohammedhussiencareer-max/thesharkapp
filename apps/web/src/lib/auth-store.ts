import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { AuthStatus } from '@/lib/auth-context';

type Snapshot = {
  status: AuthStatus;
  email: string | null;
};

let snapshot: Snapshot = { status: 'loading', email: null };
let started = false;
let checkId = 0;
let unsubscribeAuth: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(next: Snapshot) {
  if (snapshot.status === next.status && snapshot.email === next.email) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function emailOf(session: Session): string | null {
  return session.user.email ?? null;
}

export function startAuth() {
  if (started) return;
  const client = supabase;
  if (!client) return;
  started = true;

  const {
    data: { subscription },
  } = client.auth.onAuthStateChange((_event, session) => {
    if (!session) {
      checkId += 1;
      emit({
        status: snapshot.status === 'denied' ? 'denied' : 'signed-out',
        email: null,
      });
      return;
    }

    const id = ++checkId;
    const email = emailOf(session);
    emit({ status: 'checking', email });

    // The auth callback holds a lock; defer the owner lookup so it cannot deadlock.
    setTimeout(() => {
      void (async () => {
        const { data, error } = await client.schema('app').rpc('is_owner');
        if (id !== checkId) return;
        if (error || data !== true) {
          if (error || data !== false) {
            emit({ status: 'error', email });
            return;
          }
          emit({ status: 'denied', email: null });
          await client.auth.signOut();
          return;
        }
        emit({ status: 'owner', email });
      })();
    }, 0);
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

export async function signIn(
  email: string,
  password: string,
): Promise<'ok' | 'invalid'> {
  const client = supabase;
  if (!client) return 'invalid';
  if (snapshot.status === 'denied') {
    emit({ status: 'signed-out', email: null });
  }
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return 'invalid';
  return 'ok';
}

export async function signOut() {
  const client = supabase;
  if (!client) return;
  checkId += 1;
  await client.auth.signOut();
}

export function resetAuthStore() {
  checkId += 1;
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  started = false;
  snapshot = { status: 'loading', email: null };
  listeners.clear();
}
