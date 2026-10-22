import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listCounts, listDailyItems, recordCount } from '@/counts/api';
import {
  backDatedCountMessage,
  insideShiftMessage,
  openShiftMessage,
  pendingResendMessage,
  permissionMessage,
  retrySafeMessage,
  surplusWarning,
  syncCoverageMessage,
} from '@/counts/errors';
import type { CountItem, CountRecord } from '@/counts/types';
import { CountsPage } from '@/pages/CountsPage';

vi.mock('@/counts/api', () => ({
  listDailyItems: vi.fn(),
  listCounts: vi.fn(),
  recordCount: vi.fn(),
}));

const tilapia: CountItem = {
  id: 'tilapia',
  name: 'بلطي',
  onHandQty: '10',
  onHandValue: '100.00',
  avgCost: '10.05',
};

const shrimp: CountItem = {
  id: 'shrimp',
  name: 'جمبري',
  onHandQty: '4',
  onHandValue: '100.00',
  avgCost: '25',
};

function countRow(id: string, note: string | null = 'جرد الصباح'): CountRecord {
  return {
    id,
    countedAt: '2026-10-22T09:00:00.000Z',
    frequency: 'daily',
    createdAt: '2026-10-22T09:01:00.000Z',
    note,
    itemCount: 1,
    shortageValue: '150.00',
    surplusValue: '0.00',
    hasSurplus: false,
  };
}

async function renderPage() {
  render(
    <MemoryRouter>
      <CountsPage />
    </MemoryRouter>,
  );
  expect(await screen.findByLabelText('وقت الجرد')).toBeInTheDocument();
}

function fillShortage() {
  fireEvent.change(screen.getByLabelText('وقت الجرد'), {
    target: { value: '2026-10-22T12:00' },
  });
  fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
    target: { value: '7' },
  });
}

