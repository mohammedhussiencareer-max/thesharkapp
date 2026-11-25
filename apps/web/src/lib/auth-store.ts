import type { Session } from '@supabase/supabase-js';
import {
  bumpSessionGeneration,
  clearResolvedHeldWritesForUser,
  isWritesLocked,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWriteUser,
  setWritesLocked,
} from '@/lib/held-writes';
import { setPwaAuthResolved, setPwaLogoutPending } from '@/lib/pwa';
import { supabase } from '@/lib/supabase';
import type { AuthStatus } from '@/lib/auth-context';

type Snapshot = {
  status: AuthStatus;
  email: string | null;
  logoutPending: boolean;
  logoutFailed: boolean;
};

let snapshot: Snapshot = {
  status: 'loading',
  email: null,
  logoutPending: false,
  logoutFailed: false,
};
let started = false;
let checkId = 0;
let currentSession: Session | null = null;
let lastUserId: string | null = null;
let pendingSignOuts = 0;
let logoutUnresolved = false;
let signOutRunId = 0;
let storeEpoch = 0;
let pendingSignOutPromise: Promise<void> | null = null;
let unsubscribeAuth: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit(
  next: Pick<Snapshot, 'status' | 'email'> &
    Partial<Pick<Snapshot, 'logoutPending' | 'logoutFailed'>>,
) {
  const full: Snapshot = {
    status: next.status,
    email: next.email,
    logoutPending: next.logoutPending ?? false,
    logoutFailed: next.logoutFailed ?? false,
  };
  if (
    snapshot.status === full.status &&
    snapshot.email === full.email &&
    snapshot.logoutPending === full.logoutPending &&
    snapshot.logoutFailed === full.logoutFailed
  ) {
    return;
  }
  snapshot = full;
  setPwaAuthResolved(
    !logoutUnresolved &&
      pendingSignOuts === 0 &&
      full.status !== 'loading' &&
      full.status !== 'checking',
  );
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
    if (!session) {
      currentSession = null;
      setWritesLocked(true);
      bumpSessionGeneration();
      if (event === 'SIGNED_OUT' && previousUserId) {
        // Preserve unresolved per-user pins (inflight/unknown/waiting_for_sync)
        // across sign-out so the same user can verify or replay with the original
        // request id on next sign-in, while other users stay isolated by userId
        // key prefix. Clear only already-committed posted_reload markers.
        clearResolvedHeldWritesForUser(previousUserId);
      }
      lastUserId = null;
      setHeldWriteUser(null);
      checkId += 1;
      emit({
        status: 'signed-out',
        email: null,
        logoutPending: pendingSignOuts > 0,
        logoutFailed: snapshot.logoutFailed,
      });
      return;
    }
    if (pendingSignOuts > 0 || logoutUnresolved) {
      // Local logout has not completed yet: ignore any refocus/reconfirmation
      // session event so writes and PWA reload stay locked until logout finishes.
      currentSession = null;
      setWritesLocked(true);
      setHeldWriteUser(null);
      return;
    }
    currentSession = session;
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
  return (
    !logoutUnresolved &&
    pendingSignOuts === 0 &&
    snapshot.status !== 'loading' &&
    snapshot.status !== 'checking'
  );
}

export async function signIn(
  email: string,
  password: string,
): Promise<'ok' | 'invalid'> {
  const client = supabase;
  if (!client) return 'invalid';
  if (pendingSignOutPromise) {
    await pendingSignOutPromise.catch(() => {});
  }
  if (logoutUnresolved) {
    return 'invalid';
  }
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) return 'invalid';
  return 'ok';
}

export async function signOut() {
  const client = supabase;
  if (!client) return;
  const userId = currentSession?.user.id ?? lastUserId;
  // Lock all writes and PWA reload immediately and keep them locked until local
  // logout completes without error, ignoring any refocus session callbacks in
  // the interim (including if the SDK fails to remove a retained refresh token).
  // Privacy trade-off: unresolved pins (inflight/unknown/waiting_for_sync) stay
  // durable in localStorage scoped to `(projectUrl, userId)` across sign-out so
  // the same user can verify or replay an ambiguous write with the same request
  // id instead of double-posting it; other users cannot read them through the
  // store because keys are partitioned per user. Only committed `posted_reload`
  // markers are removed on sign-out.
  const runId = ++signOutRunId;
  const epoch = storeEpoch;
  pendingSignOuts += 1;
  logoutUnresolved = true;
  setWritesLocked(true);
  setPwaLogoutPending(true);
  setPwaAuthResolved(false);
  currentSession = null;
  checkId += 1;
  emit({
    status: 'signed-out',
    email: null,
    logoutPending: true,
    logoutFailed: snapshot.logoutFailed,
  });
  if (userId) {
    clearResolvedHeldWritesForUser(userId);
  }
  lastUserId = null;
  setHeldWriteUser(null);
  let task: Promise<void> | null = null;
  task = (async () => {
    let succeeded = false;
    try {
      const result = await client.auth.signOut();
      const signOutError =
        result && typeof result === 'object' && 'error' in result
          ? result.error
          : null;
      succeeded = !signOutError;
    } catch {
      succeeded = false;
    } finally {
      if (epoch === storeEpoch) {
        pendingSignOuts = Math.max(0, pendingSignOuts - 1);
        if (pendingSignOuts === 0) {
          if (pendingSignOutPromise === task) {
            pendingSignOutPromise = null;
          }
          if (succeeded && runId === signOutRunId) {
            logoutUnresolved = false;
            setPwaLogoutPending(false);
            emit({
              status: 'signed-out',
              email: null,
              logoutPending: false,
              logoutFailed: false,
            });
            setPwaAuthResolved(
              snapshot.status !== 'loading' && snapshot.status !== 'checking',
            );
          } else {
            logoutUnresolved = true;
            currentSession = null;
            setWritesLocked(true);
            setHeldWriteUser(null);
            setPwaLogoutPending(true);
            setPwaAuthResolved(false);
            emit({
              status: 'signed-out',
              email: null,
              logoutPending: false,
              logoutFailed: true,
            });
          }
        }
      }
    }
  })();
  pendingSignOutPromise = task;
  await task;
}

export function retryOwnerCheck() {
  const session = currentSession;
  if (!session) return;
  checkOwner(session);
}

export function resetAuthStore() {
  storeEpoch += 1;
  checkId += 1;
  currentSession = null;
  lastUserId = null;
  pendingSignOuts = 0;
  logoutUnresolved = false;
  signOutRunId = 0;
  pendingSignOutPromise = null;
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  started = false;
  snapshot = {
    status: 'loading',
    email: null,
    logoutPending: false,
    logoutFailed: false,
  };
  setPwaLogoutPending(false);
  setPwaAuthResolved(false);
  listeners.clear();
  resetHeldWritesStore({ clearStorage: false, resetUser: true });
}
