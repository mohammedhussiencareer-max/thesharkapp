import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl } from './local-guard';

test.use({
  viewport: { width: 390, height: 844 },
  serviceWorkers: 'allow',
});

test('serves Arabic RTL manifest, registers shell-only service worker, and keeps Supabase calls network-only', async ({
  page,
  context,
  supabaseUrl,
}) => {
  assertLocalSupabaseUrl(supabaseUrl);

  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  const manifestResponse = await page.request.get('/manifest.webmanifest');
  expect(manifestResponse.status()).toBe(200);
  const manifest = (await manifestResponse.json()) as {
    lang?: string;
    dir?: string;
    display?: string;
    start_url?: string;
  };
  expect(manifest.lang).toBe('ar');
  expect(manifest.dir).toBe('rtl');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');

  // Wait for service worker registration when running a production preview bundle.
  const swReady = await page.evaluate<{
    supported: boolean;
    activeScriptUrl: string | null;
    cachedUrls: string[];
  }>(`(async () => {
    if (!('serviceWorker' in navigator)) {
      return { supported: false, activeScriptUrl: null, cachedUrls: [] };
    }
    const reg = await navigator.serviceWorker.ready;
    const cacheNames = await caches.keys();
    const cachedUrls = [];
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const req of keys) cachedUrls.push(req.url);
    }
    return {
      supported: true,
      activeScriptUrl: reg.active ? reg.active.scriptURL : null,
      cachedUrls,
    };
  })()`);

  expect(swReady.supported).toBe(true);
  expect(swReady.activeScriptUrl).toMatch(/\/sw\.js$/);
  expect(
    swReady.cachedUrls.some(
      (url) => url.includes('/rest/v1/') || url.includes('/auth/v1/'),
    ),
  ).toBe(false);

  // Confirm Supabase REST remains NetworkOnly when offline (never served from cache).
  await context.setOffline(true);
  try {
    const restUrl = new URL('/rest/v1/', supabaseUrl).toString();
    const offlineFetchFailed = await page.evaluate<boolean>(
      `fetch(${JSON.stringify(restUrl)}).then(() => false).catch(() => true)`,
    );
    expect(offlineFetchFailed).toBe(true);
  } finally {
    await context.setOffline(false);
  }
});
