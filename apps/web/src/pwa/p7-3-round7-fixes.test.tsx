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
import { StaleWriteError, staleWriteMessage } from '@/items/errors';
import { resetHeldWrites } from '@/items/request-id';
import type { CatalogItem } from '@/items/types';
import { cairoMonthInput } from '@/lib/cairo';
import {
  clearHeldWrite,
  getHeldWrite,
  hasReloadMarker,
  putHeldWrite,
  resetHeldWritesStore,
  setHeldWriteUser,
  setReloadMarker,
  updateHeldWritePayload,
} from '@/lib/held-writes';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ItemsPage } from '@/pages/ItemsPage';

const mocks = vi.hoisted(() => ({
  supabaseSchema: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { schema: mocks.supabaseSchema },
  readSupabaseEnv: () => ({ url: 'https://test.supabase.co', anonKey: 'k' }),
}));

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

describe('P7-3 round-7 request-less reconcile helper fixes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    setOnline(true);
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true });
    setHeldWriteUser('owner-1');
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetHeldWritesStore({ clearStorage: true });
    localStorage.clear();
    setOnline(true);
  });

  it('R7-1: absence verification is invalidated on replay dispatch and failed read (replay only offered after check for CURRENT attempt)', async () => {
    // ItemsPage: Attempt 1 fails -> targeted read #1 proves absent -> replay shown.
    // Replay (Attempt 2) fails AND targeted read #2 fails -> replay MUST NOT be offered!
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem]) // initial mount
      .mockResolvedValueOnce([oilItem]) // targeted read after Attempt 1 -> absent
      .mockRejectedValueOnce(new Error('read 2 down')); // targeted read after Attempt 2 fails
    vi.mocked(updateItem)
      .mockRejectedValueOnce(new Error('net 1'))
      .mockRejectedValueOnce(new Error('net 2'));

    const itemsView = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت ممتاز' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    const retryItemBtn = await screen.findByRole('button', {
      name: 'إعادة محاولة حفظ بيانات الصنف',
    });
    fireEvent.click(retryItemBtn);

    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledTimes(2);
    });
    // After Attempt 2 fails + its verification read fails, replay button MUST be gone
    // and replaced with read-only verify button!
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'إعادة محاولة حفظ بيانات الصنف' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'التحقق من حالة الحفظ' }),
      ).toBeInTheDocument();
    });
    itemsView.unmount();

    // ExpensesPage: same invariant for month confirmation!
    const monthStart = `${cairoMonthInput()}-01`;
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: false })) // mount
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: false })) // read after Attempt 1
      .mockRejectedValueOnce(new Error('expense read 2 down')); // read after Attempt 2 fails
    vi.mocked(setMonthExpenseComplete)
      .mockRejectedValueOnce(new Error('net 1'))
      .mockRejectedValueOnce(new Error('net 2'));

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    const retryExpBtn = await screen.findByRole('button', {
      name: 'إعادة محاولة تأكيد الشهر',
    });
    fireEvent.click(retryExpBtn);

    await waitFor(() => {
      expect(setMonthExpenseComplete).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'إعادة محاولة تأكيد الشهر' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'التحقق من حالة الحفظ' }),
      ).toBeInTheDocument();
    });
  });

  it('R7-2: an old read started before a newer attempt cannot clear or verify-absent the newer attempt', async () => {
    // Seed an unknown item-details pin (legacy flat shape, attempt 1) before mounting ItemsPage.
    const flatIntent = {
      itemId: 'oil',
      draft: {
        name: 'زيت ممتاز',
        kind: 'ingredient',
        baseUnit: 'liter',
        countFrequency: 'weekly',
        parentItemId: null,
        lossPct: '0',
        active: true,
      },
      expected: {
        name: 'زيت',
        kind: 'ingredient',
        baseUnit: 'liter',
        countFrequency: 'weekly',
        parentItemId: null,
        active: true,
      },
    };
    putHeldWrite('item:details:oil', {
      requestId: 'req-details-1',
      kind: 'item_details',
      phase: 'unknown',
      payload: flatIntent,
    });

    // Mount read #1 resolves as unchanged -> verifies attempt 1 absent -> shows replay button.
    // Then trigger a slow read #2 via reconnect; while slow read #2 is in flight, a newer
    // requestId / attempt replaces the pin (simulating a newer attempt), then slow read #2
    // resolves with the NEW name: the OLD read MUST NOT clear the newer pin!
    let resolveSlowRead!: (items: CatalogItem[]) => void;
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem]) // initial mount read (verifies attempt 1 absent)
      .mockImplementationOnce(
        () =>
          new Promise<CatalogItem[]>((resolve) => {
            resolveSlowRead = resolve;
          }),
      );

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    await screen.findByRole('button', {
      name: 'إعادة محاولة حفظ بيانات الصنف',
    });

    // Start a slow read while req-details-1 (attempt 1) is unknown.
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(listItems).toHaveBeenCalledTimes(2);
    });

    // While the old read (attempt 1) is in flight, advance req-details-1 to attempt 2
    // (simulating a newer replay attempt on the same subject).
    updateHeldWritePayload('item:details:oil', 'req-details-1', {
      intent: flatIntent,
      attempt: 2,
    });

    // Resolve the OLD read (started when attempt was 1) with the new name.
    resolveSlowRead([{ ...oilItem, name: 'زيت ممتاز' }]);
    await new Promise((r) => setTimeout(r, 30));

    // Attempt 2 MUST NOT have been cleared by the old read from Attempt 1!
    expect(getHeldWrite('item:details:oil')?.requestId).toBe('req-details-1');
    expect(getHeldWrite('item:details:oil')?.phase).toBe('unknown');

    // Also verify a newer requestId (after clearing old pin) is untouched by an older read.
    let resolveSlowRead2!: (items: CatalogItem[]) => void;
    vi.mocked(listItems).mockImplementationOnce(
      () =>
        new Promise<CatalogItem[]>((resolve) => {
          resolveSlowRead2 = resolve;
        }),
    );
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(listItems).toHaveBeenCalledTimes(3);
    });
    clearHeldWrite('item:details:oil', 'req-details-1');
    putHeldWrite('item:details:oil', {
      requestId: 'req-details-2',
      kind: 'item_details',
      phase: 'unknown',
      payload: flatIntent,
    });
    resolveSlowRead2([{ ...oilItem, name: 'زيت ممتاز' }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(getHeldWrite('item:details:oil')?.requestId).toBe('req-details-2');
    expect(getHeldWrite('item:details:oil')?.phase).toBe('unknown');
  });

  it('R7-3: expenses/api preserves SQLSTATE and ExpensesPage treats 23505/22023/23514/42501 as definite refusals (clears pin, no replay offer)', async () => {
    const actualExpensesApi =
      await vi.importActual<typeof import('@/expenses/api')>('@/expenses/api');
    const monthStart = `${cairoMonthInput()}-01`;
    vi.mocked(loadExpenseMonth).mockResolvedValue(expenseMonth(monthStart));

    // Use real addExpenseCategory & renameExpenseCategory wired to mocked supabase.schema
    vi.mocked(addExpenseCategory).mockImplementation(
      actualExpensesApi.addExpenseCategory,
    );
    vi.mocked(renameExpenseCategory).mockImplementation(
      actualExpensesApi.renameExpenseCategory,
    );
    vi.mocked(setMonthExpenseComplete).mockImplementation(
      actualExpensesApi.setMonthExpenseComplete,
    );

    const rpcMock = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint',
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'permission denied' },
      });
    mocks.supabaseSchema.mockReturnValue({ rpc: rpcMock });

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );

    // 1. Duplicate category name (23505): pin MUST be cleared, error shown, NO replay button!
    fireEvent.change(await screen.findByLabelText('اسم التصنيف'), {
      target: { value: 'غاز' },
    });
    fireEvent.change(screen.getByLabelText('نوع التصنيف'), {
      target: { value: 'daily' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف تصنيف' }));

    expect(
      await screen.findByText('الاسم ده موجود قبل كده'),
    ).toBeInTheDocument();
    expect(getHeldWrite('expense:category:add')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'إعادة محاولة حفظ التصنيف' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'التحقق من حالة الحفظ' }),
    ).not.toBeInTheDocument();

    // 2. Permission denied (42501) on month confirmation: pin MUST be cleared, error shown, NO replay button!
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    expect(await screen.findByText('مفيش صلاحية')).toBeInTheDocument();
    expect(getHeldWrite(`expense:complete:${monthStart}`)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'إعادة محاولة تأكيد الشهر' }),
    ).not.toBeInTheDocument();
  });

  it('R7-4: acknowledged replay reads pin own target month (January) even when another month is displayed, and mount resumes outstanding target reads', async () => {
    const currentMonthStart = `${cairoMonthInput()}-01`;
    expect(currentMonthStart).not.toBe('2026-01-01');

    // Part A: January has an unknown confirmation pin while owner views current month (2026-11).
    putHeldWrite('expense:complete:2026-01-01', {
      requestId: 'req-jan-complete',
      kind: 'expense_complete',
      phase: 'unknown',
      payload: { kind: 'complete', monthStart: '2026-01-01', complete: true },
    });
    let janComplete = false;
    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) => {
      if (monthStart === '2026-01-01') {
        return Promise.resolve(
          expenseMonth('2026-01-01', { complete: janComplete }),
        );
      }
      return Promise.resolve(expenseMonth(monthStart, { complete: false }));
    });
    vi.mocked(setMonthExpenseComplete).mockImplementation(
      (monthStart, next) => {
        if (monthStart === '2026-01-01') janComplete = next;
        return Promise.resolve();
      },
    );

    const view1 = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );

    const retryJanBtn = await screen.findByRole('button', {
      name: 'إعادة محاولة تأكيد الشهر',
    });
    fireEvent.click(retryJanBtn);

    await waitFor(() => {
      expect(setMonthExpenseComplete).toHaveBeenCalledWith('2026-01-01', true);
    });
    // Post-replay read MUST read January (2026-01-01) and clear January's marker so writes unlock!
    await waitFor(() => {
      expect(hasReloadMarker('expense:reload', '2026-01-01')).toBe(false);
      expect(
        screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
      ).toBeEnabled();
    });
    view1.unmount();

    // Part B: Mount with an outstanding reload marker for January (2026-01-01) while viewing 2026-11
    // MUST resume reading January and clear January's marker!
    vi.mocked(loadExpenseMonth).mockClear();
    setReloadMarker('expense:reload', '2026-01-01');
    expect(hasReloadMarker('expense:reload', '2026-01-01')).toBe(true);

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(loadExpenseMonth).toHaveBeenCalledWith('2026-01-01');
      expect(hasReloadMarker('expense:reload', '2026-01-01')).toBe(false);
    });
  });

  it('R7-5: quota failure storing marker after acknowledgement keeps acknowledged inflight claim and lets post-ack read settle it', async () => {
    const origSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      key: string,
      value: string,
    ) {
      if (key.startsWith('theshark:reload:v1:')) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      return origSetItem(key, value);
    });

    // ItemsPage: updateItem succeeds, setReloadMarker throws quota, immediate readCatalog fails ->
    // acknowledged inflight claim stays held, recovery UI shows verify (NOT replay), next read settles it!
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockRejectedValueOnce(new Error('post-ack read failed'))
      .mockResolvedValueOnce([{ ...oilItem, name: 'زيت ممتاز' }]);
    vi.mocked(updateItem).mockResolvedValueOnce(undefined);

    const itemsView = render(
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
    // Exact acknowledged claim MUST remain in storage as inflight (no phantom reload marker)!
    await waitFor(() => {
      expect(getHeldWrite('item:details:oil')?.phase).toBe('inflight');
    });
    expect(hasReloadMarker('items:reload')).toBe(false);
    // Recovery UI handles acknowledged inflight claim with verify button (NEVER a replay button!).
    const verifyBtn = await screen.findByRole('button', {
      name: 'التحقق من حالة الحفظ',
    });
    expect(
      screen.queryByRole('button', { name: 'إعادة محاولة حفظ بيانات الصنف' }),
    ).not.toBeInTheDocument();

    // Clicking verify runs post-acknowledgement read -> settles and clears the acknowledged claim!
    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(getHeldWrite('item:details:oil')).toBeNull();
    });
    expect(updateItem).toHaveBeenCalledTimes(1); // NEVER re-sent!
    itemsView.unmount();

    // ExpensesPage: same quota failure path on setMonthExpenseComplete!
    const monthStart = `${cairoMonthInput()}-01`;
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: false }))
      .mockRejectedValueOnce(new Error('post-ack expense read failed'))
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: true }));
    vi.mocked(setMonthExpenseComplete).mockResolvedValueOnce(undefined);

    render(
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
    await waitFor(() => {
      expect(getHeldWrite(`expense:complete:${monthStart}`)?.phase).toBe(
        'inflight',
      );
    });
    expect(hasReloadMarker('expense:reload', monthStart)).toBe(false);
    const verifyExpBtn = await screen.findByRole('button', {
      name: 'التحقق من حالة الحفظ',
    });
    expect(
      screen.queryByRole('button', { name: 'إعادة محاولة تأكيد الشهر' }),
    ).not.toBeInTheDocument();

    fireEvent.click(verifyExpBtn);
    await waitFor(() => {
      expect(getHeldWrite(`expense:complete:${monthStart}`)).toBeNull();
    });
    expect(setMonthExpenseComplete).toHaveBeenCalledTimes(1); // NEVER re-sent!
  });

  it('R7-6: stale item replay (CAS 0 rows) re-reads item and settles as saved when intent is present or real conflict when absent', async () => {
    const seedUnknown = () =>
      putHeldWrite('item:details:oil', {
        requestId: 'req-stale-1',
        kind: 'item_details',
        phase: 'unknown',
        payload: {
          itemId: 'oil',
          draft: {
            name: 'زيت تاني',
            kind: 'ingredient',
            baseUnit: 'liter',
            countFrequency: 'weekly',
            parentItemId: null,
            lossPct: '0',
            active: true,
          },
          expected: {
            name: 'زيت',
            kind: 'ingredient',
            baseUnit: 'liter',
            countFrequency: 'weekly',
            parentItemId: null,
            active: true,
          },
        },
      });

    // Part A: replay hits StaleWriteError (CAS 0 rows), re-read finds intent ALREADY present -> saved, NO conflict error!
    seedUnknown();
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem]) // mount verifies absent
      .mockResolvedValueOnce([{ ...oilItem, name: 'زيت تاني' }]); // re-read after StaleWriteError finds intent present!
    vi.mocked(updateItem).mockRejectedValueOnce(new StaleWriteError());

    const view1 = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'إعادة محاولة حفظ بيانات الصنف',
      }),
    );
    expect(await screen.findByText('اتحفظت بيانات الصنف')).toBeInTheDocument();
    expect(screen.queryByText(staleWriteMessage)).not.toBeInTheDocument();
    expect(getHeldWrite('item:details:oil')).toBeNull();
    view1.unmount();

    // Part B: replay hits StaleWriteError, re-read finds DIFFERENT name ('زيت تالت') -> real conflict error!
    resetHeldWritesStore({ clearStorage: true });
    setHeldWriteUser('owner-1');
    seedUnknown();
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem]) // mount verifies absent
      .mockResolvedValueOnce([{ ...oilItem, name: 'زيت تالت' }]); // re-read finds real concurrent edit
    vi.mocked(updateItem).mockRejectedValueOnce(new StaleWriteError());

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'إعادة محاولة حفظ بيانات الصنف',
      }),
    );
    expect(await screen.findByText(staleWriteMessage)).toBeInTheDocument();
    expect(screen.queryByText('اتحفظت بيانات الصنف')).not.toBeInTheDocument();
    expect(getHeldWrite('item:details:oil')).toBeNull();
  });
});
