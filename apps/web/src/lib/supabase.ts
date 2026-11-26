import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export function readSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (typeof url !== 'string' || url.trim() === '') return null;
  if (typeof anonKey !== 'string' || anonKey.trim() === '') return null;
  return { url, anonKey };
}

function resolveLocalStorage(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function combineAbortSignals(signals: Array<AbortSignal | null | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = signals.filter(
    (s): s is AbortSignal => s !== null && s !== undefined,
  );
  const controller = new AbortController();
  for (const s of activeSignals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }
  }
  const cleanups: Array<() => void> = [];
  for (const s of activeSignals) {
    const onAbort = () => {
      controller.abort(s.reason);
    };
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const fn of cleanups) fn();
    },
  };
}

/**
 * Completely tear down a demoted or disposed Supabase auth client:
 * - calls `auth.dispose()` (or `stopAutoRefresh()` for mocks)
 * - synchronously closes & clears `broadcastChannel` and `stateChangeEmitters`
 *   so an in-flight refresh aborting in the same microtask cannot broadcast
 *   `SIGNED_OUT` to the newly active tab (P1-1 / I3 / I6)
 * - chains another teardown onto `initializePromise` so a pending `_initialize`
 *   cannot re-register `visibilitychange` or `autoRefreshTicker` in its `finally`.
 */
export function disposeSupabaseAuthClient(
  client: { auth?: unknown } | null | undefined,
): void {
  const auth = client?.auth as
    | {
        dispose?: () => Promise<void> | void;
        stopAutoRefresh?: () => Promise<void> | void;
        initializePromise?: Promise<unknown> | null;
        broadcastChannel?: { close?: () => void } | null;
        stateChangeEmitters?: { clear?: () => void } | null;
      }
    | undefined;
  if (!auth) return;

  const tearDown = () => {
    try {
      auth.broadcastChannel?.close?.();
      if ('broadcastChannel' in auth) {
        auth.broadcastChannel = null;
      }
      auth.stateChangeEmitters?.clear?.();
    } catch {
      // Ignore on mock or frozen auth objects.
    }
    try {
      if (typeof auth.stopAutoRefresh === 'function') {
        void Promise.resolve(auth.stopAutoRefresh()).catch(() => {});
      }
      if (typeof auth.dispose === 'function') {
        void Promise.resolve(auth.dispose()).catch(() => {});
      }
    } catch {
      // Ignore teardown errors on demoted clients.
    }
  };

  tearDown();
  if (
    auth.initializePromise &&
    typeof auth.initializePromise.then === 'function'
  ) {
    void auth.initializePromise.then(
      () => tearDown(),
      () => tearDown(),
    );
  }
}

export type ManagedSupabaseClientOptions = {
  url: string;
  anonKey: string;
  storageKey?: string;
  getStorage?: () => Storage | undefined;
  getFetch?: () => typeof fetch;
  /**
   * Starts with `autoRefreshToken: false` by default so `auth-store` reconciles
   * durable logout records before any token refresh can fire (P2-2).
   */
  autoRefreshToken?: boolean;
  /**
   * When true (default), marks the client so `auth-store` starts auto-refresh
   * once a valid authenticated session is accepted and stops it whenever
   * blocked/failed/signed-out (P2-2).
   */
  manageAutoRefresh?: boolean;
};

export type ManagedSupabaseController = {
  /** Mark leadership active without eagerly instantiating GoTrueClient (P2-2). */
  enable: () => void;
  /** Mark leadership active and ensure a live client exists. */
  activate: () => SupabaseClient<Database>;
  /** Return the current live client if enabled (creating lazily if needed). */
  getClient: () => SupabaseClient<Database> | null;
  /**
   * Immediately abort all in-flight fetches of the current generation, close
   * BroadcastChannel / listeners, stop auto-refresh, and block any further
   * network or storage activity for the demoted generation (P1-1 / I6).
   */
  deactivate: () => void;
  hasInstantiatedClient: () => boolean;
  isActive: () => boolean;
};

