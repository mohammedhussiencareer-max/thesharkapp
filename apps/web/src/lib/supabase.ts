import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export function readSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (typeof url !== 'string' || url.trim() === '') return null;
  if (typeof anonKey !== 'string' || anonKey.trim() === '') return null;
  return { url, anonKey };
}

const env = readSupabaseEnv();

let activeClient: SupabaseClient<Database> | null = null;
let clientActive = true;
let clientGeneration = 0;

function resolveLocalStorage(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

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

function createGenerationFetch(generation: number): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!clientActive || clientGeneration !== generation) {
      return Promise.reject(new DOMException('Tab is inactive', 'AbortError'));
    }
    // Always bypass the browser HTTP cache for Supabase API/auth calls so reads
    // never return stale financial or inventory state.
    return globalThis.fetch(input, { ...init, cache: 'no-store' });
  };
}

function ensureRealClient(): SupabaseClient<Database> | null {
  if (!env || !clientActive) return null;
  if (activeClient) return activeClient;
  const generation = ++clientGeneration;
  const backing = resolveLocalStorage();
  activeClient = createClient<Database>(env.url, env.anonKey, {
    auth: {
      storage: backing
        ? createGenerationStorage(backing, generation)
        : undefined,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    global: {
      fetch: createGenerationFetch(generation),
    },
  });
  return activeClient;
}

/**
 * Activate the Supabase client for the currently active tab. Client creation
 * and token auto-refresh start only after the tab becomes active, so an
 * inactive tab never instantiates GoTrueClient or races token refreshes (I6).
 */
export function activateSupabaseClient(): SupabaseClient<Database> | null {
  if (!env) return null;
  clientActive = true;
  return ensureRealClient();
}

/**
 * Immediately stop auto-refresh and block any further Supabase network or
 * storage writes when this tab loses leadership (I6).
 */
export function deactivateSupabaseClient(): void {
  clientActive = false;
  clientGeneration += 1;
  const previous = activeClient;
  activeClient = null;
  if (previous) {
    void previous.auth.stopAutoRefresh();
  }
}

export function hasInstantiatedSupabaseClient(): boolean {
  return activeClient !== null;
}

export function isSupabaseClientActive(): boolean {
  return clientActive;
}

function createLazySupabaseProxy(): SupabaseClient<Database> {
  return new Proxy({} as SupabaseClient<Database>, {
    get(_target, prop) {
      const client = ensureRealClient();
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

export const supabase: SupabaseClient<Database> | null = env
  ? createLazySupabaseProxy()
  : null;
