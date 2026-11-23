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
import { activateInventory, loadOpeningReview } from '@/accounting/api';
import { ACTIVATION_SUBJECT } from '@/accounting/activation-action';
import type { OpeningReview } from '@/accounting/types';
import {
  listCounts,
  listDailyItems,
  listPendingCounts,
  recordStoredCount,
} from '@/counts/api';
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
  clearPostedReload,
  claimFreshHeldWrite,
  getHeldWrite,
  hasAnyHeldWrite,
  HeldWriteStorageError,
  putHeldWrite,
  resetHeldWritesStore,
  setHeldWritePhase,
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
import { CountsPage } from '@/pages/CountsPage';
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

vi.mock('@/counts/api', () => ({
  listCounts: vi.fn(),
  listDailyItems: vi.fn(),
  listPendingCounts: vi.fn(),
  recordCount: vi.fn(),
  recordStoredCount: vi.fn(),
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
  const waiters = new Map<string, Array<() => void>>();
  const locks = {
    async request<T>(
      name: string,
      options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
      callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
    ): Promise<T> {
      while (held.has(name)) {
        if (options.ifAvailable) return await callback(null);
        await new Promise<void>((resolve) => {
          const pending = waiters.get(name) ?? [];
          pending.push(resolve);
          waiters.set(name, pending);
        });
      }
      held.add(name);
      try {
        return await callback({ name, mode: options.mode ?? 'exclusive' });
      } finally {
        held.delete(name);
        const pending = waiters.get(name) ?? [];
        waiters.delete(name);
        for (const resume of pending) resume();
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

  it.each(['reclaimed', 'reclaimed and released', 'unreadable'] as const)(
    'R11-1: acknowledgement cleanup preserves a %s inflight pin',
    async (scenario) => {
      const { locks } = makeFakeLocks();
      vi.stubGlobal('navigator', { onLine: true, locks });
      const other = createHeldWriteStore({ getLocks: () => locks });
      other.setHeldWriteUser('owner-r10');
      const subject = lossSubject('oil');
      const key = `${userStoragePrefix('owner-r10')}${encodeURIComponent(subject)}`;
      const claim = await claimFreshHeldWrite(subject, () => ({ loss: '10' }));
      if (!claim.ok) throw new Error('expected a fresh claim');
      const { requestId } = claim.record;
      const write = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementationOnce(() => {
          throw new Error('quota');
        });
      expect(() =>
        setHeldWritePhase(subject, requestId, 'posted_reload', {
          readTarget: 'oil',
        }),
      ).toThrow(HeldWriteStorageError);
      write.mockRestore();
      claim.release();
      await Promise.resolve();
      try {
        if (scenario !== 'unreadable') {
          const replay = await other.claimReplayHeldWrite(subject, requestId);
          if (!replay.ok) throw new Error('expected another tab to reclaim');
          try {
            if (scenario === 'reclaimed and released') {
              replay.release();
              await Promise.resolve();
            }
            const settled = clearPostedReload(subject, 'oil', requestId);
            if (scenario === 'reclaimed') {
              await Promise.resolve();
              expect(localStorage.getItem(key)).toContain(requestId);
              replay.release();
            }
            await settled;
            expect(localStorage.getItem(key)).not.toBeNull();
            expect(localStorage.getItem(key)).toContain(requestId);
          } finally {
            replay.release();
          }
        } else {
          const read = vi
            .spyOn(Storage.prototype, 'getItem')
            .mockImplementation(() => {
              throw new Error('read failed');
            });
          try {
            await expect(
              Promise.resolve().then(() =>
                clearPostedReload(subject, 'oil', requestId),
              ),
            ).rejects.toThrow(HeldWriteStorageError);
          } finally {
            read.mockRestore();
          }
          expect(localStorage.getItem(key)).toContain(requestId);
        }
      } finally {
        other.dispose();
        vi.unstubAllGlobals();
      }
    },
  );

  it('R11-2: an older conversion panel read cannot start a catalog reload during loss verification', async () => {
    let resolvePanel!: (
      value: Awaited<ReturnType<typeof listConversions>>,
    ) => void;
    let resolveVerify!: (value: CatalogItem) => void;
    vi.mocked(listConversions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePanel = resolve;
        }),
    );
    vi.mocked(getItemById).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveVerify = resolve;
        }),
    );
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
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => expect(getItemById).toHaveBeenCalledWith('oil'));
    await act(async () => {
      resolvePanel({ baseUnit: 'kg', rows: [] });
      await Promise.resolve();
    });
    await act(async () => {
      resolveVerify({ ...oilItem, lossPct: 0.1, lossFractionText: '0.1' });
      await Promise.resolve();
    });
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(getHeldWrite(lossSubject('oil'))).toBeNull();
  });

  it('R11-3a: acknowledged details save displays the readback rename with its baseline', async () => {
    const renamed = { ...oilItem, name: 'اسم من تبويب تاني' };
    vi.mocked(getItemById).mockResolvedValue(renamed);
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    const name = screen.getByLabelText('الاسم');
    fireEvent.change(name, { target: { value: 'الاسم اللي اتبعت' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await screen.findByRole('article', { name: renamed.name });
    expect(name).toHaveValue(renamed.name);
  });

  it('R11-3b: background identity refresh preserves a dirty draft and its baseline', async () => {
    let resolvePanel!: (
      value: Awaited<ReturnType<typeof listConversions>>,
    ) => void;
    const renamed = {
      ...oilItem,
      name: 'اسم من السيرفر',
      baseUnit: 'kg' as const,
    };
    vi.mocked(listConversions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePanel = resolve;
        }),
    );
    vi.mocked(listItems)
      .mockResolvedValueOnce([oilItem])
      .mockResolvedValue([renamed]);
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
    fireEvent.change(screen.getByLabelText('الاسم'), {
      target: { value: 'مسودة' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    await waitFor(() => expect(listConversions).toHaveBeenCalledWith('oil'));
    await act(async () => {
      resolvePanel({ baseUnit: 'kg', rows: [] });
      await Promise.resolve();
    });
    await screen.findByRole('article', { name: renamed.name });
    expect(screen.getByLabelText('الاسم')).toHaveValue('مسودة');
    expect(screen.getByText(/نسخة أحدث/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ البيانات' }));
    await waitFor(() => expect(updateItem).toHaveBeenCalled());
    expect(vi.mocked(updateItem).mock.calls[0]?.[2]).toMatchObject({
      name: oilItem.name,
      baseUnit: oilItem.baseUnit,
    });
  });

  it('R11-4: failed durable lookup after loss acknowledgement enables read-only recovery', async () => {
    const originalRead = localStorage.getItem.bind(localStorage);
    const key = `${userStoragePrefix('owner-r10')}${encodeURIComponent(lossSubject('oil'))}`;
    let failRead = false;
    const reads = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation((readKey) => {
        if (failRead && readKey === key)
          throw new Error('cannot read active pin');
        return originalRead(readKey);
      });
    vi.mocked(setItemLoss).mockImplementation(() => {
      failRead = true;
      return Promise.resolve();
    });
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    fireEvent.click(
      within(await screen.findByRole('article', { name: 'زيت' })).getByRole(
        'button',
        { name: 'تعديل' },
      ),
    );
    await waitFor(() =>
      expect(listCostingSchedule).toHaveBeenCalledWith('oil'),
    );
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    const verify = await screen.findByRole('button', { name: 'تحقق تاني' });
    expect(originalRead(key)).toContain('inflight');
    reads.mockRestore();
    fireEvent.click(verify);
    await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
    expect(setItemLoss).toHaveBeenCalledTimes(1);
  });

  it('R11-5: a legacy conversion pin targeting its subject clears after verification', async () => {
    const subject = conversionSubject('box', 'كرتونة');
    putHeldWrite(subject, {
      requestId: 'legacy-conversion',
      phase: 'posted_reload',
      readTarget: subject,
      payload: null,
    });
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    await screen.findByRole('article', { name: 'علبة' });
    expect(getItemById).toHaveBeenCalledWith('box');
    await waitFor(() => expect(getHeldWrite(subject)).toBeNull());
  });

  it('R11-7: a stale activation review cannot replace a payload dispatched by a different tab', async () => {
    const { locks } = makeFakeLocks();
    vi.stubGlobal('navigator', { onLine: true, locks });
    const requestId = 'activation-review-race';
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(32);
    const key = `${userStoragePrefix('owner-r10')}${encodeURIComponent(ACTIVATION_SUBJECT)}`;
    putHeldWrite(ACTIVATION_SUBJECT, {
      requestId,
      payload: { requestId, manifestHash: a, explicitZeroItemIds: [] },
      phase: 'inflight',
      awaitingReviewReload: true,
    });
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(makeReview(a))
      .mockResolvedValue(makeReview(b));
    try {
      render(
        <MemoryRouter>
          <ActivationPage />
        </MemoryRouter>,
      );
      const button = await screen.findByRole('button', {
        name: 'إعادة تحميل المراجعة',
      });
      await locks.request(key, { mode: 'exclusive' }, () => {
        localStorage.setItem(
          key,
          JSON.stringify({
            v: 1,
            subject: ACTIVATION_SUBJECT,
            requestId,
            payload: {
              requestId,
              manifestHash: b,
              explicitZeroItemIds: ['oil'],
            },
            phase: 'unknown',
          }),
        );
      });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({
        phase: 'unknown',
        payload: { manifestHash: b, explicitZeroItemIds: ['oil'] },
      });
      const retryRead = screen.getByRole('button', {
        name: 'إعادة تحميل المراجعة',
      });
      fireEvent.click(retryRead);
      await screen.findByRole('button', { name: 'إعادة المحاولة' });
      expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toMatchObject({
        phase: 'unknown',
        payload: { explicitZeroItemIds: ['oil'] },
      });
      expect(activateInventory).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('R11-6: a stored count sharing the unknown daily request id settles and reloads after posting', async () => {
    const { locks } = makeFakeLocks();
    vi.stubGlobal('navigator', { onLine: true, locks });
    const requestId = 'd1900000-0000-4000-8000-000000000060';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const payload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [],
    };
    putHeldWrite('count:daily', {
      requestId,
      payload: {
        requestId,
        countedAt,
        frequency: 'daily',
        note: null,
        lines: [],
      },
      phase: 'unknown',
      kind: 'count',
    });
    vi.mocked(listDailyItems).mockResolvedValue([]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts)
      .mockResolvedValueOnce([
        { requestId, countedAt, preparedAt: countedAt, itemCount: 0, payload },
      ])
      .mockResolvedValue([]);
    vi.mocked(recordStoredCount).mockResolvedValue({
      status: 'posted',
      countId: 'saved-count',
    });
    try {
      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      const button = await screen.findByRole('button', { name: 'سجّل الجرد' });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(recordStoredCount).toHaveBeenCalledWith(payload);
      expect(listPendingCounts).toHaveBeenCalledTimes(2);
      expect(getHeldWrite('count:daily')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('R12-1: an editor schedule read cannot strand a mounted conversions panel', async () => {
    let resolveFirst!: (
      value: Awaited<ReturnType<typeof listConversions>>,
    ) => void;
    const fresh = {
      baseUnit: 'liter' as const,
      rows: [
        { itemId: 'oil', unit: 'كرتونة', factorToBase: 3, storedFactor: '3' },
      ],
    };
    vi.mocked(listConversions)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(fresh);

    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    await waitFor(() => expect(listConversions).toHaveBeenCalledTimes(1));
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    await waitFor(() => expect(listCostingSchedule).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveFirst({ baseUnit: 'liter', rows: [] });
      await Promise.resolve();
    });
    expect(
      await within(card).findByText('1 كرتونة = 3 لتر'),
    ).toBeInTheDocument();
  });

  it('R12-2: combined verification publishes the accepted item before clearing either pin', async () => {
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

    const loss = lossSubject('oil');
    const conversion = conversionSubject('oil', 'كرتونة');
    act(() => {
      for (const subject of [loss, conversion]) {
        putHeldWrite(subject, {
          requestId: subject,
          payload: null,
          phase: 'posted_reload',
          readTarget: 'oil',
        });
      }
    });
    const newName = 'زيت بعد التحقق';
    vi.mocked(getItemById).mockResolvedValue({
      ...oilItem,
      name: newName,
      baseUnit: 'kg',
    });
    vi.mocked(listConversions).mockResolvedValue({ baseUnit: 'kg', rows: [] });
    vi.mocked(listCostingSchedule).mockResolvedValue({
      lossToken: emptyScheduleToken,
      identity: 'kg|ingredient||',
      lossVersions: [],
      conversions: [],
    });
    const field = screen.getByLabelText<HTMLInputElement>('الاسم');
    const atRemoval: string[] = [];
    const remove = localStorage.removeItem.bind(localStorage);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
      if (key.includes('posted:')) atRemoval.push(field.value);
      remove(key);
    });

    fireEvent.click(screen.getByRole('button', { name: 'تحقق تاني' }));
    await waitFor(() => {
      expect(getHeldWrite(loss)).toBeNull();
      expect(getHeldWrite(conversion)).toBeNull();
    });
    expect(atRemoval).toEqual([newName, newName]);
    expect(listCostingSchedule).toHaveBeenCalledTimes(3);
  });

  it.each(['hydrate', 'hydrate with Web Locks', 'settle'] as const)(
    'R12-3: an interrupted posted transition uses the posted copy on %s',
    async (stage) => {
      const subject = lossSubject('oil');
      const activeKey = `${userStoragePrefix('owner-r10')}${encodeURIComponent(subject)}`;
      const { locks } = makeFakeLocks();
      const options = {
        getLocks: () => (stage === 'hydrate with Web Locks' ? locks : null),
      };
      const writer = createHeldWriteStore(options);
      writer.setHeldWriteUser('owner-r10');
      const claim = await writer.claimFreshHeldWrite(subject, () => ({
        loss: '10',
      }));
      if (!claim.ok) throw new Error('expected a fresh claim');
      const { requestId } = claim.record;
      const removal = vi
        .spyOn(Storage.prototype, 'removeItem')
        .mockImplementationOnce(() => {
          throw new Error('cannot remove active pin');
        });
      try {
        expect(() =>
          writer.setHeldWritePhase(subject, requestId, 'posted_reload', {
            readTarget: 'oil',
          }),
        ).toThrow(HeldWriteStorageError);
      } finally {
        removal.mockRestore();
        claim.release();
      }
      const tab = createHeldWriteStore(options);
      try {
        tab.setHeldWriteUser('owner-r10');
        await tab.rehydrateHeldWritesAsync();
        if (stage !== 'settle') {
          expect(tab.getHeldWrite(subject)?.phase).toBe('posted_reload');
          const replay = await tab.claimReplayHeldWrite(subject, requestId);
          if (replay.ok) replay.release();
          expect(replay.ok).toBe(false);
          const fresh = await tab.claimFreshHeldWrite(subject, () => ({
            loss: '20',
          }));
          if (fresh.ok) fresh.release();
          expect(fresh.ok).toBe(false);
          expect(tab.getHeldWrite(subject)?.phase).toBe('posted_reload');
        } else {
          const read = localStorage.getItem.bind(localStorage);
          const postedKey = `${userStoragePrefix('owner-r10')}posted:${encodeURIComponent(subject)}:${encodeURIComponent(requestId)}`;
          const broken = vi
            .spyOn(Storage.prototype, 'getItem')
            .mockImplementation((key) => {
              if (key === postedKey) throw new Error('cannot read posted pin');
              return read(key);
            });
          try {
            await expect(
              Promise.resolve().then(() =>
                tab.clearPostedReload(subject, 'oil', requestId),
              ),
            ).rejects.toThrow(HeldWriteStorageError);
            expect(read(activeKey)).not.toBeNull();
            expect(read(postedKey)).not.toBeNull();
          } finally {
            broken.mockRestore();
          }
          await tab.clearPostedReload(subject, 'oil', requestId);
          expect(localStorage.getItem(activeKey)).toBeNull();
          expect(localStorage.getItem(postedKey)).toBeNull();
          expect(tab.getHeldWrite(subject)).toBeNull();
        }
      } finally {
        tab.dispose();
        writer.dispose();
      }
    },
  );

  it.each(['same session', 'new session'] as const)(
    'R12-4: a queued verified read respects the captured session (%s)',
    async (session) => {
      const { locks } = makeFakeLocks();
      const writer = createHeldWriteStore({ getLocks: () => locks });
      const reader = createHeldWriteStore({ getLocks: () => locks });
      const subject = lossSubject('oil');
      writer.setHeldWriteUser('owner-r10');
      reader.setHeldWriteUser('owner-r10');
      const claim = await writer.claimFreshHeldWrite(subject, () => ({
        loss: '10',
      }));
      if (!claim.ok) throw new Error('expected a fresh claim');
      const { requestId } = claim.record;
      const postedKey = `${userStoragePrefix('owner-r10')}posted:${encodeURIComponent(subject)}:${encodeURIComponent(requestId)}`;
      try {
        writer.setHeldWritePhase(subject, requestId, 'posted_reload', {
          readTarget: 'oil',
        });
        const another = conversionSubject('oil', 'كرتونة');
        writer.putHeldWrite(another, {
          requestId: 'another',
          phase: 'posted_reload',
          payload: null,
          readTarget: 'oil',
        });
        const anotherKey = `${userStoragePrefix('owner-r10')}posted:${encodeURIComponent(another)}:another`;
        const snapshot = [
          ...reader.snapshotPostedReloads({ subject }),
          ...reader.snapshotPostedReloads({ subject: another }),
        ];
        expect(snapshot).toHaveLength(2);
        const settle = reader.clearPostedReloadSnapshot(snapshot, 'oil');
        await Promise.resolve();
        expect(localStorage.getItem(postedKey)).not.toBeNull();
        if (session === 'new session') {
          reader.setHeldWriteUser(null);
          reader.setHeldWriteUser('owner-r10');
        }
        claim.release();
        await settle;
        expect([
          localStorage.getItem(postedKey) === null,
          localStorage.getItem(anotherKey) === null,
        ]).toEqual(session === 'same session' ? [true, true] : [false, false]);
      } finally {
        claim.release();
        reader.dispose();
        writer.dispose();
      }
    },
  );

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
      if (listCalls === 1) return Promise.resolve([oilItem, boxItem]);
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
    // The independently ordered box panel can still start a newer catalog read.
    const box = screen.getByRole('article', { name: 'علبة' });
    fireEvent.click(within(box).getByRole('button', { name: 'التحويلات' }));

    // Save loss -> post-save combined read #1 starts!
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفاقد' }));
    await waitFor(() => expect(byIdCalls).toBe(1));

    // The box panel observes a changed identity and starts a newer catalog read.
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
