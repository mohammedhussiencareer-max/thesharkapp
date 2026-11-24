import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateInventory,
  loadOpeningReview,
  loadProcessingSummary,
  recordRunFailure,
  retryParkedOrder,
  runDeductions,
} from '@/accounting/api';
import { OpeningManifestChangedError } from '@/accounting/errors';
import { ProcessingPanel } from '@/accounting/ProcessingPanel';
import {
  accountingRetrySubject,
  accountingRunSubject,
  zeroAccountingCounts,
  type RunOutcome,
} from '@/accounting/run';
import type { OpeningReview, ProcessingSummary } from '@/accounting/types';
import {
  listCounts,
  listDailyItems,
  listPendingCounts,
  recordCount,
  recordStoredCount,
} from '@/counts/api';
import {
  addExpenseEntry,
  loadExpenseMonth,
  voidExpenseEntry,
} from '@/expenses/api';
import type { ExpenseMonth } from '@/expenses/types';
import { ConfirmedRefusalError, StaleWriteError } from '@/items/errors';
import {
  clearActionPostedReloadSnapshot,
  lossSubject,
  priceSubject,
  snapshotActionPostedReloads,
} from '@/items/request-id';
import {
  clearPostedReloadSnapshot,
  clearVerifiedHeldWrite,
  createHeldWriteStore,
  getHeldWrite,
  HeldWriteStorageError,
  putHeldWrite,
  resetHeldWritesStore,
  setHeldWriteUser,
  snapshotPostedReloads,
  userStoragePrefix,
} from '@/lib/held-writes';
import { setBaseMapping, setOptionMapping } from '@/mapping/api';
import { SubjectPanel } from '@/mapping/SubjectPanel';
import type {
  MappingCatalog,
  ObservedBase,
  SubjectDetail,
} from '@/mapping/types';
import { setOrderDisposition } from '@/order-decisions/api';
import { DecisionCard } from '@/order-decisions/DecisionCard';
import { OrderChangedError } from '@/order-decisions/errors';
import { decisionSubject } from '@/order-decisions/format';
import { PendingSaves } from '@/order-decisions/PendingSaves';
import { queueRow, zeroDifferences } from '@/order-decisions/test-fixtures';
import type { DecisionResult } from '@/order-decisions/types';
import { setOrderTypePackaging } from '@/packaging/api';
import { PackagingEditor } from '@/packaging/PackagingEditor';
import { ActivationPage } from '@/pages/ActivationPage';
import { CountsPage } from '@/pages/CountsPage';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { WastePage } from '@/pages/WastePage';
import { listStockChoices } from '@/purchases/api';
import { setRecipeVersion, updateRecipe } from '@/recipes/api';
import { RecipeDetails } from '@/recipes/RecipeDetails';
import { recipeUpdateSubject, recipeVersionSubject } from '@/recipes/subjects';
import type {
  RecipeCatalog,
  RecipeRecord,
  RecipeSchedule,
} from '@/recipes/types';
import { VersionEditor } from '@/recipes/VersionEditor';
import { makeAuditedLocks } from '@/test/held-write-locks';
import { loadHistoryPage, recordWaste } from '@/waste/api';
import { MissingCostBasisError } from '@/waste/errors';
import { documentSubject } from '@/waste/format';
import { itemA, stockChoice, wasteResult } from '@/waste/test-fixtures';

vi.mock('@/accounting/api', () => ({
  loadOpeningReview: vi.fn(),
  activateInventory: vi.fn(),
  loadProcessingSummary: vi.fn(),
  runDeductions: vi.fn(),
  recordRunFailure: vi.fn(),
  retryParkedOrder: vi.fn(),
}));

vi.mock('@/counts/api', () => ({
  listDailyItems: vi.fn(),
  listCounts: vi.fn(),
  listPendingCounts: vi.fn(),
  recordCount: vi.fn(),
  recordStoredCount: vi.fn(),
}));

vi.mock('@/expenses/api', () => ({
  loadExpenseMonth: vi.fn(),
  loadExpenseEntryMonth: vi.fn(),
  addExpenseEntry: vi.fn(),
  voidExpenseEntry: vi.fn(),
  setMonthExpenseComplete: vi.fn(),
  addExpenseCategory: vi.fn(),
  renameExpenseCategory: vi.fn(),
  setExpenseCategoryActive: vi.fn(),
}));

vi.mock('@/items/api', () => ({
  costingImpact: vi.fn(() =>
    Promise.resolve({ orders: 0, shifts: 0, movements: null }),
  ),
  currentShiftStart: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/mapping/api', () => ({
  setBaseMapping: vi.fn(),
  setOptionPolicy: vi.fn(),
  setException: vi.fn(),
  setOptionMapping: vi.fn(),
}));

vi.mock('@/order-decisions/api', () => ({
  setOrderDisposition: vi.fn(),
}));

