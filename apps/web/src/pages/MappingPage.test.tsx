import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHeldWrites, unknownSaveMessage } from '@/items/request-id';
import {
  loadBases,
  loadCatalog,
  loadCoverage,
  loadSubjectDetail,
  setBaseMapping,
} from '@/mapping/api';
import type {
  Coverage,
  MappingCatalog,
  ObservedBase,
  SubjectDetail,
} from '@/mapping/types';
import { MappingPage } from '@/pages/MappingPage';

vi.mock('@/mapping/api', () => ({
  loadBases: vi.fn(),
  loadCatalog: vi.fn(),
  loadCoverage: vi.fn(),
  loadSubjectDetail: vi.fn(),
  setBaseMapping: vi.fn(),
  setOptionPolicy: vi.fn(),
  setException: vi.fn(),
  setOptionMapping: vi.fn(),
}));

function observed(
  name: string,
  status: ObservedBase['mapStatus'],
): ObservedBase {
  return {
    posItemId: name,
    sizeKey: ['none'],
    sizeKeyText: '["none"]',
    itemName: name,
    saleCount: 2,
    lastOrderedAt: '2030-06-01T08:00:00.000Z',
    latestOrderId: `order-${name}`,
    latestLineId: `line-${name}`,
    mapStatus: status,
  };
}

const catalog: MappingCatalog = {
  recipes: [{ id: 'recipe-1', name: 'طبق تجريبي', kind: 'dish' }],
  items: [{ id: 'item-1', name: 'ملح تجريبي', baseUnit: 'kg' }],
  units: [{ code: 'kg', label: 'كيلو' }],
  shiftStart: null,
};

const detail: SubjectDetail = {
  schedule: {
    subjectId: null,
    token: 'token-1',
    emptyToken: 'token-1',
    versions: [],
  },
  options: [],
  optionBindings: [],
  suggestions: [{ recipeId: 'recipe-1', name: 'طبق تجريبي', via: 'name' }],
  history: [],
  optionHistory: [],
  resolution: {
    status: 'incomplete',
    issues: [{ code: 'unmapped_base', expandIssue: null }],
    requirements: [],
  },
};

function coverage(partial: Partial<Coverage> = {}): Coverage {
  return {
    stockStart: '2030-01-01T00:00:00.000Z',
    eligibleLines: 0,
    coveredLines: 0,
    readyLines: 0,
    incompleteLines: 0,
    exceptionLines: 0,
    coverage: null,
    causes: { canceled: 1, open: 0, missing: 0, beforeStockStart: 0 },
    ...partial,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MappingPage />
    </MemoryRouter>,
  );
}

describe('MappingPage', () => {
  beforeEach(() => {
    resetHeldWrites();
    vi.mocked(loadBases).mockReset();
    vi.mocked(loadCatalog).mockReset();
    vi.mocked(loadCoverage).mockReset();
    vi.mocked(loadSubjectDetail).mockReset();
    vi.mocked(setBaseMapping).mockReset();
    vi.mocked(loadBases).mockResolvedValue([
      observed('صنف جاهز', 'ready'),
      observed('صنف ناقص', 'incomplete'),
    ]);
    vi.mocked(loadCatalog).mockResolvedValue(catalog);
    vi.mocked(loadCoverage).mockResolvedValue(coverage());
    vi.mocked(loadSubjectDetail).mockResolvedValue(detail);
  });

  it('lists unmapped subjects first and shows an empty coverage as a dash', async () => {
    renderPage();
    const rows = await screen.findAllByRole('button', { name: /عملية/ });
    expect(rows[0]).toHaveTextContent('صنف ناقص');
    expect(rows[0]).toHaveTextContent('ناقص');
    expect(rows[1]).toHaveTextContent('جاهز');
    expect(screen.getByText('المغطى —')).toBeInTheDocument();
    expect(screen.getByText(/ملغي 1/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/جنيه|EGP|ج\.م/);
  });

  it('shows covered lines over eligible lines', async () => {
    vi.mocked(loadCoverage).mockResolvedValue(
      coverage({
        eligibleLines: 4,
        coveredLines: 3,
        readyLines: 2,
        exceptionLines: 1,
        incompleteLines: 1,
        coverage: 0.75,
      }),
    );
    renderPage();
    expect(await screen.findByText('المغطى 3 من 4')).toBeInTheDocument();
  });

  it('retries the same mapping payload after an unknown save', async () => {
    vi.mocked(setBaseMapping)
      .mockRejectedValueOnce(new Error('socket'))
      .mockResolvedValueOnce(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /صنف ناقص/ }));
    expect(
      await screen.findByRole('form', { name: 'ربط الصنف' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(vi.mocked(setBaseMapping)).toHaveBeenCalledTimes(2);
    });
    const first = vi.mocked(setBaseMapping).mock.calls[0]?.[0];
    const second = vi.mocked(setBaseMapping).mock.calls[1]?.[0];
    expect(first?.requestId).toBe(second?.requestId);
    expect(first?.token).toBe('token-1');
    expect(first?.target).toEqual({
      kind: 'stock',
      stockItemId: 'item-1',
      quantity: '1',
      unit: 'kg',
    });
    expect(await screen.findByText('الربط اتحفظ')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/جنيه|EGP|ج\.م/);
  });
});
