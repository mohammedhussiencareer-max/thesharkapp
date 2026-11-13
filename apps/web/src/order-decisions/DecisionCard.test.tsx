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
import { setOrderDisposition } from '@/order-decisions/api';
import {
  notActivatedMessage,
  DecisionCard,
} from '@/order-decisions/DecisionCard';
import {
  reasonRequiredMessage,
  reloadFailedMessage,
} from '@/order-decisions/DecisionForm';
import { OrderChangedError } from '@/order-decisions/errors';
import { decisionSubject } from '@/order-decisions/format';
import { queueRow, zeroDifferences } from '@/order-decisions/test-fixtures';
import type {
  DecisionResult,
  DecisionWrite,
  QueueRow,
} from '@/order-decisions/types';

vi.mock('@/order-decisions/api', () => ({
  setOrderDisposition: vi.fn(),
}));

const saved: DecisionResult = {
  status: 'ok',
  orderId: 'order-1',
  eventId: 12,
  decision: 'not_made',
  decisionClass: 'canceled',
  outcome: 'posted',
  reason: 'not_made',
  differences: {
    stockQuantity: '-1.5',
    stockValue: '-75.00',
    cogs: '-75.00',
    waste: '0.00',
    profit: '75.00',
  },
};

const partial = (overrides: Partial<QueueRow> = {}) =>
  queueRow({
    currentClass: 'partial_refund',
    decidedClass: 'partial_refund',
    refundTotal: '45.00',
    refunds: [
      {
        shiftId: 's1',
        txId: 't1',
        amount: '45.00',
        occurredAt: '2030-01-15T10:00:00.000Z',
      },
    ],
    ...overrides,
  });

function renderCard(
  row: QueueRow,
  onChanged = vi.fn().mockResolvedValue(undefined),
) {
  const view = render(
    <MemoryRouter>
      <DecisionCard row={row} closed={false} onChanged={onChanged} />
    </MemoryRouter>,
  );
  return { onChanged, ...view };
}

function lastWrite(): DecisionWrite {
  const calls = vi.mocked(setOrderDisposition).mock.calls;
  const write = calls[calls.length - 1]?.[0];
  if (!write) throw new Error('no write was sent');
  return write;
}

function choose(name: string) {
  fireEvent.click(screen.getByRole('radio', { name }));
}

