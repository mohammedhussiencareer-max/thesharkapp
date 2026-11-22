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

  // Wait for service worker activation, then reload so the page is actively
  // controlled by the service worker (`navigator.serviceWorker.controller !== null`).
  const registered = await page.evaluate<boolean>(`(async () => {
    if (!('serviceWorker' in navigator)) return false;
    await navigator.serviceWorker.ready;
    return true;
  })()`);
  expect(registered).toBe(true);

  await page.reload();

  const swState = await page.evaluate<{
    controlled: boolean;
    activeScriptUrl: string | null;
    cachedUrls: string[];
  }>(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    const cacheNames = await caches.keys();
    const cachedUrls = [];
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const req of keys) cachedUrls.push(req.url);
    }
    return {
      controlled: navigator.serviceWorker.controller !== null,
      activeScriptUrl: reg.active ? reg.active.scriptURL : null,
      cachedUrls,
    };
  })()`);

  expect(swState.controlled).toBe(true);
  expect(swState.activeScriptUrl).toMatch(/\/sw\.js$/);
  expect(
    swState.cachedUrls.some(
      (url) => url.includes('/rest/v1/') || url.includes('/auth/v1/'),
    ),
  ).toBe(false);

  // Intercept the loopback Supabase REST path at the browser context level
  // (covering service-worker-owned requests too) and prove it succeeds online,
  // is NOT cached by the service worker, and FAILS offline while the cached
  // app shell still loads.
  const restProbeUrl = new URL(
    '/rest/v1/pwa_network_only_probe',
    supabaseUrl,
  ).toString();
  let networkHits = 0;
  await context.route(restProbeUrl, async (route) => {
    networkHits += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600',
      },
      body: JSON.stringify({ ok: true }),
    });
  });

  const onlineFetch = await page.evaluate<{ ok: boolean; status: number }>(
    `fetch(${JSON.stringify(restProbeUrl)}).then((res) => ({ ok: res.ok, status: res.status }))`,
  );
  expect(onlineFetch.ok).toBe(true);
  expect(onlineFetch.status).toBe(200);
  expect(networkHits).toBe(1);

  await context.setOffline(true);
  try {
    // Loopback API read MUST fail offline (proving NetworkOnly, never served from SW cache).
    const offlineFetchFailed = await page.evaluate<boolean>(
      `fetch(${JSON.stringify(restProbeUrl)}).then(() => false).catch(() => true)`,
    );
    expect(offlineFetchFailed).toBe(true);

    // Cached shell navigation MUST still load while offline.
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  } finally {
    await context.setOffline(false);
    await context.unroute(restProbeUrl);
  }
});
