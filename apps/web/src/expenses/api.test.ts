import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addExpenseEntry,
  instantKey,
  loadExpenseMonth,
  voidExpenseEntry,
} from '@/expenses/api';
import {
  isPayloadRefusal,
  isUnknownOutcome,
  retrySafeMessage,
} from '@/expenses/errors';
import type { ExpenseDraft } from '@/expenses/types';
import { genericCatalogError } from '@/items/errors';

const mocks = vi.hoisted(() => ({
  schema: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { schema: mocks.schema },
}));

type Captured = {
  select?: string;
  or?: string;
  eq?: { column: string; value: unknown };
  orders: { column: string; ascending?: boolean }[];
  ranges: { from: number; to: number }[];
};

function query(result: { data: unknown; error: unknown }) {
  const captured: Captured = { orders: [], ranges: [] };
  const chain: Record<string, unknown> = {};
  chain.select = (columns: string) => {
    captured.select = columns;
    return chain;
  };
  chain.or = (filter: string) => {
    captured.or = filter;
    return chain;
  };
  chain.eq = (column: string, value: unknown) => {
    captured.eq = { column, value };
    return chain;
  };
  chain.order = (column: string, options?: { ascending?: boolean }) => {
    captured.orders.push({ column, ascending: options?.ascending });
    return chain;
  };
  chain.range = (from: number, to: number) => {
    captured.ranges.push({ from, to });
    return Promise.resolve(result);
  };
  chain.maybeSingle = () => Promise.resolve(result);
  return { chain, captured };
}

const rpcCalls: { name: string; args: unknown }[] = [];

function install(options: {
  categories: ReturnType<typeof query>;
  lines: ReturnType<typeof query>;
  days: ReturnType<typeof query>;
  status: ReturnType<typeof query>;
  writeError?: { message: string; code?: string } | null;
}) {
  rpcCalls.length = 0;
  mocks.schema.mockReturnValue({
    from(name: string) {
      const table = {
        expense_categories: options.categories,
        expense_lines: options.lines,
        month_expense_status: options.status,
      }[name];
      if (!table) throw new Error(`unexpected table ${name}`);
      return table.chain;
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      if (name === 'expense_daily') return options.days.chain;
      return Promise.resolve({
        data: 'entry-id',
        error: options.writeError ?? null,
      });
    },
  });
}

const categoryRow = {
  id: 'cat-rent',
  name: 'إيجار',
  kind: 'fixed_monthly',
  active: true,
};

const estimateRow = {
  id: 'est',
  category_id: 'cat-gas',
  category_name: 'غاز',
  category_kind: 'daily',
  amount_text: '40.00',
  period_month: null,
  expense_date: '2030-04-03',
  paid_on: null,
  is_estimate: true,
  note: null,
  hours_text: null,
  hourly_rate_text: null,
  driver_label: null,
  created_at: '2030-04-03T10:00:00.000Z',
  void_id: null,
  void_reason: null,
};

const actualRow = {
  ...estimateRow,
  id: 'act',
  amount_text: '55.00',
  is_estimate: false,
  created_at: '2030-04-03T11:00:00.000Z',
};

const dayRow = {
  date: '2030-04-01',
  fixed_share_text: '33.34',
  daily_total_text: '0.00',
  driver_total_text: '0.00',
  interest_text: '0.00',
  depreciation_text: '0.00',
  total_text: '33.34',
};

