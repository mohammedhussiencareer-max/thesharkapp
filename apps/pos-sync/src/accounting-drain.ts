import { randomUUID } from 'node:crypto';
import { safeErrorMessage } from './safe-error.ts';
import {
  isUnknownOutcome,
  zeroAccountingCounts,
  type AccountingCounts,
  type AccountingDb,
  type AccountingOrderRef,
  type FailureReport,
} from './supabase-write.ts';

export const DRAIN_BUDGET_MS = 60_000;
// One order a call, so a call that fails without a reply belongs to the one
// order it was bound to.
export const DRAIN_BATCH_LIMIT = 1;
const MAX_CONSECUTIVE_STALE = 3;
// Waits before each repeat of a failure report the ledger lock turned away.
export const RECORDER_BACKOFF_MS: readonly number[] = [
  250, 500, 1_000, 2_000, 4_000,
];

export type DrainStop =
  | 'empty'
  | 'busy'
  | 'sync_running'
  | 'not_activated'
  | 'critical'
  | 'order_failed'
  | 'call_failed'
  | 'stale'
  | 'budget';

export type DrainOutcome = {
  stop: DrainStop;
  calls: number;
  counts: AccountingCounts;
  criticalOrderId: string | null;
  report: FailureReport | 'not_needed' | 'unreported' | null;
  error: string | null;
};

export type DrainOptions = {
  budgetMs: number;
  clock: () => number;
  newAttemptId: () => string;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULTS: DrainOptions = {
  budgetMs: DRAIN_BUDGET_MS,
  clock: () => Date.now(),
  newAttemptId: () => randomUUID(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type Pacing = Pick<DrainOptions, 'budgetMs' | 'clock' | 'sleep'> & {
  started: number;
};

// Runs the accounting worker, one order a call, until it has nothing left, is
// blocked, fails, or the time budget ends. Each call is bound to the order the
// previous reply named as next (the first from accounting_next_work). With no
// order known the call is unbound: the worker then only expands its rederive
// spans and returns the head, which the next call is bound to; an unbound call
// processes no order, so it has nothing a failure could be charged to. A call
// that fails without a reply is reported once, with the attempt id chosen
// before the call, naming only the order it was bound to. A report the ledger
// lock turns away (busy) is repeated with that same attempt id after a growing
// pause, while the budget lasts, so contention cannot lose the attempt. Never
// throws.
export async function drainAccountingWork(
  db: AccountingDb,
  options: Partial<DrainOptions> = {},
): Promise<DrainOutcome> {
  const { budgetMs, clock, newAttemptId, sleep } = {
    ...DEFAULTS,
    ...options,
  };
  const started = clock();
  const pacing: Pacing = { budgetMs, clock, sleep, started };
  const counts = zeroAccountingCounts();
  let calls = 0;
  let stale = 0;
  let binding: AccountingOrderRef | null;
  let criticalOrderId: string | null = null;

  const done = (
    stop: DrainStop,
    report: DrainOutcome['report'] = null,
    error: string | null = null,
  ): DrainOutcome => ({
    stop,
    calls,
    counts,
    criticalOrderId,
    report,
    error,
  });

  try {
    const next = await db.getNextWork();
    if (next.status === 'not_activated') {
      return done('not_activated');
    }
    binding = next.head;
  } catch (error) {
    return done('call_failed', 'not_needed', safeErrorMessage(error));
  }

  for (;;) {
    if (clock() - started >= budgetMs) {
      return done('budget');
    }
    const attemptId = newAttemptId();
    calls += 1;
    let run;
    try {
      run = await db.runAccountingWork(attemptId, DRAIN_BATCH_LIMIT, binding);
    } catch (error) {
      return failedCall(db, attemptId, binding, error, pacing, done);
    }
    if (run.status === 'stale') {
      stale += 1;
      if (stale > MAX_CONSECUTIVE_STALE) {
        return done('stale');
      }
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
    counts.disposition_pending += run.counts.disposition_pending;
    counts.failed += run.counts.failed;
    counts.remaining = run.counts.remaining;
    binding = run.head;
    if (run.status === 'critical') {
      criticalOrderId = run.critical?.orderId ?? null;
      return done('critical');
    }
    if (run.status !== 'processed') {
      return done(run.status);
    }
    if (run.counts.failed > 0) {
      return done('order_failed');
    }
  }
}

async function failedCall(
  db: AccountingDb,
  attemptId: string,
  binding: AccountingOrderRef | null,
  error: unknown,
  pacing: Pacing,
  done: (
    stop: DrainStop,
    report?: DrainOutcome['report'],
    error?: string | null,
  ) => DrainOutcome,
): Promise<DrainOutcome> {
  const message = safeErrorMessage(error);
  // An unbound call is maintenance and processed no order: nothing to charge.
  if (binding === null || !isUnknownOutcome(error)) {
    return done('call_failed', 'not_needed', message);
  }
  try {
    let report = await db.recordAccountingCallFailure(
      attemptId,
      binding.orderId,
      binding.workGeneration,
    );
    for (const pause of RECORDER_BACKOFF_MS) {
      const { clock, started, budgetMs, sleep } = pacing;
      if (report !== 'busy' || clock() - started + pause > budgetMs) {
        break;
      }
      await sleep(pause);
      report = await db.recordAccountingCallFailure(
        attemptId,
        binding.orderId,
        binding.workGeneration,
      );
    }
    return done('call_failed', report, message);
  } catch (reportError) {
    return done(
      'call_failed',
      'unreported',
      `${message}; ${safeErrorMessage(reportError)}`,
    );
  }
}

export function formatDrain(outcome: DrainOutcome): string {
  const c = outcome.counts;
  const parts = [
    `accounting drain stop=${outcome.stop}`,
    `calls=${outcome.calls}`,
    `processed=${c.processed}`,
    `applied=${c.applied}`,
    `unchanged=${c.unchanged}`,
    `incomplete=${c.incomplete}`,
    `none=${c.none}`,
    `blocked=${c.blocked}`,
    `disposition_pending=${c.disposition_pending}`,
    `failed=${c.failed}`,
    `remaining=${c.remaining}`,
  ];
  if (outcome.criticalOrderId !== null) {
    parts.push(`critical_order=${outcome.criticalOrderId}`);
  }
  if (outcome.report !== null) {
    parts.push(`report=${outcome.report}`);
  }
  if (outcome.error !== null) {
    parts.push(`error=${outcome.error}`);
  }
  return parts.join(' ');
}
