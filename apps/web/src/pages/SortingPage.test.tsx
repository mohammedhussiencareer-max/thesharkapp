import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SortingPage } from '@/pages/SortingPage';
import { listMixedFish, listSorts, recordSort } from '@/sorting/api';
import {
  backDatedSortMessage,
  notEnoughStockMessage,
  pendingResendMessage,
  retrySafeMessage,
} from '@/sorting/errors';
import type { MixedFish, SortRecord } from '@/sorting/types';

vi.mock('@/sorting/api', () => ({
  listMixedFish: vi.fn(),
  listSorts: vi.fn(),
  recordSort: vi.fn(),
}));

const mixed: MixedFish = {
  id: 'mixed',
  name: 'بوري مخلوط',
  onHandQty: '100',
  onHandValue: '5000.00',
  avgCost: '50',
  hasUncoveredDeficit: false,
  sizes: [
    { id: 'large', name: 'كبير' },
    { id: 'small', name: 'وسط' },
  ],
};

function sortRow(id: string): SortRecord {
  return {
    id,
    mixedItemId: 'mixed',
    mixedItemName: 'بوري مخلوط',
    occurredAt: '2026-07-15T09:00:00.000Z',
    createdAt: '2026-07-15T09:01:00.000Z',
    note: null,
    qtyTaken: '10',
    sizesQty: '9.5',
    lossQty: '0.5',
    lossValue: '25.00',
    costPerKg: '50',
    lines: [
      { lineNo: 1, itemId: 'large', itemName: 'كبير', quantity: '6' },
      { lineNo: 2, itemId: 'small', itemName: 'وسط', quantity: '3.5' },
    ],
  };
}

async function renderPage() {
  render(
    <MemoryRouter>
      <SortingPage />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('وقت الفرز')).toBeInTheDocument();
}

function fillSort() {
  fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
    target: { value: 'mixed' },
  });
  fireEvent.change(screen.getByLabelText('كمية المخلوط'), {
    target: { value: '10' },
  });
  fireEvent.change(screen.getByLabelText('كمية كبير'), {
    target: { value: '6' },
  });
  fireEvent.change(screen.getByLabelText('كمية وسط'), {
    target: { value: '3.5' },
  });
}