describe('DecisionCard', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(setOrderDisposition).mockReset();
  });

  it('shows the order, its class, source, basis, differences and history in Cairo time', () => {
    renderCard(
      queueRow({
        orderedAt: '2030-01-15T09:30:00.000Z',
        reviewReason: 'refund_changed',
        refundTotal: '10.00',
        history: [
          {
            eventId: 10,
            episode: 1,
            decision: 'made',
            decisionClass: 'canceled',
            source: 'system_default',
            ownerReviewed: false,
            reason: null,
            createdAt: '2030-01-15T09:45:00.000Z',
            returned: [],
            differences: zeroDifferences,
          },
        ],
      }),
    );
    const card = screen.getByRole('article', { name: 'طلب رقم 41' });
    expect(within(card).getByText('15/01/2030 11:30')).toBeInTheDocument();
    expect(
      within(card).getByText('ملغي — اتعمل (افتراضي من النظام)'),
    ).toBeInTheDocument();
    expect(within(card).getByRole('alert')).toHaveTextContent(
      'محتاج قرارك من جديد: المرتجعات اتغيّرت',
    );
    expect(within(card).getByText(/سمك تجريبي/)).toBeInTheDocument();
    expect(
      within(within(card).getByLabelText('الفروق الحالية')).getByText(
        'فرق الربح',
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText('سجل القرارات (1)')).toBeInTheDocument();
  });

  it('confirms an unchanged decision without a reason or returned quantities', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    const { onChanged } = renderCard(queueRow());
    expect(screen.queryByLabelText('سبب تغيير القرار')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('order-1'));
    expect(lastWrite()).toMatchObject({
      orderId: 'order-1',
      decision: 'made',
      token: 'token-1',
      reason: null,
      returned: null,
    });
    expect(hasAction(decisionSubject('order-1'))).toBe(false);
  });

  it('needs a reason to flip, then shows the exact resulting differences', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(queueRow());
    choose('ماتعملش');
    const submit = screen.getByRole('button', { name: 'حفظ القرار' });
    expect(submit).toBeDisabled();
    expect(screen.getByText(reasonRequiredMessage)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('سبب تغيير القرار'), {
      target: { value: '  اتلغى قبل التحضير  ' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    const result = await screen.findByRole('status');
    expect(lastWrite()).toMatchObject({
      decision: 'not_made',
      reason: 'اتلغى قبل التحضير',
      returned: null,
    });
    expect(
      within(result).getByText('اتسجل القرار: الطلب ماتعملش'),
    ).toBeInTheDocument();
    const differences = within(result).getByLabelText('الفروق الناتجة');
    expect(within(differences).getByText('-1.5')).toBeInTheDocument();
    expect(within(differences).getAllByText(/-75\.00/)).toHaveLength(2);
  });

  it('offers per-item returned quantities only for a not-made partial refund', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(partial());
    expect(screen.queryByText('الكميات المرتجعة')).toBeNull();
    choose('ماتعملش');
    const fish = screen.getByLabelText(/المرتجع من سمك تجريبي/);
    fireEvent.change(screen.getByLabelText('سبب تغيير القرار'), {
      target: { value: 'رجع نص الطبق' },
    });

    fireEvent.change(fish, { target: { value: '2' } });
    expect(
      screen.getByText('الكمية المرتجعة أكبر من المحضّر'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ القرار' })).toBeDisabled();

    fireEvent.change(fish, { target: { value: '0.50' } });
    expect(fish.closest('div')).toHaveTextContent('المحضّر 1.5 — المتبقي 1');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().returned).toEqual([
      { stockItemId: 'item-a', returned: '0.5' },
      { stockItemId: 'item-b', returned: '0' },
    ]);
  });

  it('sends explicit zero lines when nothing came back: a confirmed zero, not a cleared set', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(
      partial({
        decision: 'not_made',
        returned: [{ stockItemId: 'item-a', returned: '0.5' }],
      }),
    );
    expect(screen.getByLabelText(/المرتجع من سمك تجريبي/)).toHaveValue('0.5');
    fireEvent.change(screen.getByLabelText(/المرتجع من سمك تجريبي/), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().returned).toEqual([
      { stockItemId: 'item-a', returned: '0' },
      { stockItemId: 'item-b', returned: '0' },
    ]);
  });

  it('sends a confirmed zero for a first decision with every field left empty', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(partial());
    choose('ماتعملش');
    fireEvent.change(screen.getByLabelText('سبب تغيير القرار'), {
      target: { value: 'مفيش حاجة رجعت' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().returned).toEqual([
      { stockItemId: 'item-a', returned: '0' },
      { stockItemId: 'item-b', returned: '0' },
    ]);
  });

  it('clears the confirmed quantities only through the explicit control, with an empty list', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(
      partial({
        decision: 'not_made',
        returned: [{ stockItemId: 'item-a', returned: '0.5' }],
      }),
    );
    expect(
      screen.getByRole('checkbox', { name: 'امسح الكميات المرتجعة المؤكدة' }),
    ).not.toBeChecked();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'امسح الكميات المرتجعة المؤكدة' }),
    );
    expect(screen.getByLabelText(/المرتجع من سمك تجريبي/)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().returned).toEqual([]);
  });

  it('offers the retained returned quantities when a terminal order is made, and only then', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(
      queueRow({
        currentClass: 'full_refund',
        decidedClass: 'full_refund',
        decision: 'made',
        returned: [{ stockItemId: 'item-a', returned: '0.5' }],
      }),
    );
    expect(screen.getByLabelText(/المرتجع من سمك تجريبي/)).toHaveValue('0.5');
    expect(screen.getByText(/بيتسجل هالك/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/المرتجع من سمك تجريبي/), {
      target: { value: '0.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().returned).toEqual([
      { stockItemId: 'item-a', returned: '0.25' },
      { stockItemId: 'item-b', returned: '0' },
    ]);
  });

  it('does not offer returned quantities for a made terminal order that has none, and carries them', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(
      queueRow({ currentClass: 'full_refund', decidedClass: 'full_refund' }),
    );
    expect(screen.queryByLabelText(/المرتجع من/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().returned).toBeNull();
  });

  it('lets the owner clear a retained set that does not apply to the decision, and otherwise carries it', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(
      queueRow({
        currentClass: 'full_refund',
        decidedClass: 'full_refund',
        decision: 'not_made',
        returned: [{ stockItemId: 'item-a', returned: '0.5' }],
      }),
    );
    expect(screen.queryByLabelText(/المرتجع من/)).toBeNull();
    const clear = screen.getByRole('checkbox', {
      name: 'امسح الكميات المرتجعة المؤكدة',
    });
    expect(clear).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().returned).toBeNull();
  });

  it('sends an empty list when the retained set is cleared under a decision it does not apply to', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    renderCard(
      queueRow({
        currentClass: null,
        decidedClass: 'canceled',
        returned: [{ stockItemId: 'item-a', returned: '0.5' }],
      }),
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'امسح الكميات المرتجعة المؤكدة' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().returned).toEqual([]);
  });

  it('does not offer returned quantities without a ready preparation basis', () => {
    renderCard(partial({ basisStatus: 'incomplete' }));
    choose('ماتعملش');
    expect(screen.getByText(/مفيش أساس تحضير جاهز/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/المرتجع من/)).toBeNull();
  });

  it('only lets an order with no cancel or refund be confirmed as made', () => {
    renderCard(queueRow({ currentClass: null }));
    expect(screen.getByRole('radio', { name: 'ماتعملش' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'اتعمل' })).toBeEnabled();
  });

  it('locks a negative refund until the register fixes it', () => {
    renderCard(queueRow({ currentClass: 'unresolved_refund' }));
    expect(screen.getByRole('button', { name: 'تأكيد القرار' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'اتعمل' })).toBeDisabled();
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('مبلغ سالب');
  });

  it('retries an unknown save with the identical request id and payload', async () => {
    vi.mocked(setOrderDisposition)
      .mockRejectedValueOnce(new Error('socket'))
      .mockResolvedValueOnce(saved);
    const { onChanged } = renderCard(queueRow());
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تأكيد القرار' })).toBeDisabled();
    expect(onChanged).not.toHaveBeenCalled();
    const first = lastWrite();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(vi.mocked(setOrderDisposition)).toHaveBeenCalledTimes(2);
    expect(lastWrite()).toBe(first);
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
  });

  it('retires a stale refusal, reloads the row and starts the next attempt fresh', async () => {
    vi.mocked(setOrderDisposition)
      .mockRejectedValueOnce(new OrderChangedError())
      .mockResolvedValueOnce(saved);
    const { onChanged } = renderCard(queueRow());
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('الطلب اتغيّر');
    expect(onChanged).toHaveBeenCalledWith('order-1');
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(hasAction(decisionSubject('order-1'))).toBe(false);
    const stale = lastWrite();

    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    await screen.findByRole('status');
    expect(lastWrite().requestId).not.toBe(stale.requestId);
  });

  it('never settles a saved write by a failed reload', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue(saved);
    const onChanged = vi.fn().mockRejectedValue(new Error('offline'));
    renderCard(queueRow(), onChanged);
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    const result = await screen.findByRole('status');
    expect(within(result).getByText(reloadFailedMessage)).toBeInTheDocument();
    expect(screen.queryByText(unknownSaveMessage)).toBeNull();
    expect(hasAction(decisionSubject('order-1'))).toBe(false);
    expect(vi.mocked(setOrderDisposition)).toHaveBeenCalledTimes(1);
  });

  it('keeps one outstanding action per order while a save is in flight', async () => {
    let release: (value: DecisionResult) => void = () => undefined;
    vi.mocked(setOrderDisposition).mockImplementation(
      () =>
        new Promise<DecisionResult>((resolve) => {
          release = resolve;
        }),
    );
    renderCard(queueRow());
    const submit = screen.getByRole('button', { name: 'تأكيد القرار' });
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());
    fireEvent.click(submit);
    expect(vi.mocked(setOrderDisposition)).toHaveBeenCalledTimes(1);
    release(saved);
    await screen.findByRole('status');
  });

  it('says nothing was stored before the discount switch is on', async () => {
    vi.mocked(setOrderDisposition).mockResolvedValue({
      status: 'not_activated',
    });
    const { onChanged } = renderCard(queueRow());
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد القرار' }));
    expect(await screen.findByText(notActivatedMessage)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows no form once the episode has closed', () => {
    render(
      <MemoryRouter>
        <DecisionCard
          row={queueRow()}
          closed
          onChanged={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByText('الطلب ده مبقاش محتاج قرار')).toBeInTheDocument();
  });
});
