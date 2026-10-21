import { fireEvent, render, screen } from '@testing-library/react';
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
        onAdd={() => undefined}
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
});