describe('expense api', () => {
  beforeEach(() => {
    mocks.schema.mockReset();
    rpcCalls.length = 0;
  });

  it('reads exact decimal text for the month, newest first', async () => {
    const categories = query({ data: [categoryRow], error: null });
    const lines = query({ data: [estimateRow, actualRow], error: null });
    const days = query({ data: [dayRow], error: null });
    const status = query({
      data: {
        month: '2030-04-01',
        complete: false,
        confirmed_at: null,
        confirmed_by: null,
      },
      error: null,
    });
    install({ categories, lines, days, status });

    const month = await loadExpenseMonth('2030-04-01');

    expect(mocks.schema).toHaveBeenCalledWith('app');
    expect(categories.captured.select).toBe('id, name, kind, active');
    expect(categories.captured.orders).toEqual([
      { column: 'id', ascending: true },
    ]);
    expect(lines.captured.select).toContain('amount::text');
    expect(lines.captured.select).toContain('hourly_rate::text');
    expect(lines.captured.or).toBe(
      'period_month.eq.2030-04-01,and(expense_date.gte.2030-04-01,expense_date.lte.2030-04-30)',
    );
    expect(lines.captured.orders).toEqual([{ column: 'id', ascending: true }]);
    expect(days.captured.select).toContain('fixed_share::text');
    expect(days.captured.orders).toEqual([{ column: 'date', ascending: true }]);
    expect(categories.captured.ranges).toEqual([{ from: 0, to: 999 }]);
    expect(lines.captured.ranges).toEqual([{ from: 0, to: 999 }]);
    expect(days.captured.ranges).toEqual([{ from: 0, to: 999 }]);
    expect(status.captured.eq).toEqual({
      column: 'month',
      value: '2030-04-01',
    });
    expect(rpcCalls).toEqual([
      {
        name: 'expense_daily',
        args: { p_from: '2030-04-01', p_to: '2030-04-30' },
      },
    ]);
    expect(month.days[0]).toEqual({
      date: '2030-04-01',
      fixedShare: '33.34',
      dailyTotal: '0.00',
      driverTotal: '0.00',
      interest: '0.00',
      depreciation: '0.00',
      total: '33.34',
    });
    expect(
      month.entries.map((entry) => [entry.id, entry.amount, entry.superseded]),
    ).toEqual([
      ['act', '55.00', false],
      ['est', '40.00', true],
    ]);
    expect(month.complete).toBe(false);
  });

  it('orders newest first by instant even when a fraction is dropped', async () => {
    expect(instantKey('2030-04-03T10:00:00.000001+00:00')).toBeGreaterThan(
      instantKey('2030-04-03T10:00:00+00:00'),
    );
    const older = { ...estimateRow, created_at: '2030-04-03T10:00:00+00:00' };
    const newer = {
      ...actualRow,
      created_at: '2030-04-03T10:00:00.001+00:00',
    };
    install({
      categories: query({ data: [categoryRow], error: null }),
      lines: query({ data: [older, newer], error: null }),
      days: query({ data: [dayRow], error: null }),
      status: query({ data: null, error: null }),
    });

    const month = await loadExpenseMonth('2030-04-01');

    expect(month.entries.map((entry) => entry.id)).toEqual(['act', 'est']);
  });

  it('reads a day total wider than numeric(14,2)', async () => {
    install({
      categories: query({ data: [categoryRow], error: null }),
      lines: query({ data: [], error: null }),
      days: query({
        data: [
          {
            ...dayRow,
            fixed_share_text: '0.00',
            daily_total_text: '1000000000000.00',
            total_text: '1000000000000.00',
          },
        ],
        error: null,
      }),
      status: query({ data: null, error: null }),
    });

    const month = await loadExpenseMonth('2030-04-01');

    expect(month.days[0]?.dailyTotal).toBe('1000000000000.00');
    expect(month.days[0]?.total).toBe('1000000000000.00');
  });

  it('rejects a JSON number where money text is required', async () => {
    install({
      categories: query({ data: [categoryRow], error: null }),
      lines: query({
        data: [{ ...actualRow, amount_text: 55 }],
        error: null,
      }),
      days: query({ data: [dayRow], error: null }),
      status: query({ data: null, error: null }),
    });

    await expect(loadExpenseMonth('2030-04-01')).rejects.toThrow(
      genericCatalogError,
    );
  });

  it('refuses a month that is not the first day', async () => {
    await expect(loadExpenseMonth('2030-04-15')).rejects.toThrow(
      'الشهر مش مظبوط',
    );
    expect(mocks.schema).not.toHaveBeenCalled();
  });

  it('sends money as decimal strings and lets the database compute driver pay', async () => {
    install({
      categories: query({ data: [], error: null }),
      lines: query({ data: [], error: null }),
      days: query({ data: [], error: null }),
      status: query({ data: null, error: null }),
    });
    const fixed: ExpenseDraft = {
      requestId: 'a17e0000-0000-4000-8000-0000000000aa',
      categoryId: 'cat-rent',
      amount: '1000.00',
      periodMonth: '2030-04-01',
      expenseDate: null,
      paidOn: '2030-04-20',
      isEstimate: false,
      note: 'فاتورة اختبار',
      hours: null,
      hourlyRate: null,
      driverLabel: null,
    };
    const driver: ExpenseDraft = {
      requestId: 'a17e0000-0000-4000-8000-0000000000ab',
      categoryId: 'cat-driver',
      amount: '165.00',
      periodMonth: null,
      expenseDate: '2030-04-15',
      paidOn: null,
      isEstimate: false,
      note: null,
      hours: '5.50',
      hourlyRate: '30.00',
      driverLabel: 'طيار اختبار',
    };

    await addExpenseEntry(fixed);
    await addExpenseEntry(driver);
    await voidExpenseEntry(
      'est',
      'تكرار',
      'a17e0000-0000-4000-8000-0000000000ac',
    );

    const fixedArgs = rpcCalls[0]?.args;
    const driverArgs = rpcCalls[1]?.args;
    expect(rpcCalls.map((call) => call.name)).toEqual([
      'add_expense_entry',
      'add_expense_entry',
      'void_expense_entry',
    ]);
    expect(fixedArgs).toEqual({
      p_request_id: 'a17e0000-0000-4000-8000-0000000000aa',
      p_category_id: 'cat-rent',
      p_is_estimate: false,
      p_amount: '1000.00',
      p_period_month: '2030-04-01',
      p_paid_on: '2030-04-20',
      p_note: 'فاتورة اختبار',
    });
    expect(JSON.stringify(fixedArgs)).toContain('"p_amount":"1000.00"');
    expect(driverArgs).toEqual({
      p_request_id: 'a17e0000-0000-4000-8000-0000000000ab',
      p_category_id: 'cat-driver',
      p_is_estimate: false,
      p_expense_date: '2030-04-15',
      p_hours: '5.50',
      p_hourly_rate: '30.00',
      p_driver_label: 'طيار اختبار',
    });
    expect(driverArgs).not.toHaveProperty('p_amount');
    expect(JSON.stringify(driverArgs)).toContain('"p_hours":"5.50"');
    expect(JSON.stringify(driverArgs)).toContain('"p_hourly_rate":"30.00"');
    expect(rpcCalls[2]?.args).toEqual({
      p_id: 'est',
      p_reason: 'تكرار',
      p_request_id: 'a17e0000-0000-4000-8000-0000000000ac',
    });
  });

  it('turns a database rejection into Arabic', async () => {
    install({
      categories: query({ data: [], error: null }),
      lines: query({ data: [], error: null }),
      days: query({ data: [], error: null }),
      status: query({ data: null, error: null }),
      writeError: { message: 'expense category is inactive' },
    });

    await expect(
      addExpenseEntry({
        requestId: 'a17e0000-0000-4000-8000-0000000000ad',
        categoryId: 'cat-rent',
        amount: '10.00',
        periodMonth: '2030-04-01',
        expenseDate: null,
        paidOn: null,
        isEstimate: false,
        note: null,
        hours: null,
        hourlyRate: null,
        driverLabel: null,
      }),
    ).rejects.toThrow('التصنيف ده متوقف');
  });

  it('keeps a refusal definite and a lost reply unknown', async () => {
    let writeError: { code?: string; message: string } | null = {
      code: '22023',
      message: 'مينفعش تكتب أرقام تليفونات أو أرقام قومية',
    };
    mocks.schema.mockReturnValue({
      rpc() {
        if (!writeError) throw new Error('Failed to fetch');
        return Promise.resolve({ data: null, error: writeError });
      },
    });
    const id = 'a17e0000-0000-4000-8000-0000000000af';

    await expect(voidExpenseEntry('est', 'سبب', id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'مينفعش تكتب أرقام تليفونات أو أرقام قومية' &&
        isPayloadRefusal(error) &&
        !isUnknownOutcome(error) &&
        (error.cause as { code?: string }).code === '22023',
    );

    writeError = { code: '42501', message: 'permission denied' };
    await expect(voidExpenseEntry('est', 'سبب', id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'مفيش صلاحية' &&
        !isPayloadRefusal(error) &&
        !isUnknownOutcome(error),
    );

    writeError = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "expense_entries_request_id_key"',
    };
    await expect(voidExpenseEntry('est', 'سبب', id)).rejects.toThrow(
      retrySafeMessage,
    );
    await expect(voidExpenseEntry('est', 'سبب', id)).rejects.toSatisfy(
      (error: unknown) => isUnknownOutcome(error) && !isPayloadRefusal(error),
    );

    writeError = { code: 'PGRST003', message: 'upstream timed out' };
    await expect(voidExpenseEntry('est', 'سبب', id)).rejects.toThrow(
      retrySafeMessage,
    );
    await expect(voidExpenseEntry('est', 'سبب', id)).rejects.toSatisfy(
      (error: unknown) => isUnknownOutcome(error),
    );

    writeError = { code: '0A000', message: 'feature not supported' };
    await expect(voidExpenseEntry('est', 'سبب', id)).rejects.toThrow(
      genericCatalogError,
    );
    await expect(voidExpenseEntry('est', 'سبب', id)).rejects.toSatisfy(
      (error: unknown) => !isUnknownOutcome(error) && isPayloadRefusal(error),
    );

    writeError = null;
    await expect(
      addExpenseEntry({
        requestId: id,
        categoryId: 'cat-rent',
        amount: '10.00',
        periodMonth: '2030-04-01',
        expenseDate: null,
        paidOn: null,
        isEstimate: false,
        note: null,
        hours: null,
        hourlyRate: null,
        driverLabel: null,
      }),
    ).rejects.toThrow(retrySafeMessage);
    await expect(
      addExpenseEntry({
        requestId: id,
        categoryId: 'cat-rent',
        amount: '10.00',
        periodMonth: '2030-04-01',
        expenseDate: null,
        paidOn: null,
        isEstimate: false,
        note: null,
        hours: null,
        hourlyRate: null,
        driverLabel: null,
      }),
    ).rejects.toSatisfy((error: unknown) => isUnknownOutcome(error));
  });

  it('tells the owner to retry when the save reply is lost', async () => {
    mocks.schema.mockReturnValue({
      rpc() {
        throw new Error('Failed to fetch');
      },
    });
    await expect(
      addExpenseEntry({
        requestId: 'a17e0000-0000-4000-8000-0000000000ae',
        categoryId: 'cat-rent',
        amount: '10.00',
        periodMonth: '2030-04-01',
        expenseDate: null,
        paidOn: null,
        isEstimate: false,
        note: null,
        hours: null,
        hourlyRate: null,
        driverLabel: null,
      }),
    ).rejects.toThrow(retrySafeMessage);
  });

  it('returns every category id once when a name changes between pages', async () => {
    const ids = Array.from(
      { length: 1001 },
      (_, index) => `c${String(index).padStart(4, '0')}`,
    );
    const server = ids.map((id) => ({
      id,
      name: id,
      kind: 'daily',
      active: true,
    }));
    const orders: string[] = [];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.order = (column: string) => {
      orders.push(column);
      return chain;
    };
    chain.range = (from: number, to: number) => {
      const column = orders.at(-1) === 'name' ? 'name' : 'id';
      const sorted = [...server].sort((left, right) =>
        left[column].localeCompare(right[column]),
      );
      const slice = sorted.slice(from, to + 1);
      const first = server[0];
      if (from === 0 && first) first.name = 'zzzz-renamed';
      return Promise.resolve({ data: slice, error: null });
    };

    install({
      categories: {
        chain,
        captured: { orders: [], ranges: [] },
      },
      lines: query({ data: [], error: null }),
      days: query({ data: [], error: null }),
      status: query({ data: null, error: null }),
    });

    const month = await loadExpenseMonth('2030-04-01');

    expect(orders).toContain('id');
    expect(orders).not.toContain('name');
    expect(month.categories).toHaveLength(ids.length);
    expect(month.categories.map((row) => row.id).sort()).toEqual(
      [...ids].sort(),
    );
    expect(month.categories.filter((row) => row.id === 'c0000')).toEqual([
      expect.objectContaining({ name: 'zzzz-renamed' }),
    ]);
  });
});
