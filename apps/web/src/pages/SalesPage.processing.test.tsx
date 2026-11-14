import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadProcessingSummary,
  loadShiftStatuses,
  recordRunFailure,
  retryParkedOrder,
  runDeductions,
} from '@/accounting/api';
import {
  accountingRetrySubject,
  accountingRunSubject,
  zeroAccountingCounts,
  type RunOutcome,
} from '@/accounting/run';
import type {
  DifferenceVector,
  ProcessingSummary,
  ShiftAccountingStatus,
  SyncCoverage,
} from '@/accounting/types';
import { formatCairo } from '@/lib/cairo';
import {
  hasAction,
  resetHeldWrites,
  unknownSaveMessage,
} from '@/items/request-id';
import { SalesPage } from '@/pages/SalesPage';
import { loadSalesHome } from '@/sales/api';
import type { SalesHome, ShiftSummary } from '@/sales/types';

vi.mock('@/sales/api', () => ({
  loadSalesHome: vi.fn(),
}));

vi.mock('@/accounting/api', () => ({
  loadProcessingSummary: vi.fn(),
  loadShiftStatuses: vi.fn(),
  runDeductions: vi.fn(),
  recordRunFailure: vi.fn(),
  retryParkedOrder: vi.fn(),
}));

const zero: DifferenceVector = {
  netSalesDifference: '0.00',
  cogsDifference: '0.00',
  wasteDifference: '0.00',
  countDifference: '0.00',
  profitDifference: '0.00',
};

const sourceAt = '2026-09-07T10:00:00.000Z';
const coveredAt = '2026-10-21T11:05:00.000Z';

function outcome(patch: Partial<RunOutcome>): RunOutcome {
  return {
    stop: 'empty',
    calls: 1,
    counts: zeroAccountingCounts(),
    criticalOrderId: null,
    report: null,
    cause: null,
    ...patch,
  };
}

function shift(netSales: string): ShiftSummary {
  return {
    shiftId: 'shift-test-1',
    openedAt: '2026-10-15T09:00:00.000Z',
    closedAt: '2026-10-16T01:00:00.000Z',
    isActive: false,
    ordersComplete: 1,
    grossSales: netSales,
    refunds: '0.00',
    netSales,
    ordersCanceled: 0,
    ordersOpen: 0,
    ordersMissing: 0,
    drawerTotal: netSales,
    drawerDifference: '0.00',
    unknownTx: 0,
  };
}

function home(
  netSales: string,
  lastSyncAt = '2026-10-21T11:00:00.000Z',
): SalesHome {
  return { shifts: [shift(netSales)], lastSyncAt };
}

function summary(patch: Partial<ProcessingSummary> = {}): ProcessingSummary {
  return {
    activated: false,
    pendingCount: '2',
    blockedCount: '0',
    failedCount: '0',
    processedEventCount: '4',
    openEventCount: '6',
    openSpanCount: '0',
    coverage: null,
    parked: [],
    parkedCount: '0',
    parkedTruncated: false,
    ...patch,
  };
}

const coverage: SyncCoverage = {
  runId: 'run-1',
  startedAt: '2026-10-21T11:00:00.000Z',
  finishedAt: coveredAt,
  ordersScopeApplied: true,
  scopeKind: 'all',
  scopeFrom: null,
  transactionsCovered: true,
  presentedShiftCount: '1',
  legacyDirect: false,
};

function shiftStatus(
  statusLabel: string,
  revisions: ShiftAccountingStatus['revisions'] = [],
): ShiftAccountingStatus {
  return {
    shiftId: 'shift-test-1',
    openedAt: '2026-10-15T09:00:00.000Z',
    statusLabel,
    revised: revisions.length > 0,
    causes: revisions.length > 0 ? [] : ['pending_applications'],
    revisions,
    latestDifference:
      revisions.length > 0 ? { ...zero, wasteDifference: '-3.50' } : zero,
    cumulativeDifference: zero,
  };
}

function installHome(netSales: string, lastSyncAt?: string): void {
  vi.mocked(loadSalesHome).mockImplementation(() =>
    Promise.resolve(home(netSales, lastSyncAt)),
  );
}

function installStatuses(status: ShiftAccountingStatus): void {
  vi.mocked(loadShiftStatuses).mockImplementation(() =>
    Promise.resolve({
      byId: new Map([[status.shiftId, status]]),
      capped: false,
    }),
  );
}

function installSummary(value: ProcessingSummary): void {
  vi.mocked(loadProcessingSummary).mockImplementation(() =>
    Promise.resolve(value),
  );
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <SalesPage />
    </MemoryRouter>,
  );
}

function processingPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'معالجة الخصم' });
}

describe('SalesPage processing refresh', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(loadSalesHome).mockReset();
    vi.mocked(loadProcessingSummary).mockReset();
    vi.mocked(loadShiftStatuses).mockReset();
    vi.mocked(runDeductions).mockReset();
    vi.mocked(recordRunFailure).mockReset();
    vi.mocked(retryParkedOrder).mockReset();
  });

  it('reloads pending counts, coverage, and parked orders with the page', async () => {
    installHome('210.00');
    installStatuses(shiftStatus('ناقص'));
    installSummary(summary());
    renderPage();
    await waitFor(() => {
      expect(processingPanel()).toHaveTextContent('مستني 2');
    });
    expect(
      screen.getByText('الخصم لسه ما اتفعّلش. التشغيل بيرجع من غير ما يكتب.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('لسه مفيش مزامنة ناجحة متغطية'),
    ).toBeInTheDocument();
    expect(screen.queryByText('order-after-sync')).toBeNull();
    expect(screen.queryByText('مستند هالك')).toBeNull();
    expect(loadProcessingSummary).toHaveBeenCalledTimes(1);

    const nextSync = '2026-10-21T12:30:00.000Z';
    installHome('240.00', nextSync);
    installStatuses(
      shiftStatus('مكتمل', [
        { causeKind: 'waste_document', sourceAt, isLatest: true },
      ]),
    );
    installSummary(
      summary({
        activated: true,
        pendingCount: '17',
        blockedCount: '1',
        coverage,
        parked: [
          {
            orderId: 'order-after-sync',
            attempts: '5',
            workGeneration: '2',
            failedAt: '2026-10-21T12:00:00.000Z',
            sqlstate: '57014',
            reason: 'escaped',
          },
        ],
        parkedCount: '1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));

    await waitFor(() => {
      expect(processingPanel()).toHaveTextContent('مستني 17');
    });
    expect(processingPanel()).toHaveTextContent(
      `آخر تغطية ${formatCairo(coveredAt)}: كل التاريخ`,
    );
    expect(processingPanel()).toHaveTextContent('order-after-sync');
    expect(processingPanel()).toHaveTextContent('المكالمة اتقطعت (الوقت خلص)');
    expect(
      screen.queryByText('الخصم لسه ما اتفعّلش. التشغيل بيرجع من غير ما يكتب.'),
    ).toBeNull();
    expect(
      screen.getByText(`آخر مزامنة ${formatCairo(nextSync)}`),
    ).toBeInTheDocument();
    expect(screen.getByText('صافي المبيعات 240.00 ج.م')).toBeInTheDocument();
    const shiftRegion = screen.getByRole('region', { name: 'حالة الوردية' });
    expect(shiftRegion).toHaveTextContent('مكتمل');
    expect(shiftRegion).toHaveTextContent('مستند هالك');
    expect(shiftRegion).toHaveTextContent(
      `وقت الواقعة ${formatCairo(sourceAt)}`,
    );
    expect(shiftRegion).toHaveTextContent('-3.50 ج.م');
    expect(screen.queryByText('فيه خصم لسه مستني')).toBeNull();
    expect(loadSalesHome).toHaveBeenCalledTimes(2);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(2);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(2);
    expect(runDeductions).not.toHaveBeenCalled();
  });

  it('reloads shift revisions and the panel after an acknowledged run', async () => {
    installHome('210.00');
    installStatuses(shiftStatus('ناقص'));
    installSummary(summary({ activated: true, pendingCount: '4' }));
    renderPage();
    await waitFor(() => {
      expect(processingPanel()).toHaveTextContent('مستني 4');
    });
    expect(await screen.findByText('فيه خصم لسه مستني')).toBeInTheDocument();

    installHome('240.00');
    installStatuses(
      shiftStatus('مكتمل', [
        { causeKind: 'waste_document', sourceAt, isLatest: true },
      ]),
    );
    installSummary(summary({ activated: true, pendingCount: '0' }));
    vi.mocked(runDeductions).mockResolvedValueOnce(outcome({ stop: 'empty' }));
    fireEvent.click(screen.getByRole('button', { name: 'شغّل الخصم' }));

    expect(await screen.findByText('مفيش شغل مستني')).toBeInTheDocument();
    await waitFor(() => {
      expect(processingPanel()).toHaveTextContent('مستني 0');
    });
    const shiftRegion = screen.getByRole('region', { name: 'حالة الوردية' });
    expect(shiftRegion).toHaveTextContent('مكتمل');
    expect(shiftRegion).toHaveTextContent('معدّل');
    expect(shiftRegion).toHaveTextContent('مستند هالك');
    expect(shiftRegion).toHaveTextContent('-3.50 ج.م');
    expect(shiftRegion).toHaveTextContent(
      `وقت الواقعة ${formatCairo(sourceAt)}`,
    );
    expect(screen.getByText('صافي المبيعات 240.00 ج.م')).toBeInTheDocument();
    expect(screen.queryByText('فيه خصم لسه مستني')).toBeNull();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(hasAction(accountingRunSubject)).toBe(false);
    expect(loadSalesHome).toHaveBeenCalledTimes(2);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(2);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(2);
  });

  it('reloads shift revisions after an acknowledged retry and not after busy', async () => {
    installHome('210.00');
    installStatuses(shiftStatus('ناقص'));
    installSummary(
      summary({
        activated: true,
        parked: [
          {
            orderId: 'order-parked',
            attempts: '5',
            workGeneration: '2',
            failedAt: '2026-02-01T00:00:00.000Z',
            sqlstate: '57014',
            reason: 'escaped',
          },
        ],
        parkedCount: '1',
      }),
    );
    renderPage();
    expect(
      await screen.findByRole('button', { name: 'رجّع الطلب' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('فيه خصم لسه مستني')).toBeInTheDocument();
    expect(loadProcessingSummary).toHaveBeenCalledTimes(1);

    vi.mocked(retryParkedOrder).mockResolvedValueOnce('busy');
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(
      await screen.findByText('الحساب مشغول، حاول تاني'),
    ).toBeInTheDocument();
    expect(screen.getByText('ناقص')).toBeInTheDocument();
    expect(screen.queryByText('مستند هالك')).toBeNull();
    expect(loadSalesHome).toHaveBeenCalledTimes(1);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(1);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(1);

    installStatuses(
      shiftStatus('مكتمل', [
        { causeKind: 'waste_document', sourceAt, isLatest: true },
      ]),
    );
    vi.mocked(retryParkedOrder).mockResolvedValueOnce('retried');
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(await screen.findByText('الطلب رجع للشغل')).toBeInTheDocument();
    expect(await screen.findByText('مستند هالك')).toBeInTheDocument();
    expect(screen.getByText('-3.50 ج.م')).toBeInTheDocument();
    expect(loadSalesHome).toHaveBeenCalledTimes(2);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(2);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(2);

    const refundAt = '2026-09-08T09:00:00.000Z';
    installStatuses(
      shiftStatus('اتراجع', [
        { causeKind: 'refund', sourceAt: refundAt, isLatest: true },
      ]),
    );
    vi.mocked(retryParkedOrder).mockResolvedValueOnce('not_failed');
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(await screen.findByText('الطلب مش متوقف')).toBeInTheDocument();
    expect(await screen.findByText('مرتجع')).toBeInTheDocument();
    const shiftRegion = screen.getByRole('region', { name: 'حالة الوردية' });
    expect(shiftRegion).toHaveTextContent('اتراجع');
    expect(shiftRegion).toHaveTextContent(
      `وقت الواقعة ${formatCairo(refundAt)}`,
    );
    expect(screen.queryByText('مستند هالك')).toBeNull();
    expect(loadSalesHome).toHaveBeenCalledTimes(3);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(3);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(3);
  });

  it('keeps an unknown run retryable, and a failed reload does not revive it', async () => {
    installHome('210.00');
    installStatuses(shiftStatus('ناقص'));
    installSummary(summary({ activated: true, pendingCount: '2' }));
    renderPage();
    expect(
      await screen.findByRole('button', { name: 'شغّل الخصم' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('ناقص')).toBeInTheDocument();

    vi.mocked(runDeductions).mockImplementationOnce((onBound) => {
      onBound?.({
        attemptId: 'attempt-1',
        orderId: 'order-9',
        workGeneration: 4,
        failureKind: 'escaped',
      });
      return Promise.resolve(
        outcome({
          stop: 'call_failed',
          report: 'unreported',
          cause: new Error('network'),
        }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'شغّل الخصم' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(loadSalesHome).toHaveBeenCalledTimes(1);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(1);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(1);

    installHome('240.00');
    installStatuses(shiftStatus('بعد التحديث'));
    installSummary(summary({ activated: true, pendingCount: '9' }));
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    await waitFor(() => {
      expect(processingPanel()).toHaveTextContent('مستني 9');
    });
    expect(screen.getByText('بعد التحديث')).toBeInTheDocument();
    expect(screen.getByText('صافي المبيعات 240.00 ج.م')).toBeInTheDocument();
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(loadSalesHome).toHaveBeenCalledTimes(2);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(2);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(2);

    vi.mocked(recordRunFailure).mockResolvedValueOnce('busy');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByText('الحساب مشغول، حاول تاني'),
    ).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(loadSalesHome).toHaveBeenCalledTimes(2);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(2);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(2);

    vi.mocked(recordRunFailure).mockRejectedValueOnce(new Error('socket'));
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('socket')).toBeInTheDocument();
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(loadSalesHome).toHaveBeenCalledTimes(2);

    vi.mocked(loadProcessingSummary).mockRejectedValue(
      new Error('حصل خطأ. حاول تاني.'),
    );
    vi.mocked(loadSalesHome).mockRejectedValue(
      new Error('تعذّر تحديث الورديات'),
    );
    vi.mocked(recordRunFailure).mockResolvedValueOnce('recorded');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByText('اتسجل إن المكالمة اتقطعت'),
    ).toBeInTheDocument();
    expect(await screen.findByText('حصل خطأ. حاول تاني.')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'تعذّر تحديث الورديات',
    );
    expect(screen.getByText('بعد التحديث')).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(hasAction(accountingRunSubject)).toBe(false);
    expect(
      screen.getByRole('button', { name: 'شغّل الخصم' }),
    ).toBeInTheDocument();
    expect(loadSalesHome).toHaveBeenCalledTimes(3);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(2);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(3);

    fireEvent.click(
      screen.getByRole('button', { name: 'إعادة تحميل المعالجة' }),
    );
    expect(await screen.findByText('حصل خطأ. حاول تاني.')).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(false);
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(loadSalesHome).toHaveBeenCalledTimes(3);
    expect(loadShiftStatuses).toHaveBeenCalledTimes(2);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(4);
  });

  it('keeps a lost parked retry visible after refresh until not_failed', async () => {
    installHome('210.00');
    installStatuses(shiftStatus('ناقص'));
    installSummary(
      summary({
        activated: true,
        parked: [
          {
            orderId: 'order-parked',
            attempts: '5',
            workGeneration: '2',
            failedAt: '2026-02-01T00:00:00.000Z',
            sqlstate: '57014',
            reason: 'escaped',
          },
        ],
        parkedCount: '1',
      }),
    );
    renderPage();
    expect(
      await screen.findByRole('button', { name: 'رجّع الطلب' }),
    ).toBeInTheDocument();
    vi.mocked(retryParkedOrder).mockRejectedValueOnce(new Error('socket'));
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(await screen.findByText('socket')).toBeInTheDocument();
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: 'إعادة المحاولة' }),
    ).toHaveLength(1);
    expect(hasAction(accountingRetrySubject('order-parked'))).toBe(true);
    expect(
      screen.getByRole('list', { name: 'طلبات متوقفة' }),
    ).toBeInTheDocument();

    installSummary(summary({ activated: true, parked: [], parkedCount: '0' }));
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    const unresolved = await screen.findByRole('list', {
      name: 'رجوع مش متأكد',
    });
    expect(within(unresolved).getByText('order-parked')).toBeInTheDocument();
    expect(
      within(unresolved).getByRole('button', { name: 'إعادة المحاولة' }),
    ).toBeInTheDocument();
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'طلبات متوقفة' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'رجّع الطلب' })).toBeNull();
    expect(screen.queryByText('المكالمة اتقطعت (الوقت خلص)')).toBeNull();
    expect(hasAction(accountingRetrySubject('order-parked'))).toBe(true);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(2);

    vi.mocked(retryParkedOrder).mockResolvedValueOnce('not_failed');
    fireEvent.click(
      within(unresolved).getByRole('button', { name: 'إعادة المحاولة' }),
    );
    expect(await screen.findByText('الطلب مش متوقف')).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(screen.queryByRole('list', { name: 'رجوع مش متأكد' })).toBeNull();
    expect(screen.queryByText('order-parked')).toBeNull();
    expect(screen.queryByRole('button', { name: 'إعادة المحاولة' })).toBeNull();
    expect(hasAction(accountingRetrySubject('order-parked'))).toBe(false);
    expect(retryParkedOrder).toHaveBeenNthCalledWith(1, 'order-parked');
    expect(retryParkedOrder).toHaveBeenNthCalledWith(2, 'order-parked');
    expect(retryParkedOrder).toHaveBeenCalledTimes(2);
  });
});
