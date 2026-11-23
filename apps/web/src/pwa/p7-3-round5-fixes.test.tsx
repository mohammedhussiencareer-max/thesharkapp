import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadProcessingSummary,
  retryParkedOrder,
  runDeductions,
} from '@/accounting/api';
import { ProcessingPanel } from '@/accounting/ProcessingPanel';
import {
  accountingRetrySubject,
  accountingRunSubject,
  runAccountingWork,
  zeroAccountingCounts,
  type AccountingDb,
  type RunOutcome,
} from '@/accounting/run';
import type { ProcessingSummary } from '@/accounting/types';
import {
  addExpenseEntry,
  loadExpenseMonth,
  voidExpenseEntry,
} from '@/expenses/api';
import {
  addConversion,
  addCustomUnit,
  createItem,
  listConversions,
  listCostingSchedule,
  listItems,
  listUnitOptions,
} from '@/items/api';
import { ConversionsPanel } from '@/items/ConversionsPanel';
import {
  createSubject,
  markActionPostedReload,
  resetHeldWrites,
} from '@/items/request-id';
import type { CatalogItem, ItemDraft } from '@/items/types';
import { cairoMonthInput } from '@/lib/cairo';
import {
  getHeldWrite,
  hasHeldWrite,
  hasPostedReload,
  putHeldWrite,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWriteUser,
  storageWriteFailedMessage,
} from '@/lib/held-writes';
import {
  loadQueuePage,
  loadQueueRow,
  loadUnlinkedRefunds,
} from '@/order-decisions/api';
import { decisionSubject } from '@/order-decisions/format';
import { queueRow } from '@/order-decisions/test-fixtures';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ItemsPage } from '@/pages/ItemsPage';
import { OrderDecisionsPage } from '@/pages/OrderDecisionsPage';

const mocks = vi.hoisted(() => ({
  loadExpenseEntryMonth: vi.fn(),
  supabaseSchema: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { schema: mocks.supabaseSchema },
}));

vi.mock('@/accounting/api', () => ({
  loadProcessingSummary: vi.fn(),
  runDeductions: vi.fn(),
  recordRunFailure: vi.fn(),
  retryParkedOrder: vi.fn(),
}));

vi.mock('@/expenses/api', () => ({
  loadExpenseMonth: vi.fn(),
  loadExpenseEntryMonth: mocks.loadExpenseEntryMonth,
  addExpenseEntry: vi.fn(),
  voidExpenseEntry: vi.fn(),
  addExpenseCategory: vi.fn(),
  renameExpenseCategory: vi.fn(),
  setExpenseCategoryActive: vi.fn(),
  setMonthExpenseComplete: vi.fn(),
}));

vi.mock('@/items/api', () => ({
  listItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  setItemLoss: vi.fn(),
  setOpeningPrice: vi.fn(),
  listConversions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
  currentShiftStart: vi.fn(() => Promise.resolve(null)),
  listCostingSchedule: vi.fn(),
  costingImpact: vi.fn(() =>
    Promise.resolve({ orders: 0, shifts: 0, movements: 0 }),
  ),
  listUnitOptions: vi.fn(),
  addCustomUnit: vi.fn(),
}));

vi.mock('@/order-decisions/api', () => ({
  loadQueuePage: vi.fn(),
  loadQueueRow: vi.fn(),
  loadUnlinkedRefunds: vi.fn(),
  setOrderDisposition: vi.fn(),
}));

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value,
  });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

function installMockLocks(onRequest?: (name: string) => Promise<void> | void): {
  held: Set<string>;
  restore: () => void;
} {
  const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      async request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        if (onRequest) await onRequest(name);
        if (options.ifAvailable && held.has(name)) {
          return await callback(null);
        }
        held.add(name);
        try {
          return await callback({ name, mode: options.mode ?? 'exclusive' });
        } finally {
          held.delete(name);
        }
      },
      query: () =>
        Promise.resolve({ held: [...held].map((name) => ({ name })) }),
    },
  });
  return {
    held,
    restore: () => {
      if (origLocks) {
        Object.defineProperty(navigator, 'locks', origLocks);
      } else {
        delete (navigator as unknown as { locks?: unknown }).locks;
      }
    },
  };
}

