import { describe, expect, it } from 'vitest';
import {
  drainAccountingWork,
  formatDrain,
  DRAIN_BATCH_LIMIT,
  DRAIN_BUDGET_MS,
} from './accounting-drain.ts';
import {
  SupabaseRpcError,
  zeroAccountingCounts,
  type AccountingDb,
  type AccountingRun,
  type FailureReport,
} from './supabase-write.ts';

function run(
  status: AccountingRun['status'],
  counts: Partial<AccountingRun['counts']> = {},
  head: AccountingRun['head'] = null,
  critical: AccountingRun['critical'] = null,
): AccountingRun {
  return {
    status,
    counts: { ...zeroAccountingCounts(), ...counts },
    head,
    critical,
  };
}

type Script = Array<AccountingRun | Error>;

function fakeDb(script: Script, report: FailureReport | Error = 'recorded') {
  const runs: Array<{ attemptId: string; limit: number }> = [];
  const reports: Array<{ attemptId: string; generation: number | null }> = [];
  const queue = [...script];
  const db: AccountingDb = {
    async runAccountingWork(attemptId, limit) {
      runs.push({ attemptId, limit });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('script exhausted');
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    async recordAccountingCallFailure(attemptId, generation) {
      reports.push({ attemptId, generation });
      if (report instanceof Error) {
        throw report;
      }
      return report;
    },
  };
  return { db, runs, reports };
}

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

describe('drainAccountingWork', () => {
  it('stops at once when nothing is queued', async () => {
    const { db, runs, reports } = fakeDb([run('empty')]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('empty');
    expect(outcome.calls).toBe(1);
    expect(runs).toEqual([
      {
        attemptId: '00000000-0000-4000-8000-000000000001',
        limit: DRAIN_BATCH_LIMIT,
      },
    ]);
    expect(reports).toEqual([]);
  });

  it('loops until empty, sums counts and uses a fresh attempt id per call', async () => {
    const { db, runs } = fakeDb([
      run(
        'processed',
        { processed: 5, applied: 4, unchanged: 1, remaining: 7 },
        {
          orderId: 'order-a',
          workGeneration: 1,
        },
      ),
      run('processed', { processed: 5, applied: 5, remaining: 2 }),
      run('processed', { processed: 2, none: 2, remaining: 0 }),
      run('empty'),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('empty');
    expect(outcome.calls).toBe(4);
    expect(outcome.counts).toMatchObject({
      processed: 12,
      applied: 9,
      unchanged: 1,
      none: 2,
      remaining: 0,
    });
    expect(new Set(runs.map((call) => call.attemptId)).size).toBe(4);
  });

  it.each(['busy', 'sync_running', 'not_activated'] as const)(
    'stops without a report on %s',
    async (status) => {
      const { db, reports } = fakeDb([
        run('processed', { processed: 1, remaining: 3 }),
        run(status),
      ]);
      const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
      expect(outcome.stop).toBe(status);
      expect(outcome.calls).toBe(2);
      expect(outcome.counts.processed).toBe(1);
      expect(outcome.report).toBeNull();
      expect(reports).toEqual([]);
    },
  );

  it('stops on critical and names the order', async () => {
    const { db } = fakeDb([
      run('critical', { failed: 1 }, null, {
        orderId: 'order-crit',
        workGeneration: 2,
      }),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('critical');
    expect(outcome.criticalOrderId).toBe('order-crit');
    expect(formatDrain(outcome)).toContain('critical_order=order-crit');
  });

  it('stops when an order failed inside the call, without reporting', async () => {
    const { db, reports } = fakeDb([
      run('processed', { processed: 2, failed: 1, remaining: 5 }),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('order_failed');
    expect(outcome.calls).toBe(1);
    expect(reports).toEqual([]);
  });

  it('stops at the time budget', async () => {
    let now = 0;
    const { db } = fakeDb(
      Array.from({ length: 10 }, () =>
        run('processed', { processed: 1, remaining: 9 }),
      ),
    );
    const outcome = await drainAccountingWork(db, {
      newAttemptId: ids(),
      clock: () => {
        now += 40_000;
        return now;
      },
    });
    expect(outcome.stop).toBe('budget');
    expect(outcome.calls).toBe(1);
    expect(DRAIN_BUDGET_MS).toBe(60_000);
  });

  it('reports an escaped failure with the same attempt id and the last head generation', async () => {
    const timeout = new SupabaseRpcError(
      'Supabase RPC failed: network',
      'network',
    );
    const { db, runs, reports } = fakeDb(
      [
        run(
          'processed',
          { processed: 5, remaining: 3 },
          {
            orderId: 'order-next',
            workGeneration: 4,
          },
        ),
        timeout,
      ],
      'recorded',
    );
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('call_failed');
    expect(outcome.report).toBe('recorded');
    expect(outcome.error).toBe('Supabase RPC failed: network');
    expect(reports).toEqual([{ attemptId: runs[1]?.attemptId, generation: 4 }]);
  });

  it('reports a server error on the first call with no generation hint', async () => {
    const { db, runs, reports } = fakeDb(
      [
        new SupabaseRpcError(
          'Supabase RPC failed: HTTP 500',
          'http',
          500,
          '57014',
        ),
      ],
      'committed',
    );
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.report).toBe('committed');
    expect(reports).toEqual([
      { attemptId: runs[0]?.attemptId, generation: null },
    ]);
  });

  it('does not report a refused call', async () => {
    const { db, reports } = fakeDb([
      new SupabaseRpcError(
        'Supabase RPC failed: HTTP 400',
        'http',
        400,
        '22023',
      ),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('call_failed');
    expect(outcome.report).toBe('not_needed');
    expect(reports).toEqual([]);
  });

  it('keeps going to a clean stop when the report itself fails', async () => {
    const { db } = fakeDb(
      [new SupabaseRpcError('Supabase RPC failed: network', 'network')],
      new SupabaseRpcError('Supabase RPC failed: network', 'network'),
    );
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('call_failed');
    expect(outcome.report).toBe('unreported');
    expect(outcome.error).toBe(
      'Supabase RPC failed: network; Supabase RPC failed: network',
    );
  });

  it('redacts secrets from a reported error', async () => {
    const { db } = fakeDb([
      new SupabaseRpcError('boom Bearer ya29.SECRET-TOKEN', 'network'),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(formatDrain(outcome)).not.toContain('SECRET-TOKEN');
  });
});
