import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertLocalSupabaseUrl } from './local-guard';

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
  });
});

describe('database seed', () => {
  it('creates no users and holds no credentials', () => {
    const seed = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../supabase/seed.sql',
      ),
      'utf8',
    );
    expect(seed.toLowerCase()).not.toMatch(/\binsert\b/);
    expect(seed).not.toContain('LocalOwner1234');
    expect(seed).not.toContain('owner@theshark.test');
    expect(seed).not.toContain('auth.users');
    expect(seed).not.toContain('auth.identities');
  });
});
