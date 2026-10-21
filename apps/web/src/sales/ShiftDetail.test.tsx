import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ShiftDetailView } from '@/sales/ShiftDetail';
import type { ShiftDetail } from '@/sales/types';

const detail: ShiftDetail = {
  summary: {
    shiftId: 'shift-test-1',
    openedAt: '2026-10-15T09:00:00.000Z',
    closedAt: '2026-10-16T01:00:00.000Z',
    isActive: false,
    ordersComplete: 1,
    grossSales: '100.00',
    refunds: '25.00',
    netSales: '75.00',
    ordersCanceled: 0,
    ordersOpen: 0,
    ordersMissing: 1,
    drawerTotal: '75.00',
    drawerDifference: '0.00',
    unknownTx: 0,
  },
  orders: [
    {
      id: 'order-test-complete',
      orderNumber: 4242,
      orderedAt: '2026-10-15T12:00:00.000Z',
      orderType: 'takeaway',
      paymentType: 'cash',
      status: 'complete',
      missingFromPos: false,
      total: '100.00',
      refunded: '25.00',
      lines: [
        {
          lineId: 'line-test-1',
          itemName: 'سمكة اختبار',
          sizeName: 'وسط',
          quantity: '2.000000',
          weightedQty: null,
          weightedUnit: null,
          lineTotal: '100.00',
          optionValues: ['مشوي'],
        },
      ],
    },
    {
      id: 'order-test-missing',
      orderNumber: 4243,
      orderedAt: '2026-10-15T13:00:00.000Z',
      orderType: 'hall',
      paymentType: 'credit',
      status: 'complete',
      missingFromPos: true,
      total: '999.00',
      refunded: '0.00',
      lines: [],
    },
  ],
};

describe('ShiftDetailView', () => {
  it('shows view totals, a refund, and a missing order outside those totals', () => {
    render(
      <MemoryRouter>
        <ShiftDetailView detail={detail} />
      </MemoryRouter>,
    );

    expect(screen.getByText('صافي المبيعات 75.00 ج.م')).toBeInTheDocument();
    expect(screen.getByText('مرتجعات 25.00 ج.م')).toBeInTheDocument();
    expect(screen.getByText('مطابق للدرج')).toBeInTheDocument();
    expect(screen.getByText('4242')).toBeInTheDocument();
    expect(screen.getByText('25.00 ج.م')).toBeInTheDocument();
    expect(screen.getByText('تيك أواي')).toBeInTheDocument();
    expect(screen.getByText('كاش')).toBeInTheDocument();
    expect(screen.getByText(/مش موجود في الـ POS/)).toBeInTheDocument();
    expect(screen.getByText('999.00 ج.م')).toBeInTheDocument();
    expect(screen.queryByText('1074.00 ج.م')).not.toBeInTheDocument();

    expect(screen.queryByText('سمكة اختبار')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'السطور' })[0]!);
    expect(screen.getByText('سمكة اختبار')).toBeInTheDocument();
    expect(screen.getByText('وسط')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getAllByText('100.00 ج.م')).toHaveLength(2);
    expect(screen.getByText('مشوي')).toBeInTheDocument();
  });
});
