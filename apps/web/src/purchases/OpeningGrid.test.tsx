import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpeningGrid } from '@/purchases/OpeningGrid';
import type { OpeningDraft, StockChoice } from '@/purchases/types';

const oil: StockChoice = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'kg',
  parentItemId: null,
  active: true,
  hasMovements: false,
  conversions: [{ unit: 'لتر', factorToBase: '0.92' }],
};

const mixed: StockChoice = {
  id: 'mixed',
  name: 'بوري',
  kind: 'fish_mixed',
  baseUnit: 'kg',
  parentItemId: null,
  active: true,
  hasMovements: false,
  conversions: [],
};

const size: StockChoice = {
  id: 'size',
  name: 'بوري كبير',
  kind: 'fish_size',
  baseUnit: 'kg',
  parentItemId: 'mixed',
  active: true,
  hasMovements: false,
  conversions: [],
};

describe('OpeningGrid', () => {
  it('groups items and posts the filled rows at the chosen Cairo time', () => {
    const onSubmit = vi.fn<(draft: OpeningDraft) => void>();
    render(
      <OpeningGrid
        items={[size, oil, mixed]}
        locked={false}
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'سمك مخلوط' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'مكونات' })).toBeInTheDocument();
    expect(
      screen.getByRole('article', { name: 'بوري كبير' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('وقت الرصيد'), {
      target: { value: '2026-07-15T12:00' },
    });
    fireEvent.change(screen.getByLabelText('كمية زيت'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText('كمية بوري'), {
      target: { value: '١٠' },
    });
    fireEvent.change(screen.getByLabelText('تكلفة بوري'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('وحدة زيت'), {
      target: { value: 'لتر' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    const submitted = onSubmit.mock.calls[0]?.[0];
    expect(submitted?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(submitted).toMatchObject({
      occurredAt: '2026-07-15T09:00:00.000Z',
      lines: [
        {
          itemId: 'mixed',
          quantity: '10',
          unit: 'kg',
          unitCost: '100',
          expectedBaseUnit: 'kg',
          expectedFactor: '1',
        },
      ],
    });
  });

  it('shows a field error and stays locked while the page is busy', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <OpeningGrid
        items={[oil]}
        locked={false}
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText('كمية زيت'), {
      target: { value: '-1' },
    });
    fireEvent.change(screen.getByLabelText('تكلفة زيت'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'الكمية لازم تكون رقم من صفر أو أكتر',
    );
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(
      <OpeningGrid
        items={[oil]}
        locked
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(screen.getByLabelText('كمية زيت')).toBeDisabled();
  });
});
