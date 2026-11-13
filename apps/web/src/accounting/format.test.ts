import { describe, expect, it } from 'vitest';
import {
  formatCountPair,
  formatCoverage,
  formatFailureReason,
  formatSignedDifference,
  runStopLabel,
} from '@/accounting/format';
import type { SyncCoverage } from '@/accounting/types';

const coverage: SyncCoverage = {
  runId: '7801',
  startedAt: '2026-02-01T00:00:00.000Z',
  finishedAt: '2026-02-01T01:00:00.000Z',
  ordersScopeApplied: true,
  scopeKind: 'shift_ids',
  scopeFrom: null,
  transactionsCovered: true,
  presentedShiftCount: '1',
  legacyDirect: false,
};

describe('accounting format', () => {
  it('adds processed and open counts with BigInt text', () => {
    expect(formatCountPair('2', '3')).toBe('اتعالج 2 من 5');
    expect(formatCountPair('9007199254740993', '1')).toBe(
      'اتعالج 9007199254740993 من 9007199254740994',
    );
  });

  it('maps a safe reason and SQLSTATE, and a missing reason', () => {
    expect(formatFailureReason('escaped', '57014')).toBe(
      'المكالمة اتقطعت (الوقت خلص)',
    );
    expect(formatFailureReason('critical', null)).toBe(
      'خطأ جوهري في الدفتر، الحساب واقف',
    );
    expect(formatFailureReason(null, 'XX000')).toBe('الرمز XX000');
    expect(formatFailureReason(null, null)).toBe('السبب مش متسجل');
  });

  it('describes coverage without a raw scope dump', () => {
    expect(formatCoverage(null)).toBe('لسه مفيش مزامنة ناجحة متغطية');
    expect(
      formatCoverage({ ...coverage, ordersScopeApplied: false }),
    ).toContain('النطاق ما اتطبقش');
    expect(formatCoverage(coverage)).toContain('ورديات محددة');
    expect(formatCoverage({ ...coverage, scopeKind: null })).toContain(
      'النطاق مش معروف',
    );
  });

  it('formats a signed difference as money text', () => {
    expect(formatSignedDifference('-1.50')).toBe('-1.50 ج.م');
    expect(formatSignedDifference('0.00')).toBe('0.00 ج.م');
  });

  it('names every run stop in Arabic', () => {
    expect(runStopLabel('not_activated')).toBe('الخصم لسه ما اتفعّلش');
    expect(runStopLabel('budget')).toBe('الوقت خلص والباقي مستني');
    expect(runStopLabel('order_failed')).toBe('طلب فشل واتسجل. الباقي مستني');
  });
});
