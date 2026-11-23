import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateInventory, loadOpeningReview } from '@/accounting/api';
import { OpeningManifestChangedError } from '@/accounting/errors';
import type { OpeningReview } from '@/accounting/types';
import {
  listCounts,
  listDailyItems,
  listPendingCounts,
  recordCount,
  recordStoredCount,
} from '@/counts/api';
import type { CountItem } from '@/counts/types';
import {
  addExpenseCategory,
  addExpenseEntry,
  loadExpenseMonth,
  renameExpenseCategory,
  setExpenseCategoryActive,
  setMonthExpenseComplete,
  voidExpenseEntry,
} from '@/expenses/api';
import type { ExpenseMonth } from '@/expenses/types';
import {
  addConversion,
  addCustomUnit,
  costingImpact,
  createItem,
  currentShiftStart,
  deleteConversion,
  listConversions,
  listCostingSchedule,
  listItems,
  listUnitOptions,
  setItemLoss,
  setOpeningPrice,
  updateConversion,
  updateItem,
} from '@/items/api';
import { ConversionsPanel } from '@/items/ConversionsPanel';
import { ItemForm } from '@/items/ItemForm';
import {
  claimFreshAction,
  createSubject,
  settleAction,
  unknownSaveMessage,
} from '@/items/request-id';
import type { CatalogItem, ItemDraft } from '@/items/types';
import {
  getHeldWrite,
  hasAnyHeldWrite,
  hasPostedReload,
  putHeldWrite,
  rehydrateHeldWrites,
  resetHeldWritesStore,
  setHeldWriteUser,
} from '@/lib/held-writes';
import { setTestWaitingWorker } from '@/lib/pwa';
import { setBaseMapping } from '@/mapping/api';
import { baseSubject } from '@/mapping/subjects';
import { SubjectPanel } from '@/mapping/SubjectPanel';
import type {
  MappingCatalog,
  ObservedBase,
  SubjectDetail,
} from '@/mapping/types';
import { setOrderTypePackaging } from '@/packaging/api';
import { PackagingEditor } from '@/packaging/PackagingEditor';
import { orderTypePackagingSubject } from '@/packaging/subjects';
import { ActivationPage } from '@/pages/ActivationPage';
import { CountsPage } from '@/pages/CountsPage';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ItemsPage } from '@/pages/ItemsPage';
import { RecipeImportPage } from '@/pages/RecipeImportPage';
import { RecipesPage } from '@/pages/RecipesPage';
import { UpdateBanner } from '@/pwa/UpdateBanner';
import {
  createRecipe,
  listRecipes,
  setRecipeVersion,
  updateRecipe,
} from '@/recipes/api';
import {
  commitRecipeImport,
  fetchImportTokens,
  loadImportContext,
} from '@/recipes/import/api';
import { RecipeDetails } from '@/recipes/RecipeDetails';
import {
  recipeCreateSubject,
  recipeImportSubject,
  recipeUpdateSubject,
  recipeVersionSubject,
} from '@/recipes/subjects';
import type {
  RecipeCatalog,
  RecipeRecord,
  RecipeSchedule,
} from '@/recipes/types';
import { VersionEditor } from '@/recipes/VersionEditor';

vi.mock('@/counts/api', () => ({
  listDailyItems: vi.fn(),
  listCounts: vi.fn(),
  listPendingCounts: vi.fn(),
  recordCount: vi.fn(),
  recordStoredCount: vi.fn(),
}));

vi.mock('@/expenses/api', () => ({
  loadExpenseMonth: vi.fn(),
  addExpenseEntry: vi.fn(),
  voidExpenseEntry: vi.fn(),
  addExpenseCategory: vi.fn(),
  renameExpenseCategory: vi.fn(),
  setExpenseCategoryActive: vi.fn(),
  setMonthExpenseComplete: vi.fn(),
}));

