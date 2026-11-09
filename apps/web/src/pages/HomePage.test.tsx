import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { HomePage } from '@/pages/HomePage';

describe('HomePage', () => {
  it('shows the Arabic subtitle, the owner email, and signs out', () => {
    const onSignOut = vi.fn();
    render(
      <MemoryRouter>
        <HomePage email="owner@theshark.test" onSignOut={onSignOut} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', { name: 'The Shark' }),
    ).toBeInTheDocument();
    expect(screen.getByText('المخزون والمكسب اليومي')).toBeInTheDocument();
    expect(screen.getByText('owner@theshark.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'المبيعات' })).toHaveAttribute(
      'href',
      '/sales',
    );
    expect(screen.getByRole('link', { name: 'الأصناف' })).toHaveAttribute(
      'href',
      '/items',
    );
    expect(screen.getByRole('link', { name: 'الوصفات' })).toHaveAttribute(
      'href',
      '/recipes',
    );
    expect(screen.getByRole('link', { name: 'ربط الكاشير' })).toHaveAttribute(
      'href',
      '/mapping',
    );
    expect(screen.getByRole('link', { name: 'التغليف' })).toHaveAttribute(
      'href',
      '/packaging',
    );
    expect(
      screen.getByRole('link', { name: 'الرصيد الافتتاحي' }),
    ).toHaveAttribute('href', '/opening');
    expect(screen.getByRole('link', { name: 'المشتريات' })).toHaveAttribute(
      'href',
      '/purchases',
    );
    expect(screen.getByRole('link', { name: 'الفرز' })).toHaveAttribute(
      'href',
      '/sorting',
    );
    expect(screen.getByRole('link', { name: 'الجرد اليومي' })).toHaveAttribute(
      'href',
      '/counts',
    );
    expect(screen.getByRole('link', { name: 'المصاريف' })).toHaveAttribute(
      'href',
      '/expenses',
    );
    expect(
      screen.getByRole('link', { name: 'قرارات الطلبات' }),
    ).toHaveAttribute('href', '/order-decisions');

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
