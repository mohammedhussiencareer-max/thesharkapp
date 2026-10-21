import { test as base, expect } from '@playwright/test';
import {
  assertLocalSupabaseUrl,
  developmentSupabaseUrl,
  installLoopbackGuard,
} from './local-guard';

/**
 * Every spec checks the Supabase URL the development build actually uses
 * before it runs, and refuses any later request whose host is not loopback.
 */
export const test = base.extend<{ supabaseUrl: string }>({
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
  page: async ({ page }, expose) => {
    await installLoopbackGuard(page);
    await expose(page);
  },
});

export { expect };
