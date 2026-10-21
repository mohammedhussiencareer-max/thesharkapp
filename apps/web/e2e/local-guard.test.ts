import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalSupabaseUrl,
  developmentSupabaseUrl,
  installLoopbackGuard,
  isBlockedRemoteUrl,
} from './local-guard';

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

describe('development Supabase URL', () => {
  const dirs: string[] = [];
  const previous = process.env.VITE_SUPABASE_URL;

  afterEach(() => {
    if (previous === undefined) delete process.env.VITE_SUPABASE_URL;
    else process.env.VITE_SUPABASE_URL = previous;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function envDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'shark-env-'));
    dirs.push(dir);
    for (const [name, url] of Object.entries(files)) {
      writeFileSync(join(dir, name), `VITE_SUPABASE_URL=${url}\n`);
    }
    return dir;
  }

  it('uses Vite order: process env, then mode local, mode, local, shared', () => {
    const dir = envDir({
      '.env': 'http://shared.example',
      '.env.local': 'http://local.example',
      '.env.development': 'http://mode.example',
      '.env.development.local': 'http://mode-local.example',
    });
    delete process.env.VITE_SUPABASE_URL;
    expect(developmentSupabaseUrl(dir)).toBe('http://mode-local.example');

    rmSync(join(dir, '.env.development.local'));
    expect(developmentSupabaseUrl(dir)).toBe('http://mode.example');

    rmSync(join(dir, '.env.development'));
    expect(developmentSupabaseUrl(dir)).toBe('http://local.example');

    rmSync(join(dir, '.env.local'));
    expect(developmentSupabaseUrl(dir)).toBe('http://shared.example');

    process.env.VITE_SUPABASE_URL = 'http://127.0.0.1:55421';
    expect(developmentSupabaseUrl(dir)).toBe('http://127.0.0.1:55421');
  });
});

describe('loopback route guard', () => {
  it('blocks remote http and websocket hosts and allows loopback', () => {
    expect(isBlockedRemoteUrl('https://abc.supabase.co/rest/v1/x')).toBe(true);
    expect(isBlockedRemoteUrl('http://127.0.0.1.evil.com/')).toBe(true);
    expect(isBlockedRemoteUrl('http://10.0.0.5:55421')).toBe(true);
    expect(isBlockedRemoteUrl('wss://abc.supabase.co/realtime')).toBe(true);
    expect(isBlockedRemoteUrl('http://127.0.0.1:4173/')).toBe(false);
    expect(isBlockedRemoteUrl('http://localhost:55421/rest')).toBe(false);
    expect(isBlockedRemoteUrl('http://[::1]:55421/rest')).toBe(false);
    expect(isBlockedRemoteUrl('data:text/plain,hi')).toBe(false);
  });

  it('aborts a remote route and continues a loopback route', async () => {
    const decisions: string[] = [];
    const routeFor = (url: string) => ({
      request: () => ({ url: () => url }),
      abort: () => {
        decisions.push(`abort ${url}`);
        return Promise.resolve();
      },
      continue: () => {
        decisions.push(`continue ${url}`);
        return Promise.resolve();
      },
    });
    await installLoopbackGuard({
      route: async (_pattern, handler) => {
        await handler(routeFor('https://abc.supabase.co/auth/v1/token'));
        await handler(routeFor('http://127.0.0.1:55421/rest/v1/stock_items'));
      },
    });
    expect(decisions).toEqual([
      'abort https://abc.supabase.co/auth/v1/token',
      'continue http://127.0.0.1:55421/rest/v1/stock_items',
    ]);
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
