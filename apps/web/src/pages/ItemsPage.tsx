import { useEffect, useRef, useState } from 'react';
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
import type { CatalogItem, ItemSave } from '@/items/types';
import { emptyItemForm, itemToFormValues } from '@/items/validation';
import {
  abortClaimBeforeDispatch,
  canDispatchHeldWrite,
  captureWriteSession,
  claimFreshHeldWrite,
  clearHeldWrite,
  clearPostedReloadSnapshot,
  hasDurableHeldWrite,
  hasPostedReloadForTarget,
  hasReloadMarker,
  setReloadMarker,
  snapshotPostedReloads,
  storageWriteFailedMessage,
  subscribeHeldWritesStore,
  type PostedReloadSnapshot,
} from '@/lib/held-writes';
import {
  isOnline,
  offlineMoneyMessage,
  offlineWriteMessage,
  useReconnectReload,
} from '@/lib/online';
import { pageShell, primaryButton, secondaryButton } from '@/lib/page-style';

const ITEMS_RELOAD_SUBJECT = 'items:reload';

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
  const [saving, setSaving] = useState(false);
  // A save landed and fresh rows are not applied yet: stay locked until a read applies them.
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [heldEpoch, setHeldEpoch] = useState(0);
  // One page-wide lock: while an item save or a conversion operation (and the
  // reload after it) is in flight, nothing that edits data or remounts a panel
  // can start, so no editor or panel ever opens on stale data.
  const [catalogLoads, setCatalogLoads] = useState(0);
  const postedReload =
    heldEpoch >= 0 &&
    (hasPostedReloadForTarget(ITEMS_RELOAD_SUBJECT) ||
      hasReloadMarker(ITEMS_RELOAD_SUBJECT));
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

  async function reloadCatalog(staleItemId?: string) {
    const pendingReload = snapshotItemsReloads();
    const next = await readCatalog();
    if (!next) return;
    setItems(next);
    setLoadError(null);
    clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
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
    void (async () => {
      try {
        const next = await readCatalog();
        if (cancelled || !next) return;
        setItems(next);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        setLocalNeedsReload(false);
      } catch (error) {
        if (cancelled) return;
        setLoadError(messageFrom(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadId]);

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
    let detailsClaim: {
      subject: string;
      requestId: string;
      release: () => void;
    } | null = null;
    let saved = false;
    try {
      if (action.kind === 'details') {
        if (started.type !== 'edit') return false;
        const detailsSubject = `item:details:${started.id}`;
        const session = captureWriteSession();
        const claim = await claimFreshHeldWrite<{
          requestId: string;
          itemId: string;
        }>(detailsSubject, (requestId) => ({ requestId, itemId: started.id }), {
          kind: 'item_details',
          session,
        });
        if (!claim.ok) {
          if (claim.reason === 'storage' || claim.reason === 'missing') {
            setFormError(storageWriteFailedMessage);
          } else if (claim.reason === 'session_invalid' && !isOnline()) {
            setFormError(offlineWriteMessage);
          }
          return false;
        }
        let released = false;
        const releaseOnce = () => {
          if (!released) {
            released = true;
            claim.release();
          }
        };
        if (
          !canDispatchHeldWrite(detailsSubject, claim.record.requestId, session)
        ) {
          const missingPin = !hasDurableHeldWrite(
            detailsSubject,
            claim.record.requestId,
          );
          abortClaimBeforeDispatch(
            detailsSubject,
            claim.record.requestId,
            null,
            releaseOnce,
          );
          if (!isOnline()) setFormError(offlineWriteMessage);
          else if (missingPin) setFormError(storageWriteFailedMessage);
          return false;
        }
        detailsClaim = {
          subject: detailsSubject,
          requestId: claim.record.requestId,
          release: releaseOnce,
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
        const expected = expectedRef.current;
        if (!expected) {
          if (detailsClaim) {
            abortClaimBeforeDispatch(
              detailsClaim.subject,
              detailsClaim.requestId,
              null,
              detailsClaim.release,
            );
            detailsClaim = null;
          }
          throw new StaleWriteError();
        }
        await updateItem(started.id, action.draft, expected);
        expectedRef.current = expectationFromDraft(action.draft);
        saved = true;
        if (detailsClaim) {
          if (setReloadMarker(ITEMS_RELOAD_SUBJECT)) {
            clearHeldWrite(detailsClaim.subject, detailsClaim.requestId);
          }
          detailsClaim.release();
          detailsClaim = null;
        }
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
      const next = await readCatalog();
      if (next) {
        setItems(next);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        setLocalNeedsReload(false);
      }
    } catch (error) {
      if (!saved && detailsClaim) {
        clearHeldWrite(detailsClaim.subject, detailsClaim.requestId);
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
