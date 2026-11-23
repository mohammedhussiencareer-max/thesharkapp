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
  addExpenseCategory,
  addExpenseEntry,
  loadExpenseEntryMonth,
  loadExpenseMonth,
  renameExpenseCategory,
  setExpenseCategoryActive,
  setMonthExpenseComplete,
  voidExpenseEntry,
} from '@/expenses/api';
import type { ExpenseMonth } from '@/expenses/types';
import {
  addConversion,
  costingImpact,
  createItem,
  currentShiftStart,
  getItemById,
  listConversions,
  listCostingSchedule,
  listItems,
  listUnitOptions,
  setItemLoss,
  setOpeningPrice,
  updateItem,
} from '@/items/api';
import { emptyScheduleToken } from '@/items/effective';
import { StaleWriteError } from '@/items/errors';
import {
  conversionSubject,
  lossSubject,
  resetHeldWrites,
} from '@/items/request-id';
import type { CatalogItem, DatedWrite } from '@/items/types';
import {
  createHeldWriteStore,
  getHeldWrite,
  hasAnyHeldWrite,
  resetHeldWritesStore,
  setHeldWriteUser,
} from '@/lib/held-writes';
import {
  applyPwaUpdate,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ItemsPage } from '@/pages/ItemsPage';

vi.mock('@/items/api', () => ({
  ITEMS_RELOAD_SUBJECT: 'items:reload',
  listItems: vi.fn(),
  getItemById: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  setItemLoss: vi.fn(),
  setOpeningPrice: vi.fn(),
  listConversions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
  currentShiftStart: vi.fn(),
  listCostingSchedule: vi.fn(),
  costingImpact: vi.fn(),
  listUnitOptions: vi.fn(),
  addCustomUnit: vi.fn(),
}));

vi.mock('@/expenses/api', () => ({
  loadExpenseMonth: vi.fn(),
  loadExpenseEntryMonth: vi.fn(),
  addExpenseEntry: vi.fn(),
  voidExpenseEntry: vi.fn(),
  setMonthExpenseComplete: vi.fn(),
  addExpenseCategory: vi.fn(),
  renameExpenseCategory: vi.fn(),
  setExpenseCategoryActive: vi.fn(),
}));

