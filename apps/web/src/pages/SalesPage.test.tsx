import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SalesPage } from '@/pages/SalesPage';
import { loadSalesHome } from '@/sales/api';
import type { SalesHome, ShiftSummary } from '@/sales/types';

vi.mock('@/sales/api', () => ({
  loadSalesHome: vi.fn(),
}));

function shift(netSales: string): ShiftSummary {
  return {
    shiftId: 'shift-test-1',
    openedAt: '2026-10-15T09:00:00.000Z',
    closedAt: '2026-10-16T01:00:00.000Z',
    isActive: false,
    ordersComplete: 1,
    grossSales: netSales,
    refunds: '0.00',
    netSales,
    ordersCanceled: 0,
    ordersOpen: 0,
    ordersMissing: 0,
    drawerTotal: netSales,
    drawerDifference: '0.00',
    unknownTx: 0,
  };
}

function home(netSales: string): SalesHome {
  return {
    shifts: [shift(netSales)],
    lastSyncAt: '2026-10-21T11:00:00.000Z',
  };
}

describe('SalesPage', () => {
  beforeEach(() => {
    vi.mocked(loadSalesHome).mockReset();
  });

  it('shows the empty state', async () => {
    vi.mocked(loadSalesHome).mockResolvedValue({
      shifts: [],
      lastSyncAt: null,
    });
    render(
      <MemoryRouter>
        <SalesPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('لسه مفيش مبيعات متزامنة'),
    ).toBeInTheDocument();
  });

  it('shows an error and retries', async () => {
    vi.mocked(loadSalesHome)
      .mockRejectedValueOnce(new Error('حصل خطأ. حاول تاني.'))
      .mockResolvedValueOnce(home('210.00'));
    render(
      <MemoryRouter>
        <SalesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'حصل خطأ. حاول تاني.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByText('صافي المبيعات 210.00 ج.م'),
    ).toBeInTheDocument();
    expect(screen.getByText(/آخر مزامنة/)).toBeInTheDocument();
  });

  it('ignores a late response after a newer reload', async () => {
    let resolveFirst: (value: SalesHome) => void = () => undefined;
    vi.mocked(loadSalesHome)
      .mockImplementationOnce(
        () =>
          new Promise<SalesHome>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(home('210.00'));
    render(
      <MemoryRouter>
        <SalesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('جاري تحميل المبيعات…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    expect(
      await screen.findByText('صافي المبيعات 210.00 ج.م'),
    ).toBeInTheDocument();
    await act(async () => {
      resolveFirst(home('999.00'));
      await Promise.resolve();
    });
    expect(screen.getByText('صافي المبيعات 210.00 ج.م')).toBeInTheDocument();
    expect(
      screen.queryByText('صافي المبيعات 999.00 ج.م'),
    ).not.toBeInTheDocument();
  });
});
