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

function noStoreFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Always bypass the browser HTTP cache for Supabase API/auth calls so reads
  // never return stale financial or inventory state.
  return globalThis.fetch(input, { ...init, cache: 'no-store' });
}

function resolveLocalStorage(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export const supabase: SupabaseClient<Database> | null = env
  ? createClient<Database>(env.url, env.anonKey, {
      auth: {
        storage: resolveLocalStorage(),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        fetch: noStoreFetch,
      },
    })
  : null;