vi.mock('@/items/api', () => ({
  listItems: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  setItemLoss: vi.fn(),
  setOpeningPrice: vi.fn(),
  listConversions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
  currentShiftStart: vi.fn(() => Promise.resolve(null)),
  listCostingSchedule: vi.fn(() =>
    Promise.resolve({
      lossToken: 'tok-loss',
      identity: 'kg|ingredient||',
      lossVersions: [],
      conversions: [],
    }),
  ),
  costingImpact: vi.fn(() =>
    Promise.resolve({ orders: 0, shifts: 0, movements: 0 }),
  ),
  listUnitOptions: vi.fn(() =>
    Promise.resolve([
      { code: 'كيس', labelAr: 'كيس' },
      { code: 'كرتونة', labelAr: 'كرتونة' },
    ]),
  ),
  addCustomUnit: vi.fn((code: string) => Promise.resolve(code)),
}));

vi.mock('@/mapping/api', () => ({
  setBaseMapping: vi.fn(),
  setOptionPolicy: vi.fn(),
  setException: vi.fn(),
  setOptionMapping: vi.fn(),
}));

vi.mock('@/packaging/api', () => ({
  setBasePackaging: vi.fn(),
  setOrderTypePackaging: vi.fn(),
}));

vi.mock('@/recipes/api', () => ({
  listRecipes: vi.fn(),
  createRecipe: vi.fn(),
  updateRecipe: vi.fn(),
  setRecipeVersion: vi.fn(),
}));

vi.mock('@/recipes/import/api', () => ({
  loadImportContext: vi.fn(),
  fetchImportTokens: vi.fn(),
  commitRecipeImport: vi.fn(),
}));

vi.mock('@/accounting/api', () => ({
  loadOpeningReview: vi.fn(),
  activateInventory: vi.fn(),
}));

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

const tilapia: CountItem = {
  id: 'tilapia',
  name: 'بلطي',
  baseUnit: 'kg',
  onHandQty: '10',
  onHandValue: '100.00',
  avgCost: '10.00',
};

const oilItem: CatalogItem = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'kg',
  countFrequency: 'weekly',
  lossPct: 0,
  parentItemId: null,
  active: true,
  onHandQty: 0,
  avgCost: 0,
  onHandValue: 0,
};

const mapBase: ObservedBase = {
  posItemId: 'pos-item-1',
  sizeKey: ['none'],
  sizeKeyText: '["none"]',
  itemName: 'طبق تجريبي',
  saleCount: 2,
  lastOrderedAt: '2030-06-01T08:00:00.000Z',
  latestOrderId: 'order-1',
  latestLineId: 'line-1',
  mapStatus: 'incomplete',
};

const mapCatalog: MappingCatalog = {
  recipes: [],
  items: [{ id: 'item-1', name: 'ملح تجريبي', baseUnit: 'kg' }],
  packagingItems: [],
  units: [{ code: 'kg', label: 'كيلو' }],
  shiftStart: null,
};

const mapDetail: SubjectDetail = {
  schedule: {
    subjectId: null,
    token: 'tok-1',
    emptyToken: 'tok-1',
    versions: [],
  },
  options: [],
  optionBindings: [],
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
      token: 'pack-tok',
      emptyToken: 'pack-tok',
      versions: [],
    },
    history: [],
  },
};

const sampleRecipe: RecipeRecord = {
  id: 'rec-1',
  name: 'طبق قديم',
  kind: 'dish',
  active: true,
};

const sampleSchedule: RecipeSchedule = {
  identity: 'dish|true',
  token: 'sch-tok',
  emptyToken: 'sch-tok',
  versions: [],
};

const sampleRecipeCatalog: RecipeCatalog = {
  stock: [
    {
      id: 'oil',
      name: 'زيت',
      kind: 'ingredient',
      baseUnit: 'kg',
      active: true,
    },
  ],
  itemUnits: [{ itemId: 'oil', unit: 'kg', label: 'كيلو' }],
  units: [
    { code: 'kg', labelAr: 'كيلو', dimension: 'mass', metricScale: 1000 },
  ],
  batches: [],
  shiftStart: null,
};

