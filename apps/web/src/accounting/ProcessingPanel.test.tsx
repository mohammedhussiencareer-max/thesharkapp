import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadProcessingSummary,
  recordRunFailure,
  retryParkedOrder,
  runDeductions,
} from '@/accounting/api';
import { ProcessingPanel } from '@/accounting/ProcessingPanel';
import {
  accountingRetrySubject,
  accountingRunSubject,
  zeroAccountingCounts,
  type RunOutcome,
} from '@/accounting/run';
import type { ProcessingSummary } from '@/accounting/types';
import { writeError } from '@/accounting/errors';
import {
  hasAction,
  resetHeldWrites,
  unknownSaveMessage,
} from '@/items/request-id';

vi.mock('@/accounting/api', () => ({
  loadProcessingSummary: vi.fn(),
  runDeductions: vi.fn(),
  recordRunFailure: vi.fn(),
  retryParkedOrder: vi.fn(),
}));

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

const summary: ProcessingSummary = {
  activated: false,
  pendingCount: '2',
  blockedCount: '1',
  failedCount: '1',
  processedEventCount: '4',
  openEventCount: '6',
  openSpanCount: '3',
  coverage: null,
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
  parkedTruncated: true,
};

describe('ProcessingPanel', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(loadProcessingSummary).mockReset();
    vi.mocked(runDeductions).mockReset();
    vi.mocked(recordRunFailure).mockReset();
    vi.mocked(retryParkedOrder).mockReset();
    vi.mocked(loadProcessingSummary).mockResolvedValue(summary);
  });

  it('shows the counts, coverage, progress, and dormant banner', async () => {
    render(<ProcessingPanel />);
    const paragraph =
      (needle: string) => (_content: string, node: Element | null) =>
        node?.tagName === 'P' && (node.textContent ?? '').includes(needle);
    expect(await screen.findByText(paragraph('مستني'))).toBeInTheDocument();
    expect(screen.getByText(paragraph('واقف'))).toBeInTheDocument();
    expect(
      screen.getByText(paragraph('متوقف بعد ٥ محاولات')),
    ).toBeInTheDocument();
    expect(screen.getByText('اتعالج 4 من 10')).toBeInTheDocument();
    expect(screen.getByText(/فترات إعدادات لسه مفتوحة/)).toBeInTheDocument();
    expect(
      screen.getByText('لسه مفيش مزامنة ناجحة متغطية'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('الخصم لسه ما اتفعّلش. التشغيل بيرجع من غير ما يكتب.'),
    ).toBeInTheDocument();
    expect(screen.getByText('المكالمة اتقطعت (الوقت خلص)')).toBeInTheDocument();
    expect(
      screen.getByText('فيه طلبات متوقفة أكتر من المعروض'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/RAWLEAK|permission denied/)).toBeNull();
  });

  it('retires a definite refusal and keeps a bound unknown attempt', async () => {
    vi.mocked(runDeductions).mockResolvedValueOnce(
      outcome({
        stop: 'call_failed',
        report: 'not_needed',
        cause: writeError({ code: '42501', message: 'permission denied raw' }),
      }),
    );
    render(<ProcessingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'شغّل الخصم' }));
    expect(
      await screen.findByText('المالك بس يقدر يشغّل الحساب'),
    ).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(screen.queryByText(/permission denied/)).toBeNull();
    expect(hasAction(accountingRunSubject)).toBe(false);

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
    vi.mocked(recordRunFailure).mockResolvedValueOnce('busy');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByText('الحساب مشغول، حاول تاني'),
    ).toBeInTheDocument();
    expect(recordRunFailure).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      orderId: 'order-9',
      workGeneration: 4,
      failureKind: 'escaped',
    });
    expect(hasAction(accountingRunSubject)).toBe(true);
  });

  it('keeps a bound attempt when the reported cause is a recorder refusal', async () => {
    vi.mocked(runDeductions).mockImplementationOnce((onBound) => {
      onBound?.({
        attemptId: 'attempt-rec',
        orderId: 'order-9',
        workGeneration: 3,
        failureKind: 'escaped',
      });
      return Promise.resolve(
        outcome({
          stop: 'call_failed',
          report: 'unreported',
          cause: writeError({
            code: '42501',
            message: 'permission denied raw',
          }),
        }),
      );
    });
    render(<ProcessingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'شغّل الخصم' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(screen.queryByRole('button', { name: 'شغّل الخصم' })).toBeNull();
    expect(screen.queryByText('المالك بس يقدر يشغّل الحساب')).toBeNull();
  });

  it('keeps the unknown attempt when a retry recording is a payload refusal', async () => {
    vi.mocked(runDeductions).mockImplementationOnce((onBound) => {
      onBound?.({
        attemptId: 'attempt-3',
        orderId: 'order-9',
        workGeneration: 2,
        failureKind: 'recompute_timeout',
      });
      return Promise.resolve(
        outcome({
          stop: 'call_failed',
          report: 'unreported',
          cause: Object.assign(new Error('timeout'), { code: '57014' }),
        }),
      );
    });
    vi.mocked(recordRunFailure).mockRejectedValueOnce(
      writeError({ code: '22023', message: 'bad payload' }),
    );
    render(<ProcessingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'شغّل الخصم' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('الطلب مش مظبوط')).toBeInTheDocument();
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(recordRunFailure).toHaveBeenCalledWith({
      attemptId: 'attempt-3',
      orderId: 'order-9',
      workGeneration: 2,
      failureKind: 'recompute_timeout',
    });
  });

  it('settles a recorded failure and does not revive it when reload fails', async () => {
    vi.mocked(loadProcessingSummary)
      .mockResolvedValueOnce(summary)
      .mockRejectedValueOnce(new Error('حصل خطأ. حاول تاني.'));
    vi.mocked(runDeductions).mockImplementationOnce((onBound) => {
      onBound?.({
        attemptId: 'attempt-2',
        orderId: 'order-9',
        workGeneration: 1,
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
    vi.mocked(recordRunFailure).mockResolvedValueOnce('recorded');
    render(<ProcessingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'شغّل الخصم' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'إعادة المحاولة' }),
    );
    expect(
      await screen.findByText('اتسجل إن المكالمة اتقطعت'),
    ).toBeInTheDocument();
    expect(await screen.findByText('حصل خطأ. حاول تاني.')).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(hasAction(accountingRunSubject)).toBe(false);
  });

  it('retries a parked order and keeps an unknown retry', async () => {
    vi.mocked(retryParkedOrder).mockResolvedValueOnce('retried');
    render(<ProcessingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'رجّع الطلب' }));
    expect(await screen.findByText('الطلب رجع للشغل')).toBeInTheDocument();
    expect(retryParkedOrder).toHaveBeenCalledWith('order-parked');

    vi.mocked(retryParkedOrder).mockResolvedValueOnce('not_failed');
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(await screen.findByText('الطلب مش متوقف')).toBeInTheDocument();

    vi.mocked(retryParkedOrder).mockResolvedValueOnce('busy');
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(
      await screen.findByText('الحساب مشغول، حاول تاني'),
    ).toBeInTheDocument();
    expect(hasAction(accountingRetrySubject('order-parked'))).toBe(false);

    vi.mocked(retryParkedOrder).mockRejectedValueOnce(new Error('socket'));
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(hasAction(accountingRetrySubject('order-parked'))).toBe(true);
    vi.mocked(retryParkedOrder).mockResolvedValueOnce('retried');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('الطلب رجع للشغل')).toBeInTheDocument();
    expect(retryParkedOrder).toHaveBeenCalledTimes(5);
  });

  it('reloads the summary when refreshKey changes and does not notify the page', async () => {
    const onShiftDataStale = vi.fn();
    const view = render(
      <ProcessingPanel refreshKey={0} onShiftDataStale={onShiftDataStale} />,
    );
    const panel = () => screen.getByRole('region', { name: 'معالجة الخصم' });
    await waitFor(() => {
      expect(panel()).toHaveTextContent('مستني 2');
    });
    expect(loadProcessingSummary).toHaveBeenCalledTimes(1);
    expect(onShiftDataStale).not.toHaveBeenCalled();

    vi.mocked(loadProcessingSummary).mockResolvedValueOnce({
      ...summary,
      pendingCount: '8',
    });
    view.rerender(
      <ProcessingPanel refreshKey={1} onShiftDataStale={onShiftDataStale} />,
    );
    await waitFor(() => {
      expect(panel()).toHaveTextContent('مستني 8');
    });
    expect(loadProcessingSummary).toHaveBeenCalledTimes(2);
    expect(onShiftDataStale).not.toHaveBeenCalled();

    view.rerender(
      <ProcessingPanel refreshKey={1} onShiftDataStale={onShiftDataStale} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadProcessingSummary).toHaveBeenCalledTimes(2);
    expect(panel()).toHaveTextContent('مستني 8');
  });

  it('notifies the page only after an acknowledged run or retry', async () => {
    const onShiftDataStale = vi.fn();
    render(<ProcessingPanel onShiftDataStale={onShiftDataStale} />);
    const runButton = async () =>
      screen.findByRole('button', { name: 'شغّل الخصم' });
    expect(await runButton()).toBeInTheDocument();
    expect(loadProcessingSummary).toHaveBeenCalledTimes(1);

    vi.mocked(runDeductions).mockRejectedValueOnce(new Error('socket'));
    fireEvent.click(await runButton());
    expect(await screen.findByText('socket')).toBeInTheDocument();
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(onShiftDataStale).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('المكالمة ما اكتملتش')).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(hasAction(accountingRunSubject)).toBe(false);
    expect(recordRunFailure).not.toHaveBeenCalled();
    expect(onShiftDataStale).not.toHaveBeenCalled();

    vi.mocked(runDeductions).mockResolvedValueOnce(
      outcome({
        stop: 'call_failed',
        report: 'not_needed',
        cause: writeError({ code: '42501', message: 'permission denied raw' }),
      }),
    );
    fireEvent.click(await runButton());
    expect(
      await screen.findByText('المالك بس يقدر يشغّل الحساب'),
    ).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(false);
    expect(onShiftDataStale).not.toHaveBeenCalled();

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
    fireEvent.click(await runButton());
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(onShiftDataStale).not.toHaveBeenCalled();

    vi.mocked(recordRunFailure).mockResolvedValueOnce('busy');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByText('الحساب مشغول، حاول تاني'),
    ).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(onShiftDataStale).not.toHaveBeenCalled();

    vi.mocked(recordRunFailure).mockRejectedValueOnce(new Error('socket'));
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('socket')).toBeInTheDocument();
    expect(hasAction(accountingRunSubject)).toBe(true);
    expect(onShiftDataStale).not.toHaveBeenCalled();

    vi.mocked(recordRunFailure).mockResolvedValueOnce('recorded');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByText('اتسجل إن المكالمة اتقطعت'),
    ).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(hasAction(accountingRunSubject)).toBe(false);
    expect(onShiftDataStale).toHaveBeenCalledTimes(1);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(1);

    vi.mocked(runDeductions).mockResolvedValueOnce(outcome({ stop: 'empty' }));
    fireEvent.click(await runButton());
    expect(await screen.findByText('مفيش شغل مستني')).toBeInTheDocument();
    expect(onShiftDataStale).toHaveBeenCalledTimes(2);

    vi.mocked(retryParkedOrder).mockResolvedValueOnce('busy');
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(
      await screen.findByText('الحساب مشغول، حاول تاني'),
    ).toBeInTheDocument();
    expect(onShiftDataStale).toHaveBeenCalledTimes(2);

    vi.mocked(retryParkedOrder).mockResolvedValueOnce('not_failed');
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(await screen.findByText('الطلب مش متوقف')).toBeInTheDocument();
    expect(onShiftDataStale).toHaveBeenCalledTimes(3);

    vi.mocked(retryParkedOrder).mockResolvedValueOnce('retried');
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    expect(await screen.findByText('الطلب رجع للشغل')).toBeInTheDocument();
    expect(onShiftDataStale).toHaveBeenCalledTimes(4);
    expect(hasAction(accountingRetrySubject('order-parked'))).toBe(false);
    expect(loadProcessingSummary).toHaveBeenCalledTimes(1);
  });
});
