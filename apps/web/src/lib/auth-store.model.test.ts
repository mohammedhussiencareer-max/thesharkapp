// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createActiveTabController,
  type ActiveTabController,
} from '@/lib/active-tab';
import {
  createAuthStore,
  getLogoutCoordStorageKey,
  type AuthSnapshot,
} from '@/lib/auth-store';
import { createHeldWriteStore, userStoragePrefix } from '@/lib/held-writes';
import {
  createManagedSupabaseClient,
  type ManagedSupabaseController,
} from '@/lib/supabase';

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

/**
 * In-memory BroadcastChannel hub installed on `globalThis.BroadcastChannel` so
 * GoTrueClient instances open real cross-tab channels. If a demoted tab fails
 * to dispose its channel (P1-1), messages flow to the newly active tab!
 */
function createFakeBroadcastHub(onChannelOpened: () => void) {
  type Listener = (ev: { data: unknown }) => void;
  const channelsByName = new Map<string, Set<FakeChannel>>();

  class FakeChannel {
    readonly name: string;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    private readonly listeners = new Set<Listener>();
    closed = false;

    constructor(name: string) {
      this.name = name;
      onChannelOpened();
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
      if (this.closed) return;
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
    BroadcastChannel: FakeChannel,
    closeAll() {
      for (const group of channelsByName.values()) {
        for (const ch of [...group]) ch.close();
      }
      channelsByName.clear();
    },
  };
}

/**
 * Spec-faithful Web Locks manager supporting:
 * - exclusive `ifAvailable` + `steal: true` (for `active-tab.ts` leadership)
 * - queued asynchronous exclusive locks (for `held-writes.ts` subject locks)
 */
function createCombinedLockManager(onSubjectLockUsed: () => void) {
  type HeldLock = {
    id: number;
    broken: boolean;
    rejectRequest: (err: unknown) => void;
    resolveRequest: (value: unknown) => void;
  };
  type Waiter = {
    grant: () => void;
  };
  let nextId = 1;
  const heldByName = new Map<string, HeldLock>();
  const waitersByName = new Map<string, Waiter[]>();

  function pumpNext(name: string): void {
    if (heldByName.has(name)) return;
    const queue = waitersByName.get(name);
    if (!queue || queue.length === 0) {
      waitersByName.delete(name);
      return;
    }
    const next = queue.shift()!;
    if (queue.length === 0) waitersByName.delete(name);
    next.grant();
  }

  const locks: LockManager = {
    query: () =>
      Promise.resolve({
        held: [...heldByName.keys()].map((name) => ({ name })),
        pending: [],
      }),
    request<T = unknown>(
      name: string,
      optionsOrCb: LockOptions | LockGrantedCallback<T>,
      maybeCb?: LockGrantedCallback<T>,
    ): Promise<T> {
      const options: LockOptions =
        typeof optionsOrCb === 'function' ? {} : optionsOrCb;
      const callback: LockGrantedCallback<T> =
        typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb!;

      if (!name.startsWith('theshark:app:active-tab:')) {
        onSubjectLockUsed();
      }

      const grantNow = (): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const entry: HeldLock = {
            id: nextId++,
            broken: false,
            rejectRequest: reject,
            resolveRequest: resolve as (value: unknown) => void,
          };
          heldByName.set(name, entry);

          void Promise.resolve()
            .then(() =>
              callback({
                name,
                mode: options.mode ?? 'exclusive',
              }),
            )
            .then(
              (val) => {
                if (!entry.broken && heldByName.get(name)?.id === entry.id) {
                  heldByName.delete(name);
                  entry.resolveRequest(val);
                  pumpNext(name);
                }
              },
              (err) => {
                if (!entry.broken && heldByName.get(name)?.id === entry.id) {
                  heldByName.delete(name);
                  entry.rejectRequest(err);
                  pumpNext(name);
                }
              },
            );
        });

      const existing = heldByName.get(name);
      if (existing && options.steal) {
        existing.broken = true;
        heldByName.delete(name);
        existing.rejectRequest(
          new DOMException(
            'Lock broken by another request with the steal option.',
            'AbortError',
          ),
        );
        return grantNow();
      }

      if (!existing) {
        return grantNow();
      }

      if (options.ifAvailable) {
        return Promise.resolve().then(() => callback(null));
      }

      return new Promise<T>((resolve, reject) => {
        let queue = waitersByName.get(name);
        if (!queue) {
          queue = [];
          waitersByName.set(name, queue);
        }
        queue.push({
          grant: () => {
            grantNow().then(resolve, reject);
          },
        });
      });
    },
  };

  return {
    locks,
    heldCount: () => heldByName.size,
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
  revokedByRetry: boolean;
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
    aud: 'authenticated';
    role: 'authenticated';
    email: string;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
    created_at: string;
  };
};

function toSessionPayload(s: IssuedSession): SessionPayload {
  return {
    access_token: s.accessToken,
    refresh_token: s.refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: s.expiresAt,
    user: {
      id: s.user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: s.user.email,
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-11-26T00:00:00Z',
    },
  };
}

class ModelAuthServer {
  private nextSid = 1;
  private readonly sessionsByKey = new Map<string, IssuedSession>();
  private readonly sessionByAccessToken = new Map<string, IssuedSession>();
  private readonly sessionByRefreshToken = new Map<string, IssuedSession>();
  private readonly logoutAttempts = new Map<string, number>();