const oilItem: CatalogItem = {
  id: 'item-oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'liter',
  countFrequency: 'daily',
  lossPct: 0,
  lossFractionText: '0',
  identityLocked: false,
  openingPriceId: 'op-1',
  openingPriceText: '50',
  parentItemId: null,
  active: true,
  onHandQty: 10,
  avgCost: 50,
  onHandValue: 500,
};

const processingSummary: ProcessingSummary = {
  activated: true,
  pendingCount: '1',
  blockedCount: '0',
  failedCount: '1',
  processedEventCount: '5',
  openEventCount: '6',
  openSpanCount: '0',
  coverage: null,
  parked: [
    {
      orderId: 'order-parked',
      attempts: '5',
      workGeneration: '2',
      failedAt: '2026-10-01T00:00:00.000Z',
      sqlstate: '57014',
      reason: 'escaped',
    },
  ],
  parkedCount: '1',
  parkedTruncated: false,
};

function makeOutcome(patch: Partial<RunOutcome>): RunOutcome {
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

describe('P7-3 round-5 review fixes', () => {
  beforeEach(() => {
    localStorage.clear();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetHeldWrites();
    setHeldWriteUser('owner-r5');
    setNavigatorOnline(true);
    vi.resetAllMocks();
  });

  afterEach(() => {
    setNavigatorOnline(true);
  });

  it('R5-2a: ProcessingPanel holds run and retry pins in posted_reload until loadProcessingSummary succeeds', async () => {
    let resolveSummaryAfterRun!: (s: ProcessingSummary) => void;
    let resolveSummaryAfterRetry!: (s: ProcessingSummary) => void;
    vi.mocked(loadProcessingSummary)
      .mockResolvedValueOnce(processingSummary)
      .mockImplementationOnce(
        () =>
          new Promise<ProcessingSummary>((resolve) => {
            resolveSummaryAfterRun = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ProcessingSummary>((resolve) => {
            resolveSummaryAfterRetry = resolve;
          }),
      );
    vi.mocked(runDeductions).mockResolvedValueOnce(
      makeOutcome({ stop: 'empty' }),
    );
    vi.mocked(retryParkedOrder).mockResolvedValueOnce('retried');

    render(<ProcessingPanel />);
    const runBtn = await screen.findByRole('button', { name: 'شغّل الخصم' });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(loadProcessingSummary).toHaveBeenCalledTimes(2);
    });
    // While the verifying summary read is still in flight, posted_reload MUST be held!
    expect(hasPostedReload(accountingRunSubject, accountingRunSubject)).toBe(
      true,
    );

    await act(async () => {
      resolveSummaryAfterRun(processingSummary);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hasPostedReload(accountingRunSubject, accountingRunSubject)).toBe(
        false,
      );
    });

    // Now test parked-order retry
    fireEvent.click(screen.getByRole('button', { name: 'رجّع الطلب' }));
    await waitFor(() => {
      expect(loadProcessingSummary).toHaveBeenCalledTimes(3);
    });
    const retrySubj = accountingRetrySubject('order-parked');
    expect(hasPostedReload(retrySubj, retrySubj)).toBe(true);

    await act(async () => {
      resolveSummaryAfterRetry(processingSummary);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hasPostedReload(retrySubj, retrySubj)).toBe(false);
    });
  });

  it('R5-2b: createItem keeps its real request id in posted_reload through ItemsPage catalog readback', async () => {
    const actualItemsApi =
      await vi.importActual<typeof import('@/items/api')>('@/items/api');
    const rpcMock = vi
      .fn()
      .mockResolvedValueOnce({ data: 'new-item-id', error: null });
    mocks.supabaseSchema.mockReturnValue({ rpc: rpcMock });
    vi.mocked(createItem).mockImplementation(actualItemsApi.createItem);

    vi.mocked(listItems)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce([oilItem]);

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    await screen.findByText('لسه مفيش أصناف — ضيف أول صنف');
    fireEvent.click(screen.getByRole('button', { name: 'ضيف صنف' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'بوري جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledTimes(1);
    });
    await screen.findByText('reload failed');

    const sentRequestId = (
      rpcMock.mock.calls[0]?.[1] as { p_request_id?: string }
    )?.p_request_id;
    expect(typeof sentRequestId).toBe('string');

    const expectedDraft: ItemDraft = {
      name: 'بوري جديد',
      kind: 'fish_mixed',
      baseUnit: 'kg',
      countFrequency: 'daily',
      parentItemId: null,
      lossPct: '0',
      active: true,
    };
    const subject = createSubject(expectedDraft);
    // Real create request id MUST remain held in posted_reload until catalog readback succeeds!
    expect(hasPostedReload(subject, 'items:reload', sentRequestId)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await screen.findByText('زيت');
    expect(hasPostedReload(subject, 'items:reload', sentRequestId)).toBe(false);
  });

  it('R5-3a: ConversionsPanel compound write stops before addConversion if localStorage is cleared while listUnitOptions is pending', async () => {
    let resolveRefreshedUnits!: (
      opts: Array<{ code: string; labelAr: string }>,
    ) => void;
    vi.mocked(listConversions).mockResolvedValue({
      baseUnit: 'liter',
      rows: [],
    });
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'tok-1',
      emptyToken: 'tok-empty',
      identity: 'liter|ingredient||',
      lossVersions: [],
      conversions: [],
    });
    vi.mocked(listUnitOptions)
      .mockResolvedValueOnce([{ code: 'liter', labelAr: 'لتر' }])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefreshedUnits = resolve;
          }),
      );
    vi.mocked(addCustomUnit).mockResolvedValueOnce('box_1');
    vi.mocked(addConversion).mockResolvedValueOnce(undefined);

    render(<ConversionsPanel item={oilItem} />);
    await screen.findByText('مفيش تحويلات للصنف ده');

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: '__new__' },
    });
    fireEvent.change(screen.getByLabelText('كود الوحدة'), {
      target: { value: 'box_1' },
    });
    fireEvent.change(screen.getByLabelText('اسم الوحدة'), {
      target: { value: 'صندوق' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));

    await waitFor(() => {
      expect(addCustomUnit).toHaveBeenCalledTimes(1);
      expect(listUnitOptions).toHaveBeenCalledTimes(2);
    });

    // Clear durable storage while listUnitOptions is still pending!
    localStorage.clear();

    await act(async () => {
      resolveRefreshedUnits([
        { code: 'liter', labelAr: 'لتر' },
        { code: 'box_1', labelAr: 'صندوق' },
      ]);
      await Promise.resolve();
    });

    expect(
      await screen.findByText(storageWriteFailedMessage),
    ).toBeInTheDocument();
    expect(addConversion).not.toHaveBeenCalled();
  });

  it('R5-3b: accounting worker and recorder loops check durable pin before each follow-up call', async () => {
    const actualAccountingApi =
      await vi.importActual<typeof import('@/accounting/api')>(
        '@/accounting/api',
      );
    // Part 1: worker loop stops before 2nd run_accounting_work if localStorage is cleared after 1st call
    let rpcCallCount = 0;
    const rpcMock = vi.fn().mockImplementation((name: string) => {
      if (name === 'accounting_next_work') {
        return Promise.resolve({
          data: {
            status: 'ok',
            head: { order_id: 'o-1', work_generation: 1 },
          },
          error: null,
        });
      }
      if (name === 'run_accounting_work') {
        rpcCallCount += 1;
        if (rpcCallCount === 1) {
          // Clear durable pin after 1st worker call completes
          localStorage.clear();
          return Promise.resolve({
            data: {
              status: 'processed',
              processed: 1,
              applied: 1,
              unchanged: 0,
              incomplete: 0,
              none: 0,
              blocked: 0,
              disposition_pending: 0,
              failed: 0,
              remaining: 1,
              head: { order_id: 'o-2', work_generation: 1 },
              critical: null,
            },
            error: null,
          });
        }
        return Promise.resolve({
          data: {
            status: 'empty',
            processed: 0,
            applied: 0,
            unchanged: 0,
            incomplete: 0,
            none: 0,
            blocked: 0,
            disposition_pending: 0,
            failed: 0,
            remaining: 0,
            head: null,
            critical: null,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    mocks.supabaseSchema.mockReturnValue({ rpc: rpcMock });
    vi.mocked(loadProcessingSummary).mockResolvedValue(processingSummary);
    vi.mocked(runDeductions).mockImplementation(
      actualAccountingApi.runDeductions,
    );

    const view = render(<ProcessingPanel />);
    const runBtn = await screen.findByRole('button', { name: 'شغّل الخصم' });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(rpcCallCount).toBe(1);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(rpcCallCount).toBe(1);
    view.unmount();

    // Part 2: recorder backoff loop stops before 2nd recordAccountingCallFailure if durable pin disappears
    let recordCalls = 0;
    let pinPresent = true;
    const db: AccountingDb = {
      getNextWork: () =>
        Promise.resolve({
          status: 'ok',
          head: { orderId: 'o-rec', workGeneration: 1 },
        }),
      runAccountingWork: () => Promise.reject(new Error('network')),
      recordAccountingCallFailure: () => {
        recordCalls += 1;
        pinPresent = false;
        return Promise.resolve('busy');
      },
      recordAccountingRecomputeTimeout: () => Promise.resolve('recorded'),
    };
    const outcome = await runAccountingWork(db, {
      budgetMs: 10_000,
      clock: () => 0,
      newAttemptId: () => 'att-1',
      sleep: () => Promise.resolve(),
      canContinue: () => pinPresent,
    });
    expect(recordCalls).toBe(1);
    expect(outcome.report).toBe('unreported');
  });

  it('R5-4: legacy void pin without targetMonth resolves month by entry id and keeps pin if unresolved', async () => {
    const currentMonth = cairoMonthInput();
    const currentMonthStart = `${currentMonth}-01`;
    const otherMonthStart =
      currentMonth === '2025-02' ? '2025-03-01' : '2025-02-01';

    vi.mocked(loadExpenseMonth).mockResolvedValue({
      monthStart: currentMonthStart,
      categories: [
        { id: 'cat-1', name: 'إيجار', kind: 'fixed_monthly', active: true },
      ],
      entries: [],
      days: [],
      complete: false,
      confirmedAt: null,
    });

    // Case 1: Legacy void pin (no targetMonth) whose entry id resolves to otherMonthStart
    putHeldWrite('expense:void:exp-legacy-1', {
      requestId: 'req-leg-1',
      payload: {
        id: 'exp-legacy-1',
        requestId: 'req-leg-1',
        reason: 'سبب قديم',
      },
      phase: 'unknown',
      kind: 'expense_void',
    });
    rehydrateHeldWrites();
    mocks.loadExpenseEntryMonth.mockResolvedValueOnce(otherMonthStart);
    vi.mocked(voidExpenseEntry).mockResolvedValueOnce(undefined);

    const view1 = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    const retryBtn1 = await screen.findByRole('button', {
      name: 'إعادة محاولة الإلغاء',
    });
    fireEvent.click(retryBtn1);

    await waitFor(() => {
      expect(voidExpenseEntry).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 30));

    // Must resolve to otherMonthStart and NOT be cleared by currentMonthStart's reload!
    expect(hasPostedReload('expense:void:exp-legacy-1', otherMonthStart)).toBe(
      true,
    );
    view1.unmount();

    // Case 2: Legacy void pin whose month CANNOT be resolved (returns null) -> MUST keep pin!
    resetHeldWritesStore({ clearStorage: true });
    putHeldWrite('expense:void:exp-mystery', {
      requestId: 'req-leg-2',
      payload: {
        id: 'exp-mystery',
        requestId: 'req-leg-2',
        reason: 'سبب مجهول',
      },
      phase: 'unknown',
      kind: 'expense_void',
    });
    rehydrateHeldWrites();
    mocks.loadExpenseEntryMonth.mockResolvedValueOnce(null);
    vi.mocked(voidExpenseEntry).mockResolvedValueOnce(undefined);

    const view2 = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    const retryBtn2 = await screen.findByRole('button', {
      name: 'إعادة محاولة الإلغاء',
    });
    fireEvent.click(retryBtn2);

    await waitFor(() => {
      expect(voidExpenseEntry).toHaveBeenCalledTimes(2);
    });
    await new Promise((r) => setTimeout(r, 30));

    // Unresolvable month must NOT clear the pin from currentMonthStart's reload!
    expect(hasHeldWrite('expense:void:exp-mystery')).toBe(true);
    view2.unmount();
  });

  it('R5-5: second expense claim hitting busy guard cleans up its fresh inflight pin instead of stranding the page', async () => {
    let releaseVoidLockGate!: () => void;
    const mockLocks = installMockLocks(async (name) => {
      if (name.includes(encodeURIComponent('expense:void:exp-1'))) {
        await new Promise<void>((resolve) => {
          releaseVoidLockGate = resolve;
        });
      }
    });
    try {
      const currentMonth = cairoMonthInput();
      const currentMonthStart = `${currentMonth}-01`;
      vi.mocked(loadExpenseMonth).mockResolvedValue({
        monthStart: currentMonthStart,
        categories: [
          { id: 'cat-1', name: 'إيجار', kind: 'fixed_monthly', active: true },
        ],
        entries: [
          {
            id: 'exp-1',
            categoryId: 'cat-1',
            categoryName: 'إيجار',
            categoryKind: 'fixed_monthly',
            amount: '500.00',
            periodMonth: currentMonthStart,
            expenseDate: null,
            paidOn: null,
            isEstimate: false,
            note: null,
            hours: null,
            hourlyRate: null,
            driverLabel: null,
            createdAt: '2026-11-01T10:00:00.000Z',
            voided: false,
            voidReason: null,
            superseded: false,
          },
        ],
        days: [],
        complete: false,
        confirmedAt: null,
      });

      let resolveAdd!: () => void;
      vi.mocked(addExpenseEntry).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveAdd = resolve;
          }),
      );
      vi.mocked(voidExpenseEntry).mockResolvedValue(undefined);

      render(
        <MemoryRouter>
          <ExpensesPage />
        </MemoryRouter>,
      );

      // Prepare void on exp-1
      fireEvent.click(
        await screen.findByRole('button', { name: 'إلغاء المصروف' }),
      );
      fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
        target: { value: 'مكرر' },
      });
      // Click confirm void -> pauses waiting for expense:void:exp-1 lock
      fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

      // Meanwhile, submit a new expense -> acquires expense:new lock immediately and sets savingRef=true!
      fireEvent.change(screen.getByLabelText('التصنيف'), {
        target: { value: 'cat-1' },
      });
      fireEvent.change(screen.getByLabelText('المبلغ'), {
        target: { value: '200' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));

      await waitFor(() => {
        expect(addExpenseEntry).toHaveBeenCalledTimes(1);
      });

      // Now let the void claim finish acquiring its lock -> it hits runWrite's busy guard!
      await act(async () => {
        releaseVoidLockGate();
        await Promise.resolve();
      });

      // The undispatched fresh void claim MUST be cleaned up, NOT stranded as inflight!
      expect(voidExpenseEntry).not.toHaveBeenCalled();
      expect(getHeldWrite('expense:void:exp-1')).toBeNull();

      // Finish the first expense; page must become unlocked again.
      await act(async () => {
        resolveAdd();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByLabelText('مصاريف الشهر كاملة')).toBeEnabled();
      });
    } finally {
      mockLocks.restore();
    }
  });

  it('R5-6: closed order decision posted_reload pin is verified directly by order id and visible in PendingSaves', async () => {
    const closedOrderId = 'order-closed-99';
    const subject = decisionSubject(closedOrderId);
    putHeldWrite(subject, {
      requestId: 'req-closed-99',
      payload: {
        requestId: 'req-closed-99',
        orderId: closedOrderId,
        decision: 'made',
        token: 'tok-1',
        reason: null,
        returned: null,
      },
      phase: 'inflight',
    });
    markActionPostedReload(subject, 'req-closed-99', subject);
    rehydrateHeldWrites();

    vi.mocked(loadUnlinkedRefunds).mockResolvedValue([]);
    vi.mocked(loadQueuePage).mockResolvedValue({ rows: [], next: null });
    // First direct verification read fails -> pin must stay held AND be visible in PendingSaves
    vi.mocked(loadQueueRow)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(null);

    render(
      <MemoryRouter>
        <OrderDecisionsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(loadQueueRow).toHaveBeenCalledWith(closedOrderId);
    });
    expect(hasPostedReload(subject, subject)).toBe(true);
    // Must be visible in PendingSaves awaiting verification!
    const verifyBtn = await screen.findByRole('button', {
      name: 'تحديث حالة القرار',
    });
    fireEvent.click(verifyBtn);

    await waitFor(() => {
      expect(loadQueueRow).toHaveBeenCalledTimes(2);
      expect(hasPostedReload(subject, subject)).toBe(false);
    });
  });

  it('R5-8: OrderDecisionsPage preserves typed drafts on page 2 across offline -> online reconnect', async () => {
    const row1 = queueRow({
      orderId: 'order-p1',
      orderNumber: 101,
      token: 'tok-p1',
      eventId: 1,
      decision: 'not_made',
      currentClass: 'canceled',
      decidedClass: 'canceled',
    });
    const row2 = queueRow({
      orderId: 'order-p2',
      orderNumber: 102,
      token: 'tok-p2',
      eventId: 2,
      decision: 'not_made',
      currentClass: 'canceled',
      decidedClass: 'canceled',
    });

    vi.mocked(loadUnlinkedRefunds).mockResolvedValue([]);
    vi.mocked(loadQueuePage).mockImplementation((_filter, after) => {
      if (after === null) {
        return Promise.resolve({ rows: [row1], next: 'order-p1' });
      }
      if (after === 'order-p1') {
        return Promise.resolve({ rows: [row2], next: null });
      }
      return Promise.resolve({ rows: [], next: null });
    });

    render(
      <MemoryRouter>
        <OrderDecisionsPage />
      </MemoryRouter>,
    );
    await screen.findByRole('article', { name: 'طلب رقم 101' });
    fireEvent.click(screen.getByRole('button', { name: 'عرض المزيد' }));
    const card2 = await screen.findByRole('article', { name: 'طلب رقم 102' });

    fireEvent.click(within(card2).getByRole('radio', { name: 'اتعمل' }));
    fireEvent.change(within(card2).getByLabelText('سبب تغيير القرار'), {
      target: { value: 'سبب الصفحة التانية' },
    });

    // Go offline then back online (triggers reconnect refresh)
    act(() => {
      setNavigatorOnline(false);
    });
    expect(within(card2).getByLabelText('سبب تغيير القرار')).toHaveValue(
      'سبب الصفحة التانية',
    );

    const callsBeforeReconnect = vi.mocked(loadQueuePage).mock.calls.length;
    act(() => {
      setNavigatorOnline(true);
    });

    await waitFor(() => {
      expect(vi.mocked(loadQueuePage).mock.calls.length).toBeGreaterThan(
        callsBeforeReconnect,
      );
    });

    // Page-2 card MUST still be mounted with its typed draft preserved!
    const card2After = screen.getByRole('article', { name: 'طلب رقم 102' });
    expect(within(card2After).getByLabelText('سبب تغيير القرار')).toHaveValue(
      'سبب الصفحة التانية',
    );
  });
});
