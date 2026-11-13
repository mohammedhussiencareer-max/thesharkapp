import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOpeningReview } from '@/accounting/api';
import type { OpeningReview } from '@/accounting/types';
import { ActivationPage } from '@/pages/ActivationPage';

vi.mock('@/accounting/api', () => ({
  loadOpeningReview: vi.fn(),
}));

const review: OpeningReview = {
  activated: false,
  stockStartedAt: null,
  openingManifestHash: null,
  canActivate: true,
  checklist: [{ code: 'not_activated', ready: false, count: '0' }],
  roster: [],
  nextItemId: null,
};

describe('ActivationPage', () => {
  beforeEach(() => {
    vi.mocked(loadOpeningReview).mockReset();
  });

  it('shows the read-only review and no enable button', async () => {
    vi.mocked(loadOpeningReview).mockResolvedValue(review);
    render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: 'مراجعة التفعيل' }),
    ).toBeInTheDocument();
    expect(screen.getByText('الرصيد جاهز للتفعيل')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تفعيل الخصم' })).toBeNull();
  });
});