  issueSession(user: UserProfile, ttlSeconds = 3600): IssuedSession {
    const order = this.nextSid++;
    const sid = `m-${order}`;
    const sessionKey = `sid:${sid}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + ttlSeconds;
    const accessToken = makeFakeJwt({
      sub: user.id,
      email: user.email,
      session_id: sid,
      gen: 1,
      exp: expiresAt,
    });
    const refreshToken = `rt-${sid}-g1`;
    const session: IssuedSession = {
      sid,
      sessionKey,
      user,
      accessToken,
      refreshToken,
      expiresAt,
      generation: 1,
      revoked: false,
      revokedBySessionKey: null,
      revokedByRetry: false,
      issuedOrderIndex: order,
      expiredOnce: false,
    };
    this.sessionsByKey.set(sessionKey, session);
    this.sessionByAccessToken.set(accessToken, session);
    this.sessionByRefreshToken.set(refreshToken, session);
    return session;
  }

  refresh(refreshToken: string): IssuedSession | null {
    const session = this.sessionByRefreshToken.get(refreshToken);
    if (!session || session.revoked) return null;
    session.generation += 1;
    const nowSec = Math.floor(Date.now() / 1000);
    session.expiresAt = nowSec + 3600;
    const newAccess = makeFakeJwt({
      sub: session.user.id,
      email: session.user.email,
      session_id: session.sid,
      gen: session.generation,
      exp: session.expiresAt,
    });
    const newRefresh = `rt-${session.sid}-g${session.generation}`;
    session.accessToken = newAccess;
    session.refreshToken = newRefresh;
    this.sessionByAccessToken.set(newAccess, session);
    this.sessionByRefreshToken.set(newRefresh, session);
    return session;
  }

  lookupByAccessToken(token: string | null): IssuedSession | null {
    if (!token) return null;
    return this.sessionByAccessToken.get(token) ?? null;
  }

  lookupByKey(key: string): IssuedSession | null {
    return this.sessionsByKey.get(key) ?? null;
  }

  isConfirmedRevoked(sessionKey: string): boolean {
    return this.sessionsByKey.get(sessionKey)?.revoked === true;
  }

  allSessions(): IssuedSession[] {
    return [...this.sessionsByKey.values()];
  }

  nextLogoutAttemptCount(sessionKey: string): number {
    const next = (this.logoutAttempts.get(sessionKey) ?? 0) + 1;
    this.logoutAttempts.set(sessionKey, next);
    return next;
  }

  revoke(
    session: IssuedSession,
    scope: 'global' | 'local',
    viaRetry: boolean,
  ): void {
    if (scope === 'global') {
      for (const s of this.sessionsByKey.values()) {
        if (s.user.id === session.user.id && !s.revoked) {
          s.revoked = true;
          s.revokedBySessionKey = session.sessionKey;
          s.revokedByRetry = viaRetry;
        }
      }
      return;
    }
    if (!session.revoked) {
      session.revoked = true;
      session.revokedBySessionKey = session.sessionKey;
      session.revokedByRetry = viaRetry;
    }
  }
}

type QuotaMode = 'normal' | 'coord_blocked' | 'zero_byte';
type LogoutMode = '204' | '503' | 'slow_204' | 'slow_503' | '401_once';
type RefreshMode = 'ok' | 'slow_ok' | 'slow_400';

type DurableRecord = {
  attemptId: number;
  state: 'pending' | 'local_failed' | 'revocation_failed';
  sessionKey: string | null;
};

type DeferredNet = {
  id: number;
  kind: 'logout' | 'signin' | 'refresh';
  tabId: string;
  sessionKey: string | null;
  resolve: () => void;
};

type TabHandle = {
  slot: number;
  tabId: string;
  activeCtrl: ActiveTabController;
  managedClient: ManagedSupabaseController;
  heldWrites: ReturnType<typeof createHeldWriteStore>;
  store: ReturnType<typeof createAuthStore>;
  destroyed: boolean;
  inFlightSignOuts: number;
  inFlightSignIns: number;
  inFlightRetries: number;
  inFlightRefreshes: number;
  /** Live fetch AbortSignals of the current active generation (verified aborted on demotion). */
  inFlightFetchSignals: Set<AbortSignal>;
  /** I6 counters: MUST remain 0 for every tab across the entire run! */
  inactiveFetchCount: number;
  inactiveStorageWriteCount: number;
  unabortedDemotedFetchCount: number;
  /** Sessions for which THIS live tab originated a sign-out while active (cleared on demotion). */
  revocationOriginSids: Set<string>;
  differentSessionAppearedAfterSignOut: boolean;
};

type ModelCoverageStats = {
  takeovers: number;
  takeoversDuringSignOut: number;
  takeoversDuringSignIn: number;
  takeoversDuringRefresh: number;
  inFlightFetchesAbortedOnTakeover: number;
  broadcastChannelsOpened: number;
  heldWriteWebLocksUsed: number;
  refreshCallsAttempted: number;
  tabCloses: number;
  tabReloads: number;
  revocationFailedPostSettle: number;
  revocationRetriesConverged: number;
  localFailedRecoveries: number;
  tombstoneFallbacks: number;
  lateRevokedRefreshEvents: number;
  globalMultiSessionRevokes: number;
  inactiveTabsVerifiedSilent: number;
  postedReloadClearedVerified: number;
  noActiveTabLockedVerified: number;
};

function readPersistedSid(raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as {
      access_token?: string;
      refresh_token?: string;
    };
    const sid = decodeJwtSid(parsed.access_token);
    if (sid) return sid;
    if (typeof parsed.refresh_token === 'string' && parsed.refresh_token) {
      return `rt:${parsed.refresh_token}`;
    }
    return null;
  } catch {
    return null;
  }
}

function readPersistedUserEmail(raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as {
      user?: { email?: unknown };
    };
    return typeof parsed.user?.email === 'string' ? parsed.user.email : null;
  } catch {
    return null;
  }
}

function readDurableRecord(raw: string | undefined): DurableRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DurableRecord>;
    if (
      typeof parsed.attemptId === 'number' &&
      (parsed.state === 'pending' ||
        parsed.state === 'local_failed' ||
        parsed.state === 'revocation_failed')
    ) {
      return {
        attemptId: parsed.attemptId,
        state: parsed.state,
        sessionKey:
          typeof parsed.sessionKey === 'string' ? parsed.sessionKey : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function seedHeldWritesInBacking(
  values: Map<string, string>,
  projectUrl: string,
): {
  opAKey: string;
  postedAKey: string;
  opBKey: string;
  postedBKey: string;
} {
  const opAKey = `${userStoragePrefix(USER_A.id, projectUrl)}model%3Aop-a`;
  const postedAKey = `${userStoragePrefix(USER_A.id, projectUrl)}posted:model%3Aposted-a:req-a-post`;
  const opBKey = `${userStoragePrefix(USER_B.id, projectUrl)}model%3Aop-b`;
  const postedBKey = `${userStoragePrefix(USER_B.id, projectUrl)}posted:model%3Aposted-b:req-b-post`;

  values.set(
    opAKey,
    JSON.stringify({
      v: 1,
      subject: 'model:op-a',
      requestId: 'req-a-1',
      phase: 'unknown',
      payload: { user: 'a' },
    }),
  );
  values.set(
    postedAKey,
    JSON.stringify({
      v: 1,
      subject: 'model:posted-a',
      requestId: 'req-a-post',
      claimId: 'claim-a-post',
      phase: 'posted_reload',
      payload: { user: 'a' },
    }),
  );
  values.set(
    opBKey,
    JSON.stringify({
      v: 1,
      subject: 'model:op-b',
      requestId: 'req-b-1',
      phase: 'unknown',
      payload: { user: 'b' },
    }),
  );
  values.set(
    postedBKey,
    JSON.stringify({
      v: 1,
      subject: 'model:posted-b',
      requestId: 'req-b-post',
      claimId: 'claim-b-post',
      phase: 'posted_reload',
      payload: { user: 'b' },
    }),
  );
  return { opAKey, postedAKey, opBKey, postedBKey };
}

async function runModelSeed(
  seed: number,
  stats: ModelCoverageStats,
): Promise<void> {
  const rand = makePrng(seed);
  const pick = <T>(arr: readonly T[]): T =>
    arr[Math.floor(rand() * arr.length)]!;
  const chance = (p: number): boolean => rand() < p;

  const projectRef = `model1t-${seed}`;
  const projectUrl = `https://${projectRef}.supabase.co`;
  const sdkKey = `sb-${projectRef}-auth-token`;
  const coordKey = getLogoutCoordStorageKey(projectUrl);

  const originalBroadcastChannel = globalThis.BroadcastChannel;
  const bcHub = createFakeBroadcastHub(() => {
    stats.broadcastChannelsOpened += 1;
  });
  Object.defineProperty(globalThis, 'BroadcastChannel', {
    configurable: true,
    writable: true,
    value: bcHub.BroadcastChannel,
  });

  const server = new ModelAuthServer();
  const lockManager = createCombinedLockManager(() => {
    stats.heldWriteWebLocksUsed += 1;
  });
  const values = new Map<string, string>();
  const hwKeys = seedHeldWritesInBacking(values, projectUrl);

  // Environment fault knobs
  let quotaMode: QuotaMode = 'normal';
  let logoutMode: LogoutMode = '204';
  let refreshMode: RefreshMode = 'ok';
  let slowSignIn = false;
  let failSdkRemove = false;
  let failSdkTombstone = false;

  const trace: string[] = [];
  const deferredNets: DeferredNet[] = [];
  let nextNetId = 1;
  let tabSeq = 1;

  // Oracle state for I1/I2/I3/I4/I5/I6 checks:
  const everSignOutTargetedSids = new Set<string>();
  const signOutOriginUsers = new Map<string, string>(); // sessionKey -> userId
  let latestCleanSignedInSid: string | null = null;
  let latestSignOutSessionKey: string | null = null;
  // Tracks ONLY the extreme case where browser refused BOTH sdkKey erase/tombstone
  // AND writing durable coordKey (I1 extreme storage exception). Notice we do NOT
  // exempt `coord_blocked`, because `sdkKey` removal still succeeds under `coord_blocked`!
  let latestSignOutUnpersistedAndUnerased = false;
  // Tracks whether User A completed a sign-out while remaining active so its
  // queued Web Lock `clearResolvedHeldWritesForUser` callback had a chance to
  // clear `posted_reload` without being aborted by a mid-sign-out takeover (I5/I6).
  let userACleanSignOutSettledWhileActive = false;

  const tabCount = chance(0.5) ? 2 : 3;
  const tabs: TabHandle[] = [];

  // Seed initial signed-in session in ~70% of seeds (sometimes near-expiry to exercise auto-refresh!)
  if (chance(0.7)) {
    const initialUser = chance(0.65) ? USER_A : USER_B;
    const ttl = chance(0.3) ? 75 : 3600;
    const initialSession = server.issueSession(initialUser, ttl);
    values.set(sdkKey, JSON.stringify(toSessionPayload(initialSession)));
    latestCleanSignedInSid = initialSession.sessionKey;
    trace.push(
      `init: seeded ${initialSession.sessionKey} (${initialUser.id}, ttl=${ttl}s)`,
    );
  } else {
    trace.push('init: signed-out');
  }

  function formatFailure(invariant: string, detail: string): Error {
    const tabStates = tabs
      .map((t) => {
        if (t.destroyed) return `${t.tabId}(destroyed)`;
        const s: AuthSnapshot = t.store.getAuthSnapshot();
        return `${t.tabId}[active=${t.activeCtrl.isActive()} client=${t.managedClient.hasInstantiatedClient()} status=${s.status} phase=${s.logoutPhase} retry=${s.canRetryLogoutRevocation} email=${s.email ?? '-'} inactFetch=${t.inactiveFetchCount} inactWrite=${t.inactiveStorageWriteCount} unaborted=${t.unabortedDemotedFetchCount}]`;
      })
      .join(' | ');
    const recentTrace = trace.slice(-25).join('\n  ');
    return new Error(
      `[${invariant}] seed=${seed}: ${detail}\n` +
        `sdkKey=${readPersistedSid(values.get(sdkKey)) ?? 'null'} ` +
        `coordKey=${values.get(coordKey) ?? 'null'} ` +
        `locksHeld=${lockManager.heldCount()}\n` +
        `tabs: ${tabStates}\n` +
        `trace (last 25):\n  ${recentTrace}`,
    );
  }

  /**
   * Unfiltered spy storage passed to `auth-store`, `held-writes`, and as the
   * backing store inside production `createManagedSupabaseClient`.
   * ANY `setItem`/`removeItem`/`clear` that reaches this adapter while
   * `!tab.activeCtrl.isActive()` increments `tab.inactiveStorageWriteCount`
   * and trips `I6-inactive-storage-write`!
   */
  function makeTrackedBackingStorage(tab: TabHandle): Storage {
    return {
      get length() {
        return values.size;
      },
      clear() {
        if (!tab.activeCtrl.isActive()) {
          tab.inactiveStorageWriteCount += 1;
          return;
        }
        values.clear();
      },
      getItem(k: string): string | null {
        return values.get(k) ?? null;
      },
      key(i: number): string | null {
        return [...values.keys()][i] ?? null;
      },
      removeItem(k: string): void {
        if (!tab.activeCtrl.isActive()) {
          tab.inactiveStorageWriteCount += 1;
          return;
        }
        if (k === sdkKey && failSdkRemove) {
          throw new DOMException(
            'Simulated sdkKey removeItem failure',
            'QuotaExceededError',
          );
        }
        values.delete(k);
      },
      setItem(k: string, v: string): void {
        if (!tab.activeCtrl.isActive()) {
          tab.inactiveStorageWriteCount += 1;
          return;
        }
        const str = String(v);
        if (quotaMode === 'zero_byte') {
          throw new DOMException(
            'Simulated 0-byte quota',
            'QuotaExceededError',
          );
        }
        if (quotaMode === 'coord_blocked' && k === coordKey) {
          throw new DOMException(
            'Simulated coordKey quota',
            'QuotaExceededError',
          );
        }
        if (k === sdkKey && str === '' && failSdkTombstone) {
          throw new DOMException(
            'Simulated sdkKey tombstone failure',
            'QuotaExceededError',
          );
        }
        if (k === sdkKey && str === '' && failSdkRemove) {
          stats.tombstoneFallbacks += 1;
        }
        values.set(k, str);
      },
    };
  }

  /**
   * Raw network fetch passed into production `createManagedSupabaseClient`.
   * Because production `createGenerationFetch` sits in front of this function,
   * ANY call reaching here while `!tab.activeCtrl.isActive()` is a REAL,
   * REACHABLE I6 violation (`tab.inactiveFetchCount += 1`)!
   * Also tracks `init.signal` in `tab.inFlightFetchSignals` so demotion verifies
   * every in-flight fetch was aborted (P1-1)!
   */
  function makeRawNetworkFetchForTab(tab: TabHandle): typeof fetch {
    return (input, init) => {
      if (!tab.activeCtrl.isActive()) {
        tab.inactiveFetchCount += 1;
      }

      const signal = init?.signal ?? undefined;
      if (signal) {
        tab.inFlightFetchSignals.add(signal);
      }
      const untrack = () => {
        if (signal) tab.inFlightFetchSignals.delete(signal);
      };

      const href = requestUrlOf(input);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const authHeader = headers.get('Authorization') ?? '';
      const bearer = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;

      // 1) Password sign-in
      if (href.includes('/auth/v1/token?grant_type=password')) {
        const bodyRaw = typeof init?.body === 'string' ? init.body : '{}';
        const parsed = JSON.parse(bodyRaw) as { email?: string };
        const user = parsed.email === USER_B.email ? USER_B : USER_A;
        const respond = () => {
          const issued = server.issueSession(user);
          return new Response(JSON.stringify(toSessionPayload(issued)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
        if (slowSignIn) {
          return new Promise<Response>((resolve, reject) => {
            const netId = nextNetId++;
            let settled = false;
            const onAbort = () => {
              if (settled) return;
              settled = true;
              untrack();
              reject(new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            deferredNets.push({
              id: netId,
              kind: 'signin',
              tabId: tab.tabId,
              sessionKey: null,
              resolve: () => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                untrack();
                resolve(respond());
              },
            });
          });
        }
        untrack();
        return Promise.resolve(respond());
      }

      // 2) Refresh token
      if (href.includes('/auth/v1/token?grant_type=refresh_token')) {
        stats.refreshCallsAttempted += 1;
        const bodyRaw = typeof init?.body === 'string' ? init.body : '{}';
        const parsed = JSON.parse(bodyRaw) as { refresh_token?: string };
        const mode = refreshMode;
        const respond = (): Response => {
          if (mode === 'slow_400') {
            return new Response(
              JSON.stringify({
                error: 'invalid_grant',
                error_description: 'refresh_token_not_found',
              }),
              {
                status: 400,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
          const rotated = parsed.refresh_token
            ? server.refresh(parsed.refresh_token)
            : null;
          if (!rotated) {
            return new Response(JSON.stringify({ error: 'invalid_grant' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify(toSessionPayload(rotated)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
        if (mode === 'slow_ok' || mode === 'slow_400') {
          return new Promise<Response>((resolve, reject) => {
            const netId = nextNetId++;
            let settled = false;
            const onAbort = () => {
              if (settled) return;
              settled = true;
              untrack();
              reject(new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            deferredNets.push({
              id: netId,
              kind: 'refresh',
              tabId: tab.tabId,
              sessionKey: null,
              resolve: () => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                untrack();
                resolve(respond());
              },
            });
          });
        }
        untrack();
        return Promise.resolve(respond());
      }

      // 3) Logout
      if (href.includes('/auth/v1/logout')) {
        const parsedUrl = new URL(href);
        const scope =
          parsedUrl.searchParams.get('scope') === 'local' ? 'local' : 'global';
        const session = server.lookupByAccessToken(bearer);
        const sessionKey = session?.sessionKey ?? null;
        const mode = logoutMode;
        const viaRetry = tab.inFlightRetries > 0;

        const finishLogout = (): Response => {
          if (!session) {
            return new Response(JSON.stringify({ message: 'Invalid JWT' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (mode === '401_once') {
            const attempt = server.nextLogoutAttemptCount(session.sessionKey);
            if (attempt === 1 && !session.expiredOnce) {
              session.expiredOnce = true;
              return new Response(JSON.stringify({ message: 'JWT expired' }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
              });
            }
            server.revoke(session, scope, viaRetry);
            return new Response(null, { status: 204 });
          }
          if (mode === '503' || mode === 'slow_503') {
            return new Response(
              JSON.stringify({ message: 'Service Unavailable' }),
              { status: 503, headers: { 'content-type': 'application/json' } },
            );
          }
          server.revoke(session, scope, viaRetry);
          return new Response(null, { status: 204 });
        };

        if (mode === 'slow_204' || mode === 'slow_503') {
          return new Promise<Response>((resolve, reject) => {
            const netId = nextNetId++;
            let settled = false;
            const onAbort = () => {
              if (settled) return;
              settled = true;
              untrack();
              reject(new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            deferredNets.push({
              id: netId,
              kind: 'logout',
              tabId: tab.tabId,
              sessionKey,
              resolve: () => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                untrack();
                resolve(finishLogout());
              },
            });
          });
        }
        untrack();
        return Promise.resolve(finishLogout());
      }

      // 4) RPC is_owner
      if (href.includes('/rest/v1/rpc/is_owner')) {
        untrack();
        const session = server.lookupByAccessToken(bearer);
        if (!session || session.revoked) {
          return Promise.resolve(
            new Response(JSON.stringify({ message: 'Unauthorized' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify(true), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      untrack();
      return Promise.resolve(new Response(null, { status: 404 }));
    };
  }

  function createTab(slot: number): TabHandle {
    const tabId = `tab-${slot}#${tabSeq++}`;
    const activeCtrl = createActiveTabController({
      getLocks: () => lockManager.locks,
      getProjectUrl: () => projectUrl,
    });

    const tab: TabHandle = {
      slot,
      tabId,
      activeCtrl,
      managedClient: null as never,
      heldWrites: null as never,
      store: null as never,
      destroyed: false,
      inFlightSignOuts: 0,
      inFlightSignIns: 0,
      inFlightRetries: 0,
      inFlightRefreshes: 0,
      inFlightFetchSignals: new Set(),
      inactiveFetchCount: 0,
      inactiveStorageWriteCount: 0,
      unabortedDemotedFetchCount: 0,
      revocationOriginSids: new Set(),
      differentSessionAppearedAfterSignOut: false,
    };

    const backingStorage = makeTrackedBackingStorage(tab);
    const managedClient = createManagedSupabaseClient({
      url: projectUrl,
      anonKey: TEST_ANON_KEY,
      storageKey: sdkKey,
      getStorage: () => backingStorage,
      getFetch: () => makeRawNetworkFetchForTab(tab),
      manageAutoRefresh: true,
    });
    // Tabs start inactive until Web Lock leadership is granted!
    managedClient.deactivate();
    tab.managedClient = managedClient;

    const heldWrites = createHeldWriteStore({
      getStorage: () => backingStorage,
      getProjectUrl: () => projectUrl,
      getLocks: () => lockManager.locks,
      allowTestLocalUser: false,
      allowTestUnlocked: false,
    });
    heldWrites.setHeldWritesTabActive(false);
    tab.heldWrites = heldWrites;

    const store = createAuthStore({
      getClient: () => managedClient.getClient(),
      getProjectUrl: () => projectUrl,
      getStorage: () => backingStorage,
      storageKey: sdkKey,
      heldWrites,
      syncGlobalStores: true,
      initiallyActive: false,
    });
    tab.store = store;

    activeCtrl.registerLifecycle({
      onBecomeActive: () => {
        if (tab.destroyed) return;
        heldWrites.setHeldWritesTabActive(true);
        managedClient.enable();
        store.activate();
        store.startAuth();
      },
      onBecomeInactive: () => {
        const prevSignals = [...tab.inFlightFetchSignals];
        store.deactivate();
        managedClient.deactivate();
        heldWrites.setHeldWritesTabActive(false);
        tab.revocationOriginSids.clear();
        // P1-1: Every in-flight fetch of the demoted generation MUST have its
        // AbortSignal aborted synchronously upon demotion!
        for (const sig of prevSignals) {
          if (sig.aborted) {
            stats.inFlightFetchesAbortedOnTakeover += 1;
          } else {
            tab.unabortedDemotedFetchCount += 1;
          }
        }
        tab.inFlightFetchSignals.clear();
      },
    });

    activeCtrl.start();
    return tab;
  }

  function destroyTab(tab: TabHandle): void {
    if (tab.destroyed) return;
    tab.destroyed = true;
    tab.activeCtrl.dispose();
    tab.store.deactivate();
    tab.managedClient.deactivate();
    tab.heldWrites.setHeldWritesTabActive(false);
    tab.heldWrites.dispose();
  }

  function getActiveTab(): TabHandle | null {
    return tabs.find((t) => !t.destroyed && t.activeCtrl.isActive()) ?? null;
  }

  function hasAnyInFlight(): boolean {
    return tabs.some(
      (t) =>
        !t.destroyed &&
        (t.inFlightSignOuts > 0 ||
          t.inFlightSignIns > 0 ||
          t.inFlightRetries > 0 ||
          t.inFlightRefreshes > 0),
    );
  }

  function checkInvariantsAfterStep(label: string): void {
    const liveTabs = tabs.filter((t) => !t.destroyed);
    const activeTabs = liveTabs.filter((t) => t.activeCtrl.isActive());
    const inactiveTabs = liveTabs.filter((t) => !t.activeCtrl.isActive());

    // === I6: At most ONE active tab; inactive tabs have zero fetches, zero storage writes, no unaborted fetches, no live client ===
    if (activeTabs.length > 1) {
      throw formatFailure(
        'I6-multiple-active-tabs',
        `At ${label}: ${activeTabs.length} tabs simultaneously active (${activeTabs.map((t) => t.tabId).join(', ')})`,
      );
    }
    for (const t of liveTabs) {
      if (t.inactiveFetchCount > 0) {
        throw formatFailure(
          'I6-inactive-fetch',
          `At ${label}: ${t.tabId} invoked fetch ${t.inactiveFetchCount} times while inactive`,
        );
      }
      if (t.inactiveStorageWriteCount > 0) {
        throw formatFailure(
          'I6-inactive-storage-write',
          `At ${label}: ${t.tabId} wrote storage ${t.inactiveStorageWriteCount} times while inactive`,
        );
      }
      if (t.unabortedDemotedFetchCount > 0) {
        throw formatFailure(
          'I6-demoted-fetch-not-aborted',
          `At ${label}: ${t.tabId} left ${t.unabortedDemotedFetchCount} in-flight fetch(es) unaborted on demotion`,
        );
      }
    }
    for (const t of inactiveTabs) {
      stats.inactiveTabsVerifiedSilent += 1;
      if (t.managedClient.hasInstantiatedClient()) {
        throw formatFailure(
          'I6-inactive-has-client',
          `At ${label}: inactive ${t.tabId} still holds a SupabaseClient instance`,
        );
      }
      const snap = t.store.getAuthSnapshot();
      if (snap.status === 'owner') {
        throw formatFailure(
          'I6-inactive-rendered-owner',
          `At ${label}: inactive ${t.tabId} still has auth status=owner`,
        );
      }
    }

    const persistedSid = readPersistedSid(values.get(sdkKey));
    const persistedEmail = readPersistedUserEmail(values.get(sdkKey));
    const durable = readDurableRecord(values.get(coordKey));
    const activeTab = activeTabs[0] ?? null;

    // === I3: Cross-user revocation check ===
    for (const s of server.allSessions()) {
      if (s.revoked && s.revokedBySessionKey) {
        const originUser = signOutOriginUsers.get(s.revokedBySessionKey);
        if (originUser && originUser !== s.user.id) {
          throw formatFailure(
            'I3-cross-user-revocation',
            `At ${label}: signOut for ${s.revokedBySessionKey} (${originUser}) revoked ${s.sessionKey} (${s.user.id})`,
          );
        }
      }
    }

    // === I1 & I2 & I5 on active tab ===
    if (activeTab) {
      const snap = activeTab.store.getAuthSnapshot();
      if (
        (snap.logoutPhase === 'signing_out' ||
          snap.logoutPhase === 'retrying_local' ||
          snap.logoutPhase === 'local_failed' ||
          snap.logoutPhase === 'retrying_revocation') &&
        snap.status === 'owner'
      ) {
        throw formatFailure(
          'I1-owner-during-logout',
          `At ${label}: active ${activeTab.tabId} has status=owner during logoutPhase=${snap.logoutPhase}`,
        );
      }
      if (
        durable?.state === 'local_failed' &&
        (durable.sessionKey === null || durable.sessionKey === persistedSid) &&
        activeTab.inFlightSignIns === 0 &&
        snap.status === 'owner'
      ) {
        throw formatFailure(
          'I1-owner-despite-local-failed',
          `At ${label}: active ${activeTab.tabId} is status=owner despite durable local_failed for ${persistedSid ?? 'null'}`,
        );
      }
      if (
        snap.status === 'owner' &&
        persistedSid !== null &&
        server.isConfirmedRevoked(persistedSid) &&
        activeTab.inFlightSignIns === 0
      ) {
        throw formatFailure(
          'I1-owner-on-confirmed-revoked-session',
          `At ${label}: active ${activeTab.tabId} is status=owner on confirmed-revoked ${persistedSid}`,
        );
      }

      // === I2: Active tab never claims clean idle for an unconfirmed revoked session ===
      const activeIdleSettled =
        activeTab.inFlightSignOuts === 0 &&
        activeTab.inFlightRetries === 0 &&
        activeTab.inFlightSignIns === 0 &&
        snap.status === 'signed-out' &&
        persistedSid === null;
      if (
        activeIdleSettled &&
        durable?.state === 'revocation_failed' &&
        durable.sessionKey !== null &&
        !server.isConfirmedRevoked(durable.sessionKey) &&
        !snap.logoutRevocationFailed
      ) {
        throw formatFailure(
          'I2-active-tab-hid-revocation-failed',
          `At ${label}: active ${activeTab.tabId} has logoutRevocationFailed=false while durable revocation_failed holds unconfirmed ${durable.sessionKey}`,
        );
      }

      // === I5: Held-writes per-user isolation ===
      if (snap.status === 'owner' && snap.email) {
        if (
          snap.email === USER_A.email &&
          activeTab.heldWrites.getHeldWrite('model:op-b') !== null
        ) {
          throw formatFailure(
            'I5-user-b-leaked-into-user-a',
            `At ${label}: User B held write became readable while User A is owner`,
          );
        }
        if (
          snap.email === USER_B.email &&
          activeTab.heldWrites.getHeldWrite('model:op-a') !== null
        ) {
          throw formatFailure(
            'I5-user-a-leaked-into-user-b',
            `At ${label}: User A held write became readable while User B is owner`,
          );
        }
        if (
          persistedEmail &&
          persistedEmail !== snap.email &&
          activeTab.inFlightSignIns === 0
        ) {
          throw formatFailure(
            'I5-owner-email-mismatch',
            `At ${label}: active ${activeTab.tabId} is owner as ${snap.email} while sdkKey holds ${persistedEmail}`,
          );
        }
      } else if (
        snap.status === 'signed-out' &&
        !activeTab.heldWrites.isWritesLocked()
      ) {
        throw formatFailure(
          'I5-writes-unlocked-while-signed-out',
          `At ${label}: writes unlocked while active ${activeTab.tabId} is signed-out`,
        );
      }
    } else if (liveTabs.length > 0) {
      stats.noActiveTabLockedVerified += 1;
      for (const t of liveTabs) {
        if (!t.heldWrites.isWritesLocked()) {
          throw formatFailure(
            'I5-writes-unlocked-with-no-active-tab',
            `At ${label}: writes unlocked on ${t.tabId} while all tabs are inactive`,
          );
        }
      }
    }

    // Every inactive tab must also keep its held-writes store locked (I5/I6).
    for (const t of inactiveTabs) {
      if (!t.heldWrites.isWritesLocked()) {
        throw formatFailure(
          'I5-writes-unlocked-with-no-active-tab',
          `At ${label}: writes unlocked on inactive ${t.tabId}`,
        );
      }
    }

    // Both users' unresolved held writes must survive every sign-out & takeover!
    if (!values.has(hwKeys.opAKey) || !values.has(hwKeys.opBKey)) {
      throw formatFailure(
        'I5-unresolved-held-write-lost',
        `At ${label}: unresolved held write was unexpectedly erased from storage`,
      );
    }

    // Restored I5 check: once User A signs out while active (and the tab stayed
    // active long enough for the queued Web Lock prune to run), User A's
    // `posted_reload` pin must be cleared from storage.
    if (userACleanSignOutSettledWhileActive) {
      stats.postedReloadClearedVerified += 1;
      if (values.has(hwKeys.postedAKey)) {
        throw formatFailure(
          'I5-posted-reload-not-cleared',
          `At ${label}: User A posted_reload held write was not cleared after sign-out`,
        );
      }
    }
  }

  try {
    // Boot initial tabs: tab 0 acquires leadership immediately, tabs 1..N-1 boot inactive.
    for (let i = 0; i < tabCount; i += 1) {
      tabs.push(createTab(i));
    }
    await vi.advanceTimersByTimeAsync(50);
    await flushMicrotasks();
    checkInvariantsAfterStep('boot');

    // === MAIN RANDOMIZED STEP LOOP ===
    for (let step = 0; step < STEPS_PER_SEED; step += 1) {
      const r = rand();
      const activeTab = getActiveTab();
      const inactiveTabs = tabs.filter(
        (t) => !t.destroyed && !t.activeCtrl.isActive(),
      );

      if (r < 0.16 && inactiveTabs.length > 0) {
        // Explicit takeover by an inactive tab (including during in-flight sign-out, sign-in, or refresh!)
        const challenger = pick(inactiveTabs);
        const wasDuringSignOut = (activeTab?.inFlightSignOuts ?? 0) > 0;
        const wasDuringSignIn = (activeTab?.inFlightSignIns ?? 0) > 0;
        const wasDuringRefresh = (activeTab?.inFlightRefreshes ?? 0) > 0;
        stats.takeovers += 1;
        if (wasDuringSignOut) stats.takeoversDuringSignOut += 1;
        if (wasDuringSignIn) stats.takeoversDuringSignIn += 1;
        if (wasDuringRefresh) stats.takeoversDuringRefresh += 1;
        trace.push(
          `step ${step}: takeOver(${challenger.tabId}) from=${activeTab?.tabId ?? 'none'} duringSignOut=${wasDuringSignOut} duringSignIn=${wasDuringSignIn} duringRefresh=${wasDuringRefresh}`,
        );
        await challenger.activeCtrl.takeOver();
        await vi.advanceTimersByTimeAsync(25);
        await flushMicrotasks();
      } else if (r < 0.28 && activeTab) {
        // Sign in on the active tab
        const user = chance(0.55) ? USER_A : USER_B;
        trace.push(`step ${step}: signIn(${activeTab.tabId}, ${user.id})`);
        const canAwaitSync =
          !slowSignIn && deferredNets.length === 0 && !hasAnyInFlight();
        activeTab.inFlightSignIns += 1;
        const p = activeTab.store
          .signIn(user.email, 'ValidPassword123')
          .then((res) => {
            if (res === 'ok') {
              const sid = readPersistedSid(values.get(sdkKey));
              if (sid) {
                latestCleanSignedInSid = sid;
                if (sid !== latestSignOutSessionKey) {
                  activeTab.differentSessionAppearedAfterSignOut = true;
                  latestSignOutSessionKey = null;
                  latestSignOutUnpersistedAndUnerased = false;
                }
              }
            }
          })
          .finally(() => {
            activeTab.inFlightSignIns -= 1;
          });
        if (canAwaitSync) {
          await p;
        }
        await vi.advanceTimersByTimeAsync(20);
        await flushMicrotasks();
      } else if (r < 0.44 && activeTab) {
        // Sign out on the active tab
        const targetSid = readPersistedSid(values.get(sdkKey));
        const targetSession = targetSid ? server.lookupByKey(targetSid) : null;
        if (targetSid) {
          everSignOutTargetedSids.add(targetSid);
          if (targetSession) {
            signOutOriginUsers.set(targetSid, targetSession.user.id);
          }
          latestSignOutSessionKey = targetSid;
          const sdkEraseBlocked =
            failSdkRemove && (failSdkTombstone || quotaMode === 'zero_byte');
          const coordWriteBlocked =
            quotaMode === 'coord_blocked' || quotaMode === 'zero_byte';
          latestSignOutUnpersistedAndUnerased =
            sdkEraseBlocked && coordWriteBlocked;
          activeTab.revocationOriginSids.add(targetSid);
          activeTab.differentSessionAppearedAfterSignOut = false;
        }
        const signOutOriginEmail = activeTab.store.getAuthSnapshot().email;
        const signOutOriginStatus = activeTab.store.getAuthSnapshot().status;
        trace.push(
          `step ${step}: signOut(${activeTab.tabId}) target=${targetSid ?? 'none'} mode=${logoutMode} quota=${quotaMode} rmFail=${failSdkRemove} tombFail=${failSdkTombstone}`,
        );
        const canAwaitSync =
          logoutMode !== 'slow_204' &&
          logoutMode !== 'slow_503' &&
          refreshMode === 'ok' &&
          deferredNets.length === 0 &&
          !hasAnyInFlight();
        activeTab.inFlightSignOuts += 1;
        const p = activeTab.store.signOut().finally(() => {
          activeTab.inFlightSignOuts -= 1;
        });
        if (canAwaitSync) {
          await p;
        }
        await vi.advanceTimersByTimeAsync(20);
        await flushMicrotasks();
        if (
          signOutOriginStatus === 'owner' &&
          signOutOriginEmail === USER_A.email &&
          !activeTab.destroyed &&
          activeTab.activeCtrl.isActive()
        ) {
          userACleanSignOutSettledWhileActive = true;
        }
      } else if (r < 0.51 && activeTab) {
        // Retry logout revocation on the active tab
        const canRetry =
          activeTab.store.getAuthSnapshot().canRetryLogoutRevocation;
        trace.push(
          `step ${step}: retryLogoutRevocation(${activeTab.tabId}) canRetry=${canRetry}`,
        );
        const canAwaitSync =
          logoutMode !== 'slow_204' &&
          logoutMode !== 'slow_503' &&
          refreshMode === 'ok' &&
          deferredNets.length === 0 &&
          !hasAnyInFlight();
        activeTab.inFlightRetries += 1;
        const p = activeTab.store.retryLogoutRevocation().finally(() => {
          activeTab.inFlightRetries -= 1;
        });
        if (canAwaitSync) {
          await p;
        }
        await vi.advanceTimersByTimeAsync(20);
        await flushMicrotasks();
      } else if (
        r < 0.59 &&
        activeTab &&
        activeTab.managedClient.hasInstantiatedClient()
      ) {
        // Trigger a real token refresh on the active tab's production GoTrueClient
        // (exercises in-flight refresh abortion + BroadcastChannel isolation on takeover!)
        const client = activeTab.managedClient.getClient();
        if (client && activeTab.store.getAuthSnapshot().status === 'owner') {
          trace.push(
            `step ${step}: refreshSession(${activeTab.tabId}, mode=${refreshMode})`,
          );
          activeTab.inFlightRefreshes += 1;
          void client.auth
            .refreshSession()
            .catch(() => {})
            .finally(() => {
              activeTab.inFlightRefreshes -= 1;
            });
          await vi.advanceTimersByTimeAsync(15);
          await flushMicrotasks();
        }
      } else if (r < 0.67) {
        // Reload a tab (active or inactive)
        const slot = Math.floor(rand() * tabCount);
        const existing = tabs[slot]!;
        const wasActive = !existing.destroyed && existing.activeCtrl.isActive();
        stats.tabReloads += 1;
        trace.push(
          `step ${step}: reload(${existing.tabId}) wasActive=${wasActive}`,
        );
        destroyTab(existing);
        tabs[slot] = createTab(slot);
        await vi.advanceTimersByTimeAsync(30);
        await flushMicrotasks();
      } else if (r < 0.72) {
        // Close a tab (keep at least 1 live tab)
        const live = tabs.filter((t) => !t.destroyed);
        if (live.length > 1) {
          const victim = pick(live);
          stats.tabCloses += 1;
          trace.push(
            `step ${step}: close(${victim.tabId}) wasActive=${victim.activeCtrl.isActive()}`,
          );
          destroyTab(victim);
          await vi.advanceTimersByTimeAsync(20);
          await flushMicrotasks();
        }
      } else if (r < 0.8 && deferredNets.length > 0) {
        // Resolve one deferred network response
        const idx = Math.floor(rand() * deferredNets.length);
        const net = deferredNets.splice(idx, 1)[0]!;
        trace.push(
          `step ${step}: resolveNet(${net.kind}, ${net.tabId}, ${net.sessionKey ?? '-'})`,
        );
        net.resolve();
        await vi.advanceTimersByTimeAsync(25);
        await flushMicrotasks();
      } else if (
        r < 0.86 &&
        activeTab &&
        activeTab.managedClient.hasInstantiatedClient()
      ) {
        // Inject a late TOKEN_REFRESHED on the active tab for a revoked session
        const revokedSessions = server.allSessions().filter((s) => s.revoked);
        const target =
          revokedSessions.length > 0
            ? pick(revokedSessions)
            : server.allSessions()[0];
        const client = activeTab.managedClient.getClient();
        if (target && client) {
          if (target.revoked) {
            stats.lateRevokedRefreshEvents += 1;
          }
          trace.push(
            `step ${step}: lateRefresh(${activeTab.tabId}, ${target.sessionKey}, revoked=${target.revoked})`,
          );
          const payload = toSessionPayload(target);
          const clientAuth = client.auth as unknown as {
            _notifyAllSubscribers?: (
              event: string,
              session: unknown,
            ) => Promise<void>;
          };
          if (typeof clientAuth._notifyAllSubscribers === 'function') {
            await clientAuth._notifyAllSubscribers('TOKEN_REFRESHED', payload);
          }
          await vi.advanceTimersByTimeAsync(20);
          await flushMicrotasks();
        }
      } else if (r < 0.93) {
        // Advance fake timers (crossing 10s /logout timeout and 30s autoRefreshTicker!)
        const ms = pick([500, 3_000, 11_000, 31_000] as const);
        trace.push(`step ${step}: advanceTime(${ms}ms)`);
        await vi.advanceTimersByTimeAsync(ms);
        await flushMicrotasks();
      } else {
        // Flip environment fault knobs
        const knob = Math.floor(rand() * 5);
        if (knob === 0) {
          quotaMode = pick(['normal', 'coord_blocked', 'zero_byte'] as const);
          trace.push(`step ${step}: env quotaMode=${quotaMode}`);
        } else if (knob === 1) {
          failSdkRemove = chance(0.45);
          failSdkTombstone = chance(0.35);
          trace.push(
            `step ${step}: env rmFail=${failSdkRemove} tombFail=${failSdkTombstone}`,
          );
        } else if (knob === 2) {
          logoutMode = pick([
            '204',
            '503',
            'slow_204',
            'slow_503',
            '401_once',
          ] as const);
          trace.push(`step ${step}: env logoutMode=${logoutMode}`);
        } else if (knob === 3) {
          refreshMode = pick(['ok', 'slow_ok', 'slow_400'] as const);
          trace.push(`step ${step}: env refreshMode=${refreshMode}`);
        } else {
          slowSignIn = chance(0.35);
          trace.push(`step ${step}: env slowSignIn=${slowSignIn}`);
        }
      }

      checkInvariantsAfterStep(`step ${step}`);
    }

    // === FINAL QUIESCE & SETTLE PHASE (checks I1-I6) ===
    trace.push('--- SETTLE PHASE ---');
    quotaMode = 'normal';
    logoutMode = '204';
    refreshMode = 'ok';
    slowSignIn = false;
    failSdkRemove = false;
    failSdkTombstone = false;

    let guard = 0;
    while ((deferredNets.length > 0 || hasAnyInFlight()) && guard < 25) {
      guard += 1;
      while (deferredNets.length > 0) {
        deferredNets.shift()!.resolve();
      }
      await vi.advanceTimersByTimeAsync(2_000);
      await flushMicrotasks();
    }
    await vi.advanceTimersByTimeAsync(11_500);
    await flushMicrotasks();

    let activeAfterSettle = getActiveTab();
    if (!activeAfterSettle) {
      const live = tabs.find((t) => !t.destroyed);
      if (live) {
        await live.activeCtrl.takeOver();
        await vi.advanceTimersByTimeAsync(30);
        await flushMicrotasks();
        activeAfterSettle = live;
      }
    }

    checkInvariantsAfterStep('post-settle');

    const persistedAfterSettle = readPersistedSid(values.get(sdkKey));
    const durableAfterSettle = readDurableRecord(values.get(coordKey));
    const isLocalFailedAfterSettle =
      durableAfterSettle?.state === 'local_failed' &&
      (durableAfterSettle.sessionKey === null ||
        durableAfterSettle.sessionKey === persistedAfterSettle);

    // I1 post-settle: a confirmed-revoked session must NEVER remain persisted outside local_failed.
    if (
      persistedAfterSettle !== null &&
      !isLocalFailedAfterSettle &&
      server.isConfirmedRevoked(persistedAfterSettle)
    ) {
      throw formatFailure(
        'I1-revoked-session-persisted-after-settle',
        `Confirmed-revoked ${persistedAfterSettle} remained in sdkKey after settle`,
      );
    }

    if (activeAfterSettle) {
      const snap = activeAfterSettle.store.getAuthSnapshot();
      if (
        snap.logoutPhase === 'signing_out' ||
        snap.logoutPhase === 'retrying_local' ||
        snap.logoutPhase === 'retrying_revocation'
      ) {
        throw formatFailure(
          'I4-stuck-inflight',
          `Active ${activeAfterSettle.tabId} stayed stuck in logoutPhase=${snap.logoutPhase}`,
        );
      }
      if (persistedAfterSettle === null) {
        if (snap.status !== 'signed-out') {
          throw formatFailure(
            'I1-zombie-owner-after-settle',
            `Active ${activeAfterSettle.tabId} has status=${snap.status} with no sdkKey`,
          );
        }
        if (
          snap.logoutFailed ||
          snap.logoutPending ||
          !activeAfterSettle.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I4-login-disabled-after-settle',
            `Active ${activeAfterSettle.tabId} left login disabled with no sdkKey (phase=${snap.logoutPhase})`,
          );
        }
        if (durableAfterSettle?.state === 'revocation_failed') {
          const sid = durableAfterSettle.sessionKey;
          const sidConfirmed = sid !== null && server.isConfirmedRevoked(sid);
          if (!sidConfirmed && !snap.logoutRevocationFailed) {
            throw formatFailure(
              'I2-missing-revocation-failed-after-settle',
              `Active ${activeAfterSettle.tabId} reported logoutRevocationFailed=false for unconfirmed ${sid ?? 'null'}`,
            );
          }
          if (
            sid !== null &&
            !sidConfirmed &&
            activeAfterSettle.revocationOriginSids.has(sid) &&
            !activeAfterSettle.differentSessionAppearedAfterSignOut &&
            !snap.canRetryLogoutRevocation
          ) {
            throw formatFailure(
              'I2-origin-tab-lost-retry-capability',
              `Originating active ${activeAfterSettle.tabId} lost canRetryLogoutRevocation for unconfirmed ${sid}`,
            );
          }
          if (
            sid !== null &&
            !activeAfterSettle.revocationOriginSids.has(sid) &&
            snap.canRetryLogoutRevocation
          ) {
            throw formatFailure(
              'I2-non-origin-tab-has-fake-retry',
              `Non-origin active ${activeAfterSettle.tabId} falsely exposed canRetryLogoutRevocation=true for ${sid}`,
            );
          }
        }
      } else if (isLocalFailedAfterSettle) {
        if (snap.status === 'owner') {
          throw formatFailure(
            'I1-owner-with-local-failed-after-settle',
            `Active ${activeAfterSettle.tabId} remained owner while local_failed holds ${persistedAfterSettle}`,
          );
        }
      }
    }

    // === I2 Retry Convergence Check ===
    if (
      activeAfterSettle &&
      persistedAfterSettle === null &&
      durableAfterSettle?.state === 'revocation_failed'
    ) {
      stats.revocationFailedPostSettle += 1;
      if (activeAfterSettle.store.getAuthSnapshot().canRetryLogoutRevocation) {
        const retrySid = durableAfterSettle.sessionKey;
        await activeAfterSettle.store.retryLogoutRevocation();
        await vi.advanceTimersByTimeAsync(50);
        await flushMicrotasks();
        if (retrySid !== null && !server.isConfirmedRevoked(retrySid)) {
          throw formatFailure(
            'I2-retry-did-not-revoke-on-server',
            `retryLogoutRevocation() on ${activeAfterSettle.tabId} did not revoke ${retrySid}`,
          );
        }
        const postRetrySnap = activeAfterSettle.store.getAuthSnapshot();
        if (
          postRetrySnap.status !== 'signed-out' ||
          postRetrySnap.logoutPhase !== 'idle' ||
          postRetrySnap.logoutRevocationFailed ||
          !activeAfterSettle.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I2-retry-did-not-converge',
            `Active ${activeAfterSettle.tabId} stayed in status=${postRetrySnap.status} phase=${postRetrySnap.logoutPhase} after retry`,
          );
        }
        stats.revocationRetriesConverged += 1;
      }
    }

    // === I1/I4/I6 Fresh Takeover Probe ===
    const probeTab = createTab(tabCount);
    try {
      await vi.advanceTimersByTimeAsync(30);
      await flushMicrotasks();
      if (activeAfterSettle && probeTab.activeCtrl.isActive()) {
        throw formatFailure(
          'I6-probe-booted-active-while-lock-held',
          `Fresh probeTab booted active while ${activeAfterSettle.tabId} held leadership`,
        );
      }
      if (
        probeTab.inactiveFetchCount > 0 ||
        probeTab.inactiveStorageWriteCount > 0 ||
        probeTab.managedClient.hasInstantiatedClient()
      ) {
        throw formatFailure(
          'I6-probe-touched-network-or-storage-while-inactive',
          `Inactive probeTab touched fetch=${probeTab.inactiveFetchCount} storage=${probeTab.inactiveStorageWriteCount} client=${probeTab.managedClient.hasInstantiatedClient()}`,
        );
      }

      await probeTab.activeCtrl.takeOver();
      await vi.advanceTimersByTimeAsync(50);
      await flushMicrotasks();
      if (activeAfterSettle && activeAfterSettle.activeCtrl.isActive()) {
        throw formatFailure(
          'I6-old-active-did-not-yield-on-takeover',
          `Previous active ${activeAfterSettle.tabId} stayed active after probeTab.takeOver()`,
        );
      }

      const probeSnap = probeTab.store.getAuthSnapshot();
      const postProbePersisted = readPersistedSid(values.get(sdkKey));
      const postProbeDurable = readDurableRecord(values.get(coordKey));
      const postProbeLocalFailed =
        postProbeDurable?.state === 'local_failed' &&
        (postProbeDurable.sessionKey === null ||
          postProbeDurable.sessionKey === postProbePersisted);

      if (postProbePersisted === null) {
        if (
          probeSnap.status !== 'signed-out' ||
          probeSnap.logoutFailed ||
          probeSnap.logoutPending ||
          !probeTab.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I1-I4-probe-after-takeover-no-creds',
            `probeTab booted into status=${probeSnap.status} phase=${probeSnap.logoutPhase} with no sdkKey`,
          );
        }
        if (postProbeDurable?.state === 'revocation_failed') {
          if (
            !probeSnap.logoutRevocationFailed ||
            probeSnap.canRetryLogoutRevocation
          ) {
            throw formatFailure(
              'I2-probe-revocation-failed-mismatch',
              `probeTab after takeover had logoutRevocationFailed=${probeSnap.logoutRevocationFailed} canRetry=${probeSnap.canRetryLogoutRevocation}`,
            );
          }
        }
      } else if (postProbeLocalFailed) {
        if (
          probeSnap.status !== 'signed-out' ||
          probeSnap.logoutPhase !== 'local_failed' ||
          probeTab.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I1-probe-reopened-local-failed',
            `probeTab booted into status=${probeSnap.status} phase=${probeSnap.logoutPhase} under local_failed`,
          );
        }
        // P2-2 check: probe booted into local_failed with sdkKey present MUST NOT have instantiated GoTrueClient!
        if (probeTab.managedClient.hasInstantiatedClient()) {
          throw formatFailure(
            'P2-2-probe-instantiated-client-in-local-failed',
            'probeTab instantiated GoTrueClient while booted into local_failed',
          );
        }
        stats.localFailedRecoveries += 1;
        await probeTab.store.signOut();
        await vi.advanceTimersByTimeAsync(50);
        await flushMicrotasks();
        if (readPersistedSid(values.get(sdkKey)) !== null) {
          throw formatFailure(
            'I4-local-failed-recovery-left-sdk',
            'Retrying signOut after storage recovery failed to erase sdkKey',
          );
        }
        const recovered = probeTab.store.getAuthSnapshot();
        if (
          recovered.status !== 'signed-out' ||
          recovered.logoutPhase !== 'idle' ||
          !probeTab.store.isAuthResolved()
        ) {
          throw formatFailure(
            'I4-local-failed-recovery-did-not-converge',
            `probeTab stayed in status=${recovered.status} phase=${recovered.logoutPhase} after recovery`,
          );
        }
      } else if (
        server.isConfirmedRevoked(postProbePersisted) &&
        probeSnap.status === 'owner'
      ) {
        throw formatFailure(
          'I1-probe-reopened-revoked-session',
          `probeTab booted into status=owner on confirmed-revoked ${postProbePersisted}`,
        );
      } else if (
        !latestSignOutUnpersistedAndUnerased &&
        latestCleanSignedInSid !== null &&
        everSignOutTargetedSids.has(postProbePersisted) &&
        postProbePersisted === latestSignOutSessionKey &&
        probeSnap.status === 'owner'
      ) {
        throw formatFailure(
          'I1-probe-reopened-failed-signout-session',
          `probeTab booted into status=owner on sign-out-targeted ${postProbePersisted}`,
        );
      }

      // If no credentials remain, verify login is functional on probeTab (I4)
      // and check I5 held-write isolation after signing in as USER_B!
      if (readPersistedSid(values.get(sdkKey)) === null) {
        const signInResult = await probeTab.store.signIn(
          USER_B.email,
          'ValidPassword123',
        );
        await vi.advanceTimersByTimeAsync(50);
        await flushMicrotasks();
        if (
          signInResult !== 'ok' ||
          probeTab.store.getAuthSnapshot().status !== 'owner'
        ) {
          throw formatFailure(
            'I4-login-unusable-after-takeover',
            `probeTab signIn returned ${signInResult} with status=${probeTab.store.getAuthSnapshot().status}`,
          );
        }
        probeTab.heldWrites.rehydrateHeldWrites();
        if (probeTab.heldWrites.getHeldWrite('model:op-a') !== null) {
          throw formatFailure(
            'I5-post-settle-cross-user-leak',
            'User A held write leaked into User B after post-settle signIn',
          );
        }
        if (probeTab.heldWrites.getHeldWrite('model:op-b') === null) {
          throw formatFailure(
            'I5-user-b-held-write-missing',
            'User B held write disappeared after post-settle signIn',
          );
        }
      }
    } finally {
      destroyTab(probeTab);
    }

    if (
      server
        .allSessions()
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
    while (deferredNets.length > 0) {
      deferredNets.shift()!.resolve();
    }
    for (const t of tabs) {
      if (!t.destroyed) {
        destroyTab(t);
      }
    }
    bcHub.closeAll();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: originalBroadcastChannel,
    });
  }
}

describe('auth-store one-active-tab model-based suite (I1-I6)', () => {
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

  const BATCH_SIZE = 40;
  const BATCH_COUNT = SEED_COUNT / BATCH_SIZE;
  const suiteStats: ModelCoverageStats = {
    takeovers: 0,
    takeoversDuringSignOut: 0,
    takeoversDuringSignIn: 0,
    takeoversDuringRefresh: 0,
    inFlightFetchesAbortedOnTakeover: 0,
    broadcastChannelsOpened: 0,
    heldWriteWebLocksUsed: 0,
    refreshCallsAttempted: 0,
    tabCloses: 0,
    tabReloads: 0,
    revocationFailedPostSettle: 0,
    revocationRetriesConverged: 0,
    localFailedRecoveries: 0,
    tombstoneFallbacks: 0,
    lateRevokedRefreshEvents: 0,
    globalMultiSessionRevokes: 0,
    inactiveTabsVerifiedSilent: 0,
    postedReloadClearedVerified: 0,
    noActiveTabLockedVerified: 0,
  };

  for (let batch = 0; batch < BATCH_COUNT; batch += 1) {
    const startSeed = batch * BATCH_SIZE + 1;
    const endSeed = startSeed + BATCH_SIZE - 1;
    it(`preserves invariants I1-I6 across seeds ${startSeed}..${endSeed} (${STEPS_PER_SEED} randomized steps each)`, async () => {
      for (let seed = startSeed; seed <= endSeed; seed += 1) {
        await runModelSeed(seed, suiteStats);
      }
    }, 30_000);
  }

  it('exercises production client factory, BroadcastChannel, in-flight aborts, held-write Web Locks, takeovers, retries, recoveries, tombstones, late refreshes, and inactive silence non-vacuously', () => {
    expect(suiteStats.takeovers).toBeGreaterThan(0);
    expect(suiteStats.takeoversDuringSignOut).toBeGreaterThan(0);
    expect(suiteStats.takeoversDuringSignIn).toBeGreaterThan(0);
    expect(suiteStats.takeoversDuringRefresh).toBeGreaterThan(0);
    expect(suiteStats.inFlightFetchesAbortedOnTakeover).toBeGreaterThan(0);
    expect(suiteStats.broadcastChannelsOpened).toBeGreaterThan(0);
    expect(suiteStats.heldWriteWebLocksUsed).toBeGreaterThan(0);
    expect(suiteStats.refreshCallsAttempted).toBeGreaterThan(0);
    expect(suiteStats.tabCloses).toBeGreaterThan(0);
    expect(suiteStats.tabReloads).toBeGreaterThan(0);
    expect(suiteStats.revocationFailedPostSettle).toBeGreaterThan(0);
    expect(suiteStats.revocationRetriesConverged).toBeGreaterThan(0);
    expect(suiteStats.localFailedRecoveries).toBeGreaterThan(0);
    expect(suiteStats.tombstoneFallbacks).toBeGreaterThan(0);
    expect(suiteStats.lateRevokedRefreshEvents).toBeGreaterThan(0);
    expect(suiteStats.globalMultiSessionRevokes).toBeGreaterThan(0);
    expect(suiteStats.inactiveTabsVerifiedSilent).toBeGreaterThan(0);
    expect(suiteStats.postedReloadClearedVerified).toBeGreaterThan(0);
    expect(suiteStats.noActiveTabLockedVerified).toBeGreaterThan(0);
  });
});
