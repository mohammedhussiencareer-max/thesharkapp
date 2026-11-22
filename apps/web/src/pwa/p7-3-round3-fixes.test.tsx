import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateInventory,
  loadOpeningReview,
  loadOrderCost,
  loadProcessingSummary,
  loadShiftStatuses,
  recordRunFailure,
  runDeductions,
} from '@/accounting/api';
import { ACTIVATION_SUBJECT } from '@/accounting/activation-action';
import { ProcessingPanel } from '@/accounting/ProcessingPanel';
import { accountingRunSubject, type RunHeld } from '@/accounting/run';
import type {
  OpeningReview,
  OrderCostDetail,
  ProcessingSummary,
} from '@/accounting/types';
import { listCounts, listDailyItems, listPendingCounts } from '@/counts/api';
import {
  addExpenseEntry,
  loadExpenseMonth,
  voidExpenseEntry,
} from '@/expenses/api';
import type { ExpenseMonth } from '@/expenses/types';
import {
  addConversion,
  addCustomUnit,
  listConversions,
  listCostingSchedule,
  listItems,
  listUnitOptions,
} from '@/items/api';
import { ConversionsPanel } from '@/items/ConversionsPanel';
import {
  claimFreshAction,
  markActionPostedReload,
  resetHeldWrites,
} from '@/items/request-id';
import type { CatalogItem } from '@/items/types';
import { cairoMonthInput } from '@/lib/cairo';
import {
  beginHeldWrite,
  clearHeldWrite,
  getHeldWrite,
  hasPostedReload,
  putHeldWrite,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWriteUser,
  storageWriteFailedMessage,
  userStoragePrefix,
} from '@/lib/held-writes';
import {
  applyPwaUpdate,
  initPwa,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import {
  loadBases,
  loadCatalog,
  loadCoverage,
  loadSubjectDetail,
  setBaseMapping,
} from '@/mapping/api';
import { baseSubject } from '@/mapping/subjects';
import type {
  Coverage,
  MappingCatalog,
  ObservedBase,
  SubjectDetail,
} from '@/mapping/types';
import {
  loadQueuePage,
  loadUnlinkedRefunds,
  setOrderDisposition,
} from '@/order-decisions/api';
import { DecisionForm } from '@/order-decisions/DecisionForm';
import { decisionSubject } from '@/order-decisions/format';
import type { QueueRow } from '@/order-decisions/types';
import {
  loadObservedOrderTypes,
  loadOrderTypePackaging,
  loadPackagingCatalog,
  setOrderTypePackaging,
} from '@/packaging/api';
import { orderTypePackagingSubject } from '@/packaging/subjects';
import type {
  ObservedOrderType,
  PackagingCatalog,
  PackagingDetail,
} from '@/packaging/types';
import { ActivationPage } from '@/pages/ActivationPage';
import { CountsPage } from '@/pages/CountsPage';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ItemsPage } from '@/pages/ItemsPage';
import { MappingPage } from '@/pages/MappingPage';
import { OrderCostPage } from '@/pages/OrderCostPage';
import { OrderDecisionsPage } from '@/pages/OrderDecisionsPage';
import { PackagingPage } from '@/pages/PackagingPage';
import { PurchasesPage } from '@/pages/PurchasesPage';
import { SortingPage } from '@/pages/SortingPage';
import { WastePage } from '@/pages/WastePage';
import {
  listPurchases,
  listStockChoices,
  listUnitsAt,
  recordPurchase,
} from '@/purchases/api';
import type { StockChoice } from '@/purchases/types';
import { loadShiftDetail } from '@/sales/api';
import { ShiftDetailLoader } from '@/sales/ShiftDetailLoader';
import type { ShiftDetail } from '@/sales/types';
import { listMixedFish, listSorts } from '@/sorting/api';
import { loadHistoryPage, recordWaste } from '@/waste/api';
import { newWasteSubject } from '@/waste/format';
import { useWasteAction } from '@/waste/useWasteAction';

vi.mock('@/accounting/api', () => ({
  loadProcessingSummary: vi.fn(),
  runDeductions: vi.fn(),
  recordRunFailure: vi.fn(),
  retryParkedOrder: vi.fn(),
  loadOpeningReview: vi.fn(),
  activateInventory: vi.fn(),
  loadShiftStatuses: vi.fn(),
  loadOrderCost: vi.fn(),
}));

vi.mock('@/mapping/api', () => ({
  loadBases: vi.fn(),
  loadCatalog: vi.fn(),
  loadCoverage: vi.fn(),
  loadSubjectDetail: vi.fn(),
  setBaseMapping: vi.fn(),
  setOptionPolicy: vi.fn(),
  setException: vi.fn(),
  setOptionMapping: vi.fn(),
}));

vi.mock('@/packaging/api', () => ({
  loadObservedOrderTypes: vi.fn(),
  loadPackagingCatalog: vi.fn(),
  loadOrderTypePackaging: vi.fn(),
  setBasePackaging: vi.fn(),
  setOrderTypePackaging: vi.fn(),
}));

vi.mock('@/waste/api', () => ({
  historyPageSize: 20,
  loadHistoryPage: vi.fn(),
  recordWaste: vi.fn(),
}));

