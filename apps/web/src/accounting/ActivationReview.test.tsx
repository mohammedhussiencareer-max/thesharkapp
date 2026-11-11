import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { activationAction } from '@/accounting/activation-action';
import { ActivationReview } from '@/accounting/ActivationReview';
import type { OpeningReview } from '@/accounting/types';

const itemA = 'a7800000-0000-4000-8000-0000000000a1';
const itemB = 'a7800000-0000-4000-8000-0000000000a2';

function review(patch: Partial<OpeningReview> = {}): OpeningReview {
  return {
    activated: false,
    stockStartedAt: null,
    openingManifestHash: null,
    canActivate: false,
    checklist: [
      { code: 'not_activated', ready: false, count: '0' },
      { code: 'missing_observations', ready: false, count: '1' },
      { code: 'unreceipted_outflows', ready: true, count: '0' },
      { code: 'empty_roster', ready: true, count: '2' },
    ],
    roster: [
      {
        itemId: itemA,
        name: 'سمك',
        baseUnit: 'kg',
        active: true,
        missing: false,
        openingLineCount: '2',
        observation: {
          openingId: itemA,
          lineNo: '1',
          quantity: '4.5',
          unit: 'kg',
          unitCost: '10.5',
          occurredAt: '2026-01-01T00:00:00.000Z',
          explicitZero: false,
        },
      },
      {
        itemId: itemB,
        name: 'جمبري',
        baseUnit: 'kg',
        active: true,
        missing: true,
        openingLineCount: '0',
        observation: null,
      },
    ],
    nextItemId: null,
    ...patch,
  };
}

describe('ActivationReview', () => {
  it('shows the roster, including a missing observation and a repeat', () => {
    render(<ActivationReview review={review()} />);
    expect(
      screen.getByText('مفيش رصد — الصفر لازم يتسجل صراحة'),
    ).toBeInTheDocument();
    expect(screen.getByText('اتسجل 2 مرات')).toBeInTheDocument();
    expect(screen.getByText('4.5')).toBeInTheDocument();
    expect(
      screen.getByText('التفعيل لسه ما اتسجلش — ناقص'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تفعيل الخصم' })).toBeNull();
  });

  it('shows readiness without an enable button', () => {
    const ready = review({ canActivate: true, roster: [] });
    render(<ActivationReview review={ready} />);
    expect(screen.getByText('الرصيد جاهز للتفعيل')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تفعيل الخصم' })).toBeNull();
    expect(activationAction(ready)).toBeNull();
  });
});
