import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ShiftList } from '@/sales/ShiftList';
import type { ShiftSummary } from '@/sales/types';

function shift(patch: Partial<ShiftSummary>): ShiftSummary {
  return {
    shiftId: 'shift-test-1',
    openedAt: '2026-10-15T09:00:00.000Z',
    closedAt: '2026-10-16T01:00:00.000Z',
    isActive: false,
    ordersComplete: 1,
    grossSales: '100.00',
    refunds: '25.00',
    netSales: '75.00',
    ordersCanceled: 1,
    ordersOpen: 1,
    ordersMissing: 1,
    drawerTotal: '75.00',
    drawerDifference: '0.00',
    unknownTx: 0,
    ...patch,
  };
}

describe('ShiftList', () => {
  it('shows the reconciliation badge for each drawer state', () => {
    render(
      <MemoryRouter>
        <ShiftList
          shifts={[
            shift({ shiftId: 'match', drawerDifference: '0.00' }),
            shift({
              shiftId: 'off',
              drawerDifference: '1.25',
              openedAt: '2026-10-14T09:00:00.000Z',
            }),
            shift({
              shiftId: 'open',
              isActive: true,
              closedAt: null,
              drawerDifference: '0.00',
              openedAt: '2026-10-13T09:00:00.000Z',
            }),
            shift({
              shiftId: 'empty-drawer',
              drawerTotal: null,
              drawerDifference: null,
              unknownTx: 2,
              openedAt: '2026-10-12T09:00:00.000Z',
            }),
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('مطابق للدرج')).toBeInTheDocument();
    expect(screen.getByText('فرق مع الدرج: 1.25 ج.م')).toBeInTheDocument();
    expect(screen.getByText('الوردية مفتوحة')).toBeInTheDocument();
    expect(screen.getByText('مفيش أرقام درج')).toBeInTheDocument();
    expect(screen.getByText('حركات درج غير معروفة')).toBeInTheDocument();
    expect(screen.getAllByText('صافي المبيعات 75.00 ج.م')).toHaveLength(4);
    expect(
      screen.getByRole('link', { name: 'وردية 15/10/2026 12:00' }),
    ).toHaveAttribute('href', '/sales/match');
  });
});