vi.mock('@/order-decisions/api', () => ({
  loadQueuePage: vi.fn(),
  loadQueueRow: vi.fn(),
  loadUnlinkedRefunds: vi.fn(),
  setOrderDisposition: vi.fn(),
}));

vi.mock('@/items/api', () => ({
  listItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  setItemLoss: vi.fn(),
  setOpeningPrice: vi.fn(),
  listConversions: vi.fn(),
  listUnitOptions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
  addCustomUnit: vi.fn(),
  currentShiftStart: vi.fn(() => Promise.resolve(null)),
  listCostingSchedule: vi.fn(),
}));

vi.mock('@/expenses/api', () => ({
  loadExpenseMonth: vi.fn(),
  addExpenseEntry: vi.fn(),
  voidExpenseEntry: vi.fn(),
  addExpenseCategory: vi.fn(),
  renameExpenseCategory: vi.fn(),
  setExpenseCategoryActive: vi.fn(),
  setMonthExpenseComplete: vi.fn(),
}));

vi.mock('@/purchases/api', () => ({
  listStockChoices: vi.fn(),
  listPurchases: vi.fn(),
  listUnitsAt: vi.fn(() => Promise.resolve({})),
  recordPurchase: vi.fn(),
  recordOpeningStock: vi.fn(),
}));

vi.mock('@/counts/api', () => ({
  listDailyItems: vi.fn(),
  listCounts: vi.fn(),
  listPendingCounts: vi.fn(),
  recordCount: vi.fn(),
  recordStoredCount: vi.fn(),
}));

vi.mock('@/sorting/api', () => ({
  listMixedFish: vi.fn(),
  listSorts: vi.fn(),
  recordSort: vi.fn(),
}));

vi.mock('@/sales/api', () => ({
  loadShiftDetail: vi.fn(),
}));

function setNavigatorOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value,
  });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

function WasteActionHarness({ reload }: { reload: () => Promise<void> }) {
  const action = useWasteAction(newWasteSubject, { reload });
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          action.send((requestId) => ({
            requestId,
            document: {
              kind: 'record',
              occurredAt: '2026-10-15T10:00:00.000Z',
              reason: 'spoilage',
              explanation: null,
              lines: [{ itemId: 'oil', quantity: '1', unit: 'kg' }],
            },
          }))
        }
      >
        send-waste
      </button>
      {action.held ? (
        <button type="button" onClick={action.retry}>
          retry-waste
        </button>
      ) : null}
      {action.notice ? (
        <p role="alert">
          {action.notice.kind === 'failed'
            ? action.notice.message
            : (action.notice.warning ?? 'saved')}
        </p>
      ) : null}
    </div>
  );
}

