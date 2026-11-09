import { describe, expect, it } from 'vitest';
import type { PosSnapshot } from './read-pos.ts';
import { runPosSync } from './sync.ts';
import {
  SupabaseRpcError,
  zeroAccountingCounts,
  type AccountingDb,
  type AccountingRun,
  type NextWork,
  type PosDb,
} from './supabase-write.ts';
import type { IngestCounts } from './types.ts';

const emptySnapshot: PosSnapshot = {
  shifts: [],
  orders: [],
  scope: { shift_ids: [] },
  missingShiftIds: [],
};

function zeroIngest(): IngestCounts {
  return {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    missing: 0,
    shifts_upserted: 0,
    shifts_skipped: 0,
    transactions: 0,
  };
}

function posDb(events: string[]): PosDb {
  return {
    async startRun() {
      events.push('start');
      return 7;
    },
    async ingest() {
      events.push('ingest');
      return zeroIngest();
    },
    async finishRun(_runId, status) {
      events.push(`finish:${status}`);
    },
  };
}

function idle(status: AccountingRun['status']): AccountingRun {
  return { status, counts: zeroAccountingCounts(), head: null, critical: null };
}

async function nobody(): Promise<NextWork> {
  return { status: 'empty', head: null };
}

async function someone(): Promise<NextWork> {
  return { status: 'ok', head: { orderId: 'order-a', workGeneration: 1 } };
}

function run(input: {
  db: PosDb;
  accountingDb?: AccountingDb;
  logs?: string[];
}) {
  return runPosSync({
    mode: 'recent',
    supabaseUrl: 'http://127.0.0.1:55421',
    serviceRoleKey: 'local-test-key',
    reader: {
      async read() {
        return emptySnapshot;
      },
    },
    db: input.db,
    ...(input.accountingDb === undefined
      ? {}
      : { accountingDb: input.accountingDb }),
    logger: (line) => input.logs?.push(line),
  });
}

describe('runPosSync accounting drain', () => {
  it('drains after the run is finished as ok', async () => {
    const events: string[] = [];
    const logs: string[] = [];
    const result = await run({
      db: posDb(events),
      logs,
      accountingDb: {
        getNextWork: nobody,
        async runAccountingWork() {
          events.push('drain');
          return idle('empty');
        },
        async recordAccountingCallFailure() {
          events.push('record');
          return 'recorded';
        },
      },
    });
    expect(events).toEqual(['start', 'ingest', 'finish:ok', 'drain']);
    expect(result.mode).toBe('recent');
    expect(logs.at(-1)).toMatch(/^accounting drain stop=empty calls=1 /);
  });

  it('does nothing extra when no accounting client is given', async () => {
    const events: string[] = [];
    await run({ db: posDb(events) });
    expect(events).toEqual(['start', 'ingest', 'finish:ok']);
  });

  it('reports busy and does not mark the sync failed', async () => {
    const events: string[] = [];
    const logs: string[] = [];
    await run({
      db: posDb(events),
      logs,
      accountingDb: {
        getNextWork: someone,
        async runAccountingWork() {
          return idle('busy');
        },
        async recordAccountingCallFailure() {
          throw new Error('must not be called');
        },
      },
    });
    expect(events).toEqual(['start', 'ingest', 'finish:ok']);
    expect(logs.at(-1)).toMatch(/^accounting drain stop=busy /);
  });

  it('never marks the sync failed when the drain call fails', async () => {
    const events: string[] = [];
    const logs: string[] = [];
    const reported: Array<[string, string, number]> = [];
    const result = await run({
      db: posDb(events),
      logs,
      accountingDb: {
        getNextWork: someone,
        async runAccountingWork() {
          throw new SupabaseRpcError(
            'Supabase RPC failed: HTTP 500',
            'http',
            500,
            '57014',
          );
        },
        async recordAccountingCallFailure(attemptId, orderId, generation) {
          reported.push([attemptId, orderId, generation]);
          return 'recorded';
        },
      },
    });
    expect(events).toEqual(['start', 'ingest', 'finish:ok']);
    expect(result.shiftIds).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.slice(1)).toEqual(['order-a', 1]);
    expect(logs.at(-1)).toMatch(
      /^accounting drain stop=call_failed .* report=recorded error=Supabase RPC failed: HTTP 500$/,
    );
  });

  it('survives a failing report and a throwing logger', async () => {
    const events: string[] = [];
    const result = await runPosSync({
      mode: 'recent',
      supabaseUrl: 'http://127.0.0.1:55421',
      serviceRoleKey: 'local-test-key',
      reader: {
        async read() {
          return emptySnapshot;
        },
      },
      db: posDb(events),
      accountingDb: {
        getNextWork: someone,
        async runAccountingWork() {
          throw new SupabaseRpcError('Supabase RPC failed: network', 'network');
        },
        async recordAccountingCallFailure() {
          throw new SupabaseRpcError('Supabase RPC failed: network', 'network');
        },
      },
      logger: (line) => {
        if (line.startsWith('accounting drain')) {
          throw new Error('stdout closed');
        }
      },
    });
    expect(events).toEqual(['start', 'ingest', 'finish:ok']);
    expect(result.counts.read).toBe(0);
  });

  it('does not drain when the sync itself fails', async () => {
    const events: string[] = [];
    const db = posDb(events);
    db.ingest = async () => {
      throw new Error('ingest broke');
    };
    let drained = false;
    await expect(
      runPosSync({
        mode: 'recent',
        supabaseUrl: 'http://127.0.0.1:55421',
        serviceRoleKey: 'local-test-key',
        reader: {
          async read() {
            return {
              ...emptySnapshot,
              shifts: [
                {
                  id: 'shift-1',
                  opened_at: '2026-10-15T09:00:00.000000Z',
                  closed_at: null,
                  is_active: true,
                  pos_update_time: '2026-10-15T18:00:00.000000Z',
                  drawer_cash_net: null,
                  drawer_credit: null,
                  transactions: [],
                },
              ],
            };
          },
        },
        db,
        accountingDb: {
          getNextWork: nobody,
          async runAccountingWork() {
            drained = true;
            return idle('empty');
          },
          async recordAccountingCallFailure() {
            return 'recorded';
          },
        },
      }),
    ).rejects.toThrow('ingest broke');
    expect(events).toEqual(['start', 'finish:failed']);
    expect(drained).toBe(false);
  });
});
