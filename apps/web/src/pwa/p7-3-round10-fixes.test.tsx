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
import { loadOpeningReview } from '@/accounting/api';
import { ACTIVATION_SUBJECT } from '@/accounting/activation-action';
import type { OpeningReview } from '@/accounting/types';
import {
  addConversion,
  addCustomUnit,
  costingImpact,
  createItem,
  currentShiftStart,
  deleteConversion,
  getItemById,
  listConversions,
  listCostingSchedule,
  listItems,
  listUnitOptions,
  setItemLoss,
  setOpeningPrice,
  updateConversion,
  updateItem,
} from '@/items/api';
import { ConfirmedRefusalError } from '@/items/errors';
import { emptyScheduleToken } from '@/items/effective';
import {
  conversionSubject,
  ITEMS_RELOAD_SUBJECT,
  lossSubject,
  resetHeldWrites,
} from '@/items/request-id';
import type { CatalogItem, DatedWrite } from '@/items/types';
import {
  createHeldWriteStore,
  getHeldWrite,
  hasAnyHeldWrite,
  HeldWriteStorageError,
  putHeldWrite,
  resetHeldWritesStore,
  setHeldWriteUser,
  userStoragePrefix,
} from '@/lib/held-writes';
import {
  applyPwaUpdate,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import { ActivationPage } from '@/pages/ActivationPage';
import { ItemsPage } from '@/pages/ItemsPage';

vi.mock('@/items/api', () => ({
  ITEMS_RELOAD_SUBJECT: 'items:reload',
  listItems: vi.fn(),
  getItemById: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  setItemLoss: vi.fn(),
  setOpeningPrice: vi.fn(),
  listConversions: vi.fn(),
  addConversion: vi.fn(),
  updateConversion: vi.fn(),
  deleteConversion: vi.fn(),
  currentShiftStart: vi.fn(),
  listCostingSchedule: vi.fn(),
  costingImpact: vi.fn(),
  listUnitOptions: vi.fn(),
  addCustomUnit: vi.fn(),
}));

vi.mock('@/accounting/api', () => ({
  loadOpeningReview: vi.fn(),
  activateInventory: vi.fn(),
}));

const oilItem: CatalogItem = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'liter',
  countFrequency: 'daily',
  lossPct: 0,
  lossFractionText: '0',
  identityLocked: false,
  openingPriceId: 'op-1',
  openingPriceText: '50',
  parentItemId: null,
  active: true,
  onHandQty: 10,
  avgCost: 50,
  onHandValue: 500,
};

const boxItem: CatalogItem = {
  id: 'box',
  name: 'علبة',
  kind: 'packaging',
  baseUnit: 'piece',
  countFrequency: 'weekly',
  lossPct: 0,
  lossFractionText: '0',
  identityLocked: false,
  openingPriceId: null,
  openingPriceText: null,
  parentItemId: null,
  active: true,
  onHandQty: 0,
  avgCost: 0,
  onHandValue: 0,
};

function makeFakeLocks() {
  const held = new Set<string>();
  const locks = {
    async request<T>(
      name: string,
      options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
      callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
    ): Promise<T> {
      if (held.has(name)) {
        if (options.ifAvailable) return await callback(null);
        throw new Error('unexpected blocking lock');
      }
      held.add(name);
      try {
        return await callback({ name, mode: options.mode ?? 'exclusive' });
      } finally {
        held.delete(name);
      }
    },
    query() {
      return Promise.resolve({
        held: [...held].map((name) => ({ name, mode: 'exclusive' })),
      });
    },
  };
  return { held, locks };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: online,
  });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

