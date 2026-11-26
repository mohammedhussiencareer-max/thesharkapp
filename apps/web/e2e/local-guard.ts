import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { loadEnv } from 'vite';

const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
// Disable Chromium's implicit bypass rules (which include link-local IPs like
// 169.254.0.0/16 and [fe80::]/10) first with `<-loopback>`, then explicitly
// allow only the intended loopback hosts.
export const LOOPBACK_PROXY_BYPASS = '<-loopback>,127.0.0.1,localhost,[::1]';

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

type GuardedTarget = {
  route(
    url: string,
    handler: (route: {
      request(): { url(): string };
      abort(errorCode?: string): Promise<unknown>;
      continue(): Promise<unknown>;
    }) => Promise<unknown> | void,
  ): Promise<unknown>;
  // route does not see WebSockets; Playwright routes them separately.
  routeWebSocket(
    url: string,
    handler: (ws: {
      url(): string;
      close(options?: { code?: number; reason?: string }): Promise<unknown>;
      connectToServer(): unknown;
    }) => Promise<unknown> | void,
  ): Promise<unknown>;
};

/** Abort every non-loopback request and WebSocket for the life of the context or page. */
export async function installLoopbackGuard(
  target: GuardedTarget,
): Promise<void> {
  await target.route('**/*', async (route) => {
    if (isBlockedRemoteUrl(route.request().url())) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await target.routeWebSocket('**/*', async (ws) => {
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

export type LoopbackOnlyProxy = {
  proxyConfig: {
    server: string;
    bypass: string;
  };
  blockedRequests: string[];
  close: () => Promise<void>;
};

/**
 * Starts a loopback-bound proxy that refuses every proxied request without
 * opening any outbound connection. Paired with `bypass: LOOPBACK_PROXY_BYPASS`,
 * loopback traffic goes directly to localhost with Chromium's real HTTP cache
 * enabled (no `context.route()` interception), while every non-loopback HTTP,
 * HTTPS, or WebSocket request is rejected.
 */
export async function createLoopbackOnlyProxy(): Promise<LoopbackOnlyProxy> {
  const blockedRequests: string[] = [];
  const server = createServer((req, res) => {
    blockedRequests.push(req.url ?? req.headers.host ?? 'unknown');
    res.writeHead(403, {
      'content-type': 'text/plain',
      connection: 'close',
    });
    res.end('blocked by e2e loopback-only proxy');
  });
  server.on('connect', (req, socket) => {
    blockedRequests.push(`CONNECT ${req.url ?? 'unknown'}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    proxyConfig: {
      server: `http://127.0.0.1:${String(address.port)}`,
      bypass: LOOPBACK_PROXY_BYPASS,
    },
    blockedRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
