import { join } from 'node:path';
import { loadEnv } from 'vite';

const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

const webRoot = join(import.meta.dirname, '..');

export function isLoopbackHost(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  return localHosts.has(hostname);
}

/** Throws unless `url` points at a loopback host. Call this before any admin request. */
export function assertLocalSupabaseUrl(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`Refusing non-local Supabase URL: ${url}`);
  }
  if (!isLoopbackHost(hostname)) {
    throw new Error(`Refusing non-local Supabase URL: ${url}`);
  }
}

/**
 * `VITE_*` values a `--mode development` Vite build bakes in.
 * Process environment wins, then `.env.development.local`, `.env.development`,
 * `.env.local`, and `.env` — the same order Vite uses.
 */
export function developmentPublicEnv(envDir = webRoot): Record<string, string> {
  return loadEnv('development', envDir, 'VITE_');
}

export function developmentSupabaseUrl(envDir = webRoot): string {
  return developmentPublicEnv(envDir).VITE_SUPABASE_URL ?? '';
}

/**
 * True when a browser request must be aborted.
 * Non-HTTP(S) URLs (data, blob) are left alone. http(s) and ws(s) must be loopback.
 */
export function isBlockedRemoteUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'ws:' &&
    parsed.protocol !== 'wss:'
  ) {
    return false;
  }
  return !isLoopbackHost(parsed.hostname);
}

type GuardedPage = {
  route(
    url: string,
    handler: (route: {
      request(): { url(): string };
      abort(errorCode?: string): Promise<unknown>;
      continue(): Promise<unknown>;
    }) => Promise<unknown> | void,
  ): Promise<unknown>;
  // page.route does not see WebSockets; Playwright routes them separately.
  routeWebSocket(
    url: string,
    handler: (ws: {
      url(): string;
      close(options?: { code?: number; reason?: string }): Promise<unknown>;
      connectToServer(): unknown;
    }) => Promise<unknown> | void,
  ): Promise<unknown>;
};

/** Abort every non-loopback request and WebSocket for the life of the page. */
export async function installLoopbackGuard(page: GuardedPage): Promise<void> {
  await page.route('**/*', async (route) => {
    if (isBlockedRemoteUrl(route.request().url())) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.routeWebSocket('**/*', async (ws) => {
    if (isBlockedRemoteUrl(ws.url())) {
      // Never connected to the remote server; the page sees a closed socket.
      await ws.close({
        code: 1008,
        reason: 'blocked by the e2e loopback guard',
      });
      return;
    }
    ws.connectToServer();
  });
}