function makeReview(hash: string): OpeningReview {
  return {
    activated: false,
    stockStartedAt: null,
    canActivate: true,
    openingManifestHash: hash,
    checklist: [
      {
        code: 'unreceipted_outflows',
        ready: true,
        count: '0',
      },
    ],
    roster: [
      {
        itemId: 'oil',
        name: 'زيت',
        baseUnit: 'liter',
        active: true,
        missing: false,
        openingLineCount: '1',
        observation: {
          openingId: 'op-1',
          lineNo: '1',
          quantity: '10',
          unit: 'liter',
          unitCost: '50',
          occurredAt: '2026-10-01T00:00:00.000Z',
          explicitZero: false,
        },
      },
    ],
    nextItemId: null,
  };
}

describe('P7-3 round-10 review fixes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    localStorage.clear();
    resetHeldWrites();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetPwaState();
    setPwaAuthResolved(true);
    setHeldWriteUser('owner-r10');
    setOnline(true);

    vi.mocked(listItems).mockResolvedValue([oilItem, boxItem]);
    vi.mocked(getItemById).mockImplementation((id: string) =>
      Promise.resolve([oilItem, boxItem].find((row) => row.id === id) ?? null),
    );
    vi.mocked(currentShiftStart).mockResolvedValue(null);
    vi.mocked(listCostingSchedule).mockImplementation((itemId) =>
      Promise.resolve({
        lossToken: emptyScheduleToken,
        identity: itemId === 'box' ? 'piece|packaging||' : 'liter|ingredient||',
        lossVersions: [],
        conversions: [],
      }),
    );
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 0,
      shifts: 0,
      movements: 0,
    });
    vi.mocked(listUnitOptions).mockResolvedValue([
      { code: 'كرتونة', labelAr: 'كرتونة' },
    ]);
    vi.mocked(listConversions).mockImplementation((itemId) =>
      Promise.resolve({
        baseUnit: itemId === 'box' ? 'piece' : 'liter',
        rows: [],
      }),
    );
    vi.mocked(createItem).mockResolvedValue(undefined);
    vi.mocked(updateItem).mockResolvedValue(undefined);
    vi.mocked(setItemLoss).mockResolvedValue(undefined);
    vi.mocked(setOpeningPrice).mockResolvedValue(undefined);
    vi.mocked(addConversion).mockResolvedValue(undefined);
    vi.mocked(updateConversion).mockResolvedValue(undefined);
    vi.mocked(deleteConversion).mockResolvedValue(undefined);
    vi.mocked(addCustomUnit).mockImplementation((code) =>
      Promise.resolve(code),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetHeldWritesStore({ clearStorage: true, resetUser: true });
    resetPwaState();
    localStorage.clear();
    setOnline(true);
  });

  it('R10-Root-a: Older mount catalog listItems response cannot overwrite a row already applied by a newer combined by-id read', async () => {
    putHeldWrite(lossSubject('oil'), {
      requestId: 'req-loss-r10a',
      payload: null,
      phase: 'posted_reload',
      kind: 'action',
      readTarget: 'oil',
    });

    let resolveMountCatalog!: (rows: CatalogItem[]) => void;
    vi.mocked(listItems).mockImplementationOnce(
      () =>
        new Promise<CatalogItem[]>((resolve) => {
          resolveMountCatalog = resolve;
        }),
    );
    vi.mocked(getItemById).mockResolvedValueOnce({
      ...oilItem,
      name: 'زيت محدث من التحقق',
      lossPct: 0.1,
      lossFractionText: '0.1',
      identityLocked: true,
    });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    // Combined read finishes FIRST and applies the fresh 'oil' row + clears pin.
    await waitFor(() => {
      expect(getHeldWrite(lossSubject('oil'))).toBeNull();
    });
    expect(
      await screen.findByRole('heading', { name: 'زيت محدث من التحقق' }),
    ).toBeInTheDocument();
    expect(screen.getByText('فاقد 10%')).toBeInTheDocument();

    // Now the OLDER mount catalog load resolves with STALE 'oil' + fresh 'box'.
    await act(async () => {
      resolveMountCatalog([
        { ...oilItem, name: 'زيت قديم من القائمة', lossPct: 0 },
        boxItem,
      ]);
      await Promise.resolve();
    });

    // 'box' from the catalog is added, while 'oil' keeps the NEWER by-id row!
    expect(
      await screen.findByRole('heading', { name: 'علبة' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'زيت محدث من التحقق' }),
    ).toBeInTheDocument();
    expect(screen.getByText('فاقد 10%')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'زيت قديم من القائمة' }),
    ).not.toBeInTheDocument();
  });

  it('R10-Root-b: Combined read updates item row + schedule + conversions across mounted ItemForm & ConversionsPanel, preserves unsaved form draft baseline with a fresh-data notice, and syncs baseline when clean', async () => {
    const savedRows: Array<{
      itemId: string;
      unit: string;
      factorToBase: number;
      storedFactor: string;
    }> = [];
    let currentLossToken = emptyScheduleToken;

    vi.mocked(listItems).mockResolvedValue([oilItem]);
    vi.mocked(listConversions).mockImplementation(() =>
      Promise.resolve({ baseUnit: 'liter', rows: [...savedRows] }),
    );
    vi.mocked(listCostingSchedule).mockImplementation(() =>
      Promise.resolve({
        lossToken: currentLossToken,
        identity: 'liter|ingredient||',
        lossVersions: [],
        conversions: [],
      }),
    );
    vi.mocked(addConversion).mockImplementation((itemId, unit, factor) => {
      savedRows.push({
        itemId,
        unit,
        factorToBase: Number(factor),
        storedFactor: factor,
      });
      currentLossToken = 'tok-loss-v2';
      return Promise.resolve();
    });
    vi.mocked(getItemById).mockResolvedValue({
      ...oilItem,
      name: 'زيت من جهاز تاني',
      identityLocked: true,
    });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    await within(card).findByRole('option', { name: 'كرتونة' });

    // User has an UNSAVED details edit in ItemForm!
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت مسودة' },
    });

    const scheduleCallsBeforeConv =
      vi.mocked(listCostingSchedule).mock.calls.length;

    // User adds a conversion -> combined read returns fresh item name ('زيت من جهاز تاني') + new schedule token ('tok-loss-v2') + conversion row.
    fireEvent.change(within(card).getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(within(card).getByLabelText('المعامل'), {
      target: { value: '12' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'ضيف التحويل' }));

    expect(
      await within(card).findByText('1 كرتونة = 12 لتر'),
    ).toBeInTheDocument();

    // 1. ItemForm MUST keep the user's unsaved draft AND NOT silently overwrite it or its CAS baseline!
    expect(screen.getByLabelText('الاسم')).toHaveValue('زيت مسودة');
    // 2. ItemForm MUST show a fresh-data-available notice (not silently merge!).
    expect(await screen.findByText(/نسخة أحدث/)).toBeInTheDocument();
    // 3. ItemForm MUST already have the updated schedule ('tok-loss-v2') from the combined read without extra reads!
    expect(vi.mocked(listCostingSchedule).mock.calls.length).toBe(
      scheduleCallsBeforeConv + 1,
    );
    // 4. Saving details right now MUST still send the draft's ORIGINAL baseline ('زيت'), NOT 'زيت من جهاز تاني'!
    vi.mocked(updateItem).mockRejectedValueOnce(
      new ConfirmedRefusalError('مرفوض مؤقتاً'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(updateItem).mock.calls[0]?.[2]).toMatchObject({
      name: 'زيت',
    });

    // 5. Explicit adopt button loads the fresh server row ('زيت من جهاز تاني') and clears the notice.
    const adoptBtn = await screen.findByRole('button', {
      name: 'تحميل أحدث بيانات',
    });
    fireEvent.click(adoptBtn);
    await waitFor(() => {
      expect(screen.getByLabelText('الاسم')).toHaveValue('زيت من جهاز تاني');
    });
    expect(screen.queryByText(/نسخة أحدث/)).not.toBeInTheDocument();

    // 6. Clean form (no unsaved detail edits): next combined read updates form value + CAS baseline automatically in one transition!
    vi.mocked(getItemById).mockResolvedValueOnce({
      ...oilItem,
      name: 'زيت متزامن نظيف',
      lossPct: 0.1,
      lossFractionText: '0.1',
      identityLocked: true,
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => {
      expect(screen.getByLabelText('الاسم')).toHaveValue('زيت متزامن نظيف');
    });
    expect(screen.queryByText(/نسخة أحدث/)).not.toBeInTheDocument();

    // Verify CAS baseline also updated to 'زيت متزامن نظيف'!
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'زيت بعد المزامنة' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => {
      expect(updateItem).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(updateItem).mock.calls[1]?.[2]).toMatchObject({
      name: 'زيت متزامن نظيف',
    });
  });

  it('R10-Root-c: Superseded older combined read cannot apply stale data or clear its posted_reload pin', async () => {
    let resolveConvMount!: (value: {
      baseUnit: 'kg' | 'liter' | 'piece';
      rows: [];
    }) => void;
    let resolveOlderCombined!: (value: CatalogItem | null) => void;
    let rejectNewerCatalog!: (error: Error) => void;

    let listCalls = 0;
    vi.mocked(listItems).mockImplementation(() => {
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve([oilItem]);
      return new Promise<CatalogItem[]>((_resolve, reject) => {
        rejectNewerCatalog = reject;
      });
    });
    vi.mocked(listConversions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConvMount = resolve;
        }),
    );
    let byIdCalls = 0;
    vi.mocked(getItemById).mockImplementation(() => {
      byIdCalls += 1;
      if (byIdCalls === 1) {
        return new Promise<CatalogItem | null>((resolve) => {
          resolveOlderCombined = resolve;
        });
      }
      return Promise.resolve({
        ...oilItem,
        name: 'زيت بعد التحقق الجديد',
        lossPct: 0.1,
        lossFractionText: '0.1',
      });
    });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    await waitFor(() =>
      expect(listCostingSchedule).toHaveBeenCalledWith('oil'),
    );
    // Also open ConversionsPanel (its initial listConversions stays pending without marking conversionsBusy).
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));

    // Save loss -> post-save combined read #1 starts!
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => expect(byIdCalls).toBe(1));

    // While combined read #1 is pending, ConversionsPanel's mount snapshot resolves with stale baseUnit 'kg'
    // -> triggers onItemStale('oil') -> starts a NEWER catalog read (listCalls === 2)!
    await act(async () => {
      resolveConvMount({ baseUnit: 'kg', rows: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(listCalls).toBe(2));

    // The newer catalog read fails, then the OLDER combined read #1 resolves with stale data.
    await act(async () => {
      rejectNewerCatalog(new Error('newer catalog failed'));
      resolveOlderCombined({
        ...oilItem,
        name: 'زيت متأخر قديم',
        lossPct: 0.1,
      });
      await Promise.resolve();
    });

    // Superseded combined read #1 MUST NOT apply 'زيت متأخر قديم' AND MUST NOT clear the loss pin!
    expect(
      screen.queryByRole('heading', { name: 'زيت متأخر قديم' }),
    ).not.toBeInTheDocument();
    expect(getHeldWrite(lossSubject('oil'))?.phase).toBe('posted_reload');
    expect(hasAnyHeldWrite()).toBe(true);

    // Clicking read-only retry runs a fresh non-superseded combined read -> applies & clears pin!
    fireEvent.click(await screen.findByRole('button', { name: 'تحقق تاني' }));
    await waitFor(() => {
      expect(getHeldWrite(lossSubject('oil'))).toBeNull();
    });
    expect(
      await screen.findByRole('heading', { name: 'زيت بعد التحقق الجديد' }),
    ).toBeInTheDocument();
  });

  it('R10-1a: Storage failure after successful loss RPC keeps acknowledgement, settles through combined read, and shows read-only recovery when combined read fails', async () => {
    const reload = vi.fn();
    const postMessage = vi.fn();
    setTestWaitingWorker({ postMessage } as unknown as ServiceWorker);

    let capturedLossReqId = '';
    const origSetItem = Storage.prototype.setItem.bind(localStorage);
    let failStorageWrites = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
      (key: string, value: string) => {
        if (failStorageWrites) {
          throw new Error('QuotaExceededError');
        }
        origSetItem(key, value);
      },
    );

    vi.mocked(setItemLoss).mockImplementation(
      (_id: string, _lossPct: string, write: DatedWrite) => {
        capturedLossReqId = write.requestId;
        // RPC commits on server, THEN storage fails when persisting posted_reload!
        failStorageWrites = true;
        return Promise.resolve();
      },
    );
    vi.mocked(listItems).mockResolvedValue([oilItem]);
    vi.mocked(getItemById)
      .mockRejectedValueOnce(new Error('combined read down after quota'))
      .mockResolvedValueOnce({
        ...oilItem,
        lossPct: 0.1,
        lossFractionText: '0.1',
        identityLocked: true,
      });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تعديل' }));
    await waitFor(() =>
      expect(listCostingSchedule).toHaveBeenCalledWith('oil'),
    );
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));

    await waitFor(() => expect(setItemLoss).toHaveBeenCalledTimes(1));
    // Combined read MUST still have been attempted after the RPC succeeded despite storage failure!
    await waitFor(() => expect(getItemById).toHaveBeenCalledWith('oil'));

    // Because combined read failed, the page MUST keep writes locked, block PWA update,
    // keep the durable inflight pin in localStorage, and show read-only recovery ("تحقق تاني")!
    expect(hasAnyHeldWrite()).toBe(true);
    expect(applyPwaUpdate(reload, { authResolved: true })).toBe(false);
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();
    const verifyBtn = await screen.findByRole('button', { name: 'تحقق تاني' });
    expect(verifyBtn).toBeEnabled();

    const activeKey = `${userStoragePrefix('owner-r10')}${encodeURIComponent(lossSubject('oil'))}`;
    expect(localStorage.getItem(activeKey)).toContain(capturedLossReqId);

    // Clicking read-only recovery runs combined read -> succeeds -> settles & clears the exact pin WITHOUT re-sending setItemLoss!
    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(hasAnyHeldWrite()).toBe(false);
    });
    expect(localStorage.getItem(activeKey)).toBeNull();
    expect(setItemLoss).toHaveBeenCalledTimes(1);
    expect(screen.getByText('فاقد 10%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
  });

  it('R10-1b: Storage failure after successful conversion RPC keeps acknowledgement and settles through combined read / read-only recovery', async () => {
    const origSetItem = Storage.prototype.setItem.bind(localStorage);
    let failStorageWrites = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(
      (key: string, value: string) => {
        if (failStorageWrites) {
          throw new Error('QuotaExceededError');
        }
        origSetItem(key, value);
      },
    );

    vi.mocked(listItems).mockResolvedValue([boxItem]);
    vi.mocked(addConversion).mockImplementation(() => {
      failStorageWrites = true;
      return Promise.resolve();
    });
    vi.mocked(getItemById)
      .mockRejectedValueOnce(new Error('conv combined read failed'))
      .mockResolvedValueOnce({ ...boxItem, identityLocked: true });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'علبة' });
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    await within(card).findByRole('option', { name: 'كرتونة' });

    fireEvent.change(within(card).getByLabelText('الوحدة'), {
      target: { value: 'كرتونة' },
    });
    fireEvent.change(within(card).getByLabelText('المعامل'), {
      target: { value: '12' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'ضيف التحويل' }));

    await waitFor(() => expect(addConversion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getItemById).toHaveBeenCalledWith('box'));

    const verifyBtn = await screen.findByRole('button', { name: 'تحقق تاني' });
    expect(hasAnyHeldWrite()).toBe(true);
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeDisabled();

    fireEvent.click(verifyBtn);
    await waitFor(() => {
      expect(hasAnyHeldWrite()).toBe(false);
    });
    expect(addConversion).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'ضيف صنف' })).toBeEnabled();
  });

  it('R10-2a: setHeldWritePhase and updateHeldWritePayload require holding subject Web Lock and fail closed on storage read error', async () => {
    const { held, locks } = makeFakeLocks();
    const tab1 = createHeldWriteStore({ getLocks: () => locks });
    const tab2 = createHeldWriteStore({ getLocks: () => locks });
    try {
      tab1.setHeldWriteUser('user-lock');
      tab2.setHeldWriteUser('user-lock');

      const claim = await tab1.claimFreshHeldWrite(
        'purchase:new',
        (requestId) => ({ requestId, total: 50 }),
        { kind: 'purchase' },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      const reqId = claim.record.requestId;

      // 1. Tab 2 does NOT hold the subject Web Lock -> MUST refuse to rewrite storage!
      expect(() =>
        tab2.setHeldWritePhase('purchase:new', reqId, 'unknown'),
      ).toThrow();
      expect(() =>
        tab2.updateHeldWritePayload('purchase:new', reqId, {
          requestId: reqId,
          total: 999,
        }),
      ).toThrow();
      const key = `${userStoragePrefix('user-lock')}${encodeURIComponent('purchase:new')}`;
      expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({
        phase: 'inflight',
        payload: { requestId: reqId, total: 50 },
      });

      // 2. Even while Tab 1 holds the lock, a storage READ error MUST NOT fall back to memory or rewrite storage!
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
      const getItemSpy = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation(() => {
          throw new Error('SecurityError: storage read blocked');
        });
      expect(() =>
        tab1.setHeldWritePhase('purchase:new', reqId, 'unknown'),
      ).toThrow(HeldWriteStorageError);
      expect(() =>
        tab1.updateHeldWritePayload('purchase:new', reqId, {
          requestId: reqId,
          total: 75,
        }),
      ).toThrow(HeldWriteStorageError);
      expect(setItemSpy).not.toHaveBeenCalled();

      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
      claim.release();
      await Promise.resolve();
      expect(held.size).toBe(0);
    } finally {
      tab1.dispose();
      tab2.dispose();
    }
  });

  it('R10-2b: ActivationPage reload-pending path acquires the subject Web Lock before rewriting activation payload', async () => {
    const { held, locks } = makeFakeLocks();
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });
    try {
      const reqId = 'req-act-r10';
      putHeldWrite(ACTIVATION_SUBJECT, {
        requestId: reqId,
        payload: {
          requestId: reqId,
          manifestHash: 'a'.repeat(32),
          explicitZeroItemIds: [],
        },
        phase: 'inflight',
        kind: 'action',
        awaitingReviewReload: true,
      });
      vi.mocked(loadOpeningReview)
        .mockResolvedValueOnce(makeReview('a'.repeat(32)))
        .mockResolvedValueOnce(makeReview('b'.repeat(32)));

      render(
        <MemoryRouter>
          <ActivationPage />
        </MemoryRouter>,
      );

      const reloadBtn = await screen.findByRole('button', {
        name: 'إعادة تحميل المراجعة',
      });

      // Hold the activation subject lock from another tab!
      const lockName = `${userStoragePrefix('owner-r10')}${encodeURIComponent(ACTIVATION_SUBJECT)}`;
      held.add(lockName);

      fireEvent.click(reloadBtn);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // Because another tab holds the Web Lock, ActivationPage MUST NOT rewrite the activation pin!
      const stored = JSON.parse(localStorage.getItem(lockName) ?? '{}') as {
        payload?: { manifestHash?: string };
        awaitingReviewReload?: boolean;
      };
      expect(stored.payload?.manifestHash).toBe('a'.repeat(32));
      expect(stored.awaitingReviewReload).toBe(true);

      // Once the other tab releases the lock, clicking reload succeeds under the Web Lock!
      held.delete(lockName);
      fireEvent.click(reloadBtn);
      await waitFor(() => {
        const updated = JSON.parse(localStorage.getItem(lockName) ?? '{}') as {
          payload?: { manifestHash?: string };
        };
        expect(updated.payload?.manifestHash).toBe('b'.repeat(32));
      });
      expect(held.size).toBe(0);
    } finally {
      if (origLocks) {
        Object.defineProperty(navigator, 'locks', origLocks);
      } else {
        delete (navigator as unknown as { locks?: unknown }).locks;
      }
    }
  });

  it('R10-3: Round-8-format loss and conversion pins derive itemId from subject, are not prematurely cleared by listItems, and clear after combined reads succeed', async () => {
    const prefix = userStoragePrefix('owner-r10');
    const lossSubj = lossSubject('oil');
    const convSubj = conversionSubject('box', 'كرتونة');

    // Seed raw Round-8-format posted_reload pins directly into localStorage!
    localStorage.setItem(
      `${prefix}posted:${encodeURIComponent(lossSubj)}:${encodeURIComponent('req-r8-loss')}`,
      JSON.stringify({
        v: 1,
        subject: lossSubj,
        requestId: 'req-r8-loss',
        payload: null,
        phase: 'posted_reload',
        kind: 'action',
        readTarget: ITEMS_RELOAD_SUBJECT,
        readTargets: [lossSubj, ITEMS_RELOAD_SUBJECT],
      }),
    );
    localStorage.setItem(
      `${prefix}posted:${encodeURIComponent(convSubj)}:${encodeURIComponent('req-r8-conv')}`,
      JSON.stringify({
        v: 1,
        subject: convSubj,
        requestId: 'req-r8-conv',
        payload: null,
        phase: 'posted_reload',
        kind: 'action',
        readTarget: ITEMS_RELOAD_SUBJECT,
        readTargets: ['box', ITEMS_RELOAD_SUBJECT],
      }),
    );
    resetHeldWritesStore({ clearStorage: false, resetUser: false });
    setHeldWriteUser('owner-r10');

    // First combined reads fail while catalog listItems succeeds -> pins MUST NOT be cleared by listItems!
    vi.mocked(listItems).mockResolvedValue([oilItem, boxItem]);
    vi.mocked(getItemById)
      .mockRejectedValueOnce(new Error('oil combined fail'))
      .mockRejectedValueOnce(new Error('box combined fail'))
      .mockResolvedValueOnce({ ...oilItem, lossPct: 0.1 })
      .mockResolvedValueOnce({ ...boxItem, identityLocked: true });

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getItemById).toHaveBeenCalledWith('oil');
      expect(getItemById).toHaveBeenCalledWith('box');
    });
    expect(getItemById).not.toHaveBeenCalledWith(ITEMS_RELOAD_SUBJECT);
    expect(getItemById).not.toHaveBeenCalledWith(lossSubj);

    // Even though listItems() succeeded, the Round-8 pins MUST still be held until combined reads succeed!
    expect(getHeldWrite(lossSubj)?.phase).toBe('posted_reload');
    expect(getHeldWrite(convSubj)?.phase).toBe('posted_reload');
    expect(hasAnyHeldWrite()).toBe(true);

    // Clicking read-only retry runs combined reads for 'oil' and 'box' -> succeeds -> BOTH legacy pins clear!
    const verifyBtn = await screen.findByRole('button', { name: 'تحقق تاني' });
    fireEvent.click(verifyBtn);

    await waitFor(() => {
      expect(getHeldWrite(lossSubj)).toBeNull();
      expect(getHeldWrite(convSubj)).toBeNull();
    });
    expect(hasAnyHeldWrite()).toBe(false);
    expect(localStorage.length).toBe(0);
  });
});
