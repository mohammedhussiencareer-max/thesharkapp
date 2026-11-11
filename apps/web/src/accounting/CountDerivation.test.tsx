import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCountDerivation } from '@/accounting/api';
import { CountDerivation } from '@/accounting/CountDerivation';
import type { CountDerivation as Detail } from '@/accounting/types';
import { historySurplusWarning } from '@/counts/errors';

vi.mock('@/accounting/api', () => ({
  loadCountDerivation: vi.fn(),
}));

const itemA = 'a7800000-0000-4000-8000-0000000000a1';
const batch = 'a7800000-0000-4000-8000-0000000000b1';

const detail: Detail = {
  found: true,
  countId: 'count-1',
  countedAt: '2026-01-02T00:00:00.000Z',
  frequency: 'daily',
  note: null,
  hasSurplus: true,
  waitingForSync: true,
  waitingForProcessing: true,
  lines: [
    {
      lineNo: '1',
      itemId: itemA,
      name: 'سمك',
      baseUnit: 'kg',
      countedQty: '8',
      originalExpectedQty: '8',
      originalDeltaQty: '0',
      originalDeltaValue: '0.00',
      latestExpectedQty: '6',
      latestRequiredQty: '2',
      latestRequiredValue: '21.50',
      compensatorQty: '2',
      compensatorValue: '21.50',
      originalSurplus: false,
      derivedSurplus: true,
      derivations: [
        {
          id: '1',
          expectedQty: '6',
          requiredQty: '2',
          requiredValue: '21.50',
          causeBatchId: batch,
          predecessorId: null,
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      postings: [
        {
          movementId: '9',
          role: 'adjustment',
          movementType: 'cost_adjustment',
          quantity: '0',
          totalCost: '0.50',
          occurredAt: '2026-01-02T00:00:00.000Z',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ],
    },
  ],
};

describe('CountDerivation', () => {
  beforeEach(() => {
    vi.mocked(loadCountDerivation).mockReset();
  });

  it('loads the original observation, settlement, and compensation on click', async () => {
    vi.mocked(loadCountDerivation).mockResolvedValue(detail);
    render(<CountDerivation countId="count-1" />);
    expect(loadCountDerivation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'تفاصيل الاشتقاق' }));
    expect(await screen.findByText('الرصد الأصلي')).toBeInTheDocument();
    expect(screen.getByText('مستني مزامنة تغطي الجرد')).toBeInTheDocument();
    expect(screen.getByText('مستني معالجة الخصم')).toBeInTheDocument();
    expect(screen.getAllByText(historySurplusWarning).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/تعديل قيمة/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        (_content, node) =>
          node?.children.length === 0 &&
          (node.textContent ?? '').includes('21.50 ج.م'),
      ).length,
    ).toBeGreaterThan(0);
    expect(loadCountDerivation).toHaveBeenCalledWith('count-1');
  });

  function withSettlement(
    source: Detail,
    patch: {
      latestExpectedQty: string;
      compensatorQty: string;
      historyExpectedQty: string;
      waitingForProcessing: boolean;
    },
  ): Detail {
    const line = source.lines[0];
    if (!line) throw new Error('the fixture has no line');
    const history = line.derivations[0];
    if (!history) throw new Error('the fixture has no derivation');
    return {
      ...source,
      waitingForProcessing: patch.waitingForProcessing,
      lines: [
        {
          ...line,
          latestExpectedQty: patch.latestExpectedQty,
          compensatorQty: patch.compensatorQty,
          derivations: [{ ...history, expectedQty: patch.historyExpectedQty }],
        },
      ],
    };
  }

  it('reloads the settlement when a refresh arrives and when reopened', async () => {
    const compensated = withSettlement(detail, {
      latestExpectedQty: '4.5',
      compensatorQty: '7',
      historyExpectedQty: '3.25',
      waitingForProcessing: false,
    });
    const reopened = withSettlement(detail, {
      latestExpectedQty: '1.25',
      compensatorQty: '9',
      historyExpectedQty: '0.75',
      waitingForProcessing: false,
    });
    vi.mocked(loadCountDerivation)
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce(compensated)
      .mockResolvedValueOnce(reopened);
    const view = render(<CountDerivation countId="count-1" refreshKey={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'تفاصيل الاشتقاق' }));
    expect(await screen.findAllByText('6')).toHaveLength(2);
    expect(screen.getByText('مستني معالجة الخصم')).toBeInTheDocument();

    view.rerender(<CountDerivation countId="count-1" refreshKey={1} />);
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByText('3.25')).toBeInTheDocument();
    expect(screen.queryAllByText('6')).toHaveLength(0);
    expect(screen.queryByText('مستني معالجة الخصم')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'تفاصيل الاشتقاق' }));
    view.rerender(<CountDerivation countId="count-1" refreshKey={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'تفاصيل الاشتقاق' }));
    expect(await screen.findByText('9')).toBeInTheDocument();
    expect(screen.getByText('1.25')).toBeInTheDocument();
    expect(screen.getByText('0.75')).toBeInTheDocument();
    expect(screen.queryByText('7')).toBeNull();
    expect(screen.queryByText('4.5')).toBeNull();
    expect(loadCountDerivation).toHaveBeenCalledTimes(3);
  });

  it('shows a load failure as an alert', async () => {
    vi.mocked(loadCountDerivation).mockRejectedValue(
      new Error('حصل خطأ. حاول تاني.'),
    );
    render(<CountDerivation countId="count-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'تفاصيل الاشتقاق' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'حصل خطأ. حاول تاني.',
    );
  });
});
