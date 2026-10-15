import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HomePage } from '@/pages/HomePage';

describe('HomePage', () => {
  it('shows the Arabic subtitle', () => {
    render(<HomePage />);

    expect(
      screen.getByRole('heading', { name: 'The Shark' }),
    ).toBeInTheDocument();
    expect(screen.getByText('المخزون والمكسب اليومي')).toBeInTheDocument();
  });
});
