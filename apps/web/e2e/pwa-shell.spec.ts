import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import { assertLocalSupabaseUrl } from './local-guard';

test.use({
  viewport: { width: 390, height: 844 },
  serviceWorkers: 'allow',
  // Enforce loopback-only egress via a refusing proxy instead of context.route(),
  // which disables Chromium's HTTP cache and would mask missing `cache: 'no-store'`.
  loopbackGuardMode: 'proxy',
});

test('serves Arabic RTL manifest, registers shell-only service worker, and keeps Supabase calls network-only', async ({
  page,
  context,
  supabaseUrl,
}) => {
  assertLocalSupabaseUrl(supabaseUrl);

  // Serve real loopback cacheable responses in an unrouted browser context:
  // 1) `/cache-control-check` BEFORE SW control proves Chromium's HTTP cache is
  //    genuinely active (second fetch hits HTTP cache, not the server).
  // 2) `/rest/v1/pwa_network_only_probe` AFTER SW control proves Workbox's
  //    `NetworkOnly` + `cache: 'no-store'` bypasses that active HTTP cache
  //    (hitting the loopback server twice), stays out of Cache Storage, and
  //    fails offline while the cached app shell still loads.
  let cacheCheckHits = 0;
  let networkHits = 0;
  const probeServer = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': '*',
      });
      res.end();
      return;
    }
    if (req.url === '/cache-control-check') {
      cacheCheckHits += 1;
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600',
      });
      res.end(JSON.stringify({ ok: true, hit: cacheCheckHits }));
      return;
    }
    networkHits += 1;
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    });
    res.end(JSON.stringify({ ok: true, hit: networkHits }));
  });
  await new Promise<void>((resolve) => {
    probeServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probeServer.address() as AddressInfo;
  const cacheControlCheckUrl = `http://127.0.0.1:${String(address.port)}/cache-control-check`;
  const restProbeUrl = `http://127.0.0.1:${String(address.port)}/rest/v1/pwa_network_only_probe`;

  try {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // Positive control while the page is still uncontrolled by the service worker:
    // proves Chromium's HTTP cache is enabled in this unrouted context (so removing
    // `cache: 'no-store'` from the SW/client would make the probe below fail).
    const preSwCacheControl = await page.evaluate<{
      controlled: boolean;
      first: { ok: boolean; status: number; hit: number };
      second: { ok: boolean; status: number; hit: number };
      remoteBlocked: boolean;
    }>(`(async () => {
      const url = ${JSON.stringify(cacheControlCheckUrl)};
      const first = await fetch(url).then(async (res) => ({
        ok: res.ok,
        status: res.status,
        hit: (await res.json()).hit,
      }));
      const second = await fetch(url).then(async (res) => ({
        ok: res.ok,
        status: res.status,
        hit: (await res.json()).hit,
      }));
      const remoteBlocked = await fetch('https://example.invalid/blocked-probe')
        .then(() => false)
        .catch(() => true);
      return {
        controlled: navigator.serviceWorker?.controller !== null,
        first,
        second,
        remoteBlocked,
      };
    })()`);
    expect(preSwCacheControl.controlled).toBe(false);
    expect(preSwCacheControl.first).toEqual({ ok: true, status: 200, hit: 1 });
    expect(preSwCacheControl.second).toEqual({ ok: true, status: 200, hit: 1 });
    expect(cacheCheckHits).toBe(1);
    expect(preSwCacheControl.remoteBlocked).toBe(true);

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

    const firstFetch = await page.evaluate<{
      ok: boolean;
      status: number;
      hit: number;
    }>(
      `fetch(${JSON.stringify(restProbeUrl)}).then(async (res) => ({ ok: res.ok, status: res.status, hit: (await res.json()).hit }))`,
    );
    expect(firstFetch).toEqual({ ok: true, status: 200, hit: 1 });
    expect(networkHits).toBe(1);

    // Second online read against the Cache-Control: max-age=3600 endpoint MUST
    // still hit the loopback server (proving cache: 'no-store' bypasses the
    // proven-active browser HTTP cache).
    const secondFetch = await page.evaluate<{
      ok: boolean;
      status: number;
      hit: number;
    }>(
      `fetch(${JSON.stringify(restProbeUrl)}).then(async (res) => ({ ok: res.ok, status: res.status, hit: (await res.json()).hit }))`,
    );
    expect(secondFetch).toEqual({ ok: true, status: 200, hit: 2 });
    expect(networkHits).toBe(2);

    await context.setOffline(true);
    try {
      // Loopback API read MUST fail offline (never served from SW cache or HTTP cache).
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
    }
  } finally {
    await new Promise<void>((resolve) => {
      probeServer.close(() => resolve());
    });
  }
});
