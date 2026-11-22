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
  listCounts,
  listDailyItems,
  listPendingCounts,
  recordCount,
} from '@/counts/api';
import {
  addExpenseEntry,
  loadExpenseMonth,
  voidExpenseEntry,
} from '@/expenses/api';
import type { ExpenseMonth } from '@/expenses/types';
import {
  addConversion,
  listConversions,
  listCostingSchedule,
  listUnitOptions,
  setItemLoss,
  setOpeningPrice,
  updateConversion,
} from '@/items/api';
import { ConversionsPanel } from '@/items/ConversionsPanel';
import { ItemForm } from '@/items/ItemForm';
import {
  conversionSubject,
  lossSubject,
  priceSubject,
  resetHeldWrites,
} from '@/items/request-id';
import type { CatalogItem } from '@/items/types';
import { itemToFormValues } from '@/items/validation';
import { cairoMonthInput } from '@/lib/cairo';
import {
  createHeldWriteStore,
  hasPostedReload,
  putHeldWrite,
  resetHeldWritesStore,
  setHeldWriteUser,
  storageWriteFailedMessage,
  userStoragePrefix,
} from '@/lib/held-writes';
import {
  loadBases,
  loadCatalog,
  loadCoverage,
  loadSubjectDetail,
  setBaseMapping,
} from '@/mapping/api';
import { baseSubject } from '@/mapping/subjects';
import { SubjectPanel } from '@/mapping/SubjectPanel';
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
import type { QueueRow } from '@/order-decisions/types';
import { setOrderTypePackaging } from '@/packaging/api';
import { PackagingEditor } from '@/packaging/PackagingEditor';
import { orderTypePackagingSubject } from '@/packaging/subjects';
import { CountsPage } from '@/pages/CountsPage';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { MappingPage } from '@/pages/MappingPage';
import { OrderDecisionsPage } from '@/pages/OrderDecisionsPage';
import { PurchasesPage } from '@/pages/PurchasesPage';
import {
  listPurchases,
  listStockChoices,
  listUnitsAt,
  recordPurchase,
} from '@/purchases/api';
import type { StockChoice } from '@/purchases/types';
import { SortForm } from '@/sorting/SortForm';
import type { MixedFish } from '@/sorting/types';

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
  previewCostingImpact: vi.fn(),
}));

vi.mock('@/counts/api', () => ({
  listDailyItems: vi.fn(),
  listCounts: vi.fn(),
  listPendingCounts: vi.fn(),
  recordCount: vi.fn(),
  recordStoredCount: vi.fn(),
}));