const oilItem: CatalogItem = {
  id: 'oil',
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

const boxItem: CatalogItem = {
  id: 'box',
  name: 'علبة',
  kind: 'packaging',
  baseUnit: 'piece',
  countFrequency: 'weekly',
  lossPct: 0,
  lossFractionText: '0',
  identityLocked: false,
  openingPriceId: null,
  openingPriceText: null,
  parentItemId: null,
  active: true,
  onHandQty: 0,
  avgCost: 0,
  onHandValue: 0,
};

function expenseMonth(
  monthStart: string,
  patch: Partial<ExpenseMonth> = {},
): ExpenseMonth {
  return {
    monthStart,
    categories: [
      { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
      { id: 'gas', name: 'غاز', kind: 'daily', active: true },
    ],
    entries: [],
    days: [],
    complete: false,
    confirmedAt: null,
    ...patch,
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: online,
  });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

describe('P7-3 round-9 review fixes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetPwaState();
    setPwaAuthResolved(true);
    setHeldWriteUser('owner-r9');
    setOnline(true);

    vi.mocked(listItems).mockResolvedValue([oilItem, boxItem]);
    vi.mocked(getItemById).mockImplementation((id: string) =>
      Promise.resolve(
        [oilItem, boxItem].find((item) => item.id === id) ?? null,
      ),
    );
    vi.mocked(currentShiftStart).mockResolvedValue(null);
    vi.mocked(listCostingSchedule).mockImplementation((itemId) =>
      Promise.resolve({
        lossToken: emptyScheduleToken,
        identity: itemId === 'box' ? 'piece|packaging||' : 'liter|ingredient||',
        lossVersions: [],
        conversions: [],
      }),
    );
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 0,
      shifts: 0,
      movements: 0,
    });
    vi.mocked(listUnitOptions).mockResolvedValue([
      { code: 'كرتونة', labelAr: 'كرتونة' },
    ]);
    vi.mocked(listConversions).mockResolvedValue({
      baseUnit: 'piece',
      rows: [],
    });
    vi.mocked(createItem).mockResolvedValue(undefined);
    vi.mocked(updateItem).mockResolvedValue(undefined);
    vi.mocked(setItemLoss).mockResolvedValue(undefined);
    vi.mocked(setOpeningPrice).mockResolvedValue(undefined);
    vi.mocked(addConversion).mockResolvedValue(undefined);

    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
      Promise.resolve(expenseMonth(monthStart)),
    );
    vi.mocked(loadExpenseEntryMonth).mockResolvedValue(null);
    vi.mocked(addExpenseEntry).mockResolvedValue(undefined);
    vi.mocked(voidExpenseEntry).mockResolvedValue(undefined);
    vi.mocked(setMonthExpenseComplete).mockResolvedValue(undefined);
    vi.mocked(addExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(renameExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(setExpenseCategoryActive).mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetPwaState();
    localStorage.clear();
    setOnline(true);
  });

  it('R9-1a: Loss verification uses ONE combined read (schedule + getItemById) with single item-id pin target and resumes on ItemsPage mount', async () => {
    const reload = vi.fn();
    const postMessage = vi.fn();
    setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

    let capturedRequestId = '';
    vi.mocked(setItemLoss).mockImplementation(
      (_id: string, _lossPct: string, write: DatedWrite) => {
        capturedRequestId = write.requestId;
        return Promise.resolve();
      },
    );
    // Initial mount loads [oilItem]; loss verification's getItemById fails first time.
    vi.mocked(listItems).mockResolvedValue([oilItem]);
    vi.mocked(getItemById)
      .mockRejectedValueOnce(new Error('item row read failed'))
      .mockRejectedValueOnce(new Error('still failing on mount'))
      .mockResolvedValueOnce({
        ...oilItem,
        lossPct: 0.1,
        lossFractionText: '0.1',
        identityLocked: true,
      });

    const view1 = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalledWith('oil');
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));

    await waitFor(() => {
      expect(getItemById).toHaveBeenCalledWith('oil');
    });
    // Combined read did NOT use the capped catalog listItems() query!
    expect(listItems).toHaveBeenCalledTimes(1);
    const held = getHeldWrite(lossSubject('oil'));
    expect(held?.phase).toBe('posted_reload');
    expect(held?.requestId).toBe(capturedRequestId);
    // Single read target = item id, NO two-target readTargets bookkeeping!
    expect(held?.readTarget).toBe('oil');
    expect(
      (held as { readTargets?: unknown } | null)?.readTargets,
    ).toBeUndefined();
    expect(hasAnyHeldWrite()).toBe(true);
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
    view1.unmount();

    // Simulate reload: remount ItemsPage (ItemForm is NOT open).
    // ItemsPage MUST resume the combined read (listCostingSchedule + getItemById) on mount!
    const scheduleCallsBeforeMount =
      vi.mocked(listCostingSchedule).mock.calls.length;
    const byIdCallsBeforeMount = vi.mocked(getItemById).mock.calls.length;
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(vi.mocked(listCostingSchedule).mock.calls.length).toBeGreaterThan(
        scheduleCallsBeforeMount,
      );
      expect(vi.mocked(getItemById).mock.calls.length).toBeGreaterThan(
        byIdCallsBeforeMount,
      );
    });
    // Mount resume failed -> pin stays held and a targeted read-only retry control is shown.
    expect(getHeldWrite(lossSubject('oil'))?.phase).toBe('posted_reload');
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();
    const verifyBtn = await screen.findByRole('button', {
      name: 'تحقق تاني',
    });

    // Clicking read-only retry runs combined read -> succeeds -> clears pin, merges row, NEVER resends setItemLoss!
    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(getHeldWrite(lossSubject('oil'))).toBeNull();
    });
    expect(setItemLoss).toHaveBeenCalledTimes(1);
    expect(hasAnyHeldWrite()).toBe(false);
    expect(screen.getByText('فاقد 10%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
  });

  it('R9-1b: Conversion verification uses ONE combined read (conversions + schedule + getItemById) with single item-id pin target and resumes on ItemsPage mount', async () => {
    const reload = vi.fn();
    const postMessage = vi.fn();
    setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

    let capturedRequestId = '';
    vi.mocked(addConversion).mockImplementation(
      (_itemId, _unit, _factor, _baseUnit, write) => {
        capturedRequestId = write.requestId;
        return Promise.resolve();
      },
    );
    vi.mocked(listItems).mockResolvedValue([boxItem]);
    vi.mocked(getItemById)
      .mockRejectedValueOnce(new Error('box row read failed')) // post-save combined read fails
      .mockResolvedValueOnce({ ...boxItem, identityLocked: true }); // mount resume succeeds

    const view1 = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'علبة' });
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    await within(card).findByRole('option', { name: 'كرتونة' });

    fireEvent.change(within(card).getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(within(card).getByLabelText('المعامل'), {
      target: { value: '12' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'ضيف التحويل' }));

    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('box row read failed')).toBeInTheDocument();
    });
    // Combined read did NOT call listItems() again!
    expect(listItems).toHaveBeenCalledTimes(1);
    const subject = conversionSubject('box', 'كرتونة');
    const held = getHeldWrite(subject);
    expect(held?.phase).toBe('posted_reload');
    expect(held?.requestId).toBe(capturedRequestId);
    expect(held?.readTarget).toBe('box');
    expect(
      (held as { readTargets?: unknown } | null)?.readTargets,
    ).toBeUndefined();
    expect(hasAnyHeldWrite()).toBe(true);
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
    view1.unmount();

    // Remount ItemsPage (ConversionsPanel is closed) -> resumes combined read automatically and clears pin!
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(getHeldWrite(subject)).toBeNull();
    });
    expect(addConversion).toHaveBeenCalledTimes(1);
    expect(hasAnyHeldWrite()).toBe(false);
  });

  it('R9-1c: setHeldWritePhase and updateHeldWritePayload skip if another tab already cleared the durable record (no resurrection)', async () => {
    const tab1 = createHeldWriteStore();
    const tab2 = createHeldWriteStore();
    try {
      tab1.setHeldWriteUser('user-cross');
      tab2.setHeldWriteUser('user-cross');

      const claim = await tab1.claimFreshHeldWrite(
        'purchase:new',
        (requestId) => ({ requestId, total: 100 }),
        { kind: 'purchase' },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      const reqId = claim.record.requestId;
      claim.release();

      // Another tab clears the durable record from localStorage directly (before storage event fires in tab1).
      tab2.clearHeldWrite('purchase:new', reqId);
      expect(localStorage.length).toBe(0);

      // Tab 1 attempts to update phase or payload -> MUST re-read durable storage and skip (NOT resurrect!).
      tab1.setHeldWritePhase('purchase:new', reqId, 'unknown');
      expect(localStorage.length).toBe(0);
      expect(tab1.getHeldWrite('purchase:new')).toBeNull();
      expect(tab1.hasAnyHeldWrite()).toBe(false);

      tab1.updateHeldWritePayload('purchase:new', reqId, {
        requestId: reqId,
        total: 200,
      });
      expect(localStorage.length).toBe(0);
      expect(tab1.getHeldWrite('purchase:new')).toBeNull();
    } finally {
      tab1.dispose();
      tab2.dispose();
    }
  });

  it('R9-2: Stale-item refresh lock stays disabled with read-only retry when refresh is superseded and no fresh row for that item was applied', async () => {
    let resolveSchedule!: (value: {
      lossToken: string;
      identity: string;
      lossVersions: [];
      conversions: [];
    }) => void;
    let resolveStaleRefresh!: (value: CatalogItem | null) => void;
    let rejectSupersedingCatalog!: (error: Error) => void;

    vi.mocked(updateItem).mockRejectedValueOnce(new StaleWriteError());
    vi.mocked(listCostingSchedule).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSchedule = resolve;
        }),
    );
    let listCall = 0;
    vi.mocked(listItems).mockImplementation(() => {
      listCall += 1;
      if (listCall === 1) return Promise.resolve([oilItem]);
      // Superseding reloadCatalog('oil') triggered by onItemStale that will FAIL (no fresh row applied).
      return new Promise<CatalogItem[]>((_resolve, reject) => {
        rejectSupersedingCatalog = reject;
      });
    });
    let byIdCall = 0;
    vi.mocked(getItemById).mockImplementation(() => {
      byIdCall += 1;
      if (byIdCall === 1) {
        return new Promise<CatalogItem | null>((resolve) => {
          resolveStaleRefresh = resolve;
        });
      }
      return Promise.resolve({ ...oilItem, name: 'زيت محدث فعلاً' });
    });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت قديم' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    await waitFor(() => expect(byIdCall).toBe(1));
    // While the stale refresh is in flight, ItemForm's schedule load reports a stale identity
    // -> triggers reloadCatalog('oil'), superseding the in-flight stale refresh!
    await act(async () => {
      resolveSchedule({
        lossToken: emptyScheduleToken,
        identity: 'kg|ingredient||',
        lossVersions: [],
        conversions: [],
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(listCall).toBe(2));

    // The superseding catalog reload FAILS (no fresh row applied), then the superseded
    // stale refresh settles with stale data.
    await act(async () => {
      rejectSupersedingCatalog(new Error('stale catalog failed'));
      resolveStaleRefresh({ ...oilItem, name: 'زيت من قراءة قديمة' });
      await Promise.resolve();
    });

    // Save MUST stay disabled (lock NOT cleared because the refresh was superseded without applying a fresh row!).
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'حفظ البيانات' }),
      ).toBeDisabled();
    });
    expect(screen.getByLabelText('الاسم')).not.toHaveValue(
      'زيت من قراءة قديمة',
    );
    const refreshBtn = await screen.findByRole('button', {
      name: 'تحديث البيانات',
    });
    expect(refreshBtn).toBeEnabled();

    // Clicking read-only refresh applies the fresh row for 'oil' and unlocks Save.
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(screen.getByLabelText('الاسم')).toHaveValue('زيت محدث فعلاً');
    });
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeEnabled();
  });

  it('R9-3: Acknowledged item details save refreshes the item by ID via getItemById instead of capped listItems', async () => {
    vi.mocked(listItems).mockResolvedValueOnce([oilItem]);
    vi.mocked(updateItem).mockResolvedValueOnce(undefined);
    vi.mocked(getItemById).mockResolvedValueOnce({
      ...oilItem,
      name: 'زيت ممتاز',
    });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت ممتاز' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    await waitFor(() => {
      expect(getItemById).toHaveBeenCalledWith('oil');
    });
    // Must NOT call capped listItems() again after acknowledged updateItem!
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole('heading', { name: 'زيت ممتاز' }),
    ).toBeInTheDocument();
  });

  it('R9-4: ExpensesPage category verification ignores a superseded FAILED read so it cannot relock controls already verified by a newer success', async () => {
    let rejectOlderCategoryVerify!: (error: Error) => void;
    let janCalls = 0;

    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) => {
      if (monthStart === '2026-01-01') {
        janCalls += 1;
        if (janCalls === 1) {
          return Promise.resolve(expenseMonth('2026-01-01'));
        }
        if (janCalls === 2) {
          // Immediate verification read after ambiguous rename fails -> shows "تحقق تاني"
          return Promise.reject(new Error('first jan verify failed'));
        }
        // Delayed category verification started via "تحقق تاني" -> will REJECT after Feb succeeds!
        return new Promise<ExpenseMonth>((_resolve, reject) => {
          rejectOlderCategoryVerify = reject;
        });
      }
      // Newer February read succeeds and returns fresh categories!
      return Promise.resolve(
        expenseMonth(monthStart, {
          categories: [
            { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
            { id: 'gas', name: 'غاز جديد', kind: 'daily', active: true },
          ],
        }),
      );
    });
    vi.mocked(renameExpenseCategory).mockRejectedValueOnce(
      new Error('network lost'),
    );

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );

    // Switch to January 2026.
    const picker = await screen.findByLabelText('الشهر');
    fireEvent.change(picker, { target: { value: '2026-01' } });
    await waitFor(() => {
      expect(loadExpenseMonth).toHaveBeenCalledWith('2026-01-01');
    });

    // Trigger ambiguous category rename -> immediate read fails -> "تحقق تاني" shown & controls disabled.
    const renameInput = await screen.findByLabelText('اسم غاز');
    fireEvent.change(renameInput, { target: { value: 'غاز جديد' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ اسم غاز' }));
    const retryReadBtn = await screen.findByRole('button', {
      name: 'تحقق تاني',
    });
    expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeDisabled();

    // Start delayed January category verification read.
    fireEvent.click(retryReadBtn);
    await waitFor(() => expect(janCalls).toBe(3));

    // Switch to February while delayed January category read is still pending -> February succeeds and verifies categories!
    fireEvent.change(picker, { target: { value: '2026-02' } });
    expect(
      await screen.findByRole('article', { name: 'غاز جديد' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'تحقق تاني' }),
    ).not.toBeInTheDocument();

    // Now the OLDER delayed January category read REJECTS!
    await act(async () => {
      rejectOlderCategoryVerify(new Error('stale jan verify failed'));
      await Promise.resolve();
    });

    // Older failure MUST NOT relock category controls or re-show "تحقق تاني"!
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeEnabled();
    });
    expect(
      screen.queryByRole('button', { name: 'تحقق تاني' }),
    ).not.toBeInTheDocument();
  });
});
