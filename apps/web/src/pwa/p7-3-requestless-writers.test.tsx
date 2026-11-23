import {
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
  createItem,
  currentShiftStart,
  getItemById,
  listCostingSchedule,
  listItems,
  setItemLoss,
  setOpeningPrice,
  updateItem,
} from '@/items/api';
import {
  ConfirmedRefusalError,
  StaleWriteError,
  staleWriteMessage,
} from '@/items/errors';
import type { CatalogItem } from '@/items/types';
import { cairoMonthInput } from '@/lib/cairo';
import {
  bumpSessionGeneration,
  hasAnyHeldWrite,
  resetHeldWritesStore,
  setHeldWriteUser,
  setWritesLocked,
} from '@/lib/held-writes';
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
  currentShiftStart: vi.fn(),
  listCostingSchedule: vi.fn(),
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

function setNavigatorOnlineSilently(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: online,
  });
}

describe('P7-3 scope correction: request-less writers outside held-write store', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    setHeldWriteUser('owner-1');
    setOnline(true);

    vi.mocked(listItems).mockResolvedValue([oilItem]);
    vi.mocked(getItemById).mockResolvedValue(oilItem);
    vi.mocked(currentShiftStart).mockResolvedValue(null);
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'tok-loss-1',
      emptyToken: 'tok-empty',
      identity: 'liter|ingredient||',
      lossVersions: [],
      conversions: [],
    });
    vi.mocked(createItem).mockResolvedValue(undefined);
    vi.mocked(updateItem).mockResolvedValue(undefined);
    vi.mocked(setItemLoss).mockResolvedValue(undefined);
    vi.mocked(setOpeningPrice).mockResolvedValue(undefined);

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
    localStorage.clear();
    setOnline(true);
  });

  it('Rule 1: request-less writers disable controls while offline, recheck online/user/session before dispatch, and never write to localStorage', async () => {
    // 1. ItemsPage updateItem: offline disables controls, session generation bump blocks dispatch, zero localStorage.
    const itemsView = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    const saveBtn = screen.getByRole('button', { name: 'حفظ البيانات' });
    expect(saveBtn).toBeEnabled();

    setOnline(false);
    await waitFor(() => expect(saveBtn).toBeDisabled());
    setOnline(true);
    await waitFor(() => expect(saveBtn).toBeEnabled());

    // Silent offline right before dispatch blocks updateItem.
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت محجوب' },
    });
    setNavigatorOnlineSilently(false);
    fireEvent.click(saveBtn);
    await Promise.resolve();
    expect(updateItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);

    // Restore online, bump session generation right before dispatch -> blocked.
    setNavigatorOnlineSilently(true);
    bumpSessionGeneration();
    fireEvent.click(saveBtn);
    await Promise.resolve();
    expect(updateItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    itemsView.unmount();

    // 2. ExpensesPage month confirmation and categories: offline disables controls, user/lock change blocks dispatch, zero localStorage.
    setHeldWriteUser('owner-2');
    const expView = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    const completeBox = await screen.findByRole('checkbox', {
      name: 'مصاريف الشهر كاملة',
    });
    const addCatBtn = screen.getByRole('button', { name: 'ضيف تصنيف' });
    expect(completeBox).toBeEnabled();
    expect(addCatBtn).toBeEnabled();

    setOnline(false);
    await waitFor(() => {
      expect(completeBox).toBeDisabled();
      expect(addCatBtn).toBeDisabled();
    });
    setOnline(true);
    await waitFor(() => {
      expect(completeBox).toBeEnabled();
      expect(addCatBtn).toBeEnabled();
    });

    // Lock/sign-out right before dispatch blocks both month completion and category add.
    setWritesLocked(true);
    fireEvent.click(completeBox);
    fireEvent.change(screen.getByLabelText('اسم التصنيف'), {
      target: { value: 'كهربا' },
    });
    fireEvent.change(screen.getByLabelText('نوع التصنيف'), {
      target: { value: 'daily' },
    });
    fireEvent.click(addCatBtn);
    await Promise.resolve();
    expect(setMonthExpenseComplete).not.toHaveBeenCalled();
    expect(addExpenseCategory).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    expView.unmount();
  });

  it('Rule 2: definite server refusals (stale compare-and-set, 23505 uniqueness, SQLSTATE validation) show actionable errors with no ambiguous notice and nothing in localStorage', async () => {
    // 1. ItemsPage: StaleWriteError reloads item & shows staleWriteMessage, no ambiguous banner, nothing in localStorage.
    vi.mocked(updateItem).mockRejectedValueOnce(new StaleWriteError());
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockResolvedValueOnce([{ ...oilItem, name: 'زيت محدث من جهاز تاني' }]);

    const itemsView = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت تعديل' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      staleWriteMessage,
    );
    expect(screen.getByLabelText('الاسم')).toHaveValue('زيت محدث من جهاز تاني');
    expect(screen.queryByText(/مش متأكد إنه اتحفظ/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'تحقق تاني' }),
    ).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);

    // 2. ItemsPage: duplicate name (ConfirmedRefusalError / 23505) shows actionable error, keeps form editable, no ambiguous notice.
    vi.mocked(updateItem).mockRejectedValueOnce(
      new ConfirmedRefusalError('الاسم ده موجود قبل كده'),
    );
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'جمبري' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'الاسم ده موجود قبل كده',
    );
    expect(screen.queryByText(/مش متأكد إنه اتحفظ/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeEnabled();
    expect(localStorage.length).toBe(0);
    itemsView.unmount();

    // 3. ExpensesPage: duplicate category (SQLSTATE 23505) & permission refusal (42501) show actionable errors, no ambiguous banner, nothing in localStorage.
    const dupError = Object.assign(new Error('التصنيف ده موجود قبل كده'), {
      code: '23505',
      cause: { code: '23505', message: 'duplicate key value' },
    });
    vi.mocked(addExpenseCategory).mockRejectedValueOnce(dupError);
    const permError = Object.assign(new Error('مفيش صلاحية'), {
      code: '42501',
      cause: { code: '42501', message: 'insufficient_privilege' },
    });
    vi.mocked(setMonthExpenseComplete).mockRejectedValueOnce(permError);

    const expView = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText('اسم التصنيف'), {
      target: { value: 'غاز' },
    });
    fireEvent.change(screen.getByLabelText('نوع التصنيف'), {
      target: { value: 'daily' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف تصنيف' }));
    expect(
      await screen.findByText('التصنيف ده موجود قبل كده'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/مش متأكد إنه اتحفظ/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeEnabled();

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    expect(await screen.findByText('مفيش صلاحية')).toBeInTheDocument();
    expect(screen.queryByText(/مش متأكد إنه اتحفظ/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    ).toBeEnabled();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    expView.unmount();
  });

  it('Rules 3 & 4 (ItemsPage): ambiguous updateItem shows "مش متأكد إنه اتحفظ", reads affected item by ID, offers read-only "تحقق تاني" on read failure, unlocks after read succeeds, never writes localStorage, never auto-replays', async () => {
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockResolvedValueOnce([{ ...oilItem, name: 'زيت جديد' }]);
    vi.mocked(getItemById)
      .mockRejectedValueOnce(new Error('item read down'))
      .mockResolvedValueOnce({ ...oilItem, name: 'زيت' });
    vi.mocked(updateItem)
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValueOnce(undefined);

    const view1 = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));

    // Ambiguous outcome + failed verification read:
    expect(await screen.findByText('مش متأكد إنه اتحفظ')).toBeInTheDocument();
    const retryReadBtn = await screen.findByRole('button', {
      name: 'تحقق تاني',
    });
    expect(retryReadBtn).toBeEnabled();
    // Affected write stays disabled until a read succeeds.
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeDisabled();
    // Nothing in localStorage at any point.
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    expect(updateItem).toHaveBeenCalledTimes(1);

    // Clicking "تحقق تاني" performs a READ ONLY by ID (no replay of updateItem).
    fireEvent.click(retryReadBtn);
    await waitFor(() => {
      expect(getItemById).toHaveBeenCalledTimes(2);
    });
    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'تحقق تاني' }),
    ).not.toBeInTheDocument();
    // Shows actual server state ('زيت') and unlocks so owner can submit a fresh action.
    expect(screen.getByLabelText('الاسم')).toHaveValue('زيت');
    expect(screen.getByRole('button', { name: 'حفظ البيانات' })).toBeEnabled();
    expect(localStorage.length).toBe(0);

    // Owner decides to submit a fresh update.
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByRole('heading', { name: 'زيت جديد' }),
    ).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    view1.unmount();

    // Unmount/remount after an ambiguous failure leaves ZERO persisted state (page memory only).
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockResolvedValueOnce([oilItem]);
    vi.mocked(getItemById).mockRejectedValueOnce(new Error('read failed'));
    vi.mocked(updateItem).mockRejectedValueOnce(new Error('network lost'));
    const view2 = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت مؤقت' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    expect(
      await screen.findByRole('button', { name: 'تحقق تاني' }),
    ).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    view2.unmount();

    const view3 = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'زيت' });
    expect(screen.queryByText('مش متأكد إنه اتحفظ')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'تحقق تاني' }),
    ).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    view3.unmount();
  });

  it('Rules 3 & 4 (ExpensesPage month confirmation): ambiguous outcome shows "مش متأكد إنه اتحفظ", reads exact month, offers "تحقق تاني" on read failure, unlocks after read succeeds, never writes localStorage', async () => {
    const monthStart = `${cairoMonthInput()}-01`;
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: false }))
      .mockRejectedValueOnce(new Error('month read failed'))
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: false }))
      .mockResolvedValueOnce(expenseMonth(monthStart, { complete: true }));
    vi.mocked(setMonthExpenseComplete)
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValueOnce(undefined);

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    const checkbox = await screen.findByRole('checkbox', {
      name: 'مصاريف الشهر كاملة',
    });
    fireEvent.click(checkbox);

    expect(await screen.findByText('مش متأكد إنه اتحفظ')).toBeInTheDocument();
    const retryReadBtn = await screen.findByRole('button', {
      name: 'تحقق تاني',
    });
    expect(retryReadBtn).toBeEnabled();
    expect(checkbox).toBeDisabled();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    expect(setMonthExpenseComplete).toHaveBeenCalledTimes(1);

    // Click "تحقق تاني" -> read-only retry of the exact month, NO automatic replay.
    fireEvent.click(retryReadBtn);
    await waitFor(() => {
      expect(loadExpenseMonth).toHaveBeenCalledTimes(3);
    });
    expect(loadExpenseMonth).toHaveBeenLastCalledWith(monthStart);
    expect(setMonthExpenseComplete).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'تحقق تاني' }),
    ).not.toBeInTheDocument();
    expect(checkbox).toBeEnabled();
    expect(checkbox).not.toBeChecked();
    expect(localStorage.length).toBe(0);

    // Owner submits a fresh toggle -> succeeds and refreshes exact month.
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(setMonthExpenseComplete).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
      ).toBeChecked();
    });
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
  });

  it('Rules 3 & 4 (ExpensesPage categories): ambiguous category write shows "مش متأكد إنه اتحفظ", reads categories, offers "تحقق تاني" on read failure, unlocks after read succeeds, never writes localStorage', async () => {
    const monthStart = `${cairoMonthInput()}-01`;
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth(monthStart))
      .mockRejectedValueOnce(new Error('categories read failed'))
      .mockResolvedValueOnce(expenseMonth(monthStart))
      .mockResolvedValueOnce(
        expenseMonth(monthStart, {
          categories: [
            { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
            { id: 'gas', name: 'غاز طبيعي', kind: 'daily', active: true },
          ],
        }),
      );
    vi.mocked(renameExpenseCategory)
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValueOnce(undefined);

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    const renameInput = await screen.findByLabelText('اسم غاز');
    fireEvent.change(renameInput, { target: { value: 'غاز طبيعي' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ اسم غاز' }));

    expect(await screen.findByText('مش متأكد إنه اتحفظ')).toBeInTheDocument();
    const retryReadBtn = await screen.findByRole('button', {
      name: 'تحقق تاني',
    });
    expect(retryReadBtn).toBeEnabled();
    // Category controls disabled while verification read has failed.
    expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'حفظ اسم غاز' })).toBeDisabled();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    expect(renameExpenseCategory).toHaveBeenCalledTimes(1);

    // Click "تحقق تاني" -> read-only retry, NO automatic replay.
    fireEvent.click(retryReadBtn);
    await waitFor(() => {
      expect(loadExpenseMonth).toHaveBeenCalledTimes(3);
    });
    expect(renameExpenseCategory).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'تحقق تاني' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ اسم غاز' })).toBeEnabled();
    expect(localStorage.length).toBe(0);

    // Owner submits fresh rename -> succeeds and refreshes categories.
    fireEvent.click(screen.getByRole('button', { name: 'حفظ اسم غاز' }));
    await waitFor(() => {
      expect(renameExpenseCategory).toHaveBeenCalledTimes(2);
    });
    const renamedCard = await screen.findByRole('article', {
      name: 'غاز طبيعي',
    });
    expect(within(renamedCard).getByText('شغال')).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
  });

  it('Rule 3 (success + failed post-write reload): request-less writes never persist reload markers in localStorage', async () => {
    // 1. ItemsPage updateItem succeeds, post-write listItems fails -> ZERO localStorage.
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockRejectedValueOnce(new Error('catalog down'));
    const itemsView = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت محدث' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    expect(await screen.findByText('catalog down')).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    itemsView.unmount();

    // 2. ExpensesPage setMonthExpenseComplete succeeds, post-write loadExpenseMonth fails -> ZERO localStorage.
    const monthStart = `${cairoMonthInput()}-01`;
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth(monthStart))
      .mockRejectedValueOnce(new Error('expense reload down'));
    const expView = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    expect(await screen.findByText('expense reload down')).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(hasAnyHeldWrite()).toBe(false);
    expView.unmount();
  });
});
