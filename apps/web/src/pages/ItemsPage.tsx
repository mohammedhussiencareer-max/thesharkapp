import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createItem,
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
  markActionPostedReload,
  priceSubject,
} from '@/items/request-id';
import type { CatalogItem, ItemDraft, ItemSave } from '@/items/types';
import { emptyItemForm, itemToFormValues } from '@/items/validation';
import {
  abortClaimBeforeDispatch,
  captureWriteSession,
  clearPostedReloadSnapshot,
  hasAnyReloadMarker,
  hasPostedReloadForTarget,
  setReloadMarker,
  snapshotPostedReloads,
  storageWriteFailedMessage,
  subscribeHeldWritesStore,
  type PostedReloadSnapshot,
} from '@/lib/held-writes';
import {
  createRequestlessReconciler,
  type RequestlessPin,
} from '@/lib/requestless-reconcile';
import {
  isOnline,
  offlineMoneyMessage,
  offlineWriteMessage,
  useReconnectReload,
} from '@/lib/online';
import { pageShell, primaryButton, secondaryButton } from '@/lib/page-style';

const ITEMS_RELOAD_SUBJECT = 'items:reload';
const ITEM_DETAILS_PREFIX = 'item:details:';

/** Minimal fields persisted in localStorage to verify or replay an ambiguous item-details update. */
type StoredItemDetailsIntent = {
  itemId: string;
  draft: ItemDraft;
  expected: ItemExpectation;
};

function isStoredItemDetailsIntent(
  value: unknown,
): value is StoredItemDetailsIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<StoredItemDetailsIntent>;
  return (
    typeof row.itemId === 'string' &&
    row.draft !== undefined &&
    row.draft !== null &&
    typeof row.draft === 'object' &&
    row.expected !== undefined &&
    row.expected !== null &&
    typeof row.expected === 'object'
  );
}

function itemMatchesDetailsIntent(
  item: CatalogItem,
  intent: StoredItemDetailsIntent,
): boolean {
  const target = expectationFromDraft(intent.draft);
  const actual = expectationFromItem(item);
  return (
    actual.name === target.name &&
    actual.kind === target.kind &&
    actual.baseUnit === target.baseUnit &&
    actual.countFrequency === target.countFrequency &&
    actual.parentItemId === target.parentItemId &&
    actual.active === target.active
  );
}

