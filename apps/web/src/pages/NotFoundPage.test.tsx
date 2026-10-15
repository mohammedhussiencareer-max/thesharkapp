import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '@/App';

describe('unknown route', () => {
  it('shows the 404 page', () => {
    render(
      <MemoryRouter initialEntries={['/missing']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '404' })).toBeInTheDocument();
    expect(screen.getByText('الصفحة غير موجودة')).toBeInTheDocument();
  });
});