vi.mock('@/packaging/api', () => ({
  setOrderTypePackaging: vi.fn(),
  setBasePackaging: vi.fn(),
}));

vi.mock('@/purchases/api', () => ({
  listStockChoices: vi.fn(),
  listUnitsAt: vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      Object.fromEntries(
        ids.map((id) => [id, [{ unit: 'g', factorToBase: '0.001' }]]),
      ),
    ),
  ),
}));

vi.mock('@/recipes/api', () => ({
  updateRecipe: vi.fn(),
  setRecipeVersion: vi.fn(),
}));

vi.mock('@/waste/api', () => ({
  historyPageSize: 2,
  loadHistoryPage: vi.fn(),
  recordWaste: vi.fn(),
}));

const owner = 'owner-lock-audit';

function seedPostedPin(
  subject: string,
  requestId: string,
  readTarget?: string,
) {
  putHeldWrite(subject, {
    requestId,
    payload: null,
    phase: 'posted_reload',
    ...(readTarget !== undefined ? { readTarget } : {}),
  });
}

function makeExpenseMonth(monthStart: string): ExpenseMonth {
  return {
    monthStart,
    complete: false,
    confirmedAt: null,
    categories: [
      { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
    ],
    entries: [
      {
        id: 'exp-1',
        categoryId: 'rent',
        categoryName: 'إيجار',
        categoryKind: 'fixed_monthly',
        amount: '100.00',
        periodMonth: monthStart,
        expenseDate: null,
        paidOn: null,
        isEstimate: false,
        note: 'بند تجريبي',
        hours: null,
        hourlyRate: null,
        driverLabel: null,
        createdAt: `${monthStart}T08:00:00Z`,
        voided: false,
        voidReason: null,
        superseded: false,
      },
    ],
    days: [],
  };
}

function makeReview(hash: string): OpeningReview {
  return {
    activated: false,
    stockStartedAt: null,
    openingManifestHash: hash,
    canActivate: true,
    checklist: [{ code: 'unreceipted_outflows', ready: true, count: '0' }],
    roster: [
      {
        itemId: itemA,
        name: 'سمك تجريبي',
        baseUnit: 'kg',
        active: true,
        missing: false,
        openingLineCount: '1',
        observation: {
          openingId: 'open-1',
          lineNo: '1',
          quantity: '10',
          unit: 'kg',
          unitCost: '50',
          occurredAt: '2026-10-01T00:00:00Z',
          explicitZero: false,
        },
      },
    ],
    nextItemId: null,
  };
}

const processingSummary: ProcessingSummary = {
  activated: true,
  pendingCount: '1',
  blockedCount: '0',
  failedCount: '1',
  processedEventCount: '2',
  openEventCount: '3',
  openSpanCount: '0',
  coverage: null,
  parked: [
    {
      orderId: 'order-parked-1',
      attempts: '5',
      workGeneration: '1',
      failedAt: '2026-02-01T00:00:00.000Z',
      sqlstate: '57014',
      reason: 'escaped',
    },
  ],
  parkedCount: '1',
  parkedTruncated: false,
};

const runEmptyOutcome: RunOutcome = {
  stop: 'empty',
  calls: 1,
  counts: zeroAccountingCounts(),
  criticalOrderId: null,
  report: null,
  cause: null,
};

const decisionOk: DecisionResult = {
  status: 'ok',
  orderId: '41',
  eventId: 12,
  decision: 'not_made',
  decisionClass: 'canceled',
  outcome: 'posted',
  reason: 'not_made',
  differences: zeroDifferences,
};

const mappingBase: ObservedBase = {
  posItemId: 'صنف تجريبي',
  sizeKey: ['none'],
  sizeKeyText: '["none"]',
  itemName: 'صنف تجريبي',
  saleCount: 2,
  lastOrderedAt: '2030-06-01T08:00:00.000Z',
  latestOrderId: 'order-1',
  latestLineId: 'line-1',
  mapStatus: 'incomplete',
};

const mappingCatalog: MappingCatalog = {
  recipes: [{ id: 'recipe-1', name: 'طبق تجريبي', kind: 'dish' }],
  items: [{ id: 'item-1', name: 'ملح تجريبي', baseUnit: 'kg' }],
  packagingItems: [],
  units: [{ code: 'kg', label: 'كيلو' }],
  shiftStart: null,
};

const mappingDetail: SubjectDetail = {
  schedule: {
    subjectId: null,
    token: 'token-1',
    emptyToken: 'token-1',
    versions: [],
  },
  options: [
    {
      posItemId: 'صنف تجريبي',
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
        versions: [],
      },
    },
  ],
  suggestions: [],
  history: [],
  optionHistory: [],
  resolution: {
    status: 'incomplete',
    issues: [{ code: 'unmapped_base', expandIssue: null }],
    requirements: [],
  },
  packaging: {
    schedule: {
      subjectId: null,
      token: 'pack-token',
      emptyToken: 'pack-token',
      versions: [],
    },
    history: [],
  },
};

