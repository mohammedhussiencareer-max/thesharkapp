import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createItem,
  getItemById,
  listItems,
  setItemLoss,
  setOpeningPrice,
  updateItem,
} from '@/items/api';
import {
  expectationFromDraft,
  expectationFromItem,
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
  firstUnknownItemCreate,
  ITEMS_RELOAD_SUBJECT,
  listPostedCostingPins,
  markActionPostedReload,
  priceSubject,
} from '@/items/request-id';
import { verifyConversionItem, verifyLossItem } from '@/items/verify';
import type { CatalogItem, ItemSave } from '@/items/types';
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
  return [
    ...snapshotPostedReloads({ readTarget: ITEMS_RELOAD_SUBJECT }),
    ...snapshotPostedReloads({ subject: ITEMS_RELOAD_SUBJECT }),
  ];
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
  const [items, setItems] = useState<CatalogItem[] | null>(null);
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
  const detailsVerifyRef = useRef<DetailsVerifyState | null>(detailsVerify);
  const pendingSavedItemIdRef = useRef<string | null>(null);
  const dataSessionRef = useRef<WriteSession | null>(null);
  const catalogSeqRef = useRef(0);
  const itemReadSeqRef = useRef(new Map<string, number>());
  const catalogLoadsRef = useRef(0);

  const setDetailsVerifyState = useCallback(
    (next: DetailsVerifyState | null) => {
      detailsVerifyRef.current = next;
      setDetailsVerify(next);
    },
    [],
  );

  // Every catalog read goes through here: it holds the page lock while in
  // flight, and only the newest read may apply its rows or its error.
  const readCatalog = useCallback(async (): Promise<CatalogItem[] | null> => {
    const seq = ++catalogSeqRef.current;
    const readSession = captureWriteSession();
    catalogLoadsRef.current += 1;
    setCatalogLoads(catalogLoadsRef.current);
    try {
      const next = await listItems();
      if (seq !== catalogSeqRef.current) return null;
      dataSessionRef.current = readSession;
      return next;
    } catch (error) {
      if (seq !== catalogSeqRef.current) return null;
      throw error;
    } finally {
      catalogLoadsRef.current -= 1;
      setCatalogLoads(catalogLoadsRef.current);
    }
  }, []);

  type ItemByIdResult =
    { status: 'ok'; item: CatalogItem | null } | { status: 'superseded' };

  // Targeted by-ID read for single-item verification, acknowledged details
  // refreshes, and stale-write reloads (avoiding the 1,000-row catalog cap).
  const readItemById = useCallback(
    async (itemId: string): Promise<ItemByIdResult> => {
      const catalogSeq = catalogSeqRef.current;
      const itemSeq = (itemReadSeqRef.current.get(itemId) ?? 0) + 1;
      itemReadSeqRef.current.set(itemId, itemSeq);
      const readSession = captureWriteSession();
      const isSuperseded = () =>
        catalogSeq !== catalogSeqRef.current ||
        itemReadSeqRef.current.get(itemId) !== itemSeq;
      catalogLoadsRef.current += 1;
      setCatalogLoads(catalogLoadsRef.current);
      try {
        const fresh = await getItemById(itemId);
        if (isSuperseded()) return { status: 'superseded' };
        dataSessionRef.current = readSession;
        return { status: 'ok', item: fresh };
      } catch (error) {
        if (isSuperseded()) return { status: 'superseded' };
        throw error;
      } finally {
        catalogLoadsRef.current -= 1;
        setCatalogLoads(catalogLoadsRef.current);
      }
    },
    [],
  );

  const mergeFetchedItem = useCallback((fresh: CatalogItem) => {
    setItems((current) => {
      if (!current) return [fresh];
      const exists = current.some((row) => row.id === fresh.id);
      return exists
        ? current.map((row) => (row.id === fresh.id ? fresh : row))
        : [...current, fresh];
    });
  }, []);

  const applyVerifiedItem = useCallback(
    (fresh: CatalogItem) => {
      mergeFetchedItem(fresh);
      const editing = formModeRef.current;
      if (editing?.type === 'edit' && editing.id === fresh.id) {
        expectedRef.current = expectationFromItem(fresh);
      }
    },
    [mergeFetchedItem],
  );

  function setEditor(next: ItemEditor | null) {
    formModeRef.current = next;
    setFormMode(next);
  }

  const reconcileDetailsVerifyOnCatalog = useCallback(
    (next: CatalogItem[]) => {
      const current = detailsVerifyRef.current;
      if (!current || current.status === 'verified') return;
      const fresh = next.find((row) => row.id === current.itemId);
      // Never mark verification done when the affected item is absent from the catalog response.
      if (!fresh) return;
      const editing = formModeRef.current;
      if (editing?.type === 'edit' && editing.id === current.itemId) {
        expectedRef.current = expectationFromItem(fresh);
        setFormEpoch((value) => value + 1);
      }
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
    [setDetailsVerifyState],
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
    catalogLoadsRef.current += 1;
    setCatalogLoads(catalogLoadsRef.current);
    try {
      let firstError: unknown = null;
      await Promise.all(
        [...byItem.entries()].map(async ([itemId, entry]) => {
          try {
            const verified = entry.hasConversion
              ? await verifyConversionItem(itemId)
              : await verifyLossItem(itemId);
            applyVerifiedItem(verified.item);
            clearPostedReloadSnapshot(entry.snapshots, itemId);
          } catch (error) {
            if (firstError === null) firstError = error;
          }
        }),
      );
      if (firstError !== null) {
        setCostingVerifyError(messageFrom(firstError));
      }
    } finally {
      catalogLoadsRef.current -= 1;
      setCatalogLoads(catalogLoadsRef.current);
    }
  }, [applyVerifiedItem]);

  async function reloadCatalog(
    staleItemId?: string,
    staleMessage: string = staleWriteMessage,
  ): Promise<boolean> {
    const pendingReload = snapshotItemsReloads();
    const next = await readCatalog();
    if (!next) return false;
    setItems(next);
    setLoadError(null);
    clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
    reconcileDetailsVerifyOnCatalog(next);
    setLocalNeedsReload(false);
    const editing = formModeRef.current;
    if (staleItemId && editing?.type === 'edit' && editing.id === staleItemId) {
      let fresh = next.find((row) => row.id === staleItemId) ?? null;
      if (!fresh) {
        const byId = await readItemById(staleItemId);
        if (byId.status === 'superseded') return false;
        fresh = byId.item;
        if (fresh) mergeFetchedItem(fresh);
      }
      if (!fresh) {
        throw new Error(genericCatalogError);
      }
      expectedRef.current = expectationFromItem(fresh);
      setFormEpoch((value) => value + 1);
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
      mergeFetchedItem(result.item);
      setLoadError(null);
      const editing = formModeRef.current;
      if (editing?.type === 'edit' && editing.id === itemId) {
        expectedRef.current = expectationFromItem(result.item);
        setFormEpoch((value) => value + 1);
      }
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
    void (async () => {
      try {
        if (pendingItemId) {
          const result = await readItemById(pendingItemId);
          if (cancelled || result.status === 'superseded') return;
          if (!result.item) {
            setLoadError(genericCatalogError);
            return;
          }
          mergeFetchedItem(result.item);
          const editing = formModeRef.current;
          if (editing?.type === 'edit' && editing.id === pendingItemId) {
            expectedRef.current = expectationFromItem(result.item);
          }
          pendingSavedItemIdRef.current = null;
          setLoadError(null);
          setLocalNeedsReload(false);
        } else {
          const next = await readCatalog();
          if (cancelled || !next) return;
          setItems(next);
          setLoadError(null);
          clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
          reconcileDetailsVerifyOnCatalog(next);
          setLocalNeedsReload(false);
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(messageFrom(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void Promise.resolve().then(() => {
      if (!cancelled) return resumePostedCostingPins();
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [
    loadId,
    mergeFetchedItem,
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
      mergeFetchedItem(result.item);
      setLoadError(null);
      const editing = formModeRef.current;
      if (editing?.type === 'edit' && editing.id === current.itemId) {
        expectedRef.current = expectationFromItem(result.item);
        setFormEpoch((value) => value + 1);
      }
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
    setEditor({ type: 'create' });
  }

  function openEdit(item: CatalogItem) {
    if (writeLocked) return;
    setFormError(null);
    setDetailsVerifyState(null);
    // The form and the stale-write expectation always start from the same row.
    expectedRef.current = expectationFromItem(item);
    setFormEpoch((value) => value + 1);
    setEditor({ type: 'edit', id: item.id });
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
          mergeFetchedItem(result.item);
          if (sameEditor(formModeRef.current, started)) {
            expectedRef.current = expectationFromItem(result.item);
          }
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
          mergeFetchedItem(result.item);
          setLoadError(null);
          if (sameEditor(formModeRef.current, started)) {
            expectedRef.current = expectationFromItem(result.item);
            setFormEpoch((value) => value + 1);
          }
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
      const next = await readCatalog();
      if (next) {
        setItems(next);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        reconcileDetailsVerifyOnCatalog(next);
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
              onIdentityDirtyChange={setFormIdentityDirty}
              onItemStale={(itemId) =>
                reloadCatalog(itemId)
                  .then(() => undefined)
                  .catch((error: unknown) => {
                    setLoadError(messageFrom(error));
                  })
              }
              onItemVerified={applyVerifiedItem}
              onSubmit={(action) => handleSubmit(action)}
              onCancel={() => {
                if (busy) return;
                setEditor(null);
                setFormError(null);
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
              onEdit={openEdit}
              onToggleConversions={(itemId) =>
                setOpenConversionsId((current) =>
                  current === itemId ? null : itemId,
                )
              }
              onConversionsBusyChange={setConversionsBusy}
              onItemVerified={applyVerifiedItem}
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
