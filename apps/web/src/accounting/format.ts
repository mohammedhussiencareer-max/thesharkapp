import { reasonLabels, scopeLabels, sqlstateLabel } from '@/accounting/labels';
import type { FailureReason, SyncCoverage } from '@/accounting/types';
import { formatCairo } from '@/lib/cairo';
import { formatEgpText } from '@/lib/money';

export function formatCountPair(processed: string, open: string): string {
  const done = BigInt(processed);
  const waiting = BigInt(open);
  return `اتعالج ${done.toString()} من ${(done + waiting).toString()}`;
}

export function formatFailureReason(
  reason: FailureReason | null,
  sqlstate: string | null,
): string {
  const reasonLabel = reason ? reasonLabels[reason] : null;
  const stateLabel = sqlstate ? sqlstateLabel(sqlstate) : null;
  if (reasonLabel && stateLabel) return `${reasonLabel} (${stateLabel})`;
  if (reasonLabel) return reasonLabel;
  if (stateLabel) return stateLabel;
  return 'السبب مش متسجل';
}

export function formatCoverage(coverage: SyncCoverage | null): string {
  if (!coverage) return 'لسه مفيش مزامنة ناجحة متغطية';
  const when = formatCairo(coverage.finishedAt);
  if (!coverage.ordersScopeApplied) {
    return `آخر تغطية ${when}: النطاق ما اتطبقش`;
  }
  const kind = coverage.scopeKind
    ? scopeLabels[coverage.scopeKind]
    : 'النطاق مش معروف';
  return `آخر تغطية ${when}: ${kind}`;
}

export function formatSignedDifference(value: string): string {
  return formatEgpText(value);
}

export const runStopLabels = {
  empty: 'مفيش شغل مستني',
  busy: 'الحساب مشغول',
  sync_running: 'المزامنة شغالة',
  not_activated: 'الخصم لسه ما اتفعّلش',
  critical: 'الحساب وقف بسبب خطأ في الدفتر',
  order_failed: 'طلب فشل واتسجل. الباقي مستني',
  call_failed: 'المكالمة ما اكتملتش',
  stale: 'الدور اتغير، هيتراجع',
  budget: 'الوقت خلص والباقي مستني',
} as const;

export type RunStop = keyof typeof runStopLabels;

export function runStopLabel(stop: RunStop): string {
  return runStopLabels[stop];
}
