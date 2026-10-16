import { describe, expect, it } from 'vitest';
import { localServiceRoleKey } from './local-supabase.ts';
import { createSupabaseDb } from './supabase-write.ts';
import type { IngestCounts } from './types.ts';

const counts: IngestCounts = {
  inserted: 1,
  updated: 0,
  unchanged: 2,
  stale: 0,
  missing: 0,
  shifts_upserted: 1,
  shifts_skipped: 0,
};

describe('createSupabaseDb', () => {
  it('refuses a hosted URL before fetching', () => {
    expect(() =>
      createSupabaseDb(
        'https://abc.supabase.co',
        localServiceRoleKey,
        async () => {
          throw new Error('fetch should not be called');
        },
      ),
    ).toThrow(/Refusing non-local Supabase URL/);
  });

  it('calls the app RPC profile and hides error bodies', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const db = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async (url, init) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        if (path.endsWith('/start_pos_sync_run')) {
          return new Response('4', { status: 200 });
        }
        if (path.endsWith('/ingest_pos_batch')) {
          return new Response(JSON.stringify(counts), { status: 200 });
        }
        return new Response(null, { status: 204 });
      },
    );
    await expect(db.startRun('recent')).resolves.toBe(4);
    await expect(db.ingest(4, [], [], null)).resolves.toEqual(counts);
    await expect(
      db.finishRun(4, 'ok', { read: 0 }, null),
    ).resolves.toBeUndefined();
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/rest/v1/rpc/start_pos_sync_run',
      '/rest/v1/rpc/ingest_pos_batch',
      '/rest/v1/rpc/finish_pos_sync_run',
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(call.init.redirect).toBe('error');
      expect(headers.get('Content-Profile')).toBe('app');
      expect(headers.get('Accept-Profile')).toBe('app');
      expect(headers.get('apikey')).toBe(localServiceRoleKey);
      expect(headers.get('Authorization')).toBe(
        `Bearer ${localServiceRoleKey}`,
      );
    }
    const ingest = calls[1]?.init.body;
    expect(typeof ingest).toBe('string');
    expect(ingest).toContain('"p_scope":null');

    const failing = createSupabaseDb(
      'http://127.0.0.1:55421',
      localServiceRoleKey,
      async () => {
        return new Response('pii-customer-name ya29.SECRET', { status: 500 });
      },
    );
    await expect(failing.startRun('recent')).rejects.toThrow(
      /^Supabase RPC failed: HTTP 500$/,
    );
  });
});
