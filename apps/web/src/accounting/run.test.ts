import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CALLS,
  RUN_BATCH_LIMIT,
  runAccountingWork,
  zeroAccountingCounts,
  type AccountingDb,
  type AccountingOrderRef,
  type AccountingRun,
  type NextWork,
} from '@/accounting/run';

function processed(remaining: number): AccountingRun {
  return {
    status: 'processed',
    counts: { ...zeroAccountingCounts(), processed: 1, remaining },
    head: { orderId: 'order-1', workGeneration: 1 },
    critical: null,
  };
}

function next(status: NextWork['status'], head: NextWork['head']): NextWork {
  return { status, head };
}

const noSleep = (): Promise<void> => Promise.resolve();

function harness(overrides: Partial<AccountingDb> = {}): AccountingDb {
  return {
    getNextWork: vi.fn(() =>
      Promise.resolve(next('ok', { orderId: 'order-1', workGeneration: 1 })),
    ),
    runAccountingWork: vi.fn(() => Promise.resolve(processed(0))),
    recordAccountingCallFailure: vi.fn(() =>
      Promise.resolve('recorded' as const),
    ),
    ...overrides,
  };
}

describe('runAccountingWork', () => {
  it('still makes one unbound call when the next-work head is empty', async () => {
    const run = vi.fn(
      (
        ...args: [string, number, AccountingOrderRef | null]
      ): Promise<AccountingRun> => {
        expect(args[1]).toBe(RUN_BATCH_LIMIT);
        expect(args[2]).toBeNull();
        return Promise.resolve({
          status: 'empty',
          counts: zeroAccountingCounts(),
          head: null,
          critical: null,
        });
      },
    );
    const db = harness({
      getNextWork: vi.fn(() => Promise.resolve(next('empty', null))),
      runAccountingWork: run,
    });
    const result = await runAccountingWork(db, {
      budgetMs: 2_000,
      clock: () => 0,
      sleep: noSleep,
    });
    expect(result.stop).toBe('empty');
    expect(result.calls).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not call the worker when accounting is not activated', async () => {
    const run = vi.fn(() => Promise.resolve(processed(0)));
    const db = harness({
      getNextWork: vi.fn(() => Promise.resolve(next('not_activated', null))),
      runAccountingWork: run,
    });
    const result = await runAccountingWork(db, { clock: () => 0 });
    expect(result.stop).toBe('not_activated');
    expect(result.calls).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('stops before the next call once the budget has elapsed', async () => {
    let now = 0;
    const db = harness({
      runAccountingWork: vi.fn(() => {
        now = 2_000;
        return Promise.resolve(processed(4));
      }),
    });
    const result = await runAccountingWork(db, {
      budgetMs: 2_000,
      clock: () => now,
      sleep: noSleep,
    });
    expect(result.stop).toBe('budget');
    expect(result.calls).toBe(1);
  });

  it('does not start an 11th call', async () => {
    const run = vi.fn(() => Promise.resolve(processed(1)));
    const db = harness({ runAccountingWork: run });
    const result = await runAccountingWork(db, {
      budgetMs: 60_000,
      clock: () => 0,
      sleep: noSleep,
    });
    expect(result.stop).toBe('budget');
    expect(result.calls).toBe(MAX_CALLS);
    expect(run).toHaveBeenCalledTimes(MAX_CALLS);
  });

  it('stops on the fourth stale reply', async () => {
    let generation = 1;
    const db = harness({
      runAccountingWork: vi.fn(() => {
        generation += 1;
        return Promise.resolve({
          status: 'stale' as const,
          counts: zeroAccountingCounts(),
          head: { orderId: 'order-1', workGeneration: generation },
          critical: null,
        });
      }),
    });
    const result = await runAccountingWork(db, {
      budgetMs: 60_000,
      clock: () => 0,
      sleep: noSleep,
    });
    expect(result.stop).toBe('stale');
    expect(result.calls).toBe(4);
  });

  it('reports a bound unknown outcome with the same attempt id and backs off while busy', async () => {
    const seen: string[] = [];
    let reports = 0;
    const sleeps: number[] = [];
    let phase = 'before';
    const db = harness({
      runAccountingWork: vi.fn(() => {
        phase = 'inside';
        return Promise.reject(
          Object.assign(new Error('timeout'), { code: '57014' }),
        );
      }),
      recordAccountingCallFailure: vi.fn((attemptId: string) => {
        seen.push(attemptId);
        reports += 1;
        return Promise.resolve(
          reports === 1 ? ('busy' as const) : ('recorded' as const),
        );
      }),
    });
    const result = await runAccountingWork(db, {
      budgetMs: 2_000,
      clock: () => 0,
      newAttemptId: () => 'attempt-fixed',
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      onBoundAttempt: () => {
        expect(phase).toBe('before');
      },
    });
    expect(result.stop).toBe('call_failed');
    expect(result.report).toBe('recorded');
    expect(seen).toEqual(['attempt-fixed', 'attempt-fixed']);
    expect(sleeps).toEqual([250]);
    expect(phase).toBe('inside');
  });

  it('does not record an unbound unknown outcome', async () => {
    const record = vi.fn(() => Promise.resolve('recorded' as const));
    const db = harness({
      getNextWork: vi.fn(() => Promise.resolve(next('empty', null))),
      runAccountingWork: vi.fn(() => Promise.reject(new Error('network'))),
      recordAccountingCallFailure: record,
    });
    const result = await runAccountingWork(db, {
      clock: () => 0,
      sleep: noSleep,
    });
    expect(result.stop).toBe('call_failed');
    expect(result.report).toBe('not_needed');
    expect(record).not.toHaveBeenCalled();
  });

  it('does not record a definite 42501 refusal', async () => {
    const record = vi.fn(() => Promise.resolve('recorded' as const));
    const db = harness({
      runAccountingWork: vi.fn(() =>
        Promise.reject(Object.assign(new Error('no'), { code: '42501' })),
      ),
      recordAccountingCallFailure: record,
    });
    const result = await runAccountingWork(db, {
      clock: () => 0,
      sleep: noSleep,
    });
    expect(result.report).toBe('not_needed');
    expect(result.cause).toMatchObject({ code: '42501' });
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the worker error when recording the failure is refused', async () => {
    const worker = Object.assign(new Error('timeout'), { code: '57014' });
    const recorder = Object.assign(new Error('denied'), { code: '42501' });
    const db = harness({
      runAccountingWork: vi.fn(() => Promise.reject(worker)),
      recordAccountingCallFailure: vi.fn(() => Promise.reject(recorder)),
    });
    const result = await runAccountingWork(db, {
      clock: () => 0,
      sleep: noSleep,
      newAttemptId: () => 'attempt-fixed',
    });
    expect(result.stop).toBe('call_failed');
    expect(result.report).toBe('unreported');
    expect(result.cause).toBe(worker);
    expect(result.cause).toMatchObject({ code: '57014' });
  });

  it('returns call_failed when the next-work read throws', async () => {
    const db = harness({
      getNextWork: vi.fn(() => Promise.reject(new Error('down'))),
    });
    const result = await runAccountingWork(db);
    expect(result.stop).toBe('call_failed');
    expect(result.report).toBe('not_needed');
    expect(result.calls).toBe(0);
  });
});
