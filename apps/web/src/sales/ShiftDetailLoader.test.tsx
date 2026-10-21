import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShiftDetailLoader } from '@/sales/ShiftDetailLoader';
import { loadShiftDetail } from '@/sales/api';
import type { ShiftDetail } from '@/sales/types';

vi.mock('@/sales/api', () => ({
  loadShiftDetail: vi.fn(),
}));

function detail(orderNumber: number): ShiftDetail {
  return {
    summary: {
      shiftId: 'shift-test-1',
      openedAt: '2026-10-15T09:00:00.000Z',
      closedAt: '2026-10-16T01:00:00.000Z',
      isActive: false,
      ordersComplete: 1,
      grossSales: '100.00',
      refunds: '0.00',
      netSales: '100.00',
      ordersCanceled: 0,
      ordersOpen: 0,
      ordersMissing: 0,
      drawerTotal: '100.00',
      drawerDifference: '0.00',
      unknownTx: 0,
    },
    orders: [
      {
        id: `order-${orderNumber.toString()}`,
        orderNumber,
        orderedAt: '2026-10-15T12:00:00.000Z',
        orderType: 'takeaway',
        paymentType: 'cash',
        status: 'complete',
        missingFromPos: false,
        total: '100.00',
        refunded: '0.00',
        lines: [],
      },
    ],
  };
}

describe('ShiftDetailLoader', () => {
  beforeEach(() => {
    vi.mocked(loadShiftDetail).mockReset();
  });

  it('ignores a late response for the previous shift', async () => {
    let resolveSlow: (value: ShiftDetail) => void = () => undefined;
    vi.mocked(loadShiftDetail).mockImplementation((shiftId: string) => {
      if (shiftId === 'shift-slow') {
        return new Promise<ShiftDetail>((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(detail(9002));
    });

    const { rerender } = render(
      <MemoryRouter>
        <ShiftDetailLoader shiftId="shift-slow" />
      </MemoryRouter>,
    );
    expect(await screen.findByText('جاري تحميل المبيعات…')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <ShiftDetailLoader shiftId="shift-fast" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('9002')).toBeInTheDocument();
    await act(async () => {
      resolveSlow(detail(9001));
      await Promise.resolve();
    });
    expect(screen.getByText('9002')).toBeInTheDocument();
    expect(screen.queryByText('9001')).not.toBeInTheDocument();
  });

  it('says when the shift is missing', async () => {
    vi.mocked(loadShiftDetail).mockResolvedValue(null);
    render(
      <MemoryRouter>
        <ShiftDetailLoader shiftId="shift-missing" />
      </MemoryRouter>,
    );
    expect(await screen.findByText('الوردية دي مش موجودة')).toBeInTheDocument();
    expect(
      screen.queryByText('لسه مفيش مبيعات متزامنة'),
    ).not.toBeInTheDocument();
  });
});
