import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHeldWrites } from '@/items/request-id';
import { AuthContext } from '@/lib/auth-context';
import {
  claimFreshHeldWrite,
  hasAnyHeldWrite,
  resetHeldWritesStore,
  setHeldWriteUser,
} from '@/lib/held-writes';
import {
  applyPwaUpdate,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import {
  loadQueuePage,
  loadQueueRow,
  loadUnlinkedRefunds,
} from '@/order-decisions/api';
import { queueRow } from '@/order-decisions/test-fixtures';
import { OrderDecisionsPage } from '@/pages/OrderDecisionsPage';
import { UpdateBanner } from '@/pwa/UpdateBanner';

vi.mock('@/order-decisions/api', () => ({
  loadQueuePage: vi.fn(),
  loadQueueRow: vi.fn(),
  loadUnlinkedRefunds: vi.fn(),
  setOrderDisposition: vi.fn(),
}));

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

function installMockLocks() {
  const held = new Set<string>();
  const locks = {
    async request<T>(
      name: string,
      options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
      callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
    ): Promise<T> {
      if (options.ifAvailable && held.has(name)) {
        return await callback(null);
      }
      held.add(name);
      try {
        return await callback({ name, mode: options.mode ?? 'exclusive' });
      } finally {
        held.delete(name);
      }
    },
    query: () => Promise.resolve({ held: [...held].map((name) => ({ name })) }),
  };
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: locks,
  });
  return { held };
}

describe('P7-3 round-6 review fixes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    setOnline(true);
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true });
    setHeldWriteUser('owner-1');
    resetPwaState();
    setPwaAuthResolved(true);
    installMockLocks();

    vi.mocked(loadUnlinkedRefunds).mockResolvedValue([]);
    vi.mocked(loadQueueRow).mockResolvedValue(null);
  });

  afterEach(() => {
    resetHeldWritesStore({ clearStorage: true });
    resetPwaState();
    localStorage.clear();
    setOnline(true);
  });

  it('R6-3b: UpdateBanner stays disabled after sign-out while a live claim lock is held and re-enables only after release (still requiring click)', async () => {
    const reload = vi.fn();
    const postMessage = vi.fn();
    setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

    const claim = await claimFreshHeldWrite('purchase:new', (requestId) => ({
      requestId,
    }));
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    render(
      <AuthContext.Provider
        value={{
          status: 'signed-out',
          email: null,
          signIn: vi.fn().mockResolvedValue('ok'),
          signOut: vi.fn().mockResolvedValue(undefined),
          retry: vi.fn(),
        }}
      >
        <UpdateBanner onReload={reload} />
      </AuthContext.Provider>,
    );
    const updateBtn = screen.getByRole('button', { name: 'تحديث التطبيق' });
    expect(updateBtn).toBeDisabled();

    // Simulate sign-out clearing pins while the dispatched RPC still holds its lock.
    act(() => {
      setHeldWriteUser(null);
    });

    // Update guard MUST still block reload while live claim lock is held!
    expect(hasAnyHeldWrite()).toBe(true);
    expect(updateBtn).toBeDisabled();
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    // Releasing the last live claim notifies the update banner to re-enable, WITHOUT auto-reloading.
    act(() => {
      claim.release();
    });
    await waitFor(() => {
      expect(updateBtn).toBeEnabled();
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    // Explicit owner click now triggers the update.
    fireEvent.click(updateBtn);
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('R6-4: OrderDecisionsPage preserves drafted order state when earlier orders enter while offline and push it past loaded pages', async () => {
    const order0a = queueRow({
      orderId: 'order-0a',
      orderNumber: 100,
      token: 'tok-0a',
      eventId: 1,
    });
    const order0b = queueRow({
      orderId: 'order-0b',
      orderNumber: 101,
      token: 'tok-0b',
      eventId: 1,
    });
    const order1 = queueRow({
      orderId: 'order-1',
      orderNumber: 102,
      token: 'tok-1',
      eventId: 1,
    });
    const order2 = queueRow({
      orderId: 'order-2',
      orderNumber: 103,
      token: 'tok-2',
      eventId: 1,
    });

    vi.mocked(loadQueuePage)
      // Initial load: page 1 -> order-1, page 2 -> order-2
      .mockResolvedValueOnce({ rows: [order1], next: 'cursor-2' })
      .mockResolvedValueOnce({ rows: [order2], next: null })
      // Reconnect after 2 earlier orders arrived: page 1 -> order-0a, page 2 -> order-0b (order-2 moved to page 3!)
      .mockResolvedValueOnce({ rows: [order0a], next: 'cursor-0b' })
      .mockResolvedValueOnce({ rows: [order0b], next: 'cursor-1' });

    render(
      <MemoryRouter>
        <OrderDecisionsPage />
      </MemoryRouter>,
    );

    await screen.findByRole('article', { name: 'طلب رقم 102' });
    fireEvent.click(screen.getByRole('button', { name: 'عرض المزيد' }));
    const card2 = await screen.findByRole('article', { name: 'طلب رقم 103' });

    // Owner drafts a change on order-2.
    fireEvent.click(within(card2).getByLabelText('ماتعملش'));
    fireEvent.change(within(card2).getByLabelText('سبب تغيير القرار'), {
      target: { value: 'اتلغى قبل الطبخ' },
    });

    // Go offline then reconnect while earlier orders pushed order-2 past pages 1..2.
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    await screen.findByRole('article', { name: 'طلب رقم 100' });
    await screen.findByRole('article', { name: 'طلب رقم 101' });

    // order-2's card and draft MUST survive the pagination shift!
    const keptCard2 = screen.getByRole('article', { name: 'طلب رقم 103' });
    expect(within(keptCard2).getByLabelText('سبب تغيير القرار')).toHaveValue(
      'اتلغى قبل الطبخ',
    );
    expect(within(keptCard2).getByLabelText('ماتعملش')).toBeChecked();
  });
});
