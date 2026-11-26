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
  getPurchaseById,
  listPurchases,
  listStockChoices,
  listUnitsAt,
  recordPurchase,
} from '@/purchases/api';
import {
  claimReplayHeldWrite,
  hasPostedReload,
  putHeldWrite,
} from '@/lib/held-writes';
import { PurchasesPage } from '@/pages/PurchasesPage';
import type { Purchase, StockChoice, UnitOption } from '@/purchases/types';

vi.mock('@/purchases/api', () => ({
  getPurchaseById: vi.fn(),
  listStockChoices: vi.fn(),
  listPurchases: vi.fn(),
  recordPurchase: vi.fn(),
  listUnitsAt: vi.fn(() => Promise.resolve({})),
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
    vi.mocked(getPurchaseById).mockReset();
    vi.mocked(listStockChoices).mockReset();
    vi.mocked(listPurchases).mockReset();
    vi.mocked(recordPurchase).mockReset();
    vi.mocked(getPurchaseById).mockResolvedValue(purchase('مورد'));
    vi.mocked(listStockChoices).mockResolvedValue([oil]);
    vi.mocked(listPurchases).mockResolvedValue([]);
    vi.mocked(recordPurchase).mockResolvedValue(undefined);
    vi.mocked(listUnitsAt).mockReset();
    vi.mocked(listUnitsAt).mockResolvedValue({});
  });

  it('blocks a legacy purchase retry at the page and under the lock until the older post is verified', async () => {
    await renderPage();
    const subject = 'purchase:new';
    act(() => {
      putHeldWrite(subject, {
        requestId: 'older-purchase',
        payload: null,
        phase: 'posted_reload',
        readTarget: 'saved-purchase',
      });
      putHeldWrite(subject, {
        requestId: 'legacy-retry',
        phase: 'unknown',
        payload: {
          requestId: 'legacy-retry',
          purchasedAt: '2026-07-15T09:00:00.000Z',
          supplier: 'مورد',
          invoiceNo: null,
          note: null,
          lines: [
            {
              itemId: 'oil',
              quantity: '1',
              unit: 'kg',
              amountPaid: '10',
              baseUnit: 'kg',
              expectedFactor: '1',
            },
          ],
        },
      });
    });
    const claimed = await claimReplayHeldWrite(subject, 'legacy-retry');
    if (claimed.ok) claimed.release();
    expect(claimed).toMatchObject({
      ok: false,
      reason: 'conflict',
      existing: { requestId: 'older-purchase' },
    });
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'تحقق تاني' }));
    await waitFor(() => expect(hasPostedReload(subject)).toBe(false));
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
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
        releaseSave = () => resolve(undefined);
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
    const lookedUpAt: string[] = [];
    let releaseUnits: (rows: Record<string, UnitOption[]>) => void = () =>
      undefined;
    vi.mocked(listUnitsAt).mockImplementation((_ids, at) => {
      lookedUpAt.push(at);
      if (lookedUpAt.length === 1) {
        return Promise.resolve({
          oil: [{ unit: 'لتر', factorToBase: '0.92', label: 'لتر' }],
        });
      }
      return new Promise((resolve) => {
        releaseUnits = resolve;
      });
    });
    await renderPage();
    const purchasedAt = screen.getByLabelText('وقت الشراء');
    const stamp = (purchasedAt as HTMLInputElement).value;
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
    });
    vi.mocked(recordPurchase).mockRejectedValueOnce(
      new ConversionChangedError(),
    );
    fillAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      conversionChangedMessage,
    );
    expect(
      screen.queryByRole('heading', { name: 'مراجعة المشتريات' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('وقت الشراء')).toHaveValue(stamp);
    expect(screen.getByLabelText('الكمية')).toHaveValue('2');
    expect(screen.getByLabelText('الوحدة')).toHaveValue('لتر');
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeDisabled();
    expect(lookedUpAt.length).toBeGreaterThanOrEqual(2);
    expect(lookedUpAt[1]).toBe(lookedUpAt[0]);

    await act(async () => {
      releaseUnits({
        oil: [{ unit: 'لتر', factorToBase: '1.1', label: 'لتر' }],
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
    });
    expect(screen.getByLabelText('وقت الشراء')).toHaveValue(stamp);
    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    expect(
      screen.getByRole('heading', { name: 'مراجعة المشتريات' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordPurchase).toHaveBeenCalledTimes(2);
    });
    expect(
      vi.mocked(recordPurchase).mock.calls[0]?.[0]?.lines[0]?.expectedFactor,
    ).toBe('0.92');
    expect(
      vi.mocked(recordPurchase).mock.calls[1]?.[0]?.lines[0]?.expectedFactor,
    ).toBe('1.1');
    expect(vi.mocked(recordPurchase).mock.calls[1]?.[0]?.purchasedAt).toBe(
      vi.mocked(recordPurchase).mock.calls[0]?.[0]?.purchasedAt,
    );
    expect(vi.mocked(recordPurchase).mock.calls[1]?.[0]?.requestId).toBe(
      vi.mocked(recordPurchase).mock.calls[0]?.[0]?.requestId,
    );
  });

  it('P2 item 3: inverted date filter does not block purchase verification or filter edits', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2026-07-20' },
    });
    fireEvent.change(screen.getByLabelText('إلى'), {
      target: { value: '2026-07-01' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'تاريخ البداية لازم يكون قبل تاريخ النهاية',
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
    });

    fillAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'اتسجلت المشتريات',
    );

    // Verification must succeed independently of the inverted filter, clearing
    // posted_reload and leaving both filter inputs and the form usable.
    await waitFor(() => {
      expect(hasPostedReload('purchase:new')).toBe(false);
    });
    expect(screen.getByLabelText('من')).toBeEnabled();
    expect(screen.getByLabelText('إلى')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
  });

  it('P2 item 3b: purchase verification checks the saved purchase by id independently of an excluding history filter', async () => {
    await renderPage();
    // Filter excludes the saved purchase's date; listPurchases returns [].
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2025-01-01' },
    });
    fireEvent.change(screen.getByLabelText('إلى'), {
      target: { value: '2025-01-31' },
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
    });

    vi.mocked(recordPurchase).mockResolvedValueOnce('purch-saved-1');
    vi.mocked(getPurchaseById)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(purchase('مورد محفوظ'));

    fillAndReview();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'اتسجلت المشتريات',
    );

    // Even though filtered listPurchases returned [], posted_reload must NOT
    // clear when getPurchaseById does not find the saved purchase.
    await waitFor(() => {
      expect(getPurchaseById).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'purch-saved-1' }),
      );
    });
    expect(hasPostedReload('purchase:new', 'purch-saved-1')).toBe(true);
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeDisabled();

    // Retry succeeds once getPurchaseById returns the saved purchase.
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(hasPostedReload('purchase:new', 'purch-saved-1')).toBe(false);
    });
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
  });
});