vi.mock('@/purchases/api', () => ({
  listStockChoices: vi.fn(),
  listPurchases: vi.fn(),
  listUnitsAt: vi.fn(() => Promise.resolve({})),
  recordPurchase: vi.fn(),
  recordOpeningStock: vi.fn(),
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

vi.mock('@/order-decisions/api', () => ({
  loadQueuePage: vi.fn(),
  loadQueueRow: vi.fn(),
  loadUnlinkedRefunds: vi.fn(),
  setOrderDisposition: vi.fn(),
}));

function setNavigatorOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value,
  });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

function makeFakeLocks() {
  const heldLocks = new Set<string>();
  const locks = {
    async request<T>(
      name: string,
      options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
      callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
    ): Promise<T> {
      if (heldLocks.has(name)) {
        if (options.ifAvailable) return await callback(null);
        throw new Error('unexpected blocking lock');
      }
      heldLocks.add(name);
      try {
        return await callback({ name, mode: options.mode ?? 'exclusive' });
      } finally {
        heldLocks.delete(name);
      }
    },
    query() {
      return Promise.resolve({
        held: [...heldLocks].map((name) => ({ name, mode: 'exclusive' })),
      });
    },
  };
  return { heldLocks, locks };
}

const mapCatalog: MappingCatalog = {
  items: [{ id: 'item-1', name: 'بلطي', baseUnit: 'kg' }],
  packagingItems: [],
  recipes: [],
  units: [{ code: 'kg', label: 'كيلو' }],
  shiftStart: null,
};

const mapCoverage: Coverage = {
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

function makeMapDetail(subjectId: string): SubjectDetail {
  return {
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
  };
}

describe('P7-3 round-4 review fixes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listUnitsAt).mockResolvedValue({});
    localStorage.clear();
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    setNavigatorOnline(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    setNavigatorOnline(true);
  });

  it('R4-1: fresh mapping and packaging writes hold a Web Lock while inflight so a second tab cannot promote or replay them', async () => {
    const { locks } = makeFakeLocks();
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });

    const tab2 = createHeldWriteStore({ getLocks: () => locks });
    try {
      setHeldWriteUser('user-a');
      tab2.setHeldWriteUser('user-a');

      let resolveMap!: () => void;
      vi.mocked(setBaseMapping).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveMap = resolve;
          }),
      );

      const mapView = render(
        <SubjectPanel
          base={baseA}
          detail={makeMapDetail('pos-a')}
          catalog={mapCatalog}
          onReload={() => Promise.resolve(true)}
        />,
      );
      fireEvent.change(screen.getByLabelText('الصنف'), {
        target: { value: 'item-1' },
      });
      fireEvent.change(screen.getByLabelText('الوحدة'), {
        target: { value: 'kg' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));

      await waitFor(() => {
        expect(setBaseMapping).toHaveBeenCalledTimes(1);
      });

      const subjMap = baseSubject('pos-a', '');
      await tab2.rehydrateHeldWritesAsync();
      // Live Tab 1 holds the Web Lock -> Tab 2 MUST NOT promote inflight -> unknown.
      expect(tab2.getHeldWrite(subjMap)?.phase).toBe('inflight');
      resolveMap();
      mapView.unmount();

      // PackagingEditor fresh write also holds a Web Lock while inflight.
      let resolvePack!: () => void;
      vi.mocked(setOrderTypePackaging).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePack = resolve;
          }),
      );
      const subjPack = orderTypePackagingSubject('takeaway');
      const packView = render(
        <PackagingEditor
          subjectKey={subjPack}
          kind="order_type"
          orderType="takeaway"
          schedule={{
            subjectId: 'ot-takeaway',
            token: 'tok-1',
            emptyToken: 'etok-1',
            versions: [],
          }}
          history={[]}
          items={[]}
          units={[]}
          shiftStart={null}
          allowCapacity={false}
          onReload={() => Promise.resolve(true)}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'احفظ التغليف' }));
      await waitFor(() => {
        expect(setOrderTypePackaging).toHaveBeenCalledTimes(1);
      });
      await tab2.rehydrateHeldWritesAsync();
      expect(tab2.getHeldWrite(subjPack)?.phase).toBe('inflight');
      resolvePack();
      packView.unmount();
    } finally {
      tab2.dispose();
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks);
      } else {
        delete (navigator as unknown as { locks?: unknown }).locks;
      }
    }
  });

  it('R4-3a: MappingPage switching from A to B while A save is STILL pending does NOT let A refresh read B and clear A', async () => {
    vi.mocked(loadBases).mockResolvedValue([baseA, baseB]);
    vi.mocked(loadCatalog).mockResolvedValue(mapCatalog);
    vi.mocked(loadCoverage).mockResolvedValue(mapCoverage);
    vi.mocked(loadSubjectDetail).mockImplementation((base) =>
      Promise.resolve(makeMapDetail(base.posItemId)),
    );
    let resolveSaveA!: () => void;
    vi.mocked(setBaseMapping).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSaveA = resolve;
        }),
    );

    render(
      <MemoryRouter>
        <MappingPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /سمكة أ/ }));
    fireEvent.change(await screen.findByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'kg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));

    await waitFor(() => {
      expect(setBaseMapping).toHaveBeenCalledTimes(1);
    });

    // Switch to B BEFORE A's RPC resolves!
    fireEvent.click(screen.getByRole('button', { name: /سمكة ب/ }));
    await screen.findByRole('heading', { name: /سمكة ب/ });

    // Now A's save resolves and triggers its post-save reload while B is selected.
    await act(async () => {
      resolveSaveA();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 20));
    });

    const subjectA = baseSubject('pos-a', '');
    // A's posted_reload MUST remain held because B was read, NOT A!
    expect(hasPostedReload(subjectA, subjectA)).toBe(true);
  });

  it('R4-3b: CountsPage and PurchasesPage mount reads do NOT clear posted_reload pins created after the read started', async () => {
    let resolveDailyItems!: (rows: []) => void;
    vi.mocked(listDailyItems).mockImplementation(
      () =>
        new Promise<[]>((resolve) => {
          resolveDailyItems = resolve;
        }),
    );
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([]);

    const countsView = render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(listDailyItems).toHaveBeenCalledTimes(1);
    });

    // A posted_reload pin appears AFTER the mount read started.
    putHeldWrite('count:daily', {
      requestId: 'req-after-start',
      payload: null,
      phase: 'posted_reload',
      kind: 'count',
    });

    await act(async () => {
      resolveDailyItems([]);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 10));
    });

    // Mount read started BEFORE req-after-start -> MUST NOT clear it!
    expect(hasPostedReload('count:daily', undefined, 'req-after-start')).toBe(
      true,
    );
    countsView.unmount();

    // Same check for PurchasesPage mount read.
    let resolveChoices!: (rows: StockChoice[]) => void;
    vi.mocked(listStockChoices).mockImplementation(
      () =>
        new Promise<StockChoice[]>((resolve) => {
          resolveChoices = resolve;
        }),
    );
    vi.mocked(listPurchases).mockResolvedValue([]);

    const purchasesView = render(
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(listStockChoices).toHaveBeenCalledTimes(1);
    });

    putHeldWrite('purchase:new', {
      requestId: 'req-purch-after-start',
      payload: null,
      phase: 'posted_reload',
      kind: 'purchase',
    });

    await act(async () => {
      resolveChoices([]);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(
      hasPostedReload('purchase:new', undefined, 'req-purch-after-start'),
    ).toBe(true);
    purchasesView.unmount();
  });

  it('R4-4b: going offline or sign-out+re-sign-in during lock acquisition stops CountsPage and PurchasesPage from dispatching', async () => {
    let releaseLockGate!: () => void;
    const gatedLocks = {
      async request<T>(
        name: string,
        options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
        callback: (
          lock: { name: string; mode: string } | null,
        ) => Promise<T> | T,
      ): Promise<T> {
        await new Promise<void>((resolve) => {
          releaseLockGate = resolve;
        });
        return await callback({ name, mode: options.mode ?? 'exclusive' });
      },
    };
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: gatedLocks,
    });

    try {
      setHeldWriteUser('user-a');
      vi.mocked(listDailyItems).mockResolvedValue([
        {
          id: 'c-1',
          name: 'بلطي',
          baseUnit: 'kg',
          onHandQty: '5',
          avgCost: '30',
          onHandValue: '150',
        },
      ]);
      vi.mocked(listCounts).mockResolvedValue([]);
      vi.mocked(listPendingCounts).mockResolvedValue([]);

      const countsView = render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      const qtyInput = await screen.findByLabelText(/الكمية المعدودة بلطي/);
      fireEvent.change(qtyInput, { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

      // Go offline while awaiting Web Lock acquisition!
      act(() => setNavigatorOnline(false));
      await act(async () => {
        releaseLockGate();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(recordCount).not.toHaveBeenCalled();
      countsView.unmount();

      // Now test PurchasesPage with sign-out + re-sign-in to SAME user during lock acquisition!
      act(() => setNavigatorOnline(true));
      const oil: StockChoice = {
        id: 'oil',
        name: 'زيت',
        kind: 'ingredient',
        baseUnit: 'kg',
        parentItemId: null,
        active: true,
        hasMovements: false,
        conversions: [],
      };
      vi.mocked(listStockChoices).mockResolvedValue([oil]);
      vi.mocked(listPurchases).mockResolvedValue([]);

      const purchasesView = render(
        <MemoryRouter>
          <PurchasesPage />
        </MemoryRouter>,
      );
      fireEvent.change(await screen.findByLabelText('الصنف'), {
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

      // Sign out and sign back in as SAME user while awaiting lock!
      setHeldWriteUser(null);
      setHeldWriteUser('user-a');
      await act(async () => {
        releaseLockGate();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(recordPurchase).not.toHaveBeenCalled();
      purchasesView.unmount();
    } finally {
      if (originalLocks) {
        Object.defineProperty(navigator, 'locks', originalLocks);
      } else {
        delete (navigator as unknown as { locks?: unknown }).locks;
      }
    }
  });

  it('R4-5: ItemForm loss/price retries and ConversionsPanel retries refuse to send when localStorage was cleared', async () => {
    const item: CatalogItem = {
      id: 'item-1',
      name: 'بلطي',
      kind: 'fish_size',
      baseUnit: 'kg',
      countFrequency: 'daily',
      parentItemId: null,
      lossPct: 0.1,
      lossFractionText: '0.1',
      openingPriceId: 'op-1',
      openingPriceText: '50',
      active: true,
      onHandQty: 10,
      avgCost: 50,
      onHandValue: 500,
    };
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'ltok',
      emptyToken: 'etok',
      identity: 'kg|fish_size||',
      lossVersions: [],
      conversions: [],
    });

    // Seed unknown loss & price pins.
    putHeldWrite(lossSubject('item-1'), {
      requestId: 'req-loss-1',
      payload: {
        lossPct: '0.2',
        write: {
          requestId: 'req-loss-1',
          effectiveFrom: null,
          effectiveTo: null,
          token: 'ltok',
          reason: null,
        },
      },
      phase: 'unknown',
      kind: 'action',
    });
    putHeldWrite(priceSubject('item-1'), {
      requestId: 'req-price-1',
      payload: {
        price: '60',
        reason: null,
        expectedId: 'op-1',
        identity: 'kg|fish_size||',
        requestId: 'req-price-1',
      },
      phase: 'unknown',
      kind: 'action',
    });

    const onSubmit = vi.fn().mockResolvedValue(true);
    const formView = render(
      <ItemForm
        items={[item]}
        editingId="item-1"
        initial={itemToFormValues(item)}
        submitting={false}
        locked={false}
        serverError={null}
        onClearServerError={() => undefined}
        onSubmit={onSubmit}
        onCancel={() => undefined}
      />,
    );

    const retryButtons = await screen.findAllByRole('button', {
      name: 'إعادة المحاولة',
    });
    expect(retryButtons).toHaveLength(2);

    // Clear storage before clicking either retry!
    localStorage.clear();

    fireEvent.click(retryButtons[0]!);
    fireEvent.click(retryButtons[1]!);

    await waitFor(() => {
      expect(
        screen.getAllByText(storageWriteFailedMessage).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(setItemLoss).not.toHaveBeenCalled();
    expect(setOpeningPrice).not.toHaveBeenCalled();
    formView.unmount();

    // ConversionsPanel retry after storage clear.
    vi.mocked(listConversions).mockResolvedValue({
      baseUnit: 'kg',
      rows: [
        {
          itemId: 'item-1',
          unit: 'box',
          label: 'صندوق',
          factorToBase: 5,
          storedFactor: '5',
          source: 'explicit',
        },
      ],
    });
    vi.mocked(listUnitOptions).mockResolvedValue([
      { code: 'kg', labelAr: 'كيلو' },
      { code: 'box', labelAr: 'صندوق' },
    ]);
    putHeldWrite(conversionSubject('item-1', 'box'), {
      requestId: 'req-conv-1',
      payload: {
        kind: 'set_conversion',
        via: 'edit',
        itemId: 'item-1',
        unit: 'box',
        factor: '6',
        expectedFactor: '5',
        baseUnit: 'kg',
        write: {
          requestId: 'req-conv-1',
          effectiveFrom: null,
          effectiveTo: null,
          token: 'etok',
          reason: null,
        },
      },
      phase: 'unknown',
      kind: 'action',
    });

    const convView = render(<ConversionsPanel item={item} />);
    const convRetryBtn = await screen.findByRole('button', {
      name: 'إعادة المحاولة',
    });

    localStorage.clear();
    fireEvent.click(convRetryBtn);

    expect(
      await screen.findByText(storageWriteFailedMessage),
    ).toBeInTheDocument();
    expect(updateConversion).not.toHaveBeenCalled();
    expect(addConversion).not.toHaveBeenCalled();
    convView.unmount();
  });

  it('R4-6: detached expense void retry persists original expense month as readTarget and does not clear from another month reload', async () => {
    const currentMonth = cairoMonthInput();
    const currentMonthStart = `${currentMonth}-01`;
    const otherMonthStart =
      currentMonthStart === '2030-04-01' ? '2030-03-01' : '2030-04-01';
    const otherMonthInput = otherMonthStart.slice(0, 7);

    const otherMonthData: ExpenseMonth = {
      monthStart: otherMonthStart,
      complete: false,
      confirmedAt: null,
      categories: [],
      entries: [
        {
          id: 'exp-april',
          categoryId: 'cat-1',
          categoryName: 'كهرباء',
          categoryKind: 'fixed_monthly',
          periodMonth: otherMonthStart,
          expenseDate: null,
          paidOn: null,
          isEstimate: false,
          amount: '150.00',
          note: null,
          hours: null,
          hourlyRate: null,
          driverLabel: null,
          createdAt: '2026-04-01T10:00:00.000Z',
          voided: false,
          voidReason: null,
          superseded: false,
        },
      ],
      days: [],
    };
    const currentMonthData: ExpenseMonth = {
      monthStart: currentMonthStart,
      complete: false,
      confirmedAt: null,
      categories: [],
      entries: [],
      days: [],
    };

    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
      Promise.resolve(
        monthStart === otherMonthStart ? otherMonthData : currentMonthData,
      ),
    );
    vi.mocked(voidExpenseEntry)
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(undefined);

    const view1 = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    await screen.findByText('مفيش مصاريف في الشهر ده');
    fireEvent.change(screen.getByLabelText('الشهر'), {
      target: { value: otherMonthInput },
    });
    await screen.findByText('150.00 ج.م');

    // Void the April expense -> network error leaves unknown void pin.
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
      target: { value: 'مكرر' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    await waitFor(() => {
      expect(voidExpenseEntry).toHaveBeenCalledTimes(1);
    });

    // Reload page on default month (currentMonthStart !== otherMonthStart).
    view1.unmount();
    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );

    const retryVoidBtn = await screen.findByRole('button', {
      name: /إعادة محاولة الإلغاء/,
    });
    fireEvent.click(retryVoidBtn);

    await waitFor(() => {
      expect(voidExpenseEntry).toHaveBeenCalledTimes(2);
    });
    // Wait for currentMonth's post-write reload to settle.
    await new Promise((r) => setTimeout(r, 20));

    // The void's posted_reload MUST still be held for `otherMonthStart` because
    // only `currentMonthStart` was reloaded, NOT the voided expense's month!
    expect(hasPostedReload('expense:void:exp-april', otherMonthStart)).toBe(
      true,
    );
    expect(addExpenseEntry).not.toHaveBeenCalled();
  });

  it('R4-7: SortForm and ItemForm hide cached monetary values while offline and preserve form state across reconnect', () => {
    const mixed: MixedFish = {
      id: 'm-1',
      name: 'سمك مشكل',
      onHandQty: '20',
      onHandValue: '1000.00',
      avgCost: '50.00',
      hasUncoveredDeficit: false,
      sizes: [{ id: 's-1', name: 'كبير' }],
    };

    const sortView = render(
      <SortForm
        items={[mixed]}
        locked={false}
        submitting={false}
        serverError={null}
        pending={null}
        onClearServerError={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
      target: { value: 'm-1' },
    });
    fireEvent.change(screen.getByLabelText('كمية المخلوط'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('كمية كبير'), {
      target: { value: '8' },
    });

    // Online: shows cached avgCost and monetary preview.
    expect(screen.getByText(/متوسط التكلفة/)).toBeInTheDocument();
    expect(screen.getByText(/تكلفة الكيلو/)).toBeInTheDocument();
    expect(screen.getByText(/قيمة الفاقد/)).toBeInTheDocument();

    // Go offline: cached avgCost and monetary preview MUST be hidden while typed inputs stay!
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/متوسط التكلفة/)).not.toBeInTheDocument();
    expect(screen.queryByText(/تكلفة الكيلو/)).not.toBeInTheDocument();
    expect(screen.queryByText(/قيمة الفاقد/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('كمية المخلوط')).toHaveValue('10');
    expect(screen.getByLabelText('كمية كبير')).toHaveValue('8');
    sortView.unmount();

    // ItemForm: hides saved opening price while offline, restores state on reconnect.
    act(() => setNavigatorOnline(true));
    const item: CatalogItem = {
      id: 'item-1',
      name: 'بلطي',
      kind: 'fish_size',
      baseUnit: 'kg',
      countFrequency: 'daily',
      parentItemId: null,
      lossPct: null,
      openingPriceId: 'op-1',
      openingPriceText: '125.50',
      active: true,
      onHandQty: 10,
      avgCost: 125.5,
      onHandValue: 1255,
    };
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'ltok',
      emptyToken: 'etok',
      identity: 'kg|fish_size||',
      lossVersions: [],
      conversions: [],
    });

    const itemView = render(
      <ItemForm
        items={[item]}
        editingId="item-1"
        initial={itemToFormValues(item)}
        submitting={false}
        locked={false}
        serverError={null}
        onClearServerError={() => undefined}
        onSubmit={() => Promise.resolve(true)}
        onCancel={() => undefined}
      />,
    );

    const priceInput = screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة');
    expect(priceInput).toHaveValue('125.50');

    act(() => setNavigatorOnline(false));
    expect(screen.queryByDisplayValue('125.50')).not.toBeInTheDocument();

    act(() => setNavigatorOnline(true));
    expect(screen.getByLabelText('السعر الافتتاحي المعتمد للوحدة')).toHaveValue(
      '125.50',
    );
    itemView.unmount();
  });

  it('R4-8: OrderDecisionsPage keeps DecisionCard and DecisionForm mounted while offline, preserving typed reason while hiding money', async () => {
    const row: QueueRow = {
      orderId: 'ord-77',
      episode: 1,
      currentClass: 'canceled',
      decidedClass: 'canceled',
      reviewReason: null,
      token: 'tok-77',
      needsDecision: true,
      eventId: 1,
      decision: 'not_made',
      source: 'system_default',
      ownerReviewed: false,
      decisionReason: null,
      decidedAt: '2026-10-15T10:00:00.000Z',
      orderNumber: 77,
      orderedAt: '2026-10-15T10:00:00.000Z',
      orderStatus: 'canceled',
      missingFromPos: false,
      orderTotal: '345.00',
      decidedOrderTotal: '345.00',
      refundTotal: '345.00',
      decidedRefundTotal: '345.00',
      basisStatus: 'ready',
      basisItems: [],
      refunds: [],
      returned: [],
      differences: {
        stockQuantity: '0',
        stockValue: '123.00',
        cogs: '0',
        waste: '0',
        profit: '-123.00',
      },
      history: [],
    };
    vi.mocked(loadQueuePage).mockResolvedValue({ rows: [row], next: null });
    vi.mocked(loadUnlinkedRefunds).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <OrderDecisionsPage />
      </MemoryRouter>,
    );

    expect((await screen.findAllByText(/345\.00/)).length).toBeGreaterThan(0);

    // Owner switches decision to 'made' and types a reason.
    fireEvent.click(screen.getByLabelText('اتعمل'));
    const reasonBox = screen.getByLabelText('سبب تغيير القرار');
    fireEvent.change(reasonBox, {
      target: { value: 'اتعمل فعلاً قبل الإلغاء' },
    });

    // Go offline: monetary values MUST disappear, but DecisionForm stays mounted
    // (disabled) with the typed reason preserved!
    act(() => setNavigatorOnline(false));
    expect(screen.queryByText(/345\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/123\.00/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('سبب تغيير القرار')).toHaveValue(
      'اتعمل فعلاً قبل الإلغاء',
    );
    expect(screen.getByLabelText('سبب تغيير القرار')).toBeDisabled();
    expect(setOrderDisposition).not.toHaveBeenCalled();

    // Verify prefix import usage (keeps imports clean).
    expect(userStoragePrefix('user-a')).toContain('user-a');
  });
});
