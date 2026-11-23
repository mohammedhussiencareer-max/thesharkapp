import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createItem,
  getItemById,
  listConversions,
  listCostingSchedule,
  listItems,
  setItemLoss,
  setOpeningPrice,
  updateItem,
  type ConversionList,
} from '@/items/api';
import {
  expectationFromDraft,
  expectationFromItem,
  sameExpectation,
  type ItemExpectation,
} from '@/items/expectation';
import { sameEditor, type ItemEditor } from '@/items/editor';
import {
  ConfirmedRefusalError,
  CostingChangedError,
  costingChangedMessage,
  genericCatalogError,
  messageFrom,
  StaleWriteError,
  staleWriteMessage,
} from '@/items/errors';
import { groupCatalog } from '@/items/group';
import { ItemForm } from '@/items/ItemForm';
import { ItemList } from '@/items/ItemList';
import {
  clearCostingPinsForItem,
  costingItemIdFromSubject,
  firstUnknownItemCreate,
  ITEMS_RELOAD_SUBJECT,
  listPostedCostingPins,
  markActionPostedReload,
  priceSubject,
} from '@/items/request-id';
import {
  verifyConversionItem,
  verifyLossItem,
  type ItemReadOutcome,
  type ItemReadRequest,
  type ItemSyncedData,
} from '@/items/verify';
import type { CatalogItem, CostingSchedule, ItemSave } from '@/items/types';
import { emptyItemForm, itemToFormValues } from '@/items/validation';
import {
  canDispatchWriteFor,
  captureWriteSession,
  clearPostedReloadSnapshot,
  hasPostedReloadForTarget,
  snapshotPostedReloads,
  subscribeHeldWritesStore,
  type PostedReloadSnapshot,
  type WriteSession,
} from '@/lib/held-writes';
import {
  isOnline,
  offlineMoneyMessage,
  offlineWriteMessage,
  useReconnectReload,
} from '@/lib/online';
import { pageShell, primaryButton, secondaryButton } from '@/lib/page-style';
import { isRequestlessDefiniteRefusal } from '@/lib/write-outcome';

type DetailsVerifyState = {
  itemId: string;
  reason: 'ambiguous' | 'stale';
  status: 'verifying' | 'read_failed' | 'verified';
  readError: string | null;
};

function snapshotItemsReloads(): PostedReloadSnapshot {
  const combined = [
    ...snapshotPostedReloads({ readTarget: ITEMS_RELOAD_SUBJECT }),
    ...snapshotPostedReloads({ subject: ITEMS_RELOAD_SUBJECT }),
  ];
  // Never let a plain catalog listItems() load prematurely clear a Round-8
  // loss/conversion pin that stored `readTarget: 'items:reload'`; those clear
  // exclusively after their combined verification read applies.
  return combined.filter(
    (entry) => costingItemIdFromSubject(entry.subject) === null,
  );
}

function visibleCount(
  items: readonly CatalogItem[],
  showInactive: boolean,
): number {
  const groups = groupCatalog(items, showInactive);
  const fish = groups.fish.reduce(
    (count, block) =>
      count + (block.showParent ? 1 : 0) + block.children.length,
    0,
  );
  return (
    fish +
    groups.orphans.length +
    groups.seafood.length +
    groups.ingredients.length +
    groups.packaging.length
  );
}