function expenseMonth(monthStart: string): ExpenseMonth {
  return {
    monthStart,
    categories: [
      { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
    ],
    entries: [],
    days: [],
    complete: false,
    confirmedAt: null,
  };
}

describe('P7-3 review fixes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:55421');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    localStorage.clear();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    setHeldWriteUser('user-review');
    setOnline(true);

    vi.mocked(listDailyItems).mockResolvedValue([tilapia]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([]);
    vi.mocked(recordCount).mockResolvedValue({
      status: 'posted',
      countId: 'c1',
    });
    vi.mocked(recordStoredCount).mockResolvedValue({
      status: 'posted',
      countId: 'c2',
    });
    vi.mocked(loadExpenseMonth).mockImplementation((m) =>
      Promise.resolve(expenseMonth(m)),
    );
    vi.mocked(addExpenseEntry).mockResolvedValue(undefined);
    vi.mocked(voidExpenseEntry).mockResolvedValue(undefined);
    vi.mocked(setMonthExpenseComplete).mockResolvedValue(undefined);
    vi.mocked(addExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(renameExpenseCategory).mockResolvedValue(undefined);
    vi.mocked(setExpenseCategoryActive).mockResolvedValue(undefined);
    vi.mocked(listItems).mockResolvedValue([oilItem]);
    vi.mocked(createItem).mockResolvedValue(undefined);
    vi.mocked(updateItem).mockResolvedValue(undefined);
    vi.mocked(setItemLoss).mockResolvedValue(undefined);
    vi.mocked(setOpeningPrice).mockResolvedValue(undefined);
    vi.mocked(listConversions).mockResolvedValue({ baseUnit: 'kg', rows: [] });
    vi.mocked(addConversion).mockResolvedValue(undefined);
    vi.mocked(updateConversion).mockResolvedValue(undefined);
    vi.mocked(deleteConversion).mockResolvedValue(undefined);
    vi.mocked(addCustomUnit).mockImplementation((code) =>
      Promise.resolve(code),
    );
    vi.mocked(listUnitOptions).mockResolvedValue([
      { code: 'كيس', labelAr: 'كيس' },
      { code: 'كرتونة', labelAr: 'كرتونة' },
    ]);
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: 'tok-loss',
      identity: 'kg|ingredient||',
      lossVersions: [],
      conversions: [],
    });
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 0,
      shifts: 0,
      movements: 0,
    });
    vi.mocked(currentShiftStart).mockResolvedValue(null);
    vi.mocked(setBaseMapping).mockResolvedValue(undefined);
    vi.mocked(setOrderTypePackaging).mockResolvedValue(undefined);
    vi.mocked(listRecipes).mockResolvedValue([]);
    vi.mocked(createRecipe).mockResolvedValue('rec-new');
    vi.mocked(updateRecipe).mockResolvedValue(undefined);
    vi.mocked(setRecipeVersion).mockResolvedValue(undefined);
    vi.mocked(loadImportContext).mockResolvedValue({
      stock: [],
      recipes: [],
      batches: [],
      itemUnits: [],
      units: [],
      bindings: [],
      blockBindings: [],
      knownHashes: [],
      shiftStart: null,
    });
    vi.mocked(fetchImportTokens).mockResolvedValue({
      recipes: new Map(),
      losses: new Map(),
    });
    vi.mocked(commitRecipeImport).mockResolvedValue({
      importId: 'imp-1',
      recipes: [],
      counts: {
        items_created: 0,
        recipes_created: 0,
        versions_published: 0,
        recipes_unchanged: 0,
        losses_set: 0,
        losses_unchanged: 0,
        opening_prices_set: 0,
        bindings: 0,
      },
    });
  });

  afterEach(() => {
    setOnline(true);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it('P1-2: CountsPage renders retry control for a local unknown count:stored pin even when server pending list no longer includes it', async () => {
    const storedPayload = {
      request_id: 'req-stored-lost-reply',
      frequency: 'daily',
      counted_at: '2026-10-22T09:00:00.000Z',
      note: null,
      lines: [
        { item_id: 'tilapia', counted_qty: '4', expected_base_unit: 'kg' },
      ],
    };
    putHeldWrite('count:stored:req-stored-lost-reply', {
      requestId: 'req-stored-lost-reply',
      payload: storedPayload,
      phase: 'unknown',
      kind: 'count_stored',
    });
    // Server already committed the count, so listPendingCounts returns [].
    vi.mocked(listPendingCounts).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );

    const resendBtn = await screen.findByRole('button', { name: 'سجّل الجرد' });
    fireEvent.click(resendBtn);
    await waitFor(() => {
      expect(recordStoredCount).toHaveBeenCalledWith(storedPayload);
    });
  });

  it('P2-1: mapping, packaging, and recipes keep posted_reload until their post-write read succeeds', async () => {
    // 1. Mapping SubjectPanel
    let rejectMapReload = true;
    const mapView = render(
      <SubjectPanel
        base={mapBase}
        detail={mapDetail}
        catalog={mapCatalog}
        onReload={() =>
          rejectMapReload
            ? Promise.reject(new Error('reload down'))
            : Promise.resolve()
        }
      />,
    );
    fireEvent.change(screen.getByLabelText('الصنف'), {
      target: { value: 'item-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الربط' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('reload down');
    expect(
      hasPostedReload(baseSubject(mapBase.posItemId, mapBase.sizeKeyText)),
    ).toBe(true);
    rejectMapReload = false;
    mapView.unmount();

    // 2. PackagingEditor
    resetHeldWritesStore({ clearStorage: true });
    const packSubject = orderTypePackagingSubject('takeaway');
    const packView = render(
      <PackagingEditor
        subjectKey={packSubject}
        kind="order_type"
        orderType="takeaway"
        schedule={{
          subjectId: null,
          token: 'p-tok',
          emptyToken: 'p-tok',
          versions: [],
        }}
        history={[]}
        items={[]}
        units={[{ code: 'piece', label: 'قطعة' }]}
        shiftStart={null}
        allowCapacity={false}
        onReload={() => Promise.reject(new Error('pack reload down'))}
      />,
    );
    fireEvent.change(screen.getByLabelText('القرار'), {
      target: { value: 'none' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التغليف' }));
    expect(await screen.findByText('pack reload down')).toBeInTheDocument();
    expect(hasPostedReload(packSubject)).toBe(true);
    packView.unmount();

    // 3. RecipeDetails (onReload resolves null when read fails)
    resetHeldWritesStore({ clearStorage: true });
    const detailsView = render(
      <RecipeDetails
        recipe={sampleRecipe}
        locked={false}
        onBusyChange={() => undefined}
        onReload={() => Promise.resolve(null)}
      />,
    );
    fireEvent.change(screen.getByLabelText('اسم الوصفة'), {
      target: { value: 'طبق جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ البيانات' }));
    await waitFor(() => expect(updateRecipe).toHaveBeenCalledTimes(1));
    expect(hasPostedReload(recipeUpdateSubject(sampleRecipe.id))).toBe(true);
    detailsView.unmount();

    // 4. VersionEditor
    resetHeldWritesStore({ clearStorage: true });
    const versionView = render(
      <VersionEditor
        recipe={sampleRecipe}
        schedule={sampleSchedule}
        catalog={sampleRecipeCatalog}
        locked={false}
        onBusyChange={() => undefined}
        onReload={() => Promise.reject(new Error('ver reload down'))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ضيف مكوّن' }));
    fireEvent.change(screen.getByLabelText('المكوّن 1'), {
      target: { value: 'item:oil' },
    });
    fireEvent.change(screen.getByLabelText('الكمية 1'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ النسخة' }));
    await waitFor(() => expect(setRecipeVersion).toHaveBeenCalledTimes(1));
    expect(hasPostedReload(recipeVersionSubject(sampleRecipe.id))).toBe(true);
    versionView.unmount();
  });

  it('P2-1: ExpensesPage successful read of another month does NOT clear a posted_reload pin for a different month', async () => {
    putHeldWrite('expense:new', {
      requestId: 'req-exp-april',
      payload: null,
      phase: 'posted_reload',
      kind: 'expense',
    });
    // Tag the pin with target month 2030-04-01 directly in storage if supported,
    // or trigger via real save flow on 2030-04!
    resetHeldWritesStore({ clearStorage: true });
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth('2026-11-01'))
      .mockResolvedValueOnce(expenseMonth('2030-04-01'))
      .mockRejectedValueOnce(new Error('april reload failed'))
      .mockResolvedValue(expenseMonth('2026-11-01'));

    const view = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText('الشهر'), {
      target: { value: '2030-04' },
    });
    await waitFor(() =>
      expect(loadExpenseMonth).toHaveBeenCalledWith('2030-04-01'),
    );
    fireEvent.change(await screen.findByLabelText('التصنيف'), {
      target: { value: 'rent' },
    });
    fireEvent.change(screen.getByLabelText('المبلغ'), {
      target: { value: '500' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'april reload failed',
    );
    expect(hasPostedReload('expense:new')).toBe(true);

    // Reload page: opens on default month (not 2030-04) and that month's read succeeds.
    view.unmount();
    rehydrateHeldWrites();
    render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('التصنيف')).toBeInTheDocument(),
    );
    // Reading current month (2026-11-01) MUST NOT clear the 2030-04-01 posted_reload pin!
    expect(hasPostedReload('expense:new')).toBe(true);
  });

  it('P2-2: ItemForm create, RecipesPage create, ConversionsPanel add, and ActivationPage restore retry controls after reload', async () => {
    // 1. ItemForm create after reload
    const draft: ItemDraft = {
      name: 'صنف معلّق',
      kind: 'seafood',
      baseUnit: 'kg',
      countFrequency: 'daily',
      parentItemId: null,
      lossPct: '0',
      active: true,
    };
    const itemSubj = createSubject(draft);
    const itemClaim = await claimFreshAction(itemSubj, (id) => id);
    expect(itemClaim.ok).toBe(true);
    if (!itemClaim.ok) return;
    itemClaim.release();
    settleAction(itemSubj, itemClaim.record.requestId, new Error('socket'));
    rehydrateHeldWrites();

    const onItemSubmit = vi.fn(() => Promise.resolve(true));
    const itemView = render(
      <ItemForm
        items={[]}
        submitting={false}
        serverError={null}
        onClearServerError={() => undefined}
        onSubmit={onItemSubmit}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText(unknownSaveMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(onItemSubmit).toHaveBeenCalledWith({ kind: 'create', draft });
    });
    itemView.unmount();

    // 2. RecipesPage create after reload
    resetHeldWritesStore({ clearStorage: true });
    const recSubj = recipeCreateSubject('وصفة معلقة', 'dish');
    const recClaim = await claimFreshAction(recSubj, (id) => id);
    expect(recClaim.ok).toBe(true);
    if (!recClaim.ok) return;
    recClaim.release();
    settleAction(recSubj, recClaim.record.requestId, new Error('socket'));
    rehydrateHeldWrites();

    const recView = render(
      <MemoryRouter>
        <RecipesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(createRecipe).toHaveBeenCalledWith('وصفة معلقة', 'dish');
    });
    recView.unmount();

    // 3. ConversionsPanel add after reload (without reselecting unit!)
    resetHeldWritesStore({ clearStorage: true });
    vi.mocked(addConversion).mockRejectedValueOnce(new Error('socket'));
    const convView = render(<ConversionsPanel item={oilItem} />);
    expect(
      await screen.findByRole('option', { name: 'كيس' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: 'كيس' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    expect(await screen.findByText(unknownSaveMessage)).toBeInTheDocument();
    convView.unmount();
    rehydrateHeldWrites();

    vi.mocked(addConversion).mockResolvedValueOnce(undefined);
    const convView2 = render(<ConversionsPanel item={oilItem} />);
    expect(
      await screen.findByText(`تحويل كيس — ${unknownSaveMessage}`),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    await waitFor(() => {
      expect(addConversion).toHaveBeenCalledTimes(2);
    });
    convView2.unmount();

    // 4. ActivationPage review reload pin survives reload and retains requestId
    resetHeldWritesStore({ clearStorage: true });
    const hashA = 'a'.repeat(32);
    const hashB = 'b'.repeat(32);
    const review = (hash: string): OpeningReview => ({
      activated: false,
      stockStartedAt: null,
      openingManifestHash: hash,
      canActivate: false,
      checklist: [
        { code: 'not_activated', ready: false, count: '0' },
        { code: 'missing_observations', ready: false, count: '1' },
        { code: 'unreceipted_outflows', ready: true, count: '0' },
        { code: 'empty_roster', ready: true, count: '1' },
      ],
      roster: [
        {
          itemId: 'a7900000-0000-4000-8000-000000000001',
          name: 'سمك',
          baseUnit: 'kg',
          active: true,
          missing: true,
          openingLineCount: '0',
          observation: null,
        },
      ],
      nextItemId: null,
    });
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(review(hashA))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(review(hashA))
      .mockResolvedValue(review(hashB));
    vi.mocked(activateInventory).mockRejectedValueOnce(
      new OpeningManifestChangedError(),
    );

    const actView = render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('button', { name: 'تفعيل الخصم' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'صفر صريح' }));
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل الخصم' }));
    expect(
      await screen.findByRole('button', { name: 'إعادة تحميل المراجعة' }),
    ).toBeInTheDocument();
    const firstReqId =
      vi.mocked(activateInventory).mock.calls[0]?.[0]?.requestId;
    actView.unmount();

    // Real reload promotes inflight -> unknown while awaitingReviewReload is true.
    rehydrateHeldWrites();
    render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'إعادة تحميل المراجعة' }),
    );
    expect(
      await screen.findByText('قائمة الافتتاح اتغيرت — راجعها وفعّل تاني'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'صفر صريح' }));
    vi.mocked(activateInventory).mockResolvedValueOnce({
      activated: true,
      stockStartedAt: '2026-03-01T08:00:00.000Z',
      openingManifestHash: hashB,
    });
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل الخصم' }));
    await waitFor(() => {
      expect(activateInventory).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(activateInventory).mock.calls[1]?.[0]?.requestId).toBe(
      firstReqId,
    );
  });

  it('P2-3: compound conversion stops before addConversion when offline or user changes during addCustomUnit await', async () => {
    let resolveUnit: (code: string) => void = () => undefined;
    vi.mocked(addCustomUnit).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUnit = resolve;
        }),
    );

    render(<ConversionsPanel item={oilItem} />);
    expect(
      await screen.findByRole('option', { name: 'وحدة جديدة' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('الوحدة'), {
      target: { value: '__new__' },
    });
    fireEvent.change(screen.getByLabelText('كود الوحدة'), {
      target: { value: 'box9' },
    });
    fireEvent.change(screen.getByLabelText('اسم الوحدة'), {
      target: { value: 'علبة 9' },
    });
    fireEvent.change(screen.getByLabelText('المعامل'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ضيف التحويل' }));
    await waitFor(() => expect(addCustomUnit).toHaveBeenCalledTimes(1));

    // Go offline while addCustomUnit is in flight.
    act(() => {
      setOnline(false);
    });
    await act(async () => {
      resolveUnit('box9');
      await Promise.resolve();
      await Promise.resolve();
    });
    // addConversion MUST NOT be dispatched while offline!
    expect(addConversion).not.toHaveBeenCalled();
  });

  it('P2-3: UpdateBanner disables update button while auth status is unresolved (loading)', async () => {
    const { resetAuthStore } = await import('@/lib/auth-store');
    resetAuthStore(); // status = 'loading'
    setTestWaitingWorker({ postMessage: vi.fn() } as unknown as ServiceWorker);
    render(<UpdateBanner onReload={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'تحديث التطبيق' }),
    ).toBeDisabled();
  });

  it('P3: CountsPage stores no display itemName in localStorage and ItemsPage/ExpensesPage reload markers store no fake UUID requestId', async () => {
    // 1. CountsPage: localStorage must NOT contain itemName
    vi.mocked(recordCount).mockRejectedValueOnce(new Error('socket'));
    const countView = render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('وقت الجرد')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('وقت الجرد'), {
      target: { value: '2026-10-22T12:00' },
    });
    fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(1));
    const storedCountRaw = Object.keys(localStorage)
      .map((k) => localStorage.getItem(k) ?? '')
      .join('\n');
    expect(storedCountRaw).not.toContain('itemName');
    expect(storedCountRaw).not.toContain('بلطي');
    countView.unmount();

    // 2. Request-less writers (ItemsPage updateItem & ExpensesPage setMonthExpenseComplete)
    // stay outside the held-write store and never write to localStorage.
    localStorage.clear();
    resetHeldWritesStore({ clearStorage: true });
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockRejectedValueOnce(new Error('catalog down'));
    const itemsView = render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت جديد' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    expect(await screen.findByText('catalog down')).toBeInTheDocument();
    expect(hasAnyHeldWrite()).toBe(false);
    expect(localStorage.length).toBe(0);
    itemsView.unmount();

    localStorage.clear();
    resetHeldWritesStore({ clearStorage: true });
    vi.mocked(loadExpenseMonth)
      .mockResolvedValueOnce(expenseMonth('2026-11-01'))
      .mockRejectedValueOnce(new Error('expense reload down'));
    const expView = render(
      <MemoryRouter>
        <ExpensesPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'مصاريف الشهر كاملة' }),
    );
    expect(await screen.findByText('expense reload down')).toBeInTheDocument();
    expect(hasAnyHeldWrite()).toBe(false);
    expect(localStorage.length).toBe(0);
    expView.unmount();
  });

  it('P2-1: RecipeImportPage keeps posted_reload pin until reload succeeds', async () => {
    vi.mocked(commitRecipeImport).mockResolvedValueOnce({
      importId: 'imp-1',
      recipes: [],
      counts: {
        items_created: 1,
        recipes_created: 0,
        versions_published: 0,
        recipes_unchanged: 0,
        losses_set: 0,
        losses_unchanged: 0,
        opening_prices_set: 0,
        bindings: 0,
      },
    });
    // Pre-seed an unknown import action so we can trigger retry -> success -> failed reload.
    putHeldWrite(recipeImportSubject, {
      requestId: 'req-import-1',
      payload: { requestId: 'req-import-1', payload: {} },
      phase: 'unknown',
      kind: 'action',
    });
    vi.mocked(loadImportContext)
      .mockResolvedValueOnce({
        stock: [],
        recipes: [],
        batches: [],
        itemUnits: [],
        units: [],
        bindings: [],
        blockBindings: [],
        knownHashes: [],
        shiftStart: null,
      })
      .mockRejectedValueOnce(new Error('import reload down'));

    render(
      <MemoryRouter>
        <RecipeImportPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'إعادة المحاولة' }),
    );
    expect(await screen.findByText('import reload down')).toBeInTheDocument();
    expect(hasPostedReload(recipeImportSubject)).toBe(true);
    expect(getHeldWrite(recipeImportSubject)?.phase).toBe('posted_reload');
  });
});
