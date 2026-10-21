import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExpenseForm } from '@/expenses/ExpenseForm';
import type { ExpenseCategory, ExpenseDraft } from '@/expenses/types';

const categories: ExpenseCategory[] = [
  { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
  { id: 'gas', name: 'غاز', kind: 'daily', active: true },
  { id: 'driver', name: 'أجر طيارين', kind: 'driver_hours', active: true },
];

function renderForm(onSubmit = vi.fn<(draft: ExpenseDraft) => void>()) {
  render(
    <ExpenseForm
      categories={categories}
      month="2030-04"
      disabled={false}
      serverError={null}
      onMonthChange={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

describe('ExpenseForm', () => {
  it('changes the fields with the category kind', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('التصنيف'), {
      target: { value: 'rent' },
    });
    expect(screen.getByLabelText('شهر المصروف')).toBeInTheDocument();
    expect(screen.queryByLabelText('التاريخ')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('التصنيف'), {
      target: { value: 'gas' },
    });
    expect(screen.getByLabelText('التاريخ')).toBeInTheDocument();
    expect(screen.queryByLabelText('شهر المصروف')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('الساعات')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('التصنيف'), {
      target: { value: 'driver' },
    });
    expect(screen.getByLabelText('الساعات')).toBeInTheDocument();
    expect(screen.getByLabelText('سعر الساعة')).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'المبلغ' }),
    ).not.toBeInTheDocument();
  });

  it('previews driver pay before saving', () => {
    const onSubmit = renderForm();
    fireEvent.change(screen.getByLabelText('التصنيف'), {
      target: { value: 'driver' },
    });
    fireEvent.change(screen.getByLabelText('الساعات'), {
      target: { value: '5.5' },
    });
    fireEvent.change(screen.getByLabelText('سعر الساعة'), {
      target: { value: '30' },
    });
    expect(screen.getByLabelText('المبلغ')).toHaveTextContent('165.00 ج.م');

    fireEvent.change(screen.getByLabelText('الساعات'), {
      target: { value: '١٫١٥' },
    });
    fireEvent.change(screen.getByLabelText('سعر الساعة'), {
      target: { value: '٠٫١٠' },
    });
    expect(screen.getByLabelText('المبلغ')).toHaveTextContent('0.12 ج.م');

    fireEvent.change(screen.getByLabelText('الساعات'), {
      target: { value: '٥٫٥' },
    });
    fireEvent.change(screen.getByLabelText('سعر الساعة'), {
      target: { value: '٣٠' },
    });
    fireEvent.change(screen.getByLabelText('التاريخ'), {
      target: { value: '2030-04-15' },
    });
    fireEvent.change(screen.getByLabelText('اسم الطيار'), {
      target: { value: 'طيار اختبار' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: '165.00',
        hours: '5.50',
        hourlyRate: '30.00',
        expenseDate: '2030-04-15',
        driverLabel: 'طيار اختبار',
        periodMonth: null,
      }),
    );
  });

  it('blocks a save that has no category', () => {
    const onSubmit = renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('اختار التصنيف');
  });
});