/**
 * Production per-tab Supabase client lifecycle manager.
 * Exported as a factory so both the app singleton and integration/model tests
 * run the exact same generation-gated Storage, AbortController-wired fetch,
 * lazy instantiation, and full `dispose()` teardown path (P1-1, P2-2, P2-3).
 */
export function createManagedSupabaseClient(
  options: ManagedSupabaseClientOptions,
): ManagedSupabaseController {
  const getStorage = options.getStorage ?? resolveLocalStorage;
  const getFetch = options.getFetch ?? (() => globalThis.fetch);
  const autoRefreshToken = options.autoRefreshToken ?? false;
  const manageAutoRefresh = options.manageAutoRefresh ?? true;

  let activeClient: SupabaseClient<Database> | null = null;
  let clientActive = true;
  let clientGeneration = 0;
  let generationAbortController: AbortController | null = null;

  function createGenerationStorage(
    backing: Storage,
    generation: number,
  ): Storage {
    const isLive = () => clientActive && clientGeneration === generation;
    return {
      get length() {
        return isLive() ? backing.length : 0;
      },
      clear() {
        if (!isLive()) return;
        backing.clear();
      },
      getItem(key: string) {
        if (!isLive()) return null;
        return backing.getItem(key);
      },
      key(index: number) {
        if (!isLive()) return null;
        return backing.key(index);
      },
      removeItem(key: string) {
        if (!isLive()) return;
        backing.removeItem(key);
      },
      setItem(key: string, value: string) {
        if (!isLive()) return;
        backing.setItem(key, value);
      },
    };
  }

  function inactiveTabResponse(): Response {
    // Return a non-retryable 499 Response instead of throwing a network error:
    // `@supabase/auth-js` treats thrown fetch errors as `AuthRetryableFetchError`
    // and spins an exponential backoff loop for ~25s inside `_refreshAccessToken`
    // while holding its internal lock. A 499 exits immediately with zero retries,
    // while `generationAbortController.abort()` still aborts the real network
    // request and `disposeSupabaseAuthClient()` has already closed the channel
    // and listeners (P1-1 / I6).
    return new Response(JSON.stringify({ message: 'Tab is inactive' }), {
      status: 499,
      headers: { 'content-type': 'application/json' },
    });
  }

  function createGenerationFetch(
    generation: number,
    generationSignal: AbortSignal,
  ): typeof fetch {
    const isLive = () =>
      clientActive &&
      clientGeneration === generation &&
      !generationSignal.aborted;

    return (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (!isLive()) {
        return Promise.resolve(inactiveTabResponse());
      }
      const requestSignal =
        typeof Request !== 'undefined' && input instanceof Request
          ? input.signal
          : undefined;
      const { signal, cleanup } = combineAbortSignals([
        generationSignal,
        init?.signal,
        requestSignal,
      ]);
      // Always bypass the browser HTTP cache for Supabase API/auth calls so
      // reads never return stale financial or inventory state.
      const fetcher = getFetch();
      let promise: Promise<Response>;
      try {
        promise = Promise.resolve(
          fetcher(input, { ...init, cache: 'no-store', signal }),
        );
      } catch (error) {
        cleanup();
        if (!isLive()) {
          return Promise.resolve(inactiveTabResponse());
        }
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return new Promise<Response>((resolve, reject) => {
        let settled = false;
        const onGenerationAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(inactiveTabResponse());
        };
        if (generationSignal.aborted) {
          onGenerationAbort();
          return;
        }
        generationSignal.addEventListener('abort', onGenerationAbort, {
          once: true,
        });
        promise.then(
          (response) => {
            generationSignal.removeEventListener('abort', onGenerationAbort);
            if (settled) return;
            settled = true;
            cleanup();
            if (!isLive()) {
              resolve(inactiveTabResponse());
              return;
            }
            resolve(response);
          },
          (error: unknown) => {
            generationSignal.removeEventListener('abort', onGenerationAbort);
            if (settled) return;
            settled = true;
            cleanup();
            if (!isLive()) {
              resolve(inactiveTabResponse());
              return;
            }
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    };
  }

  function ensureRealClient(): SupabaseClient<Database> | null {
    if (!clientActive) return null;
    if (activeClient) return activeClient;
    const generation = ++clientGeneration;
    const controller = new AbortController();
    generationAbortController = controller;
    const backing = getStorage();
    const client = createClient<Database>(options.url, options.anonKey, {
      auth: {
        storage: backing
          ? createGenerationStorage(backing, generation)
          : undefined,
        ...(options.storageKey ? { storageKey: options.storageKey } : {}),
        persistSession: true,
        autoRefreshToken,
        detectSessionInUrl: false,
      },
      global: {
        fetch: createGenerationFetch(generation, controller.signal),
      },
    });
    if (manageAutoRefresh) {
      (
        client.auth as unknown as { __thesharkManagedAutoRefresh?: boolean }
      ).__thesharkManagedAutoRefresh = true;
    }
    activeClient = client;
    return activeClient;
  }

  function enable(): void {
    clientActive = true;
  }

  function activate(): SupabaseClient<Database> {
    clientActive = true;
    return ensureRealClient()!;
  }

  function getClient(): SupabaseClient<Database> | null {
    return ensureRealClient();
  }

  function deactivate(): void {
    clientActive = false;
    clientGeneration += 1;
    const previousAbort = generationAbortController;
    generationAbortController = null;
    const previousClient = activeClient;
    activeClient = null;
    // Close BroadcastChannel + emitters synchronously BEFORE aborting fetches
    // so an aborting refresh cannot broadcast SIGNED_OUT to the new active tab.
    if (previousClient) {
      disposeSupabaseAuthClient(previousClient);
    }
    if (previousAbort && !previousAbort.signal.aborted) {
      previousAbort.abort(new DOMException('Tab is inactive', 'AbortError'));
    }
  }

  return {
    enable,
    activate,
    getClient,
    deactivate,
    hasInstantiatedClient: () => activeClient !== null,
    isActive: () => clientActive,
  };
}

const env = readSupabaseEnv();

const defaultController: ManagedSupabaseController | null = env
  ? createManagedSupabaseClient({
      url: env.url,
      anonKey: env.anonKey,
    })
  : null;

/**
 * Mark the tab active so the Supabase client can be lazily instantiated once
 * `auth-store` finishes durable logout reconciliation (P2-2).
 */
export function enableSupabaseClient(): void {
  defaultController?.enable();
}

/**
 * Activate and return the Supabase client for the currently active tab.
 */
export function activateSupabaseClient(): SupabaseClient<Database> | null {
  return defaultController ? defaultController.activate() : null;
}

/**
 * Immediately abort in-flight fetches, close GoTrueClient's BroadcastChannel
 * and listeners, stop auto-refresh, and block any further Supabase network or
 * storage writes when this tab loses leadership (P1-1 / I6).
 */
export function deactivateSupabaseClient(): void {
  defaultController?.deactivate();
}

export function hasInstantiatedSupabaseClient(): boolean {
  return defaultController ? defaultController.hasInstantiatedClient() : false;
}

export function isSupabaseClientActive(): boolean {
  return defaultController ? defaultController.isActive() : false;
}

function createLazySupabaseProxy(
  controller: ManagedSupabaseController,
): SupabaseClient<Database> {
  return new Proxy({} as SupabaseClient<Database>, {
    get(_target, prop) {
      const client = controller.getClient();
      if (!client) {
        throw new Error('Supabase client is unavailable while tab is inactive');
      }
      const value: unknown = Reflect.get(client, prop, client);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(client)
        : value;
    },
  });
}

export const supabase: SupabaseClient<Database> | null = defaultController
  ? createLazySupabaseProxy(defaultController)
  : null;
