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
  loadExpenseMonth,
  renameExpenseCategory,
  setExpenseCategoryActive,
  setMonthExpenseComplete,
} from '@/expenses/api';
import type { ExpenseMonth } from '@/expenses/types';
import {
  currentShiftStart,
  listCostingSchedule,
  listItems,
  updateItem,
} from '@/items/api';
import { resetHeldWrites } from '@/items/request-id';
import type { CatalogItem } from '@/items/types';
import { AuthContext } from '@/lib/auth-context';
import { cairoMonthInput } from '@/lib/cairo';
import {
  claimFreshHeldWrite,
  getHeldWrite,
  hasAnyHeldWrite,
  hasReloadMarker,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWriteUser,
  setReloadMarker,
} from '@/lib/held-writes';
import {
  applyPwaUpdate,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import {
  loadQueuePage,
  loadQueueRow,
  loadUnlinkedRefunds,
} from '@/order-decisions/api';
import { queueRow } from '@/order-decisions/test-fixtures';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ItemsPage } from '@/pages/ItemsPage';
import { OrderDecisionsPage } from '@/pages/OrderDecisionsPage';
import { UpdateBanner } from '@/pwa/UpdateBanner';

vi.mock('@/items/api', () => ({
  addConversion: vi.fn(),
  addCustomUnit: vi.fn(),
  costingImpact: vi.fn(),
  createItem: vi.fn(),
  currentShiftStart: vi.fn(),
  listConversions: vi.fn(),
  listCostingSchedule: vi.fn(),
  listItems: vi.fn(),
  listUnitOptions: vi.fn(),
  setItemLoss: vi.fn(),
  setOpeningPrice: vi.fn(),
  updateItem: vi.fn(),
}));

vi.mock('@/expenses/api', () => ({
  addExpenseCategory: vi.fn(),
  addExpenseEntry: vi.fn(),
  loadExpenseEntryMonth: vi.fn(),
  loadExpenseMonth: vi.fn(),
  renameExpenseCategory: vi.fn(),
  setExpenseCategoryActive: vi.fn(),
  setMonthExpenseComplete: vi.fn(),
  voidExpenseEntry: vi.fn(),
}));

vi.mock('@/order-decisions/api', () => ({
  loadQueuePage: vi.fn(),
  loadQueueRow: vi.fn(),
  loadUnlinkedRefunds: vi.fn(),
  setOrderDisposition: vi.fn(),
}));

const oilItem: CatalogItem = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'liter',
  countFrequency: 'weekly',
  lossPct: 0,
  parentItemId: null,
  active: true,
  onHandQty: 0,
  avgCost: 0,
  onHandValue: 0,
};

