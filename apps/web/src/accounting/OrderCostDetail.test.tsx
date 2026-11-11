import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrderCostDetail } from '@/accounting/OrderCostDetail';
import type { OrderCostDetail as Detail } from '@/accounting/types';

const itemA = 'a7800000-0000-4000-8000-0000000000a1';

function detail(patch: Partial<Detail> = {}): Detail {
  return {
    found: true,
    orderId: 'o-cost',
    orderNumber: '9001',
    input: {
      inputId: '4',
      inputRevision: '2',
      snapshotId: '3',
      snapshotVersion: '3',
      missingFromPos: false,
      digest: 'abc',
    },
    state: {
      disposition: 'sale',
      latestApplicationId: '9',
      ownerApplicationId: '9',
      causes: ['missing_cost_basis'],
    },
    applications: [
      {
        id: '9',
        receiptKind: 'posting',
        disposition: 'sale',
        costInputId: '4',
        inputRevision: '2',
        snapshotId: '3',
        snapshotVersion: '3',
        predecessorId: null,
        retiredApplicationId: null,
        movementOwnerId: '9',
        occurredAt: '2026-02-01T00:00:00.000Z',
        shiftId: 'shift-read',
        algorithmVersion: '1',
        signature: 'abc',
        createdAt: '2026-02-01T00:00:00.000Z',
        lines: [
          { itemId: itemA, name: 'سمك', baseUnit: 'kg', quantity: '4.5' },
        ],
        posted: [
          {
            movementId: '1',
            itemId: itemA,
            name: 'سمك',
            movementType: 'sale',
            quantity: '-2.5',
            totalCost: '-26.25',
            occurredAt: '2026-02-01T00:00:00.000Z',
          },
        ],
        provenance: {
          mappingVersions: [],
          recipeVersions: [],
          packagingVersions: [],
          lossVersions: [{ itemId: itemA, versionId: itemA, lossPct: '0.1' }],
          conversionVersions: [],
          algorithmVersion: '1',
        },
        reversals: [
          {
            movementId: '3',
            itemId: itemA,
            name: 'سمك',
            movementType: 'sale_reversal',
            quantity: '2.5',
            totalCost: '27.75',
            reversesMovementId: '1',
          },
        ],
        adjustments: [
          {
            movementId: '2',
            itemId: itemA,
            name: 'سمك',
            quantity: '0',
            totalCost: '-1.50',
            adjustsMovementId: '1',
          },
        ],
      },
    ],
    ...patch,
  };
}

describe('OrderCostDetail', () => {
  it('shows the applied input, state, quantities, provenance, reversals, and adjustments', () => {
    render(<OrderCostDetail detail={detail()} />);
    expect(screen.getByText(/طلب رقم/)).toBeInTheDocument();
    expect(screen.getByText('9001')).toBeInTheDocument();
    expect(screen.getByText(/الحالة الحالية:/)).toHaveTextContent('بيع');
    expect(screen.getByText('سعر التكلفة ناقص')).toBeInTheDocument();
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(screen.getByText('0.1')).toBeInTheDocument();
    expect(
      screen.getByText(/-26\.25 ج\.م/, { selector: 'li' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/27\.75 ج\.م/, { selector: 'li' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/-1\.50 ج\.م/, { selector: 'li' }),
    ).toBeInTheDocument();
    expect(screen.getByText('العكس')).toBeInTheDocument();
    expect(screen.getByText('تعديلات القيمة')).toBeInTheDocument();
    expect(screen.getByText('نسخ الربط')).toBeInTheDocument();
  });

  it('says when the order or its cost is missing', () => {
    const { rerender } = render(
      <OrderCostDetail detail={detail({ found: false, applications: [] })} />,
    );
    expect(screen.getByText('الطلب مش موجود')).toBeInTheDocument();
    rerender(
      <OrderCostDetail
        detail={detail({ applications: [], state: null, input: null })}
      />,
    );
    expect(screen.getByText('لسه مفيش تكلفة محفوظة')).toBeInTheDocument();
  });
});
