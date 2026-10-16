import { describe, expect, it } from 'vitest';
import { main } from './cli.ts';
import type { SyncResult } from './sync.ts';

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

  it('logs counts and shift ids without the token', async () => {
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
      'pos sync ok mode=recent shift_ids=shift-test-1 read=2 inserted=1 updated=0 unchanged=1 stale=0 missing=0 shifts=1',
    ]);
    expect(logs.join('\n')).not.toContain('ya29');
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
        throw new Error('another POS sync is running');
      },
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors).toEqual(['pos sync failed: another POS sync is running']);
    expect(errors.join('\n')).not.toContain('ya29');
  });
});