describe('P7-3 round-3 review fixes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listUnitsAt).mockResolvedValue({});
    localStorage.clear();
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetPwaState();
    setNavigatorOnline(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetPwaState();
    setNavigatorOnline(true);
  });

  it('R3-1c: ProcessingPanel replays an existing unknown run pin from storage instead of starting a fresh run', async () => {
    const summary: ProcessingSummary = {
      activated: true,
      pendingCount: '1',
      blockedCount: '0',
      failedCount: '0',
      processedEventCount: '0',
      openEventCount: '1',
      openSpanCount: '0',
      coverage: null,
      parked: [],
      parkedCount: '0',
      parkedTruncated: false,
    };
    vi.mocked(loadProcessingSummary).mockResolvedValue(summary);
    vi.mocked(recordRunFailure).mockResolvedValue('recorded');
    vi.mocked(runDeductions).mockResolvedValue({
      stop: 'empty',
      calls: 1,
      counts: {
        processed: 1,
        applied: 1,
        unchanged: 0,
        none: 0,
        incomplete: 0,
        blocked: 0,
        dispositionPending: 0,
        failed: 0,
        remaining: 0,
      },
      criticalOrderId: null,
      report: 'not_needed',
      cause: null,
    });

    render(<ProcessingPanel />);
    const runBtn = await screen.findByRole('button', { name: 'شغّل الخصم' });

    // Another tab wrote an unknown accounting run pin directly to localStorage
    // before this tab received a storage event.
    const existingPin: RunHeld = {
      requestId: 'req-existing-run',
      report: {
        attemptId: 'att-bound-1',
        orderId: 'order-99',
        workGeneration: 3,
        failureKind: 'escaped',
      },
    };
    const key = `${userStoragePrefix('__local__')}${encodeURIComponent(accountingRunSubject)}`;
    localStorage.setItem(
      key,
      JSON.stringify({
        v: 1,
        subject: accountingRunSubject,
        kind: 'action',
        requestId: existingPin.requestId,
        payload: existingPin,
        phase: 'unknown',
      }),
    );

    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(recordRunFailure).toHaveBeenCalledWith(existingPin.report);
    });
    expect(runDeductions).not.toHaveBeenCalled();
  });

  it('R3-2a: MappingPage switching from subject A to B during A refresh does not clear A posted_reload from B read', async () => {
    const baseA: ObservedBase = {
      posItemId: 'pos-a',
      sizeKey: ['none'],
      sizeKeyText: '',
      itemName: 'سمكة أ',
      mapStatus: 'incomplete',
      saleCount: 2,
      lastOrderedAt: '2026-10-15T10:00:00.000Z',
      latestOrderId: 'ord-a',
      latestLineId: 'line-a',
    };
    const baseB: ObservedBase = {
      posItemId: 'pos-b',
      sizeKey: ['none'],
      sizeKeyText: '',
      itemName: 'سمكة ب',
      mapStatus: 'incomplete',
      saleCount: 1,
      lastOrderedAt: '2026-10-15T10:00:00.000Z',
      latestOrderId: 'ord-b',
      latestLineId: 'line-b',
    };
    const catalog: MappingCatalog = {
      items: [
        {
          id: 'item-1',
          name: 'بلطي',
          baseUnit: 'kg',
        },
      ],
      packagingItems: [],
      recipes: [],
      units: [{ code: 'kg', label: 'كيلو' }],
      shiftStart: null,
    };
    const coverage: Coverage = {
      eligibleLines: 2,
      coveredLines: 0,
      readyLines: 0,
      incompleteLines: 2,
      exceptionLines: 0,
      coverage: 0,
      causes: { canceled: 0, open: 0, missing: 0, beforeStockStart: 0 },
      stockStart: null,
      orders: {
        ready: 0,
        incomplete: 2,
        eligible: 2,
        coverage: 0,
        causes: { line: 2, packagingUnreviewed: 0, blocked: 0 },
        excluded: { canceled: 0, open: 0, missing: 0, beforeStockStart: 0 },
      },
      orderTypes: [],
    };
    const makeDetail = (subjectId: string): SubjectDetail => ({
      schedule: {
        subjectId,
        token: `tok-${subjectId}`,
        emptyToken: `etok-${subjectId}`,
        versions: [],
      },
      history: [],
      optionBindings: [],
      optionHistory: [],
      options: [],
      packaging: {
        schedule: {
          subjectId: `p-${subjectId}`,
          token: 'ptok',
          emptyToken: 'petok',
          versions: [],
        },
        history: [],
      },
      suggestions: [],
      resolution: { status: 'incomplete', issues: [], requirements: [] },
    });

    let resolveSecondBases!: (rows: ObservedBase[]) => void;
    let basesCalls = 0;
    vi.mocked(loadBases).mockImplementation(() => {
      basesCalls += 1;
      if (basesCalls === 1) return Promise.resolve([baseA, baseB]);
      return new Promise((resolve) => {
        resolveSecondBases = resolve;
      });
    });
    vi.mocked(loadCatalog).mockResolvedValue(catalog);
    vi.mocked(loadCoverage).mockResolvedValue(coverage);
    vi.mocked(loadSubjectDetail).mockImplementation((base) =>
      Promise.resolve(makeDetail(base.posItemId)),
    );
    vi.mocked(setBaseMapping).mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <MappingPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /سمكة أ/ }));
    const select = await screen.findByLabelText('الصنف');
    fireEvent.change(select, { target: { value: 'item-1' } });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'kg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));

    const subjectA = baseSubject('pos-a', '');
    await waitFor(() => {
      expect(setBaseMapping).toHaveBeenCalledTimes(1);
      expect(hasPostedReload(subjectA, subjectA)).toBe(true);
    });

    // While A's post-write reload is still waiting on loadBases, switch to B.
    fireEvent.click(screen.getByRole('button', { name: /سمكة ب/ }));
    await screen.findByRole('heading', { name: /سمكة ب/ });

    // Now finish A's superseded loadBases call.
    await act(async () => {
      resolveSecondBases([baseA, baseB]);
      await Promise.resolve();
    });

    // A's posted_reload pin MUST still be held because B was loaded, not A.
    expect(hasPostedReload(subjectA, subjectA)).toBe(true);
  });

  it('R3-2b: PackagingPage switching from type A to B during A refresh does not clear A posted_reload from B read', async () => {
    const typeA: ObservedOrderType = {
      key: 'takeaway',
      keyText: 'takeaway',
      label: 'takeaway',
      orderCount: 3,
      lastOrderedAt: '2026-10-15T10:00:00.000Z',
    };
    const typeB: ObservedOrderType = {
      key: 'delivery',
      keyText: 'delivery',
      label: 'delivery',
      orderCount: 2,
      lastOrderedAt: '2026-10-15T10:00:00.000Z',
    };
    const catalog: PackagingCatalog = {
      items: [],
      units: [],
      shiftStart: null,
    };
    const coverage: Coverage = {
      eligibleLines: 0,
      coveredLines: 0,
      readyLines: 0,
      incompleteLines: 0,
      exceptionLines: 0,
      coverage: null,
      causes: { canceled: 0, open: 0, missing: 0, beforeStockStart: 0 },
      stockStart: null,
      orders: {
        ready: 0,
        incomplete: 5,
        eligible: 5,
        coverage: 0,
        causes: { line: 0, packagingUnreviewed: 5, blocked: 0 },
        excluded: { canceled: 0, open: 0, missing: 0, beforeStockStart: 0 },
      },
      orderTypes: [],
    };
    const makeDetail = (key: string): PackagingDetail => ({
      schedule: {
        subjectId: `ot-${key}`,
        token: `tok-${key}`,
        emptyToken: `etok-${key}`,
        versions: [],
      },
      history: [],
    });

    let resolveSecondTypes!: (rows: ObservedOrderType[]) => void;
    let typesCalls = 0;
    vi.mocked(loadObservedOrderTypes).mockImplementation(() => {
      typesCalls += 1;
      if (typesCalls === 1) return Promise.resolve([typeA, typeB]);
      return new Promise((resolve) => {
        resolveSecondTypes = resolve;
      });
    });
    vi.mocked(loadPackagingCatalog).mockResolvedValue(catalog);
    vi.mocked(loadCoverage).mockResolvedValue(coverage);
    vi.mocked(loadOrderTypePackaging).mockImplementation((label) =>
      Promise.resolve(makeDetail(label ?? 'none')),
    );
    vi.mocked(setOrderTypePackaging).mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <PackagingPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /takeaway/ }));
    const saveBtn = await screen.findByRole('button', { name: 'احفظ التغليف' });
    fireEvent.click(saveBtn);

    const subjectA = orderTypePackagingSubject('takeaway');
    await waitFor(() => {
      expect(hasPostedReload(subjectA, subjectA)).toBe(true);
    });

    // Switch to type B while type A's refresh is still in flight.
    fireEvent.click(screen.getByRole('button', { name: /delivery/ }));
    await waitFor(() => {
      expect(loadOrderTypePackaging).toHaveBeenCalledWith('delivery');
    });

    await act(async () => {
      resolveSecondTypes([typeA, typeB]);
      await Promise.resolve();
    });

    expect(hasPostedReload(subjectA, subjectA)).toBe(true);
  });

  it('R3-2c: claimFreshAction does not discard an existing posted_reload pin on a second submit', async () => {
    const subject = 'mapping:base:pos-1:';
    const first = await claimFreshAction(subject, (requestId) => ({
      requestId,
      n: 1,
    }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    markActionPostedReload(subject, first.record.requestId, subject);
    first.release();
    expect(hasPostedReload(subject, subject)).toBe(true);

    const second = await claimFreshAction(subject, (requestId) => ({
      requestId,
      n: 2,
    }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.record.requestId).not.toBe(first.record.requestId);
    second.release();
    // First posted_reload pin MUST NOT be discarded by the second submit.
    expect(hasPostedReload(subject, subject)).toBe(true);
  });

  it('R3-2d: activation moves to posted_reload after activateInventory succeeds and clears only after loadOpeningReview succeeds', async () => {
    const review: OpeningReview = {
      activated: false,
      stockStartedAt: null,
      openingManifestHash: 'hash-1',
      canActivate: true,
      checklist: [{ code: 'unreceipted_outflows', ready: true, count: '0' }],
      roster: [
        {
          itemId: 'oil',
          name: 'زيت',
          baseUnit: 'kg',
          active: true,
          missing: false,
          openingLineCount: '1',
          observation: {
            openingId: 'op-1',
            lineNo: '1',
            quantity: '10',
            unit: 'kg',
            unitCost: '50',
            occurredAt: '2026-10-15T09:00:00.000Z',
            explicitZero: false,
          },
        },
      ],
      nextItemId: null,
    };
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(review)
      .mockRejectedValueOnce(new Error('reload failed'));
    vi.mocked(activateInventory).mockResolvedValue({
      activated: true,
      stockStartedAt: '2026-10-15T10:00:00.000Z',
      openingManifestHash: 'hash-1',
    });

    render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'تفعيل الخصم' }));
    await screen.findByText(/تحديث السجل فشل/);

    // Post-write reload failed: activation MUST remain in posted_reload.
    expect(hasPostedReload(ACTIVATION_SUBJECT, ACTIVATION_SUBJECT)).toBe(true);
  });

  it('R3-2e: useWasteAction moves to posted_reload after recordWaste succeeds and clears only after reload succeeds', async () => {
    vi.mocked(recordWaste).mockResolvedValue({
      documentId: 'w-1',
      predecessorId: null,
      kind: 'record',
      occurredAt: '2026-10-15T10:00:00.000Z',
      reason: 'spoilage',
      lines: [],
      differences: {
        stockQuantity: '0',
        stockValue: '0',
        cogs: '0',
        waste: '10',
        profit: '-10',
      },
    });
    const reload = vi.fn().mockRejectedValueOnce(new Error('reload failed'));

    render(<WasteActionHarness reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'send-waste' }));

    await screen.findByText(/تحديث السجل فشل/);
    expect(hasPostedReload(newWasteSubject, newWasteSubject)).toBe(true);
  });

  it('R3-2f: DecisionForm moves to posted_reload after setOrderDisposition succeeds and clears only after onChanged succeeds', async () => {
    const row: QueueRow = {
      orderId: 'ord-42',
      episode: 1,
      currentClass: 'canceled',
      decidedClass: 'canceled',
      reviewReason: null,
      token: 'tok-42',
      needsDecision: true,
      eventId: 1,
      decision: 'not_made',
      source: 'system_default',
      ownerReviewed: false,
      decisionReason: null,
      decidedAt: '2026-10-15T10:00:00.000Z',
      orderNumber: 42,
      orderedAt: '2026-10-15T10:00:00.000Z',
      orderStatus: 'canceled',
      missingFromPos: false,
      orderTotal: '100',
      decidedOrderTotal: '100',
      refundTotal: '100',
      decidedRefundTotal: '100',
      basisStatus: 'ready',
      basisItems: [],
      refunds: [],
      returned: [],
      differences: {
        stockQuantity: '0',
        stockValue: '0',
        cogs: '0',
        waste: '0',
        profit: '0',
      },
      history: [],
    };
    vi.mocked(setOrderDisposition).mockResolvedValue({
      status: 'ok',
      orderId: 'ord-42',
      eventId: 1,
      decision: 'not_made',
      decisionClass: 'canceled',
      outcome: 'saved',
      reason: null,
      differences: {
        stockQuantity: '0',
        stockValue: '0',
        cogs: '0',
        waste: '0',
        profit: '0',
      },
    });
    const onChanged = vi.fn().mockRejectedValueOnce(new Error('reload failed'));
    const onNotice = vi.fn();

    render(
      <DecisionForm row={row} onNotice={onNotice} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));

    await waitFor(() => {
      const savedCall = onNotice.mock.calls.find(
        (args) =>
          args[0] &&
          typeof args[0] === 'object' &&
          (args[0] as { kind?: string }).kind === 'saved',
      );
      expect(savedCall).toBeDefined();
      expect((savedCall?.[0] as { warning?: string | null }).warning).toContain(
        'تحديث الشاشة فشل',
      );
    });
    const subj = decisionSubject('ord-42');
    expect(hasPostedReload(subj, subj)).toBe(true);
  });

  it('R3-3: ConversionsPanel blocks addConversion after sign-out + re-sign-in to the SAME user during addCustomUnit', async () => {
    setHeldWriteUser('user-a');
    const item: CatalogItem = {
      id: 'item-1',
      name: 'بلطي',
      kind: 'fish_size',
      baseUnit: 'kg',
      countFrequency: 'daily',
      parentItemId: null,
      lossPct: null,
      active: true,
      onHandQty: 10,
      avgCost: 50,
      onHandValue: 500,
    };
    vi.mocked(listConversions).mockResolvedValue({
      baseUnit: 'kg',
      rows: [],
    });
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'ltok',
      emptyToken: 'etok',
      identity: 'kg|fish_size||',
      lossVersions: [],
      conversions: [],
    });
    let resolveUnit!: (code: string) => void;
    vi.mocked(addCustomUnit).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveUnit = resolve;
        }),
    );
    vi.mocked(listUnitOptions).mockResolvedValue([
      { code: 'kg', labelAr: 'كيلو' },
      { code: 'box', labelAr: 'صندوق' },
    ]);
    vi.mocked(addConversion).mockResolvedValue(undefined);

    render(<ConversionsPanel item={item} />);
    await screen.findByLabelText('الوحدة');

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: '__new__' },
    });
    fireEvent.change(screen.getByLabelText('اسم الوحدة'), {
      target: { value: 'جركن' },
    });
    fireEvent.change(screen.getByLabelText('كود الوحدة'), {
      target: { value: 'jerry' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));

    await waitFor(() => {
      expect(addCustomUnit).toHaveBeenCalledTimes(1);
    });

    // Sign out and sign back in to the EXACT same user while addCustomUnit is pending.
    setHeldWriteUser(null);
    setHeldWriteUser('user-a');

    await act(async () => {
      resolveUnit('box');
      await Promise.resolve();
    });

    // Stale continuation must NOT dispatch addConversion.
    expect(addConversion).not.toHaveBeenCalled();
  });

  it('R3-4a: useWasteAction retry refuses to call recordWaste and shows storageWriteFailedMessage when localStorage was cleared', async () => {
    vi.mocked(recordWaste).mockRejectedValueOnce(new Error('network lost'));
    const reload = vi.fn().mockResolvedValue(undefined);

    render(<WasteActionHarness reload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: 'send-waste' }));

    const retryBtn = await screen.findByRole('button', { name: 'retry-waste' });
    expect(recordWaste).toHaveBeenCalledTimes(1);

    // Wipe localStorage underneath the mounted component (simulating iOS purge / storage cleared).
    localStorage.clear();

    fireEvent.click(retryBtn);
    await screen.findByText(storageWriteFailedMessage);
    expect(recordWaste).toHaveBeenCalledTimes(1);
  });

  it('R3-4b: ExpensesPage surfaces storageWriteFailedMessage on submit and void instead of swallowing __pin_blocked__', async () => {
    const currentMonthStart = `${cairoMonthInput()}-01`;
    const monthData: ExpenseMonth = {
      monthStart: currentMonthStart,
      complete: false,
      confirmedAt: null,
      categories: [
        { id: 'cat-1', name: 'كهرباء', kind: 'fixed_monthly', active: true },
      ],
      entries: [
        {
          id: 'exp-1',
          categoryId: 'cat-1',
          categoryName: 'كهرباء',
          categoryKind: 'fixed_monthly',
          periodMonth: currentMonthStart,
          expenseDate: null,
          paidOn: null,
          isEstimate: false,
          amount: '150.00',
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
    };
    vi.mocked(loadExpenseMonth).mockResolvedValue(monthData);

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );

    await screen.findByText('150.00 ج.م');

    // Make localStorage.setItem fail with QuotaExceededError.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    // Select category and submit a new expense.
    fireEvent.change(screen.getByLabelText('التصنيف'), {
      target: { value: 'cat-1' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));

    expect(
      await screen.findByText(storageWriteFailedMessage),
    ).toBeInTheDocument();
    expect(addExpenseEntry).not.toHaveBeenCalled();

    // Try voiding an existing expense.
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
      target: { value: 'غلط' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await waitFor(() => {
      expect(
        screen.getAllByText(storageWriteFailedMessage).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(voidExpenseEntry).not.toHaveBeenCalled();
  });

  it('R3-5: PurchasesPage stores only retry fields (no itemName, baseQuantity, or unitCost) and restores labels on reload', async () => {
    const oil: StockChoice = {
      id: 'oil',
      name: 'زيت عباد',
      kind: 'ingredient',
      baseUnit: 'kg',
      parentItemId: null,
      active: true,
      hasMovements: false,
      conversions: [{ unit: 'can', factorToBase: '5', label: 'جركن' }],
    };
    vi.mocked(listStockChoices).mockResolvedValue([oil]);
    vi.mocked(listPurchases).mockResolvedValue([]);
    vi.mocked(listUnitsAt).mockResolvedValue({
      oil: [{ unit: 'can', factorToBase: '5', label: 'جركن' }],
    });
    vi.mocked(recordPurchase).mockRejectedValueOnce(
      new Error('Failed to fetch'),
    );

    const { unmount } = render(
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>,
    );

    await screen.findByLabelText('الصنف');
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'oil' },
    });
    fireEvent.change(screen.getByLabelText('الكمية'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ' }));

    await waitFor(() => {
      expect(recordPurchase).toHaveBeenCalledTimes(1);
    });

    const storageKey = `${userStoragePrefix('__local__')}${encodeURIComponent('purchase:new')}`;
    const raw = localStorage.getItem(storageKey);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      payload: { lines: Array<Record<string, unknown>> };
    };
    expect(parsed.payload.lines[0]).not.toHaveProperty('itemName');
    expect(parsed.payload.lines[0]).not.toHaveProperty('baseQuantity');
    expect(parsed.payload.lines[0]).not.toHaveProperty('unitCost');

    // Reload: item name and derived baseQuantity/unitCost are restored from catalog + math.
    unmount();
    rehydrateHeldWrites();
    render(
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/زيت عباد/)).toBeInTheDocument();
  });

  it('R3-6: deferred PWA reload does not get stuck if a pin appears between approval and controllerchange', () => {
    const swListeners = new Map<string, Array<() => void>>();
    const register = vi.fn().mockResolvedValue({
      waiting: null,
      addEventListener: vi.fn(),
    });
    const originalSw = Object.getOwnPropertyDescriptor(
      navigator,
      'serviceWorker',
    );
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register,
        addEventListener: (event: string, fn: () => void) => {
          const list = swListeners.get(event) ?? [];
          list.push(fn);
          swListeners.set(event, list);
        },
        controller: {},
      },
    });
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_PWA', '1');

    try {
      const reload = vi.fn();
      const postMessage = vi.fn();
      initPwa(reload);
      setPwaAuthResolved(true);
      setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

      // Owner approves update while no pin exists -> SKIP_WAITING sent.
      expect(applyPwaUpdate(reload, { authResolved: true })).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

      // A pin appears before controllerchange fires!
      const pin = beginHeldWrite('count:daily', (requestId) => ({ requestId }));
      for (const fn of swListeners.get('controllerchange') ?? []) fn();
      // Reload MUST be skipped while pinned.
      expect(reload).not.toHaveBeenCalled();

      // Now the pin clears and owner clicks update again — worker already activated
      // so there will be NO second controllerchange!
      clearHeldWrite('count:daily', pin.requestId);
      expect(applyPwaUpdate(reload, { authResolved: true })).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      if (originalSw) {
        Object.defineProperty(navigator, 'serviceWorker', originalSw);
      } else {
        delete (navigator as unknown as { serviceWorker?: unknown })
          .serviceWorker;
      }
    }
  });

  it('R3-7a: ExpensesPage reconciles an unknown void pin when reloaded month proves the entry is already voided', async () => {
    const currentMonthStart = `${cairoMonthInput()}-01`;
    const voidedMonth: ExpenseMonth = {
      monthStart: currentMonthStart,
      complete: false,
      confirmedAt: null,
      categories: [],
      entries: [
        {
          id: 'exp-voided',
          categoryId: 'cat-1',
          categoryName: 'كهرباء',
          categoryKind: 'fixed_monthly',
          periodMonth: currentMonthStart,
          expenseDate: null,
          paidOn: null,
          isEstimate: false,
          amount: '150.00',
          note: null,
          hours: null,
          hourlyRate: null,
          driverLabel: null,
          createdAt: '2026-11-01T10:00:00.000Z',
          voided: true,
          voidReason: 'مكرر',
          superseded: false,
        },
      ],
      days: [],
    };
    putHeldWrite('expense:void:exp-voided', {
      requestId: 'req-void-1',
      payload: { id: 'exp-voided', requestId: 'req-void-1', reason: 'مكرر' },
      phase: 'unknown',
      kind: 'expense_void',
    });
    vi.mocked(loadExpenseMonth).mockResolvedValue(voidedMonth);

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );

    await screen.findByText('كهرباء');
    await waitFor(() => {
      expect(getHeldWrite('expense:void:exp-voided')).toBeNull();
    });
  });

  it('R3-7b: ExpensesPage renders an explicit retry control for an unknown void pin even when entry is not in loaded month', async () => {
    const currentMonthStart = `${cairoMonthInput()}-01`;
    const emptyMonth: ExpenseMonth = {
      monthStart: currentMonthStart,
      complete: false,
      confirmedAt: null,
      categories: [],
      entries: [],
      days: [],
    };
    putHeldWrite('expense:void:exp-other-month', {
      requestId: 'req-void-other',
      payload: {
        id: 'exp-other-month',
        requestId: 'req-void-other',
        reason: 'سبب مفقود',
      },
      phase: 'unknown',
      kind: 'expense_void',
    });
    vi.mocked(loadExpenseMonth).mockResolvedValue(emptyMonth);
    vi.mocked(voidExpenseEntry).mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );

    const retryVoidBtn = await screen.findByRole('button', {
      name: /إعادة محاولة الإلغاء/,
    });
    expect(screen.getByText(/سبب مفقود/)).toBeInTheDocument();

    fireEvent.click(retryVoidBtn);
    await waitFor(() => {
      expect(voidExpenseEntry).toHaveBeenCalledWith(
        'exp-other-month',
        'سبب مفقود',
        'req-void-other',
      );
    });
  });

  it('R3-8a: ShiftDetailLoader hides monetary values while offline and refetches on reconnect', async () => {
    const detail: ShiftDetail = {
      summary: {
        shiftId: 'sh-1',
        openedAt: '2026-10-15T09:00:00.000Z',
        closedAt: '2026-10-16T01:00:00.000Z',
        isActive: false,
        ordersComplete: 1,
        grossSales: '100.00',
        refunds: '25.00',
        netSales: '75.00',
        ordersCanceled: 0,
        ordersOpen: 0,
        ordersMissing: 0,
        drawerTotal: '75.00',
        drawerDifference: '0.00',
        unknownTx: 0,
      },
      orders: [],
    };
    vi.mocked(loadShiftDetail).mockResolvedValue(detail);
    vi.mocked(loadShiftStatuses).mockResolvedValue({
      byId: new Map(),
      capped: false,
    });

    render(
      <MemoryRouter>
        <ShiftDetailLoader shiftId="sh-1" />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('صافي المبيعات 75.00 ج.م'),
    ).toBeInTheDocument();
    expect(loadShiftDetail).toHaveBeenCalledTimes(1);

    // Go offline: monetary values MUST be hidden.
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/75\.00 ج\.م/)).not.toBeInTheDocument();
    expect(screen.queryByText(/25\.00 ج\.م/)).not.toBeInTheDocument();

    // Come back online: must refetch shift detail and show fresh numbers.
    act(() => setNavigatorOnline(true));
    await waitFor(() => {
      expect(loadShiftDetail).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText('صافي المبيعات 75.00 ج.م'),
    ).toBeInTheDocument();
  });

  it('R3-8b: OrderCostPage, ItemsPage, CountsPage, PurchasesPage, ExpensesPage, OrderDecisionsPage, WastePage, SortingPage, and ActivationPage hide cached money offline and refetch on reconnect', async () => {
    const currentMonthStart = `${cairoMonthInput()}-01`;
    // OrderCostPage
    const costDetail: OrderCostDetail = {
      found: true,
      orderId: 'ord-1',
      orderNumber: '1',
      input: {
        inputId: 'in-1',
        inputRevision: '1',
        snapshotId: 'snap-1',
        snapshotVersion: '1',
        missingFromPos: false,
        digest: 'd',
      },
      state: {
        disposition: 'sale',
        latestApplicationId: 'app-1',
        ownerApplicationId: 'app-1',
        causes: [],
      },
      applications: [
        {
          id: 'app-1',
          receiptKind: 'posting',
          disposition: 'sale',
          costInputId: 'in-1',
          inputRevision: '1',
          snapshotId: 'snap-1',
          snapshotVersion: '1',
          predecessorId: null,
          retiredApplicationId: null,
          movementOwnerId: 'app-1',
          occurredAt: '2026-10-15T10:00:00.000Z',
          shiftId: 'sh-1',
          algorithmVersion: '1',
          signature: 'sig',
          createdAt: '2026-10-15T10:00:00.000Z',
          lines: [],
          posted: [
            {
              movementId: 'mov-1',
              movementType: 'sale',
              itemId: 'item-1',
              name: 'بلطي',
              quantity: '1',
              totalCost: '88.50',
              occurredAt: '2026-10-15T10:00:00.000Z',
            },
          ],
          provenance: {
            mappingVersions: [],
            recipeVersions: [],
            packagingVersions: [],
            lossVersions: [],
            conversionVersions: [],
            algorithmVersion: '1',
          },
          reversals: [],
          adjustments: [],
        },
      ],
    };
    vi.mocked(loadOrderCost).mockResolvedValue(costDetail);
    const costView = render(
      <MemoryRouter initialEntries={['/orders/ord-1']}>
        <Routes>
          <Route path="/orders/:orderId" element={<OrderCostPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/88\.50/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/88\.50/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(loadOrderCost).toHaveBeenCalledTimes(2));
    costView.unmount();

    // ItemsPage
    vi.mocked(listItems).mockResolvedValue([
      {
        id: 'i-1',
        name: 'سمك',
        kind: 'fish_size',
        baseUnit: 'kg',
        countFrequency: 'daily',
        parentItemId: null,
        lossPct: null,
        active: true,
        onHandQty: 2,
        avgCost: 45,
        onHandValue: 90,
      },
    ]);
    const itemsView = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/90\.00/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/90\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/45\.00/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(listItems).toHaveBeenCalledTimes(2));
    itemsView.unmount();

    // CountsPage
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'c-1',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '5',
        avgCost: '33.25',
        onHandValue: '166.25',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([]);
    const countsView = render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/33\.25/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/33\.25/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(listDailyItems).toHaveBeenCalledTimes(2));
    countsView.unmount();

    // PurchasesPage
    vi.mocked(listStockChoices).mockResolvedValue([]);
    vi.mocked(listPurchases).mockResolvedValue([
      {
        id: 'p-1',
        purchasedAt: '2026-10-15T10:00:00.000Z',
        supplier: 'مورد',
        invoiceNo: null,
        note: null,
        totalPaid: '444.00',
        lines: [],
      },
    ]);
    const purchasesView = render(
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/444\.00/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/444\.00/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(listPurchases).toHaveBeenCalledTimes(2));
    purchasesView.unmount();

    // ExpensesPage
    vi.mocked(loadExpenseMonth).mockResolvedValue({
      monthStart: currentMonthStart,
      complete: false,
      confirmedAt: null,
      categories: [],
      entries: [
        {
          id: 'e-1',
          categoryId: 'cat-1',
          categoryName: 'كهرباء',
          categoryKind: 'fixed_monthly',
          periodMonth: currentMonthStart,
          expenseDate: null,
          paidOn: null,
          isEstimate: false,
          amount: '777.00',
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
    });
    const expensesView = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/777\.00/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/777\.00/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(loadExpenseMonth).toHaveBeenCalledTimes(2));
    expensesView.unmount();

    // OrderDecisionsPage
    vi.mocked(loadQueuePage).mockResolvedValue({ rows: [], next: null });
    vi.mocked(loadUnlinkedRefunds).mockResolvedValue([
      {
        shiftId: 's-1',
        txId: 't-1',
        occurredAt: '2026-10-15T10:00:00.000Z',
        amount: '612.00',
      },
    ]);
    const decisionsView = render(
      <MemoryRouter>
        <OrderDecisionsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/612\.00/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/612\.00/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(loadUnlinkedRefunds).toHaveBeenCalledTimes(2));
    decisionsView.unmount();

    // WastePage
    vi.mocked(listStockChoices).mockResolvedValue([]);
    vi.mocked(loadHistoryPage).mockResolvedValue({
      entries: [
        {
          id: 'w-1',
          requestId: 'req-w-1',
          occurredAt: '2026-10-15T10:00:00.000Z',
          reason: 'spoilage',
          explanation: null,
          predecessorId: null,
          successorId: null,
          kind: 'record',
          isVoid: false,
          isCurrent: true,
          createdAt: '2026-10-15T10:00:00.000Z',
          value: '321.00',
          lines: [],
        },
      ],
      next: null,
    });
    const wasteView = render(
      <MemoryRouter>
        <WastePage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/321\.00/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/321\.00/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(loadHistoryPage).toHaveBeenCalledTimes(2));
    wasteView.unmount();

    // SortingPage
    vi.mocked(listMixedFish).mockResolvedValue([]);
    vi.mocked(listSorts).mockResolvedValue([
      {
        id: 's-1',
        occurredAt: '2026-10-15T10:00:00.000Z',
        createdAt: '2026-10-15T10:00:00.000Z',
        mixedItemId: 'm-1',
        mixedItemName: 'سمك مشكل',
        qtyTaken: '10',
        sizesQty: '9',
        lossQty: '1',
        lossValue: '555.00',
        costPerKg: '55.50',
        note: null,
        lines: [],
      },
    ]);
    const sortingView = render(
      <MemoryRouter>
        <SortingPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/555\.00/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/555\.00/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(listSorts).toHaveBeenCalledTimes(2));
    sortingView.unmount();

    // ActivationPage
    vi.mocked(loadOpeningReview).mockResolvedValue({
      activated: false,
      stockStartedAt: null,
      openingManifestHash: 'h-1',
      canActivate: true,
      checklist: [{ code: 'unreceipted_outflows', ready: true, count: '0' }],
      roster: [
        {
          itemId: 'oil',
          name: 'زيت',
          baseUnit: 'kg',
          active: true,
          missing: false,
          openingLineCount: '1',
          observation: {
            openingId: 'op-1',
            lineNo: '1',
            quantity: '10',
            unit: 'kg',
            unitCost: '919.00',
            occurredAt: '2026-10-15T09:00:00.000Z',
            explicitZero: false,
          },
        },
      ],
      nextItemId: null,
    });
    const actView = render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/919\.00/)).toBeInTheDocument();
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/919\.00/)).not.toBeInTheDocument();
    act(() => setNavigatorOnline(true));
    await waitFor(() => expect(loadOpeningReview).toHaveBeenCalledTimes(2));
    actView.unmount();
  });
});