describe('CountsPage', () => {
  beforeEach(() => {
    vi.mocked(listDailyItems).mockReset();
    vi.mocked(listCounts).mockReset();
    vi.mocked(recordCount).mockReset();
    vi.mocked(listDailyItems).mockResolvedValue([tilapia, shrimp]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(recordCount).mockResolvedValue(undefined);
  });

  it('locks the page through the save and the reload', async () => {
    await renderPage();
    let releaseSave: () => void = () => undefined;
    vi.mocked(recordCount).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSave = () => resolve();
      }),
    );
    fillShortage();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeDisabled();
    expect(screen.getByLabelText('وقت الجرد')).toBeDisabled();

    let releaseReload: (rows: CountRecord[]) => void = () => undefined;
    vi.mocked(listCounts).mockReturnValue(
      new Promise((resolve) => {
        releaseReload = resolve;
      }),
    );
    releaseSave();
    expect(await screen.findByRole('status')).toHaveTextContent('اتسجل الجرد');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeDisabled();
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveValue('');

    releaseReload([countRow('saved')]);
    expect(
      await screen.findByRole('article', { name: 'جرد الصباح' }),
    ).toBeInTheDocument();
    expect(screen.getByText('عجز 150.00 ج.م')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeEnabled();
  });

  it('keeps the request id across a failed save and mints a new one after success', async () => {
    await renderPage();
    vi.mocked(recordCount).mockRejectedValueOnce(new Error(retrySafeMessage));
    fillShortage();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      retrySafeMessage,
    );

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(recordCount).mock.calls[0]?.[0]?.requestId;
    const second = vi.mocked(recordCount).mock.calls[1]?.[0]?.requestId;
    expect(first).toBeTruthy();
    expect(second).toBe(first);

    expect(await screen.findByRole('status')).toHaveTextContent('اتسجل الجرد');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    fillShortage();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(recordCount).mock.calls[2]?.[0]?.requestId).not.toBe(
      first,
    );
  });

  it('ignores a stale refresh and keeps تحديث available during the load', async () => {
    const resolvers: ((rows: CountRecord[]) => void)[] = [];
    vi.mocked(listCounts).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(resolvers).toHaveLength(1);
    });
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    await waitFor(() => {
      expect(resolvers).toHaveLength(2);
    });

    await act(async () => {
      resolvers[1]?.([countRow('جديد', 'جديد')]);
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('article', { name: 'جديد' }),
    ).toBeInTheDocument();

    await act(async () => {
      resolvers[0]?.([countRow('قديم', 'قديم')]);
      await Promise.resolve();
    });
    expect(screen.getByRole('article', { name: 'جديد' })).toBeInTheDocument();
    expect(
      screen.queryByRole('article', { name: 'قديم' }),
    ).not.toBeInTheDocument();
  });

  it('previews a book-value shortage and omits a blank row from the payload', async () => {
    await renderPage();
    fillShortage();
    fireEvent.change(screen.getByLabelText('ملاحظة'), {
      target: { value: 'صباح' },
    });
    expect(
      screen.getByText('الفرق -3 — القيمة -30.00 ج.م'),
    ).toBeInTheDocument();
    expect(screen.getByText('عجز 30.00 ج.م')).toBeInTheDocument();
    expect(screen.queryByText(surplusWarning)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(recordCount).mock.calls[0]?.[0]).toMatchObject({
      countedAt: '2026-10-22T09:00:00.000Z',
      note: 'صباح',
      lines: [{ itemId: 'tilapia', countedQty: '7' }],
    });
    expect(vi.mocked(recordCount).mock.calls[0]?.[0]?.requestId).toBeTruthy();
  });

  it('highlights a surplus and still sends it', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الكمية المعدودة جمبري'), {
      target: { value: '6' },
    });
    expect(screen.getByText(surplusWarning)).toBeInTheDocument();
    expect(screen.getByText('زيادة 50.00 ج.م')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(recordCount).mock.calls[0]?.[0]?.lines).toEqual([
      { itemId: 'shrimp', itemName: 'جمبري', countedQty: '6' },
    ]);
  });

  it('shows why a count inside a shift or before sync coverage is blocked', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(recordCount).mockRejectedValueOnce({
      code: '22023',
      message: 'count time is inside a shift',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      insideShiftMessage,
    );

    vi.mocked(recordCount).mockRejectedValueOnce({
      code: '22023',
      message: 'a shift is still open',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(openShiftMessage);
    });

    vi.mocked(recordCount).mockRejectedValueOnce({
      code: '22023',
      message: 'sync has not covered this count time',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(syncCoverageMessage);
    });
  });

  it('lets the owner correct the time after a back-dated refusal', async () => {
    await renderPage();
    fillShortage();
    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T10:00' },
    });
    vi.mocked(recordCount).mockRejectedValueOnce({
      code: 'P0001',
      message: 'back-dated movement not supported yet',
      details: 'بلطي',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      backDatedCountMessage('بلطي'),
    );
    expect(screen.getByLabelText('وقت الجرد')).not.toHaveAttribute('readonly');
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(recordCount).mock.calls[0]?.[0];
    const second = vi.mocked(recordCount).mock.calls[1]?.[0];
    expect(first?.countedAt).toBe('2026-10-22T07:00:00.000Z');
    expect(second?.countedAt).toBe('2026-10-22T09:00:00.000Z');
    expect(second?.requestId).toBe(first?.requestId);
  });

  it('resends the same payload after a network failure', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(recordCount).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to fetch',
    );
    expect(screen.getByText(pendingResendMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveAttribute(
      'readonly',
    );
    expect(screen.getByLabelText('وقت الجرد')).toHaveAttribute('readonly');

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordCount).mock.calls[1]?.[0]).toEqual(
      vi.mocked(recordCount).mock.calls[0]?.[0],
    );
  });

  it('keeps the pin when a later attempt is unknown', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(recordCount).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    vi.mocked(recordCount).mockRejectedValueOnce({
      code: 'PGRST003',
      message: 'upstream timed out',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(retrySafeMessage);
    });
    expect(screen.getByText(pendingResendMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveAttribute(
      'readonly',
    );
    expect(vi.mocked(recordCount).mock.calls[1]?.[0]).toEqual(
      vi.mocked(recordCount).mock.calls[0]?.[0],
    );
  });

  it('keeps the pin when the replay is refused for permission', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(recordCount).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    vi.mocked(recordCount).mockRejectedValueOnce({
      code: '42501',
      message: 'insufficient_privilege',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(permissionMessage);
    });
    expect(screen.getByText(pendingResendMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveAttribute(
      'readonly',
    );

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(recordCount).mock.calls[2]?.[0]).toEqual(
      vi.mocked(recordCount).mock.calls[0]?.[0],
    );
  });

  it('releases the pin when the replay is definitely refused', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(recordCount).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    vi.mocked(recordCount).mockRejectedValueOnce({
      code: '22023',
      message: 'sync has not covered this count time',
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(syncCoverageMessage);
    });
    expect(vi.mocked(recordCount).mock.calls[1]?.[0]).toEqual(
      vi.mocked(recordCount).mock.calls[0]?.[0],
    );
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
    expect(screen.getByLabelText('وقت الجرد')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveValue('7');

    fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
      target: { value: '8' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(3);
    });
    const first = vi.mocked(recordCount).mock.calls[0]?.[0];
    const edited = vi.mocked(recordCount).mock.calls[2]?.[0];
    expect(edited?.requestId).toBe(first?.requestId);
    expect(edited?.lines).toEqual([
      { itemId: 'tilapia', itemName: 'بلطي', countedQty: '8' },
    ]);
  });

  it('clears the pin after the pinned payload succeeds and mints a new request id', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(recordCount).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('status')).toHaveTextContent('اتسجل الجرد');
    expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
    const pinnedId = vi.mocked(recordCount).mock.calls[0]?.[0]?.requestId;
    expect(vi.mocked(recordCount).mock.calls[1]?.[0]?.requestId).toBe(pinnedId);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveValue('');

    fillShortage();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(recordCount).mock.calls[2]?.[0]?.requestId).not.toBe(
      pinnedId,
    );
  });

  it('offers a retry when the reload after a save fails', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(listCounts).mockRejectedValueOnce(new Error('تعذر التحميل'));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر التحميل');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'إعادة المحاولة' }),
    ).toBeEnabled();

    vi.mocked(listCounts).mockResolvedValueOnce([countRow('saved')]);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByRole('article', { name: 'جرد الصباح' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    expect(screen.getByRole('button', { name: 'تحديث' })).toBeEnabled();
  });

  it('keeps the form usable when a refresh fails', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(listCounts).mockRejectedValueOnce(new Error('تعذر التحميل'));
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر التحميل');
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveValue('7');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    expect(screen.getByLabelText('وقت الجرد')).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'إعادة المحاولة' }),
    ).toBeEnabled();
  });

  it('keeps the pinned lines when a refresh removes and restores the item', async () => {
    await renderPage();
    fillShortage();
    vi.mocked(recordCount).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(pendingResendMessage)).toBeInTheDocument();

    let releaseItems: (rows: CountItem[]) => void = () => undefined;
    vi.mocked(listDailyItems).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseItems = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    await act(async () => {
      releaseItems([]);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });

    expect(
      screen.queryByText('مفيش أصناف جرد يومي نشطة'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('بلطي')).toBeInTheDocument();
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveValue('7');
    expect(screen.getByLabelText('وقت الجرد')).toHaveValue('2026-10-22T12:00');

    vi.mocked(recordCount).mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(recordCount).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(recordCount).mock.calls[1]?.[0]).toEqual(
      vi.mocked(recordCount).mock.calls[0]?.[0],
    );

    vi.mocked(listDailyItems).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseItems = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    await act(async () => {
      releaseItems([tilapia, shrimp]);
      await Promise.resolve();
    });
    expect(screen.getByLabelText('الكمية المعدودة بلطي')).toHaveValue('7');
    expect(screen.getByLabelText('وقت الجرد')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
  });
});
