// @vitest-environment jsdom
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthStore,
  getLogoutCoordStorageKey,
  type AuthSnapshot,
} from '@/lib/auth-store';
import {
  getHeldWrite,
  isWritesLocked,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  userStoragePrefix,
} from '@/lib/held-writes';

const TEST_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.model.sig';
const SEED_COUNT = 400;
const STEPS_PER_SEED = 45;

type UserProfile = {
  id: 'user-a' | 'user-b';
  email: 'a@model.test' | 'b@model.test';
};

const USER_A: UserProfile = { id: 'user-a', email: 'a@model.test' };
const USER_B: UserProfile = { id: 'user-b', email: 'b@model.test' };

function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.model-sig`;
}

function decodeJwtSid(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const segment = parts[1] ?? '';
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const pad =
      padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const parsed = JSON.parse(atob(padded + pad)) as {
      session_id?: unknown;
      sid?: unknown;
    };
    const sid = parsed.session_id ?? parsed.sid;
    return typeof sid === 'string' && sid.length > 0 ? `sid:${sid}` : null;
  } catch {
    return null;
  }
}

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function createFakeBroadcastHub(isDropped: () => boolean) {
  type Listener = (ev: { data: unknown }) => void;
  const channelsByName = new Map<string, Set<FakeChannel>>();

  class FakeChannel {
    readonly name: string;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    private readonly listeners = new Set<Listener>();
    private closed = false;

    constructor(name: string) {
      this.name = name;
      let group = channelsByName.get(name);
      if (!group) {
        group = new Set();
        channelsByName.set(name, group);
      }
      group.add(this);
    }

    addEventListener(type: string, fn: Listener): void {
      if (type === 'message') this.listeners.add(fn);
    }

    removeEventListener(type: string, fn: Listener): void {
      if (type === 'message') this.listeners.delete(fn);
    }

    postMessage(data: unknown): void {
      if (this.closed || isDropped()) return;
      const group = channelsByName.get(this.name);
      if (!group) return;
      for (const peer of [...group]) {
        if (peer === this || peer.closed) continue;
        peer.onmessage?.({ data });
        for (const fn of [...peer.listeners]) fn({ data });
      }
    }

    close(): void {
      this.closed = true;
      channelsByName.get(this.name)?.delete(this);
    }
  }

  return {
    createChannel: (name: string) => new FakeChannel(name),
    closeAll() {
      for (const group of channelsByName.values()) {
        for (const ch of [...group]) ch.close();
      }
      channelsByName.clear();
    },
  };
}

function createFakeLockManager(
  getMode: () => 'enabled' | 'unavailable' | 'rejecting',
) {
  const held = new Map<string, Array<() => void>>();

  return {
    getLocks() {
      const mode = getMode();
      if (mode === 'unavailable') return null;
      return {
        request<T>(
          name: string,
          options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
          callback: (
            lock: { name: string; mode: string } | null,
          ) => Promise<T> | T,
        ): Promise<T> {
          if (getMode() === 'rejecting') {
            return Promise.reject(new Error('LockManager unavailable'));
          }
          const runWithLock = async (): Promise<T> => {
            try {
              return await callback({
                name,
                mode: options.mode ?? 'exclusive',
              });
            } finally {
              const waiters = held.get(name);
              if (waiters && waiters.length > 0) {
                const next = waiters.shift()!;
                next();
              } else {
                held.delete(name);
              }
            }
          };

          if (!held.has(name)) {
            held.set(name, []);
            return runWithLock();
          }
          if (options.ifAvailable) {
            return Promise.resolve().then(() => callback(null));
          }
          return new Promise<T>((resolve, reject) => {
            held.get(name)!.push(() => {
              runWithLock().then(resolve, reject);
            });
          });
        },
      };
    },
  };
}

type IssuedSession = {
  sid: string;
  sessionKey: string;
  user: UserProfile;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  generation: number;
  revoked: boolean;
  revokedBySessionKey: string | null;
  revokedAtOrderIndex: number | null;
  issuedOrderIndex: number;
  expiredOnce: boolean;
};

type SessionPayload = {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
  user: {
    id: string;
    email: string;
    aud: string;
    role: string;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
    created_at: string;
  };
};

function createModelAuthServer() {
  let sidCounter = 0;
  const sessionsBySid = new Map<string, IssuedSession>();
  const sidByAccess = new Map<string, string>();
  const sidByRefresh = new Map<string, string>();
  const confirmedRevokedKeys = new Set<string>();
  const confirmedRevokedAtOrder = new Map<string, number>();
  const issuedOrder: string[] = [];

  function toPayload(s: IssuedSession): SessionPayload {
    return {
      access_token: s.accessToken,
      refresh_token: s.refreshToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: s.expiresAt,
      user: {
        id: s.user.id,
        email: s.user.email,
        aud: 'authenticated',
        role: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      },
    };
  }

  function issueSession(user: UserProfile): SessionPayload {
    sidCounter += 1;
    const sid = `msid-${sidCounter}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = makeFakeJwt({
      sub: user.id,
      email: user.email,
      session_id: sid,
      exp: expiresAt,
      jti: `at-${sidCounter}-0`,
    });
    const refreshToken = `rt-${sidCounter}-0`;
    const issuedOrderIndex = issuedOrder.length;
    const record: IssuedSession = {
      sid,
      sessionKey: `sid:${sid}`,
      user,
      accessToken,
      refreshToken,
      expiresAt,
      generation: 0,
      revoked: false,
      revokedBySessionKey: null,
      revokedAtOrderIndex: null,
      issuedOrderIndex,
      expiredOnce: false,
    };
    sessionsBySid.set(sid, record);
    sidByAccess.set(accessToken, sid);
    sidByRefresh.set(refreshToken, sid);
    issuedOrder.push(record.sessionKey);
    return toPayload(record);
  }

  function rotateSession(refreshToken: string):
    | {
        ok: true;
        payload: SessionPayload;
      }
    | {
        ok: false;
        status: number;
        body: Record<string, unknown>;
      } {
    const sid = sidByRefresh.get(refreshToken);
    if (!sid) {
      return {
        ok: false,
        status: 400,
        body: {
          error_code: 'refresh_token_not_found',
          msg: 'Invalid refresh token',
        },
      };
    }
    const rec = sessionsBySid.get(sid);
    if (!rec || rec.revoked || rec.refreshToken !== refreshToken) {
      return {
        ok: false,
        status: 400,
        body: {
          error_code: 'refresh_token_already_used',
          msg: 'Already used or revoked',
        },
      };
    }
    rec.generation += 1;
    rec.expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const nextAccess = makeFakeJwt({
      sub: rec.user.id,
      email: rec.user.email,
      session_id: rec.sid,
      exp: rec.expiresAt,
      jti: `at-${rec.sid}-${rec.generation}`,
    });
    const nextRefresh = `rt-${rec.sid}-${rec.generation}`;
    rec.accessToken = nextAccess;
    rec.refreshToken = nextRefresh;
    sidByAccess.set(nextAccess, rec.sid);
    sidByRefresh.set(nextRefresh, rec.sid);
    return { ok: true, payload: toPayload(rec) };
  }

  function handleLogout(
    authHeader: string | null,
    mode: '204' | '503' | '401_once',
  ): Response {
    if (mode === '503') {
      return new Response('unavailable', { status: 503 });
    }
    const token = authHeader?.replace(/^Bearer\s+/i, '') ?? '';
    const sid = sidByAccess.get(token);
    if (!sid) {
      return new Response(JSON.stringify({ msg: 'Invalid JWT' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const rec = sessionsBySid.get(sid)!;
    if (mode === '401_once' && !rec.expiredOnce) {
      rec.expiredOnce = true;
      return new Response(JSON.stringify({ msg: 'Token expired' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (rec.revoked) {
      // Once this session is already revoked, a duplicate/delayed logout using
      // its token is a server no-op and never wipes newer sessions issued after.
      return new Response(null, { status: 204 });
    }
    // Match real GoTrue POST /auth/v1/logout?scope=global semantics: revoking
    // an active session revokes ALL active sessions belonging to rec.user.id.
    const revokeOrderIndex = issuedOrder.length;
    for (const s of sessionsBySid.values()) {
      if (s.user.id === rec.user.id && !s.revoked) {
        s.revoked = true;
        s.revokedBySessionKey = rec.sessionKey;
        s.revokedAtOrderIndex = revokeOrderIndex;
        confirmedRevokedKeys.add(s.sessionKey);
        confirmedRevokedAtOrder.set(s.sessionKey, revokeOrderIndex);
      }
    }
    return new Response(null, { status: 204 });
  }

  function handleRefresh(body: string | null): Response {
    let rt: string;
    try {
      const parsed = JSON.parse(body ?? '{}') as { refresh_token?: string };
      rt = parsed.refresh_token ?? '';
    } catch {
      rt = '';
    }
    const rotated = rotateSession(rt);
    if (!rotated.ok) {
      return new Response(JSON.stringify(rotated.body), {
        status: rotated.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(rotated.payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function latestActiveSessions(): IssuedSession[] {
    return [...sessionsBySid.values()];
  }

  return {
    issueSession,
    rotateSession,
    handleLogout,
    handleRefresh,
    latestActiveSessions,
    isConfirmedRevoked: (sessionKey: string) =>
      confirmedRevokedKeys.has(sessionKey),
    getConfirmedRevokedAtOrder: (sessionKey: string) =>
      confirmedRevokedAtOrder.get(sessionKey) ?? null,
    getIssuedIndex: (sessionKey: string) => issuedOrder.indexOf(sessionKey),
    getIssuedOrder: () => [...issuedOrder],
    getSessionByKey: (sessionKey: string) => {
      const sid = sessionKey.startsWith('sid:')
        ? sessionKey.slice(4)
        : sessionKey;
      return sessionsBySid.get(sid) ?? null;
    },
  };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

type QuotaMode = 'normal' | 'coord_blocked' | 'zero_byte';
type StorageEventMode = 'immediate' | 'delayed' | 'dropped';
type LogoutServerMode = '204' | '503' | 'slow_204' | 'slow_503' | '401_once';
type LocksMode = 'enabled' | 'unavailable' | 'rejecting';

type DeferredNet = {
  id: number;
  kind: 'logout' | 'signin';
  label: string;
  resolve: () => void;
};

type TabHandle = {
  slot: number;
  tabId: string;
  stopAutoRefresh: () => Promise<void>;
  notifyAuthSubscriber: (
    event: string,
    session: unknown,
    broadcast?: boolean,
  ) => Promise<void>;
  store: ReturnType<typeof createAuthStore>;
  storage: Storage;
  visibilityListeners: Set<() => void>;
  storageListeners: Set<(e: StorageEvent) => void>;
  unsubscribeTrace: () => void;
  inFlightPromises: Set<Promise<unknown>>;
  // Model-tracking fields for I2/I3 verification:
  lastHeldSid: string | null;
  attemptedSignOutSids: Set<string>;
  revocationOriginSids: Set<string>;
  differentSessionAppearedAfterSignOut: boolean;
  sawUnbackedLocalFailedWithNullCoord: boolean;
  destroyed: boolean;
};

function readPersistedSid(raw: string | undefined): string | null {
  if (!raw || raw.trim() === '' || raw.trim() === 'null') return null;
  try {
    const parsed = JSON.parse(raw) as { access_token?: string };
    return decodeJwtSid(parsed?.access_token);
  } catch {
    return null;
  }
}

function readCoordRecord(raw: string | undefined): {
  attemptId: number;
  ownerTabId: string;
  state: string;
  sessionKey: string | null;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      attemptId?: unknown;
      ownerTabId?: unknown;
      state?: unknown;
      sessionKey?: unknown;
    };
    if (typeof parsed.attemptId !== 'number') return null;
    return {
      attemptId: parsed.attemptId,
      ownerTabId:
        typeof parsed.ownerTabId === 'string' ? parsed.ownerTabId : '',
      state: typeof parsed.state === 'string' ? parsed.state : '',
      sessionKey:
        typeof parsed.sessionKey === 'string' ? parsed.sessionKey : null,
    };
  } catch {
    return null;
  }
}

type ModelCoverageStats = {
  revocationFailedPostSettle: number;
  revocationRetriesConverged: number;
  localFailedRecoveries: number;
  globalMultiSessionRevokes: number;
};

async function runModelSeed(
  seed: number,
  stats: ModelCoverageStats,
): Promise<void> {
  const rand = makePrng(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rand() * items.length)]!;
  const chance = (p: number): boolean => rand() < p;

  const url = `https://model-seed-${seed}.test`;
  const sdkKey = `sb-model-seed-${seed}-auth-token`;
  const coordKey = getLogoutCoordStorageKey(url);
  const tabCount = rand() < 0.5 ? 2 : 3;

  // Shared storage map backed by jsdom window.localStorage for held-writes keys,
  // while auth keys live in `values` so per-tab quota/remove faults stay isolated
  // from held-writes storage reads/writes.
  const values = new Map<string, string>();
  const trace: string[] = [];

  let quotaMode: QuotaMode = 'normal';
  let storageEventMode: StorageEventMode = 'immediate';
  let bcDropped = false;
  let locksMode: LocksMode = 'enabled';
  let logoutMode: LogoutServerMode = '204';
  let slowSignIn = false;
  const failSdkRemove = Array.from({ length: tabCount }, () => false);
  const failSdkTombstone = Array.from({ length: tabCount }, () => false);
  const delayedStorageEvents: Array<{
    targetSlot: number;
    event: StorageEvent;
  }> = [];
  const deferredNets: DeferredNet[] = [];
  let deferredNetId = 0;

  const hub = createFakeBroadcastHub(() => bcDropped);
  const fakeLocks = createFakeLockManager(() => locksMode);
  const server = createModelAuthServer();

  let maxObservedCoordAttemptId = 0;
  let everHadCoordKey = false;
  let maxIssuedIndexSeen = -1;
  // Track every sessionKey that ANY tab ever targeted for sign-out (explicitly
  // or by inheriting persisted sdkKey on signOut), every Bearer sessionKey sent
  // directly to POST /logout, and every session erased from sdkKey.
  const everSignOutTargetedSids = new Set<string>();
  const directLogoutDispatchedSids = new Set<string>();
  const erasedUntargetedSdkViolations: string[] = [];
  const staleDispatchWhileNewerPersistedViolations: string[] = [];
  let tab0LastOwnerEmail: string | null = null;
  let tab0SignedOutDirectlyFromUserA = false;
  const tabs: TabHandle[] = [];
  let tabGeneration = 0;

  // Seed unresolved & resolved held-writes for USER_A and USER_B before starting.
  resetHeldWritesStore({ clearStorage: true, resetUser: true });
  const prefixA = userStoragePrefix(USER_A.id);
  const prefixB = userStoragePrefix(USER_B.id);
  const opAKey = `${prefixA}${encodeURIComponent('model:op-a')}`;
  const opBKey = `${prefixB}${encodeURIComponent('model:op-b')}`;
  const postedAKey = `${prefixA}posted:${encodeURIComponent('model:posted-a')}:${encodeURIComponent(`posted-a-${seed}`)}`;
  window.localStorage.setItem(
    opAKey,
    JSON.stringify({
      v: 1,
      subject: 'model:op-a',
      requestId: `req-a-${seed}`,
      payload: { seed, user: 'a' },
      phase: 'unknown',
    }),
  );
  window.localStorage.setItem(
    opBKey,
    JSON.stringify({
      v: 1,
      subject: 'model:op-b',
      requestId: `req-b-${seed}`,
      payload: { seed, user: 'b' },
      phase: 'unknown',
    }),
  );
  window.localStorage.setItem(
    postedAKey,
    JSON.stringify({
      v: 1,
      subject: 'model:posted-a',
      requestId: `posted-a-${seed}`,
      payload: {},
      phase: 'posted_reload',
    }),
  );
  rehydrateHeldWrites();

  function dispatchStorageEvent(
    fromSlot: number,
    key: string,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    if (storageEventMode === 'dropped') return;
    for (const peer of tabs) {
      if (peer.slot === fromSlot || peer.destroyed) continue;
      const ev = new StorageEvent('storage', { key, oldValue, newValue });
      if (storageEventMode === 'delayed') {
        delayedStorageEvents.push({ targetSlot: peer.slot, event: ev });
      } else {
        for (const fn of [...peer.storageListeners]) fn(ev);
      }
    }
  }

  function makeTabStorage(slot: number): Storage {
    return {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(k: string) {
        return values.get(k) ?? null;
      },
      key(i: number) {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string) {
        if (k === sdkKey && failSdkRemove[slot]) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        const oldValue = values.get(k) ?? null;
        if (!values.delete(k)) return;
        if (k === sdkKey) {
          const erasedSid = readPersistedSid(oldValue ?? undefined);
          if (erasedSid !== null && !everSignOutTargetedSids.has(erasedSid)) {
            erasedUntargetedSdkViolations.push(
              `tab${slot} removed untargeted sdkKey=${erasedSid}`,
            );
          }
        }
        dispatchStorageEvent(slot, k, oldValue, null);
      },
      setItem(k: string, v: string) {
        const str = String(v);
        const isTombstone =
          k === sdkKey && (str === '' || str === 'null' || str === '{}');
        if (isTombstone && failSdkTombstone[slot]) {
          throw new DOMException('StorageLocked', 'InvalidStateError');
        }
        if (quotaMode === 'zero_byte') {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        if (quotaMode === 'coord_blocked' && k === coordKey) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        const oldValue = values.get(k) ?? null;
        if (isTombstone) {
          const erasedSid = readPersistedSid(oldValue ?? undefined);
          if (erasedSid !== null && !everSignOutTargetedSids.has(erasedSid)) {
            erasedUntargetedSdkViolations.push(
              `tab${slot} tombstoned untargeted sdkKey=${erasedSid}`,
            );
          }
        }
        values.set(k, str);
        dispatchStorageEvent(slot, k, oldValue, str);
      },
    };
  }

  function makeFetch(slot: number): typeof fetch {
    return (input, init) => {
      const href = requestUrlOf(input);
      const headers = new Headers(init?.headers);
      if (href.includes('/rest/v1/rpc/is_owner')) {
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (href.includes('/auth/v1/token?grant_type=password')) {
        let email: string = USER_A.email;
        try {
          const rawBody = typeof init?.body === 'string' ? init.body : '{}';
          const parsed = JSON.parse(rawBody) as {
            email?: string;
          };
          if (parsed.email === USER_B.email) email = USER_B.email;
        } catch {
          email = USER_A.email;
        }
        const profile = email === USER_B.email ? USER_B : USER_A;
        const makeResp = () => {
          const payload = server.issueSession(profile);
          const issuedKey = decodeJwtSid(payload.access_token) ?? 'unknown';
          trace.push(`  [net] issued ${issuedKey} (${profile.id})`);
          maxIssuedIndexSeen = Math.max(
            maxIssuedIndexSeen,
            server.getIssuedIndex(issuedKey),
          );
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
        if (slowSignIn) {
          return new Promise<Response>((resolve) => {
            const id = ++deferredNetId;
            const entry: DeferredNet = {
              id,
              kind: 'signin',
              label: `signin(${profile.id})#${id}`,
              resolve: () => resolve(makeResp()),
            };
            deferredNets.push(entry);
          });
        }
        return Promise.resolve(makeResp());
      }
      if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
        const body = typeof init?.body === 'string' ? init.body : null;
        return Promise.resolve(server.handleRefresh(body));
      }
      if (href.includes('/auth/v1/logout')) {
        const authHeader = headers.get('authorization');
        const mode = logoutMode;
        const logoutSid = decodeJwtSid(
          authHeader?.replace(/^Bearer\s+/i, '') ?? '',
        );
        if (logoutSid !== null) {
          directLogoutDispatchedSids.add(logoutSid);
          const persistedNow = readPersistedSid(values.get(sdkKey));
          if (
            persistedNow !== null &&
            persistedNow !== logoutSid &&
            !everSignOutTargetedSids.has(persistedNow) &&
            quotaMode === 'normal' &&
            storageEventMode === 'immediate' &&
            !bcDropped
          ) {
            const logoutRec = server.getSessionByKey(logoutSid);
            const persistedRec = server.getSessionByKey(persistedNow);
            if (
              logoutRec &&
              persistedRec &&
              logoutRec.user.id === persistedRec.user.id &&
              persistedRec.issuedOrderIndex > logoutRec.issuedOrderIndex
            ) {
              staleDispatchWhileNewerPersistedViolations.push(
                `tab${slot} dispatched /logout(${logoutSid}) while newer untargeted ${persistedNow} of same user was persisted`,
              );
            }
          }
        }
        const immediateMode =
          mode === 'slow_204' ? '204' : mode === 'slow_503' ? '503' : mode;
        trace.push(
          `  [net tab${slot}] POST /logout (${logoutSid ?? 'unknown'}, mode=${immediateMode})`,
        );
        return Promise.resolve(server.handleLogout(authHeader, immediateMode));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };
  }

  // Clean slow-fetch implementation where AbortError rejects directly.
  function makeCleanFetch(slot: number): typeof fetch {
    const base = makeFetch(slot);
    return (input, init) => {
      const href = requestUrlOf(input);
      if (
        href.includes('/auth/v1/logout') &&
        (logoutMode === 'slow_204' || logoutMode === 'slow_503')
      ) {
        const headers = new Headers(init?.headers);
        const authHeader = headers.get('authorization');
        const logoutSid = decodeJwtSid(
          authHeader?.replace(/^Bearer\s+/i, '') ?? '',
        );
        if (logoutSid !== null) {
          directLogoutDispatchedSids.add(logoutSid);
          const persistedNow = readPersistedSid(values.get(sdkKey));
          if (
            persistedNow !== null &&
            persistedNow !== logoutSid &&
            !everSignOutTargetedSids.has(persistedNow) &&
            quotaMode === 'normal' &&
            storageEventMode === 'immediate' &&
            !bcDropped
          ) {
            const logoutRec = server.getSessionByKey(logoutSid);
            const persistedRec = server.getSessionByKey(persistedNow);
            if (
              logoutRec &&
              persistedRec &&
              logoutRec.user.id === persistedRec.user.id &&
              persistedRec.issuedOrderIndex > logoutRec.issuedOrderIndex
            ) {
              staleDispatchWhileNewerPersistedViolations.push(
                `tab${slot} dispatched slow /logout(${logoutSid}) while newer untargeted ${persistedNow} of same user was persisted`,
              );
            }
          }
        }
        const resolvedMode = logoutMode === 'slow_204' ? '204' : '503';
        const signal = init?.signal;
        return new Promise<Response>((resolve, reject) => {
          const id = ++deferredNetId;
          const cleanup = () => {
            const idx = deferredNets.findIndex((d) => d.id === id);
            if (idx >= 0) deferredNets.splice(idx, 1);
            signal?.removeEventListener('abort', onAbort);
          };
          const onAbort = () => {
            cleanup();
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          deferredNets.push({
            id,
            kind: 'logout',
            label: `logout(${resolvedMode})#${id}`,
            resolve: () => {
              cleanup();
              resolve(server.handleLogout(authHeader, resolvedMode));
            },
          });
        });
      }
      return base(input, init);
    };
  }

  function createTab(slot: number): TabHandle {
    tabGeneration += 1;
    const tabId = `tab${slot}-g${tabGeneration}`;
    const storage = makeTabStorage(slot);
    const visibilityListeners = new Set<() => void>();
    const storageListeners = new Set<(e: StorageEvent) => void>();
    const client = createClient(url, TEST_ANON_KEY, {
      auth: {
        storage,
        storageKey: sdkKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { fetch: makeCleanFetch(slot) },
    });
    const store = createAuthStore({
      getClient: () => client as never,
      getProjectUrl: () => url,
      getStorage: () => storage,
      addStorageListener: (fn) => {
        storageListeners.add(fn);
        return () => storageListeners.delete(fn);
      },
      addVisibilityListener: (fn) => {
        visibilityListeners.add(fn);
        return () => visibilityListeners.delete(fn);
      },
      createBroadcastChannel: (name) => hub.createChannel(name) as never,
      getLocks: () => fakeLocks.getLocks(),
      tabId,
      syncGlobalStores: slot === 0,
    });
    const internals = client.auth as unknown as {
      _notifyAllSubscribers: (
        event: string,
        session: unknown,
        broadcast?: boolean,
      ) => Promise<void>;
    };
    const handle: TabHandle = {
      slot,
      tabId,
      stopAutoRefresh: async () => {
        await client.auth.stopAutoRefresh();
      },
      notifyAuthSubscriber: (event, session, broadcast = false) =>
        internals._notifyAllSubscribers(event, session, broadcast),
      store,
      storage,
      visibilityListeners,
      storageListeners,
      unsubscribeTrace: () => {},
      inFlightPromises: new Set(),
      lastHeldSid: null,
      attemptedSignOutSids: new Set(),
      revocationOriginSids: new Set(),
      differentSessionAppearedAfterSignOut: false,
      sawUnbackedLocalFailedWithNullCoord: false,
      destroyed: false,
    };
    const {
      data: { subscription: traceSub },
    } = client.auth.onAuthStateChange((ev, sess) => {
      const sid = decodeJwtSid(sess?.access_token);
      trace.push(`  [sdk ${tabId}] ${ev} ${sid ?? 'null'}`);
      if (sid !== null && readPersistedSid(values.get(sdkKey)) === sid) {
        handle.lastHeldSid = sid;
      }
    });
    handle.unsubscribeTrace = () => traceSub.unsubscribe();
    store.startAuth();
    return handle;
  }

  async function destroyTab(tab: TabHandle): Promise<void> {
    tab.destroyed = true;
    tab.unsubscribeTrace();
    await tab.stopAutoRefresh();
    tab.store.resetAuthStore({ clearStorage: false });
    tab.visibilityListeners.clear();
    tab.storageListeners.clear();
  }

  function formatFailure(invariant: string, detail: string): Error {
    const coord = readCoordRecord(values.get(coordKey));
    const sdkSid = readPersistedSid(values.get(sdkKey));
    const tabSummaries = tabs.map((t) => {
      const snap: AuthSnapshot = t.store.getAuthSnapshot();
      return `  ${t.tabId}: status=${snap.status} email=${snap.email} phase=${snap.logoutPhase} resolved=${t.store.isAuthResolved()} inFlight=${t.inFlightPromises.size} attemptedSids=[${[...t.attemptedSignOutSids].join(',')}]`;
    });
    return new Error(
      [
        `MODEL VIOLATION [SEED=${seed}] [${invariant}]: ${detail}`,
        `Storage: sdkSid=${sdkSid ?? 'null'} coord=${JSON.stringify(coord)} quota=${quotaMode} events=${storageEventMode} bcDropped=${bcDropped} locks=${locksMode} logoutMode=${logoutMode} failRemove=[${failSdkRemove.join(',')}] failTombstone=[${failSdkTombstone.join(',')}]`,
        `Tabs:\n${tabSummaries.join('\n')}`,
        `Trace (${trace.length} steps):\n${trace.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}`,
      ].join('\n'),
    );
  }

  function hasAnyInFlight(): boolean {
    return (
      deferredNets.length > 0 ||
      tabs.some((t) => !t.destroyed && t.inFlightPromises.size > 0)
    );
  }

  function checkInvariantsAfterStep(stepLabel: string): void {
    const coord = readCoordRecord(values.get(coordKey));
    const persistedSid = readPersistedSid(values.get(sdkKey));

    // Track whether any tab is in unbacked local_failed while coordKey is null
    // (owner-approved DELTA14-P3-5 full-storage exception), and whether a
    // different session appeared in sdkKey or signed_in coord after a tab's
    // sign-out attempt (Rule B intentionally clears stale logout notice).
    // Reset sawUnbackedLocalFailedWithNullCoord once coordKey exists (and tab
    // is not in local_failed) or a different session appears so I2-dishonest-idle
    // stays armed for all later attempts in the same seed.
    for (const t of tabs) {
      if (t.destroyed) continue;
      const snap = t.store.getAuthSnapshot();
      if (coord === null && snap.logoutPhase === 'local_failed') {
        t.sawUnbackedLocalFailedWithNullCoord = true;
      } else if (coord !== null && snap.logoutPhase !== 'local_failed') {
        t.sawUnbackedLocalFailedWithNullCoord = false;
      }
      if (t.attemptedSignOutSids.size > 0) {
        const latestAttemptedSid = [...t.attemptedSignOutSids].at(-1)!;
        if (
          (persistedSid !== null && persistedSid !== latestAttemptedSid) ||
          (coord !== null &&
            coord.state === 'signed_in' &&
            coord.sessionKey !== null &&
            coord.sessionKey !== latestAttemptedSid)
        ) {
          t.differentSessionAppearedAfterSignOut = true;
          t.sawUnbackedLocalFailedWithNullCoord = false;
        }
      }
    }

    // I3-a: coordKey is never deleted once created, and attemptId is strictly non-decreasing.
    if (everHadCoordKey && coord === null) {
      throw formatFailure(
        'I3-coord-never-removed',
        `coordKey vanished at ${stepLabel} (maxAttemptId was ${maxObservedCoordAttemptId})`,
      );
    }
    if (coord !== null) {
      everHadCoordKey = true;
      if (coord.attemptId < maxObservedCoordAttemptId) {
        throw formatFailure(
          'I3-attemptId-monotonic',
          `coordKey.attemptId regressed from ${maxObservedCoordAttemptId} to ${coord.attemptId} at ${stepLabel}`,
        );
      }
      maxObservedCoordAttemptId = coord.attemptId;
    }

    // I3-b: Under real GoTrue scope=global semantics:
    //  1. Every POST /logout Bearer token must belong to a session explicitly
    //     targeted by a signOut/retryLogoutRevocation call.
    //  2. No untargeted persisted sdkKey may ever be erased/tombstoned.
    //  3. A global logout of user A never revokes any session of user B.
    //  4. A session issued AFTER its revoker's target session was already
    //     confirmed revoked is never revoked by that stale target.
    //  5. Under normal coordinated storage/events/BC, a stale logout for an
    //     older session is never dispatched while a newer untargeted session
    //     of the same user is already persisted in sdkKey.
    for (const dispatchedSid of directLogoutDispatchedSids) {
      if (!everSignOutTargetedSids.has(dispatchedSid)) {
        throw formatFailure(
          'I3-untargeted-direct-logout',
          `POST /logout dispatched with untargeted session ${dispatchedSid} (at ${stepLabel})`,
        );
      }
    }
    if (erasedUntargetedSdkViolations.length > 0) {
      throw formatFailure(
        'I3-erased-untargeted-sdkKey',
        `${erasedUntargetedSdkViolations[0]} (at ${stepLabel})`,
      );
    }
    if (staleDispatchWhileNewerPersistedViolations.length > 0) {
      throw formatFailure(
        'I3-stale-logout-dispatched-over-newer-session',
        `${staleDispatchWhileNewerPersistedViolations[0]} (at ${stepLabel})`,
      );
    }
    for (const s of server.latestActiveSessions()) {
      if (!s.revoked) continue;
      if (s.revokedBySessionKey !== null) {
        const revoker = server.getSessionByKey(s.revokedBySessionKey);
        if (revoker && revoker.user.id !== s.user.id) {
          throw formatFailure(
            'I3-cross-user-revocation',
            `Session ${s.sessionKey} (${s.user.id}) was revoked by ${s.revokedBySessionKey} (${revoker.user.id}) at ${stepLabel}`,
          );
        }
        const revokerConfirmedAt = server.getConfirmedRevokedAtOrder(
          s.revokedBySessionKey,
        );
        if (
          revokerConfirmedAt !== null &&
          s.issuedOrderIndex >= revokerConfirmedAt
        ) {
          throw formatFailure(
            'I3-revoked-session-issued-after-confirmed-logout',
            `Session ${s.sessionKey} (order=${s.issuedOrderIndex}) was revoked by already-confirmed ${s.revokedBySessionKey} (confirmedAt=${revokerConfirmedAt}) at ${stepLabel}`,
          );
        }
      }
    }

    // I1-a: No tab in a blocking/retrying logout phase may report status === 'owner'.
    for (const t of tabs) {
      if (t.destroyed) continue;
      const snap = t.store.getAuthSnapshot();
      if (
        (snap.logoutPhase === 'signing_out' ||
          snap.logoutPhase === 'local_failed' ||
          snap.logoutPhase === 'retrying_local' ||
          snap.logoutPhase === 'retrying_revocation') &&
        snap.status === 'owner'
      ) {
        throw formatFailure(
          'I1-owner-during-logout',
          `${t.tabId} reported status=owner while logoutPhase=${snap.logoutPhase} at ${stepLabel}`,
        );
      }

      // I2: A tab that explicitly tried to revoke `sid` must NOT report clean
      // idle (signed-out, logoutRevocationFailed=false) if `sid` was never
      // confirmed globally revoked AND no different session appeared in sdkKey
      // or signed_in coord since the attempt (excluding the owner-approved
      // shared===null unbacked local_failed case).
      if (
        snap.status === 'signed-out' &&
        snap.logoutPhase === 'idle' &&
        !snap.logoutRevocationFailed &&
        t.inFlightPromises.size === 0 &&
        t.attemptedSignOutSids.size > 0 &&
        !t.sawUnbackedLocalFailedWithNullCoord &&
        !t.differentSessionAppearedAfterSignOut
      ) {
        const latestAttemptedSid = [...t.attemptedSignOutSids].at(-1)!;
        if (!server.isConfirmedRevoked(latestAttemptedSid)) {
          throw formatFailure(
            'I2-dishonest-idle',
            `${t.tabId} reached clean idle for unrevoked ${latestAttemptedSid} at ${stepLabel}`,
          );
        }
      }
    }

    // I5: Held-writes per-user isolation on Tab 0 (syncGlobalStores: true).
    const tab0 = tabs[0];
    if (tab0 && !tab0.destroyed) {
      const snap0 = tab0.store.getAuthSnapshot();
      // Unresolved held writes for both users MUST stay in localStorage across sign-out.
      if (window.localStorage.getItem(opAKey) === null) {
        throw formatFailure(
          'I5-lost-user-a-pin',
          `Unresolved held write for user-a was deleted from localStorage at ${stepLabel}`,
        );
      }
      if (window.localStorage.getItem(opBKey) === null) {
        throw formatFailure(
          'I5-lost-user-b-pin',
          `Unresolved held write for user-b was deleted from localStorage at ${stepLabel}`,
        );
      }
      if (snap0.status === 'owner' && snap0.email === USER_B.email) {
        tab0LastOwnerEmail = USER_B.email;
        if (getHeldWrite('model:op-a') !== null) {
          throw formatFailure(
            'I5-cross-user-leak',
            `User A held write readable while Tab 0 is owner as User B at ${stepLabel}`,
          );
        }
        if (getHeldWrite('model:op-b')?.requestId !== `req-b-${seed}`) {
          throw formatFailure(
            'I5-missing-user-b-pin',
            `User B held write not readable while Tab 0 is owner as User B at ${stepLabel}`,
          );
        }
      } else if (snap0.status === 'owner' && snap0.email === USER_A.email) {
        tab0LastOwnerEmail = USER_A.email;
        if (getHeldWrite('model:op-b') !== null) {
          throw formatFailure(
            'I5-cross-user-leak',
            `User B held write readable while Tab 0 is owner as User A at ${stepLabel}`,
          );
        }
        if (getHeldWrite('model:op-a')?.requestId !== `req-a-${seed}`) {
          throw formatFailure(
            'I5-missing-user-a-pin',
            `User A held write not readable while Tab 0 is owner as User A at ${stepLabel}`,
          );
        }
      } else if (snap0.status === 'signed-out') {
        if (tab0LastOwnerEmail === USER_A.email) {
          tab0SignedOutDirectlyFromUserA = true;
          tab0LastOwnerEmail = null;
        } else if (tab0LastOwnerEmail !== null) {
          tab0LastOwnerEmail = null;
        }
        if (!isWritesLocked()) {
          throw formatFailure(
            'I5-writes-unlocked-signed-out',
            `Writes were not locked while Tab 0 is signed-out at ${stepLabel}`,
          );
        }
        if (
          getHeldWrite('model:op-a') !== null ||
          getHeldWrite('model:op-b') !== null
        ) {
          throw formatFailure(
            'I5-leak-when-signed-out',
            `Held write readable while Tab 0 is signed-out at ${stepLabel}`,
          );
        }
        if (
          tab0SignedOutDirectlyFromUserA &&
          window.localStorage.getItem(postedAKey) !== null
        ) {
          throw formatFailure(
            'I5-posted-reload-not-cleared',
            `Resolved posted_reload pin for user-a was not cleared after Tab 0 signed out at ${stepLabel}`,
          );
        }
      }
    }
  }

  function trackPromise(tab: TabHandle, p: Promise<unknown>): void {
    tab.inFlightPromises.add(p);
    void p.finally(() => {
      tab.inFlightPromises.delete(p);
    });
  }

  function recordSignOutTarget(tab: TabHandle): void {
    const persistedSid = readPersistedSid(values.get(sdkKey));
    const snap = tab.store.getAuthSnapshot();
    const coord = readCoordRecord(values.get(coordKey));
    const isSignedInTab = snap.status === 'owner' || snap.status === 'checking';
    // A signed-out tab retrying an older logout for a DIFFERENT sessionKey
    // must never adopt persistedSid (I3).
    const isSignedOutRetryForDifferentSid =
      !isSignedInTab &&
      persistedSid !== null &&
      (snap.logoutPhase === 'local_failed' ||
        snap.logoutPhase === 'revocation_failed' ||
        snap.logoutPhase === 'signing_out') &&
      coord !== null &&
      coord.state !== 'signed_in' &&
      coord.sessionKey !== null &&
      coord.sessionKey !== persistedSid;
    if (persistedSid !== null && !isSignedOutRetryForDifferentSid) {
      everSignOutTargetedSids.add(persistedSid);
      // Only track I2 honesty for tabs actively initiating/retrying sign-out
      // (a signed-out idle tab with a prior revokedSessionKey may intentionally
      // abort signOut() on L3890 to protect a different persisted session).
      if (
        isSignedInTab ||
        snap.logoutPhase === 'local_failed' ||
        snap.logoutPhase === 'revocation_failed'
      ) {
        tab.attemptedSignOutSids.add(persistedSid);
        tab.revocationOriginSids.add(persistedSid);
        tab.differentSessionAppearedAfterSignOut = false;
        tab.sawUnbackedLocalFailedWithNullCoord = false;
      }
    }
    if (
      tab.lastHeldSid !== null &&
      (!isSignedOutRetryForDifferentSid || persistedSid === null)
    ) {
      everSignOutTargetedSids.add(tab.lastHeldSid);
      if (isSignedInTab) {
        tab.revocationOriginSids.add(tab.lastHeldSid);
        tab.sawUnbackedLocalFailedWithNullCoord = false;
      }
    }
    if (coord?.sessionKey && !isSignedInTab && coord.state !== 'signed_in') {
      everSignOutTargetedSids.add(coord.sessionKey);
    }
  }

  try {
    // Boot initial tabs (2 or 3). Seed an initial session in ~70% of seeds so
    // early sign-out/refresh races happen immediately.
    if (chance(0.7)) {
      const initUser = chance(0.5) ? USER_A : USER_B;
      const initSession = server.issueSession(initUser);
      values.set(sdkKey, JSON.stringify(initSession));
      trace.push(`boot: seeded sdkKey (${initUser.id})`);
    } else {
      trace.push('boot: empty storage');
    }

    for (let i = 0; i < tabCount; i += 1) {
      tabs.push(createTab(i));
    }
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    checkInvariantsAfterStep('boot');

    // Run STEPS_PER_SEED randomized interleaving steps.
    for (let step = 1; step <= STEPS_PER_SEED; step += 1) {
      const r = rand();
      const slot = Math.floor(rand() * tabCount);
      const tab = tabs[slot]!;

      if (r < 0.16) {
        // signIn (user A or user B), sometimes concurrent (unawaited)
        const user = chance(0.5) ? USER_A : USER_B;
        const concurrent = chance(0.35);
        trace.push(
          `signIn(tab${slot}, ${user.id}, ${concurrent ? 'async' : 'await'})`,
        );
        const p = tab.store.signIn(user.email, 'ValidPassword123');
        trackPromise(tab, p);
        if (!concurrent) {
          await vi.advanceTimersByTimeAsync(10);
          await flushMicrotasks();
          if (deferredNets.length === 0) {
            await p;
          }
        }
      } else if (r < 0.34) {
        // signOut, sometimes concurrent (unawaited)
        const concurrent = chance(0.4);
        const snapBefore = tab.store.getAuthSnapshot();
        trace.push(
          `signOut(tab${slot}, ${concurrent ? 'async' : 'await'}, sdk=${readPersistedSid(values.get(sdkKey)) ?? 'null'}, tabStatus=${snapBefore.status}, phase=${snapBefore.logoutPhase})`,
        );
        recordSignOutTarget(tab);
        const p = tab.store.signOut();
        trackPromise(tab, p);
        if (!concurrent) {
          await vi.advanceTimersByTimeAsync(10);
          await flushMicrotasks();
          if (deferredNets.length === 0) {
            await p;
          }
        }
      } else if (r < 0.44) {
        // retryLogoutRevocation
        const concurrent = chance(0.3);
        trace.push(
          `retryLogoutRevocation(tab${slot}, ${concurrent ? 'async' : 'await'})`,
        );
        const persistedSid = readPersistedSid(values.get(sdkKey));
        if (persistedSid) {
          const coord = readCoordRecord(values.get(coordKey));
          if (!coord || coord.sessionKey === persistedSid) {
            everSignOutTargetedSids.add(persistedSid);
          }
        }
        const p = tab.store.retryLogoutRevocation();
        trackPromise(tab, p);
        if (!concurrent) {
          await vi.advanceTimersByTimeAsync(10);
          await flushMicrotasks();
          if (deferredNets.length === 0) {
            await p;
          }
        }
      } else if (r < 0.54) {
        // Reload tab (crash/close + fresh boot with new tabId)
        trace.push(`reloadTab(tab${slot})`);
        if (slot === 0) {
          tab0LastOwnerEmail = null;
        }
        await destroyTab(tab);
        tabs[slot] = createTab(slot);
        await vi.advanceTimersByTimeAsync(10);
        await flushMicrotasks();
      } else if (r < 0.64) {
        // Refocus / visibilitychange + optional SDK focus replay
        const withReplay = chance(0.45);
        trace.push(`refocusTab(tab${slot}, replay=${withReplay})`);
        for (const fn of [...tab.visibilityListeners]) fn();
        tab.store.isAuthResolved();
        if (withReplay) {
          const rawSdk = values.get(sdkKey);
          const parsed = rawSdk
            ? (JSON.parse(rawSdk) as Record<string, unknown>)
            : null;
          if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.access_token === 'string'
          ) {
            await tab.notifyAuthSubscriber('SIGNED_IN', parsed, false);
          }
        }
        await vi.advanceTimersByTimeAsync(10);
        await flushMicrotasks();
      } else if (r < 0.72) {
        // Late TOKEN_REFRESHED from an earlier (possibly already revoked) session
        const all = server.latestActiveSessions();
        if (all.length > 0) {
          const chosen = pick(all);
          const rotated = server.rotateSession(chosen.refreshToken);
          const payload = rotated.ok
            ? rotated.payload
            : {
                access_token: chosen.accessToken,
                refresh_token: chosen.refreshToken,
                token_type: 'bearer' as const,
                expires_in: 3600,
                expires_at: chosen.expiresAt,
                user: {
                  id: chosen.user.id,
                  email: chosen.user.email,
                  aud: 'authenticated',
                  role: 'authenticated',
                  app_metadata: {},
                  user_metadata: {},
                  created_at: '2026-01-01T00:00:00Z',
                },
              };
          trace.push(
            `lateTokenRefreshed(tab${slot}, ${chosen.sessionKey}, rotated=${rotated.ok})`,
          );
          // Write to sdkKey if storage permits (simulating GoTrueClient _callRefreshToken)
          try {
            tab.storage.setItem(sdkKey, JSON.stringify(payload));
          } catch {
            // Quota rejected write
          }
          await tab.notifyAuthSubscriber('TOKEN_REFRESHED', payload, false);
          await vi.advanceTimersByTimeAsync(10);
          await flushMicrotasks();
        } else {
          trace.push('lateTokenRefreshed(skip: no sessions)');
        }
      } else if (r < 0.8) {
        // Resolve a deferred network request or flush delayed StorageEvents
        if (deferredNets.length > 0 && chance(0.65)) {
          const idx = Math.floor(rand() * deferredNets.length);
          const item = deferredNets[idx]!;
          trace.push(`resolveNet(${item.label})`);
          item.resolve();
          await vi.advanceTimersByTimeAsync(10);
          await flushMicrotasks();
        } else if (delayedStorageEvents.length > 0) {
          const evItem = delayedStorageEvents.shift()!;
          const target = tabs[evItem.targetSlot];
          trace.push(
            `flushStorageEvent(tab${evItem.targetSlot}, key=${evItem.event.key})`,
          );
          if (target && !target.destroyed) {
            for (const fn of [...target.storageListeners]) fn(evItem.event);
          }
          await vi.advanceTimersByTimeAsync(10);
          await flushMicrotasks();
        } else {
          trace.push('advanceTime(2100ms)');
          await vi.advanceTimersByTimeAsync(2_100);
          await flushMicrotasks();
        }
      } else if (r < 0.86) {
        // Advance fake timers (heartbeat / partial lease / >10s lease expiry)
        const delta = pick([2_100, 5_000, 11_000] as const);
        trace.push(`advanceTime(${delta}ms)`);
        await vi.advanceTimersByTimeAsync(delta);
        await flushMicrotasks();
      } else {
        // Toggle environment fault knob (14% weight so quota/lock/net/remove
        // faults combine frequently within every 45-step run)
        const knob = Math.floor(rand() * 7);
        if (knob === 0) {
          quotaMode = pick(['normal', 'coord_blocked', 'zero_byte'] as const);
          trace.push(`env: quotaMode=${quotaMode}`);
        } else if (knob === 1) {
          failSdkRemove[slot] = !failSdkRemove[slot];
          trace.push(`env: failSdkRemove[tab${slot}]=${failSdkRemove[slot]}`);
        } else if (knob === 2) {
          failSdkTombstone[slot] = !failSdkTombstone[slot];
          trace.push(
            `env: failSdkTombstone[tab${slot}]=${failSdkTombstone[slot]}`,
          );
        } else if (knob === 3) {
          storageEventMode = pick(['immediate', 'delayed', 'dropped'] as const);
          trace.push(`env: storageEventMode=${storageEventMode}`);
        } else if (knob === 4) {
          bcDropped = !bcDropped;
          trace.push(`env: bcDropped=${bcDropped}`);
        } else if (knob === 5) {
          locksMode = pick(['enabled', 'unavailable', 'rejecting'] as const);
          trace.push(`env: locksMode=${locksMode}`);
        } else {
          logoutMode = pick([
            '204',
            '503',
            'slow_204',
            'slow_503',
            '401_once',
          ] as const);
          slowSignIn = chance(0.25);
          trace.push(`env: logoutMode=${logoutMode} slowSignIn=${slowSignIn}`);
        }
      }

      checkInvariantsAfterStep(`step ${step}`);
    }

    // === FINAL QUIESCE & SETTLE PHASE (checks I1, I3, I4, I5) ===
    trace.push('--- SETTLE PHASE ---');
    quotaMode = 'normal';
    storageEventMode = 'immediate';
    bcDropped = false;
    locksMode = 'enabled';
    logoutMode = '204';
    slowSignIn = false;
    for (let i = 0; i < tabCount; i += 1) {
      failSdkRemove[i] = false;
      failSdkTombstone[i] = false;
    }

    // Resolve all deferred network responses and deliver delayed storage events.
    let guard = 0;
    while (
      (deferredNets.length > 0 ||
        delayedStorageEvents.length > 0 ||
        hasAnyInFlight()) &&
      guard < 25
    ) {
      guard += 1;
      while (deferredNets.length > 0) {
        const next = deferredNets.shift()!;
        next.resolve();
      }
      while (delayedStorageEvents.length > 0) {
        const evItem = delayedStorageEvents.shift()!;
        const target = tabs[evItem.targetSlot];
        if (target && !target.destroyed) {
          for (const fn of [...target.storageListeners]) fn(evItem.event);
        }
      }
      await vi.advanceTimersByTimeAsync(2_000);
      await flushMicrotasks();
    }

    // Advance past the 10s abandonment lease and refocus all tabs.
    await vi.advanceTimersByTimeAsync(11_500);
    await flushMicrotasks();
    for (const t of tabs) {
      if (t.destroyed) continue;
      for (const fn of [...t.visibilityListeners]) fn();
      t.store.isAuthResolved();
    }
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    checkInvariantsAfterStep('post-settle');

    // Assert I4 & I1: no tab remains stuck in an in-flight logout phase, and
    // verify fresh-tab reload + recovery semantics after settle.
    const persistedAfterSettle = readPersistedSid(values.get(sdkKey));
    const coordAfterSettle = readCoordRecord(values.get(coordKey));
    for (const t of tabs) {
      if (t.destroyed) continue;
      const snap = t.store.getAuthSnapshot();
      if (
        snap.logoutPhase === 'signing_out' ||
        snap.logoutPhase === 'retrying_local' ||
        snap.logoutPhase === 'retrying_revocation'
      ) {
        throw formatFailure(
          'I4-stuck-inflight',
          `${t.tabId} stayed stuck in logoutPhase=${snap.logoutPhase} after 11.5s settle`,
        );
      }
      if (persistedAfterSettle === null) {
        if (snap.status !== 'signed-out') {
          throw formatFailure(
            'I1-zombie-owner-after-settle',
            `${t.tabId} has status=${snap.status} after settle with no persisted sdkKey`,
          );
        }
        if (
          snap.logoutFailed ||
          snap.logoutPending ||
          !t.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I4-login-disabled-after-settle',
            `${t.tabId} left login disabled after settle with no sdkKey (phase=${snap.logoutPhase}, resolved=${t.store.isAuthResolved()})`,
          );
        }
        // I2 propagation: when coordKey holds revocation_failed for an
        // unconfirmed session, every open tab must report logoutRevocationFailed,
        // and any non-reloaded originating tab must keep canRetryLogoutRevocation.
        if (coordAfterSettle?.state === 'revocation_failed') {
          const coordSid = coordAfterSettle.sessionKey;
          const sidConfirmed =
            coordSid !== null && server.isConfirmedRevoked(coordSid);
          if (!sidConfirmed && !snap.logoutRevocationFailed) {
            throw formatFailure(
              'I2-missing-revocation-failed-on-open-tab',
              `${t.tabId} reported logoutRevocationFailed=false (phase=${snap.logoutPhase}) while coordKey is revocation_failed for unconfirmed ${coordSid ?? 'null'}`,
            );
          }
          if (
            coordSid !== null &&
            !sidConfirmed &&
            t.revocationOriginSids.has(coordSid) &&
            !t.differentSessionAppearedAfterSignOut &&
            !snap.canRetryLogoutRevocation
          ) {
            throw formatFailure(
              'I2-missing-retry-capability-on-origin-tab',
              `Originating non-reloaded tab ${t.tabId} lost canRetryLogoutRevocation for unconfirmed ${coordSid}`,
            );
          }
        }
      } else if (
        coordAfterSettle?.state === 'local_failed' &&
        (coordAfterSettle.sessionKey === null ||
          coordAfterSettle.sessionKey === persistedAfterSettle)
      ) {
        if (snap.status === 'owner') {
          throw formatFailure(
            'I1-owner-with-local-failed-after-settle',
            `${t.tabId} remained owner after settle while coordKey is local_failed for ${persistedAfterSettle}`,
          );
        }
      }
    }

    // Check fresh-tab boot behavior after settle (I1 & I4):
    const probeTab = createTab(tabCount);
    try {
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      const probeSnap = probeTab.store.getAuthSnapshot();
      if (persistedAfterSettle === null) {
        if (
          probeSnap.status !== 'signed-out' ||
          probeSnap.logoutFailed ||
          probeSnap.logoutPending ||
          !probeTab.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I1-I4-fresh-reload-with-no-creds',
            `Fresh reloaded tab booted into status=${probeSnap.status} phase=${probeSnap.logoutPhase} resolved=${probeTab.store.isAuthResolved()} with no sdkKey`,
          );
        }
        if (
          coordAfterSettle?.state === 'revocation_failed' &&
          !probeSnap.logoutRevocationFailed
        ) {
          throw formatFailure(
            'I2-fresh-reload-missing-revocation-failed',
            `Fresh reloaded tab booted into phase=${probeSnap.logoutPhase} (logoutRevocationFailed=false) while coordKey is revocation_failed`,
          );
        }
      } else if (
        coordAfterSettle?.state === 'local_failed' &&
        (coordAfterSettle.sessionKey === null ||
          coordAfterSettle.sessionKey === persistedAfterSettle)
      ) {
        if (
          probeSnap.status !== 'signed-out' ||
          probeSnap.logoutPhase !== 'local_failed' ||
          probeTab.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I1-fresh-reload-reopened-local-failed',
            `Fresh reloaded tab booted into status=${probeSnap.status} phase=${probeSnap.logoutPhase} while local_failed holds ${persistedAfterSettle}`,
          );
        }
      }
    } finally {
      await destroyTab(probeTab);
    }

    // If coordKey holds revocation_failed after settle and any tab retains the
    // token (canRetryLogoutRevocation === true), calling retryLogoutRevocation()
    // under the recovered 204 server MUST confirm revocation on the server and
    // converge every open tab to clean idle (I2, I4).
    if (
      persistedAfterSettle === null &&
      coordAfterSettle?.state === 'revocation_failed'
    ) {
      stats.revocationFailedPostSettle += 1;
      const retryTab = tabs.find(
        (t) =>
          !t.destroyed && t.store.getAuthSnapshot().canRetryLogoutRevocation,
      );
      if (retryTab) {
        const retryTargetSid = coordAfterSettle.sessionKey;
        if (retryTargetSid !== null) {
          everSignOutTargetedSids.add(retryTargetSid);
        }
        await retryTab.store.retryLogoutRevocation();
        await vi.advanceTimersByTimeAsync(50);
        await flushMicrotasks();
        if (
          retryTargetSid !== null &&
          !server.isConfirmedRevoked(retryTargetSid)
        ) {
          throw formatFailure(
            'I2-retry-did-not-revoke-on-server',
            `retryLogoutRevocation() on ${retryTab.tabId} did not confirm global revocation for ${retryTargetSid}`,
          );
        }
        for (const t of tabs) {
          if (t.destroyed) continue;
          const snap = t.store.getAuthSnapshot();
          if (
            snap.status !== 'signed-out' ||
            snap.logoutPhase !== 'idle' ||
            snap.logoutRevocationFailed ||
            !t.store.isAuthResolved()
          ) {
            throw formatFailure(
              'I2-retry-did-not-converge-to-idle',
              `${t.tabId} stayed in status=${snap.status} phase=${snap.logoutPhase} logoutRevocationFailed=${snap.logoutRevocationFailed} after retryLogoutRevocation()`,
            );
          }
        }
        stats.revocationRetriesConverged += 1;
      }
    }

    // If local_failed holds persistedAfterSettle, retrying signOut now (with
    // storage recovered) MUST converge every tab to signed-out / idle (I4).
    if (
      persistedAfterSettle !== null &&
      coordAfterSettle?.state === 'local_failed' &&
      (coordAfterSettle.sessionKey === null ||
        coordAfterSettle.sessionKey === persistedAfterSettle)
    ) {
      stats.localFailedRecoveries += 1;
      everSignOutTargetedSids.add(persistedAfterSettle);
      await tabs[0]!.store.signOut();
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      if (readPersistedSid(values.get(sdkKey)) !== null) {
        throw formatFailure(
          'I4-local-failed-recovery-left-sdk',
          'Retrying signOut after storage recovery failed to remove sdkKey',
        );
      }
      for (const t of tabs) {
        if (t.destroyed) continue;
        const snap = t.store.getAuthSnapshot();
        if (
          snap.status !== 'signed-out' ||
          snap.logoutPhase !== 'idle' ||
          !t.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I4-local-failed-recovery-did-not-converge',
            `${t.tabId} stayed in status=${snap.status} phase=${snap.logoutPhase} after local_failed recovery`,
          );
        }
      }
    }

    // If no credentials remain, verify login is ACTUALLY functional on tab 0 (I4)
    // and check I5 user-b isolation one more time.
    if (readPersistedSid(values.get(sdkKey)) === null) {
      const signInResult = await tabs[0]!.store.signIn(
        USER_B.email,
        'ValidPassword123',
      );
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      if (
        signInResult !== 'ok' ||
        tabs[0]!.store.getAuthSnapshot().status !== 'owner'
      ) {
        throw formatFailure(
          'I4-login-unusable-after-settle',
          `tab0 signIn after settle returned ${signInResult} with status=${tabs[0]!.store.getAuthSnapshot().status}`,
        );
      }
      if (getHeldWrite('model:op-a') !== null) {
        throw formatFailure(
          'I5-post-settle-cross-user-leak',
          'User A held write leaked into User B after post-settle signIn',
        );
      }
    }
    // Record whether real GoTrue scope=global revoked multiple sessions of the
    // same user in this seed so the suite verifies non-vacuous coverage.
    if (
      server
        .latestActiveSessions()
        .some(
          (s) =>
            s.revoked &&
            s.revokedBySessionKey !== null &&
            s.revokedBySessionKey !== s.sessionKey,
        )
    ) {
      stats.globalMultiSessionRevokes += 1;
    }
  } finally {
    // Release any lingering deferred promises cleanly before teardown.
    while (deferredNets.length > 0) {
      deferredNets.shift()!.resolve();
    }
    for (const t of tabs) {
      if (!t.destroyed) {
        await destroyTab(t);
      }
    }
    hub.closeAll();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
  }
}

describe('auth-store deterministic model-based interleaving suite (I1-I5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    const origWarn = console.warn.bind(console);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      if (
        typeof args[0] === 'string' &&
        args[0].includes('Multiple GoTrueClient instances detected')
      ) {
        return;
      }
      origWarn(...args);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Partition 400 deterministic seeds into 10 batches of 40 so Vitest reports
  // clear progress and keeps per-test timeouts comfortable (< 60s total).
  const BATCH_SIZE = 40;
  const BATCH_COUNT = SEED_COUNT / BATCH_SIZE;
  const suiteStats: ModelCoverageStats = {
    revocationFailedPostSettle: 0,
    revocationRetriesConverged: 0,
    localFailedRecoveries: 0,
    globalMultiSessionRevokes: 0,
  };

  for (let batch = 0; batch < BATCH_COUNT; batch += 1) {
    const startSeed = batch * BATCH_SIZE + 1;
    const endSeed = startSeed + BATCH_SIZE - 1;
    it(`preserves invariants I1-I5 across seeds ${startSeed}..${endSeed} (${STEPS_PER_SEED} randomized steps each)`, async () => {
      for (let seed = startSeed; seed <= endSeed; seed += 1) {
        await runModelSeed(seed, suiteStats);
      }
    }, 30_000);
  }

  it('exercises revocation_failed retry convergence, local_failed recovery, and GoTrue global multi-session revocations non-vacuously', () => {
    expect(suiteStats.revocationFailedPostSettle).toBeGreaterThan(0);
    expect(suiteStats.revocationRetriesConverged).toBeGreaterThan(0);
    expect(suiteStats.localFailedRecoveries).toBeGreaterThan(0);
    expect(suiteStats.globalMultiSessionRevokes).toBeGreaterThan(0);
  });
});