function catalogMatchesDetailsIntent(
  catalog: readonly CatalogItem[],
  intent: StoredItemDetailsIntent,
): boolean {
  const fresh = catalog.find((row) => row.id === intent.itemId);
  return fresh !== undefined && itemMatchesDetailsIntent(fresh, intent);
}

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
  const [detailsNotice, setDetailsNotice] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A save landed and fresh rows are not applied yet: stay locked until a read applies them.
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const [reconcileEpoch, setReconcileEpoch] = useState(0);
  const [detailsReconciler] = useState(() =>
    createRequestlessReconciler<StoredItemDetailsIntent, CatalogItem[]>({
      prefixes: [ITEM_DETAILS_PREFIX],
      reloadSubject: ITEMS_RELOAD_SUBJECT,
      isIntent: isStoredItemDetailsIntent,
      targetOf: () => ITEMS_RELOAD_SUBJECT,
      markerTargetOf: () => undefined,
      matchesServerState: catalogMatchesDetailsIntent,
      onChange: () => setReconcileEpoch((value) => value + 1),
    }),
  );
  // One page-wide lock: while an item save or a conversion operation (and the
  // reload after it) is in flight, nothing that edits data or remounts a panel
  // can start, so no editor or panel ever opens on stale data.
  const [catalogLoads, setCatalogLoads] = useState(0);
  const recoverableDetailsPins =
    heldEpoch < 0 || reconcileEpoch < 0
      ? []
      : detailsReconciler.listRecoverablePins();
  const postedReload =
    heldEpoch >= 0 &&
    reconcileEpoch >= 0 &&
    (hasPostedReloadForTarget(ITEMS_RELOAD_SUBJECT) ||
      hasAnyReloadMarker(ITEMS_RELOAD_SUBJECT) ||
      detailsReconciler.hasAcknowledgedClaim());
  const needsReload = localNeedsReload || postedReload;
  const busy = saving || conversionsBusy || needsReload || catalogLoads > 0;
  const online = useReconnectReload(() => {
    if (!saving && !conversionsBusy && catalogLoads === 0) {
      setLoading(true);
      setLoadError(null);
      setLoadId((value) => value + 1);
    }
  });
  const writeLocked = busy || !online;

  useEffect(
    () => subscribeHeldWritesStore(() => setHeldEpoch((value) => value + 1)),
    [],
  );
  const [openConversionsId, setOpenConversionsId] = useState<string | null>(
    null,
  );
  const formModeRef = useRef<ItemEditor | null>(formMode);
  const expectedRef = useRef<ItemExpectation | null>(null);
  const catalogSeqRef = useRef(0);
  const catalogLoadsRef = useRef(0);

  // Every catalog read goes through here: it holds the page lock while in
  // flight, and only the newest read may apply its rows or its error.
  async function readCatalog(): Promise<CatalogItem[] | null> {
    const seq = ++catalogSeqRef.current;
    catalogLoadsRef.current += 1;
    setCatalogLoads(catalogLoadsRef.current);
    try {
      const next = await listItems();
      return seq === catalogSeqRef.current ? next : null;
    } catch (error) {
      if (seq !== catalogSeqRef.current) return null;
      throw error;
    } finally {
      catalogLoadsRef.current -= 1;
      setCatalogLoads(catalogLoadsRef.current);
    }
  }

  function setEditor(next: ItemEditor | null) {
    formModeRef.current = next;
    setFormMode(next);
  }

  const applyDetailsRead = useCallback(
    (
      snapshot: ReturnType<typeof detailsReconciler.snapshotBeforeRead>,
      catalog: CatalogItem[],
    ) => {
      const outcome = detailsReconciler.applyReadResult(
        snapshot,
        catalog,
        ITEMS_RELOAD_SUBJECT,
      );
      if (outcome.reconciledSubjects.size > 0) {
        setDetailsNotice('اتحفظت بيانات الصنف');
        setDetailsError(null);
        setFormError(null);
        const editing = formModeRef.current;
        if (editing?.type === 'edit') {
          const fresh = catalog.find((row) => row.id === editing.id);
          if (fresh) {
            expectedRef.current = expectationFromItem(fresh);
          }
        }
      }
      return outcome;
    },
    [detailsReconciler],
  );

  async function reloadCatalog(staleItemId?: string) {
    const pendingReload = snapshotItemsReloads();
    const detailsSnap =
      detailsReconciler.snapshotBeforeRead(ITEMS_RELOAD_SUBJECT);
    let next: CatalogItem[] | null;
    try {
      next = await readCatalog();
    } catch (error) {
      detailsReconciler.applyReadFailure(detailsSnap);
      throw error;
    }
    if (!next) return;
    setItems(next);
    setLoadError(null);
    clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
    applyDetailsRead(detailsSnap, next);
    setLocalNeedsReload(false);
    const editing = formModeRef.current;
    if (staleItemId && editing?.type === 'edit' && editing.id === staleItemId) {
      const fresh = next.find((row) => row.id === staleItemId);
      if (fresh) {
        expectedRef.current = expectationFromItem(fresh);
        setFormEpoch((value) => value + 1);
      }
      setFormError(staleWriteMessage);
    }
  }

  // A landed conversion can configure the item. Stay locked until the catalog
  // says so; a failed read leaves the lock and the retry button in place.
  async function refreshAfterConversion() {
    setReloadMarker(ITEMS_RELOAD_SUBJECT);
    setLocalNeedsReload(true);
    try {
      await reloadCatalog();
    } catch (error) {
      setLoadError(messageFrom(error));
    }
  }

  useEffect(() => {
    let cancelled = false;
    const pendingReload = snapshotItemsReloads();
    const detailsSnap =
      detailsReconciler.snapshotBeforeRead(ITEMS_RELOAD_SUBJECT);
    void (async () => {
      try {
        const next = await readCatalog();
        if (cancelled || !next) return;
        setItems(next);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        applyDetailsRead(detailsSnap, next);
        setLocalNeedsReload(false);
      } catch (error) {
        detailsReconciler.applyReadFailure(detailsSnap);
        if (cancelled) return;
        setLoadError(messageFrom(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadId, applyDetailsRead, detailsReconciler]);

  function retry() {
    if (saving || conversionsBusy || catalogLoadsRef.current > 0) return;
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function openCreate() {
    if (writeLocked) return;
    setFormError(null);
    setEditor({ type: 'create' });
  }

  function openEdit(item: CatalogItem) {
    if (writeLocked) return;
    setFormError(null);
    // The form and the stale-write expectation always start from the same row.
    expectedRef.current = expectationFromItem(item);
    setFormEpoch((value) => value + 1);
    setEditor({ type: 'edit', id: item.id });
  }

  async function handleSubmit(action: ItemSave): Promise<boolean> {
    const started = formModeRef.current;
    if (!started || busy || catalogLoadsRef.current > 0 || !isOnline())
      return false;
    setSaving(true);
    setFormError(null);
    setDetailsNotice(null);
    let detailsClaim: {
      subject: string;
      requestId: string;
      attempt: number;
      intent: StoredItemDetailsIntent;
      release: () => void;
    } | null = null;
    let saved = false;
    try {
      if (action.kind === 'details') {
        if (started.type !== 'edit') return false;
        const expected = expectedRef.current;
        if (!expected) {
          throw new StaleWriteError();
        }
        const detailsSubject = `${ITEM_DETAILS_PREFIX}${started.id}`;
        const minimalDraft: ItemDraft = {
          name: action.draft.name,
          kind: action.draft.kind,
          baseUnit: action.draft.baseUnit,
          countFrequency: action.draft.countFrequency,
          parentItemId: action.draft.parentItemId,
          lossPct: action.draft.lossPct,
          active: action.draft.active,
        };
        const intent: StoredItemDetailsIntent = {
          itemId: started.id,
          draft: minimalDraft,
          expected,
        };
        const session = captureWriteSession();
        const claimed = await detailsReconciler.claimFresh(
          detailsSubject,
          'item_details',
          intent,
          session,
        );
        if (!claimed.ok) {
          if (claimed.reason === 'storage' || claimed.reason === 'missing') {
            setFormError(storageWriteFailedMessage);
          } else if (claimed.reason === 'session_invalid' && !isOnline()) {
            setFormError(offlineWriteMessage);
          }
          return false;
        }
        const dispatchCheck = detailsReconciler.verifyCanDispatchOrAbort(
          detailsSubject,
          claimed.requestId,
          null,
          session,
          claimed.releaseOnce,
        );
        if (!dispatchCheck.ok) {
          if (!isOnline()) setFormError(offlineWriteMessage);
          else if (dispatchCheck.missingPin)
            setFormError(storageWriteFailedMessage);
          return false;
        }
        detailsClaim = {
          subject: detailsSubject,
          requestId: claimed.requestId,
          attempt: claimed.attempt,
          intent,
          release: claimed.releaseOnce,
        };
      }
      if (action.kind === 'create') {
        if (started.type !== 'create') return false;
        await createItem(action.draft);
        saved = true;
        if (!hasPostedReloadForTarget(ITEMS_RELOAD_SUBJECT)) {
          setReloadMarker(ITEMS_RELOAD_SUBJECT);
        }
      } else if (started.type !== 'edit') {
        if (detailsClaim) {
          abortClaimBeforeDispatch(
            detailsClaim.subject,
            detailsClaim.requestId,
            null,
            detailsClaim.release,
          );
          detailsClaim = null;
        }
        return false;
      } else if (action.kind === 'details') {
        if (!detailsClaim) {
          throw new StaleWriteError();
        }
        await updateItem(
          detailsClaim.intent.itemId,
          detailsClaim.intent.draft,
          detailsClaim.intent.expected,
        );
        expectedRef.current = expectationFromDraft(detailsClaim.intent.draft);
        saved = true;
        detailsReconciler.markAcknowledged(
          detailsClaim.subject,
          detailsClaim.requestId,
          detailsClaim.intent,
          detailsClaim.attempt,
        );
        detailsClaim.release();
        detailsClaim = null;
      } else if (action.kind === 'loss') {
        await setItemLoss(started.id, action.lossPct, action.write);
        saved = true;
        setReloadMarker(ITEMS_RELOAD_SUBJECT);
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
      const detailsSnap =
        detailsReconciler.snapshotBeforeRead(ITEMS_RELOAD_SUBJECT);
      let next: CatalogItem[] | null;
      try {
        next = await readCatalog();
      } catch (readError) {
        detailsReconciler.applyReadFailure(detailsSnap);
        throw readError;
      }
      if (next) {
        setItems(next);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        applyDetailsRead(detailsSnap, next);
        setLocalNeedsReload(false);
      }
    } catch (error) {
      if (!saved && detailsClaim) {
        const activeClaim = detailsClaim;
        detailsClaim = null;
        const outcome = await detailsReconciler.settleFailure({
          subject: activeClaim.subject,
          requestId: activeClaim.requestId,
          target: ITEMS_RELOAD_SUBJECT,
          error,
          releaseOnce: activeClaim.release,
          readState: () => readCatalog(),
          onReadData: (fresh) => {
            setItems(fresh);
            setLoadError(null);
            const editing = formModeRef.current;
            if (
              editing?.type === 'edit' &&
              editing.id === activeClaim.intent.itemId
            ) {
              const row = fresh.find(
                (entry) => entry.id === activeClaim.intent.itemId,
              );
              if (row) {
                expectedRef.current = expectationFromItem(row);
              }
            }
          },
          loadedTargetOf: () => ITEMS_RELOAD_SUBJECT,
        });
        if (outcome.status === 'reconciled_saved') {
          setDetailsNotice('اتحفظت بيانات الصنف');
          setFormError(null);
          return true;
        }
        if (outcome.status === 'stale_conflict') {
          if (
            started.type === 'edit' &&
            sameEditor(formModeRef.current, started)
          ) {
            setFormEpoch((value) => value + 1);
            setFormError(staleWriteMessage);
          }
          throw error;
        }
        if (sameEditor(formModeRef.current, started)) {
          setFormError(messageFrom(error));
        }
        throw error;
      }
      if (
        !saved &&
        error instanceof StaleWriteError &&
        started.type === 'edit' &&
        sameEditor(formModeRef.current, started)
      ) {
        try {
          await reloadCatalog(started.id);
          if (error instanceof CostingChangedError) {
            setFormError(costingChangedMessage);
          }
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
      detailsClaim?.release();
      setSaving(false);
    }
    return saved;
  }

  async function retryUnknownDetails(
    pin: RequestlessPin<StoredItemDetailsIntent>,
  ): Promise<void> {
    if (busy || catalogLoadsRef.current > 0 || !isOnline()) return;
    const session = captureWriteSession();
    setSaving(true);
    setFormError(null);
    setDetailsNotice(null);
    setDetailsError(null);
    let releaseOnce = () => {};
    let saved = false;
    try {
      const claimed = await detailsReconciler.claimReplay(pin, session);
      if (!claimed.ok) {
        if (claimed.reason === 'storage' || claimed.reason === 'missing') {
          setDetailsError(storageWriteFailedMessage);
          setFormError(storageWriteFailedMessage);
        } else if (claimed.reason === 'session_invalid' && !isOnline()) {
          setDetailsError(offlineWriteMessage);
          setFormError(offlineWriteMessage);
        }
        return;
      }
      releaseOnce = claimed.releaseOnce;
      const dispatchCheck = detailsReconciler.verifyCanDispatchOrAbort(
        pin.subject,
        claimed.requestId,
        'unknown',
        session,
        releaseOnce,
      );
      if (!dispatchCheck.ok) {
        if (!isOnline()) {
          setDetailsError(offlineWriteMessage);
          setFormError(offlineWriteMessage);
        } else if (dispatchCheck.missingPin) {
          setDetailsError(storageWriteFailedMessage);
          setFormError(storageWriteFailedMessage);
        }
        return;
      }
      await updateItem(
        claimed.intent.itemId,
        claimed.intent.draft,
        claimed.intent.expected,
      );
      saved = true;
      detailsReconciler.markAcknowledged(
        pin.subject,
        claimed.requestId,
        claimed.intent,
        claimed.attempt,
      );
      releaseOnce();
      setLocalNeedsReload(true);
      const pendingReload = snapshotItemsReloads();
      const detailsSnap =
        detailsReconciler.snapshotBeforeRead(ITEMS_RELOAD_SUBJECT);
      let next: CatalogItem[] | null;
      try {
        next = await readCatalog();
      } catch (readError) {
        detailsReconciler.applyReadFailure(detailsSnap);
        throw readError;
      }
      if (next) {
        setItems(next);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        applyDetailsRead(detailsSnap, next);
        setLocalNeedsReload(false);
      }
      setDetailsNotice('اتحفظت بيانات الصنف');
    } catch (error) {
      if (!saved) {
        const outcome = await detailsReconciler.settleFailure({
          subject: pin.subject,
          requestId: pin.requestId,
          target: ITEMS_RELOAD_SUBJECT,
          error,
          releaseOnce,
          readState: () => readCatalog(),
          onReadData: (fresh) => {
            setItems(fresh);
            setLoadError(null);
            const editing = formModeRef.current;
            if (editing?.type === 'edit' && editing.id === pin.intent.itemId) {
              const row = fresh.find((entry) => entry.id === pin.intent.itemId);
              if (row) {
                expectedRef.current = expectationFromItem(row);
                setFormEpoch((value) => value + 1);
              }
            }
          },
          loadedTargetOf: () => ITEMS_RELOAD_SUBJECT,
        });
        if (outcome.status === 'reconciled_saved') {
          setDetailsNotice('اتحفظت بيانات الصنف');
          setDetailsError(null);
          setFormError(null);
        } else if (outcome.status === 'stale_conflict') {
          setDetailsError(staleWriteMessage);
          setFormError(staleWriteMessage);
        } else {
          const message = messageFrom(error);
          setDetailsError(message);
          setFormError(message);
        }
      } else {
        setLocalNeedsReload(true);
        setLoadError(messageFrom(error));
      }
    } finally {
      releaseOnce();
      setSaving(false);
    }
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
      {detailsNotice ? <p role="status">{detailsNotice}</p> : null}
      {detailsError ? <p role="alert">{detailsError}</p> : null}
      {recoverableDetailsPins.length > 0 ? (
        <section
          aria-label="تعديلات أصناف مش متأكد إنها اتسجلت"
          className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
        >
          {recoverableDetailsPins.map((pin) => {
            const replayReady = detailsReconciler.canReplay(pin);
            return (
              <div key={pin.subject} className="flex flex-col gap-2">
                <p role="status">
                  {pin.acknowledged
                    ? `تعديل الصنف «${pin.intent.draft.name.trim()}» اتحفظ وجاري التحقق من التحديث`
                    : `تعديل الصنف «${pin.intent.draft.name.trim()}» مش متأكد إنه اتسجل`}
                </p>
                {replayReady ? (
                  <button
                    className={secondaryButton}
                    type="button"
                    disabled={writeLocked}
                    onClick={() => void retryUnknownDetails(pin)}
                  >
                    إعادة محاولة حفظ بيانات الصنف
                  </button>
                ) : (
                  <button
                    className={secondaryButton}
                    type="button"
                    disabled={
                      saving || conversionsBusy || catalogLoads > 0 || !online
                    }
                    onClick={retry}
                  >
                    التحقق من حالة الحفظ
                  </button>
                )}
              </div>
            );
          })}
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
                reloadCatalog(itemId).catch((error: unknown) => {
                  setLoadError(messageFrom(error));
                })
              }
              onSubmit={(action) => handleSubmit(action)}
              onCancel={() => {
                if (busy) return;
                setEditor(null);
                setFormError(null);
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
              onConversionSaved={refreshAfterConversion}
              onItemStale={(itemId) =>
                reloadCatalog(itemId).catch((error: unknown) => {
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
