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
import { retrySafeMessage } from '@/sorting/errors';
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
});
