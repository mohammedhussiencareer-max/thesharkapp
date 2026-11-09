import { describe, expect, it } from 'vitest';
import {
  drainAccountingWork,
  formatDrain,
  DRAIN_BATCH_LIMIT,
  DRAIN_BUDGET_MS,
  RECORDER_BACKOFF_MS,
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
  report: FailureReport | Error | Array<FailureReport | Error> = 'recorded',
  peek: NextWork | Error = { status: 'ok', head: orderA },
) {
  const replies = Array.isArray(report) ? [...report] : null;
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
      const reply = replies === null ? report : (replies.shift() ?? 'busy');
      if (reply instanceof Error) {
        throw reply;
      }
      if (Array.isArray(reply)) {
        throw new Error('unexpected report script');
      }
      return reply;
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

  it('treats an unbound call as maintenance: its head leads to a bound call and the drain still ends on empty', async () => {
    const { db, runs } = fakeDb(
      [
        run('processed', { remaining: 1 }, orderB),
        run('processed', { processed: 1, applied: 1, remaining: 0 }),
        run('empty'),
      ],
      'recorded',
      { status: 'empty', head: null },
    );
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('empty');
    expect(outcome.calls).toBe(3);
    expect(outcome.counts).toMatchObject({ processed: 1, applied: 1 });
    expect(runs.map((call) => call.binding)).toEqual([null, orderB, null]);
    expect(runs.every((call) => call.limit === 1)).toBe(true);
  });

  it('keeps making unbound calls while a span is still expanding, then ends on empty', async () => {
    const { db, runs } = fakeDb(
      [run('processed'), run('processed'), run('empty')],
      'recorded',
      { status: 'empty', head: null },
    );
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('empty');
    expect(outcome.calls).toBe(3);
    expect(runs.map((call) => call.binding)).toEqual([null, null, null]);
  });

  it('reports the order a maintenance call named when the bound call that processes it is lost', async () => {
    const { db, runs, reports } = fakeDb(
      [
        run('processed', { remaining: 1 }, orderC),
        new SupabaseRpcError('Supabase RPC failed: network', 'network'),
      ],
      'recorded',
      { status: 'empty', head: null },
    );
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(outcome.stop).toBe('call_failed');
    expect(outcome.report).toBe('recorded');
    expect(runs.map((call) => call.binding)).toEqual([null, orderC]);
    expect(reports).toEqual([
      {
        attemptId: runs[1]?.attemptId,
        orderId: 'order-c',
        generation: 2,
      },
    ]);
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

  it('makes no report when an unbound (maintenance) call fails, as it processed no order', async () => {
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

  describe('a failure report the ledger lock turns away', () => {
    const lost = new SupabaseRpcError(
      'Supabase RPC failed: network',
      'network',
    );

    function pauses(clockStart = 0) {
      let now = clockStart;
      const slept: number[] = [];
      return {
        slept,
        clock: () => now,
        sleep: async (ms: number) => {
          slept.push(ms);
          now += ms;
        },
      };
    }

    it('is repeated with the same attempt id after growing pauses until it is recorded', async () => {
      const { db, runs, reports } = fakeDb(
        [lost],
        ['busy', 'busy', 'recorded'],
      );
      const pace = pauses();
      const outcome = await drainAccountingWork(db, {
        newAttemptId: ids(),
        ...pace,
      });
      expect(outcome.stop).toBe('call_failed');
      expect(outcome.report).toBe('recorded');
      expect(outcome.calls).toBe(1);
      expect(pace.slept).toEqual([250, 500]);
      expect(reports).toEqual(
        Array.from({ length: 3 }, () => ({
          attemptId: runs[0]?.attemptId,
          orderId: 'order-a',
          generation: 1,
        })),
      );
    });

    it('is repeated a bounded number of times and then left busy', async () => {
      const { db, runs, reports } = fakeDb(
        [lost],
        Array.from({ length: 20 }, () => 'busy' as const),
      );
      const pace = pauses();
      const outcome = await drainAccountingWork(db, {
        newAttemptId: ids(),
        ...pace,
      });
      expect(outcome.stop).toBe('call_failed');
      expect(outcome.report).toBe('busy');
      expect(pace.slept).toEqual([...RECORDER_BACKOFF_MS]);
      expect(reports).toHaveLength(RECORDER_BACKOFF_MS.length + 1);
      expect(new Set(reports.map((r) => r.attemptId))).toEqual(
        new Set([runs[0]?.attemptId]),
      );
    });

    it('stops repeating when the budget cannot cover the next pause, and later drains stay correct', async () => {
      const next = ids();
      const first = fakeDb([lost], ['busy', 'busy', 'busy', 'busy']);
      const pace = pauses();
      const outcome = await drainAccountingWork(first.db, {
        newAttemptId: next,
        budgetMs: 1_000,
        ...pace,
      });
      expect(outcome.stop).toBe('call_failed');
      expect(outcome.report).toBe('busy');
      expect(outcome.calls).toBe(1);
      expect(pace.slept).toEqual([250, 500]);
      expect(first.reports).toHaveLength(3);
      expect(first.runs).toHaveLength(1);

      const second = fakeDb([
        run('processed', { processed: 1, applied: 1 }),
        run('empty'),
      ]);
      const later = await drainAccountingWork(second.db, {
        newAttemptId: next,
      });
      expect(later.stop).toBe('empty');
      expect(later.counts.applied).toBe(1);
      expect(second.reports).toEqual([]);
      expect(second.runs.map((r) => r.binding)).toEqual([orderA, null]);
      const used = [...first.runs, ...second.runs].map((r) => r.attemptId);
      expect(new Set(used).size).toBe(used.length);
    });

    it('is still made once when the failed call used up the budget, but not repeated', async () => {
      const { db, reports } = fakeDb([lost], ['busy', 'recorded']);
      const pace = pauses();
      let reads = 0;
      const outcome = await drainAccountingWork(db, {
        newAttemptId: ids(),
        clock: () => (reads++ < 2 ? 0 : DRAIN_BUDGET_MS + 1),
        sleep: pace.sleep,
      });
      expect(outcome.stop).toBe('call_failed');
      expect(outcome.report).toBe('busy');
      expect(reports).toHaveLength(1);
      expect(pace.slept).toEqual([]);
    });

    it.each([
      'recorded',
      'committed',
      'duplicate',
      'no_work',
      'stale',
    ] as const)('is not repeated once the answer is %s', async (answer) => {
      const { db, reports } = fakeDb([lost], answer);
      const pace = pauses();
      const outcome = await drainAccountingWork(db, {
        newAttemptId: ids(),
        ...pace,
      });
      expect(outcome.report).toBe(answer);
      expect(reports).toHaveLength(1);
      expect(pace.slept).toEqual([]);
    });

    it('ends unreported when a repeat itself fails, keeping the attempt id', async () => {
      const { db, runs, reports } = fakeDb(
        [lost],
        [
          'busy',
          new SupabaseRpcError('Supabase RPC failed: network', 'network'),
        ],
      );
      const pace = pauses();
      const outcome = await drainAccountingWork(db, {
        newAttemptId: ids(),
        ...pace,
      });
      expect(outcome.report).toBe('unreported');
      expect(reports.map((r) => r.attemptId)).toEqual([
        runs[0]?.attemptId,
        runs[0]?.attemptId,
      ]);
    });
  });

  it('redacts secrets from a reported error', async () => {
    const { db } = fakeDb([
      new SupabaseRpcError('boom Bearer ya29.SECRET-TOKEN', 'network'),
    ]);
    const outcome = await drainAccountingWork(db, { newAttemptId: ids() });
    expect(formatDrain(outcome)).not.toContain('SECRET-TOKEN');
  });
});
