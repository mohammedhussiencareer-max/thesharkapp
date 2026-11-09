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
  type AccountingOrderRef,
  type AccountingRun,
  type FailureReport,
  type NextWork,
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

const orderA: AccountingOrderRef = { orderId: 'order-a', workGeneration: 1 };
const orderB: AccountingOrderRef = { orderId: 'order-b', workGeneration: 3 };
const orderC: AccountingOrderRef = { orderId: 'order-c', workGeneration: 2 };

type Script = Array<AccountingRun | Error>;

function fakeDb(
  script: Script,
  report: FailureReport | Error = 'recorded',
  peek: NextWork | Error = { status: 'ok', head: orderA },
) {
  const runs: Array<{
    attemptId: string;
    limit: number;
    binding: AccountingOrderRef | null;
  }> = [];
  const reports: Array<{
    attemptId: string;
    orderId: string;
    generation: number;
  }> = [];
  const queue = [...script];
  const db: AccountingDb = {
    async getNextWork() {
      if (peek instanceof Error) {
        throw peek;
      }
      return peek;
    },
    async runAccountingWork(attemptId, limit, binding) {
      runs.push({ attemptId, limit, binding });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('script exhausted');
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
    async recordAccountingCallFailure(attemptId, orderId, generation) {
      reports.push({ attemptId, orderId, generation });
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
  it('sends one order a call', () => {
    expect(DRAIN_BATCH_LIMIT).toBe(1);
  });

  it('stops at once when nothing is queued, still asking the worker once', async () => {
    const { db, runs, reports } = fakeDb([run('empty')], 'recorded', {
      status: 'empty',
      head: null,
    });
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('empty');
    expect(outcome.calls).toBe(1);
    expect(runs).toEqual([
      {
        attemptId: '00000000-0000-4000-8000-000000000001',
        limit: 1,
        binding: null,
      },
    ]);
    expect(reports).toEqual([]);
  });

  it('stops before any worker call when the engine is not activated', async () => {
    const { db, runs } = fakeDb([], 'recorded', {
      status: 'not_activated',
      head: null,
    });
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('not_activated');
    expect(outcome.calls).toBe(0);
    expect(runs).toEqual([]);
  });

  it('stops without a worker call or a report when the peek fails', async () => {
    const { db, runs, reports } = fakeDb(
      [],
      'recorded',
      new SupabaseRpcError('Supabase RPC failed: network', 'network'),
    );
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('call_failed');
    expect(outcome.report).toBe('not_needed');
    expect(outcome.error).toBe('Supabase RPC failed: network');
    expect(runs).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('loops until empty, sums counts, uses a fresh attempt id and binds each call to the previous head', async () => {
    const { db, runs } = fakeDb([
      run('processed', { processed: 1, applied: 1, remaining: 3 }, orderB),
      run('processed', { processed: 1, unchanged: 1, remaining: 2 }, orderC),
      run('processed', { processed: 1, none: 1, remaining: 0 }),
      run('empty'),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('empty');
    expect(outcome.calls).toBe(4);
    expect(outcome.counts).toMatchObject({
      processed: 3,
      applied: 1,
      unchanged: 1,
      none: 1,
      remaining: 0,
    });
    expect(new Set(runs.map((call) => call.attemptId)).size).toBe(4);
    expect(runs.map((call) => call.binding)).toEqual([
      orderA,
      orderB,
      orderC,
      null,
    ]);
    expect(runs.every((call) => call.limit === 1)).toBe(true);
  });

  it.each(['busy', 'sync_running', 'not_activated'] as const)(
    'stops without a report on %s',
    async (status) => {
      const { db, reports } = fakeDb([
        run('processed', { processed: 1, remaining: 3 }, orderB),
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

  it('rebinds to the real head when the worker answers stale, without counting it', async () => {
    const { db, runs } = fakeDb([
      run('stale', {}, orderB),
      run('processed', { processed: 1, applied: 1, remaining: 0 }),
      run('empty'),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('empty');
    expect(outcome.calls).toBe(3);
    expect(outcome.counts).toMatchObject({ processed: 1, applied: 1 });
    expect(runs.map((call) => call.binding)).toEqual([orderA, orderB, null]);
  });

  it('gives up after repeated stale answers, without a report', async () => {
    const { db, runs, reports } = fakeDb([
      run('stale', {}, orderB),
      run('stale', {}, orderC),
      run('stale', {}, orderB),
      run('stale', {}, orderC),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('stale');
    expect(outcome.calls).toBe(4);
    expect(outcome.report).toBeNull();
    expect(runs).toHaveLength(4);
    expect(reports).toEqual([]);
  });

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

  it('stops when the order failed inside the call, without reporting', async () => {
    const { db, reports } = fakeDb([
      run('processed', { processed: 0, failed: 1, remaining: 5 }, orderA),
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
        run('processed', { processed: 1, remaining: 9 }, orderB),
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

  it('reports an escaped failure with the same attempt id, naming only the bound order', async () => {
    const timeout = new SupabaseRpcError(
      'Supabase RPC failed: network',
      'network',
    );
    const { db, runs, reports } = fakeDb(
      [
        run(
          'processed',
          { processed: 1, remaining: 3 },
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
    expect(reports).toEqual([
      {
        attemptId: runs[1]?.attemptId,
        orderId: 'order-next',
        generation: 4,
      },
    ]);
  });

  it('reports a server error on the first call against the order the peek named', async () => {
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
      {
        attemptId: runs[0]?.attemptId,
        orderId: 'order-a',
        generation: 1,
      },
    ]);
  });

  it('makes no report when the failed call was bound to no order', async () => {
    const { db, reports } = fakeDb(
      [new SupabaseRpcError('Supabase RPC failed: network', 'network')],
      'recorded',
      { status: 'empty', head: null },
    );
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('call_failed');
    expect(outcome.report).toBe('not_needed');
    expect(reports).toEqual([]);
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
