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
  recordCount,
  recordStoredCount,
} from '@/counts/api';
import { pendingResendMessage, waitingForSyncMessage } from '@/counts/errors';
import type { CountRecord } from '@/counts/types';
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
import {
  addExpenseEntry,
  loadExpenseMonth,
  renameExpenseCategory,
} from '@/expenses/api';
import type { ExpenseMonth } from '@/expenses/types';
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
  COUNT_DAILY_SUBJECT,
  COUNT_STORED_PREFIX,
  createHeldWriteStore,
  clearHeldWritesForUser,
  clearPostedReload,
  claimFreshHeldWrite,
  getHeldWrite,
  hasAnyHeldWrite,
  hasLiveHeldWriteClaims,
  hasPostedReload,
  HeldWriteStorageError,
  putHeldWrite,
  resetHeldWritesStore,
  setHeldWritePhase,
  setHeldWriteUser,
  setWritesLocked,
  userStoragePrefix,
} from '@/lib/held-writes';
import { resetAuthStore, startAuth } from '@/lib/auth-store';
import {
  applyPwaUpdate,
  resetPwaState,
  setPwaAuthResolved,
  setTestWaitingWorker,
} from '@/lib/pwa';
import { AuthProvider } from '@/auth/AuthProvider';
import { RequireOwner } from '@/auth/RequireOwner';
import { ActivationPage } from '@/pages/ActivationPage';
import { CountsPage } from '@/pages/CountsPage';
import { ExpensesPage } from '@/pages/ExpensesPage';
import { ItemsPage } from '@/pages/ItemsPage';
import { makeAuditedLocks } from '@/test/held-write-locks';

type AuthMockSession = {
  user: { id: string; email: string };
  access_token?: string;
  refresh_token?: string;
} | null;

const authMock = vi.hoisted(() => {
  const rpcResult: {
    data: boolean | null;
    error: { message: string } | null;
  } = { data: true, error: null };
  return {
    session: null as AuthMockSession,
    listeners: [] as Array<(event: string, session: AuthMockSession) => void>,
    rpcResult,
  };
});

vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>();
  return {
    ...actual,
    supabase: {
      auth: {
        onAuthStateChange: (
          callback: (event: string, session: AuthMockSession) => void,
        ) => {
          authMock.listeners.push(callback);
          callback('INITIAL_SESSION', authMock.session);
          return {
            data: {
              subscription: {
                unsubscribe: () => {
                  const index = authMock.listeners.indexOf(callback);
                  if (index >= 0) authMock.listeners.splice(index, 1);
                },
              },
            },
          };
        },
        signInWithPassword: () =>
          Promise.resolve({ data: { user: null, session: null }, error: null }),
        signOut: () => {
          authMock.session = null;
          for (const listener of [...authMock.listeners]) {
            listener('SIGNED_OUT', null);
          }
          return Promise.resolve({ error: null });
        },
      },
      schema: () => ({
        rpc: () => Promise.resolve(authMock.rpcResult),
      }),
    },
  };
});

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

vi.mock('@/expenses/api', () => ({
  loadExpenseMonth: vi.fn(),
  addExpenseEntry: vi.fn(),
  voidExpenseEntry: vi.fn(),
  addExpenseCategory: vi.fn(),
  renameExpenseCategory: vi.fn(),
  setExpenseCategoryActive: vi.fn(),
  setMonthExpenseComplete: vi.fn(),
}));

