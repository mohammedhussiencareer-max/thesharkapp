import { describe, expect, it } from 'vitest';
import { main } from './cli.ts';
import { PosSyncError } from './safe-error.ts';
import { runPosSync, type SyncResult } from './sync.ts';
import { SupabaseRpcError } from './supabase-write.ts';

const result: SyncResult = {
  mode: 'recent',
  shiftIds: ['shift-test-1'],
  counts: {
    read: 2,
    inserted: 1,
    updated: 0,
    unchanged: 1,
    stale: 0,
    missing: 0,
    shifts_upserted: 1,
    shifts_skipped: 0,
    transactions: 0,
  },
};

describe('main', () => {
  it('parses arguments before requesting a token', async () => {
    let loaded = 0;
    const errors: string[] = [];
    const code = await main({
      argv: ['--mode', 'ya29.SECRET'],
      env: {},
      loadToken: async () => {
        loaded += 1;
        return 'ya29.SECRET';
      },
      runSync: async () => result,
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(loaded).toBe(0);
    expect(errors).toEqual(['pos sync failed: Unknown mode']);
  });

  it('logs shift counts without shift ids or the token', async () => {
    const logs: string[] = [];
    const code = await main({
      argv: ['--mode', 'recent'],
      env: { POS_SUPABASE_URL: 'http://127.0.0.1:55421' },
      loadToken: async () => 'ya29.SECRET',
      runSync: async (input) => {
        expect(input.token).toBe('ya29.SECRET');
        expect(input.supabaseUrl).toBe('http://127.0.0.1:55421');
        return result;
      },
      log: (line) => logs.push(line),
      error: () => {
        throw new Error('should not log an error');
      },
    });
    expect(code).toBe(0);
    expect(logs).toEqual([
      'pos sync ok mode=recent shifts_read=1 read=2 inserted=1 updated=0 unchanged=1 stale=0 missing=0 shifts=1',
    ]);
    expect(logs.join('\n')).not.toContain('ya29');
  });

  it.each([
    ['when the failed run is saved', false, ''],
    [
      'when saving the failed run also fails',
      true,
      '; Supabase RPC failed: HTTP 503 08006',
    ],
  ] as const)(
    'keeps RPC diagnostics on stderr %s',
    async (_case, failFinish, suffix) => {
      const errors: string[] = [];
      const finished: Array<[string, string | null]> = [];
      const marker = 'SyntheticMarker7f3a';
      const code = await main({
        argv: ['--mode', 'recent'],
        env: { POS_SUPABASE_SERVICE_ROLE_KEY: 'local-test-key' },
        loadToken: async () => 'test-token',
        runSync: ({ mode, supabaseUrl, serviceRoleKey }) =>
          runPosSync({
            mode,
            supabaseUrl,
            serviceRoleKey,
            reader: {
              async read() {
                return {
                  shifts: [],
                  orders: [],
                  scope: { shift_ids: [] },
                  missingShiftIds: [],
                };
              },
            },
            db: {
              async startRun() {
                return 9;
              },
              async ingest() {
                throw Object.assign(
                  new SupabaseRpcError('http', 400, '23505'),
                  { message: marker },
                );
              },
              async finishRun(_runId, status, _counts, error) {
                finished.push([status, error]);
                if (failFinish)
                  throw Object.assign(
                    new SupabaseRpcError('http', 503, '08006'),
                    { message: marker },
                  );
              },
            },
          }),
        log: () => undefined,
        error: (line) => errors.push(line),
      });
      expect(code).toBe(1);
      expect(finished).toEqual([
        ['failed', 'Supabase RPC failed: HTTP 400 23505'],
      ]);
      expect(errors.join('\n')).not.toContain(marker);
      expect(errors).toEqual([
        `pos sync failed: Supabase RPC failed: HTTP 400 23505${suffix}`,
      ]);
    },
  );

  it('drops arbitrary dependency errors from stderr', async () => {
    const marker = 'SyntheticMarker7f3a';
    const errors: string[] = [];
    const code = await main({
      argv: [],
      env: {},
      loadToken: async () => {
        throw new Error(`unexpected ${marker}`);
      },
      runSync: async () => result,
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors).toEqual(['pos sync failed: sync failed']);
  });

  it('refuses a hosted URL before requesting a token', async () => {
    let loaded = 0;
    const errors: string[] = [];
    const code = await main({
      argv: [],
      env: { POS_SUPABASE_URL: 'https://abc.supabase.co' },
      loadToken: async () => {
        loaded += 1;
        return 'ya29.SECRET';
      },
      runSync: async () => result,
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(loaded).toBe(0);
    expect(errors[0]).toContain('Refusing non-local');
    expect(errors.join('\n')).not.toContain('ya29');
  });

  it('prints when another POS sync is running', async () => {
    const errors: string[] = [];
    const code = await main({
      argv: ['--mode', 'recent'],
      env: { POS_SUPABASE_URL: 'http://127.0.0.1:55421' },
      loadToken: async () => 'ya29.SECRET',
      runSync: async () => {
        throw new PosSyncError('syncAlreadyRunning');
      },
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors).toEqual(['pos sync failed: another POS sync is running']);
    expect(errors.join('\n')).not.toContain('ya29');
  });
});
