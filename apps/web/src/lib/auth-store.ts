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
let terminalToken = 0;
let outstandingSignOuts = 0;
let staleNulls = 0;
let signOutPromise: Promise<void> | null = null;
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

function waitForSignOut(): Promise<void> {
  return signOutPromise ?? Promise.resolve();
}

function beginSignOut(): Promise<void> {
  if (signOutPromise) return signOutPromise;
  const client = supabase;
  if (!client) return Promise.resolve();
  outstandingSignOuts += 1;
  const task = client.auth
    .signOut()
    .then(() => undefined)
    .finally(() => {
      if (signOutPromise === task) signOutPromise = null;
    });
  signOutPromise = task;
  return task;
}

async function settleSignOut(done: 'denied' | 'signed-out'): Promise<void> {
  const token = ++terminalToken;
  checkId += 1;
  emit({ status: 'signing-out', email: null });
  await beginSignOut();
  if (token !== terminalToken) return;
  emit({ status: done, email: null });
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
      // A sign-out that started before the current session must not clear it.
      if (staleNulls > 0) {
        staleNulls -= 1;
        return;
      }
      if (outstandingSignOuts > 0) outstandingSignOuts -= 1;
      checkId += 1;
      if (snapshot.status === 'signing-out') return;
      emit({
        status: snapshot.status === 'denied' ? 'denied' : 'signed-out',
        email: null,
      });
      return;
    }

    if (outstandingSignOuts > 0) {
      staleNulls += outstandingSignOuts;
      outstandingSignOuts = 0;
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
          await settleSignOut('denied');
          return;
        }
        if (id !== checkId) return;
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
  const token = ++terminalToken;
  if (snapshot.status === 'denied') {
    emit({ status: 'signed-out', email: null });
  }
  await waitForSignOut();
  if (token !== terminalToken) return 'invalid';
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (token !== terminalToken) return 'invalid';
  if (error) {
    emit({ status: 'signed-out', email: null });
    return 'invalid';
  }
  return 'ok';
}

export async function signOut() {
  await settleSignOut('signed-out');
}

export function resetAuthStore() {
  checkId += 1;
  terminalToken += 1;
  outstandingSignOuts = 0;
  staleNulls = 0;
  signOutPromise = null;
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  started = false;
  snapshot = { status: 'loading', email: null };
  listeners.clear();
}
