import { test as base, expect } from '@playwright/test';
import {
  assertLocalSupabaseUrl,
  createLoopbackOnlyProxy,
  developmentSupabaseUrl,
  installLoopbackGuard,
} from './local-guard';

/**
 * Every spec checks the Supabase URL the development build actually uses
 * before it runs, and refuses any later request whose host is not loopback.
 *
 * Specs that exercise real browser HTTP caching set `loopbackGuardMode: 'proxy'`
 * so non-loopback egress is refused by a local proxy instead of `context.route()`,
 * which disables Chromium's HTTP cache.
 */
export const test = base.extend<{
  supabaseUrl: string;
  loopbackGuardMode: 'route' | 'proxy';
}>({
  supabaseUrl: [
    // Reads the Vite development env; it does not use a Playwright fixture.
    // eslint-disable-next-line no-empty-pattern
    async ({}, expose) => {
      const url = developmentSupabaseUrl();
      assertLocalSupabaseUrl(url);
      await expose(url);
    },
    { auto: true },
  ],
  loopbackGuardMode: ['route', { option: true }],
  proxy: async ({ proxy, loopbackGuardMode }, expose) => {
    if (loopbackGuardMode !== 'proxy') {
      await expose(proxy);
      return;
    }
    const guardProxy = await createLoopbackOnlyProxy();
    try {
      await expose(guardProxy.proxyConfig);
    } finally {
      await guardProxy.close();
    }
  },
  context: async ({ context, loopbackGuardMode }, expose) => {
    if (loopbackGuardMode === 'route') {
      await installLoopbackGuard(context);
    }
    await expose(context);
  },
});

export { expect };
