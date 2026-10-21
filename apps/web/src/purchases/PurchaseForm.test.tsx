import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { backDatedMessage } from '@/purchases/errors';
import { PurchaseForm } from '@/purchases/PurchaseForm';
import type { StockChoice } from '@/purchases/types';

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
    const onSubmit = vi.fn();
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
    expect(onSubmit).toHaveBeenCalledWith({
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
});
