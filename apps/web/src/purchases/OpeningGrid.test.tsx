import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpeningGrid } from '@/purchases/OpeningGrid';
import { cairoDateTimeLocalToIso } from '@/purchases/time';
import { unitLookupErrorMessage } from '@/purchases/units-at';
import type { OpeningDraft, StockChoice } from '@/purchases/types';
import { unitUnavailableMessage } from '@/purchases/validation';

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

  it('refreshes the opening unit when the balance time changes', async () => {
    const onSubmit = vi.fn<(draft: OpeningDraft) => void>();
    const july = cairoDateTimeLocalToIso('2026-07-15T12:00');
    const january = cairoDateTimeLocalToIso('2020-01-15T10:00');
    if (july === null || january === null) {
      throw new Error('cairo time did not parse');
    }
    const resolveUnits = vi.fn((_ids: readonly string[], at: string) =>
      Promise.resolve({
        oil: [
          {
            unit: 'liter',
            factorToBase: at === january ? '0.5' : '0.92',
            label: 'لتر',
          },
        ],
      }),
    );
    render(
      <OpeningGrid
        items={[oil]}
        locked={false}
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
        resolveUnits={resolveUnits}
      />,
    );

    fireEvent.change(screen.getByLabelText('وقت الرصيد'), {
      target: { value: '2026-07-15T12:00' },
    });
    await waitFor(() => {
      expect(resolveUnits).toHaveBeenCalledWith(['oil'], july);
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'لتر' })).toHaveValue('liter');
    });
    fireEvent.change(screen.getByLabelText('وحدة زيت'), {
      target: { value: 'liter' },
    });
    fireEvent.change(screen.getByLabelText('كمية زيت'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('تكلفة زيت'), {
      target: { value: '50' },
    });
    expect(screen.getByText('1 لتر = 0.92 كيلو')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('وقت الرصيد'), {
      target: { value: '2020-01-15T10:00' },
    });
    await waitFor(() => {
      expect(resolveUnits).toHaveBeenCalledWith(['oil'], january);
    });
    expect(await screen.findByText('1 لتر = 0.5 كيلو')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      occurredAt: january,
      lines: [
        expect.objectContaining({
          itemId: 'oil',
          unit: 'liter',
          expectedFactor: '0.5',
        }),
      ],
    });
  });

  it('looks up units at the current minute the opening will submit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:37.000Z'));
    try {
      const minute = '2026-07-15T09:00:00.000Z';
      const resolveUnits = vi.fn(() =>
        Promise.resolve({
          oil: [{ unit: 'liter', factorToBase: '0.92', label: 'لتر' }],
        }),
      );
      const onSubmit = vi.fn<(draft: OpeningDraft) => void>();
      const view = render(
        <OpeningGrid
          items={[oil]}
          locked={false}
          submitting={false}
          serverError={null}
          onClearServerError={vi.fn()}
          onSubmit={onSubmit}
          resolveUnits={resolveUnits}
        />,
      );

      await waitFor(() => {
        expect(resolveUnits).toHaveBeenCalledWith(['oil'], minute);
      });
      expect(screen.getByLabelText('وقت الرصيد')).toHaveValue(
        '2026-07-15T12:00',
      );
      expect(resolveUnits).not.toHaveBeenCalledWith(
        ['oil'],
        '2026-07-15T09:00:37.000Z',
      );

      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'لتر' })).toHaveValue(
          'liter',
        );
      });
      fireEvent.change(screen.getByLabelText('وحدة زيت'), {
        target: { value: 'liter' },
      });
      fireEvent.change(screen.getByLabelText('كمية زيت'), {
        target: { value: '2' },
      });
      fireEvent.change(screen.getByLabelText('تكلفة زيت'), {
        target: { value: '50' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
      expect(onSubmit.mock.calls[0]?.[0].occurredAt).toBe(minute);

      view.unmount();
      vi.setSystemTime(new Date('2026-07-15T09:01:10.000Z'));
      render(
        <OpeningGrid
          items={[oil]}
          locked={false}
          submitting={false}
          serverError={null}
          onClearServerError={vi.fn()}
          onSubmit={vi.fn()}
          resolveUnits={resolveUnits}
        />,
      );
      await waitFor(() => {
        expect(resolveUnits).toHaveBeenCalledWith(
          ['oil'],
          '2026-07-15T09:01:00.000Z',
        );
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('keeps a selected unit and blocks save when a later lookup fails', async () => {
    const july = cairoDateTimeLocalToIso('2026-07-15T12:00');
    const january = cairoDateTimeLocalToIso('2020-01-15T10:00');
    if (july === null || january === null) {
      throw new Error('cairo time did not parse');
    }
    let failJanuary = true;
    const carton = {
      unit: 'carton',
      factorToBase: '12',
      label: 'كرتونة',
    };
    const resolveUnits = vi.fn((_ids: readonly string[], at: string) =>
      at === january && failJanuary
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ oil: [carton] }),
    );
    const onSubmit = vi.fn<(draft: OpeningDraft) => void>();
    render(
      <OpeningGrid
        items={[oil]}
        locked={false}
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
        resolveUnits={resolveUnits}
      />,
    );

    fireEvent.change(screen.getByLabelText('وقت الرصيد'), {
      target: { value: '2026-07-15T12:00' },
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'كرتونة' })).toHaveValue(
        'carton',
      );
    });
    fireEvent.change(screen.getByLabelText('وحدة زيت'), {
      target: { value: 'carton' },
    });
    fireEvent.change(screen.getByLabelText('كمية زيت'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('تكلفة زيت'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('وقت الرصيد'), {
      target: { value: '2020-01-15T10:00' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      unitLookupErrorMessage,
    );
    expect(screen.getByLabelText('وحدة زيت')).toHaveValue('carton');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    failJanuary = false;
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
    });
    expect(screen.getByLabelText('وحدة زيت')).toHaveValue('carton');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(onSubmit.mock.calls[0]?.[0].lines[0]).toMatchObject({
      quantity: '2',
      unit: 'carton',
      expectedFactor: '12',
    });
  });

  it('blocks save when the selected unit is gone at the new time', async () => {
    const july = cairoDateTimeLocalToIso('2026-07-15T12:00');
    const january = cairoDateTimeLocalToIso('2020-01-15T10:00');
    if (july === null || january === null) {
      throw new Error('cairo time did not parse');
    }
    const resolveUnits = vi.fn((_ids: readonly string[], at: string) =>
      Promise.resolve({
        oil:
          at === january
            ? []
            : [{ unit: 'carton', factorToBase: '12', label: 'كرتونة' }],
      }),
    );
    const onSubmit = vi.fn<(draft: OpeningDraft) => void>();
    render(
      <OpeningGrid
        items={[oil]}
        locked={false}
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
        resolveUnits={resolveUnits}
      />,
    );

    fireEvent.change(screen.getByLabelText('وقت الرصيد'), {
      target: { value: '2026-07-15T12:00' },
    });
    await waitFor(() => {
      expect(resolveUnits).toHaveBeenCalledWith(['oil'], july);
    });
    fireEvent.change(screen.getByLabelText('وحدة زيت'), {
      target: { value: 'carton' },
    });
    fireEvent.change(screen.getByLabelText('كمية زيت'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('تكلفة زيت'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByLabelText('وقت الرصيد'), {
      target: { value: '2020-01-15T10:00' },
    });

    expect(await screen.findByText(unitUnavailableMessage)).toBeInTheDocument();
    expect(screen.getByLabelText('وحدة زيت')).toHaveValue('carton');
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('وحدة زيت'), {
      target: { value: 'kg' },
    });
    expect(screen.queryByText(unitUnavailableMessage)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(onSubmit.mock.calls[0]?.[0].lines[0]).toMatchObject({
      quantity: '2',
      unit: 'kg',
      expectedFactor: '1',
    });
  });
});
