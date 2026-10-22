import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SortForm } from '@/sorting/SortForm';
import { notEnoughStockMessage, sizesExceedMessage } from '@/sorting/errors';
import type { MixedFish, SortDraft } from '@/sorting/types';

const mixed: MixedFish = {
  id: 'mixed',
  name: 'بوري مخلوط',
  onHandQty: '1000',
  onHandValue: '51234.57',
  avgCost: '51.234567',
  hasUncoveredDeficit: false,
  sizes: [
    { id: 'large', name: 'كبير' },
    { id: 'small', name: 'وسط' },
  ],
};

function renderForm(items: readonly MixedFish[] = [mixed], locked = false) {
  const onSubmit = vi.fn<(draft: SortDraft) => void>();
  render(
    <SortForm
      items={items}
      locked={locked}
      submitting={false}
      serverError={null}
      pending={null}
      onClearServerError={() => undefined}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

function chooseMixed() {
  fireEvent.change(screen.getByLabelText('السمك المخلوط'), {
    target: { value: 'mixed' },
  });
}

describe('SortForm', () => {
  it('previews an Arabic entry and submits exact strings with one request id', () => {
    const onSubmit = renderForm();
    chooseMixed();
    fireEvent.change(screen.getByLabelText('كمية المخلوط'), {
      target: { value: '١٠٠' },
    });
    fireEvent.change(screen.getByLabelText('كمية كبير'), {
      target: { value: '٦٠' },
    });
    fireEvent.change(screen.getByLabelText('كمية وسط'), {
      target: { value: '٣٨' },
    });

    const preview = screen.getByRole('region', { name: 'معاينة الفرز' });
    expect(preview).toHaveTextContent('الفاقد 2 كيلو');
    expect(preview).toHaveTextContent('102.47');
    expect(preview).toHaveTextContent('51.234567');
    expect(preview).toHaveTextContent('3074.08');
    expect(preview).toHaveTextContent('1946.91');

    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    const first = onSubmit.mock.calls[0]?.[0];
    const second = onSubmit.mock.calls[1]?.[0];
    expect(first?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(second?.requestId).toBe(first?.requestId);
    expect(first).toMatchObject({
      mixedItemId: 'mixed',
      qtyTaken: '100',
      note: null,
      lines: [
        { itemId: 'large', quantity: '60' },
        { itemId: 'small', quantity: '38' },
      ],
    });
  });

  it('does not save when the sizes exceed the taken quantity', () => {
    const onSubmit = renderForm();
    chooseMixed();
    fireEvent.change(screen.getByLabelText('كمية المخلوط'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('كمية كبير'), {
      target: { value: '70' },
    });
    fireEvent.change(screen.getByLabelText('كمية وسط'), {
      target: { value: '40' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(sizesExceedMessage);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not save when the take is above the balance', () => {
    const onSubmit = renderForm([{ ...mixed, onHandQty: '100' }]);
    chooseMixed();
    fireEvent.change(screen.getByLabelText('كمية المخلوط'), {
      target: { value: '101' },
    });
    fireEvent.change(screen.getByLabelText('كمية كبير'), {
      target: { value: '1' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(notEnoughStockMessage);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables saving while the page is locked', () => {
    const onSubmit = renderForm([mixed], true);
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
