import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomePage } from '@/pages/HomePage';

describe('HomePage', () => {
  it('shows the Arabic subtitle, the owner email, and signs out', () => {
    const onSignOut = vi.fn();
    render(<HomePage email="owner@theshark.test" onSignOut={onSignOut} />);

    expect(
      screen.getByRole('heading', { name: 'The Shark' }),
    ).toBeInTheDocument();
    expect(screen.getByText('المخزون والمكسب اليومي')).toBeInTheDocument();
    expect(screen.getByText('owner@theshark.test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
