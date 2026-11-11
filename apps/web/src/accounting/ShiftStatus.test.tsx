import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShiftStatus } from '@/accounting/ShiftStatus';
import type {
  DifferenceVector,
  ShiftAccountingStatus,
} from '@/accounting/types';

const zero: DifferenceVector = {
  netSalesDifference: '0.00',
  cogsDifference: '1.25',
  wasteDifference: '-1.25',
  countDifference: '0.00',
  profitDifference: '0.00',
};

const status: ShiftAccountingStatus = {
  shiftId: 'shift-1',
  openedAt: '2026-01-01T00:00:00.000Z',
  statusLabel: 'ناقص',
  revised: true,
  causes: [
    'open_orders',
    'pending_applications',
    'tracking_unknown',
    'incomplete_application',
    'unmapped_base',
  ],
  latestDifference: zero,
  cumulativeDifference: zero,
};

describe('ShiftStatus', () => {
  it('shows the label, Arabic causes, the revised badge, and the difference vector', () => {
    render(<ShiftStatus status={status} capped={false} missing={false} />);
    expect(screen.getByText('ناقص')).toBeInTheDocument();
    expect(screen.getByText('معدّل')).toBeInTheDocument();
    expect(screen.getByText('فيه طلبات مفتوحة')).toBeInTheDocument();
    expect(screen.getByText('فيه خصم لسه مستني')).toBeInTheDocument();
    expect(
      screen.getByText('تتبع الصنف قبل الوردية مش معروف'),
    ).toBeInTheDocument();
    expect(screen.getByText('فيه خصم ناقص')).toBeInTheDocument();
    expect(screen.getByText('الصنف مش مربوط')).toBeInTheDocument();
    expect(screen.getAllByText('فرق المبيعات').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1.25 ج.م').length).toBeGreaterThan(0);
    expect(screen.queryByText(/صافي المبيعات/)).toBeNull();
  });

  it('says when the shift is outside the loaded window', () => {
    const { rerender } = render(<ShiftStatus status={null} capped missing />);
    expect(
      screen.getByText('حالة الوردية مش في النافذة المحمّلة'),
    ).toBeInTheDocument();
    rerender(<ShiftStatus status={null} capped={false} missing />);
    expect(screen.getByText('حالة الوردية مش متاحة')).toBeInTheDocument();
  });
});
