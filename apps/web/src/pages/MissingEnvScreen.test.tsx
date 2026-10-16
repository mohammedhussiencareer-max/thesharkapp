import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MissingEnvScreen } from '@/pages/MissingEnvScreen';

describe('MissingEnvScreen', () => {
  it('explains that the connection settings are missing', () => {
    render(<MissingEnvScreen />);

    expect(
      screen.getByRole('heading', { name: 'The Shark' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'التطبيق مش قادر يشتغل لأن إعدادات الاتصال ناقصة.',
    );
  });
});
