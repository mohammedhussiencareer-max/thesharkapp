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

export const supabase: SupabaseClient<Database> | null = env
  ? createClient<Database>(env.url, env.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
