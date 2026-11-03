import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { backDatedMessage } from '@/purchases/errors';
import { PurchaseForm } from '@/purchases/PurchaseForm';
import { cairoDateTimeLocalToIso } from '@/purchases/time';
import { unitLookupErrorMessage } from '@/purchases/units-at';
import type { PurchaseDraft, StockChoice } from '@/purchases/types';
import { unitUnavailableMessage } from '@/purchases/validation';

const oil: StockChoice = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'kg',
  parentItemId: null,
  active: true,
  hasMovements: true,
  conversions: [{ unit: 'لتر', factorToBase: '0.92' }],
};

describe('PurchaseForm', () => {
  it('shows the derived unit cost, confirms, then submits exact strings', () => {
    const onSubmit = vi.fn<(draft: PurchaseDraft) => void>();
    render(
      <PurchaseForm
        items={[oil]}
        locked={false}
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('وقت الشراء'), {
      target: { value: '2026-07-15T12:00' },
    });
    fireEvent.change(screen.getByLabelText('المورد'), {
      target: { value: 'مورد' },
    });
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'oil' },
    });
    fireEvent.change(screen.getByLabelText('الكمية'), {
      target: { value: '٢' },
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'لتر' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '٥٠' },
    });

    expect(screen.getByText('تكلفة كيلو: 27.173913 ج.م')).toBeInTheDocument();
    expect(screen.getByText('1 لتر = 0.92 كيلو')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    expect(
      screen.getByText('المشتريات نهائية لحد ما نضيف التعديل'),
    ).toBeInTheDocument();
    expect(screen.getByText(/27\.173913 ج\.م/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'رجوع' }));
    expect(screen.getByLabelText('الكمية')).toHaveValue('٢');

    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    const submitted = onSubmit.mock.calls[0]?.[0];
    expect(submitted?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(submitted).toMatchObject({
      purchasedAt: '2026-07-15T09:00:00.000Z',
      supplier: 'مورد',
      invoiceNo: null,
      note: null,
      lines: [
        {
          itemId: 'oil',
          itemName: 'زيت',
          quantity: '2',
          unit: 'لتر',
          amountPaid: '50.00',
          baseUnit: 'kg',
          baseQuantity: '1.84',
          unitCost: '27.173913',
          expectedFactor: '0.92',
        },
      ],
    });
  }, 15_000);

  it('shows the back-dated message and keeps the form locked', () => {
    render(
      <PurchaseForm
        items={[oil]}
        locked
        submitting={false}
        serverError={backDatedMessage('زيت')}
        onClearServerError={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'مينفعش تسجّل حركة لـ زيت بتاريخ أقدم من آخر حركة ليه — التعديل بأثر رجعي جاي في مرحلة لاحقة',
    );
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeDisabled();
  });

  it('reloads the unit factor when the purchase time changes', async () => {
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
      <PurchaseForm
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
      expect(resolveUnits).toHaveBeenCalled();
    });
    fireEvent.change(screen.getByLabelText('وقت الشراء'), {
      target: { value: '2026-07-15T12:00' },
    });
    await waitFor(() => {
      expect(resolveUnits).toHaveBeenCalledWith(['oil'], july);
    });
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'oil' },
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'لتر' })).toHaveValue('liter');
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'liter' },
    });
    fireEvent.change(screen.getByLabelText('الكمية'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '50' },
    });
    expect(screen.getByText('تكلفة كيلو: 27.173913 ج.م')).toBeInTheDocument();
    expect(screen.getByText('1 لتر = 0.92 كيلو')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('وقت الشراء'), {
      target: { value: '2020-01-15T10:00' },
    });
    await waitFor(() => {
      expect(resolveUnits).toHaveBeenCalledWith(['oil'], january);
    });
    expect(await screen.findByText('تكلفة كيلو: 50 ج.م')).toBeInTheDocument();
    expect(screen.getByText('1 لتر = 0.5 كيلو')).toBeInTheDocument();
    expect(screen.getByLabelText('الوحدة')).toHaveValue('liter');
  });

  it('looks up units at the current minute the purchase will submit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T09:00:37.000Z'));
    try {
      const minute = '2026-07-15T09:00:00.000Z';
      const resolveUnits = vi.fn(() =>
        Promise.resolve({
          oil: [{ unit: 'liter', factorToBase: '0.92', label: 'لتر' }],
        }),
      );
      const onSubmit = vi.fn<(draft: PurchaseDraft) => void>();
      const view = render(
        <PurchaseForm
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
      expect(screen.getByLabelText('وقت الشراء')).toHaveValue(
        '2026-07-15T12:00',
      );
      expect(resolveUnits).not.toHaveBeenCalledWith(
        ['oil'],
        '2026-07-15T09:00:37.000Z',
      );

      fireEvent.change(screen.getByLabelText('الصنف'), {
        target: { value: 'oil' },
      });
      fireEvent.change(screen.getByLabelText('الكمية'), {
        target: { value: '2' },
      });
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'لتر' })).toHaveValue(
          'liter',
        );
      });
      fireEvent.change(screen.getByLabelText('الوحدة'), {
        target: { value: 'liter' },
      });
      fireEvent.change(screen.getByLabelText('المبلغ'), {
        target: { value: '50' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
      expect(onSubmit.mock.calls[0]?.[0].purchasedAt).toBe(minute);

      view.unmount();
      vi.setSystemTime(new Date('2026-07-15T09:01:10.000Z'));
      render(
        <PurchaseForm
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

  it('keeps a selected unit and blocks review when a later lookup fails', async () => {
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
    const onSubmit = vi.fn<(draft: PurchaseDraft) => void>();
    render(
      <PurchaseForm
        items={[oil]}
        locked={false}
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
        resolveUnits={resolveUnits}
      />,
    );

    fireEvent.change(screen.getByLabelText('وقت الشراء'), {
      target: { value: '2026-07-15T12:00' },
    });
    await waitFor(() => {
      expect(resolveUnits).toHaveBeenCalledWith(['oil'], july);
    });
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'oil' },
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'كرتونة' })).toHaveValue(
        'carton',
      );
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'carton' },
    });
    fireEvent.change(screen.getByLabelText('الكمية'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '24' },
    });

    fireEvent.change(screen.getByLabelText('وقت الشراء'), {
      target: { value: '2020-01-15T10:00' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      unitLookupErrorMessage,
    );
    expect(screen.getByLabelText('الوحدة')).toHaveValue('carton');
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    failJanuary = false;
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'مراجعة' })).toBeEnabled();
    });
    expect(screen.getByLabelText('الوحدة')).toHaveValue('carton');
    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(onSubmit.mock.calls[0]?.[0].lines[0]).toMatchObject({
      quantity: '2',
      unit: 'carton',
      baseQuantity: '24',
      expectedFactor: '12',
    });
  });

  it('blocks review when the selected unit is gone at the new time', async () => {
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
    const onSubmit = vi.fn<(draft: PurchaseDraft) => void>();
    render(
      <PurchaseForm
        items={[oil]}
        locked={false}
        submitting={false}
        serverError={null}
        onClearServerError={vi.fn()}
        onSubmit={onSubmit}
        resolveUnits={resolveUnits}
      />,
    );

    fireEvent.change(screen.getByLabelText('وقت الشراء'), {
      target: { value: '2026-07-15T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'oil' },
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'كرتونة' })).toHaveValue(
        'carton',
      );
    });
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'carton' },
    });
    fireEvent.change(screen.getByLabelText('الكمية'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '24' },
    });
    fireEvent.change(screen.getByLabelText('وقت الشراء'), {
      target: { value: '2020-01-15T10:00' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      unitUnavailableMessage,
    );
    expect(screen.getByLabelText('الوحدة')).toHaveValue('carton');
    expect(screen.getByRole('button', { name: 'مراجعة' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'kg' },
    });
    expect(screen.queryByText(unitUnavailableMessage)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(onSubmit.mock.calls[0]?.[0].lines[0]).toMatchObject({
      quantity: '2',
      unit: 'kg',
      baseQuantity: '2',
      expectedFactor: '1',
    });
  });
});