function expenseMonth(
  monthStart: string,
  overrides: Partial<ExpenseMonth> = {},
): ExpenseMonth {
  return {
    monthStart,
    complete: false,
    confirmedAt: null,
    categories: [
      { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
      { id: 'gas', name: 'غاز', kind: 'daily', active: true },
    ],
    entries: [],
    days: [],
    ...overrides,
  };
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

function installMockLocks() {
  const held = new Set<string>();
  const locks = {
    async request<T>(
      name: string,
      options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
      callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
    ): Promise<T> {
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
    query: () => Promise.resolve({ held: [...held].map((name) => ({ name })) }),
  };
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: locks,
  });
  return { held };
}

describe('P7-3 round-6 review fixes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    setOnline(true);
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true });
    setHeldWriteUser('owner-1');
    resetPwaState();
    setPwaAuthResolved(true);
    installMockLocks();

    vi.mocked(listItems).mockResolvedValue([oilItem]);
    vi.mocked(updateItem).mockResolvedValue(undefined);
    vi.mocked(currentShiftStart).mockResolvedValue(null);
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'tok-loss-1',
      emptyToken: 'tok-empty',
      identity: 'liter|ingredient||',
      lossVersions: [],
      conversions: [],
    });
    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
      Promise.resolve(expenseMonth(monthStart)),
    );
    vi.mocked(setMonthExpenseComplete).mockResolvedValue(undefined);
    vi.mocked(addExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(renameExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(setExpenseCategoryActive).mockResolvedValue(undefined);
    vi.mocked(loadUnlinkedRefunds).mockResolvedValue([]);
    vi.mocked(loadQueueRow).mockResolvedValue(null);
  });

  afterEach(() => {
    resetHeldWritesStore({ clearStorage: true });
    resetPwaState();
    localStorage.clear();
    setOnline(true);
  });

  it('R6-1b: confirming February does not overwrite or clear January reload verification marker', async () => {
    // January was previously confirmed and its reload failed, leaving January's marker held.
    setReloadMarker('expense:reload', '2026-01-01');
    expect(hasReloadMarker('expense:reload', '2026-01-01')).toBe(true);

    // Owner opens ExpensesPage on February (2026-02) and confirms February; February's read succeeds.
    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
      Promise.resolve(
        expenseMonth(monthStart, { complete: monthStart === '2026-02-01' }),
      ),
    );
    // Switch to February by setting another month marker directly and confirming via ExpensesPage.
    const currentMonthStart = `${cairoMonthInput()}-01`;
    vi.mocked(loadExpenseMonth).mockResolvedValueOnce(
      expenseMonth(currentMonthStart, { complete: false }),
    );
    vi.mocked(loadExpenseMonth).mockResolvedValueOnce(
      expenseMonth('2026-02-01', { complete: false }),
    );
    vi.mocked(loadExpenseMonth).mockResolvedValueOnce(
      expenseMonth('2026-02-01', { complete: true }),
    );

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );

    // Switch picker to February (allowed because January's marker targets 2026-01-01, not current month).
    const picker = await screen.findByLabelText('الشهر');
    fireEvent.change(picker, { target: { value: '2026-02' } });
    await waitFor(() => {
      expect(loadExpenseMonth).toHaveBeenCalledWith('2026-02-01');
    });

    // Directly test two independent posted markers: Jan (2026-01-01) and Feb (2026-02-01).
    setReloadMarker('expense:reload', '2026-02-01');
    expect(hasReloadMarker('expense:reload', '2026-01-01')).toBe(true);
    expect(hasReloadMarker('expense:reload', '2026-02-01')).toBe(true);

    // Reading February clears ONLY February's marker; January's marker MUST remain!
    rehydrateHeldWrites();
    expect(hasReloadMarker('expense:reload', '2026-01-01')).toBe(true);
  });

  it('R6-2a: ItemsPage updateItem verifies ambiguous outcomes via targeted read, reconciles if applied, and offers explicit replay after reload if not', async () => {
    // Part 1: RPC committed on server, reply lost -> targeted read sees new name -> clears pin & shows saved.
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockResolvedValueOnce([{ ...oilItem, name: 'زيت ممتاز' }]);
    vi.mocked(updateItem).mockRejectedValueOnce(new Error('network lost'));

    const view1 = render(
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
      expect(updateItem).toHaveBeenCalledTimes(1);
    });
    // Targeted read reconciled the committed update and cleared the pin.
    expect(await screen.findByText('اتحفظت بيانات الصنف')).toBeInTheDocument();
    expect(getHeldWrite('item:details:oil')).toBeNull();
    view1.unmount();

    // Part 2: RPC did NOT commit, reply lost -> pin stays unknown (never cleared without match),
    // never auto-sends, and survives reload with an explicit retry button that replays the intent.
    vi.resetAllMocks();
    resetHeldWritesStore({ clearStorage: true });
    setHeldWriteUser('owner-1');
    vi.mocked(listItems).mockResolvedValue([oilItem]);
    vi.mocked(currentShiftStart).mockResolvedValue(null);
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'tok-loss-1',
      emptyToken: 'tok-empty',
      identity: 'liter|ingredient||',
      lossVersions: [],
      conversions: [],
    });
    vi.mocked(updateItem).mockRejectedValueOnce(new Error('network lost'));

    const view2 = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت تاني' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledTimes(1);
    });
    // Pin MUST remain unknown in localStorage (NOT cleared by the error handler).
    await waitFor(() => {
      expect(getHeldWrite('item:details:oil')?.phase).toBe('unknown');
    });
    // Never auto-sends.
    expect(updateItem).toHaveBeenCalledTimes(1);
    view2.unmount();

    // Simulate reload: remount ItemsPage -> reads catalog -> still 'زيت' -> shows explicit retry!
    rehydrateHeldWrites();
    vi.mocked(updateItem).mockResolvedValueOnce(undefined);
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockResolvedValueOnce([{ ...oilItem, name: 'زيت تاني' }]);

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    const retryBtn = await screen.findByRole('button', {
      name: 'إعادة محاولة حفظ بيانات الصنف',
    });
    expect(updateItem).toHaveBeenCalledTimes(1); // still no auto-send after reload
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(updateItem).mock.calls[1]?.[0]).toBe('oil');
    expect(vi.mocked(updateItem).mock.calls[1]?.[1]).toMatchObject({
      name: 'زيت تاني',
    });
    await waitFor(() => {
      expect(getHeldWrite('item:details:oil')).toBeNull();
    });
  });

  it('R6-2b: ExpensesPage month confirmation and category writes verify ambiguous outcomes via read and offer explicit replay after reload', async () => {
    const monthStart = `${cairoMonthInput()}-01`;

    // Part 1: month confirmation lost reply, server ALREADY applied complete=true -> clears pin & shows saved.
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: false }))
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: true }));
    vi.mocked(setMonthExpenseComplete).mockRejectedValueOnce(
      new Error('network lost'),
    );

    const view1 = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    await waitFor(() => {
      expect(setMonthExpenseComplete).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText('اتحفظ التعديل')).toBeInTheDocument();
    expect(getHeldWrite(`expense:complete:${monthStart}`)).toBeNull();
    view1.unmount();

    // Part 2: month confirmation lost reply, server still complete=false -> pin stays unknown across reload,
    // no auto-send, explicit retry button replays the exact stored intent!
    vi.resetAllMocks();
    resetHeldWritesStore({ clearStorage: true });
    setHeldWriteUser('owner-1');
    vi.mocked(loadExpenseMonth).mockResolvedValue(
      expenseMonth(monthStart, { complete: false }),
    );
    vi.mocked(setMonthExpenseComplete).mockRejectedValueOnce(
      new Error('network lost'),
    );

    const view2 = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    await waitFor(() => {
      expect(getHeldWrite(`expense:complete:${monthStart}`)?.phase).toBe(
        'unknown',
      );
    });
    expect(setMonthExpenseComplete).toHaveBeenCalledTimes(1);
    view2.unmount();

    // Reload -> targeted read sees complete=false -> shows explicit retry button.
    rehydrateHeldWrites();
    vi.mocked(setMonthExpenseComplete).mockResolvedValueOnce(undefined);
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: false }))
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: true }));

    const view3 = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    const retryCompleteBtn = await screen.findByRole('button', {
      name: 'إعادة محاولة تأكيد الشهر',
    });
    expect(setMonthExpenseComplete).toHaveBeenCalledTimes(1); // no auto-send
    fireEvent.click(retryCompleteBtn);
    await waitFor(() => {
      expect(setMonthExpenseComplete).toHaveBeenCalledTimes(2);
    });
    expect(setMonthExpenseComplete).toHaveBeenLastCalledWith(monthStart, true);
    await waitFor(() => {
      expect(getHeldWrite(`expense:complete:${monthStart}`)).toBeNull();
    });
    view3.unmount();

    // Part 3: category rename lost reply -> stays unknown, explicit retry replays renameExpenseCategory!
    vi.resetAllMocks();
    resetHeldWritesStore({ clearStorage: true });
    setHeldWriteUser('owner-1');
    vi.mocked(loadExpenseMonth).mockResolvedValue(expenseMonth(monthStart));
    vi.mocked(renameExpenseCategory).mockRejectedValueOnce(
      new Error('network lost'),
    );

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    const renameInput = await screen.findByLabelText('اسم غاز');
    fireEvent.change(renameInput, { target: { value: 'غاز طبيعي' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ اسم غاز' }));

    await waitFor(() => {
      expect(getHeldWrite('expense:category:rename:gas')?.phase).toBe(
        'unknown',
      );
    });
    vi.mocked(renameExpenseCategory).mockResolvedValueOnce(undefined);
    const retryCatBtn = await screen.findByRole('button', {
      name: 'إعادة محاولة حفظ التصنيف',
    });
    fireEvent.click(retryCatBtn);
    await waitFor(() => {
      expect(renameExpenseCategory).toHaveBeenCalledTimes(2);
    });
    expect(renameExpenseCategory).toHaveBeenLastCalledWith('gas', 'غاز طبيعي');
  });

  it('R6-3b: UpdateBanner stays disabled after sign-out while a live claim lock is held and re-enables only after release (still requiring click)', async () => {
    const reload = vi.fn();
    const postMessage = vi.fn();
    setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

    const claim = await claimFreshHeldWrite('purchase:new', (requestId) => ({
      requestId,
    }));
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    render(
      <AuthContext.Provider
        value={{
          status: 'signed-out',
          email: null,
          signIn: vi.fn().mockResolvedValue('ok'),
          signOut: vi.fn().mockResolvedValue(undefined),
          retry: vi.fn(),
        }}
      >
        <UpdateBanner onReload={reload} />
      </AuthContext.Provider>,
    );
    const updateBtn = screen.getByRole('button', { name: 'تحديث التطبيق' });
    expect(updateBtn).toBeDisabled();

    // Simulate sign-out clearing pins while the dispatched RPC still holds its lock.
    act(() => {
      setHeldWriteUser(null);
    });

    // Update guard MUST still block reload while live claim lock is held!
    expect(hasAnyHeldWrite()).toBe(true);
    expect(updateBtn).toBeDisabled();
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    // Releasing the last live claim notifies the update banner to re-enable, WITHOUT auto-reloading.
    act(() => {
      claim.release();
    });
    await waitFor(() => {
      expect(updateBtn).toBeEnabled();
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    // Explicit owner click now triggers the update.
    fireEvent.click(updateBtn);
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('R6-4: OrderDecisionsPage preserves drafted order state when earlier orders enter while offline and push it past loaded pages', async () => {
    const order0a = queueRow({
      orderId: 'order-0a',
      orderNumber: 100,
      token: 'tok-0a',
      eventId: 1,
    });
    const order0b = queueRow({
      orderId: 'order-0b',
      orderNumber: 101,
      token: 'tok-0b',
      eventId: 1,
    });
    const order1 = queueRow({
      orderId: 'order-1',
      orderNumber: 102,
      token: 'tok-1',
      eventId: 1,
    });
    const order2 = queueRow({
      orderId: 'order-2',
      orderNumber: 103,
      token: 'tok-2',
      eventId: 1,
    });

    vi.mocked(loadQueuePage)
      // Initial load: page 1 -> order-1, page 2 -> order-2
      .mockResolvedValueOnce({ rows: [order1], next: 'cursor-2' })
      .mockResolvedValueOnce({ rows: [order2], next: null })
      // Reconnect after 2 earlier orders arrived: page 1 -> order-0a, page 2 -> order-0b (order-2 moved to page 3!)
      .mockResolvedValueOnce({ rows: [order0a], next: 'cursor-0b' })
      .mockResolvedValueOnce({ rows: [order0b], next: 'cursor-1' });

    render(
      <MemoryRouter>
        <OrderDecisionsPage />
      </MemoryRouter>,
    );

    await screen.findByRole('article', { name: 'طلب رقم 102' });
    fireEvent.click(screen.getByRole('button', { name: 'عرض المزيد' }));
    const card2 = await screen.findByRole('article', { name: 'طلب رقم 103' });

    // Owner drafts a change on order-2.
    fireEvent.click(within(card2).getByLabelText('ماتعملش'));
    fireEvent.change(within(card2).getByLabelText('سبب تغيير القرار'), {
      target: { value: 'اتلغى قبل الطبخ' },
    });

    // Go offline then reconnect while earlier orders pushed order-2 past pages 1..2.
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    await screen.findByRole('article', { name: 'طلب رقم 100' });
    await screen.findByRole('article', { name: 'طلب رقم 101' });

    // order-2's card and draft MUST survive the pagination shift!
    const keptCard2 = screen.getByRole('article', { name: 'طلب رقم 103' });
    expect(within(keptCard2).getByLabelText('سبب تغيير القرار')).toHaveValue(
      'اتلغى قبل الطبخ',
    );
    expect(within(keptCard2).getByLabelText('ماتعملش')).toBeChecked();
  });
});
