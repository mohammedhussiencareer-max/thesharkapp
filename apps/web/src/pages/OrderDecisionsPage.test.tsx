import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasAction,
  resetHeldWrites,
  unknownSaveMessage,
} from '@/items/request-id';
import {
  loadQueuePage,
  loadQueueRow,
  loadUnlinkedRefunds,
  setOrderDisposition,
} from '@/order-decisions/api';
import { decisionSubject } from '@/order-decisions/format';
import { queueRow } from '@/order-decisions/test-fixtures';
import { OrderDecisionsPage } from '@/pages/OrderDecisionsPage';

vi.mock('@/order-decisions/api', () => ({
  loadQueuePage: vi.fn(),
  loadQueueRow: vi.fn(),
  loadUnlinkedRefunds: vi.fn(),
  setOrderDisposition: vi.fn(),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <OrderDecisionsPage />
    </MemoryRouter>,
  );
}

describe('OrderDecisionsPage', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(loadQueuePage).mockReset();
    vi.mocked(loadQueueRow).mockReset();
    vi.mocked(loadUnlinkedRefunds).mockReset();
    vi.mocked(setOrderDisposition).mockReset();
    vi.mocked(loadUnlinkedRefunds).mockResolvedValue([]);
  });

  it('shows the empty state and the way back home', async () => {
    vi.mocked(loadQueuePage).mockResolvedValue({ rows: [], next: null });
    renderPage();
    expect(
      await screen.findByText('مفيش طلبات محتاجة قرار'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'الرئيسية' })).toHaveAttribute(
      'href',
      '/',
    );
    expect(loadQueuePage).toHaveBeenCalledWith('pending', null);
    expect(
      await screen.findByText('مفيش مرتجعات من غير طلب'),
    ).toBeInTheDocument();
  });

  it('shows a load error and retries', async () => {
    vi.mocked(loadQueuePage)
      .mockRejectedValueOnce(new Error('حصل خطأ. حاول تاني.'))
      .mockResolvedValueOnce({ rows: [queueRow()], next: null });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('حصل خطأ');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByRole('article', { name: 'طلب رقم 41' }),
    ).toBeInTheDocument();
  });

  it('switches filters and pages by the last order id', async () => {
    vi.mocked(loadQueuePage)
      .mockResolvedValueOnce({
        rows: [queueRow({ orderId: 'order-1', orderNumber: 1 })],
        next: 'order-1',
      })
      .mockResolvedValueOnce({
        rows: [
          queueRow({ orderId: 'order-1', orderNumber: 1 }),
          queueRow({ orderId: 'order-2', orderNumber: 2 }),
        ],
        next: null,
      });
    renderPage();
    await screen.findByRole('article', { name: 'طلب رقم 1' });
    fireEvent.click(screen.getByRole('button', { name: 'عرض المزيد' }));
    await screen.findByRole('article', { name: 'طلب رقم 2' });
    expect(loadQueuePage).toHaveBeenLastCalledWith('pending', 'order-1');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'عرض المزيد' })).toBeNull();

    vi.mocked(loadQueuePage).mockResolvedValueOnce({ rows: [], next: null });
    fireEvent.click(screen.getByRole('button', { name: 'كل الطلبات' }));
    await waitFor(() =>
      expect(loadQueuePage).toHaveBeenLastCalledWith('all', null),
    );
    expect(
      await screen.findByText('مفيش طلبات ملغية أو مرتجعة'),
    ).toBeInTheDocument();
  });

  it('keeps a decided order on screen with its result until the next refresh', async () => {
    vi.mocked(loadQueuePage).mockResolvedValue({
      rows: [queueRow()],
      next: null,
    });
    vi.mocked(setOrderDisposition).mockResolvedValue({
      status: 'ok',
      orderId: 'order-1',
      eventId: 12,
      decision: 'made',
      decisionClass: 'canceled',
      outcome: 'unchanged',
      reason: null,
      differences: {
        stockQuantity: '0',
        stockValue: '0.00',
        cogs: '0.00',
        waste: '0.00',
        profit: '0.00',
      },
    });
    vi.mocked(loadQueueRow).mockResolvedValue(
      queueRow({
        token: 'token-2',
        eventId: 12,
        source: 'owner',
        ownerReviewed: true,
        needsDecision: false,
      }),
    );
    renderPage();
    await screen.findByRole('article', { name: 'طلب رقم 41' });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'ومفيش تغيير في المخزون',
    );
    expect(screen.getByText(/قرارك/)).toBeInTheDocument();
    expect(loadQueueRow).toHaveBeenCalledWith('order-1');
  });

  it('marks an order whose episode closed and keeps its history', async () => {
    vi.mocked(loadQueuePage).mockResolvedValue({
      rows: [queueRow()],
      next: null,
    });
    vi.mocked(setOrderDisposition).mockResolvedValue({
      status: 'ok',
      orderId: 'order-1',
      eventId: 12,
      decision: 'made',
      decisionClass: 'none',
      outcome: 'unchanged',
      reason: null,
      differences: {
        stockQuantity: '0',
        stockValue: '0.00',
        cogs: '0.00',
        waste: '0.00',
        profit: '0.00',
      },
    });
    vi.mocked(loadQueueRow).mockResolvedValue(null);
    renderPage();
    await screen.findByRole('article', { name: 'طلب رقم 41' });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    expect(
      await screen.findByText('الطلب ده مبقاش محتاج قرار'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('keeps the identical-retry control for a lost closing decision after a refresh', async () => {
    vi.mocked(loadQueuePage).mockResolvedValueOnce({
      rows: [queueRow()],
      next: null,
    });
    vi.mocked(setOrderDisposition).mockRejectedValueOnce(new Error('socket'));
    renderPage();
    await screen.findByRole('article', { name: 'طلب رقم 41' });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    const first = vi.mocked(setOrderDisposition).mock.calls[0]?.[0];

    // The closing decision was stored, so neither queue filter lists the order.
    vi.mocked(loadQueuePage).mockResolvedValueOnce({ rows: [], next: null });
    fireEvent.click(screen.getByRole('button', { name: 'تحديث' }));
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'طلب رقم 41' })).toBeNull(),
    );
    expect(
      await screen.findByText('مفيش طلبات محتاجة قرار'),
    ).toBeInTheDocument();
    const section = screen.getByRole('region', {
      name: 'قرارات مش متأكد إنها اتسجلت',
    });
    expect(within(section).getByText(/order-1/)).toBeInTheDocument();

    vi.mocked(loadQueuePage).mockResolvedValueOnce({ rows: [], next: null });
    fireEvent.click(screen.getByRole('button', { name: 'كل الطلبات' }));
    await screen.findByText('مفيش طلبات ملغية أو مرتجعة');
    expect(
      screen.getByRole('region', { name: 'قرارات مش متأكد إنها اتسجلت' }),
    ).toBeInTheDocument();

    vi.mocked(setOrderDisposition).mockResolvedValueOnce({
      status: 'ok',
      orderId: 'order-1',
      eventId: 12,
      decision: 'made',
      decisionClass: 'none',
      outcome: 'posted',
      reason: null,
      differences: {
        stockQuantity: '-1',
        stockValue: '-50.00',
        cogs: '50.00',
        waste: '0.00',
        profit: '-50.00',
      },
    });
    vi.mocked(loadQueuePage).mockResolvedValueOnce({ rows: [], next: null });
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(
      await screen.findByLabelText('نتيجة إعادة المحاولة لطلب order-1'),
    ).toHaveTextContent('اتسجل القرار');
    expect(vi.mocked(setOrderDisposition)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setOrderDisposition).mock.calls[1]?.[0]).toBe(first);
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'قرارات مش متأكد إنها اتسجلت' }),
      ).toBeNull(),
    );
    expect(hasAction(decisionSubject('order-1'))).toBe(false);
  });

  it('shows the retry control once, on the card, while the order is still listed', async () => {
    vi.mocked(loadQueuePage).mockResolvedValue({
      rows: [queueRow()],
      next: null,
    });
    vi.mocked(setOrderDisposition).mockRejectedValueOnce(new Error('socket'));
    renderPage();
    await screen.findByRole('article', { name: 'طلب رقم 41' });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await screen.findByText(unknownSaveMessage);
    expect(
      screen.getAllByRole('button', { name: 'إعادة المحاولة' }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole('region', { name: 'قرارات مش متأكد إنها اتسجلت' }),
    ).toBeNull();
  });

  it('lists refunds that no order owns', async () => {
    vi.mocked(loadQueuePage).mockResolvedValue({ rows: [], next: null });
    vi.mocked(loadUnlinkedRefunds).mockResolvedValue([
      {
        shiftId: 's1',
        txId: 't1',
        amount: '12.50',
        occurredAt: '2030-01-15T09:30:00.000Z',
      },
    ]);
    renderPage();
    expect(await screen.findByText(/15\/01\/2030 11:30/)).toBeInTheDocument();
    expect(screen.getByText(/12\.50/)).toBeInTheDocument();
  });
});
