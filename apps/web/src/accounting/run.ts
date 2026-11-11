import { isUnknownOutcome } from '@/lib/write-outcome';
import type { RunStop } from '@/accounting/format';

export const RUN_BUDGET_MS = 2_000;
export const RUN_BATCH_LIMIT = 1;
export const MAX_CALLS = 10;
const MAX_CONSECUTIVE_STALE = 3;
export const RECORDER_BACKOFF_MS: readonly number[] = [
  250, 500, 1_000, 2_000, 4_000,
];

export const accountingRunSubject = 'accounting:run';

export function accountingRetrySubject(orderId: string): string {
  return `accounting:retry:${orderId}`;
}

export type AccountingCounts = {
  processed: number;
  applied: number;
  unchanged: number;
  incomplete: number;
  none: number;
  blocked: number;
  dispositionPending: number;
  failed: number;
  remaining: number;
};

export type AccountingOrderRef = {
  orderId: string;
  workGeneration: number;
};

export type AccountingStatus =
  | 'processed'
  | 'stale'
  | 'empty'
  | 'busy'
  | 'sync_running'
  | 'not_activated'
  | 'critical';

export type AccountingRun = {
  status: AccountingStatus;
  counts: AccountingCounts;
  head: AccountingOrderRef | null;
  critical: AccountingOrderRef | null;
};

export type FailureReport =
  'recorded' | 'committed' | 'duplicate' | 'no_work' | 'stale' | 'busy';

export type NextWork = {
  status: 'ok' | 'empty' | 'not_activated';
  head: AccountingOrderRef | null;
};

export type AttemptReport = {
  attemptId: string;
  orderId: string;
  workGeneration: number;
};

export type RunHeld = {
  requestId: string;
  report: AttemptReport | null;
};

export type AccountingDb = {
  getNextWork(): Promise<NextWork>;
  runAccountingWork(
    attemptId: string,
    limit: number,
    binding: AccountingOrderRef | null,
  ): Promise<AccountingRun>;
  recordAccountingCallFailure(
    attemptId: string,
    orderId: string,
    workGeneration: number,
  ): Promise<FailureReport>;
};

export type RunOutcome = {
  stop: RunStop;
  calls: number;
  counts: AccountingCounts;
  criticalOrderId: string | null;
  report: FailureReport | 'not_needed' | 'unreported' | null;
  cause: unknown;
};

export type RunOptions = {
  budgetMs: number;
  clock: () => number;
  newAttemptId: () => string;
  sleep: (ms: number) => Promise<void>;
  onBoundAttempt?: (report: AttemptReport) => void;
};

const DEFAULTS: RunOptions = {
  budgetMs: RUN_BUDGET_MS,
  clock: () => Date.now(),
  newAttemptId: () => crypto.randomUUID(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function zeroAccountingCounts(): AccountingCounts {
  return {
    processed: 0,
    applied: 0,
    unchanged: 0,
    incomplete: 0,
    none: 0,
    blocked: 0,
    dispositionPending: 0,
    failed: 0,
    remaining: 0,
  };
}

/**
 * One order per call. The attempt id is chosen before the call. The first
 * call may be unbound maintenance. A later call is bound to the head the
 * previous reply named. An unknown outcome of a bound call is reported with
 * that same attempt id. The attempt stays until the recorder returns an
 * acknowledged terminal status: recorded, committed, duplicate, no_work, or
 * stale. busy is not terminal, and a recorder error does not replace the
 * worker error. A full page reload drops the in-memory id.
 * Never throws.
 */
export async function runAccountingWork(
  db: AccountingDb,
  options: Partial<RunOptions> = {},
): Promise<RunOutcome> {
  const { budgetMs, clock, newAttemptId, sleep, onBoundAttempt } = {
    ...DEFAULTS,
    ...options,
  };
  const started = clock();
  const counts = zeroAccountingCounts();
  let calls = 0;
  let stale = 0;
  let binding: AccountingOrderRef | null;
  let criticalOrderId: string | null = null;

  const done = (
    stop: RunStop,
    report: RunOutcome['report'] = null,
    cause: unknown = null,
  ): RunOutcome => ({
    stop,
    calls,
    counts,
    criticalOrderId,
    report,
    cause,
  });

  try {
    const next = await db.getNextWork();
    if (next.status === 'not_activated') return done('not_activated');
    binding = next.head;
  } catch (error) {
    return done('call_failed', 'not_needed', error);
  }

  for (;;) {
    if (clock() - started >= budgetMs || calls >= MAX_CALLS) {
      return done('budget');
    }
    const attemptId = newAttemptId();
    calls += 1;
    if (binding !== null) {
      onBoundAttempt?.({
        attemptId,
        orderId: binding.orderId,
        workGeneration: binding.workGeneration,
      });
    }
    let run: AccountingRun;
    try {
      run = await db.runAccountingWork(attemptId, RUN_BATCH_LIMIT, binding);
    } catch (error) {
      return failedCall(
        db,
        attemptId,
        binding,
        error,
        { budgetMs, clock, sleep, started },
        done,
      );
    }
    if (run.status === 'stale') {
      stale += 1;
      if (stale > MAX_CONSECUTIVE_STALE) return done('stale');
      binding = run.head;
      continue;
    }
    stale = 0;
    counts.processed += run.counts.processed;
    counts.applied += run.counts.applied;
    counts.unchanged += run.counts.unchanged;
    counts.incomplete += run.counts.incomplete;
    counts.none += run.counts.none;
    counts.blocked += run.counts.blocked;
    counts.dispositionPending += run.counts.dispositionPending;
    counts.failed += run.counts.failed;
    counts.remaining = run.counts.remaining;
    binding = run.head;
    if (run.status === 'critical') {
      criticalOrderId = run.critical?.orderId ?? null;
      return done('critical');
    }
    if (run.status !== 'processed') return done(run.status);
    if (run.counts.failed > 0) return done('order_failed');
  }
}

async function failedCall(
  db: AccountingDb,
  attemptId: string,
  binding: AccountingOrderRef | null,
  error: unknown,
  pacing: {
    budgetMs: number;
    clock: () => number;
    sleep: (ms: number) => Promise<void>;
    started: number;
  },
  done: (
    stop: RunStop,
    report?: RunOutcome['report'],
    cause?: unknown,
  ) => RunOutcome,
): Promise<RunOutcome> {
  if (binding === null || !isUnknownOutcome(error)) {
    return done('call_failed', 'not_needed', error);
  }
  try {
    let report = await db.recordAccountingCallFailure(
      attemptId,
      binding.orderId,
      binding.workGeneration,
    );
    const { clock, started, budgetMs, sleep } = pacing;
    let waited = 0;
    for (let repeat = 0; report === 'busy'; repeat += 1) {
      const pause = RECORDER_BACKOFF_MS[
        Math.min(repeat, RECORDER_BACKOFF_MS.length - 1)
      ] as number;
      if (Math.max(clock() - started, waited) + pause > budgetMs) break;
      await sleep(pause);
      waited += pause;
      report = await db.recordAccountingCallFailure(
        attemptId,
        binding.orderId,
        binding.workGeneration,
      );
    }
    return done('call_failed', report, error);
  } catch {
    // Recording did not acknowledge a terminal status. The worker outcome is
    // still unknown, so the recorder's error must not become the cause.
    return done('call_failed', 'unreported', error);
  }
}
