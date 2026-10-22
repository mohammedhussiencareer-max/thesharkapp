import { fireEvent, render, screen, within } from '@testing-library/react';
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

  it('keeps showing the pinned payload when the month and categories change', () => {
    const onMonthChange = vi.fn();
    const onSubmit = vi.fn<(draft: ExpenseDraft) => void>();
    const view = render(
      <ExpenseForm
        categories={categories}
        month="2026-10"
        disabled={false}
        serverError={null}
        onMonthChange={onMonthChange}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText('التصنيف'), {
      target: { value: 'rent' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByLabelText('ملاحظة'), {
      target: { value: 'ملاحظة مثبتة' },
    });
    fireEvent.change(screen.getByLabelText('تاريخ الدفع'), {
      target: { value: '2030-04-20' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'تقدير' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    const draft = onSubmit.mock.calls[0]?.[0];
    expect(draft).toMatchObject({
      periodMonth: '2026-10-01',
      amount: '1000.00',
      note: 'ملاحظة مثبتة',
      paidOn: '2030-04-20',
      isEstimate: true,
    });
    if (!draft) throw new Error('missing draft');

    view.rerender(
      <ExpenseForm
        categories={[
          { id: 'rent', name: 'إيجار جديد', kind: 'daily', active: false },
        ]}
        month="2030-05"
        disabled={false}
        serverError={null}
        pending={draft}
        onMonthChange={onMonthChange}
        onSubmit={onSubmit}
      />,
    );

    const form = screen.getByRole('form', { name: 'مصروف جديد' });
    expect(within(form).getByLabelText('شهر المصروف')).toHaveValue('2026-10');
    expect(within(form).getByLabelText('شهر المصروف')).toBeDisabled();
    expect(
      within(form).getByRole('option', { name: 'إيجار' }),
    ).toBeInTheDocument();
    expect(
      within(form).queryByRole('option', { name: 'إيجار جديد' }),
    ).not.toBeInTheDocument();
    expect(within(form).getByText('النوع: ثابت شهري')).toBeInTheDocument();
    expect(within(form).queryByLabelText('التاريخ')).not.toBeInTheDocument();
    expect(within(form).getByLabelText('المبلغ')).toHaveValue('1000.00');
    expect(within(form).getByLabelText('ملاحظة')).toHaveValue('ملاحظة مثبتة');
    expect(within(form).getByLabelText('تاريخ الدفع')).toHaveValue(
      '2030-04-20',
    );
    expect(within(form).getByRole('checkbox', { name: 'تقدير' })).toBeChecked();

    fireEvent.change(within(form).getByLabelText('شهر المصروف'), {
      target: { value: '1999-01' },
    });
    expect(within(form).getByLabelText('شهر المصروف')).toHaveValue('2026-10');
    expect(onMonthChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    expect(onSubmit.mock.calls[1]?.[0]).toBe(draft);
  });

  it('keeps the pinned date when the page month changes', () => {
    const onSubmit = vi.fn<(draft: ExpenseDraft) => void>();
    const view = render(
      <ExpenseForm
        categories={categories}
        month="2026-10"
        disabled={false}
        serverError={null}
        onMonthChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText('التصنيف'), {
      target: { value: 'gas' },
    });
    fireEvent.change(screen.getByLabelText('التاريخ'), {
      target: { value: '2026-10-15' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    const draft = onSubmit.mock.calls[0]?.[0];
    if (!draft) throw new Error('missing draft');

    view.rerender(
      <ExpenseForm
        categories={[
          { id: 'gas', name: 'غاز جديد', kind: 'fixed_monthly', active: true },
        ]}
        month="2030-05"
        disabled={false}
        serverError={null}
        pending={draft}
        onMonthChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const date = screen.getByLabelText('التاريخ');
    expect(date).toHaveValue('2026-10-15');
    expect(date).not.toHaveAttribute('min');
    expect(date).not.toHaveAttribute('max');
    expect(screen.getByLabelText('المبلغ')).toHaveValue('40.00');
    expect(screen.getByRole('option', { name: 'غاز' })).toBeInTheDocument();
    expect(screen.queryByLabelText('شهر المصروف')).not.toBeInTheDocument();
    expect(screen.getByText('النوع: يومي')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    expect(onSubmit.mock.calls[1]?.[0]).toBe(draft);
  });

  it('keeps the pinned driver fields when the category kind changes', () => {
    const onSubmit = vi.fn<(draft: ExpenseDraft) => void>();
    const view = render(
      <ExpenseForm
        categories={categories}
        month="2026-10"
        disabled={false}
        serverError={null}
        onMonthChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText('التصنيف'), {
      target: { value: 'driver' },
    });
    fireEvent.change(screen.getByLabelText('التاريخ'), {
      target: { value: '2026-10-15' },
    });
    fireEvent.change(screen.getByLabelText('الساعات'), {
      target: { value: '5.5' },
    });
    fireEvent.change(screen.getByLabelText('سعر الساعة'), {
      target: { value: '30' },
    });
    fireEvent.change(screen.getByLabelText('اسم الطيار'), {
      target: { value: 'طيار اختبار' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    const draft = onSubmit.mock.calls[0]?.[0];
    if (!draft) throw new Error('missing draft');

    view.rerender(
      <ExpenseForm
        categories={[
          { id: 'driver', name: 'طيار جديد', kind: 'daily', active: true },
        ]}
        month="2030-06"
        disabled={false}
        serverError={null}
        pending={draft}
        onMonthChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByLabelText('الساعات')).toHaveValue('5.50');
    expect(screen.getByLabelText('سعر الساعة')).toHaveValue('30.00');
    expect(screen.getByLabelText('اسم الطيار')).toHaveValue('طيار اختبار');
    expect(screen.getByLabelText('التاريخ')).toHaveValue('2026-10-15');
    expect(screen.getByLabelText('المبلغ')).toHaveTextContent('165.00 ج.م');
    expect(
      screen.getByRole('option', { name: 'أجر طيارين' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'طيار جديد' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'المبلغ' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    expect(onSubmit.mock.calls[1]?.[0]).toBe(draft);
  });
});
