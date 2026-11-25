import type { Session } from '@supabase/supabase-js';
import {
  bumpSessionGeneration,
  clearHeldWritesForUser,
  isWritesLocked,
  rehydrateHeldWrites,
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

function decodeBase64UrlUtf8(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  if (typeof atob !== 'function') return null;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function extractJwtSessionId(accessToken: unknown): string | null {
  if (typeof accessToken !== 'string') return null;
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  const decoded = decodeBase64UrlUtf8(parts[1]);
  if (decoded === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'session_id' in parsed &&
      typeof (parsed as { session_id?: unknown }).session_id === 'string'
    ) {
      const id = (parsed as { session_id: string }).session_id.trim();
      return id !== '' ? id : null;
    }
  } catch {
    return null;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isSameAuthenticatedSession(
  previous: Session | null,
  next: Session,
  event: string,
): boolean {
  if (!previous) return false;
  if (previous.user.id !== next.user.id) return false;

  const prevSessionId = extractJwtSessionId(previous.access_token);
  const nextSessionId = extractJwtSessionId(next.access_token);
  if (prevSessionId !== null || nextSessionId !== null) {
    return prevSessionId === nextSessionId;
  }

  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
    return true;
  }

  const prevAccess = nonEmptyString(previous.access_token);
  const nextAccess = nonEmptyString(next.access_token);
  const prevRefresh = nonEmptyString(previous.refresh_token);
  const nextRefresh = nonEmptyString(next.refresh_token);
  if (
    prevAccess !== null ||
    nextAccess !== null ||
    prevRefresh !== null ||
    nextRefresh !== null
  ) {
    return prevAccess === nextAccess && prevRefresh === nextRefresh;
  }

  return true;
}

function checkOwner(
  session: Session,
  options?: { keepCurrentOwner?: boolean },
) {
  const client = supabase;
  if (!client) return;
  const id = ++checkId;
  const email = emailOf(session);
  if (options?.keepCurrentOwner && snapshot.status === 'owner') {
    emit({ status: 'owner', email });
  } else {
    emit({ status: 'checking', email });
  }

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
    const previousSession = currentSession;
    const previousUserId = previousSession?.user.id ?? lastUserId;
    currentSession = session;
    if (!session) {
      setWritesLocked(true);
      bumpSessionGeneration();
      if (event === 'SIGNED_OUT' && previousUserId) {
        clearHeldWritesForUser(previousUserId);
      }
      lastUserId = null;
      setHeldWriteUser(null);
      checkId += 1;
      emit({ status: 'signed-out', email: null });
      return;
    }
    const wasWritesLocked = isWritesLocked();
    const sameSession =
      !wasWritesLocked &&
      isSameAuthenticatedSession(previousSession, session, event);
    lastUserId = session.user.id;
    if (!sameSession) {
      bumpSessionGeneration();
    }
    setWritesLocked(false);
    setHeldWriteUser(session.user.id);
    if (
      !sameSession &&
      !wasWritesLocked &&
      previousSession?.user.id === session.user.id
    ) {
      rehydrateHeldWrites();
    }
    checkOwner(session, { keepCurrentOwner: sameSession });
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
