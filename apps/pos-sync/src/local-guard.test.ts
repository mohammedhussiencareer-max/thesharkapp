import { describe, expect, it } from 'vitest';
import { assertLocalSupabaseUrl } from './local-guard.ts';

describe('assertLocalSupabaseUrl', () => {
  it('accepts loopback hosts', () => {
    expect(() =>
      assertLocalSupabaseUrl('http://127.0.0.1:55421'),
    ).not.toThrow();
    expect(() =>
      assertLocalSupabaseUrl('http://localhost:55421'),
    ).not.toThrow();
    expect(() => assertLocalSupabaseUrl('http://[::1]:55421')).not.toThrow();
  });

  it('rejects hosted and look-alike hosts', () => {
    expect(() => assertLocalSupabaseUrl('https://abc.supabase.co')).toThrow(
      /Refusing non-local/,
    );
    expect(() => assertLocalSupabaseUrl('http://127.0.0.1.evil.com')).toThrow(
      /Refusing non-local/,
    );
    expect(() => assertLocalSupabaseUrl('http://10.0.0.5:55421')).toThrow(
      /Refusing non-local/,
    );
    expect(() =>
      assertLocalSupabaseUrl('http://user:pass@127.0.0.1:55421'),
    ).toThrow(/Refusing non-local/);
    expect(() => assertLocalSupabaseUrl('http://127.0.0.1:55421/rest')).toThrow(
      /Refusing non-local/,
    );
    expect(() => assertLocalSupabaseUrl('ftp://127.0.0.1:55421')).toThrow(
      /Refusing non-local/,
    );
  });
});
