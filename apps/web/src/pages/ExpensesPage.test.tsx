import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addExpenseCategory,
  addExpenseEntry,
  loadExpenseMonth,
  renameExpenseCategory,
  setExpenseCategoryActive,
  setMonthExpenseComplete,
  voidExpenseEntry,
} from '@/expenses/api';
import type {
  AllocationDay,
  ExpenseCategory,
  ExpenseLine,
  ExpenseMonth,
} from '@/expenses/types';
import { retrySafeMessage } from '@/expenses/errors';
import { genericCatalogError } from '@/items/errors';
import { ExpensesPage } from '@/pages/ExpensesPage';

vi.mock('@/expenses/api', () => ({
  loadExpenseMonth: vi.fn(),
  addExpenseEntry: vi.fn(),
  voidExpenseEntry: vi.fn(),
  addExpenseCategory: vi.fn(),
  renameExpenseCategory: vi.fn(),
  setExpenseCategoryActive: vi.fn(),
  setMonthExpenseComplete: vi.fn(),
}));

const categories: ExpenseCategory[] = [
  { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
  { id: 'gas', name: 'غاز', kind: 'daily', active: true },
  { id: 'driver', name: 'أجر طيارين', kind: 'driver_hours', active: true },
];

function entry(patch: Partial<ExpenseLine> = {}): ExpenseLine {
  return {
    id: 'entry-1',
    categoryId: 'rent',
    categoryName: 'إيجار',
    categoryKind: 'fixed_monthly',
    amount: '1000.00',
    periodMonth: '2030-04-01',
    expenseDate: null,
    paidOn: null,
    isEstimate: false,
    note: 'إيجار الاختبار',
    hours: null,
    hourlyRate: null,
    driverLabel: null,
    createdAt: '2030-04-01T08:00:00.000Z',
    voided: false,
    voidReason: null,
    superseded: false,
    ...patch,
  };
}

function day(): AllocationDay {
  return {
    date: '2030-04-01',
    fixedShare: '33.34',
    dailyTotal: '0.00',
    driverTotal: '0.00',
    interest: '0.00',
    depreciation: '0.00',
    total: '33.34',
  };
}

function monthData(
  monthStart: string,
  patch: Partial<ExpenseMonth> = {},
): ExpenseMonth {
  return {
    monthStart,
    categories,
    entries: [entry()],
    days: [day()],
    complete: false,
    confirmedAt: null,
    ...patch,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ExpensesPage />
    </MemoryRouter>,
  );
}

describe('ExpensesPage', () => {
  beforeEach(() => {
    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
      Promise.resolve(monthData(monthStart)),
    );
    vi.mocked(addExpenseEntry).mockResolvedValue(undefined);
    vi.mocked(voidExpenseEntry).mockResolvedValue(undefined);
    vi.mocked(setMonthExpenseComplete).mockResolvedValue(undefined);
    vi.mocked(addExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(renameExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(setExpenseCategoryActive).mockResolvedValue(undefined);
  });

  it('renders the loaded allocation', async () => {
    renderPage();
    expect(
      await screen.findByRole('table', { name: 'توزيع الشهر' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('cell', { name: '33.34 ج.م' }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('إيجار الاختبار')).toBeInTheDocument();
  });

  it('keeps the newest month when an older read finishes later', async () => {
    let resolveFirst: (value: ExpenseMonth) => void = () => {};
    vi.mocked(loadExpenseMonth).mockReset();
    vi.mocked(loadExpenseMonth).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
      Promise.resolve(
        monthData(monthStart, {
          entries: [entry({ note: 'إيجار مايو', periodMonth: '2030-05-01' })],
        }),
      ),
    );

    renderPage();
    await waitFor(() => expect(loadExpenseMonth).toHaveBeenCalledTimes(1));
    const monthInput = screen.getByLabelText('الشهر');
    expect(monthInput).toBeEnabled();
    expect(screen.queryByText('إيجار مايو')).not.toBeInTheDocument();
    fireEvent.change(monthInput, { target: { value: '2030-05' } });

    expect(await screen.findByText('إيجار مايو')).toBeInTheDocument();
    expect(loadExpenseMonth).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveFirst(
        monthData('2030-04-01', {
          entries: [entry({ note: 'إيجار أبريل' })],
        }),
      );
      await Promise.resolve();
    });
    expect(screen.getByText('إيجار مايو')).toBeInTheDocument();
    expect(screen.queryByText('إيجار أبريل')).not.toBeInTheDocument();
  });

  it('voids an entry after a reason and reloads it as voided', async () => {
    vi.mocked(voidExpenseEntry).mockImplementation(() => {
      vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
        Promise.resolve(
          monthData(monthStart, {
            entries: [entry({ voided: true, voidReason: 'تكرار' })],
          }),
        ),
      );
      return Promise.resolve();
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'إلغاء المصروف' }),
    );
    fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
      target: { value: 'تكرار' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await waitFor(() =>
      expect(voidExpenseEntry).toHaveBeenCalledWith(
        'entry-1',
        'تكرار',
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        ),
      ),
    );
    expect(await screen.findByText('ملغي')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'إلغاء المصروف' }),
    ).not.toBeInTheDocument();
  });

  it('keeps the expense request id across a failed save and mints a new one after success', async () => {
    renderPage();
    async function fillRent() {
      fireEvent.change(await screen.findByLabelText('التصنيف'), {
        target: { value: 'rent' },
      });
      fireEvent.change(screen.getByLabelText('المبلغ'), {
        target: { value: '1000' },
      });
    }
    await fillRent();
    vi.mocked(addExpenseEntry).mockRejectedValueOnce(
      new Error(retrySafeMessage),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(2));
    const first = vi.mocked(addExpenseEntry).mock.calls[0]?.[0]?.requestId;
    const second = vi.mocked(addExpenseEntry).mock.calls[1]?.[0]?.requestId;
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(second).toBe(first);

    await waitFor(() => {
      expect(screen.getByLabelText('التصنيف')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'حفظ المصروف' })).toBeEnabled();
    });
    await fillRent();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(3));
    expect(vi.mocked(addExpenseEntry).mock.calls[2]?.[0]?.requestId).not.toBe(
      first,
    );
  });

  it('reuses the void request id when the void reply is lost', async () => {
    vi.mocked(voidExpenseEntry).mockRejectedValueOnce(
      new Error(retrySafeMessage),
    );
    renderPage();
    async function confirmVoid() {
      fireEvent.click(
        await screen.findByRole('button', { name: 'إلغاء المصروف' }),
      );
      fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
        target: { value: 'تكرار' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    }
    await confirmVoid();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );
    await confirmVoid();
    await waitFor(() => expect(voidExpenseEntry).toHaveBeenCalledTimes(2));
    expect(vi.mocked(voidExpenseEntry).mock.calls[1]?.[2]).toBe(
      vi.mocked(voidExpenseEntry).mock.calls[0]?.[2],
    );
  });

  it('retries a lost void with the first reason even if another is typed', async () => {
    vi.mocked(voidExpenseEntry).mockRejectedValueOnce(
      new Error(retrySafeMessage),
    );
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'إلغاء المصروف' }),
    );
    fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
      target: { value: 'تكرار' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'إلغاء المصروف' }),
    );
    const reason = screen.getByLabelText('سبب الإلغاء');
    expect(reason).toHaveValue('تكرار');
    expect(reason).toHaveAttribute('readonly');
    fireEvent.change(reason, { target: { value: 'اتسجل مرتين' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await waitFor(() => expect(voidExpenseEntry).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(voidExpenseEntry).mock.calls;
    expect(second).toEqual(first);
    expect(second?.[1]).toBe('تكرار');
  });

  it('marks the month complete and clears it again', async () => {
    let complete = false;
    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
      Promise.resolve(monthData(monthStart, { complete })),
    );
    vi.mocked(setMonthExpenseComplete).mockImplementation((_month, next) => {
      complete = next;
      return Promise.resolve();
    });
    renderPage();
    fireEvent.change(await screen.findByLabelText('الشهر'), {
      target: { value: '2030-04' },
    });
    await waitFor(() => {
      expect(loadExpenseMonth).toHaveBeenCalledWith('2030-04-01');
      expect(
        screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
      ).toBeEnabled();
    });
    const checkbox = screen.getByRole('checkbox', {
      name: 'مصاريف الشهر كاملة',
    });
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(setMonthExpenseComplete).toHaveBeenCalledWith('2030-04-01', true),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
      ).toBeChecked(),
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    await waitFor(() =>
      expect(setMonthExpenseComplete).toHaveBeenLastCalledWith(
        '2030-04-01',
        false,
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
      ).not.toBeChecked(),
    );
  });

  it('locks the page from the save until the reload finishes', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('التصنيف'), {
      target: { value: 'rent' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '1000' },
    });

    let resolveSave: () => void = () => {};
    vi.mocked(addExpenseEntry).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalled());
    expect(addExpenseEntry).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '1000.00', categoryId: 'rent' }),
    );
    expect(screen.getByLabelText('الشهر')).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'إلغاء المصروف' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeDisabled();

    const requested = vi.mocked(loadExpenseMonth).mock.calls[0]?.[0] ?? '';
    let resolveReload: (value: ExpenseMonth) => void = () => {};
    vi.mocked(loadExpenseMonth).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        }),
    );
    resolveSave();
    await waitFor(() =>
      expect(vi.mocked(loadExpenseMonth).mock.calls.length).toBeGreaterThan(1),
    );
    expect(screen.getByLabelText('الشهر')).toBeDisabled();
    await act(async () => {
      resolveReload(monthData(requested));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByLabelText('الشهر')).toBeEnabled());
  });

  it('shows the load error and unlocks when the owner retries a failed reload', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('التصنيف'), {
      target: { value: 'rent' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '1000' },
    });
    const requested = vi.mocked(loadExpenseMonth).mock.calls[0]?.[0] ?? '';
    vi.mocked(loadExpenseMonth).mockRejectedValueOnce(
      new Error(genericCatalogError),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      genericCatalogError,
    );
    expect(
      screen.getByRole('button', { name: 'إعادة المحاولة' }),
    ).toBeEnabled();
    expect(screen.getByLabelText('الشهر')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'إلغاء المصروف' }),
    ).toBeDisabled();

    vi.mocked(loadExpenseMonth).mockImplementation((monthStart) =>
      Promise.resolve(monthData(monthStart)),
    );
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => expect(screen.getByLabelText('الشهر')).toBeEnabled());
    expect(screen.getByRole('button', { name: 'إلغاء المصروف' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(loadExpenseMonth).toHaveBeenLastCalledWith(requested);
  });

  it('adds a category through the manager', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('اسم التصنيف'), {
      target: { value: 'كهربا' },
    });
    fireEvent.change(screen.getByLabelText('نوع التصنيف'), {
      target: { value: 'daily' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف تصنيف' }));
    await waitFor(() =>
      expect(addExpenseCategory).toHaveBeenCalledWith('كهربا', 'daily'),
    );
  });
});
