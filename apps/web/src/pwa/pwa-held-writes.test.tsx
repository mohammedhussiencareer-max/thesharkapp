import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateInventory,
  loadOpeningReview,
  loadProcessingSummary,
  runDeductions,
} from '@/accounting/api';
import { ProcessingPanel } from '@/accounting/ProcessingPanel';
import type { OpeningReview, ProcessingSummary } from '@/accounting/types';
import {
  listCounts,
  listDailyItems,
  listPendingCounts,
  recordCount,
  recordStoredCount,
} from '@/counts/api';
import { pendingResendMessage, retrySafeMessage } from '@/counts/errors';
import type { CountItem, CountWriteResult } from '@/counts/types';
import {
  addExpenseCategory,
  addExpenseEntry,
  loadExpenseMonth,
  renameExpenseCategory,
  setExpenseCategoryActive,
  setMonthExpenseComplete,
  voidExpenseEntry,
} from '@/expenses/api';
import { pendingResendMessage as expensePendingMessage } from '@/expenses/errors';
import type { ExpenseMonth } from '@/expenses/types';
import { unknownSaveMessage } from '@/items/request-id';
import {
  claimFreshHeldWrite,
  clearHeldWrite,
  hasPostedReload,
  rehydrateHeldWrites,
  rehydrateHeldWritesAsync,
  resetHeldWritesStore,
} from '@/lib/held-writes';
import {
  applyPwaUpdate,
  getPwaUpdateSnapshot,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import { setBaseMapping } from '@/mapping/api';
import { SubjectPanel } from '@/mapping/SubjectPanel';
import type {
  MappingCatalog,
  ObservedBase,
  SubjectDetail,
} from '@/mapping/types';
import { ActivationPage } from '@/pages/ActivationPage';
import { CountsPage } from '@/pages/CountsPage';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { OpeningPage } from '@/pages/OpeningPage';
import { PurchasesPage } from '@/pages/PurchasesPage';
import { SortingPage } from '@/pages/SortingPage';
import {
  getPurchaseById,
  listPurchases,
  listStockChoices,
  listUnitsAt,
  recordOpeningStock,
  recordPurchase,
} from '@/purchases/api';
import type { StockChoice } from '@/purchases/types';
import { UpdateBanner } from '@/pwa/UpdateBanner';
import { listMixedFish, listSorts, recordSort } from '@/sorting/api';
import { pendingResendMessage as sortPendingMessage } from '@/sorting/errors';
import type { MixedFish } from '@/sorting/types';

vi.mock('@/counts/api', () => ({
  listDailyItems: vi.fn(),
  listCounts: vi.fn(),
  listPendingCounts: vi.fn(),
  recordCount: vi.fn(),
  recordStoredCount: vi.fn(),
}));

vi.mock('@/purchases/api', () => ({
  getPurchaseById: vi.fn(),
  listStockChoices: vi.fn(),
  listPurchases: vi.fn(),
  recordPurchase: vi.fn(),
  recordOpeningStock: vi.fn(),
  listUnitsAt: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@/sorting/api', () => ({
  listMixedFish: vi.fn(),
  listSorts: vi.fn(),
  recordSort: vi.fn(),
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

vi.mock('@/mapping/api', () => ({
  setBaseMapping: vi.fn(),
  setOptionPolicy: vi.fn(),
  setException: vi.fn(),
  setOptionMapping: vi.fn(),
}));

vi.mock('@/accounting/api', () => ({
  loadProcessingSummary: vi.fn(),
  runDeductions: vi.fn(),
  recordRunFailure: vi.fn(),
  retryParkedOrder: vi.fn(),
  loadOpeningReview: vi.fn(),
  activateInventory: vi.fn(),
}));

const tilapia: CountItem = {
  id: 'tilapia',
  name: 'بلطي',
  baseUnit: 'kg',
  onHandQty: '10',
  onHandValue: '100.00',
  avgCost: '10.00',
};

const oil: StockChoice = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'kg',
  parentItemId: null,
  active: true,
  hasMovements: true,
  conversions: [],
};

const openingOil: StockChoice = {
  ...oil,
  hasMovements: false,
};

const mixedFish: MixedFish = {
  id: 'mixed',
  name: 'بوري مخلوط',
  onHandQty: '100',
  onHandValue: '5000.00',
  avgCost: '50',
  hasUncoveredDeficit: false,
  sizes: [{ id: 'large', name: 'كبير' }],
};

function expenseMonth(monthStart: string): ExpenseMonth {
  return {
    monthStart,
    categories: [
      { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
    ],
    entries: [],
    days: [],
    complete: false,
    confirmedAt: null,
  };
}

const mapBase: ObservedBase = {
  posItemId: 'pos-item-1',
  sizeKey: ['none'],
  sizeKeyText: '["none"]',
  itemName: 'طبق تجريبي',
  saleCount: 2,
  lastOrderedAt: '2030-06-01T08:00:00.000Z',
  latestOrderId: 'order-1',
  latestLineId: 'line-1',
  mapStatus: 'incomplete',
};

const mapCatalog: MappingCatalog = {
  recipes: [],
  items: [{ id: 'item-1', name: 'ملح تجريبي', baseUnit: 'kg' }],
  packagingItems: [],
  units: [{ code: 'kg', label: 'كيلو' }],
  shiftStart: null,
};

const mapDetail: SubjectDetail = {
  schedule: {
    subjectId: null,
    token: 'tok-1',
    emptyToken: 'tok-1',
    versions: [],
  },
  options: [],
  optionBindings: [],
  suggestions: [],
  history: [],
  optionHistory: [],
  resolution: {
    status: 'incomplete',
    issues: [{ code: 'unmapped_base', expandIssue: null }],
    requirements: [],
  },
  packaging: {
    schedule: {
      subjectId: null,
      token: 'pack-tok',
      emptyToken: 'pack-tok',
      versions: [],
    },
    history: [],
  },
};

const processingSummary: ProcessingSummary = {
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

const openingReview: OpeningReview = {
  activated: false,
  stockStartedAt: null,
  openingManifestHash: 'a'.repeat(32),
  canActivate: true,
  checklist: [{ code: 'unreceipted_outflows', ready: true, count: '0' }],
  roster: [
    {
      itemId: 'item-1',
      name: 'بلطي',
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
        occurredAt: '2026-10-22T09:00:00.000Z',
        explicitZero: false,
      },
    },
  ],
  nextItemId: null,
};

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: online,
  });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

describe('held writes and offline behavior across writers', () => {
  beforeEach(() => {
    localStorage.clear();
    setOnline(true);
    vi.mocked(listDailyItems).mockReset();
    vi.mocked(listCounts).mockReset();
    vi.mocked(listPendingCounts).mockReset();
    vi.mocked(listDailyItems).mockResolvedValue([tilapia]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([]);
    vi.mocked(recordCount).mockReset();
    vi.mocked(recordCount).mockResolvedValue({
      status: 'posted',
      countId: 'c-1',
    });
    vi.mocked(recordStoredCount).mockReset();

    vi.mocked(listStockChoices).mockReset();
    vi.mocked(listPurchases).mockReset();
    vi.mocked(listUnitsAt).mockReset();
    vi.mocked(listStockChoices).mockResolvedValue([oil]);
    vi.mocked(listPurchases).mockResolvedValue([]);
    vi.mocked(listUnitsAt).mockResolvedValue({});
    vi.mocked(recordPurchase).mockReset();
    vi.mocked(recordPurchase).mockResolvedValue(undefined);
    vi.mocked(recordOpeningStock).mockReset();
    vi.mocked(recordOpeningStock).mockResolvedValue(undefined);

    vi.mocked(listMixedFish).mockReset();
    vi.mocked(listSorts).mockReset();
    vi.mocked(listMixedFish).mockResolvedValue([mixedFish]);
    vi.mocked(listSorts).mockResolvedValue([]);
    vi.mocked(recordSort).mockReset();
    vi.mocked(recordSort).mockResolvedValue(undefined);

    vi.mocked(loadExpenseMonth).mockReset();
    vi.mocked(loadExpenseMonth).mockImplementation((m) =>
      Promise.resolve(expenseMonth(m)),
    );
    vi.mocked(addExpenseEntry).mockReset();
    vi.mocked(addExpenseEntry).mockResolvedValue(undefined);
    vi.mocked(voidExpenseEntry).mockReset();
    vi.mocked(voidExpenseEntry).mockResolvedValue(undefined);
    vi.mocked(addExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(renameExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(setExpenseCategoryActive).mockResolvedValue(undefined);
    vi.mocked(setMonthExpenseComplete).mockResolvedValue(undefined);

    vi.mocked(setBaseMapping).mockReset();
    vi.mocked(setBaseMapping).mockResolvedValue(undefined);

    vi.mocked(loadProcessingSummary).mockReset();
    vi.mocked(loadProcessingSummary).mockResolvedValue(processingSummary);
    vi.mocked(runDeductions).mockReset();
    vi.mocked(loadOpeningReview).mockReset();
    vi.mocked(loadOpeningReview).mockResolvedValue(openingReview);
    vi.mocked(activateInventory).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setOnline(true);
    localStorage.clear();
  });

  it('reload during transmission restores count as unknown without auto-sending', async () => {
    vi.mocked(recordCount).mockReturnValueOnce(
      new Promise<CountWriteResult>(() => {
        // Never resolves: simulates reload mid-transmission.
      }),
    );

    const view = render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('وقت الجرد')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(1);
    });
    const sent = vi.mocked(recordCount).mock.calls[0]?.[0];
    expect(sent).toBeDefined();
    expect(localStorage.length).toBeGreaterThan(0);

    view.unmount();
    resetHeldWritesStore({ clearStorage: false });
    await rehydrateHeldWritesAsync();

    // Fresh mount must restore unknown without auto-sending.
    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();
    expect(recordCount).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveValue('7');
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveAttribute(
      'readonly',
    );

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordCount).mock.calls[1]?.[0]).toEqual(sent);
  });

  it('a committed post whose reply was lost retries with the same id and payload after reload and stores exactly one result', async () => {
    const serverLedger = new Map<
      string,
      { countId: string; payload: unknown }
    >();
    let firstReplyDropped = false;
    vi.mocked(recordCount).mockImplementation((draft) => {
      const existing = serverLedger.get(draft.requestId);
      const countId =
        existing?.countId ?? `count-${String(serverLedger.size + 1)}`;
      if (!existing) {
        serverLedger.set(draft.requestId, { countId, payload: draft });
      }
      if (!firstReplyDropped) {
        firstReplyDropped = true;
        return Promise.reject(new Error(retrySafeMessage));
      }
      return Promise.resolve({ status: 'posted', countId });
    });

    const view = render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('وقت الجرد')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();
    const first = vi.mocked(recordCount).mock.calls[0]?.[0];
    expect(serverLedger.size).toBe(1);

    view.unmount();
    resetHeldWritesStore({ clearStorage: false });
    await rehydrateHeldWritesAsync();

    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordCount).mock.calls[1]?.[0]).toEqual(first);
    expect(serverLedger.size).toBe(1);
    expect(serverLedger.has(first!.requestId)).toBe(true);
  });

  it('reopening while offline keeps the ledger button disabled until back online', async () => {
    vi.mocked(recordCount).mockRejectedValueOnce(new Error(retrySafeMessage));
    const view = render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('وقت الجرد')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();
    view.unmount();

    setOnline(false);
    rehydrateHeldWrites();
    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();

    act(() => {
      setOnline(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
  });

  it('a successful save followed by a failed reload keeps posted_reload until a read succeeds', async () => {
    vi.mocked(listCounts)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce([]);

    const view = render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('وقت الجرد')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(localStorage.length).toBeGreaterThan(0);

    view.unmount();
    resetHeldWritesStore({ clearStorage: false });
    await rehydrateHeldWritesAsync();

    // Reopen while read still fails: posted_reload stays held and save stays locked.
    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('still down');
    expect(recordCount).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBeGreaterThan(0);

    // Retry reload succeeds -> posted_reload clears and form unlocks.
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    expect(localStorage.length).toBe(0);
  });

  it('reload restores purchase payload', async () => {
    vi.mocked(recordPurchase).mockRejectedValueOnce(new Error('socket'));
    vi.mocked(getPurchaseById).mockResolvedValueOnce({
      id: 'purchase-verified',
      purchasedAt: '2030-04-01T08:00:00Z',
      supplier: 'مورد تجريبي',
      invoiceNo: null,
      note: null,
      totalPaid: '75',
      lines: [],
    });
    const view = render(
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('الصنف')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('المورد'), {
      target: { value: 'مورد تجريبي' },
    });
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'oil' },
    });
    fireEvent.change(screen.getByLabelText('الكمية'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '75' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('socket');
    const first = vi.mocked(recordPurchase).mock.calls[0]?.[0];

    view.unmount();
    resetHeldWritesStore({ clearStorage: false });
    await rehydrateHeldWritesAsync();

    render(
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'مراجعة المشتريات' }),
    ).toBeInTheDocument();
    expect(screen.getByText('مورد تجريبي')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordPurchase).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordPurchase).mock.calls[1]?.[0]).toEqual(first);
    await waitFor(() => {
      expect(hasPostedReload('purchase:new')).toBe(false);
    });
    expect(getPurchaseById).toHaveBeenCalledWith({
      requestId: first?.requestId,
    });
  });

  it('reload restores opening stock payload', async () => {
    expect(navigator.locks).toBeDefined();
    const lockSpy = vi.spyOn(navigator.locks, 'request');
    vi.mocked(listStockChoices).mockResolvedValue([openingOil]);
    vi.mocked(recordOpeningStock).mockRejectedValueOnce(new Error('socket'));
    const view = render(
      <MemoryRouter>
        <OpeningPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('كمية زيت')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('كمية زيت'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('تكلفة زيت'), {
      target: { value: '20' },
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('socket');
    const first = vi.mocked(recordOpeningStock).mock.calls[0]?.[0];
    expect(lockSpy).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('opening:new')),
      expect.objectContaining({ mode: 'exclusive' }),
      expect.any(Function),
    );
    const firstLockCalls = lockSpy.mock.calls.length;

    view.unmount();
    resetHeldWritesStore({ clearStorage: false });
    await rehydrateHeldWritesAsync();

    // Even if server already moved oil out of candidates, pinned retry stays available.
    vi.mocked(listStockChoices).mockResolvedValue([oil]);
    const openingLockPart = encodeURIComponent('opening:new');
    let resolveReplay: (() => void) | undefined;
    vi.mocked(recordOpeningStock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveReplay = resolve;
        }),
    );
    render(
      <MemoryRouter>
        <OpeningPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/5 kg/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordOpeningStock).toHaveBeenCalledTimes(2);
    });
    // Yield microtasks while the replay RPC stays pending so an early
    // claim.release() before dispatch would already have cleared the lock.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const { held = [] } = await navigator.locks.query();
    expect(held.map((lock) => lock.name ?? '')).toContainEqual(
      expect.stringContaining(openingLockPart),
    );
    expect(vi.mocked(recordOpeningStock).mock.calls[1]?.[0]).toEqual(first);
    expect(lockSpy.mock.calls.length).toBeGreaterThan(firstLockCalls);

    await act(async () => {
      resolveReplay?.();
      await Promise.resolve();
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'اتسجل الرصيد الافتتاحي',
    );
    await waitFor(async () => {
      const after = await navigator.locks.query();
      expect(
        (after.held ?? []).map((lock) => lock.name ?? ''),
      ).not.toContainEqual(expect.stringContaining(openingLockPart));
    });
  });

  it('reload restores sort payload', async () => {
    vi.mocked(recordSort).mockRejectedValueOnce(new Error('socket'));
    const view = render(
      <MemoryRouter>
        <SortingPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('السمك المخلوط')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
      target: { value: 'mixed' },
    });
    fireEvent.change(screen.getByLabelText('كمية المخلوط'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('كمية كبير'), {
      target: { value: '9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(sortPendingMessage)).toBeInTheDocument();
    const first = vi.mocked(recordSort).mock.calls[0]?.[0];

    view.unmount();
    resetHeldWritesStore({ clearStorage: false });
    await rehydrateHeldWritesAsync();

    render(
      <MemoryRouter>
        <SortingPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(sortPendingMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('كمية المخلوط')).toHaveValue('10');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordSort).mock.calls[1]?.[0]).toEqual(first);
  });

  it('reload restores expense payload', async () => {
    vi.mocked(addExpenseEntry).mockRejectedValueOnce(new Error('socket'));
    const view = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText('التصنيف'), {
      target: { value: 'rent' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    expect(await screen.findByText(expensePendingMessage)).toBeInTheDocument();
    const first = vi.mocked(addExpenseEntry).mock.calls[0]?.[0];

    view.unmount();
    resetHeldWritesStore({ clearStorage: false });
    await rehydrateHeldWritesAsync();

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(expensePendingMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('المبلغ')).toHaveValue('1000.00');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => {
      expect(addExpenseEntry).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(addExpenseEntry).mock.calls[1]?.[0]).toEqual(first);
  });

  it('reload restores mapping payload from localStorage and retries with same id', async () => {
    vi.mocked(setBaseMapping).mockRejectedValueOnce(new Error('socket'));
    const view = render(
      <SubjectPanel
        base={mapBase}
        detail={mapDetail}
        catalog={mapCatalog}
        onReload={() => Promise.resolve()}
      />,
    );
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(localStorage.length).toBeGreaterThan(0);
    const first = vi.mocked(setBaseMapping).mock.calls[0]?.[0];

    view.unmount();
    resetHeldWritesStore({ clearStorage: false });
    await rehydrateHeldWritesAsync();

    render(
      <SubjectPanel
        base={mapBase}
        detail={mapDetail}
        catalog={mapCatalog}
        onReload={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    expect(setBaseMapping).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(setBaseMapping).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(setBaseMapping).mock.calls[1]?.[0]).toEqual(first);
  });

  it('P2-4: a throwing localStorage refuses to send a ledger write, shows Arabic error, keeps retry usable, and leaves reads working', async () => {
    const getSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('SecurityError');
      });
    const setSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new DOMException('SecurityError');
      });
    const keySpy = vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });

    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    // Reads and non-ledger UI still load without storage.
    expect(await screen.findByLabelText('وقت الجرد')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    // Must NOT send the write without durable pin protection.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'مش قادر أحفظ العملية على الجهاز، جرّب تاني',
    );
    expect(recordCount).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();

    // Once storage recovers, the same button works to send.
    getSpy.mockRestore();
    setSpy.mockRestore();
    removeSpy.mockRestore();
    keySpy.mockRestore();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(1);
    });
  });

  it('disables ledger buttons across screens while navigator.onLine is false', async () => {
    setOnline(false);

    const countsView = render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('وقت الجرد')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    countsView.unmount();

    const purchasesView = render(
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('الصنف')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeDisabled();
    purchasesView.unmount();

    const sortView = render(
      <MemoryRouter>
        <SortingPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('السمك المخلوط')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    sortView.unmount();

    const expenseView = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('التصنيف')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ المصروف' })).toBeDisabled();
    expenseView.unmount();

    const mappingView = render(
      <SubjectPanel
        base={mapBase}
        detail={mapDetail}
        catalog={mapCatalog}
        onReload={() => Promise.resolve()}
      />,
    );
    expect(screen.getByRole('button', { name: 'احفظ الربط' })).toBeDisabled();
    mappingView.unmount();

    const processingView = render(<ProcessingPanel />);
    expect(
      await screen.findByRole('button', { name: 'شغّل الخصم' }),
    ).toBeDisabled();
    processingView.unmount();

    const activationView = render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('button', { name: 'تفعيل الخصم' }),
    ).toBeDisabled();
    activationView.unmount();
  });

  it('UpdateBanner waits for owner reload, never reloads while a pin is held, and blocks controllerchange if a pin appears in between', async () => {
    const controllerListeners: Array<() => void> = [];
    const originalSw = Object.getOwnPropertyDescriptor(
      navigator,
      'serviceWorker',
    );
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: {},
        register: vi.fn(() =>
          Promise.resolve({
            waiting: null,
            installing: null,
            addEventListener: vi.fn(),
          }),
        ),
        addEventListener: (event: string, cb: () => void) => {
          if (event === 'controllerchange') controllerListeners.push(cb);
        },
      },
    });
    try {
      const postMessage = vi.fn();
      const reload = vi.fn();
      const { initPwa } = await import('@/lib/pwa');
      vi.stubEnv('PROD', true);
      initPwa(reload);
      setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);
      const held = await claimFreshHeldWrite('count:daily', (requestId) => ({
        requestId,
      }));
      if (!held.ok) throw new Error('expected held write claim');

      const { AuthContext } = await import('@/lib/auth-context');
      render(
        <AuthContext.Provider
          value={{
            status: 'owner',
            email: 'owner@theshark.test',
            signIn: () => Promise.resolve('ok'),
            signOut: () => Promise.resolve(),
            retry: () => undefined,
          }}
        >
          <UpdateBanner onReload={reload} />
        </AuthContext.Provider>,
      );
      const button = screen.getByRole('button', { name: 'تحديث التطبيق' });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(postMessage).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();

      // Clear pin -> owner approves update.
      await act(async () => {
        clearHeldWrite('count:daily', held.record.requestId);
        held.release();
        await Promise.resolve();
      });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

      // A pin appears AFTER approval and BEFORE controllerchange fires -> NO reload!
      const held2 = await claimFreshHeldWrite('purchase:new', (requestId) => ({
        requestId,
      }));
      if (!held2.ok) throw new Error('expected second held write claim');
      for (const listener of controllerListeners) listener();
      expect(reload).not.toHaveBeenCalled();

      // Also verify controllerchange DOES reload when no pin is held and approved again.
      await act(async () => {
        clearHeldWrite('purchase:new', held2.record.requestId);
        held2.release();
        await Promise.resolve();
      });
      fireEvent.click(button);
      for (const listener of controllerListeners) listener();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      if (originalSw) {
        Object.defineProperty(navigator, 'serviceWorker', originalSw);
      } else {
        delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      }
    }
  });

  it('P2 item 6a: first-visit tab without controller detects a waiting update from registration state', async () => {
    const originalSw = Object.getOwnPropertyDescriptor(
      navigator,
      'serviceWorker',
    );
    const updateFoundListeners: Array<() => void> = [];
    const installingStateListeners: Array<() => void> = [];
    const installingWorker = {
      state: 'installing',
      postMessage: vi.fn(),
      addEventListener: (event: string, cb: () => void) => {
        if (event === 'statechange') installingStateListeners.push(cb);
      },
      removeEventListener: vi.fn(),
    };
    const registration: {
      active: { state: string } | null;
      waiting: typeof installingWorker | null;
      installing: typeof installingWorker | null;
      addEventListener: (event: string, cb: () => void) => void;
    } = {
      active: { state: 'activated' },
      waiting: null,
      installing: null,
      addEventListener: (event: string, cb: () => void) => {
        if (event === 'updatefound') updateFoundListeners.push(cb);
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: null,
        register: vi.fn(() => Promise.resolve(registration)),
        addEventListener: vi.fn(),
      },
    });
    try {
      resetPwaState();
      vi.stubEnv('PROD', true);
      const { initPwa } = await import('@/lib/pwa');
      initPwa(vi.fn());
      await waitFor(() => {
        expect(updateFoundListeners.length).toBe(1);
      });

      registration.installing = installingWorker;
      for (const cb of updateFoundListeners) cb();
      installingWorker.state = 'installed';
      registration.waiting = installingWorker;
      for (const cb of installingStateListeners) cb();

      expect(getPwaUpdateSnapshot().waiting).toBe(true);
    } finally {
      resetPwaState();
      vi.unstubAllEnvs();
      if (originalSw) {
        Object.defineProperty(navigator, 'serviceWorker', originalSw);
      } else {
        delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      }
    }
  });

  it.each([true, false])(
    'P2 item 6b: approves the newer worker before reloading (statechange delivered: %s)',
    async (stateChangeDelivered) => {
      const controllerListeners: Array<() => void> = [];
      const originalSw = Object.getOwnPropertyDescriptor(
        navigator,
        'serviceWorker',
      );
      const registration = {
        active: { state: 'activated' },
        waiting: null as ServiceWorker | null,
        installing: null,
        addEventListener: vi.fn(),
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          controller: {},
          register: vi.fn(() => Promise.resolve(registration)),
          addEventListener: (event: string, cb: () => void) => {
            if (event === 'controllerchange') controllerListeners.push(cb);
          },
        },
      });
      try {
        resetPwaState();
        vi.stubEnv('PROD', true);
        const reload = vi.fn();
        const { initPwa } = await import('@/lib/pwa');
        initPwa(reload);
        setPwaAuthResolved(true);

        // Worker 1 activates while a pin blocks reload -> reloadDeferred becomes true.
        const w1Listeners: Array<() => void> = [];
        const w1 = {
          state: 'installed',
          postMessage: vi.fn(),
          addEventListener: (event: string, cb: () => void) => {
            if (event === 'statechange') w1Listeners.push(cb);
          },
          removeEventListener: vi.fn(),
        };
        setTestWaitingWorker(w1 as unknown as ServiceWorker);
        expect(applyPwaUpdate(reload)).toBe(true);
        expect(w1.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

        const pin = await claimFreshHeldWrite('count:daily', (requestId) => ({
          requestId,
        }));
        if (!pin.ok) throw new Error('expected pin');
        w1.state = 'activated';
        for (const cb of w1Listeners) cb();
        for (const cb of controllerListeners) cb();
        expect(reload).not.toHaveBeenCalled();

        clearHeldWrite('count:daily', pin.record.requestId);
        pin.release();

        // A newer waiting worker w2 arrives before the user clicks again.
        const w2Listeners: Array<() => void> = [];
        const w2 = {
          state: 'installed',
          postMessage: vi.fn(),
          addEventListener: (event: string, cb: () => void) => {
            if (event === 'statechange') w2Listeners.push(cb);
          },
          removeEventListener: vi.fn(),
        };
        registration.waiting = w2 as unknown as ServiceWorker;
        if (stateChangeDelivered) setTestWaitingWorker(registration.waiting);

        // Clicking update MUST activate w2 (send SKIP_WAITING) and NOT reload before w2 activates.
        expect(applyPwaUpdate(reload)).toBe(true);
        expect(w2.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(reload).not.toHaveBeenCalled();

        // Once w2 activates, reload completes.
        w2.state = 'activated';
        for (const cb of w2Listeners) cb();
        expect(reload).toHaveBeenCalledTimes(1);
      } finally {
        resetPwaState();
        vi.unstubAllEnvs();
        if (originalSw) {
          Object.defineProperty(navigator, 'serviceWorker', originalSw);
        } else {
          delete (navigator as { serviceWorker?: unknown }).serviceWorker;
        }
      }
    },
  );

  it('P2 item 6c: first install with no active worker and no controller does not flag a waiting update or post SKIP_WAITING', async () => {
    const originalSw = Object.getOwnPropertyDescriptor(
      navigator,
      'serviceWorker',
    );
    const updateFoundListeners: Array<() => void> = [];
    const installingStateListeners: Array<() => void> = [];
    const installingWorker = {
      state: 'installing',
      postMessage: vi.fn(),
      addEventListener: (event: string, cb: () => void) => {
        if (event === 'statechange') installingStateListeners.push(cb);
      },
      removeEventListener: vi.fn(),
    };
    const registration: {
      active: typeof installingWorker | null;
      waiting: typeof installingWorker | null;
      installing: typeof installingWorker | null;
      addEventListener: (event: string, cb: () => void) => void;
    } = {
      active: null,
      waiting: null,
      installing: null,
      addEventListener: (event: string, cb: () => void) => {
        if (event === 'updatefound') updateFoundListeners.push(cb);
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: null,
        register: vi.fn(() => Promise.resolve(registration)),
        addEventListener: vi.fn(),
      },
    });
    try {
      resetPwaState();
      vi.stubEnv('PROD', true);
      const reload = vi.fn();
      const { initPwa } = await import('@/lib/pwa');
      initPwa(reload);
      setPwaAuthResolved(true);
      await waitFor(() => {
        expect(updateFoundListeners.length).toBe(1);
      });

      // Per Service Worker spec Install algorithm, registration.waiting is set
      // to installing BEFORE its state transitions to 'installed', even on a
      // first install with no active worker or controller.
      registration.installing = installingWorker;
      for (const cb of updateFoundListeners) cb();
      registration.installing = null;
      registration.waiting = installingWorker;
      installingWorker.state = 'installed';
      for (const cb of installingStateListeners) cb();

      expect(getPwaUpdateSnapshot().waiting).toBe(false);
      expect(applyPwaUpdate(reload)).toBe(false);
      expect(installingWorker.postMessage).not.toHaveBeenCalled();

      // First-install worker proceeds to activate automatically.
      registration.waiting = null;
      registration.active = installingWorker;
      installingWorker.state = 'activated';
      for (const cb of installingStateListeners) cb();

      expect(getPwaUpdateSnapshot().waiting).toBe(false);
      expect(applyPwaUpdate(reload)).toBe(false);
      expect(installingWorker.postMessage).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      resetPwaState();
      vi.unstubAllEnvs();
      if (originalSw) {
        Object.defineProperty(navigator, 'serviceWorker', originalSw);
      } else {
        delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      }
    }
  });
});
