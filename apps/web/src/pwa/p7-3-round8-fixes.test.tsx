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
import * as itemsApi from '@/items/api';
import {
  addConversion,
  costingImpact,
  createItem,
  currentShiftStart,
  listConversions,
  listCostingSchedule,
  listItems,
  listUnitOptions,
  setItemLoss,
  setOpeningPrice,
  updateItem,
} from '@/items/api';
import { emptyScheduleToken } from '@/items/effective';
import { StaleWriteError, staleWriteMessage } from '@/items/errors';
import {
  conversionSubject,
  lossSubject,
  resetHeldWrites,
} from '@/items/request-id';
import type { CatalogItem, DatedWrite } from '@/items/types';
import {
  getHeldWrite,
  hasAnyHeldWrite,
  hasPostedReloadForTarget,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWriteUser,
  userStoragePrefix,
} from '@/lib/held-writes';
import {
  applyPwaUpdate,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ItemsPage } from '@/pages/ItemsPage';

const mocks = vi.hoisted(() => ({
  getItemById: vi.fn(),
}));

vi.mock('@/items/api', () => ({
  ITEMS_RELOAD_SUBJECT: 'items:reload',
  listItems: vi.fn(),
  getItemById: mocks.getItemById,
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

describe('P7-3 round-8 review fixes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetPwaState();
    setPwaAuthResolved(true);
    setHeldWriteUser('owner-r8');
    setOnline(true);

    vi.mocked(listItems).mockResolvedValue([oilItem, boxItem]);
    mocks.getItemById.mockImplementation((id: string) =>
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

  it('R8-1: ItemsPage keeps editor locked and offers only a read-only refresh when compare-and-set fails and follow-up read also fails', async () => {
    vi.mocked(updateItem).mockRejectedValueOnce(new StaleWriteError());
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockRejectedValueOnce(new Error('stale reload down'))
      .mockResolvedValueOnce([{ ...oilItem, name: 'زيت محدث من جهاز تاني' }]);
    mocks.getItemById.mockResolvedValueOnce({
      ...oilItem,
      name: 'زيت محدث من جهاز تاني',
    });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    expect(await screen.findByText('stale reload down')).toBeInTheDocument();
    // Save MUST stay disabled (never re-enabled with the stale expectation).
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeDisabled();
    // Must offer a read-only refresh button (and NOT show "مش متأكد إنه اتحفظ" since CAS proved refusal).
    expect(screen.queryByText('مش متأكد إنه اتحفظ')).not.toBeInTheDocument();
    const refreshBtn = screen.getByRole('button', { name: 'تحديث البيانات' });
    expect(refreshBtn).toBeEnabled();
    expect(updateItem).toHaveBeenCalledTimes(1);

    // Clicking refresh performs read-only fetch, updates form to fresh server state, and unlocks Save.
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(screen.getByLabelText('الاسم')).toHaveValue(
        'زيت محدث من جهاز تاني',
      );
    });
    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(screen.getByText(staleWriteMessage)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeEnabled();
  });

  it('R8-2: ExpensesPage per-month sequence prevents an older delayed January verification read from overwriting newer January data or re-enabling writes from stale data', async () => {
    let resolveDelayedVerify!: (value: ExpenseMonth) => void;
    let janCalls = 0;

    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) => {
      if (monthStart === '2026-01-01') {
        janCalls += 1;
        if (janCalls === 1) {
          // Initial January load
          return Promise.resolve(
            expenseMonth('2026-01-01', { complete: false }),
          );
        }
        if (janCalls === 2) {
          // Immediate verification read after ambiguous failure -> fails so "تحقق تاني" appears
          return Promise.reject(new Error('jan verify down'));
        }
        if (janCalls === 3) {
          // Delayed verification read started when clicking "تحقق تاني"
          return new Promise<ExpenseMonth>((resolve) => {
            resolveDelayedVerify = resolve;
          });
        }
        // Newer regular January read after switching Feb -> Jan returns FRESH complete: true!
        return Promise.resolve(expenseMonth('2026-01-01', { complete: true }));
      }
      return Promise.resolve(expenseMonth(monthStart, { complete: false }));
    });
    vi.mocked(setMonthExpenseComplete).mockRejectedValueOnce(
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

    // Click month complete -> ambiguous error + failed immediate read -> "تحقق تاني" offered.
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    const retryReadBtn = await screen.findByRole('button', {
      name: 'تحقق تاني',
    });

    // Start the delayed January verification read.
    fireEvent.click(retryReadBtn);
    await waitFor(() => expect(janCalls).toBe(3));

    // Switch to February and back to January while delayed verification is still pending.
    fireEvent.change(picker, { target: { value: '2026-02' } });
    await waitFor(() => {
      expect(loadExpenseMonth).toHaveBeenCalledWith('2026-02-01');
    });
    fireEvent.change(picker, { target: { value: '2026-01' } });

    // Newer regular January read resolves FIRST with complete: true!
    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
      ).toBeChecked();
    });

    // Now the OLDER delayed January verification resolves with STALE complete: false!
    await act(async () => {
      resolveDelayedVerify(expenseMonth('2026-01-01', { complete: false }));
      await Promise.resolve();
    });

    // Stale verification MUST NOT overwrite the newer January complete: true state!
    expect(
      screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    ).toBeChecked();
  });

  it('R8-3a: Loss save keeps real request id held in posted_reload when schedule read succeeds but catalog refresh fails, blocking shell updates until catalog reload succeeds', async () => {
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
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockRejectedValueOnce(new Error('catalog refresh failed'))
      .mockResolvedValueOnce([
        {
          ...oilItem,
          lossPct: 0.1,
          lossFractionText: '0.1',
          identityLocked: true,
        },
      ]);

    render(
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

    expect(
      await screen.findByText('catalog refresh failed'),
    ).toBeInTheDocument();
    expect(capturedRequestId).not.toBe('');
    // Wait a tick for ItemForm's schedule reload to finish too.
    await waitFor(() => {
      expect(listCostingSchedule).toHaveBeenCalledTimes(2);
    });

    // Real loss pin MUST STILL be held in posted_reload because catalog refresh failed!
    const held = getHeldWrite(lossSubject('oil'));
    expect(held?.phase).toBe('posted_reload');
    expect(held?.requestId).toBe(capturedRequestId);
    expect(hasPostedReloadForTarget('items:reload')).toBe(true);
    expect(hasAnyHeldWrite()).toBe(true);
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();

    // Survives reload/rehydration.
    rehydrateHeldWrites();
    expect(getHeldWrite(lossSubject('oil'))?.phase).toBe('posted_reload');
    expect(hasAnyHeldWrite()).toBe(true);

    // Retrying catalog load now succeeds -> real loss pin clears completely!
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(getHeldWrite(lossSubject('oil'))).toBeNull();
    });
    expect(hasAnyHeldWrite()).toBe(false);
  });

  it('R8-3b: Conversion save keeps real request id held in posted_reload when conversion schedule read succeeds but catalog refresh fails, blocking shell updates until catalog reload succeeds', async () => {
    const reload = vi.fn();
    const postMessage = vi.fn();
    setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

    let capturedRequestId = '';
    const savedRows: Array<{
      itemId: string;
      unit: string;
      factorToBase: number;
      storedFactor: string;
    }> = [];
    vi.mocked(listConversions).mockImplementation(() =>
      Promise.resolve({ baseUnit: 'piece', rows: [...savedRows] }),
    );
    vi.mocked(addConversion).mockImplementation(
      (itemId, unit, factor, _baseUnit, write) => {
        capturedRequestId = write.requestId;
        savedRows.push({
          itemId,
          unit,
          factorToBase: Number(factor),
          storedFactor: factor,
        });
        return Promise.resolve();
      },
    );
    vi.mocked(listItems)
      .mockResolvedValueOnce([boxItem])
      .mockRejectedValueOnce(new Error('catalog refresh failed after conv'))
      .mockResolvedValueOnce([{ ...boxItem, identityLocked: true }]);

    render(
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

    expect(
      await screen.findByText('catalog refresh failed after conv'),
    ).toBeInTheDocument();
    expect(capturedRequestId).not.toBe('');

    const subject = conversionSubject('box', 'كرتونة');
    const held = getHeldWrite(subject);
    expect(held?.phase).toBe('posted_reload');
    expect(held?.requestId).toBe(capturedRequestId);
    expect(hasPostedReloadForTarget('items:reload')).toBe(true);
    expect(hasAnyHeldWrite()).toBe(true);
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();

    // Retrying catalog load succeeds -> real conversion pin clears completely!
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(getHeldWrite(subject)).toBeNull();
    });
    expect(hasAnyHeldWrite()).toBe(false);
  });

  it('R8-4a: ItemsPage verifies ambiguous details update by ID via getItemById and does NOT mark verification done when item is missing', async () => {
    vi.mocked(listItems).mockResolvedValueOnce([oilItem]);
    vi.mocked(updateItem).mockRejectedValueOnce(new Error('network lost'));
    // First verification by ID returns null (missing item) -> must NOT unlock!
    // Second verification ("تحقق تاني") returns the actual server row -> unlocks and refreshes!
    mocks.getItemById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...oilItem, name: 'زيت من السيرفر' });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت معدل' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    // Must verify by ID using getItemById (NOT a second listItems call!).
    await waitFor(() => {
      expect(mocks.getItemById).toHaveBeenCalledWith('oil');
    });
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('مش متأكد إنه اتحفظ')).toBeInTheDocument();
    // Because item was missing (null), verification MUST NOT be marked done!
    const retryReadBtn = await screen.findByRole('button', {
      name: 'تحقق تاني',
    });
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeDisabled();

    // Also verify that api module exports getItemById.
    expect(typeof (itemsApi as { getItemById?: unknown }).getItemById).toBe(
      'function',
    );

    // Click "تحقق تاني" -> calls getItemById('oil') again -> finds actual server row -> unlocks!
    fireEvent.click(retryReadBtn);
    await waitFor(() => {
      expect(mocks.getItemById).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByLabelText('الاسم')).toHaveValue('زيت من السيرفر');
    });
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'تحقق تاني' }),
    ).not.toBeInTheDocument();
  });

  it('R8-5: Scoped hydration discards orphaned retired request-less pins and legacy reload markers so earlier builds do not block PWA updates', () => {
    const reload = vi.fn();
    const postMessage = vi.fn();
    setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

    const userPrefix = userStoragePrefix('owner-legacy');
    const otherUserPrefix = userStoragePrefix('owner-other');
    const reloadPrefix = userPrefix.replace(
      'theshark:held:v1:',
      'theshark:reload:v1:',
    );
    const otherReloadPrefix = otherUserPrefix.replace(
      'theshark:held:v1:',
      'theshark:reload:v1:',
    );

    // Seed retired request-less pins (active + posted) and legacy reload markers for owner-legacy.
    localStorage.setItem(
      `${userPrefix}${encodeURIComponent('item:details:oil')}`,
      JSON.stringify({
        v: 1,
        subject: 'item:details:oil',
        kind: 'item_details',
        requestId: 'old-req-1',
        payload: { itemId: 'oil' },
        phase: 'unknown',
      }),
    );
    localStorage.setItem(
      `${userPrefix}posted:${encodeURIComponent('expense:complete:2026-01-01')}:old-req-2`,
      JSON.stringify({
        v: 1,
        subject: 'expense:complete:2026-01-01',
        kind: 'expense_complete',
        requestId: 'old-req-2',
        payload: null,
        phase: 'posted_reload',
        readTarget: '2026-01-01',
      }),
    );
    localStorage.setItem(
      `${userPrefix}${encodeURIComponent('expense:category:add')}`,
      JSON.stringify({
        v: 1,
        subject: 'expense:category:add',
        kind: 'expense_category',
        requestId: 'old-req-3',
        payload: { kind: 'category_add' },
        phase: 'inflight',
      }),
    );
    localStorage.setItem(
      `${reloadPrefix}${encodeURIComponent('items:reload')}:marker-1`,
      JSON.stringify({ v: 1, subject: 'items:reload', id: 'marker-1' }),
    );
    localStorage.setItem(
      `${reloadPrefix}${encodeURIComponent('expense:reload')}:marker-2`,
      JSON.stringify({
        v: 1,
        subject: 'expense:reload',
        id: 'marker-2',
        target: '2026-01-01',
      }),
    );

    // Seed another user's keys to prove cleanup is strictly scoped to the active user.
    const otherKey = `${otherUserPrefix}${encodeURIComponent('item:details:oil')}`;
    const otherMarkerKey = `${otherReloadPrefix}${encodeURIComponent('items:reload')}:marker-other`;
    localStorage.setItem(
      otherKey,
      JSON.stringify({
        v: 1,
        subject: 'item:details:oil',
        kind: 'item_details',
        requestId: 'other-req',
        payload: {},
        phase: 'unknown',
      }),
    );
    localStorage.setItem(
      otherMarkerKey,
      JSON.stringify({ v: 1, subject: 'items:reload', id: 'marker-other' }),
    );

    // Hydrate owner-legacy -> all retired pins and reload markers for owner-legacy are discarded.
    setHeldWriteUser('owner-legacy');
    expect(hasAnyHeldWrite()).toBe(false);
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    // Confirm owner-legacy retired keys were removed from storage while owner-other keys remain untouched.
    expect(
      localStorage.getItem(
        `${userPrefix}${encodeURIComponent('item:details:oil')}`,
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        `${userPrefix}posted:${encodeURIComponent('expense:complete:2026-01-01')}:old-req-2`,
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        `${userPrefix}${encodeURIComponent('expense:category:add')}`,
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        `${reloadPrefix}${encodeURIComponent('items:reload')}:marker-1`,
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        `${reloadPrefix}${encodeURIComponent('expense:reload')}:marker-2`,
      ),
    ).toBeNull();
    expect(localStorage.getItem(otherKey)).not.toBeNull();
    expect(localStorage.getItem(otherMarkerKey)).not.toBeNull();

    // Real request-id pins for owner-legacy MUST NOT be discarded.
    const realKey = `${userPrefix}${encodeURIComponent('purchase:new')}`;
    localStorage.setItem(
      realKey,
      JSON.stringify({
        v: 1,
        subject: 'purchase:new',
        kind: 'purchase',
        requestId: 'real-purchase-1',
        payload: { requestId: 'real-purchase-1' },
        phase: 'unknown',
      }),
    );
    rehydrateHeldWrites();
    expect(hasAnyHeldWrite()).toBe(true);
    expect(getHeldWrite('purchase:new')?.requestId).toBe('real-purchase-1');
  });
});