function r13ExpenseMonth(
  monthStart: string,
  entries: ExpenseMonth['entries'] = [],
): ExpenseMonth {
  return {
    monthStart,
    categories: [
      { id: 'rent', name: 'إيجار', kind: 'fixed_monthly', active: true },
    ],
    entries,
    days: [],
    complete: false,
    confirmedAt: null,
  };
}

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

  it('R13-1: two expense tabs finish month cleanup after releasing their write locks', async () => {
    const { locks } = makeFakeLocks();
    vi.stubGlobal('navigator', { onLine: true, locks });
    const other = createHeldWriteStore({ getLocks: () => locks });
    other.setHeldWriteUser('owner-r10');
    let releaseOther = () => {};
    let completeSave: () => void = () => {};
    let settleRead: (() => void) | undefined;
    let partnerCleanup: Promise<void> | undefined;
    const prefix = userStoragePrefix('owner-r10');
    const month = '2030-04-01';
    const otherSubject = 'expense:void:synthetic-void';
    const otherId = 'synthetic-void-request';
    const postedKey = (subject: string, id: string) =>
      `${prefix}posted:${encodeURIComponent(subject)}:${encodeURIComponent(id)}`;
    vi.mocked(loadExpenseMonth).mockImplementation((target) =>
      Promise.resolve(r13ExpenseMonth(target)),
    );
    vi.mocked(addExpenseEntry).mockImplementation(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }),
    );
    try {
      render(
        <MemoryRouter>
          <ExpensesPage />
        </MemoryRouter>,
      );
      const picker = await screen.findByLabelText('الشهر');
      fireEvent.change(picker, { target: { value: '2030-04' } });
      await waitFor(() =>
        expect(screen.getByLabelText('التصنيف')).toBeEnabled(),
      );
      fireEvent.change(screen.getByLabelText('التصنيف'), {
        target: { value: 'rent' },
      });
      fireEvent.change(screen.getByLabelText('المبلغ'), {
        target: { value: '1000' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
      await waitFor(() => expect(addExpenseEntry).toHaveBeenCalledTimes(1));
      const draft = vi.mocked(addExpenseEntry).mock.calls[0]?.[0];
      if (!draft) throw new Error('expected expense draft');

      const voidClaim = await other.claimFreshHeldWrite(
        otherSubject,
        () => ({ id: 'synthetic-void' }),
        { requestId: otherId },
      );
      if (!voidClaim.ok)
        throw new Error('expected the second tab to hold the void lock');
      releaseOther = voidClaim.release;
      other.setHeldWritePhase(otherSubject, otherId, 'posted_reload', {
        readTarget: month,
      });
      vi.mocked(loadExpenseMonth).mockImplementationOnce(
        (target) =>
          new Promise((resolve) => {
            settleRead = () => resolve(r13ExpenseMonth(target));
          }),
      );
      await act(async () => {
        completeSave();
        await Promise.resolve();
      });
      await waitFor(() => expect(settleRead).toBeDefined());

      const bothPins = [
        ...other.snapshotPostedReloads({ subject: 'expense:new' }),
        ...other.snapshotPostedReloads({ subject: otherSubject }),
      ];
      expect(bothPins).toHaveLength(2);
      partnerCleanup = other
        .clearPostedReloadSnapshot(bothPins, month)
        .finally(releaseOther);
      await act(async () => {
        settleRead?.();
        await Promise.resolve();
      });

      await waitFor(
        () => {
          expect(
            [
              localStorage.getItem(
                postedKey('expense:new', draft.requestId),
              ) === null,
              localStorage.getItem(postedKey(otherSubject, otherId)) === null,
            ],
            'concurrent month cleanup must finish without a lock cycle',
          ).toEqual([true, true]);
        },
        { timeout: 800 },
      );
    } finally {
      releaseOther();
      other.dispose();
      await partnerCleanup;
      vi.unstubAllGlobals();
    }
  });

  it('R13-2: readback settles an acknowledged claim promoted by another tab', async () => {
    const { locks } = makeFakeLocks();
    const writer = createHeldWriteStore({ getLocks: () => locks });
    const reader = createHeldWriteStore({ getLocks: () => locks });
    const subject = lossSubject('oil');
    const owner = 'owner-r10';
    writer.setHeldWriteUser(owner);
    const claim = await writer.claimFreshHeldWrite(subject, () => ({
      loss: '10',
    }));
    if (!claim.ok) throw new Error('expected fresh claim');
    const { requestId, claimId } = claim.record;
    const key = `${userStoragePrefix(owner)}${encodeURIComponent(subject)}`;
    try {
      const write = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementationOnce(() => {
          throw new Error('cannot persist acknowledgement');
        });
      expect(() =>
        writer.setHeldWritePhase(subject, requestId, 'posted_reload', {
          readTarget: 'oil',
        }),
      ).toThrow(HeldWriteStorageError);
      write.mockRestore();
      claim.release();
      await Promise.resolve();
      reader.setHeldWriteUser(owner);
      await reader.rehydrateHeldWritesAsync();
      expect(reader.getHeldWrite(subject)).toMatchObject({
        requestId,
        claimId,
        phase: 'unknown',
      });

      await writer.clearPostedReloadSnapshot(
        writer.snapshotPostedReloads({ subject }),
        'oil',
      );
      expect(localStorage.getItem(key)).toBeNull();
    } finally {
      claim.release();
      reader.dispose();
      writer.dispose();
    }
  });

  it('R13-3: sign-out removes an unchanged pin when the other tab closes', async () => {
    const { locks } = makeFakeLocks();
    const writer = createHeldWriteStore({ getLocks: () => locks });
    const signingOut = createHeldWriteStore({ getLocks: () => locks });
    const owner = 'owner-r10';
    const subject = lossSubject('oil');
    const key = `${userStoragePrefix(owner)}${encodeURIComponent(subject)}`;
    writer.setHeldWriteUser(owner);
    signingOut.setHeldWriteUser(owner);
    const claim = await writer.claimFreshHeldWrite(subject, () => ({
      loss: '10',
    }));
    if (!claim.ok) throw new Error('expected fresh claim');
    try {
      signingOut.setWritesLocked(true);
      signingOut.clearHeldWritesForUser(owner);
      signingOut.setHeldWriteUser(null);
      await Promise.resolve();
      expect(localStorage.getItem(key)).not.toBeNull();
      writer.dispose();
      await waitFor(() => expect(localStorage.getItem(key)).toBeNull(), {
        timeout: 400,
      });
    } finally {
      claim.release();
      signingOut.dispose();
      writer.dispose();
    }
  });

  it('R13-4: a stale count card cannot repost a request with a posted copy and empty active slot', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000061';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const subject = `count:stored:${requestId}`;
    const payload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [],
    };
    vi.mocked(listDailyItems).mockResolvedValue([]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([
      { requestId, countedAt, preparedAt: countedAt, itemCount: 0, payload },
    ]);
    vi.mocked(recordStoredCount).mockResolvedValue({
      status: 'posted',
      countId: 'other',
    });
    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    const button = await screen.findByRole('button', { name: 'سجّل الجرد' });

    // Another tab recorded this id after the card was loaded, before its storage event was delivered.
    const tab = createHeldWriteStore();
    tab.setHeldWriteUser('owner-r10');
    try {
      tab.putHeldWrite(subject, {
        requestId,
        payload: null,
        phase: 'posted_reload',
        kind: 'count_stored',
      });
      expect(
        localStorage.getItem(
          `${userStoragePrefix('owner-r10')}${encodeURIComponent(subject)}`,
        ),
      ).toBeNull();
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      expect(recordStoredCount).not.toHaveBeenCalled();
    } finally {
      tab.dispose();
    }
  });

  it('R13-5: superseded schedule still supplies the editor open shift timing', async () => {
    let finishSchedule!: (
      schedule: Awaited<ReturnType<typeof listCostingSchedule>>,
    ) => void;
    const schedule = {
      lossToken: emptyScheduleToken,
      identity: 'liter|ingredient||',
      lossVersions: [],
      conversions: [],
    };
    vi.mocked(currentShiftStart).mockResolvedValueOnce(
      '2020-01-01T00:00:00.000Z',
    );
    vi.mocked(listCostingSchedule).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSchedule = resolve;
        }),
    );
    vi.mocked(costingImpact).mockResolvedValue({
      orders: 2,
      shifts: 1,
      movements: 0,
    });
    render(
      <MemoryRouter>
        <ItemsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('article', { name: 'زيت' });
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    await waitFor(() => expect(listCostingSchedule).toHaveBeenCalledTimes(1));
    fireEvent.click(within(card).getByRole('button', { name: 'التحويلات' }));
    await waitFor(() => expect(listCostingSchedule).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishSchedule(schedule);
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('نسبة الفاقد'), {
      target: { value: '10' },
    });
    expect(
      await screen.findByText('ممكن يأثر على 2 طلب في 1 وردية (تقدير)'),
    ).toBeInTheDocument();
  });

  it('R13-6: an older cleanup failure cannot relock verified expense categories', async () => {
    const { locks } = makeFakeLocks();
    vi.stubGlobal('navigator', { onLine: true, locks });
    const other = createHeldWriteStore({ getLocks: () => locks });
    other.setHeldWriteUser('owner-r10');
    const subject = 'expense:void:synthetic-void';
    const key = `${userStoragePrefix('owner-r10')}${encodeURIComponent(subject)}`;
    let releaseLock = () => {};
    vi.mocked(loadExpenseMonth).mockImplementation((target) =>
      Promise.resolve(r13ExpenseMonth(target)),
    );
    vi.mocked(renameExpenseCategory).mockRejectedValueOnce(
      new Error('response lost'),
    );
    try {
      render(
        <MemoryRouter>
          <ExpensesPage />
        </MemoryRouter>,
      );
      const picker = await screen.findByLabelText('الشهر');
      fireEvent.change(picker, { target: { value: '2030-04' } });
      const rename = await screen.findByLabelText('اسم إيجار');
      vi.mocked(loadExpenseMonth).mockRejectedValueOnce(
        new Error('first verification failed'),
      );
      fireEvent.change(rename, { target: { value: 'إيجار جديد' } });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ اسم إيجار' }));
      const retry = await screen.findByRole('button', { name: 'تحقق تاني' });

      const claim = await other.acquireHeldWriteLock(subject);
      if (!claim.acquired) throw new Error('expected a busy void subject');
      releaseLock = claim.release;
      act(() => {
        putHeldWrite(subject, {
          requestId: 'void-request',
          phase: 'unknown',
          payload: { id: 'synthetic-void' },
        });
      });
      const older = r13ExpenseMonth('2030-04-01', [
        {
          id: 'synthetic-void',
          categoryId: 'rent',
          categoryName: 'إيجار',
          categoryKind: 'fixed_monthly',
          amount: '100.00',
          periodMonth: '2030-04-01',
          expenseDate: null,
          paidOn: null,
          isEstimate: false,
          note: 'إلغاء قديم',
          hours: null,
          hourlyRate: null,
          driverLabel: null,
          createdAt: '2030-04-01T08:00:00Z',
          voided: true,
          voidReason: 'تكرار',
          superseded: false,
        },
      ]);
      vi.mocked(loadExpenseMonth).mockResolvedValueOnce(older);
      fireEvent.click(retry);
      await screen.findByText('إلغاء قديم');
      fireEvent.change(picker, { target: { value: '2030-05' } });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeEnabled(),
      );

      const read = localStorage.getItem.bind(localStorage);
      const failedRead = vi
        .spyOn(Storage.prototype, 'getItem')
        .mockImplementation((candidate) => {
          if (candidate === key)
            throw new Error('delayed cleanup storage failure');
          return read(candidate);
        });
      try {
        await act(async () => {
          releaseLock();
          await Promise.resolve();
        });
        expect(failedRead).toHaveBeenCalledWith(key);
        expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeEnabled();
        expect(
          screen.queryByRole('button', { name: 'تحقق تاني' }),
        ).not.toBeInTheDocument();
      } finally {
        failedRead.mockRestore();
      }
    } finally {
      releaseLock();
      other.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('R14-1: queued sign-out follows a captured claim into the posted slot and respects session and newer-claim guards', async () => {
    const { client, nested } = makeAuditedLocks();
    const writerLocks = client('writer-1');
    const writerNewerLocks = client('writer-2');
    const signerLocks = client('signing-out tab');
    const writer = createHeldWriteStore({ getLocks: () => writerLocks });
    const writerNewer = createHeldWriteStore({
      getLocks: () => writerNewerLocks,
    });
    const signer = createHeldWriteStore({
      getLocks: () => signerLocks,
    });
    const subject = lossSubject('oil');
    const subjectNewer = lossSubject('box');
    const subjectResign = lossSubject('resign');
    const owner = 'owner-r10';
    writer.setHeldWriteUser(owner);
    writerNewer.setHeldWriteUser(owner);
    signer.setHeldWriteUser(owner);
    const claim = await writer.claimFreshHeldWrite(subject, () => ({
      loss: '10',
    }));
    const claimNewer = await writerNewer.claimFreshHeldWrite(
      subjectNewer,
      () => ({ loss: '5' }),
    );
    if (!claim.ok || !claimNewer.ok) throw new Error('expected writer claims');
    try {
      signer.setWritesLocked(true);
      signer.clearHeldWritesForUser(owner);
      signer.setHeldWriteUser(null);
      const { requestId } = claim.record;
      writer.setHeldWritePhase(subject, requestId, 'posted_reload', {
        readTarget: 'oil',
      });
      const prefix = userStoragePrefix(owner);
      const posted = `${prefix}posted:${encodeURIComponent(subject)}:${encodeURIComponent(requestId)}`;
      const newerActive = `${prefix}${encodeURIComponent(subjectNewer)}`;
      expect(localStorage.getItem(posted)).not.toBeNull();

      // Replace the second subject with a newer claim (new claimId) before the queued cleanup acquires the lock.
      const existingNewer = JSON.parse(
        localStorage.getItem(newerActive) ?? '{}',
      ) as Record<string, unknown>;
      localStorage.setItem(
        newerActive,
        JSON.stringify({ ...existingNewer, claimId: 'newer-claim-id' }),
      );
      claimNewer.release();

      writer.dispose();
      await waitFor(() => expect(localStorage.getItem(posted)).toBeNull(), {
        timeout: 400,
      });
      // Newer claim (different claimId) must NOT be deleted by the older sign-out snapshot.
      expect(localStorage.getItem(newerActive)).not.toBeNull();

      // Session guard: if the same user signs back in before a queued cleanup runs, keep their pin.
      signer.setHeldWriteUser(owner);
      const writer2Locks = client('writer-3');
      const writer2 = createHeldWriteStore({
        getLocks: () => writer2Locks,
      });
      writer2.setHeldWriteUser(owner);
      const claimResign = await writer2.claimFreshHeldWrite(
        subjectResign,
        () => ({ price: '10' }),
      );
      if (!claimResign.ok) throw new Error('expected resign claim');
      const resignKey = `${prefix}${encodeURIComponent(subjectResign)}`;
      try {
        signer.setWritesLocked(true);
        signer.clearHeldWritesForUser(owner);
        signer.setHeldWriteUser(null);
        signer.setHeldWriteUser(owner);
        claimResign.release();
        await Promise.resolve();
        await Promise.resolve();
        expect(localStorage.getItem(resignKey)).not.toBeNull();
      } finally {
        claimResign.release();
        writer2.dispose();
      }
      expect(nested).toEqual([]);
    } finally {
      claim.release();
      claimNewer.release();
      writer.dispose();
      writerNewer.dispose();
      signer.dispose();
    }
  });

  it('R14-3: a month snapshot waiting for cleanup cannot verify a later ambiguous category rename', async () => {
    const { locks } = makeFakeLocks();
    vi.stubGlobal('navigator', { onLine: true, locks });
    const other = createHeldWriteStore({ getLocks: () => locks });
    other.setHeldWriteUser('owner-r10');
    const subject = 'expense:void:synthetic-void';
    let release = () => {};
    vi.mocked(loadExpenseMonth).mockImplementation((target) =>
      Promise.resolve(r13ExpenseMonth(target)),
    );
    try {
      render(
        <MemoryRouter>
          <ExpensesPage />
        </MemoryRouter>,
      );
      await screen.findByRole('button', { name: 'حفظ اسم إيجار' });
      const claim = await other.acquireHeldWriteLock(subject);
      if (!claim.acquired) throw new Error('expected busy void subject');
      release = claim.release;
      act(() => {
        putHeldWrite(subject, {
          requestId: 'old-void',
          phase: 'unknown',
          payload: { id: 'synthetic-void' },
        });
      });
      vi.mocked(loadExpenseMonth).mockResolvedValueOnce(
        r13ExpenseMonth('2030-05-01', [
          {
            id: 'synthetic-void',
            categoryId: 'rent',
            categoryName: 'إيجار',
            categoryKind: 'fixed_monthly',
            amount: '100.00',
            periodMonth: '2030-05-01',
            expenseDate: null,
            paidOn: null,
            isEstimate: false,
            note: 'إلغاء مستني التنضيف',
            hours: null,
            hourlyRate: null,
            driverLabel: null,
            createdAt: '2030-05-01T08:00:00Z',
            voided: true,
            voidReason: 'تكرار',
            superseded: false,
          },
        ]),
      );
      fireEvent.change(screen.getByLabelText('الشهر'), {
        target: { value: '2030-05' },
      });
      await screen.findByText('إلغاء مستني التنضيف');
      vi.mocked(renameExpenseCategory).mockRejectedValueOnce(
        new Error('rename reply lost'),
      );
      vi.mocked(loadExpenseMonth).mockRejectedValueOnce(
        new Error('rename verification unavailable'),
      );
      fireEvent.change(screen.getByLabelText('اسم إيجار'), {
        target: { value: 'إيجار جديد' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ اسم إيجار' }));
      await screen.findByRole('button', { name: 'تحقق تاني' });
      await act(async () => {
        release();
        await Promise.resolve();
      });
      await waitFor(() => expect(getHeldWrite(subject)).toBeNull());
      expect(
        screen.getByRole('button', { name: 'تحقق تاني' }),
      ).toBeInTheDocument();
    } finally {
      release();
      other.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('R14-4: acknowledged activation offers read-only review when the posted write failed', async () => {
    const review = makeReview('a'.repeat(32));
    const activated = { ...review, activated: true, canActivate: false };
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(review)
      .mockResolvedValue(activated);
    vi.mocked(activateInventory).mockImplementationOnce(() => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new Error('posted storage unavailable');
      });
      return Promise.resolve({
        activated: true,
        stockStartedAt: null,
        openingManifestHash: review.openingManifestHash,
      });
    });
    render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تفعيل الخصم' }));
    const readOnly = await screen.findByRole('button', {
      name: 'إعادة تحميل المراجعة',
    });
    expect(
      screen.queryByRole('button', { name: 'تفعيل الخصم' }),
    ).not.toBeInTheDocument();
    fireEvent.click(readOnly);
    await waitFor(() => expect(getHeldWrite(ACTIVATION_SUBJECT)).toBeNull());
    expect(activateInventory).toHaveBeenCalledTimes(1);
    expect(loadOpeningReview).toHaveBeenCalledTimes(2);
  });

  it('R14-4 store: an acknowledged claim refuses a direct replay before readback', async () => {
    const tab = createHeldWriteStore();
    tab.setHeldWriteUser('owner-r10');
    const claim = await tab.claimFreshHeldWrite(ACTIVATION_SUBJECT, () => ({
      activate: true,
    }));
    if (!claim.ok) throw new Error('expected fresh activation');
    try {
      const storage = vi
        .spyOn(Storage.prototype, 'setItem')
        .mockImplementationOnce(() => {
          throw new Error('posted copy unavailable');
        });
      expect(() =>
        tab.setHeldWritePhase(
          ACTIVATION_SUBJECT,
          claim.record.requestId,
          'posted_reload',
          { readTarget: ACTIVATION_SUBJECT },
        ),
      ).toThrow(HeldWriteStorageError);
      storage.mockRestore();
      claim.release();
      const replay = await tab.claimReplayHeldWrite(
        ACTIVATION_SUBJECT,
        claim.record.requestId,
      );
      if (replay.ok) replay.release();
      expect(replay).toMatchObject({ ok: false, reason: 'conflict' });
    } finally {
      claim.release();
      tab.dispose();
    }
  });

  it('R14-5: a stale stored card reads back an id posted by the daily form', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000062';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const payload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [],
    };
    vi.mocked(listDailyItems).mockResolvedValue([]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts)
      .mockResolvedValueOnce([
        { requestId, countedAt, preparedAt: countedAt, itemCount: 0, payload },
      ])
      .mockResolvedValue([]);
    vi.mocked(recordStoredCount).mockResolvedValue({
      status: 'posted',
      countId: 'other',
    });
    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    const card = await screen.findByRole('button', { name: 'سجّل الجرد' });
    const other = createHeldWriteStore();
    other.setHeldWriteUser('owner-r10');
    try {
      other.putHeldWrite('count:daily', {
        requestId,
        payload: null,
        phase: 'posted_reload',
        kind: 'count',
      });
      await act(async () => {
        fireEvent.click(card);
        await Promise.resolve();
      });
      expect(recordStoredCount).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'سجّل الجرد' }),
        ).not.toBeInTheDocument(),
      );
      expect(listPendingCounts).toHaveBeenCalledTimes(2);
    } finally {
      other.dispose();
    }
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

  it('R15-1a: a confirmed daily count retry settles a matching unknown stored-card alias so no detached retry card remains', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000071';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const dailyDraft = {
      requestId,
      countedAt,
      note: null,
      lines: [{ itemId: 'tilapia', countedQty: '7', expectedBaseUnit: 'kg' }],
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([]);
    vi.mocked(recordCount).mockResolvedValueOnce({
      status: 'posted',
      countId: 'count-r15-1a',
    });

    putHeldWrite(COUNT_DAILY_SUBJECT, {
      requestId,
      payload: dailyDraft,
      phase: 'unknown',
      kind: 'count',
    });
    putHeldWrite(storedSubject, {
      requestId,
      payload: storedPayload,
      phase: 'unknown',
      kind: 'count_stored',
    });

    render(
      <MemoryRouter>
        <CountsPage />
      </MemoryRouter>,
    );
    const saveBtn = await screen.findByRole('button', { name: 'حفظ' });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getHeldWrite(COUNT_DAILY_SUBJECT)).toBeNull());
    expect(getHeldWrite(storedSubject)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'سجّل الجرد' }),
    ).not.toBeInTheDocument();
  });

  it('R15-1b: a confirmed daily count retains posted proof if stored-alias cleanup fails and clears both on recovery', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000072';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const dailyPostedKey = `${prefix}posted:${encodeURIComponent(COUNT_DAILY_SUBJECT)}:${encodeURIComponent(requestId)}`;
    const storedPostedKey = `${prefix}posted:${encodeURIComponent(storedSubject)}:${encodeURIComponent(requestId)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const dailyDraft = {
      requestId,
      countedAt,
      note: null,
      lines: [{ itemId: 'tilapia', countedQty: '7', expectedBaseUnit: 'kg' }],
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([]);
    vi.mocked(recordCount).mockResolvedValueOnce({
      status: 'posted',
      countId: 'count-r15-1b',
    });

    putHeldWrite(COUNT_DAILY_SUBJECT, {
      requestId,
      payload: dailyDraft,
      phase: 'unknown',
      kind: 'count',
    });
    putHeldWrite(storedSubject, {
      requestId,
      payload: storedPayload,
      phase: 'unknown',
      kind: 'count_stored',
    });

    const origRemove = localStorage.removeItem.bind(localStorage);
    let blockStoredRemove = true;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockStoredRemove && key === storedKey) {
          throw new Error('alias remove failed');
        }
        return origRemove(key);
      });

    try {
      const firstView = render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'حفظ' }));
      await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(1));
      await screen.findByRole('alert');

      // While stored-alias removal fails, posted proof MUST stay in storage.
      expect(
        localStorage.getItem(dailyPostedKey) !== null ||
          localStorage.getItem(storedPostedKey) !== null,
      ).toBe(true);
      expect(
        screen.queryByRole('button', { name: 'سجّل الجرد' }),
      ).not.toBeInTheDocument();

      // Simulate full reload while alias removal STILL fails: readback must retain posted proof and not expose a detached retry card.
      firstView.unmount();
      resetHeldWritesStore({ clearStorage: false, resetUser: false });
      setHeldWriteUser('owner-r10');

      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      await screen.findByRole('alert');
      expect(
        localStorage.getItem(dailyPostedKey) !== null ||
          localStorage.getItem(storedPostedKey) !== null,
      ).toBe(true);
      expect(
        screen.queryByRole('button', { name: 'سجّل الجرد' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();

      // Once storage removal recovers, retry readback clears BOTH the stored alias and posted proof.
      blockStoredRemove = false;
      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled(),
      );
      expect(localStorage.getItem(storedKey)).toBeNull();
      expect(localStorage.getItem(dailyPostedKey)).toBeNull();
      expect(localStorage.getItem(storedPostedKey)).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'سجّل الجرد' }),
      ).not.toBeInTheDocument();
      expect(recordCount).toHaveBeenCalledTimes(1);
      expect(recordStoredCount).not.toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('R15-2: old expense void cleanup completing cannot unlock a newer category rename whose readback failed', async () => {
    const { locks } = makeFakeLocks();
    vi.stubGlobal('navigator', { onLine: true, locks });
    const other = createHeldWriteStore({ getLocks: () => locks });
    other.setHeldWriteUser('owner-r10');
    const subject = 'expense:void:synthetic-void-r15';
    let release = () => {};
    vi.mocked(loadExpenseMonth).mockImplementation((target) =>
      Promise.resolve(r13ExpenseMonth(target)),
    );
    try {
      render(
        <MemoryRouter>
          <ExpensesPage />
        </MemoryRouter>,
      );
      await screen.findByRole('button', { name: 'حفظ اسم إيجار' });
      const claim = await other.acquireHeldWriteLock(subject);
      if (!claim.acquired) throw new Error('expected busy void subject');
      release = claim.release;
      act(() => {
        putHeldWrite(subject, {
          requestId: 'old-void-r15',
          phase: 'unknown',
          payload: { id: 'synthetic-void-r15' },
        });
      });

      vi.mocked(loadExpenseMonth).mockResolvedValueOnce(
        r13ExpenseMonth('2030-05-01', [
          {
            id: 'synthetic-void-r15',
            categoryId: 'rent',
            categoryName: 'إيجار',
            categoryKind: 'fixed_monthly',
            amount: '100.00',
            periodMonth: '2030-05-01',
            expenseDate: null,
            paidOn: null,
            isEstimate: false,
            note: 'إلغاء معلق r15',
            hours: null,
            hourlyRate: null,
            driverLabel: null,
            createdAt: '2030-05-01T08:00:00Z',
            voided: true,
            voidReason: 'تكرار',
            superseded: false,
          },
        ]),
      );
      fireEvent.change(screen.getByLabelText('الشهر'), {
        target: { value: '2030-05' },
      });
      await screen.findByText('إلغاء معلق r15');

      // While old month read is waiting on void cleanup, category rename succeeds but its readback fails.
      vi.mocked(renameExpenseCategory).mockResolvedValueOnce(undefined);
      vi.mocked(loadExpenseMonth).mockRejectedValueOnce(
        new Error('rename readback failed'),
      );
      fireEvent.change(screen.getByLabelText('اسم إيجار'), {
        target: { value: 'إيجار محدث' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ اسم إيجار' }));
      await screen.findByText('rename readback failed');
      expect(screen.getByLabelText('الشهر')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeDisabled();

      // Releasing the old void cleanup MUST NOT clear the newer write's reload lock!
      await act(async () => {
        release();
        await Promise.resolve();
      });
      await waitFor(() => expect(getHeldWrite(subject)).toBeNull());
      expect(screen.getByLabelText('الشهر')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'حفظ اسم إيجار' }),
      ).toBeDisabled();

      // A fresh qualifying retry read unlocks the page.
      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'ضيف تصنيف' })).toBeEnabled(),
      );
      expect(screen.getByLabelText('الشهر')).toBeEnabled();
    } finally {
      release();
      other.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('R15-3: a tab opened while a daily count holds the shared lock promotes an abandoned stored-card pin once the lock frees', async () => {
    const { client, nested } = makeAuditedLocks();
    const tab1Locks = client('tab-daily');
    const tab2Locks = client('tab-reader');
    const tab1 = createHeldWriteStore({ getLocks: () => tab1Locks });
    const tab2 = createHeldWriteStore({ getLocks: () => tab2Locks });
    const owner = 'owner-r10';
    const storedSubject = `${COUNT_STORED_PREFIX}req-abandoned-r15`;
    const prefix = userStoragePrefix(owner);
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    let releaseDaily = () => {};
    try {
      // Seed an abandoned inflight stored-card pin (simulating a crashed tab).
      localStorage.setItem(
        storedKey,
        JSON.stringify({
          v: 1,
          subject: storedSubject,
          kind: 'count_stored',
          requestId: 'req-abandoned-r15',
          claimId: 'abandoned-claim-r15',
          payload: { request_id: 'req-abandoned-r15' },
          phase: 'inflight',
        }),
      );

      tab1.setHeldWriteUser(owner);
      const dailyClaim = await tab1.claimFreshHeldWrite(
        COUNT_DAILY_SUBJECT,
        (requestId) => ({ requestId }),
        { kind: 'count' },
      );
      if (!dailyClaim.ok) throw new Error('expected daily claim');
      releaseDaily = dailyClaim.release;

      // Tab 2 opens while Tab 1 holds the shared count lock.
      tab2.setHeldWriteUser(owner);
      await tab2.rehydrateHeldWritesAsync();
      expect(tab2.getHeldWrite(COUNT_DAILY_SUBJECT)?.phase).toBe('inflight');
      expect(tab2.getHeldWrite(storedSubject)?.phase).toBe('inflight');

      let notifications = 0;
      const unsub = tab2.subscribeHeldWritesStore(() => {
        notifications += 1;
      });
      try {
        // Tab 1 finishes its daily count, fires a cross-tab storage event, and releases the shared lock.
        tab1.setHeldWritePhase(
          COUNT_DAILY_SUBJECT,
          dailyClaim.record.requestId,
          'posted_reload',
        );
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: `${prefix}${encodeURIComponent(COUNT_DAILY_SUBJECT)}`,
          }),
        );
        dailyClaim.release();

        // Without another page reload, Tab 2 must promote the abandoned stored-card pin once the shared lock frees.
        await waitFor(() =>
          expect(tab2.getHeldWrite(storedSubject)?.phase).toBe('unknown'),
        );
        expect(
          JSON.parse(localStorage.getItem(storedKey) ?? '{}'),
        ).toMatchObject({
          requestId: 'req-abandoned-r15',
          phase: 'unknown',
        });
        expect(notifications).toBeGreaterThan(0);
        expect(nested).toEqual([]);
      } finally {
        unsub();
      }
    } finally {
      releaseDaily();
      tab1.dispose();
      tab2.dispose();
    }
  });

  it('R15-4: reloading activation after a failed posted marker resolves the unknown pin when fresh review is activated and keeps fallback read-only', async () => {
    const review = makeReview('a'.repeat(32));
    const activated = { ...review, activated: true, canActivate: false };
    vi.mocked(loadOpeningReview)
      .mockResolvedValueOnce(review)
      .mockResolvedValue(activated);
    vi.mocked(activateInventory).mockImplementationOnce(() => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
        throw new Error('posted storage unavailable');
      });
      return Promise.resolve({
        activated: true,
        stockStartedAt: null,
        openingManifestHash: review.openingManifestHash,
      });
    });

    const firstView = render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'تفعيل الخصم' }));
    await screen.findByRole('button', { name: 'إعادة تحميل المراجعة' });
    expect(activateInventory).toHaveBeenCalledTimes(1);

    // Simulate a full page reload (loses in-memory acknowledgement; active inflight pin restores as unknown).
    firstView.unmount();
    resetHeldWritesStore({ clearStorage: false, resetUser: false });
    setHeldWriteUser('owner-r10');

    const secondView = render(
      <MemoryRouter>
        <ActivationPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(getHeldWrite(ACTIVATION_SUBJECT)).toBeNull());
    expect(
      screen.queryByRole('button', { name: 'إعادة المحاولة' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'تفعيل الخصم' }),
    ).not.toBeInTheDocument();
    expect(activateInventory).toHaveBeenCalledTimes(1);
    secondView.unmount();

    // If clearing the restored unknown pin fails (e.g. removeItem throws), the UI must stay read-only and never offer a write retry.
    putHeldWrite(ACTIVATION_SUBJECT, {
      requestId: 'req-act-r15-fallback',
      payload: {
        requestId: 'req-act-r15-fallback',
        manifestHash: 'a'.repeat(32),
        explicitZeroItemIds: [],
      },
      phase: 'unknown',
      kind: 'action',
    });
    const actKey = `${userStoragePrefix('owner-r10')}${encodeURIComponent(ACTIVATION_SUBJECT)}`;
    const origRemove = localStorage.removeItem.bind(localStorage);
    let blockRemove = true;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockRemove && key === actKey) {
          throw new Error('remove failed');
        }
        return origRemove(key);
      });
    try {
      render(
        <MemoryRouter>
          <ActivationPage />
        </MemoryRouter>,
      );
      const reloadButtons = await screen.findAllByRole('button', {
        name: 'إعادة تحميل المراجعة',
      });
      expect(reloadButtons.length).toBeGreaterThan(0);
      expect(
        screen.queryByRole('button', { name: 'إعادة المحاولة' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'تفعيل الخصم' }),
      ).not.toBeInTheDocument();

      blockRemove = false;
      fireEvent.click(reloadButtons[reloadButtons.length - 1]!);
      await waitFor(() => expect(getHeldWrite(ACTIVATION_SUBJECT)).toBeNull());
      expect(activateInventory).toHaveBeenCalledTimes(1);
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('R16-1: legacy active-slot posted_reload keeps posted proof when count alias removal fails and clears both on recovery', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000081';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const dailyKey = `${prefix}${encodeURIComponent(COUNT_DAILY_SUBJECT)}`;
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([]);

    // Seed the legacy layout: posted_reload lives only in the active daily slot,
    // while the matching stored-card alias remains unknown in its active slot.
    localStorage.setItem(
      dailyKey,
      JSON.stringify({
        v: 1,
        subject: COUNT_DAILY_SUBJECT,
        kind: 'count',
        requestId,
        payload: null,
        phase: 'posted_reload',
      }),
    );
    localStorage.setItem(
      storedKey,
      JSON.stringify({
        v: 1,
        subject: storedSubject,
        kind: 'count_stored',
        requestId,
        payload: storedPayload,
        phase: 'unknown',
      }),
    );
    resetHeldWritesStore({ clearStorage: false, resetUser: false });
    setHeldWriteUser('owner-r10');

    const origRemove = localStorage.removeItem.bind(localStorage);
    let blockStoredRemove = true;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockStoredRemove && key === storedKey) {
          throw new Error('legacy alias remove failed');
        }
        return origRemove(key);
      });

    try {
      const firstView = render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      await screen.findByRole('alert');

      // Alias removal failed: the legacy active-slot posted proof must stay intact.
      expect(localStorage.getItem(dailyKey)).not.toBeNull();
      expect(localStorage.getItem(storedKey)).not.toBeNull();
      expect(
        screen.queryByRole('button', { name: 'سجّل الجرد' }),
      ).not.toBeInTheDocument();

      // Simulate a full reload while alias removal still fails: the alias must
      // remain suppressed and editing must stay locked.
      firstView.unmount();
      resetHeldWritesStore({ clearStorage: false, resetUser: false });
      setHeldWriteUser('owner-r10');

      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      await screen.findByRole('alert');
      expect(localStorage.getItem(dailyKey)).not.toBeNull();
      expect(
        screen.queryByRole('button', { name: 'سجّل الجرد' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'حفظ' })).toBeDisabled();

      // Once storage removal recovers, retry readback clears both records.
      blockStoredRemove = false;
      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled(),
      );
      expect(localStorage.getItem(storedKey)).toBeNull();
      expect(localStorage.getItem(dailyKey)).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'سجّل الجرد' }),
      ).not.toBeInTheDocument();
      expect(recordCount).not.toHaveBeenCalled();
      expect(recordStoredCount).not.toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('R16-2: waiting_for_sync preserves wait phase and notice when deleting the stored-card alias fails', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000082';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const dailyKey = `${prefix}${encodeURIComponent(COUNT_DAILY_SUBJECT)}`;
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const dailyDraft = {
      requestId,
      countedAt,
      note: null,
      lines: [{ itemId: 'tilapia', countedQty: '7', expectedBaseUnit: 'kg' }],
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([]);
    vi.mocked(recordCount)
      .mockResolvedValueOnce({ status: 'waiting_for_sync' })
      .mockResolvedValueOnce({ status: 'waiting_for_sync' });

    putHeldWrite(COUNT_DAILY_SUBJECT, {
      requestId,
      payload: dailyDraft,
      phase: 'unknown',
      kind: 'count',
    });
    putHeldWrite(storedSubject, {
      requestId,
      payload: storedPayload,
      phase: 'unknown',
      kind: 'count_stored',
    });

    const origRemove = localStorage.removeItem.bind(localStorage);
    let blockStoredRemove = true;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockStoredRemove && key === storedKey) {
          throw new Error('wait alias remove failed');
        }
        return origRemove(key);
      });

    try {
      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'حفظ' }));
      await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(1));

      expect(
        await screen.findByText(waitingForSyncMessage),
      ).toBeInTheDocument();
      expect(getHeldWrite(COUNT_DAILY_SUBJECT)?.phase).toBe('waiting_for_sync');
      expect(JSON.parse(localStorage.getItem(dailyKey) ?? '{}')).toMatchObject({
        requestId,
        phase: 'waiting_for_sync',
      });
      expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'جرد مستني المزامنة' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Once storage removal recovers, resending the waiting count cleans up the alias too.
      blockStoredRemove = false;
      fireEvent.click(screen.getByRole('button', { name: 'سجّل الجرد' }));
      await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(localStorage.getItem(storedKey)).toBeNull());
      expect(getHeldWrite(COUNT_DAILY_SUBJECT)?.phase).toBe('waiting_for_sync');
      expect(screen.getByText(waitingForSyncMessage)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('R17-1a: stored count card without daily pin persists replayable waiting_for_sync on removal failure and retries after storage recovers', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000083';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const pendingCard = {
      requestId,
      preparedAt: '2026-10-22T10:05:00.000Z',
      countedAt,
      itemCount: 1,
      payload: storedPayload,
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([pendingCard]);
    vi.mocked(recordStoredCount)
      .mockResolvedValueOnce({ status: 'waiting_for_sync' })
      .mockResolvedValueOnce({ status: 'waiting_for_sync' })
      .mockResolvedValueOnce({ status: 'posted', countId: 'count-r17-1a' });

    const origRemove = localStorage.removeItem.bind(localStorage);
    let blockStoredRemove = true;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockStoredRemove && key === storedKey) {
          throw new Error('stored card wait remove failed');
        }
        return origRemove(key);
      });

    try {
      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      const cardBtn = await screen.findByRole('button', { name: 'سجّل الجرد' });
      fireEvent.click(cardBtn);
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(1));

      expect(
        await screen.findByText(waitingForSyncMessage),
      ).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');
      expect(JSON.parse(localStorage.getItem(storedKey) ?? '{}')).toMatchObject(
        {
          requestId,
          phase: 'waiting_for_sync',
          payload: storedPayload,
        },
      );
      expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'سجّل الجرد' }),
        ).toBeEnabled(),
      );

      // Once storage recovers, clicking the enabled card button replays with the
      // exact same request ID and payload instead of silently conflicting.
      blockStoredRemove = false;
      fireEvent.click(screen.getByRole('button', { name: 'سجّل الجرد' }));
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(2));
      expect(vi.mocked(recordStoredCount).mock.calls[1]?.[0]).toEqual(
        storedPayload,
      );
      await waitFor(() => expect(localStorage.getItem(storedKey)).toBeNull());
      expect(getHeldWrite(storedSubject)).toBeNull();
      expect(screen.getByText(waitingForSyncMessage)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // A subsequent click posts the pending count and clears the card.
      vi.mocked(listPendingCounts).mockResolvedValue([]);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'سجّل الجرد' }),
        ).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'سجّل الجرد' }));
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(3));
      expect(vi.mocked(recordStoredCount).mock.calls[2]?.[0]).toEqual(
        storedPayload,
      );
      expect(await screen.findByText('اتسجل الجرد')).toBeInTheDocument();
      await waitFor(() => expect(localStorage.getItem(storedKey)).toBeNull());
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('R17-1b: stored count card waiting_for_sync survives reload and replays the persisted request ID and payload', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000084';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: 'ملاحظة تجريبية',
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const pendingCard = {
      requestId,
      preparedAt: '2026-10-22T10:05:00.000Z',
      countedAt,
      itemCount: 1,
      payload: storedPayload,
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([pendingCard]);
    vi.mocked(recordStoredCount)
      .mockResolvedValueOnce({ status: 'waiting_for_sync' })
      .mockResolvedValueOnce({ status: 'posted', countId: 'count-r17-1b' });

    const origRemove = localStorage.removeItem.bind(localStorage);
    let blockStoredRemove = true;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockStoredRemove && key === storedKey) {
          throw new Error('stored card wait remove failed');
        }
        return origRemove(key);
      });

    try {
      const firstView = render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'سجّل الجرد' }),
      );
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(1));
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');

      // Full reload: waiting_for_sync must persist without turning into unknown,
      // and restore a local-only card even when the server pending list is empty.
      firstView.unmount();
      resetHeldWritesStore({ clearStorage: false, resetUser: false });
      setHeldWriteUser('owner-r10');
      blockStoredRemove = false;
      vi.mocked(listPendingCounts).mockResolvedValue([]);

      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      expect(
        await screen.findByText(waitingForSyncMessage),
      ).toBeInTheDocument();
      const restoredCardBtn = await screen.findByRole('button', {
        name: 'سجّل الجرد',
      });
      await waitFor(() => expect(restoredCardBtn).toBeEnabled());
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');
      expect(screen.queryByText(pendingResendMessage)).not.toBeInTheDocument();

      fireEvent.click(restoredCardBtn);
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(2));
      expect(vi.mocked(recordStoredCount).mock.calls[1]?.[0]).toEqual(
        storedPayload,
      );
      expect(await screen.findByText('اتسجل الجرد')).toBeInTheDocument();
      await waitFor(() => expect(getHeldWrite(storedSubject)).toBeNull());
      expect(localStorage.getItem(storedKey)).toBeNull();
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('R17-1c: stored count card stays replayable in-tab even when both removeItem and setItem fail on waiting_for_sync', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000085';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: null,
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const pendingCard = {
      requestId,
      preparedAt: '2026-10-22T10:05:00.000Z',
      countedAt,
      itemCount: 1,
      payload: storedPayload,
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([pendingCard]);

    const origRemove = localStorage.removeItem.bind(localStorage);
    const origSet = localStorage.setItem.bind(localStorage);
    let blockStorageWrites = false;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockStorageWrites && key === storedKey) {
          throw new Error('remove failed');
        }
        return origRemove(key);
      });
    const setSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => {
        if (blockStorageWrites && key === storedKey) {
          throw new Error('set failed');
        }
        return origSet(key, value);
      });

    vi.mocked(recordStoredCount)
      .mockImplementationOnce(() => {
        blockStorageWrites = true;
        return Promise.resolve({ status: 'waiting_for_sync' });
      })
      .mockResolvedValueOnce({ status: 'posted', countId: 'count-r17-1c' });

    try {
      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'سجّل الجرد' }),
      );
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByText(waitingForSyncMessage),
      ).toBeInTheDocument();
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');

      blockStorageWrites = false;
      vi.mocked(listPendingCounts).mockResolvedValue([]);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'سجّل الجرد' }),
        ).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'سجّل الجرد' }));
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(2));
      expect(vi.mocked(recordStoredCount).mock.calls[1]?.[0]).toEqual(
        storedPayload,
      );
      expect(await screen.findByText('اتسجل الجرد')).toBeInTheDocument();
      await waitFor(() => expect(localStorage.getItem(storedKey)).toBeNull());
    } finally {
      removeSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('R18-1a: stored count card stays replayable after both post-RPC storage lookups fail on waiting_for_sync', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000086';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: 'انتظار مع تعطل القراءة',
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const pendingCard = {
      requestId,
      preparedAt: '2026-10-22T10:05:00.000Z',
      countedAt,
      itemCount: 1,
      payload: storedPayload,
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([pendingCard]);

    const origGet = localStorage.getItem.bind(localStorage);
    let blockStoredRead = false;
    const getSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation((key) => {
        if (blockStoredRead && key === storedKey) {
          throw new Error('storage read failed after wait');
        }
        return origGet(key);
      });

    vi.mocked(recordStoredCount)
      .mockImplementationOnce(() => {
        blockStoredRead = true;
        return Promise.resolve({ status: 'waiting_for_sync' });
      })
      .mockResolvedValueOnce({ status: 'posted', countId: 'count-r18-1a' });

    try {
      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'سجّل الجرد' }),
      );
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByText(waitingForSyncMessage),
      ).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');

      // Even while storage reads still fail, an unrelated cross-tab storage event
      // must keep the acknowledged wait in memory.
      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: `${prefix}${encodeURIComponent('purchase:new')}`,
          }),
        );
      });
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');

      // Storage recovers and another unrelated cross-tab storage event fires.
      blockStoredRead = false;
      expect(JSON.parse(origGet(storedKey) ?? '{}')).toMatchObject({
        requestId,
        phase: 'inflight',
      });
      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: `${prefix}${encodeURIComponent('purchase:new')}`,
          }),
        );
      });
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');

      vi.mocked(listPendingCounts).mockResolvedValue([]);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'سجّل الجرد' }),
        ).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'سجّل الجرد' }));
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(2));
      expect(vi.mocked(recordStoredCount).mock.calls[1]?.[0]).toEqual(
        storedPayload,
      );
      expect(await screen.findByText('اتسجل الجرد')).toBeInTheDocument();
      await waitFor(() => expect(localStorage.getItem(storedKey)).toBeNull());
    } finally {
      getSpy.mockRestore();
    }
  });

  it('R18-1b: unrelated cross-tab storage event does not replace in-memory waiting_for_sync fallback with durable inflight', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000087';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: 'حدث تبويب آخر',
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const pendingCard = {
      requestId,
      preparedAt: '2026-10-22T10:05:00.000Z',
      countedAt,
      itemCount: 1,
      payload: storedPayload,
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([pendingCard]);

    const origRemove = localStorage.removeItem.bind(localStorage);
    const origSet = localStorage.setItem.bind(localStorage);
    let blockStorageWrites = false;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockStorageWrites && key === storedKey) {
          throw new Error('remove failed');
        }
        return origRemove(key);
      });
    const setSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => {
        if (blockStorageWrites && key === storedKey) {
          throw new Error('set failed');
        }
        return origSet(key, value);
      });

    vi.mocked(recordStoredCount)
      .mockImplementationOnce(() => {
        blockStorageWrites = true;
        return Promise.resolve({ status: 'waiting_for_sync' });
      })
      .mockResolvedValueOnce({ status: 'posted', countId: 'count-r18-1b' });

    try {
      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'سجّل الجرد' }),
      );
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByText(waitingForSyncMessage),
      ).toBeInTheDocument();
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');

      // An unrelated cross-tab storage event fires while localStorage still holds inflight.
      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: `${prefix}${encodeURIComponent('expense:new')}`,
          }),
        );
      });
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');

      blockStorageWrites = false;
      vi.mocked(listPendingCounts).mockResolvedValue([]);
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'سجّل الجرد' }),
        ).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'سجّل الجرد' }));
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(2));
      expect(vi.mocked(recordStoredCount).mock.calls[1]?.[0]).toEqual(
        storedPayload,
      );
      expect(await screen.findByText('اتسجل الجرد')).toBeInTheDocument();
      await waitFor(() => expect(localStorage.getItem(storedKey)).toBeNull());
    } finally {
      removeSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('R18-1c: wait acknowledgement is bound to exact claim across storage sync and revalidated under the shared lock before replay', async () => {
    const requestId = 'd1900000-0000-4000-8000-000000000088';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const prefix = userStoragePrefix('owner-r10');
    const storedKey = `${prefix}${encodeURIComponent(storedSubject)}`;
    const sharedCountLockKey = `${prefix}${encodeURIComponent(COUNT_DAILY_SUBJECT)}`;
    const { locks, nested } = makeAuditedLocks();
    const requestSpy = vi.spyOn(locks, 'request');
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: 'تحقق من القفل المشترك',
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const pendingCard = {
      requestId,
      preparedAt: '2026-10-22T10:05:00.000Z',
      countedAt,
      itemCount: 1,
      payload: storedPayload,
    };
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([pendingCard]);

    const origRemove = localStorage.removeItem.bind(localStorage);
    const origSet = localStorage.setItem.bind(localStorage);
    let blockStorageWrites = false;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation((key) => {
        if (blockStorageWrites && key === storedKey) {
          throw new Error('remove failed');
        }
        return origRemove(key);
      });
    const setSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => {
        if (blockStorageWrites && key === storedKey) {
          throw new Error('set failed');
        }
        return origSet(key, value);
      });

    vi.mocked(recordStoredCount).mockImplementationOnce(() => {
      blockStorageWrites = true;
      return Promise.resolve({ status: 'waiting_for_sync' });
    });

    try {
      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'سجّل الجرد' }),
      );
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(1));
      expect(getHeldWrite(storedSubject)?.phase).toBe('waiting_for_sync');

      // Storage recovers, but another tab has replaced the slot with a different inflight claim
      // and no storage event has arrived in this tab yet.
      blockStorageWrites = false;
      const originalDurable = JSON.parse(
        localStorage.getItem(storedKey) ?? '{}',
      ) as {
        claimId?: string;
      };
      const replacementClaimId = 'claim-from-other-tab';
      expect(originalDurable.claimId).not.toBe(replacementClaimId);
      localStorage.setItem(
        storedKey,
        JSON.stringify({
          ...originalDurable,
          claimId: replacementClaimId,
          phase: 'inflight',
        }),
      );

      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'سجّل الجرد' }),
        ).toBeEnabled(),
      );
      requestSpy.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'سجّل الجرد' }));

      // Revalidation under the shared lock must request the shared count lock and reject the stale wait ack without dispatching.
      await waitFor(() =>
        expect(requestSpy).toHaveBeenCalledWith(
          sharedCountLockKey,
          { mode: 'exclusive', ifAvailable: true },
          expect.any(Function),
        ),
      );
      await waitFor(() =>
        expect(getHeldWrite(storedSubject)).toMatchObject({
          requestId,
          claimId: replacementClaimId,
          phase: 'inflight',
        }),
      );
      expect(recordStoredCount).toHaveBeenCalledTimes(1);
      expect(nested).toEqual([]);

      // A subsequent cross-tab storage event also keeps the replacement inflight claim intact.
      act(() => {
        window.dispatchEvent(new StorageEvent('storage', { key: storedKey }));
      });
      expect(getHeldWrite(storedSubject)).toMatchObject({
        requestId,
        claimId: replacementClaimId,
        phase: 'inflight',
      });
    } finally {
      if (origLocks) {
        Object.defineProperty(navigator, 'locks', origLocks);
      } else {
        Reflect.deleteProperty(navigator, 'locks');
      }
      requestSpy.mockRestore();
      removeSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('R19-1a: late waiting_for_sync reply after sign-out and sign-in without Web Locks does not restore previous session pin and still releases claim', async () => {
    expect((navigator as unknown as { locks?: unknown }).locks).toBeUndefined();
    const requestId = 'd1900000-0000-4000-8000-000000000089';
    const countedAt = '2026-10-22T10:00:00.000Z';
    const storedSubject = `${COUNT_STORED_PREFIX}${requestId}`;
    const ownerBPrefix = userStoragePrefix('owner-b');
    const ownerBStoredKey = `${ownerBPrefix}${encodeURIComponent(storedSubject)}`;
    const storedPayload = {
      request_id: requestId,
      frequency: 'daily',
      counted_at: countedAt,
      note: 'جلسة سابقة',
      lines: [
        { item_id: 'tilapia', counted_qty: '7', expected_base_unit: 'kg' },
      ],
    };
    const pendingCard = {
      requestId,
      preparedAt: '2026-10-22T10:05:00.000Z',
      countedAt,
      itemCount: 1,
      payload: storedPayload,
    };
    setHeldWriteUser('owner-a');
    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    vi.mocked(listCounts).mockResolvedValue([]);
    vi.mocked(listPendingCounts).mockResolvedValue([pendingCard]);

    const origGet = localStorage.getItem.bind(localStorage);
    let blockStoredRead = false;
    const getSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation((key) => {
        if (blockStoredRead && key === ownerBStoredKey) {
          throw new Error('storage read failed after session switch');
        }
        return origGet(key);
      });

    let resolveStored!: (value: { status: 'waiting_for_sync' }) => void;
    vi.mocked(recordStoredCount).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStored = resolve;
        }),
    );

    try {
      render(
        <MemoryRouter>
          <CountsPage />
        </MemoryRouter>,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: 'سجّل الجرد' }),
      );
      await waitFor(() => expect(recordStoredCount).toHaveBeenCalledTimes(1));
      expect(hasLiveHeldWriteClaims()).toBe(true);

      act(() => {
        setWritesLocked(true);
        clearHeldWritesForUser('owner-a');
        setHeldWriteUser(null);
        setHeldWriteUser('owner-b');
      });

      blockStoredRead = true;
      await act(async () => {
        resolveStored({ status: 'waiting_for_sync' });
        await Promise.resolve();
      });

      await waitFor(() => expect(hasLiveHeldWriteClaims()).toBe(false));
      blockStoredRead = false;
      expect(getHeldWrite(storedSubject)).toBeNull();
      expect(hasAnyHeldWrite()).toBe(false);
      expect(localStorage.getItem(ownerBStoredKey)).toBeNull();
      expect(screen.queryByText(waitingForSyncMessage)).not.toBeInTheDocument();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('R20-1b: refocusing a tab (SIGNED_IN reconfirmation) settles an in-flight daily count without stranding inflight, while sign-out or session switch still rejects late replies', async () => {
    const makeSyntheticJwt = (payload: Record<string, unknown>): string => {
      const encode = (value: Record<string, unknown>) =>
        btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(JSON.stringify(value)),
          ),
        )
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/g, '');
      return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`;
    };
    const emitAuth = (event: string, session: AuthMockSession) => {
      authMock.session = session;
      for (const listener of [...authMock.listeners]) {
        listener(event, session);
      }
    };

    const userId = 'owner-r20';
    const jwtSid1 = makeSyntheticJwt({
      sub: userId,
      session_id: 'sid-r20-1',
      exp: 2_000_000_000,
    });
    const jwtSid2 = makeSyntheticJwt({
      sub: userId,
      session_id: 'sid-r20-2',
      exp: 2_000_007_200,
    });
    const jwtSid3 = makeSyntheticJwt({
      sub: userId,
      session_id: 'sid-r20-3',
      exp: 2_000_014_400,
    });
    const prefix = userStoragePrefix(userId);
    const dailyKey = `${prefix}${encodeURIComponent(COUNT_DAILY_SUBJECT)}`;
    const { locks, nested } = makeAuditedLocks();
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });

    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    let postedCounts: CountRecord[] = [];
    vi.mocked(listCounts).mockImplementation(() =>
      Promise.resolve([...postedCounts]),
    );
    vi.mocked(listPendingCounts).mockResolvedValue([]);

    let resolveFirst!: (value: { status: 'posted'; countId: string }) => void;
    let resolveSecond!: (value: { status: 'posted'; countId: string }) => void;
    let resolveThird!: (value: { status: 'posted'; countId: string }) => void;
    let resolveFourth!: (value: { status: 'posted'; countId: string }) => void;
    vi.mocked(recordCount)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveThird = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFourth = resolve;
          }),
      );

    try {
      authMock.listeners.splice(0, authMock.listeners.length);
      authMock.rpcResult = { data: true, error: null };
      authMock.session = {
        user: { id: userId, email: 'owner@theshark.test' },
        access_token: jwtSid1,
        refresh_token: 'rt-r20-1',
      };
      startAuth();

      render(
        <MemoryRouter>
          <AuthProvider>
            <RequireOwner>
              <CountsPage />
            </RequireOwner>
          </AuthProvider>
        </MemoryRouter>,
      );

      const qtyInput = await screen.findByLabelText('الكمية المعدودة بلطي');
      fireEvent.change(qtyInput, { target: { value: '8' } });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

      await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(1));
      expect(getHeldWrite(COUNT_DAILY_SUBJECT)?.phase).toBe('inflight');
      expect(hasLiveHeldWriteClaims()).toBe(true);

      // Simulate tab refocus: Supabase reconfirms the existing session with SIGNED_IN.
      act(() => {
        emitAuth('SIGNED_IN', {
          user: { id: userId, email: 'owner@theshark.test' },
          access_token: jwtSid1,
          refresh_token: 'rt-r20-1',
        });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      // The in-flight count succeeds after refocus and must settle cleanly on the visible page.
      postedCounts = [
        {
          id: 'cnt-r20-1',
          countedAt: '2026-10-22T10:00:00.000Z',
          createdAt: '2026-10-22T10:00:00.000Z',
          frequency: 'daily',
          note: 'جرد بعد الرجوع',
          itemCount: 1,
          shortageValue: '0',
          surplusValue: '0',
          revisedDifference: '0',
          compensatorSum: '0',
          hasCompensator: false,
          hasSurplus: false,
        },
      ];
      await act(async () => {
        resolveFirst({ status: 'posted', countId: 'cnt-r20-1' });
        await Promise.resolve();
      });

      expect(await screen.findByText('جرد بعد الرجوع')).toBeInTheDocument();
      expect(await screen.findByText('اتسجل الجرد')).toBeInTheDocument();
      await waitFor(() => expect(hasLiveHeldWriteClaims()).toBe(false));
      expect(getHeldWrite(COUNT_DAILY_SUBJECT)).toBeNull();
      expect(localStorage.getItem(dailyKey)).toBeNull();
      expect(hasAnyHeldWrite()).toBe(false);
      expect(screen.getByLabelText('الكمية المعدودة بلطي')).toBeEnabled();
      expect(nested).toEqual([]);

      // Now submit a second daily count, then sign out and sign in with a new session
      // while the RPC is still in flight: late reply must be discarded and lock released.
      fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
        target: { value: '6' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
      await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(2));
      expect(hasLiveHeldWriteClaims()).toBe(true);

      act(() => {
        emitAuth('SIGNED_OUT', null);
        emitAuth('SIGNED_IN', {
          user: { id: userId, email: 'owner@theshark.test' },
          access_token: jwtSid2,
          refresh_token: 'rt-r20-2',
        });
      });
      await screen.findByLabelText('الكمية المعدودة بلطي');

      await act(async () => {
        resolveSecond({ status: 'posted', countId: 'cnt-r20-2' });
        await Promise.resolve();
      });

      await waitFor(() => expect(hasLiveHeldWriteClaims()).toBe(false));
      expect(hasPostedReload(COUNT_DAILY_SUBJECT)).toBe(false);
      expect(localStorage.getItem(dailyKey)).toBeNull();
      expect(hasAnyHeldWrite()).toBe(false);
      expect(nested).toEqual([]);

      // Direct same-user session switch (new session_id without SIGNED_OUT) also rejects
      // the late reply, promotes the pin to unknown once released, and allows retrying the same request.
      fireEvent.change(screen.getByLabelText('الكمية المعدودة بلطي'), {
        target: { value: '5' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
      await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(3));
      const thirdRequestId =
        vi.mocked(recordCount).mock.calls[2]?.[0]?.requestId;
      expect(typeof thirdRequestId).toBe('string');
      expect(thirdRequestId).toBeTruthy();
      expect(hasLiveHeldWriteClaims()).toBe(true);

      act(() => {
        emitAuth('SIGNED_IN', {
          user: { id: userId, email: 'owner@theshark.test' },
          access_token: jwtSid3,
          refresh_token: 'rt-r20-3',
        });
      });
      await screen.findByLabelText('الكمية المعدودة بلطي');

      await act(async () => {
        resolveThird({ status: 'posted', countId: 'cnt-r20-3' });
        await Promise.resolve();
      });

      await waitFor(() => expect(hasLiveHeldWriteClaims()).toBe(false));
      expect(hasPostedReload(COUNT_DAILY_SUBJECT)).toBe(false);
      await waitFor(() => {
        const recovered = getHeldWrite(COUNT_DAILY_SUBJECT);
        expect(recovered?.phase).toBe('unknown');
        expect(recovered?.requestId).toBe(thirdRequestId);
      });
      expect(
        JSON.parse(localStorage.getItem(dailyKey) ?? 'null'),
      ).toMatchObject({
        requestId: thirdRequestId,
        phase: 'unknown',
      });

      // The same request can be retried after lock release and settles cleanly.
      const retryButton = screen.getByRole('button', { name: 'حفظ' });
      await waitFor(() => expect(retryButton).toBeEnabled());
      fireEvent.click(retryButton);
      await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(4));
      expect(vi.mocked(recordCount).mock.calls[3]?.[0]?.requestId).toBe(
        thirdRequestId,
      );

      postedCounts = [
        ...postedCounts,
        {
          id: 'cnt-r20-3',
          countedAt: '2026-10-22T11:00:00.000Z',
          createdAt: '2026-10-22T11:00:00.000Z',
          frequency: 'daily',
          note: 'جرد بعد تبديل الجلسة',
          itemCount: 1,
          shortageValue: '0',
          surplusValue: '0',
          revisedDifference: '0',
          compensatorSum: '0',
          hasCompensator: false,
          hasSurplus: false,
        },
      ];
      await act(async () => {
        resolveFourth({ status: 'posted', countId: 'cnt-r20-3' });
        await Promise.resolve();
      });

      expect(
        await screen.findByText('جرد بعد تبديل الجلسة'),
      ).toBeInTheDocument();
      await waitFor(() => expect(hasLiveHeldWriteClaims()).toBe(false));
      expect(getHeldWrite(COUNT_DAILY_SUBJECT)).toBeNull();
      expect(localStorage.getItem(dailyKey)).toBeNull();
      expect(hasAnyHeldWrite()).toBe(false);
      expect(screen.getByLabelText('الكمية المعدودة بلطي')).toBeEnabled();
      expect(nested).toEqual([]);
    } finally {
      authMock.session = null;
      authMock.rpcResult = { data: true, error: null };
      authMock.listeners.splice(0, authMock.listeners.length);
      resetAuthStore();
      if (origLocks) {
        Object.defineProperty(navigator, 'locks', origLocks);
      } else {
        Reflect.deleteProperty(navigator, 'locks');
      }
    }
  });

  it('R21-1: when RequireOwner unmounts and remounts CountsPage while a daily count is in flight, post-save refresh routes to the mounted page', async () => {
    const makeSyntheticJwt = (payload: Record<string, unknown>): string => {
      const encode = (value: Record<string, unknown>) =>
        btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(JSON.stringify(value)),
          ),
        )
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/g, '');
      return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`;
    };
    const emitAuth = (event: string, session: AuthMockSession) => {
      authMock.session = session;
      for (const listener of [...authMock.listeners]) {
        listener(event, session);
      }
    };

    const userId = 'owner-r21';
    const jwtSid1 = makeSyntheticJwt({
      sub: userId,
      session_id: 'sid-r21-1',
      exp: 2_000_000_000,
    });
    const prefix = userStoragePrefix(userId);
    const dailyKey = `${prefix}${encodeURIComponent(COUNT_DAILY_SUBJECT)}`;
    const { locks, nested } = makeAuditedLocks();
    const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: locks,
    });

    vi.mocked(listDailyItems).mockResolvedValue([
      {
        id: 'tilapia',
        name: 'بلطي',
        baseUnit: 'kg',
        onHandQty: '10',
        onHandValue: '100.00',
        avgCost: '10.00',
      },
    ]);
    let posted = false;
    const freshCount: CountRecord = {
      id: 'cnt-r21-1',
      countedAt: '2026-10-22T12:00:00.000Z',
      createdAt: '2026-10-22T12:00:00.000Z',
      frequency: 'daily',
      note: 'جرد بعد إعادة التحميل',
      itemCount: 1,
      shortageValue: '0',
      surplusValue: '0',
      revisedDifference: '0',
      compensatorSum: '0',
      hasCompensator: false,
      hasSurplus: false,
    };
    vi.mocked(listCounts).mockImplementation(() =>
      Promise.resolve(posted ? [freshCount] : []),
    );
    vi.mocked(listPendingCounts).mockResolvedValue([]);

    let resolveCount!: (value: { status: 'posted'; countId: string }) => void;
    vi.mocked(recordCount).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCount = resolve;
        }),
    );

    try {
      authMock.listeners.splice(0, authMock.listeners.length);
      authMock.rpcResult = { data: true, error: null };
      authMock.session = {
        user: { id: userId, email: 'owner@theshark.test' },
        access_token: jwtSid1,
        refresh_token: 'rt-r21-1',
      };
      startAuth();

      render(
        <MemoryRouter>
          <AuthProvider>
            <RequireOwner>
              <CountsPage />
            </RequireOwner>
          </AuthProvider>
        </MemoryRouter>,
      );

      const firstInput = await screen.findByLabelText('الكمية المعدودة بلطي');
      fireEvent.change(firstInput, { target: { value: '7' } });
      fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
      await waitFor(() => expect(recordCount).toHaveBeenCalledTimes(1));
      expect(getHeldWrite(COUNT_DAILY_SUBJECT)?.phase).toBe('inflight');

      // Force RequireOwner to unmount CountsPage via a transient owner-check error,
      // then retry so a fresh CountsPage mounts and reads empty counts before the write posts.
      authMock.rpcResult = { data: null, error: { message: 'temporary' } };
      act(() => {
        emitAuth('SIGNED_IN', {
          user: { id: userId, email: 'owner@theshark.test' },
          access_token: jwtSid1,
          refresh_token: 'rt-r21-1',
        });
      });
      expect(
        await screen.findByText('تعذر التحقق من صلاحية الحساب'),
      ).toBeInTheDocument();

      authMock.rpcResult = { data: true, error: null };
      fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

      const remountedInput = await screen.findByLabelText(
        'الكمية المعدودة بلطي',
      );
      expect(remountedInput).not.toBe(firstInput);
      expect(screen.getByText('لسه مفيش جرد')).toBeInTheDocument();
      expect(remountedInput).toBeDisabled();

      // Now the in-flight count posts on the server. The mounted page must receive
      // the fresh readback before the pin clears and unlocks the form.
      posted = true;
      await act(async () => {
        resolveCount({ status: 'posted', countId: freshCount.id });
        await Promise.resolve();
      });

      expect(
        await screen.findByText('جرد بعد إعادة التحميل'),
      ).toBeInTheDocument();
      expect(screen.queryByText('لسه مفيش جرد')).not.toBeInTheDocument();
      expect(await screen.findByText('اتسجل الجرد')).toBeInTheDocument();
      await waitFor(() => expect(hasLiveHeldWriteClaims()).toBe(false));
      expect(getHeldWrite(COUNT_DAILY_SUBJECT)).toBeNull();
      expect(localStorage.getItem(dailyKey)).toBeNull();
      expect(hasAnyHeldWrite()).toBe(false);
      expect(screen.getByLabelText('الكمية المعدودة بلطي')).toBeEnabled();
      expect(nested).toEqual([]);
    } finally {
      authMock.session = null;
      authMock.rpcResult = { data: true, error: null };
      authMock.listeners.splice(0, authMock.listeners.length);
      resetAuthStore();
      if (origLocks) {
        Object.defineProperty(navigator, 'locks', origLocks);
      } else {
        Reflect.deleteProperty(navigator, 'locks');
      }
    }
  });
});
