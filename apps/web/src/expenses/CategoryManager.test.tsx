import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CategoryManager } from '@/expenses/CategoryManager';
import type { ExpenseCategory } from '@/expenses/types';

const rent: ExpenseCategory = {
  id: 'rent',
  name: 'إيجار',
  kind: 'fixed_monthly',
  active: true,
};

describe('CategoryManager', () => {
  it('shows the Arabic reason when a category rename is empty', () => {
    const onRename = vi.fn();
    render(
      <CategoryManager
        categories={[rent]}
        disabled={false}
        serverError={null}
        onAdd={() => Promise.resolve(true)}
        onRename={onRename}
        onSetActive={() => undefined}
      />,
    );

    const name = screen.getByLabelText('اسم إيجار');
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ اسم إيجار' }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('اكتب اسم التصنيف');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAttribute('aria-describedby', alert.id);
    expect(onRename).not.toHaveBeenCalled();
  });

  it('keeps the new category fields when the save is refused', async () => {
    let resolveAdd: (saved: boolean) => void = () => {};
    const onAdd = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    render(
      <CategoryManager
        categories={[rent]}
        disabled={false}
        serverError={null}
        onAdd={onAdd}
        onRename={() => undefined}
        onSetActive={() => undefined}
      />,
    );

    const name = screen.getByLabelText('اسم التصنيف');
    const kind = screen.getByLabelText('نوع التصنيف');
    fireEvent.change(name, { target: { value: 'إيجار' } });
    fireEvent.change(kind, { target: { value: 'daily' } });
    fireEvent.submit(name.closest('form')!);

    expect(onAdd).toHaveBeenCalledWith('إيجار', 'daily');
    resolveAdd(false);
    await waitFor(() => expect(name).toHaveValue('إيجار'));
    expect(kind).toHaveValue('daily');
  });

  it('clears the new category fields after a confirmed save', async () => {
    render(
      <CategoryManager
        categories={[rent]}
        disabled={false}
        serverError={null}
        onAdd={() => Promise.resolve(true)}
        onRename={() => undefined}
        onSetActive={() => undefined}
      />,
    );

    const name = screen.getByLabelText('اسم التصنيف');
    const kind = screen.getByLabelText('نوع التصنيف');
    fireEvent.change(name, { target: { value: 'كهربا' } });
    fireEvent.change(kind, { target: { value: 'fixed_monthly' } });
    fireEvent.submit(name.closest('form')!);

    await waitFor(() => expect(name).toHaveValue(''));
    expect(kind).toHaveValue('');
  });
});
