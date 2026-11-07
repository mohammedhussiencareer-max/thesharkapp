import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHeldWrites } from '@/items/request-id';
import { loadCoverage } from '@/mapping/api';
import type { Coverage } from '@/mapping/types';
import {
  loadObservedOrderTypes,
  loadOrderTypePackaging,
  loadPackagingCatalog,
  setOrderTypePackaging,
} from '@/packaging/api';
import type { PackagingCatalog, PackagingDetail } from '@/packaging/types';
import { PackagingPage } from '@/pages/PackagingPage';

vi.mock('@/packaging/api', () => ({
  loadObservedOrderTypes: vi.fn(),
  loadOrderTypePackaging: vi.fn(),
  loadPackagingCatalog: vi.fn(),
  setOrderTypePackaging: vi.fn(),
}));

vi.mock('@/mapping/api', () => ({
  loadCoverage: vi.fn(),
}));

const catalog: PackagingCatalog = {
  items: [{ id: 'box-1', name: 'علبة تجريبية', baseUnit: 'piece' }],
  units: [{ code: 'piece', label: 'قطعة' }],
  shiftStart: null,
};

const detail: PackagingDetail = {
  schedule: {
    subjectId: null,
    token: 'pack-token',
    emptyToken: 'pack-token',
    versions: [],
  },
  history: [],
};

function coverage(): Coverage {
  return {
    stockStart: '2030-01-01T00:00:00.000Z',
    eligibleLines: 1,
    coveredLines: 1,
    readyLines: 1,
    incompleteLines: 0,
    exceptionLines: 0,
    coverage: 1,
    causes: { canceled: 0, open: 0, missing: 0, beforeStockStart: 0 },
    orders: {
      eligible: 1,
      ready: 0,
      incomplete: 1,
      coverage: 0,
      causes: { line: 0, packagingUnreviewed: 1, blocked: 0 },
      excluded: { canceled: 0, open: 0, missing: 0, beforeStockStart: 0 },
    },
    orderTypes: [
      {
        key: '["type","hall"]',
        label: 'hall',
        seen: 1,
        eligible: 1,
        covered: 0,
        unreviewed: 1,
        blocked: 0,
        coverage: 0,
      },
    ],
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PackagingPage />
    </MemoryRouter>,
  );
}

describe('PackagingPage', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(loadObservedOrderTypes).mockReset();
    vi.mocked(loadOrderTypePackaging).mockReset();
    vi.mocked(loadPackagingCatalog).mockReset();
    vi.mocked(setOrderTypePackaging).mockReset();
    vi.mocked(loadCoverage).mockReset();
    vi.mocked(loadObservedOrderTypes).mockResolvedValue([
      {
        key: '["type","hall"]',
        keyText: '["type", "hall"]',
        label: 'hall',
        orderCount: 1,
        lastOrderedAt: '2030-06-01T12:00:00.000Z',
      },
    ]);
    vi.mocked(loadPackagingCatalog).mockResolvedValue(catalog);
    vi.mocked(loadCoverage).mockResolvedValue(coverage());
    vi.mocked(loadOrderTypePackaging).mockResolvedValue(detail);
  });

  it('shows order coverage and an unreviewed type', async () => {
    renderPage();
    expect(await screen.findByText('تغطية الطلبات 0 من 1')).toBeInTheDocument();
    expect(screen.getByText(/تغليف مش متراجع 1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hall/ })).toHaveTextContent(
      '0 من 1',
    );
    expect(document.body.textContent).not.toMatch(/جنيه|EGP|ج\.م/);
  });

  it('retries the same packaging payload after an unknown save', async () => {
    vi.mocked(setOrderTypePackaging)
      .mockRejectedValueOnce(new Error('socket'))
      .mockResolvedValueOnce(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /hall/ }));
    const form = await screen.findByRole('form', { name: 'تغليف نوع الطلب' });
    fireEvent.change(within(form).getByLabelText('القرار'), {
      target: { value: 'none' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التغليف' }));
    expect(
      await screen.findByText('آخر حفظ مش متأكد إنه اتسجل'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('التغليف اتحفظ')).toBeInTheDocument();
    expect(vi.mocked(setOrderTypePackaging)).toHaveBeenCalledTimes(2);
    const first = vi.mocked(setOrderTypePackaging).mock.calls[0]?.[0];
    const second = vi.mocked(setOrderTypePackaging).mock.calls[1]?.[0];
    expect(second?.requestId).toBe(first?.requestId);
    expect(second?.policy).toEqual({ none: true });
    expect(second?.token).toBe('pack-token');
  });
});