describe('SortingPage', () => {
  beforeEach(() => {
    vi.mocked(listMixedFish).mockReset();
    vi.mocked(listSorts).mockReset();
    vi.mocked(recordSort).mockReset();
    vi.mocked(listMixedFish).mockResolvedValue([mixed]);
    vi.mocked(listSorts).mockResolvedValue([]);
    vi.mocked(recordSort).mockResolvedValue(undefined);
  });

  it('locks the page through the save and the reload', async () => {
    await renderPage();
    let releaseSave: () => void = () => undefined;
    vi.mocked(recordSort).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSave = () => resolve();
      }),
    );
    fillSort();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(screen.getByLabelText('من')).toBeDisabled();

    let releaseReload: (rows: SortRecord[]) => void = () => undefined;
    vi.mocked(listSorts).mockReturnValue(
      new Promise((resolve) => {
        releaseReload = resolve;
      }),
    );
    releaseSave();
    expect(await screen.findByRole('status')).toHaveTextContent('اتسجل الفرز');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    });
    expect(screen.getByLabelText('كمية المخلوط')).toHaveValue('');

    releaseReload([sortRow('saved')]);
    expect(
      await screen.findByRole('article', { name: 'بوري مخلوط' }),
    ).toBeInTheDocument();
    expect(screen.getByText('الفاقد 0.5 كيلو')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    expect(screen.getByLabelText('من')).toBeEnabled();
  });

  it('keeps the request id across a failed save and mints a new one after success', async () => {
    await renderPage();
    vi.mocked(recordSort).mockRejectedValueOnce(new Error(retrySafeMessage));
    fillSort();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(recordSort).mock.calls[0]?.[0]?.requestId;
    const second = vi.mocked(recordSort).mock.calls[1]?.[0]?.requestId;
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(vi.mocked(recordSort).mock.calls[0]?.[0]).toMatchObject({
      qtyTaken: '10',
      lines: [
        { itemId: 'large', quantity: '6' },
        { itemId: 'small', quantity: '3.5' },
      ],
    });

    expect(await screen.findByRole('status')).toHaveTextContent('اتسجل الفرز');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    fillSort();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(recordSort).mock.calls[2]?.[0]?.requestId).not.toBe(first);
  });

  it('ignores a stale history read', async () => {
    const resolvers: ((rows: SortRecord[]) => void)[] = [];
    vi.mocked(listSorts).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(
      <MemoryRouter>
        <SortingPage />
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
    expect(listSorts).toHaveBeenLastCalledWith({
      from: '2026-07-14T21:00:00.000Z',
      toExclusive: undefined,
    });

    await act(async () => {
      resolvers[1]?.([sortRow('جديد')]);
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('article', { name: 'بوري مخلوط' }),
    ).toBeInTheDocument();

    await act(async () => {
      resolvers[0]?.([{ ...sortRow('قديم'), mixedItemName: 'دنيس مخلوط' }]);
      await Promise.resolve();
    });
    expect(
      screen.getByRole('article', { name: 'بوري مخلوط' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: 'دنيس مخلوط' }),
    ).not.toBeInTheDocument();
  });

  it('resends the saved payload after a lost reply and a zero balance', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
      target: { value: 'mixed' },
    });
    fireEvent.change(screen.getByLabelText('كمية المخلوط'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('كمية كبير'), {
      target: { value: '100' },
    });
    vi.mocked(recordSort).mockRejectedValueOnce(new Error(retrySafeMessage));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );
    expect(screen.getByText(pendingResendMessage)).toBeInTheDocument();

    vi.mocked(listMixedFish).mockResolvedValue([
      { ...mixed, onHandQty: '0', onHandValue: '0.00', avgCost: '0' },
    ]);
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2026-10-01' },
    });
    expect(await screen.findByText(/الرصيد 0 كيلو/)).toBeInTheDocument();
    expect(screen.getByLabelText('كمية المخلوط')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('كمية كبير')).toHaveAttribute('readonly');
    expect(screen.queryByText(notEnoughStockMessage)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordSort).mock.calls[1]?.[0]).toEqual(
      vi.mocked(recordSort).mock.calls[0]?.[0],
    );
  });

  it('blocks a save when the history range is reversed', async () => {
    await renderPage();
    fillSort();
    const beforeRange = vi.mocked(listSorts).mock.calls.length;
    fireEvent.change(screen.getByLabelText('إلى'), {
      target: { value: '2026-10-21' },
    });
    await waitFor(() => {
      expect(vi.mocked(listSorts).mock.calls.length).toBe(beforeRange + 1);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    const reads = vi.mocked(listSorts).mock.calls.length;
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2026-10-22' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'تاريخ البداية لازم يكون قبل تاريخ النهاية',
    );
    expect(screen.getByLabelText('من')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('إلى')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('من')).toBeEnabled();
    expect(screen.getByLabelText('إلى')).toBeEnabled();
    expect(vi.mocked(listSorts)).toHaveBeenCalledTimes(reads);

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(recordSort).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    expect(screen.getByLabelText('من')).toBeEnabled();
    expect(screen.getByLabelText('كمية المخلوط')).not.toHaveAttribute(
      'readonly',
    );
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
  });

  it('saves after a reversed range is corrected', async () => {
    await renderPage();
    fillSort();
    const beforeTo = vi.mocked(listSorts).mock.calls.length;
    fireEvent.change(screen.getByLabelText('إلى'), {
      target: { value: '2026-10-21' },
    });
    await waitFor(() => {
      expect(vi.mocked(listSorts).mock.calls.length).toBe(beforeTo + 1);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2026-10-22' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(recordSort).not.toHaveBeenCalled();
    expect(screen.getByLabelText('وقت الفرز')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('كمية المخلوط')).not.toHaveAttribute(
      'readonly',
    );
    expect(screen.getByLabelText('السمك المخلوط')).toBeEnabled();

    const beforeFix = vi.mocked(listSorts).mock.calls.length;
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2026-10-21' },
    });
    await waitFor(() => {
      expect(vi.mocked(listSorts).mock.calls.length).toBe(beforeFix + 1);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(recordSort).mock.calls[0]?.[0]).toMatchObject({
      qtyTaken: '10',
      lines: [
        { itemId: 'large', quantity: '6' },
        { itemId: 'small', quantity: '3.5' },
      ],
    });
  });

  it('lets the owner correct the time after a back-dated refusal', async () => {
    await renderPage();
    fillSort();
    fireEvent.change(screen.getByLabelText('وقت الفرز'), {
      target: { value: '2026-10-22T10:00' },
    });
    vi.mocked(recordSort).mockRejectedValueOnce({
      code: 'P0001',
      message: 'back-dated movement not supported yet',
      details: 'بوري مخلوط',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      backDatedSortMessage('بوري مخلوط'),
    );
    expect(screen.getByLabelText('وقت الفرز')).not.toHaveAttribute('readonly');
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('وقت الفرز'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(recordSort).mock.calls[0]?.[0];
    const second = vi.mocked(recordSort).mock.calls[1]?.[0];
    expect(first?.occurredAt).toBe('2026-10-22T07:00:00.000Z');
    expect(second?.occurredAt).toBe('2026-10-22T09:00:00.000Z');
    expect(second?.requestId).toBe(first?.requestId);
  });

  it('resends the same payload after a network failure', async () => {
    await renderPage();
    fillSort();
    vi.mocked(recordSort).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to fetch',
    );
    expect(screen.getByText(pendingResendMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('كمية المخلوط')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('وقت الفرز')).toHaveAttribute('readonly');

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordSort).mock.calls[1]?.[0]).toEqual(
      vi.mocked(recordSort).mock.calls[0]?.[0],
    );
  });

  it('keeps the pin when a later attempt is unknown', async () => {
    await renderPage();
    fillSort();
    vi.mocked(recordSort).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('كمية المخلوط')).toHaveAttribute('readonly');

    vi.mocked(recordSort).mockRejectedValueOnce({
      code: 'PGRST003',
      message: 'upstream timed out',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(retrySafeMessage);
    });
    expect(screen.getByText(pendingResendMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('كمية المخلوط')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('وقت الفرز')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('السمك المخلوط')).toBeDisabled();
    expect(vi.mocked(recordSort).mock.calls[1]?.[0]).toEqual(
      vi.mocked(recordSort).mock.calls[0]?.[0],
    );

    fireEvent.change(screen.getByLabelText('كمية المخلوط'), {
      target: { value: '99' },
    });
    expect(screen.getByLabelText('كمية المخلوط')).toHaveValue('10');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(recordSort).mock.calls[2]?.[0]).toEqual(
      vi.mocked(recordSort).mock.calls[0]?.[0],
    );
  });

  it('releases the pin when the replay is definitely refused', async () => {
    await renderPage();
    fillSort();
    vi.mocked(recordSort).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    vi.mocked(recordSort).mockRejectedValueOnce({
      code: '22023',
      message: 'not enough stock to sort',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        notEnoughStockMessage,
      );
    });
    expect(vi.mocked(recordSort).mock.calls[1]?.[0]).toEqual(
      vi.mocked(recordSort).mock.calls[0]?.[0],
    );
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
    expect(screen.getByLabelText('وقت الفرز')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('كمية المخلوط')).not.toHaveAttribute(
      'readonly',
    );
    expect(screen.getByLabelText('كمية المخلوط')).toHaveValue('10');
    expect(screen.getByLabelText('السمك المخلوط')).toBeEnabled();

    fireEvent.change(screen.getByLabelText('كمية كبير'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(3);
    });
    const first = vi.mocked(recordSort).mock.calls[0]?.[0];
    const edited = vi.mocked(recordSort).mock.calls[2]?.[0];
    expect(edited?.requestId).toBe(first?.requestId);
    expect(edited?.lines).toEqual([
      { itemId: 'large', quantity: '5' },
      { itemId: 'small', quantity: '3.5' },
    ]);
  });

  it('clears the pin after the pinned payload succeeds and mints a new request id', async () => {
    await renderPage();
    fillSort();
    vi.mocked(recordSort).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('status')).toHaveTextContent('اتسجل الفرز');
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
    const pinnedId = vi.mocked(recordSort).mock.calls[0]?.[0]?.requestId;
    expect(vi.mocked(recordSort).mock.calls[1]?.[0]?.requestId).toBe(pinnedId);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    expect(screen.getByLabelText('كمية المخلوط')).toHaveValue('');

    fillSort();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordSort).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(recordSort).mock.calls[2]?.[0]?.requestId).not.toBe(
      pinnedId,
    );
  });

  it('stays unlocked when the range is reversed after a save', async () => {
    await renderPage();
    fillSort();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('status')).toHaveTextContent('اتسجل الفرز');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });

    const beforeRange = vi.mocked(listSorts).mock.calls.length;
    fireEvent.change(screen.getByLabelText('إلى'), {
      target: { value: '2026-10-21' },
    });
    await waitFor(() => {
      expect(vi.mocked(listSorts).mock.calls.length).toBe(beforeRange + 1);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    const reads = vi.mocked(listSorts).mock.calls.length;
    fireEvent.change(screen.getByLabelText('من'), {
      target: { value: '2026-10-22' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'تاريخ البداية لازم يكون قبل تاريخ النهاية',
    );
    expect(screen.getByLabelText('من')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('إلى')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('من')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    expect(vi.mocked(listSorts)).toHaveBeenCalledTimes(reads);
    expect(
      screen.queryByRole('button', { name: 'إعادة المحاولة' }),
    ).not.toBeInTheDocument();

    fillSort();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(recordSort).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('من')).toBeEnabled();
  });

  it('offers a retry when the reload after a save fails', async () => {
    await renderPage();
    fillSort();
    vi.mocked(listSorts).mockRejectedValueOnce(new Error('تعذر التحميل'));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر التحميل');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(screen.getByLabelText('من')).toBeDisabled();

    vi.mocked(listSorts).mockResolvedValueOnce([sortRow('saved')]);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByRole('article', { name: 'بوري مخلوط' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    expect(screen.getByLabelText('من')).toBeEnabled();
  });
});
