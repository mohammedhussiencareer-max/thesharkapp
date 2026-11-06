import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHeldWrites, unknownSaveMessage } from '@/items/request-id';
import {
  loadBases,
  loadCatalog,
  loadCoverage,
  loadSubjectDetail,
  setBaseMapping,
  setOptionMapping,
} from '@/mapping/api';
import { sourceChangedMessage } from '@/mapping/labels';
import type {
  Coverage,
  MappingCatalog,
  ObservedBase,
  ScheduleVersion,
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
  items: [
    { id: 'item-1', name: 'ملح تجريبي', baseUnit: 'kg' },
    { id: 'item-2', name: 'فلفل تجريبي', baseUnit: 'kg' },
  ],
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
    vi.mocked(setOptionMapping).mockReset();
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

  function stockVersion(
    id: string,
    from: string,
    to: string | null,
    itemId: string,
    quantity: string,
  ): ScheduleVersion {
    return {
      id,
      family: 'mapping',
      effectiveFrom: from,
      effectiveTo: to,
      targetKind: 'stock',
      recipeId: null,
      stockItemId: itemId,
      quantityPerBasis: quantity,
      unitCode: 'kg',
      exceptionReason: null,
      optionPolicy: null,
    };
  }

  const versionA = stockVersion(
    'ver-a',
    '2000-01-01T00:00:00.000Z',
    '2090-01-01T00:00:00.000Z',
    'item-1',
    '1',
  );
  const versionB = stockVersion(
    'ver-b',
    '2090-01-01T00:00:00.000Z',
    null,
    'item-2',
    '2',
  );

  function crossIntoLaterVersion(form: HTMLElement) {
    fireEvent.change(within(form).getByLabelText('الكمية'), {
      target: { value: '9' },
    });
    fireEvent.change(within(form).getByLabelText('وقت السريان'), {
      target: { value: 'custom' },
    });
    fireEvent.change(within(form).getByLabelText('الوقت'), {
      target: { value: '2090-06-01T12:00' },
    });
  }

  it('resets base fields when the effective version changes', async () => {
    vi.mocked(loadSubjectDetail).mockResolvedValue({
      ...detail,
      schedule: {
        subjectId: 'sub-1',
        token: 'token-1',
        emptyToken: 'empty',
        versions: [versionA, versionB],
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /صنف ناقص/ }));
    const form = await screen.findByRole('form', { name: 'ربط الصنف' });
    crossIntoLaterVersion(form);
    fireEvent.click(within(form).getByRole('button', { name: 'احفظ الربط' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      sourceChangedMessage,
    );
    expect(vi.mocked(setBaseMapping)).not.toHaveBeenCalled();
    expect(within(form).getByLabelText('الكمية')).toHaveValue('2');
    expect(within(form).getByLabelText('الصنف')).toHaveValue('item-2');
    fireEvent.click(within(form).getByRole('button', { name: 'احفظ الربط' }));
    await waitFor(() => {
      expect(vi.mocked(setBaseMapping)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(setBaseMapping).mock.calls[0]?.[0]?.target).toEqual({
      kind: 'stock',
      stockItemId: 'item-2',
      quantity: '2',
      unit: 'kg',
    });
  });

  it('resets option fields when the effective version changes', async () => {
    vi.mocked(loadSubjectDetail).mockResolvedValue({
      ...detail,
      options: [
        {
          posItemId: 'صنف ناقص',
          sizeKeyText: '["none"]',
          optionValue: 'مشوي',
          seenCount: 1,
        },
      ],
      optionBindings: [
        {
          scope: 'global',
          optionValue: 'مشوي',
          schedule: {
            subjectId: 'opt-1',
            token: 'opt-token',
            emptyToken: 'opt-empty',
            versions: [versionA, versionB],
          },
        },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /صنف ناقص/ }));
    const form = await screen.findByRole('form', {
      name: 'ربط الاختيار العام مشوي',
    });
    crossIntoLaterVersion(form);
    fireEvent.click(
      within(form).getByRole('button', { name: 'احفظ ربط الاختيار' }),
    );
    expect(within(form).getByRole('alert')).toHaveTextContent(
      sourceChangedMessage,
    );
    expect(vi.mocked(setOptionMapping)).not.toHaveBeenCalled();
    expect(within(form).getByLabelText('الكمية')).toHaveValue('2');
    expect(within(form).getByLabelText('الصنف')).toHaveValue('item-2');
    fireEvent.click(
      within(form).getByRole('button', { name: 'احفظ ربط الاختيار' }),
    );
    await waitFor(() => {
      expect(vi.mocked(setOptionMapping)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(setOptionMapping).mock.calls[0]?.[0]?.target).toEqual({
      kind: 'stock',
      stockItemId: 'item-2',
      quantity: '2',
      unit: 'kg',
    });
  });

  it('discards a detail reload after another subject is selected', async () => {
    const pending: Array<(value: SubjectDetail) => void> = [];
    let opened = false;
    const detailReady: SubjectDetail = {
      ...detail,
      resolution: {
        status: 'ready',
        issues: [],
        requirements: [
          { stockItemId: 'item-1', baseUnit: 'kg', quantity: '9.5' },
        ],
      },
    };
    vi.mocked(setBaseMapping).mockResolvedValue(undefined);
    vi.mocked(loadSubjectDetail).mockImplementation((base) => {
      if (base.posItemId === 'صنف جاهز') return Promise.resolve(detailReady);
      if (!opened) {
        opened = true;
        return Promise.resolve(detail);
      }
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /صنف ناقص/ }));
    expect(
      await screen.findByRole('form', { name: 'ربط الصنف' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    await waitFor(() => {
      expect(pending.length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: /صنف جاهز/ }));
    expect(await screen.findByText(/9\.5/)).toBeInTheDocument();
    await act(async () => {
      pending.splice(0).forEach((resolve) => resolve(detail));
      await Promise.resolve();
    });
    expect(
      screen.getByRole('heading', { level: 2, name: /صنف جاهز/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/9\.5/)).toBeInTheDocument();
    expect(screen.queryByText('الصنف مش مربوط')).not.toBeInTheDocument();
  });

  function nextIsoDate(iso: string): string {
    const [year, month, day] = iso.split('-').map(Number);
    const next = new Date(
      Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1),
    );
    const y = next.getUTCFullYear();
    const m = String(next.getUTCMonth() + 1).padStart(2, '0');
    const d = String(next.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  it('keeps a newer coverage period when a save reload resolves late', async () => {
    const releaseReload: Array<() => void> = [];
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload.push(resolve);
    });
    let basesCalls = 0;
    let coverageCalls = 0;
    const initialBases = [
      observed('صنف جاهز', 'ready'),
      observed('صنف ناقص', 'incomplete'),
    ];
    const newerBases = [
      ...initialBases,
      observed('صنف الفترة الجديدة', 'incomplete'),
    ];
    const staleBases = [
      ...initialBases,
      observed('صنف الفترة القديمة', 'ready'),
    ];
    const newerCoverage = coverage({
      eligibleLines: 8,
      coveredLines: 7,
      readyLines: 7,
      coverage: 0.875,
    });
    const staleCoverage = coverage({
      eligibleLines: 9,
      coveredLines: 1,
      readyLines: 1,
      coverage: 1 / 9,
    });
    vi.mocked(loadBases).mockImplementation(() => {
      basesCalls += 1;
      if (basesCalls === 1) return Promise.resolve(initialBases);
      if (basesCalls === 2) return reloadGate.then(() => staleBases);
      return Promise.resolve(newerBases);
    });
    vi.mocked(loadCoverage).mockImplementation(() => {
      coverageCalls += 1;
      if (coverageCalls === 1) return Promise.resolve(coverage());
      if (coverageCalls === 2) return reloadGate.then(() => staleCoverage);
      return Promise.resolve(newerCoverage);
    });
    vi.mocked(setBaseMapping).mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /صنف ناقص/ }));
    expect(
      await screen.findByRole('form', { name: 'ربط الصنف' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    await waitFor(() => {
      expect(basesCalls).toBe(2);
      expect(coverageCalls).toBe(2);
    });
    const toInput = screen.getByLabelText('إلى تاريخ');
    const nextDay = nextIsoDate((toInput as HTMLInputElement).value);
    fireEvent.change(toInput, { target: { value: nextDay } });
    expect(await screen.findByText('المغطى 7 من 8')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /صنف الفترة الجديدة/ }),
    ).toBeInTheDocument();
    expect(toInput).toHaveValue(nextDay);
    await act(async () => {
      releaseReload.splice(0).forEach((release) => release());
      await Promise.resolve();
    });
    expect(screen.getByText('المغطى 7 من 8')).toBeInTheDocument();
    expect(screen.queryByText('المغطى 1 من 9')).not.toBeInTheDocument();
    expect(screen.getByText(/جاهز 7/)).toBeInTheDocument();
    expect(screen.queryByText(/جاهز 1،/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /صنف الفترة الجديدة/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /صنف الفترة القديمة/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('إلى تاريخ')).toHaveValue(nextDay);
  });

  it('keeps the open subject when its row is clicked again', async () => {
    renderPage();
    const row = await screen.findByRole('button', { name: /صنف ناقص/ });
    fireEvent.click(row);
    expect(
      await screen.findByRole('form', { name: 'ربط الصنف' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('جاري تحميل الصنف…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /صنف ناقص/ }));
    expect(screen.getByRole('form', { name: 'ربط الصنف' })).toBeInTheDocument();
    expect(screen.queryByText('جاري تحميل الصنف…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /صنف ناقص/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