export function ItemsPage() {
  const [catalogState, setCatalogState] = useState<{
    items: CatalogItem[] | null;
    byId: Record<string, ItemSyncedData>;
  }>({ items: null, byId: {} });
  const items = catalogState.items;
  const itemDataById = catalogState.byId;
  const [freshItemNoticeId, setFreshItemNoticeId] = useState<string | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [costingVerifyError, setCostingVerifyError] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadId, setLoadId] = useState(0);
  const [showInactive, setShowInactive] = useState(false);
  const [conversionsBusy, setConversionsBusy] = useState(false);
  const [formMode, setFormMode] = useState<ItemEditor | null>(() =>
    firstUnknownItemCreate() !== null ? { type: 'create' } : null,
  );
  const [formEpoch, setFormEpoch] = useState(0);
  const [formIdentityDirty, setFormIdentityDirty] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [detailsVerify, setDetailsVerify] = useState<DetailsVerifyState | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  // A save landed and fresh rows are not applied yet: stay locked until a read applies them.
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [heldEpoch, setHeldEpoch] = useState(0);
  // One page-wide lock: while an item save or a conversion operation (and the
  // reload after it) is in flight, nothing that edits data or remounts a panel
  // can start, so no editor or panel ever opens on stale data.
  const [catalogLoads, setCatalogLoads] = useState(0);
  const postedCostingPins = heldEpoch < 0 ? [] : listPostedCostingPins();
  const postedReload =
    heldEpoch >= 0 &&
    (hasPostedReloadForTarget(ITEMS_RELOAD_SUBJECT) ||
      postedCostingPins.length > 0);
  const needsReload = localNeedsReload || postedReload;
  const detailsVerifyBlocked =
    detailsVerify !== null && detailsVerify.status !== 'verified';
  const busy = saving || conversionsBusy || needsReload || catalogLoads > 0;
  const online = useReconnectReload(() => {
    if (!saving && !conversionsBusy && catalogLoads === 0) {
      setLoading(true);
      setLoadError(null);
      setLoadId((value) => value + 1);
    }
  });
  const writeLocked = busy || !online || detailsVerifyBlocked;

  useEffect(
    () => subscribeHeldWritesStore(() => setHeldEpoch((value) => value + 1)),
    [],
  );
  const [openConversionsId, setOpenConversionsId] = useState<string | null>(
    null,
  );
  const formModeRef = useRef<ItemEditor | null>(formMode);
  const expectedRef = useRef<ItemExpectation | null>(null);
  const formDetailsDirtyRef = useRef(false);
  const detailsVerifyRef = useRef<DetailsVerifyState | null>(detailsVerify);
  const pendingSavedItemIdRef = useRef<string | null>(null);
  const dataSessionRef = useRef<WriteSession | null>(null);
  // Single monotonically increasing per-item read pipeline across catalog loads,
  // by-id refreshes, combined loss/conversion verification reads, and retries.
  const readSeqRef = useRef(0);
  const catalogIssuedSeqRef = useRef(0);
  const itemIssuedSeqRef = useRef(new Map<string, number>());
  const itemAppliedSeqRef = useRef(new Map<string, number>());
  const catalogLoadsRef = useRef(0);

  const setDetailsVerifyState = useCallback(
    (next: DetailsVerifyState | null) => {
      detailsVerifyRef.current = next;
      setDetailsVerify(next);
    },
    [],
  );

  const handleDetailsDirtyChange = useCallback((dirty: boolean) => {
    formDetailsDirtyRef.current = dirty;
  }, []);

  const beginCatalogRead = useCallback((): number => {
    const token = ++readSeqRef.current;
    catalogIssuedSeqRef.current = token;
    return token;
  }, []);

  const beginItemRead = useCallback((itemId: string): number => {
    const token = ++readSeqRef.current;
    itemIssuedSeqRef.current.set(itemId, token);
    return token;
  }, []);

  const isLatestForItem = useCallback((itemId: string, token: number) => {
    return (
      Math.max(
        itemIssuedSeqRef.current.get(itemId) ?? 0,
        catalogIssuedSeqRef.current,
      ) === token
    );
  }, []);

  const syncFormBaseline = useCallback(
    (
      fresh: CatalogItem,
      opts?: { forceSyncBaseline?: boolean; bumpFormEpoch?: boolean },
    ) => {
      const editing = formModeRef.current;
      if (editing?.type !== 'edit' || editing.id !== fresh.id) return;
      const nextExp = expectationFromItem(fresh);
      if (opts?.forceSyncBaseline) {
        expectedRef.current = nextExp;
        if (opts.bumpFormEpoch) {
          formDetailsDirtyRef.current = false;
          setFormEpoch((value) => value + 1);
        }
        setFreshItemNoticeId(null);
        return;
      }
      if (!formDetailsDirtyRef.current) {
        expectedRef.current = nextExp;
        setFormEpoch((value) => value + 1);
        setFreshItemNoticeId(null);
        return;
      }
      // Form has unsaved detail edits: keep the draft's CAS baseline and show
      // that fresher server data is available instead of silently merging.
      if (!sameExpectation(expectedRef.current, nextExp)) {
        setFreshItemNoticeId(fresh.id);
      }
    },
    [],
  );

  // Every catalog read goes through here: it holds the page lock while in
  // flight, and only applies rows for items without a newer per-item read.
  const readCatalog = useCallback(async (): Promise<{
    rows: CatalogItem[];
    token: number;
  } | null> => {
    const token = beginCatalogRead();
    const readSession = captureWriteSession();
    catalogLoadsRef.current += 1;
    setCatalogLoads(catalogLoadsRef.current);
    try {
      const next = await listItems();
      if (token !== catalogIssuedSeqRef.current) return null;
      dataSessionRef.current = readSession;
      return { rows: next, token };
    } catch (error) {
      if (token !== catalogIssuedSeqRef.current) return null;
      throw error;
    } finally {
      catalogLoadsRef.current -= 1;
      setCatalogLoads(catalogLoadsRef.current);
    }
  }, [beginCatalogRead]);

  const applyCatalogRows = useCallback(
    (next: CatalogItem[], catalogToken: number) => {
      setCatalogState((state) => {
        const currentById = new Map(
          (state.items ?? []).map((row) => [row.id, row]),
        );
        const seen = new Set<string>();
        const merged: CatalogItem[] = [];
        for (const row of next) {
          seen.add(row.id);
          const newerSeq = Math.max(
            itemIssuedSeqRef.current.get(row.id) ?? 0,
            itemAppliedSeqRef.current.get(row.id) ?? 0,
          );
          const existing = currentById.get(row.id);
          if (newerSeq > catalogToken && existing) {
            merged.push(existing);
          } else {
            merged.push(row);
            itemAppliedSeqRef.current.set(row.id, catalogToken);
          }
        }
        // Preserve rows beyond the 1,000-row cap that a newer by-id read applied.
        for (const [id, existing] of currentById.entries()) {
          if (seen.has(id)) continue;
          const newerSeq = Math.max(
            itemIssuedSeqRef.current.get(id) ?? 0,
            itemAppliedSeqRef.current.get(id) ?? 0,
          );
          if (newerSeq > catalogToken) {
            merged.push(existing);
          }
        }
        return { items: merged, byId: state.byId };
      });
    },
    [],
  );

  type ItemByIdResult =
    | { status: 'ok'; item: CatalogItem | null; token: number }
    | { status: 'superseded' };

  // Targeted by-ID read sharing the same per-item read token sequence.
  const readItemById = useCallback(
    async (itemId: string): Promise<ItemByIdResult> => {
      const token = beginItemRead(itemId);
      const readSession = captureWriteSession();
      catalogLoadsRef.current += 1;
      setCatalogLoads(catalogLoadsRef.current);
      try {
        const fresh = await getItemById(itemId);
        if (!isLatestForItem(itemId, token)) return { status: 'superseded' };
        dataSessionRef.current = readSession;
        return { status: 'ok', item: fresh, token };
      } catch (error) {
        if (!isLatestForItem(itemId, token)) return { status: 'superseded' };
        throw error;
      } finally {
        catalogLoadsRef.current -= 1;
        setCatalogLoads(catalogLoadsRef.current);
      }
    },
    [beginItemRead, isLatestForItem],
  );

  const applyItemTransition = useCallback(
    (
      itemId: string,
      token: number,
      payload: {
        item?: CatalogItem;
        schedule?: CostingSchedule;
        conversions?: ConversionList;
      },
      opts?: {
        forceSyncBaseline?: boolean;
        bumpFormEpoch?: boolean;
        clearPins?: PostedReloadSnapshot;
      },
    ): boolean => {
      if (!isLatestForItem(itemId, token)) return false;
      itemAppliedSeqRef.current.set(itemId, token);
      setCatalogState((state) => {
        let nextItems = state.items;
        if (payload.item) {
          const fresh = payload.item;
          if (!state.items) {
            nextItems = [fresh];
          } else {
            const exists = state.items.some((row) => row.id === fresh.id);
            nextItems = exists
              ? state.items.map((row) => (row.id === fresh.id ? fresh : row))
              : [...state.items, fresh];
          }
        }
        let nextById = state.byId;
        if (payload.schedule || payload.conversions) {
          const prev = state.byId[itemId];
          nextById = {
            ...state.byId,
            [itemId]: {
              version: token,
              schedule: payload.schedule ?? prev?.schedule,
              conversions: payload.conversions ?? prev?.conversions,
            },
          };
        }
        return { items: nextItems, byId: nextById };
      });
      if (payload.item) {
        syncFormBaseline(payload.item, opts);
      }
      if (opts?.clearPins && opts.clearPins.length > 0) {
        clearCostingPinsForItem(opts.clearPins, itemId);
      }
      return true;
    },
    [isLatestForItem, syncFormBaseline],
  );

  /**
   * Single per-item read entry point shared by ItemsPage, ItemForm, and
   * ConversionsPanel for combined loss/conversion verification reads and
   * panel/form schedule/conversion loads.
   */
  const runItemRead = useCallback(
    async (
      itemId: string,
      request: ItemReadRequest,
    ): Promise<ItemReadOutcome> => {
      if (request.kind === 'loss' || request.kind === 'conversion') {
        const token = beginItemRead(itemId);
        const readSession = captureWriteSession();
        catalogLoadsRef.current += 1;
        setCatalogLoads(catalogLoadsRef.current);
        try {
          if (request.kind === 'loss') {
            const verified = await verifyLossItem(itemId);
            if (!isLatestForItem(itemId, token)) {
              return { status: 'superseded' };
            }
            dataSessionRef.current = readSession;
            applyItemTransition(
              itemId,
              token,
              { item: verified.item, schedule: verified.schedule },
              { clearPins: request.snapshots },
            );
            return {
              status: 'applied',
              item: verified.item,
              schedule: verified.schedule,
            };
          }
          const verified = await verifyConversionItem(itemId);
          if (!isLatestForItem(itemId, token)) {
            return { status: 'superseded' };
          }
          dataSessionRef.current = readSession;
          applyItemTransition(
            itemId,
            token,
            {
              item: verified.item,
              schedule: verified.schedule,
              conversions: verified.conversions,
            },
            { clearPins: request.snapshots },
          );
          return {
            status: 'applied',
            item: verified.item,
            schedule: verified.schedule,
            conversions: verified.conversions,
          };
        } catch (error) {
          if (!isLatestForItem(itemId, token)) {
            return { status: 'superseded' };
          }
          throw error;
        } finally {
          catalogLoadsRef.current -= 1;
          setCatalogLoads(catalogLoadsRef.current);
        }
      }

      // Passive panel/form read (no pending pin): uses the same monotonic clock
      // so it can never overwrite schedule/conversions from a newer item read,
      // without locking page-level details edits while opening.
      const token = ++readSeqRef.current;
      if (request.kind === 'schedule') {
        const nextSchedule = await listCostingSchedule(itemId);
        if (token > (itemAppliedSeqRef.current.get(itemId) ?? 0)) {
          setCatalogState((state) => {
            const prev = state.byId[itemId];
            if (prev && prev.version > token) return state;
            return {
              items: state.items,
              byId: {
                ...state.byId,
                [itemId]: {
                  version: token,
                  schedule: nextSchedule,
                  conversions: prev?.conversions,
                },
              },
            };
          });
        }
        return { status: 'applied', schedule: nextSchedule };
      }
      const [nextConversions, nextSchedule] = await Promise.all([
        listConversions(itemId),
        listCostingSchedule(itemId),
      ]);
      if (token > (itemAppliedSeqRef.current.get(itemId) ?? 0)) {
        setCatalogState((state) => {
          const prev = state.byId[itemId];
          if (prev && prev.version > token) return state;
          return {
            items: state.items,
            byId: {
              ...state.byId,
              [itemId]: {
                version: token,
                schedule: nextSchedule,
                conversions: nextConversions,
              },
            },
          };
        });
      }
      return {
        status: 'applied',
        schedule: nextSchedule,
        conversions: nextConversions,
      };
    },
    [applyItemTransition, beginItemRead, isLatestForItem],
  );

  function setEditor(next: ItemEditor | null) {
    formModeRef.current = next;
    setFormMode(next);
  }

  const reconcileDetailsVerifyOnCatalog = useCallback(
    (next: CatalogItem[], catalogToken: number) => {
      const current = detailsVerifyRef.current;
      if (!current || current.status === 'verified') return;
      const newerSeq = Math.max(
        itemIssuedSeqRef.current.get(current.itemId) ?? 0,
        itemAppliedSeqRef.current.get(current.itemId) ?? 0,
      );
      if (newerSeq > catalogToken) return;
      const fresh = next.find((row) => row.id === current.itemId);
      // Never mark verification done when the affected item is absent from the catalog response.
      if (!fresh) return;
      syncFormBaseline(fresh, {
        forceSyncBaseline: true,
        bumpFormEpoch: true,
      });
      if (current.reason === 'stale') {
        setFormError(staleWriteMessage);
        setDetailsVerifyState(null);
      } else {
        setDetailsVerifyState({
          itemId: current.itemId,
          reason: 'ambiguous',
          status: 'verified',
          readError: null,
        });
      }
    },
    [setDetailsVerifyState, syncFormBaseline],
  );

  const resumePostedCostingPins = useCallback(async () => {
    const pins = listPostedCostingPins();
    if (pins.length === 0 || !isOnline()) return;
    const byItem = new Map<
      string,
      { hasConversion: boolean; snapshots: PostedReloadSnapshot }
    >();
    for (const pin of pins) {
      const existing = byItem.get(pin.itemId) ?? {
        hasConversion: false,
        snapshots: [],
      };
      if (pin.kind === 'conversion') existing.hasConversion = true;
      existing.snapshots = [
        ...existing.snapshots,
        ...snapshotPostedReloads({ subject: pin.subject }),
      ];
      byItem.set(pin.itemId, existing);
    }
    setCostingVerifyError(null);
    let firstError: unknown = null;
    await Promise.all(
      [...byItem.entries()].map(async ([itemId, entry]) => {
        try {
          await runItemRead(itemId, {
            kind: entry.hasConversion ? 'conversion' : 'loss',
            snapshots: entry.snapshots,
          });
        } catch (error) {
          if (firstError === null) firstError = error;
        }
      }),
    );
    if (firstError !== null) {
      setCostingVerifyError(messageFrom(firstError));
    }
  }, [runItemRead]);

  async function reloadCatalog(
    staleItemId?: string,
    staleMessage: string = staleWriteMessage,
  ): Promise<boolean> {
    const pendingReload = snapshotItemsReloads();
    const loaded = await readCatalog();
    if (!loaded) return false;
    applyCatalogRows(loaded.rows, loaded.token);
    setLoadError(null);
    clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
    reconcileDetailsVerifyOnCatalog(loaded.rows, loaded.token);
    setLocalNeedsReload(false);
    const editing = formModeRef.current;
    if (staleItemId && editing?.type === 'edit' && editing.id === staleItemId) {
      let fresh = loaded.rows.find((row) => row.id === staleItemId) ?? null;
      if (!fresh) {
        const byId = await readItemById(staleItemId);
        if (byId.status === 'superseded') return false;
        fresh = byId.item;
        if (fresh) {
          applyItemTransition(
            staleItemId,
            byId.token,
            { item: fresh },
            { forceSyncBaseline: true, bumpFormEpoch: true },
          );
        }
      } else {
        syncFormBaseline(fresh, {
          forceSyncBaseline: true,
          bumpFormEpoch: true,
        });
      }
      if (!fresh) {
        throw new Error(genericCatalogError);
      }
      setFormError(staleMessage);
      return true;
    }
    return true;
  }

  async function refreshStaleDetailsItem(itemId: string): Promise<boolean> {
    setDetailsVerifyState({
      itemId,
      reason: 'stale',
      status: 'verifying',
      readError: null,
    });
    try {
      const result = await readItemById(itemId);
      if (result.status === 'superseded') {
        // Only stay locked if no newer read has already refreshed this item.
        if (
          detailsVerifyRef.current?.itemId === itemId &&
          detailsVerifyRef.current.status !== 'verified'
        ) {
          setDetailsVerifyState({
            itemId,
            reason: 'stale',
            status: 'read_failed',
            readError: genericCatalogError,
          });
        }
        return false;
      }
      if (!result.item) {
        setDetailsVerifyState({
          itemId,
          reason: 'stale',
          status: 'read_failed',
          readError: genericCatalogError,
        });
        return false;
      }
      applyItemTransition(
        itemId,
        result.token,
        { item: result.item },
        { forceSyncBaseline: true, bumpFormEpoch: true },
      );
      setLoadError(null);
      setFormError(staleWriteMessage);
      setDetailsVerifyState(null);
      return true;
    } catch (reloadError) {
      setDetailsVerifyState({
        itemId,
        reason: 'stale',
        status: 'read_failed',
        readError: messageFrom(reloadError),
      });
      return false;
    }
  }

  useEffect(() => {
    let cancelled = false;
    const pendingReload = snapshotItemsReloads();
    const pendingItemId = pendingSavedItemIdRef.current;
    // Start the catalog/pending-item read FIRST so its sequence token precedes
    // any concurrent mount resumption of costing pins (guaranteeing the catalog
    // list response can never overwrite a row applied by a newer combined read).
    const catalogPromise = (async () => {
      try {
        if (pendingItemId) {
          const result = await readItemById(pendingItemId);
          if (cancelled || result.status === 'superseded') return;
          if (!result.item) {
            setLoadError(genericCatalogError);
            return;
          }
          applyItemTransition(
            pendingItemId,
            result.token,
            { item: result.item },
            { forceSyncBaseline: true, bumpFormEpoch: true },
          );
          pendingSavedItemIdRef.current = null;
          setLoadError(null);
          setLocalNeedsReload(false);
        } else {
          const loaded = await readCatalog();
          if (cancelled || !loaded) return;
          applyCatalogRows(loaded.rows, loaded.token);
          setLoadError(null);
          clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
          reconcileDetailsVerifyOnCatalog(loaded.rows, loaded.token);
          setLocalNeedsReload(false);
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(messageFrom(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void catalogPromise;
    void Promise.resolve().then(() => {
      if (!cancelled) return resumePostedCostingPins();
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [
    applyCatalogRows,
    applyItemTransition,
    loadId,
    readCatalog,
    readItemById,
    reconcileDetailsVerifyOnCatalog,
    resumePostedCostingPins,
  ]);

  function retry() {
    if (saving || conversionsBusy || catalogLoadsRef.current > 0) return;
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  async function verifyDetailsRead(): Promise<void> {
    const current = detailsVerifyRef.current;
    if (
      !current ||
      saving ||
      conversionsBusy ||
      catalogLoadsRef.current > 0 ||
      !isOnline()
    ) {
      return;
    }
    if (current.reason === 'stale') {
      await refreshStaleDetailsItem(current.itemId);
      return;
    }
    setDetailsVerifyState({ ...current, status: 'verifying', readError: null });
    try {
      const result = await readItemById(current.itemId);
      if (result.status === 'superseded') {
        if (
          detailsVerifyRef.current?.itemId === current.itemId &&
          detailsVerifyRef.current.status !== 'verified'
        ) {
          setDetailsVerifyState({
            itemId: current.itemId,
            reason: 'ambiguous',
            status: 'read_failed',
            readError: genericCatalogError,
          });
        }
        return;
      }
      if (!result.item) {
        setDetailsVerifyState({
          itemId: current.itemId,
          reason: 'ambiguous',
          status: 'read_failed',
          readError: genericCatalogError,
        });
        return;
      }
      applyItemTransition(
        current.itemId,
        result.token,
        { item: result.item },
        { forceSyncBaseline: true, bumpFormEpoch: true },
      );
      setLoadError(null);
      setDetailsVerifyState({
        itemId: current.itemId,
        reason: 'ambiguous',
        status: 'verified',
        readError: null,
      });
    } catch (readError) {
      setDetailsVerifyState({
        itemId: current.itemId,
        reason: 'ambiguous',
        status: 'read_failed',
        readError: messageFrom(readError),
      });
    }
  }

  function openCreate() {
    if (writeLocked) return;
    setFormError(null);
    setDetailsVerifyState(null);
    setFreshItemNoticeId(null);
    formDetailsDirtyRef.current = false;
    setEditor({ type: 'create' });
  }

  function openEdit(item: CatalogItem) {
    if (writeLocked) return;
    setFormError(null);
    setDetailsVerifyState(null);
    setFreshItemNoticeId(null);
    formDetailsDirtyRef.current = false;
    // The form and the stale-write expectation always start from the same row.
    expectedRef.current = expectationFromItem(item);
    setFormEpoch((value) => value + 1);
    setEditor({ type: 'edit', id: item.id });
  }

  function adoptFreshItem() {
    const editing = formModeRef.current;
    if (editing?.type !== 'edit' || !items) return;
    const fresh = items.find((row) => row.id === editing.id);
    if (!fresh) return;
    expectedRef.current = expectationFromItem(fresh);
    formDetailsDirtyRef.current = false;
    setFormEpoch((value) => value + 1);
    setFreshItemNoticeId(null);
    setFormError(null);
  }

  async function handleSubmit(action: ItemSave): Promise<boolean> {
    const started = formModeRef.current;
    if (
      !started ||
      busy ||
      detailsVerifyBlocked ||
      catalogLoadsRef.current > 0 ||
      !isOnline()
    ) {
      return false;
    }
    if (action.kind === 'details') {
      if (started.type !== 'edit') return false;
      const expected = expectedRef.current;
      if (!expected) {
        throw new StaleWriteError();
      }
      const session = dataSessionRef.current ?? captureWriteSession();
      if (!canDispatchWriteFor(session)) {
        if (!isOnline()) setFormError(offlineWriteMessage);
        return false;
      }
      setSaving(true);
      setFormError(null);
      setDetailsVerifyState(null);
      let saved = false;
      try {
        await updateItem(started.id, action.draft, expected);
        expectedRef.current = expectationFromDraft(action.draft);
        saved = true;
        pendingSavedItemIdRef.current = started.id;
        setLocalNeedsReload(true);
        const result = await readItemById(started.id);
        if (result.status === 'ok' && result.item) {
          applyItemTransition(
            started.id,
            result.token,
            { item: result.item },
            { forceSyncBaseline: true },
          );
          pendingSavedItemIdRef.current = null;
          setLoadError(null);
          setLocalNeedsReload(false);
        } else if (result.status === 'ok' && !result.item) {
          setLoadError(genericCatalogError);
        }
        return true;
      } catch (error) {
        if (saved) {
          pendingSavedItemIdRef.current = started.id;
          setLocalNeedsReload(true);
          setLoadError(messageFrom(error));
          return true;
        }
        if (error instanceof StaleWriteError) {
          if (sameEditor(formModeRef.current, started)) {
            const applied = await refreshStaleDetailsItem(started.id);
            if (applied && error instanceof CostingChangedError) {
              setFormError(costingChangedMessage);
            }
          }
          throw error;
        }
        if (
          error instanceof ConfirmedRefusalError ||
          isRequestlessDefiniteRefusal(error)
        ) {
          if (sameEditor(formModeRef.current, started)) {
            setFormError(messageFrom(error));
          }
          throw error;
        }
        // Ambiguous outcome: show "مش متأكد إنه اتحفظ" and read the affected item by ID.
        setDetailsVerifyState({
          itemId: started.id,
          reason: 'ambiguous',
          status: 'verifying',
          readError: null,
        });
        try {
          const result = await readItemById(started.id);
          if (result.status === 'superseded') {
            if (
              detailsVerifyRef.current?.itemId === started.id &&
              detailsVerifyRef.current.status !== 'verified'
            ) {
              setDetailsVerifyState({
                itemId: started.id,
                reason: 'ambiguous',
                status: 'read_failed',
                readError: genericCatalogError,
              });
            }
            return false;
          }
          if (!result.item) {
            setDetailsVerifyState({
              itemId: started.id,
              reason: 'ambiguous',
              status: 'read_failed',
              readError: genericCatalogError,
            });
            return false;
          }
          applyItemTransition(
            started.id,
            result.token,
            { item: result.item },
            { forceSyncBaseline: true, bumpFormEpoch: true },
          );
          setLoadError(null);
          setDetailsVerifyState({
            itemId: started.id,
            reason: 'ambiguous',
            status: 'verified',
            readError: null,
          });
        } catch (readError) {
          setDetailsVerifyState({
            itemId: started.id,
            reason: 'ambiguous',
            status: 'read_failed',
            readError: messageFrom(readError),
          });
        }
        return false;
      } finally {
        setSaving(false);
      }
    }

    setSaving(true);
    setFormError(null);
    let saved = false;
    try {
      if (action.kind === 'create') {
        if (started.type !== 'create') return false;
        await createItem(action.draft);
        saved = true;
      } else if (started.type !== 'edit') {
        return false;
      } else if (action.kind === 'loss') {
        // ItemForm owns the single-target loss pin and runs the combined
        // schedule + item-by-ID verification read immediately after this settles.
        await setItemLoss(started.id, action.lossPct, action.write);
        return true;
      } else {
        await setOpeningPrice(
          started.id,
          action.price,
          action.reason,
          action.expectedId,
          action.requestId,
          action.identity,
        );
        saved = true;
        markActionPostedReload(
          priceSubject(started.id),
          action.requestId,
          ITEMS_RELOAD_SUBJECT,
        );
      }
      // Locked from the moment the save lands until fresh rows are applied.
      // The editor stays open so a sibling section keeps its pending value.
      setLocalNeedsReload(true);
      if (
        action.kind === 'create' &&
        sameEditor(formModeRef.current, started)
      ) {
        setEditor(null);
      }
      const pendingReload = snapshotItemsReloads();
      const loaded = await readCatalog();
      if (loaded) {
        applyCatalogRows(loaded.rows, loaded.token);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        reconcileDetailsVerifyOnCatalog(loaded.rows, loaded.token);
        setLocalNeedsReload(false);
      }
    } catch (error) {
      if (
        !saved &&
        error instanceof StaleWriteError &&
        started.type === 'edit' &&
        sameEditor(formModeRef.current, started)
      ) {
        try {
          await reloadCatalog(
            started.id,
            error instanceof CostingChangedError
              ? costingChangedMessage
              : staleWriteMessage,
          );
        } catch (reloadError) {
          setFormError(messageFrom(reloadError));
        }
      } else if (!saved) {
        if (sameEditor(formModeRef.current, started)) {
          setFormError(messageFrom(error));
        }
      } else {
        setLocalNeedsReload(true);
        setLoadError(messageFrom(error));
      }
      if (!saved) throw error;
    } finally {
      setSaving(false);
    }
    return saved;
  }

  const editingItem =
    formMode?.type === 'edit'
      ? items?.find((item) => item.id === formMode.id)
      : undefined;
  const showForm =
    formMode?.type === 'create' || (formMode?.type === 'edit' && editingItem);

  return (
    <main className={pageShell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">الأصناف</h1>
      {!online ? (
        <>
          <p role="status">{offlineWriteMessage}</p>
          <p role="status">{offlineMoneyMessage}</p>
        </>
      ) : null}
      {postedCostingPins.length > 0 ? (
        <section
          aria-label="حالة التحقق من التكلفة"
          className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
        >
          <p role="status">جاري التحقق من حفظ بيانات التكلفة</p>
          {costingVerifyError ? <p role="alert">{costingVerifyError}</p> : null}
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || conversionsBusy || catalogLoads > 0 || !online}
            onClick={() => void resumePostedCostingPins()}
          >
            تحقق تاني
          </button>
        </section>
      ) : null}
      {detailsVerify &&
      (detailsVerify.reason === 'ambiguous' ||
        detailsVerify.status === 'read_failed') ? (
        <section
          aria-label="حالة حفظ بيانات الصنف"
          className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
        >
          {detailsVerify.reason === 'ambiguous' ? (
            <p role="status">مش متأكد إنه اتحفظ</p>
          ) : null}
          {detailsVerify.status === 'read_failed' ? (
            <>
              {detailsVerify.readError ? (
                <p role="alert">{detailsVerify.readError}</p>
              ) : null}
              <button
                className={secondaryButton}
                type="button"
                disabled={
                  saving || conversionsBusy || catalogLoads > 0 || !online
                }
                onClick={() => void verifyDetailsRead()}
              >
                {detailsVerify.reason === 'stale'
                  ? 'تحديث البيانات'
                  : 'تحقق تاني'}
              </button>
            </>
          ) : null}
        </section>
      ) : null}
      {loading && items === null ? <p>جاري تحميل الأصناف…</p> : null}
      {items === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericCatalogError}</p>
          <button
            className={secondaryButton}
            type="button"
            disabled={saving || conversionsBusy || catalogLoads > 0}
            onClick={retry}
          >
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {items !== null ? (
        <>
          {loadError ? (
            <div className="flex flex-col gap-2">
              <p role="alert">{loadError}</p>
              <button
                className={secondaryButton}
                type="button"
                disabled={saving || conversionsBusy || catalogLoads > 0}
                onClick={retry}
              >
                إعادة المحاولة
              </button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              className={primaryButton}
              type="button"
              disabled={writeLocked}
              onClick={openCreate}
            >
              ضيف صنف
            </button>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showInactive}
                disabled={busy}
                onChange={(event) => setShowInactive(event.target.checked)}
              />
              عرض الموقوف
            </label>
          </div>
          {showForm ? (
            <ItemForm
              key={formMode?.type === 'edit' ? formMode.id : 'create'}
              items={items}
              editingId={editingItem?.id}
              initial={
                editingItem ? itemToFormValues(editingItem) : emptyItemForm()
              }
              submitting={saving}
              locked={writeLocked}
              serverError={formError}
              onClearServerError={() => setFormError(null)}
              detailsKey={formEpoch}
              syncedSchedule={
                editingItem ? itemDataById[editingItem.id]?.schedule : undefined
              }
              freshDataAvailable={
                editingItem !== undefined &&
                freshItemNoticeId === editingItem.id
              }
              onAdoptFreshData={adoptFreshItem}
              onIdentityDirtyChange={setFormIdentityDirty}
              onDetailsDirtyChange={handleDetailsDirtyChange}
              onItemStale={(itemId) =>
                reloadCatalog(itemId)
                  .then(() => undefined)
                  .catch((error: unknown) => {
                    setLoadError(messageFrom(error));
                  })
              }
              onRunItemRead={runItemRead}
              onSubmit={(action) => handleSubmit(action)}
              onCancel={() => {
                if (busy) return;
                setEditor(null);
                setFormError(null);
                setFreshItemNoticeId(null);
                formDetailsDirtyRef.current = false;
                if (detailsVerifyRef.current?.status === 'verified') {
                  setDetailsVerifyState(null);
                }
              }}
            />
          ) : null}
          {items.length === 0 ? (
            <p>لسه مفيش أصناف — ضيف أول صنف</p>
          ) : visibleCount(items, showInactive) === 0 ? (
            <p>مفيش أصناف ظاهرة</p>
          ) : (
            <ItemList
              items={items}
              showInactive={showInactive}
              openConversionsId={openConversionsId}
              editsDisabled={writeLocked}
              hideMoney={!online}
              identityDirtyId={
                formIdentityDirty && formMode?.type === 'edit'
                  ? formMode.id
                  : null
              }
              syncedDataById={itemDataById}
              onEdit={openEdit}
              onToggleConversions={(itemId) =>
                setOpenConversionsId((current) =>
                  current === itemId ? null : itemId,
                )
              }
              onConversionsBusyChange={setConversionsBusy}
              onRunItemRead={runItemRead}
              onItemStale={(itemId) =>
                reloadCatalog(itemId)
                  .then(() => undefined)
                  .catch((error: unknown) => {
                    setLoadError(messageFrom(error));
                  })
              }
            />
          )}
        </>
      ) : null}
    </main>
  );
}
