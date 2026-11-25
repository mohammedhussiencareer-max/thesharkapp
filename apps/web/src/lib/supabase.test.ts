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

  it('P2: Supabase client requests enforce cache: no-store to bypass the browser HTTP cache', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55421');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(true), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    try {
      vi.resetModules();
      const mod = await import('@/lib/supabase');
      expect(mod.supabase).not.toBeNull();
      await mod.supabase!.schema('app').rpc('is_owner');
      expect(fetchSpy).toHaveBeenCalled();
      const init = fetchSpy.mock.calls[0]?.[1];
      expect(init?.cache).toBe('no-store');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
