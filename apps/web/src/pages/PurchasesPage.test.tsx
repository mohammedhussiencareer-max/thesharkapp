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
  backDatedMessage,
  ConversionChangedError,
  conversionChangedMessage,
  retrySafeMessage,
} from '@/purchases/errors';
import {
  listPurchases,
  listStockChoices,
  recordPurchase,
} from '@/purchases/api';
import { PurchasesPage } from '@/pages/PurchasesPage';
import type { Purchase, StockChoice } from '@/purchases/types';

vi.mock('@/purchases/api', () => ({
  listStockChoices: vi.fn(),
  listPurchases: vi.fn(),
  recordPurchase: vi.fn(),
}));

const oil: StockChoice = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'kg',
  parentItemId: null,
  active: true,
  hasMovements: true,
  conversions: [{ unit: 'لتر', factorToBase: '0.92' }],
};

function purchase(supplier: string): Purchase {
  return {
    id: supplier,
    purchasedAt: '2026-07-15T09:00:00.000Z',
    supplier,
    invoiceNo: 'T-1',
    note: null,
    totalPaid: '50.00',
    lines: [
      {
        lineNo: 1,
        itemId: 'oil',
        itemName: 'زيت',
        baseUnit: 'kg',
        quantity: '2',
        unit: 'لتر',
        baseQuantity: '1.84',
        amountPaid: '50.00',
      },
    ],
  };
}

async function renderPage() {
  render(
    <MemoryRouter>
      <PurchasesPage />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('وقت الشراء')).toBeInTheDocument();
}

describe('PurchasesPage', () => {
  beforeEach(() => {
    vi.mocked(listStockChoices).mockReset();
    vi.mocked(listPurchases).mockReset();
    vi.mocked(recordPurchase).mockReset();
    vi.mocked(listStockChoices).mockResolvedValue([oil]);
    vi.mocked(listPurchases).mockResolvedValue([]);
    vi.mocked(recordPurchase).mockResolvedValue(undefined);
  });

  it('filters by a Cairo date range and ignores a stale read', async () => {
    const resolvers: ((rows: Purchase[]) => void)[] = [];
    vi.mocked(listPurchases).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(
      <MemoryRouter>
        <PurchasesPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(resolvers).toHaveLength(1);
    });
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2026-07-15' },
    });
    await waitFor(() => {
      expect(resolvers).toHaveLength(2);
    });
    expect(listPurchases).toHaveBeenLastCalledWith({
      from: '2026-07-14T21:00:00.000Z',
      toExclusive: undefined,
    });

    await act(async () => {
      resolvers[1]?.([purchase('جديد')]);
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('article', { name: 'جديد' }),
    ).toBeInTheDocument();
    expect(screen.getByText('50.00 ج.م')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'التفاصيل' }));
    expect(screen.getByText(/لتر/)).toBeInTheDocument();

    await act(async () => {
      resolvers[0]?.([purchase('قديم')]);
      await Promise.resolve();
    });
    expect(screen.getByRole('article', { name: 'جديد' })).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: 'قديم' }),
    ).not.toBeInTheDocument();
  });

  it('rejects an inverted date range without another read', async () => {
    await renderPage();
    const calls = vi.mocked(listPurchases).mock.calls.length;
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2026-02-02' },
    });
    fireEvent.change(screen.getByLabelText('إلى'), {
      target: { value: '2026-01-01' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'تاريخ البداية لازم يكون قبل تاريخ النهاية',
    );
    await waitFor(() => {
      expect(vi.mocked(listPurchases).mock.calls.length).toBe(calls + 1);
    });
  });

  it('locks the page through save and reload, and shows a back-dated failure on the confirm step', async () => {
    await renderPage();
    vi.mocked(recordPurchase).mockRejectedValueOnce(
      new Error(backDatedMessage('زيت')),
    );
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'oil' },
    });
    fireEvent.change(screen.getByLabelText('الكمية'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'لتر' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'مينفعش تسجّل حركة لـ زيت بتاريخ أقدم من آخر حركة ليه — التعديل بأثر رجعي جاي في مرحلة لاحقة',
    );
    expect(
      screen.getByText('المشتريات نهائية لحد ما نضيف التعديل'),
    ).toBeInTheDocument();

    let releaseSave: () => void = () => undefined;
    vi.mocked(recordPurchase).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSave = () => resolve();
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordPurchase).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(screen.getByLabelText('من')).toBeDisabled();
    const sent = vi.mocked(recordPurchase).mock.calls[1]?.[0];
    expect(sent?.lines[0]).toMatchObject({
      quantity: '2',
      unit: 'لتر',
      amountPaid: '50.00',
    });
    expect(sent?.lines[0]?.unitCost).toBe('27.173913');

    let releaseReload: (rows: Purchase[]) => void = () => undefined;
    vi.mocked(listPurchases).mockReturnValue(
      new Promise((resolve) => {
        releaseReload = resolve;
      }),
    );
    releaseSave();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'اتسجلت المشتريات',
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'مراجعة' })).toBeDisabled();
    });
    expect(screen.getByLabelText('الصنف')).toHaveValue('');

    releaseReload([purchase('مورد')]);
    expect(
      await screen.findByRole('article', { name: 'مورد' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
    expect(screen.getByLabelText('من')).toBeEnabled();
  });

  function fillAndReview() {
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'oil' },
    });
    fireEvent.change(screen.getByLabelText('الكمية'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'لتر' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
  }

  it('keeps the request id across a failed save and mints a new one after success', async () => {
    await renderPage();
    vi.mocked(recordPurchase).mockRejectedValueOnce(
      new Error(retrySafeMessage),
    );
    fillAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );
    expect(
      screen.getByText('المشتريات نهائية لحد ما نضيف التعديل'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordPurchase).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(recordPurchase).mock.calls[0]?.[0]?.requestId;
    const second = vi.mocked(recordPurchase).mock.calls[1]?.[0]?.requestId;
    expect(first).toBeTruthy();
    expect(second).toBe(first);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'اتسجلت المشتريات',
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
    });
    fillAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordPurchase).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(recordPurchase).mock.calls[2]?.[0]?.requestId).not.toBe(
      first,
    );
  });

  it('asks for another review when the conversion changed and keeps the draft', async () => {
    await renderPage();
    const loads = vi.mocked(listStockChoices).mock.calls.length;
    vi.mocked(recordPurchase).mockRejectedValueOnce(
      new ConversionChangedError(),
    );
    fillAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      conversionChangedMessage,
    );
    expect(
      screen.getByText('المشتريات نهائية لحد ما نضيف التعديل'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(vi.mocked(listStockChoices).mock.calls.length).toBeGreaterThan(
        loads,
      );
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    expect(screen.queryByLabelText('الكمية')).not.toBeInTheDocument();
  });
});
