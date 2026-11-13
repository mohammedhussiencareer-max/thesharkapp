import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrderCost } from '@/accounting/api';
import type { OrderCostDetail } from '@/accounting/types';
import { OrderCostPage } from '@/pages/OrderCostPage';

vi.mock('@/accounting/api', () => ({
  loadOrderCost: vi.fn(),
}));

const empty: OrderCostDetail = {
  found: true,
  orderId: 'order 1',
  orderNumber: null,
  input: null,
  state: null,
  applications: [],
};

describe('OrderCostPage', () => {
  beforeEach(() => {
    vi.mocked(loadOrderCost).mockReset();
  });

  it('loads the decoded order id and shows an empty cost', async () => {
    vi.mocked(loadOrderCost).mockResolvedValue(empty);
    render(
      <MemoryRouter initialEntries={['/orders/order%201']}>
        <Routes>
          <Route path="/orders/:orderId" element={<OrderCostPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'تكلفة الطلب' }),
    ).toBeInTheDocument();
    expect(screen.getByText('لسه مفيش تكلفة محفوظة')).toBeInTheDocument();
    expect(loadOrderCost).toHaveBeenCalledWith('order 1');
  });

  it('says when the order is unknown', async () => {
    vi.mocked(loadOrderCost).mockResolvedValue({ ...empty, found: false });
    render(
      <MemoryRouter initialEntries={['/orders/missing']}>
        <Routes>
          <Route path="/orders/:orderId" element={<OrderCostPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('الطلب مش موجود')).toBeInTheDocument();
  });
});