const sampleRecipe: RecipeRecord = {
  id: 'rec-1',
  name: 'وصفة تجريبية',
  kind: 'dish',
  active: true,
};

const sampleSchedule: RecipeSchedule = {
  identity: 'dish|rec-1',
  token: 'sched-1',
  emptyToken: 'sched-empty',
  versions: [],
};

const sampleRecipeCatalog: RecipeCatalog = {
  stock: [
    {
      id: 'oil',
      name: 'زيت',
      kind: 'ingredient',
      baseUnit: 'liter',
      active: true,
    },
  ],
  batches: [],
  itemUnits: [{ itemId: 'oil', unit: 'liter', label: 'لتر' }],
  units: [
    {
      code: 'liter',
      labelAr: 'لتر',
      dimension: 'volume',
      metricScale: 1000,
    },
  ],
  shiftStart: null,
};

describe('mechanical lock-nesting audit', () => {
  let audit: ReturnType<typeof makeAuditedLocks>;
  let originalLocks: PropertyDescriptor | undefined;
  let allowNestedForControl = false;

  beforeEach(() => {
    vi.clearAllMocks();
    allowNestedForControl = false;
    audit = makeAuditedLocks();
    originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: audit.locks,
    });
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    setHeldWriteUser(owner);
  });

  afterEach(() => {
    if (!allowNestedForControl) {
      expect(
        audit.nested,
        'a context requested a second subject lock while holding one',
      ).toEqual([]);
    }
    if (originalLocks) {
      Object.defineProperty(navigator, 'locks', originalLocks);
    } else {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('instrumentation fails when a context requests a second subject lock while holding one', async () => {
    allowNestedForControl = true;
    const { locks, client, nested } = makeAuditedLocks();
    await locks.request('subject-a', { mode: 'exclusive' }, async () => {
      await locks.request('subject-b', { mode: 'exclusive' }, () => {});
    });
    expect(nested).toEqual([
      {
        context: 'page',
        holding: ['subject-a'],
        requested: 'subject-b',
      },
    ]);

    // A simulated tab using one stable audit client catches two overlapping claims on the same store.
    const tabLocks = client('single-tab');
    const tab = createHeldWriteStore({ getLocks: () => tabLocks });
    tab.setHeldWriteUser(owner);
    const first = await tab.claimFreshHeldWrite(lossSubject('nest-a'), () => ({
      loss: '1',
    }));
    const second = await tab.claimFreshHeldWrite(
      priceSubject('nest-b'),
      () => ({ price: '2' }),
    );
    try {
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(nested).toHaveLength(2);
      const tabNested = nested[1];
      expect(tabNested?.context).toBe('single-tab');
      expect(tabNested?.holding).toHaveLength(1);
      expect(tabNested?.holding[0]).toContain(
        encodeURIComponent('loss:nest-a'),
      );
      expect(tabNested?.requested).toContain(
        encodeURIComponent('price:nest-b'),
      );
    } finally {
      if (first.ok) first.release();
      if (second.ok) second.release();
      tab.dispose();
    }
  });

  it('WastePage / useWasteAction: success, definitive rejection, unknown, replay, and sibling cleanup never nest locks', async () => {
    const sibling = documentSubject('sibling-waste');
    vi.mocked(listStockChoices).mockResolvedValue([stockChoice()]);
    vi.mocked(loadHistoryPage).mockResolvedValue({ entries: [], next: null });

    render(
      <MemoryRouter>
        <WastePage />
      </MemoryRouter>,
    );
    const form = await screen.findByRole('form', { name: 'تسجيل هالك جديد' });
    const fillAndClick = async (qty: string) => {
      fireEvent.change(within(form).getByLabelText('السبب'), {
        target: { value: 'spoilage' },
      });
      const line = within(form).getByRole('group', { name: 'سطر 1' });
      fireEvent.change(within(line).getByLabelText('الصنف'), {
        target: { value: itemA },
      });
      fireEvent.change(within(line).getByLabelText('الكمية'), {
        target: { value: qty },
      });
      const submit = within(form).getByRole('button', { name: 'سجّل الهالك' });
      await waitFor(() => expect(submit).toBeEnabled());
      fireEvent.click(submit);
    };

    // Definitive rejection while a sibling waste posted_reload pin exists
    vi.mocked(recordWaste).mockImplementationOnce(() => {
      seedPostedPin(sibling, 'req-sib-waste-1', sibling);
      return Promise.reject(new MissingCostBasisError([itemA]));
    });
    await fillAndClick('2');
    expect(await screen.findByRole('alert')).toHaveTextContent('مفيش تكلفة');
    await waitFor(() => expect(getHeldWrite(sibling)).toBeNull());

    // Unknown -> replay -> success while a sibling waste posted_reload pin exists
    vi.mocked(recordWaste)
      .mockRejectedValueOnce(new Error('socket'))
      .mockImplementationOnce(() => {
        seedPostedPin(sibling, 'req-sib-waste-2', sibling);
        return Promise.resolve(wasteResult());
      });
    await fillAndClick('3');
    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retry);
    await screen.findByRole('status');
    await waitFor(() => expect(getHeldWrite(sibling)).toBeNull());
  });

  it('DecisionForm & PendingSaves: success, definitive rejection, unknown, and replay never nest locks during sibling cleanup', async () => {
    const sibling = decisionSubject('sibling-order');
    const onChanged = vi.fn(async () => {
      await Promise.resolve();
      const snap = snapshotActionPostedReloads({ prefix: 'order-decision:' });
      await clearActionPostedReloadSnapshot(snap);
    });

    const view = render(
      <MemoryRouter>
        <DecisionCard row={queueRow()} closed={false} onChanged={onChanged} />
      </MemoryRouter>,
    );
    const pickNotMade = () => {
      fireEvent.click(screen.getByLabelText('ماتعملش'));
      fireEvent.change(screen.getByLabelText('سبب تغيير القرار'), {
        target: { value: 'سبب تجريبي' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ القرار' }));
    };

    // Definitive rejection with sibling pin cleared by onChanged
    vi.mocked(setOrderDisposition).mockImplementationOnce(() => {
      seedPostedPin(sibling, 'req-sib-dec-1', sibling);
      return Promise.reject(new OrderChangedError());
    });
    pickNotMade();
    await waitFor(() => expect(getHeldWrite(sibling)).toBeNull());

    // Unknown -> replay success with sibling pin cleared by onChanged
    vi.mocked(setOrderDisposition)
      .mockRejectedValueOnce(new Error('socket'))
      .mockImplementationOnce(() => {
        seedPostedPin(sibling, 'req-sib-dec-2', sibling);
        return Promise.resolve(decisionOk);
      });
    pickNotMade();
    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retry);
    await waitFor(() => expect(getHeldWrite(sibling)).toBeNull());
    view.unmount();

    // PendingSaves replay: definitive refusal and success with sibling cleanup in onSettled
    const pendingOrder = '99';
    const pendingSubject = decisionSubject(pendingOrder);
    const seedPending = (reqId: string) =>
      putHeldWrite(pendingSubject, {
        requestId: reqId,
        phase: 'unknown',
        payload: {
          requestId: reqId,
          orderId: pendingOrder,
          decision: 'not_made',
          token: 'tok-99',
          reason: null,
          returned: null,
        },
      });
    const onSettled = vi.fn(() => {
      void Promise.resolve().then(async () => {
        const snap = snapshotActionPostedReloads({ prefix: 'order-decision:' });
        await clearActionPostedReloadSnapshot(snap);
      });
    });
    seedPending('req-pending-1');
    vi.mocked(setOrderDisposition).mockImplementationOnce(() => {
      seedPostedPin(sibling, 'req-sib-pending-1', sibling);
      return Promise.reject(new ConfirmedRefusalError('مرفوض'));
    });
    render(<PendingSaves shown={new Set()} onSettled={onSettled} />);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => expect(getHeldWrite(sibling)).toBeNull());

    seedPending('req-pending-2');
    vi.mocked(setOrderDisposition).mockImplementationOnce(() => {
      seedPostedPin(sibling, 'req-sib-pending-2', sibling);
      return Promise.resolve({ ...decisionOk, orderId: pendingOrder });
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'إعادة المحاولة' }),
    );
    await waitFor(() => expect(getHeldWrite(sibling)).toBeNull());
  });

  it('ExpensesPage: add and void success, refusal, unknown, and cleanup never nest locks', async () => {
    const monthData = makeExpenseMonth('2030-04-01');
    const siblingVoid = 'expense:void:other-exp';
    vi.mocked(loadExpenseMonth).mockResolvedValue(monthData);

    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    const picker = await screen.findByLabelText('الشهر');
    fireEvent.change(picker, { target: { value: '2030-04' } });
    await screen.findByText('بند تجريبي');

    const submitAdd = () => {
      fireEvent.change(screen.getByLabelText('التصنيف'), {
        target: { value: 'rent' },
      });
      fireEvent.change(screen.getByLabelText('المبلغ'), {
        target: { value: '50' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    };

    // Add expense: definitive refusal -> unknown -> replay success (clearing sibling void posted_reload)
    vi.mocked(addExpenseEntry)
      .mockRejectedValueOnce(new Error('المبلغ غير صالح'))
      .mockRejectedValueOnce({ status: 503, message: 'network' })
      .mockImplementationOnce(() => {
        seedPostedPin(siblingVoid, 'req-sib-void', '2030-04-01');
        return Promise.resolve();
      });

    submitAdd();
    expect(await screen.findByText('المبلغ غير صالح')).toBeInTheDocument();

    submitAdd();
    await waitFor(() =>
      expect(getHeldWrite('expense:new')?.phase).toBe('unknown'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(getHeldWrite(siblingVoid)).toBeNull());

    // Void expense: definitive refusal -> unknown -> replay success (clearing sibling expense:new posted_reload)
    vi.mocked(voidExpenseEntry)
      .mockRejectedValueOnce(new Error('السبب مطلوب'))
      .mockRejectedValueOnce({ status: 503, message: 'network' })
      .mockImplementationOnce(() => {
        seedPostedPin('expense:new', 'req-sib-new', '2030-04-01');
        return Promise.resolve();
      });

    const clickVoid = () => {
      if (!screen.queryByRole('button', { name: 'تأكيد الإلغاء' })) {
        fireEvent.click(screen.getByRole('button', { name: 'إلغاء المصروف' }));
      }
      fireEvent.change(screen.getByLabelText('سبب الإلغاء'), {
        target: { value: 'تكرار' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    };
    clickVoid();
    expect(await screen.findByText('السبب مطلوب')).toBeInTheDocument();

    clickVoid();
    await waitFor(() =>
      expect(getHeldWrite('expense:void:exp-1')?.phase).toBe('unknown'),
    );
    clickVoid();
    await waitFor(() => expect(getHeldWrite('expense:new')).toBeNull());
  });

  it('CountsPage: daily submit and stored card paths (success, wait, refusal, unknown, alias refresh) never nest locks', async () => {
    const cardId = 'd1900000-0000-4000-8000-000000000077';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const cardPayload = {
      request_id: cardId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [],
    };
    const siblingCard = 'count:stored:other-card';
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'fish-1',
        name: 'سمك',
        baseUnit: 'kg',
        onHandQty: '5',
        onHandValue: '250.00',
        avgCost: '50.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([
      {
        requestId: cardId,
        countedAt,
        preparedAt: countedAt,
        itemCount: 0,
        payload: cardPayload,
      },
    ]);

    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    const resendCard = await screen.findByRole('button', {
      name: 'سجّل الجرد',
    });

    // Stored card: refusal -> unknown -> waiting_for_sync -> success (clearing sibling)
    vi.mocked(recordStoredCount)
      .mockRejectedValueOnce(new Error('جرد مرفوض'))
      .mockRejectedValueOnce({ status: 503, message: 'lost' })
      .mockResolvedValueOnce({ status: 'waiting_for_sync' })
      .mockImplementationOnce(() => {
        seedPostedPin(siblingCard, 'req-sib-card');
        return Promise.resolve({ status: 'posted', countId: 'c-1' });
      });

    fireEvent.click(resendCard);
    expect(await screen.findByText('جرد مرفوض')).toBeInTheDocument();

    fireEvent.click(resendCard);
    await waitFor(() =>
      expect(getHeldWrite(`count:stored:${cardId}`)?.phase).toBe('unknown'),
    );
    fireEvent.click(resendCard);
    await waitFor(() =>
      expect(getHeldWrite(`count:stored:${cardId}`)).toBeNull(),
    );
    fireEvent.click(resendCard);
    await waitFor(() => expect(getHeldWrite(siblingCard)).toBeNull());

    // Daily form: refusal -> unknown -> success (clearing sibling)
    vi.mocked(recordCount)
      .mockRejectedValueOnce(new Error('كمية غير صالحة'))
      .mockRejectedValueOnce({ status: 503, message: 'lost' })
      .mockImplementationOnce(() => {
        seedPostedPin(siblingCard, 'req-sib-card-2');
        return Promise.resolve({ status: 'posted', countId: 'c-2' });
      });
    const qtyInput = screen.getByLabelText(/سمك/);
    fireEvent.change(qtyInput, { target: { value: '4' } });
    const submitForm = screen.getByRole('button', { name: 'حفظ' });
    fireEvent.click(submitForm);
    expect(await screen.findByText('كمية غير صالحة')).toBeInTheDocument();

    fireEvent.click(submitForm);
    await waitFor(() =>
      expect(getHeldWrite('count:daily')?.phase).toBe('unknown'),
    );
    fireEvent.click(submitForm);
    await waitFor(() => expect(getHeldWrite(siblingCard)).toBeNull());
  });

  it('SubjectPanel & PackagingEditor: success, definitive refusal, and unknown never nest locks during sibling reload cleanup', async () => {
    const siblingMap = 'mapping:option:sibling';
    const onMapReload = vi.fn(async () => {
      await Promise.resolve();
      const snap = snapshotActionPostedReloads({ prefix: 'mapping:' });
      await clearActionPostedReloadSnapshot(snap);
    });
    const view = render(
      <SubjectPanel
        base={mappingBase}
        detail={mappingDetail}
        catalog={mappingCatalog}
        onReload={onMapReload}
      />,
    );

    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    vi.mocked(setBaseMapping)
      .mockImplementationOnce(() => {
        seedPostedPin(siblingMap, 'req-sib-map-1', siblingMap);
        return Promise.reject(new ConfirmedRefusalError('مرفوض'));
      })
      .mockRejectedValueOnce(new Error('socket'))
      .mockImplementationOnce(() => {
        seedPostedPin(siblingMap, 'req-sib-map-2', siblingMap);
        return Promise.resolve();
      });

    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    await waitFor(() => expect(getHeldWrite(siblingMap)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    const retryBase = await screen.findByRole('button', {
      name: 'إعادة المحاولة',
    });
    fireEvent.click(retryBase);
    await waitFor(() => expect(getHeldWrite(siblingMap)).toBeNull());

    // Option mapping section
    const optForm = screen.getByRole('form', {
      name: 'ربط الاختيار العام مشوي',
    });
    const siblingBase = 'mapping:base:sibling';
    vi.mocked(setOptionMapping)
      .mockImplementationOnce(() => {
        seedPostedPin(siblingBase, 'req-sib-opt-1', siblingBase);
        return Promise.reject(new ConfirmedRefusalError('مرفوض'));
      })
      .mockRejectedValueOnce(new Error('socket'))
      .mockImplementationOnce(() => {
        seedPostedPin(siblingBase, 'req-sib-opt-2', siblingBase);
        return Promise.resolve();
      });

    fireEvent.click(
      within(optForm).getByRole('button', { name: 'احفظ ربط الاختيار' }),
    );
    await waitFor(() => expect(getHeldWrite(siblingBase)).toBeNull());
    fireEvent.click(
      within(optForm).getByRole('button', { name: 'احفظ ربط الاختيار' }),
    );
    const retryOpt = await within(optForm).findByRole('button', {
      name: 'إعادة المحاولة',
    });
    fireEvent.click(retryOpt);
    await waitFor(() => expect(getHeldWrite(siblingBase)).toBeNull());
    view.unmount();

    // PackagingEditor
    const siblingPack = 'packaging-order-type:sibling';
    const onPackReload = vi.fn(async () => {
      await Promise.resolve();
      const snap = snapshotActionPostedReloads({ prefix: 'packaging-' });
      await clearActionPostedReloadSnapshot(snap);
    });
    render(
      <PackagingEditor
        subjectKey="packaging-order-type:hall"
        kind="order_type"
        orderType="hall"
        schedule={{
          subjectId: 'sub-pack',
          token: 'pack-token',
          emptyToken: 'pack-empty',
          versions: [],
        }}
        history={[]}
        items={[{ id: 'box-1', name: 'علبة', baseUnit: 'piece' }]}
        units={[{ code: 'piece', label: 'قطعة' }]}
        shiftStart={null}
        allowCapacity={false}
        onReload={onPackReload}
      />,
    );
    vi.mocked(setOrderTypePackaging)
      .mockImplementationOnce(() => {
        seedPostedPin(siblingPack, 'req-sib-pack-1', siblingPack);
        return Promise.reject(new ConfirmedRefusalError('مرفوض'));
      })
      .mockRejectedValueOnce(new Error('socket'))
      .mockImplementationOnce(() => {
        seedPostedPin(siblingPack, 'req-sib-pack-2', siblingPack);
        return Promise.resolve();
      });

    fireEvent.click(screen.getByRole('button', { name: 'احفظ التغليف' }));
    await waitFor(() => expect(getHeldWrite(siblingPack)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التغليف' }));
    const retryPack = await screen.findByRole('button', {
      name: 'إعادة المحاولة',
    });
    fireEvent.click(retryPack);
    await waitFor(() => expect(getHeldWrite(siblingPack)).toBeNull());
  });

  it('RecipeDetails & VersionEditor: success, definitive refusal, and unknown never nest locks during sibling reload cleanup', async () => {
    const versionSubj = recipeVersionSubject(sampleRecipe.id);
    const updateSubj = recipeUpdateSubject(sampleRecipe.id);
    const onDetailsReload = vi.fn(async () => {
      await Promise.resolve();
      const snap = snapshotActionPostedReloads({ subject: versionSubj });
      await clearActionPostedReloadSnapshot(snap, versionSubj);
      return sampleRecipe;
    });
    const view = render(
      <RecipeDetails
        recipe={sampleRecipe}
        locked={false}
        onBusyChange={vi.fn()}
        onReload={onDetailsReload}
      />,
    );

    vi.mocked(updateRecipe)
      .mockImplementationOnce(() => {
        seedPostedPin(versionSubj, 'req-sib-ver-1', versionSubj);
        return Promise.reject(new StaleWriteError());
      })
      .mockRejectedValueOnce(new Error('socket'))
      .mockImplementationOnce(() => {
        seedPostedPin(versionSubj, 'req-sib-ver-2', versionSubj);
        return Promise.resolve();
      });

    fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
      target: { value: 'وصفة محدثة' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
    await waitFor(() => expect(getHeldWrite(versionSubj)).toBeNull());

    fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
      target: { value: 'وصفة تانية' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
    const retryDetails = await screen.findByRole('button', {
      name: 'إعادة المحاولة',
    });
    fireEvent.click(retryDetails);
    await waitFor(() => expect(getHeldWrite(versionSubj)).toBeNull());
    view.unmount();

    const onVersionReload = vi.fn(async () => {
      await Promise.resolve();
      const snap = snapshotActionPostedReloads({ subject: updateSubj });
      await clearActionPostedReloadSnapshot(snap, updateSubj);
      return true;
    });
    render(
      <VersionEditor
        recipe={sampleRecipe}
        schedule={sampleSchedule}
        catalog={sampleRecipeCatalog}
        locked={false}
        onBusyChange={vi.fn()}
        onReload={onVersionReload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
    fireEvent.change(screen.getByLabelText('المكوّن 1'), {
      target: { value: 'item:oil' },
    });
    fireEvent.change(screen.getByLabelText('الكمية 1'), {
      target: { value: '2' },
    });

    vi.mocked(setRecipeVersion)
      .mockImplementationOnce(() => {
        seedPostedPin(updateSubj, 'req-sib-upd-1', updateSubj);
        return Promise.reject(new ConfirmedRefusalError('مرفوض'));
      })
      .mockRejectedValueOnce(new Error('socket'))
      .mockImplementationOnce(() => {
        seedPostedPin(updateSubj, 'req-sib-upd-2', updateSubj);
        return Promise.resolve();
      });

    fireEvent.click(screen.getByRole('button', { name: 'احفظ النسخة' }));
    await waitFor(() => expect(getHeldWrite(updateSubj)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'احفظ النسخة' }));
    const retryVersion = await screen.findByRole('button', {
      name: 'إعادة المحاولة',
    });
    fireEvent.click(retryVersion);
    await waitFor(() => expect(getHeldWrite(updateSubj)).toBeNull());
  });

  it('ActivationPage & ProcessingPanel: success, refusal, unknown, replay, and sibling cleanup never nest locks', async () => {
    const hashA = 'a'.repeat(32);
    const hashB = 'b'.repeat(32);
    const reviewA = makeReview(hashA);
    const reviewB = makeReview(hashB);
    const activated = { ...reviewB, activated: true, canActivate: false };
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(reviewA)
      .mockResolvedValueOnce(reviewB)
      .mockResolvedValue(activated);
    vi.mocked(activateInventory)
      .mockRejectedValueOnce(new OpeningManifestChangedError())
      .mockRejectedValueOnce(new Error('socket'))
      .mockResolvedValueOnce({
        activated: true,
        stockStartedAt: null,
        openingManifestHash: hashB,
      });

    const actView = render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تفعيل الخصم' }));
    await screen.findByText('قائمة الافتتاح اتغيرت — راجعها وفعّل تاني');
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل الخصم' }));
    const retryAct = await screen.findByRole('button', {
      name: 'إعادة المحاولة',
    });
    fireEvent.click(retryAct);
    await screen.findByText(/التفعيل اتسجل/);
    actView.unmount();

    // ProcessingPanel: run & parked-order retry clearing sibling pins on reload
    const siblingRetry = accountingRetrySubject('order-sibling');
    vi.mocked(loadProcessingSummary).mockResolvedValue(processingSummary);
    vi.mocked(runDeductions)
      .mockResolvedValueOnce({
        ...runEmptyOutcome,
        stop: 'call_failed',
        report: 'not_needed',
        cause: new ConfirmedRefusalError('مرفوض'),
      })
      .mockImplementationOnce(() => {
        seedPostedPin(siblingRetry, 'req-sib-retry', siblingRetry);
        return Promise.resolve(runEmptyOutcome);
      });
    vi.mocked(recordRunFailure).mockResolvedValue('recorded');
    vi.mocked(retryParkedOrder)
      .mockRejectedValueOnce(new ConfirmedRefusalError('مرفوض'))
      .mockRejectedValueOnce(new Error('socket'))
      .mockImplementationOnce(() => {
        seedPostedPin(
          accountingRunSubject,
          'req-sib-run',
          accountingRunSubject,
        );
        return Promise.resolve('retried');
      });

    render(<ProcessingPanel />);
    const runBtn = await screen.findByRole('button', { name: 'شغّل الخصم' });
    fireEvent.click(runBtn);
    await waitFor(() => expect(runDeductions).toHaveBeenCalledTimes(1));

    fireEvent.click(runBtn);
    await waitFor(() => expect(getHeldWrite(siblingRetry)).toBeNull());

    const retryOrderBtn = screen.getByRole('button', { name: 'رجّع الطلب' });
    fireEvent.click(retryOrderBtn);
    await waitFor(() => expect(retryParkedOrder).toHaveBeenCalledTimes(1));

    fireEvent.click(retryOrderBtn);
    const replayParked = await screen.findByRole('button', {
      name: 'إعادة المحاولة',
    });
    fireEvent.click(replayParked);
    await waitFor(() => expect(getHeldWrite(accountingRunSubject)).toBeNull());
  });

  it('held-writes store cleanup paths (multi-subject snapshot, verified clear, sign-out, and rehydration) never nest locks', async () => {
    const s1 = lossSubject('oil');
    const s2 = priceSubject('oil');
    const s3 = 'count:stored:req-3';
    seedPostedPin(s1, 'r1', 'oil');
    seedPostedPin(s2, 'r2', 'oil');
    seedPostedPin(s3, 'r3');
    const snap = snapshotPostedReloads({});
    await clearPostedReloadSnapshot(snap);
    expect(getHeldWrite(s1)).toBeNull();
    expect(getHeldWrite(s2)).toBeNull();
    expect(getHeldWrite(s3)).toBeNull();

    // clearVerifiedHeldWrite across two distinct subjects
    putHeldWrite('expense:void:a', {
      requestId: 'va',
      phase: 'unknown',
      payload: { id: 'a' },
    });
    putHeldWrite('expense:void:b', {
      requestId: 'vb',
      phase: 'unknown',
      payload: { id: 'b' },
    });
    const recA = getHeldWrite('expense:void:a');
    const recB = getHeldWrite('expense:void:b');
    if (recA) await clearVerifiedHeldWrite(recA);
    if (recB) await clearVerifiedHeldWrite(recB);
    expect(getHeldWrite('expense:void:a')).toBeNull();
    expect(getHeldWrite('expense:void:b')).toBeNull();

    // clearHeldWritesForUser across multiple subjects (one free, one busy transitioning active->posted)
    const { client, nested } = makeAuditedLocks();
    const tabALocks = client('tab-a');
    const tabBLocks = client('tab-b');
    const tabA = createHeldWriteStore({ getLocks: () => tabALocks });
    const tabB = createHeldWriteStore({ getLocks: () => tabBLocks });
    tabA.setHeldWriteUser(owner);
    tabB.setHeldWriteUser(owner);
    const c1 = await tabA.claimFreshHeldWrite(lossSubject('a1'), () => ({
      loss: '1',
    }));
    if (!c1.ok) throw new Error('expected first claim');
    c1.release();
    await Promise.resolve();
    const c2 = await tabA.claimFreshHeldWrite(priceSubject('b1'), () => ({
      price: '2',
    }));
    if (!c2.ok) throw new Error('expected second claim');
    try {
      tabB.setWritesLocked(true);
      tabB.clearHeldWritesForUser(owner);
      tabB.setHeldWriteUser(null);
      tabA.setHeldWritePhase(
        priceSubject('b1'),
        c2.record.requestId,
        'posted_reload',
        {
          readTarget: 'b1',
        },
      );
      c2.release();
      const prefix = userStoragePrefix(owner);
      const postedB1 = `${prefix}posted:${encodeURIComponent(priceSubject('b1'))}:${encodeURIComponent(c2.record.requestId)}`;
      await waitFor(() => expect(localStorage.getItem(postedB1)).toBeNull(), {
        timeout: 400,
      });

      // rehydrateHeldWritesAsync across multiple unheld inflight subjects
      tabA.setHeldWriteUser(owner);
      const c3 = await tabA.claimFreshHeldWrite(lossSubject('h1'), () => ({
        loss: '3',
      }));
      if (!c3.ok) throw new Error('expected first hydration claim');
      const spy = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementationOnce(() => {
          throw new Error('forced ack storage error');
        });
      expect(() =>
        tabA.setHeldWritePhase(
          lossSubject('h1'),
          c3.record.requestId,
          'posted_reload',
          {
            readTarget: 'h1',
          },
        ),
      ).toThrow(HeldWriteStorageError);
      spy.mockRestore();
      c3.release();
      await Promise.resolve();
      const c4 = await tabA.claimFreshHeldWrite(priceSubject('h2'), () => ({
        price: '4',
      }));
      if (!c4.ok) throw new Error('expected second hydration claim');
      c4.release();
      await Promise.resolve();
      await act(async () => {
        await tabA.rehydrateHeldWritesAsync();
      });
      expect(nested).toEqual([]);
    } finally {
      c1.release();
      c2.release();
      tabA.dispose();
      tabB.dispose();
    }
  });
});
