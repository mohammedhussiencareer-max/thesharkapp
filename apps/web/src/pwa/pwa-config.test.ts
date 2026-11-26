// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlugins, isPwaEnabled, pwaOptions } from '../../vite.config';

function pluginNames(env: Record<string, string | undefined>): string[] {
  return buildPlugins(env)
    .flat()
    .flatMap((plugin) =>
      plugin &&
      typeof plugin === 'object' &&
      'name' in plugin &&
      typeof plugin.name === 'string'
        ? [plugin.name]
        : [],
    );
}

describe('PWA Vite configuration', () => {
  it('enables PWA plugin with Arabic RTL standalone manifest when VITE_PWA is not 0', () => {
    expect(isPwaEnabled({})).toBe(true);
    expect(isPwaEnabled({ VITE_PWA: '1' })).toBe(true);
    expect(
      pluginNames({}).some((name) => name.includes('vite-plugin-pwa')),
    ).toBe(true);

    const manifest = pwaOptions.manifest;
    expect(manifest).toBeTruthy();
    if (!manifest || typeof manifest === 'boolean') {
      throw new Error('Expected manifest object');
    }
    expect(manifest.lang).toBe('ar');
    expect(manifest.dir).toBe('rtl');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(pwaOptions.registerType).toBe('prompt');
  });

  it('keeps all Supabase calls network-only with no Background Sync', () => {
    const workbox = pwaOptions.workbox;
    expect(workbox?.skipWaiting).toBe(false);
    expect(workbox?.clientsClaim).toBe(false);
    const rules = workbox?.runtimeCaching ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.handler).toBe('NetworkOnly');
      expect(rule.options?.backgroundSync).toBeUndefined();
      expect(rule.options?.fetchOptions?.cache).toBe('no-store');
    }
    const matcher = rules[0]?.urlPattern;
    expect(typeof matcher).toBe('function');
    if (typeof matcher === 'function') {
      const matchFn = matcher as (ctx: {
        url: URL;
        sameOrigin: boolean;
      }) => boolean;
      expect(
        matchFn({
          url: new URL('https://example.supabase.co/rest/v1/rpc/record_count'),
          sameOrigin: false,
        }),
      ).toBe(true);
      expect(
        matchFn({
          url: new URL('http://127.0.0.1:4173/rest/v1/stock_items'),
          sameOrigin: true,
        }),
      ).toBe(true);
      expect(
        matchFn({
          url: new URL('http://127.0.0.1:4173/assets/index.js'),
          sameOrigin: true,
        }),
      ).toBe(false);
    }
  });

  it('omits the PWA plugin completely when VITE_PWA=0', () => {
    expect(isPwaEnabled({ VITE_PWA: '0' })).toBe(false);
    const names = pluginNames({ VITE_PWA: '0' });
    expect(names.some((name) => name.includes('pwa'))).toBe(false);
  });

  it('does not follow redirects when forwarding the count write in the mobile smoke test', () => {
    const mobileSpec = readFileSync(
      resolve(import.meta.dirname, '../../e2e/mobile-pwa.spec.ts'),
      'utf8',
    );
    expect(mobileSpec).toMatch(
      /const upstream = await route\.fetch\(\{\s*maxRedirects:\s*0\s*,?\s*\}\)/,
    );
  });

  it('uses one guarded client with redirects disabled for both mobile count helpers', () => {
    const mobileSpec = readFileSync(
      resolve(import.meta.dirname, '../../e2e/mobile-pwa.spec.ts'),
      'utf8',
    );
    expect(mobileSpec.match(/createClient<Database>\(/g)).toHaveLength(1);
    expect(mobileSpec).toMatch(
      /fetch\(input,\s*\{\s*\.\.\.init,\s*redirect:\s*'error'/,
    );
    expect(mobileSpec).toContain(
      'const client = createLocalCountClient(apiUrl)',
    );
    expect(mobileSpec).toContain(
      'const verifyClient = createLocalCountClient(supabaseUrl)',
    );
  });

  it('runs the mobile browser smoke spec behind the loopback-only proxy', () => {
    const mobileSpec = readFileSync(
      resolve(import.meta.dirname, '../../e2e/mobile-pwa.spec.ts'),
      'utf8',
    );
    expect(mobileSpec).toMatch(
      /test\.use\(\{(?:[^{}]|\{[^{}]*\})*?\bloopbackGuardMode:\s*'proxy'/,
    );
  });

  it('builds the desktop Tauri frontend with VITE_PWA=0 and keeps detectSessionInUrl false', () => {
    const tauriConf = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../../desktop/src-tauri/tauri.conf.json',
        ),
        'utf8',
      ),
    ) as { build?: { beforeBuildCommand?: string } };
    expect(tauriConf.build?.beforeBuildCommand).toContain('build:desktop');

    const desktopBuildScript = readFileSync(
      resolve(import.meta.dirname, '../../scripts/build-desktop.mjs'),
      'utf8',
    );
    expect(desktopBuildScript).toContain("VITE_PWA: '0'");

    const supabaseSource = readFileSync(
      resolve(import.meta.dirname, '../lib/supabase.ts'),
      'utf8',
    );
    expect(supabaseSource).toContain('detectSessionInUrl: false');
  });
});
