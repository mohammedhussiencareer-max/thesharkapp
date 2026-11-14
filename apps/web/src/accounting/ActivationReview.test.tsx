import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { showActivationButton } from '@/accounting/activation-action';
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

  it('shows readiness without an enable button when the roster is empty', () => {
    const ready = review({ canActivate: true, roster: [] });
    render(<ActivationReview review={ready} showActivate={false} />);
    expect(screen.getByText('الرصيد جاهز للتفعيل')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تفعيل الخصم' })).toBeNull();
    expect(showActivationButton(ready)).toBe(false);
  });

  it('shows a stored explicit zero and enables activation once it is checked', () => {
    const onActivate = vi.fn();
    const stored = review({
      roster: [
        {
          itemId: itemA,
          name: 'سمك',
          baseUnit: 'kg',
          active: true,
          missing: false,
          openingLineCount: '0',
          observation: {
            openingId: null,
            lineNo: null,
            quantity: '0',
            unit: 'كجم',
            unitCost: '0',
            occurredAt: '2026-03-01T08:00:00.000Z',
            explicitZero: true,
          },
        },
        review().roster[1]!,
      ],
    });
    const { rerender } = render(
      <ActivationReview
        review={stored}
        showActivate
        activateDisabled
        onToggleZero={() => undefined}
        onActivate={onActivate}
      />,
    );
    expect(screen.getByText('رصيد صفر مسجّل')).toBeInTheDocument();
    expect(
      screen.getByText('مفيش رصد — الصفر لازم يتسجل صراحة'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تفعيل الخصم' })).toBeDisabled();
    rerender(
      <ActivationReview
        review={stored}
        showActivate
        checkedZeroIds={new Set([itemB])}
        activateDisabled={false}
        onToggleZero={() => undefined}
        onActivate={onActivate}
      />,
    );
    expect(screen.getByRole('button', { name: 'تفعيل الخصم' })).toBeEnabled();
    expect(showActivationButton(stored)).toBe(true);
  });
});
