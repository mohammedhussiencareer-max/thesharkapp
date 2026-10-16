import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/App';

vi.mock('@/lib/supabase', () => ({
  supabase: null,
  readSupabaseEnv: () => null,
}));

describe('App without Supabase env', () => {
  it('shows the Arabic configuration error instead of the app', () => {
    render(<App />);

    expect(
      screen.getByText('التطبيق مش قادر يشتغل لأن إعدادات الاتصال ناقصة.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تسجيل الخروج' })).toBeNull();
  });
});
