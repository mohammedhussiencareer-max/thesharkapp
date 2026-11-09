import { randomUUID } from 'node:crypto';
import { safeErrorMessage } from './safe-error.ts';
import {
  isUnknownOutcome,
  zeroAccountingCounts,
  type AccountingCounts,
  type AccountingDb,
  type FailureReport,
} from './supabase-write.ts';

export const DRAIN_BUDGET_MS = 60_000;
export const DRAIN_BATCH_LIMIT = 5;

export type DrainStop =
  | 'empty'
  | 'busy'
  | 'sync_running'
  | 'not_activated'
  | 'critical'
  | 'order_failed'
  | 'call_failed'
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
  limit: number;
  clock: () => number;
  newAttemptId: () => string;
};

const DEFAULTS: DrainOptions = {
  budgetMs: DRAIN_BUDGET_MS,
  limit: DRAIN_BATCH_LIMIT,
  clock: () => Date.now(),
  newAttemptId: () => randomUUID(),
};

// Runs the accounting worker until it has nothing left, is blocked, fails, or
// the time budget ends. A call that fails without a reply is reported once with
// the attempt id the caller chose before the call. Never throws.
export async function drainAccountingWork(
  db: AccountingDb,
  options: Partial<DrainOptions> = {},
): Promise<DrainOutcome> {
  const { budgetMs, limit, clock, newAttemptId } = { ...DEFAULTS, ...options };
  const started = clock();
  const counts = zeroAccountingCounts();
  let calls = 0;
  let hint: number | null = null;
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

  for (;;) {
    if (clock() - started >= budgetMs) {
      return done('budget');
    }
    const attemptId = newAttemptId();
    calls += 1;
    let run;
    try {
      run = await db.runAccountingWork(attemptId, limit);
    } catch (error) {
      return failedCall(db, attemptId, hint, error, done);
    }
    counts.processed += run.counts.processed;
    counts.applied += run.counts.applied;
    counts.unchanged += run.counts.unchanged;
    counts.incomplete += run.counts.incomplete;
    counts.none += run.counts.none;
    counts.blocked += run.counts.blocked;
    counts.disposition_pending += run.counts.disposition_pending;
    counts.failed += run.counts.failed;
    counts.remaining = run.counts.remaining;
    hint = run.head?.workGeneration ?? null;
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
  hint: number | null,
  error: unknown,
  done: (
    stop: DrainStop,
    report?: DrainOutcome['report'],
    error?: string | null,
  ) => DrainOutcome,
): Promise<DrainOutcome> {
  const message = safeErrorMessage(error);
  if (!isUnknownOutcome(error)) {
    return done('call_failed', 'not_needed', message);
  }
  try {
    const report = await db.recordAccountingCallFailure(attemptId, hint);
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
