import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AllocationTable } from '@/expenses/AllocationTable';
import type { AllocationDay } from '@/expenses/types';
import { addMoney } from '@/lib/money';

function aprilRent(): AllocationDay[] {
  return Array.from({ length: 30 }, (_, index) => {
    const share = index < 10 ? '33.34' : '33.33';
    const day = String(index + 1).padStart(2, '0');
    return {
      date: `2030-04-${day}`,
      fixedShare: share,
      dailyTotal: '0.00',
      driverTotal: '0.00',
      interest: '0.00',
      depreciation: '0.00',
      total: share,
    };
  });
}

describe('AllocationTable', () => {
  it('shows 33.34 and 33.33 shares that sum to 1000.00', () => {
    const days = aprilRent();
    const summed = days.reduce(
      (total, day) => addMoney(total, day.fixedShare),
      '0.00',
    );
    expect(summed).toBe('1000.00');

    render(<AllocationTable days={days} />);

    const table = screen.getByRole('table', { name: 'توزيع الشهر' });
    expect(
      within(table).getAllByRole('cell', { name: '33.34 ج.م' }),
    ).toHaveLength(20);
    expect(
      within(table).getAllByRole('cell', { name: '33.33 ج.م' }),
    ).toHaveLength(40);
    const footer = within(table).getByRole('row', { name: 'إجمالي الشهر' });
    expect(within(footer).getAllByText('1000.00 ج.م')).toHaveLength(2);
    expect(
      within(table).getByRole('row', { name: /01\/04\/2030/ }),
    ).toHaveTextContent('33.34 ج.م');
    expect(
      within(table).getByRole('row', { name: /11\/04\/2030/ }),
    ).toHaveTextContent('33.33 ج.م');
  });
});
