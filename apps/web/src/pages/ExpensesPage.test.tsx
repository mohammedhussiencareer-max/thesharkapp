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
import {
  pendingResendMessage,
  pendingVoidMessage,
  retrySafeMessage,
} from '@/expenses/errors';
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

const phoneMessage = 'مينفعش تكتب أرقام تليفونات أو أرقام قومية';

function phoneRefusal(): Error {
  return new Error(phoneMessage, {
    cause: { code: '22023', message: phoneMessage },
  });
}

function permissionRefusal(): Error {
  return new Error('مفيش صلاحية', {
    cause: { code: '42501', message: 'insufficient_privilege' },
  });
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

  async function saveRent(amount = '1000') {
    fireEvent.change(await screen.findByLabelText('التصنيف'), {
      target: { value: 'rent' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: amount },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
  }

  it('does not pin an expense that fails client validation', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('التصنيف'), {
      target: { value: 'rent' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));

    expect(addExpenseEntry).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('اكتب المبلغ');
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
    expect(screen.getByLabelText('التصنيف')).toBeEnabled();
    expect(screen.getByLabelText('المبلغ')).not.toHaveAttribute('readonly');
  });

  it('lets the owner correct an expense after a definite refusal', async () => {
    vi.mocked(addExpenseEntry).mockRejectedValueOnce(phoneRefusal());
    renderPage();
    await saveRent('1000');

    expect(await screen.findByRole('alert')).toHaveTextContent(phoneMessage);
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
    const amount = screen.getByLabelText('المبلغ');
    expect(amount).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('التصنيف')).toBeEnabled();

    fireEvent.change(amount, { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(addExpenseEntry).mock.calls;
    expect(first?.[0]).toMatchObject({ amount: '1000.00' });
    expect(second?.[0]).toMatchObject({ amount: '2000.00' });
    expect(second?.[0]?.requestId).toBe(first?.[0]?.requestId);
  });

  it('resends the same expense after a network failure', async () => {
    vi.mocked(addExpenseEntry).mockRejectedValueOnce(
      new Error(retrySafeMessage),
    );
    renderPage();
    await saveRent('1000');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );
    expect(screen.getByText(pendingResendMessage)).toBeInTheDocument();
    const amount = screen.getByLabelText('المبلغ');
    expect(amount).toHaveAttribute('readonly');
    expect(amount).toHaveValue('1000');
    expect(screen.getByLabelText('التصنيف')).toBeDisabled();
    expect(screen.getByLabelText('ملاحظة')).toHaveAttribute('readonly');

    fireEvent.change(amount, { target: { value: '9999' } });
    expect(amount).toHaveValue('1000');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(2));
    expect(vi.mocked(addExpenseEntry).mock.calls[1]?.[0]).toEqual(
      vi.mocked(addExpenseEntry).mock.calls[0]?.[0],
    );
  });

  it('keeps a pinned expense when the replay is refused for permission', async () => {
    vi.mocked(addExpenseEntry)
      .mockRejectedValueOnce(new Error(retrySafeMessage))
      .mockRejectedValueOnce(permissionRefusal());
    renderPage();
    await saveRent('1000');
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('مفيش صلاحية');
    expect(screen.getByText(pendingResendMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('المبلغ')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('المبلغ')).toHaveValue('1000');
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '9999' },
    });
    expect(screen.getByLabelText('المبلغ')).toHaveValue('1000');

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(3));
    const [first, second, third] = vi.mocked(addExpenseEntry).mock.calls;
    expect(second?.[0]).toEqual(first?.[0]);
    expect(third?.[0]).toEqual(first?.[0]);
  });

  it('releases a pinned expense when the replay is definitely refused', async () => {
    vi.mocked(addExpenseEntry)
      .mockRejectedValueOnce(new Error(retrySafeMessage))
      .mockRejectedValueOnce(phoneRefusal());
    renderPage();
    await saveRent('1000');
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(phoneMessage);
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
    const amount = screen.getByLabelText('المبلغ');
    expect(amount).not.toHaveAttribute('readonly');
    expect(amount).toHaveValue('1000');
    expect(screen.getByLabelText('التصنيف')).toBeEnabled();

    fireEvent.change(amount, { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(3));
    const [first, second, third] = vi.mocked(addExpenseEntry).mock.calls;
    expect(second?.[0]).toEqual(first?.[0]);
    expect(third?.[0]).toMatchObject({ amount: '2000.00' });
    expect(third?.[0]?.requestId).toBe(first?.[0]?.requestId);
  });

  it('clears a pinned expense after that payload succeeds', async () => {
    vi.mocked(addExpenseEntry).mockRejectedValueOnce(
      new Error(retrySafeMessage),
    );
    renderPage();
    await saveRent('1000');
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();
    const pinnedId = vi.mocked(addExpenseEntry).mock.calls[0]?.[0]?.requestId;

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => {
      expect(screen.getByLabelText('التصنيف')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'حفظ المصروف' })).toBeEnabled();
    });
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
    expect(vi.mocked(addExpenseEntry).mock.calls[1]?.[0]).toEqual(
      vi.mocked(addExpenseEntry).mock.calls[0]?.[0],
    );

    await saveRent('1500');
    await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(3));
    expect(vi.mocked(addExpenseEntry).mock.calls[2]?.[0]?.requestId).not.toBe(
      pinnedId,
    );
    expect(vi.mocked(addExpenseEntry).mock.calls[2]?.[0]).toMatchObject({
      amount: '1500.00',
    });
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

  it('does not pin a void that fails client validation', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'إلغاء المصروف' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    expect(voidExpenseEntry).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('اكتب سبب الإلغاء');
    expect(screen.getByLabelText('سبب الإلغاء')).not.toHaveAttribute(
      'readonly',
    );
    expect(screen.queryByText(pendingVoidMessage)).not.toBeInTheDocument();
  });

  it('does not pin a void that is not sent while the page is busy', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'إلغاء المصروف' }),
    );
    fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
      target: { value: 'تكرار' },
    });
    fireEvent.change(screen.getByLabelText('التصنيف'), {
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
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'تأكيد الإلغاء' }),
      ).toBeDisabled(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    expect(voidExpenseEntry).not.toHaveBeenCalled();

    resolveSave();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'تأكيد الإلغاء' }),
      ).toBeEnabled(),
    );
    const reason = screen.getByLabelText('سبب الإلغاء');
    expect(reason).toHaveValue('تكرار');
    expect(reason).not.toHaveAttribute('readonly');
    expect(screen.queryByText(pendingVoidMessage)).not.toBeInTheDocument();
  });

  it('lets the owner correct a void reason after a definite refusal', async () => {
    vi.mocked(voidExpenseEntry).mockRejectedValueOnce(phoneRefusal());
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'إلغاء المصروف' }),
    );
    fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
      target: { value: 'سبب غلط' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(phoneMessage);
    expect(screen.queryByText(pendingVoidMessage)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    const reason = screen.getByLabelText('سبب الإلغاء');
    expect(reason).not.toHaveAttribute('readonly');
    expect(reason).toHaveValue('');
    fireEvent.change(reason, { target: { value: 'سبب صحيح' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await waitFor(() => expect(voidExpenseEntry).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(voidExpenseEntry).mock.calls;
    expect(second?.[1]).toBe('سبب صحيح');
    expect(second?.[2]).toBe(first?.[2]);
    expect(second?.[0]).toBe('entry-1');
  });

  it('does not pin a void refused for permission on the first attempt', async () => {
    vi.mocked(voidExpenseEntry).mockRejectedValueOnce(permissionRefusal());
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'إلغاء المصروف' }),
    );
    fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
      target: { value: 'تكرار' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('مفيش صلاحية');
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    const reason = screen.getByLabelText('سبب الإلغاء');
    expect(reason).not.toHaveAttribute('readonly');
    expect(screen.queryByText(pendingVoidMessage)).not.toBeInTheDocument();
    fireEvent.change(reason, { target: { value: 'سبب تاني' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await waitFor(() => expect(voidExpenseEntry).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(voidExpenseEntry).mock.calls;
    expect(second?.[1]).toBe('سبب تاني');
    expect(second?.[2]).toBe(first?.[2]);
  });

  it('keeps a pinned void when the replay is refused for permission', async () => {
    vi.mocked(voidExpenseEntry)
      .mockRejectedValueOnce(new Error(retrySafeMessage))
      .mockRejectedValueOnce(permissionRefusal());
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

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    const reason = screen.getByLabelText('سبب الإلغاء');
    expect(reason).toHaveValue('تكرار');
    expect(reason).toHaveAttribute('readonly');
    expect(screen.getByText(pendingVoidMessage)).toBeInTheDocument();
    fireEvent.change(reason, { target: { value: 'سبب تاني' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await waitFor(() => expect(voidExpenseEntry).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('مفيش صلاحية');
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    expect(screen.getByLabelText('سبب الإلغاء')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('سبب الإلغاء')).toHaveValue('تكرار');
    expect(screen.getByText(pendingVoidMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await waitFor(() => expect(voidExpenseEntry).toHaveBeenCalledTimes(3));
    const [first, second, third] = vi.mocked(voidExpenseEntry).mock.calls;
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('releases a pinned void when the replay is definitely refused', async () => {
    vi.mocked(voidExpenseEntry)
      .mockRejectedValueOnce(new Error(retrySafeMessage))
      .mockRejectedValueOnce(phoneRefusal());
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
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    expect(screen.getByText(pendingVoidMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('سبب الإلغاء')).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(phoneMessage);

    expect(screen.queryByText(pendingVoidMessage)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    const reason = screen.getByLabelText('سبب الإلغاء');
    expect(reason).not.toHaveAttribute('readonly');
    fireEvent.change(reason, { target: { value: 'سبب صحيح' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    await waitFor(() => expect(voidExpenseEntry).toHaveBeenCalledTimes(3));
    const [first, second, third] = vi.mocked(voidExpenseEntry).mock.calls;
    expect(second).toEqual(first);
    expect(third?.[1]).toBe('سبب صحيح');
    expect(third?.[2]).toBe(first?.[2]);
  });

  it('clears a pinned void after the same payload succeeds', async () => {
    vi.mocked(voidExpenseEntry).mockRejectedValueOnce(
      new Error(retrySafeMessage),
    );
    vi.mocked(voidExpenseEntry).mockImplementationOnce(() => {
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
    expect(screen.getByText(pendingVoidMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('سبب الإلغاء')).toHaveValue('تكرار');
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));

    expect(await screen.findByText('ملغي')).toBeInTheDocument();
    expect(screen.queryByText(pendingVoidMessage)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'إلغاء المصروف' }),
    ).not.toBeInTheDocument();
    const [first, second] = vi.mocked(voidExpenseEntry).mock.calls;
    expect(second).toEqual(first);
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
