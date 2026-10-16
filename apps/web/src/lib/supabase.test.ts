import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSupabaseEnv } from '@/lib/supabase';

describe('readSupabaseEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when the vite env vars are missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    expect(readSupabaseEnv()).toBeNull();
  });

  it('returns null when only one env var is set', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55421');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    expect(readSupabaseEnv()).toBeNull();
  });

  it('returns the url and anon key when both are set', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55421');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');

    expect(readSupabaseEnv()).toEqual({
      url: 'http://127.0.0.1:55421',
      anonKey: 'anon-key',
    });
  });
});
