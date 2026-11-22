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
  markActionPostedReload,
  priceSubject,
} from '@/items/request-id';
import type { CatalogItem, ItemDraft, ItemSave } from '@/items/types';
import { emptyItemForm, itemToFormValues } from '@/items/validation';
import {
  abortClaimBeforeDispatch,
  canDispatchHeldWrite,
  captureWriteSession,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWrite,
  clearPostedReloadSnapshot,
  hasAnyReloadMarker,
  hasDurableHeldWrite,
  hasPostedReloadForTarget,
  listHeldWritesByPrefix,
  setHeldWritePhase,
  setReloadMarker,
  snapshotPostedReloads,
  storageWriteFailedMessage,
  subscribeHeldWritesStore,
  type HeldWriteRecord,
  type PostedReloadSnapshot,
} from '@/lib/held-writes';
import { isPayloadRefusal } from '@/lib/write-outcome';
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

function detailsPinKey(record: HeldWriteRecord): string {
  return `${record.subject}:${record.requestId}`;
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
  const [verifiedAbsentDetails, setVerifiedAbsentDetails] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [saving, setSaving] = useState(false);
  // A save landed and fresh rows are not applied yet: stay locked until a read applies them.
  const [localNeedsReload, setLocalNeedsReload] = useState(false);
  const [heldEpoch, setHeldEpoch] = useState(0);
  // One page-wide lock: while an item save or a conversion operation (and the
  // reload after it) is in flight, nothing that edits data or remounts a panel
  // can start, so no editor or panel ever opens on stale data.
  const [catalogLoads, setCatalogLoads] = useState(0);
  const unknownDetailsPins =
    heldEpoch < 0
      ? []
      : listHeldWritesByPrefix<StoredItemDetailsIntent>(
          ITEM_DETAILS_PREFIX,
        ).filter(
          (record) =>
            record.phase === 'unknown' &&
            isStoredItemDetailsIntent(record.payload),
        );
  const postedReload =
    heldEpoch >= 0 &&
    (hasPostedReloadForTarget(ITEMS_RELOAD_SUBJECT) ||
      hasAnyReloadMarker(ITEMS_RELOAD_SUBJECT));
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

  function reconcileUnknownDetails(catalog: readonly CatalogItem[]): {
    reconciledSubjects: ReadonlySet<string>;
  } {
    const reconciled = new Set<string>();
    const absentKeys: string[] = [];
    const clearedKeys: string[] = [];
    for (const record of listHeldWritesByPrefix<StoredItemDetailsIntent>(
      ITEM_DETAILS_PREFIX,
    )) {
      if (
        record.phase !== 'unknown' ||
        !isStoredItemDetailsIntent(record.payload)
      ) {
        continue;
      }
      const key = detailsPinKey(record);
      const fresh = catalog.find((row) => row.id === record.payload.itemId);
      if (fresh && itemMatchesDetailsIntent(fresh, record.payload)) {
        clearHeldWrite(record.subject, record.requestId);
        reconciled.add(record.subject);
        clearedKeys.push(key);
        const editing = formModeRef.current;
        if (editing?.type === 'edit' && editing.id === fresh.id) {
          expectedRef.current = expectationFromItem(fresh);
        }
      } else {
        absentKeys.push(key);
      }
    }
    if (reconciled.size > 0) {
      setDetailsNotice('اتحفظت بيانات الصنف');
      setFormError(null);
    }
    if (absentKeys.length > 0 || clearedKeys.length > 0) {
      setVerifiedAbsentDetails((current) => {
        const next = new Set(current);
        for (const key of clearedKeys) next.delete(key);
        for (const key of absentKeys) next.add(key);
        return next;
      });
    }
    return { reconciledSubjects: reconciled };
  }

  async function reloadCatalog(staleItemId?: string) {
    const pendingReload = snapshotItemsReloads();
    const next = await readCatalog();
    if (!next) return;
    setItems(next);
    setLoadError(null);
    clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
    reconcileUnknownDetails(next);
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
        reconcileUnknownDetails(next);
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
    setDetailsNotice(null);
    let detailsClaim: {
      subject: string;
      requestId: string;
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
        const claim = await claimFreshHeldWrite<StoredItemDetailsIntent>(
          detailsSubject,
          () => intent,
          {
            kind: 'item_details',
            session,
          },
        );
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
          intent,
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
        if (
          setReloadMarker(
            ITEMS_RELOAD_SUBJECT,
            undefined,
            detailsClaim.requestId,
          )
        ) {
          clearHeldWrite(detailsClaim.subject, detailsClaim.requestId);
        }
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
      const next = await readCatalog();
      if (next) {
        setItems(next);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        reconcileUnknownDetails(next);
        setLocalNeedsReload(false);
      }
    } catch (error) {
      if (!saved && detailsClaim) {
        const definiteRefusal =
          error instanceof StaleWriteError ||
          error instanceof ConfirmedRefusalError ||
          isPayloadRefusal(error);
        if (definiteRefusal) {
          clearHeldWrite(detailsClaim.subject, detailsClaim.requestId);
        } else {
          // Ambiguous outcome: keep the pin in `unknown` and verify via a
          // targeted read before ever clearing or offering retry.
          setHeldWritePhase(
            detailsClaim.subject,
            detailsClaim.requestId,
            'unknown',
          );
          const pendingSubject = detailsClaim.subject;
          detailsClaim.release();
          detailsClaim = null;
          try {
            const fresh = await readCatalog();
            if (fresh) {
              setItems(fresh);
              setLoadError(null);
              const { reconciledSubjects } = reconcileUnknownDetails(fresh);
              if (reconciledSubjects.has(pendingSubject)) {
                return true;
              }
            }
          } catch {
            // Keep pin in `unknown` until a later targeted read succeeds.
          }
        }
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
    record: HeldWriteRecord<StoredItemDetailsIntent>,
  ): Promise<void> {
    if (busy || catalogLoadsRef.current > 0 || !isOnline()) return;
    const session = captureWriteSession();
    setSaving(true);
    setFormError(null);
    setDetailsNotice(null);
    let releaseOnce = () => {};
    let saved = false;
    try {
      const claim = await claimReplayHeldWrite<StoredItemDetailsIntent>(
        record.subject,
        record.requestId,
        { session },
      );
      if (!claim.ok) {
        if (claim.reason === 'storage' || claim.reason === 'missing') {
          setFormError(storageWriteFailedMessage);
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setFormError(offlineWriteMessage);
        }
        return;
      }
      let released = false;
      releaseOnce = () => {
        if (!released) {
          released = true;
          claim.release();
        }
      };
      if (!canDispatchHeldWrite(record.subject, record.requestId, session)) {
        const missingPin = !hasDurableHeldWrite(
          record.subject,
          record.requestId,
        );
        abortClaimBeforeDispatch(
          record.subject,
          record.requestId,
          'unknown',
          releaseOnce,
        );
        if (!isOnline()) setFormError(offlineWriteMessage);
        else if (missingPin) setFormError(storageWriteFailedMessage);
        return;
      }
      const intent = claim.record.payload;
      await updateItem(intent.itemId, intent.draft, intent.expected);
      saved = true;
      if (setReloadMarker(ITEMS_RELOAD_SUBJECT, undefined, record.requestId)) {
        clearHeldWrite(record.subject, record.requestId);
      }
      releaseOnce();
      setLocalNeedsReload(true);
      const pendingReload = snapshotItemsReloads();
      const next = await readCatalog();
      if (next) {
        setItems(next);
        setLoadError(null);
        clearPostedReloadSnapshot(pendingReload, ITEMS_RELOAD_SUBJECT);
        reconcileUnknownDetails(next);
        setLocalNeedsReload(false);
      }
      setDetailsNotice('اتحفظت بيانات الصنف');
    } catch (error) {
      if (!saved) {
        const definiteRefusal =
          error instanceof StaleWriteError ||
          error instanceof ConfirmedRefusalError ||
          isPayloadRefusal(error);
        if (definiteRefusal) {
          clearHeldWrite(record.subject, record.requestId);
          setFormError(
            error instanceof StaleWriteError
              ? staleWriteMessage
              : messageFrom(error),
          );
        } else {
          setHeldWritePhase(record.subject, record.requestId, 'unknown');
          releaseOnce();
          try {
            const fresh = await readCatalog();
            if (fresh) {
              setItems(fresh);
              setLoadError(null);
              reconcileUnknownDetails(fresh);
            }
          } catch {
            // Keep unknown until targeted read succeeds.
          }
          setFormError(messageFrom(error));
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
      {unknownDetailsPins.length > 0 ? (
        <section
          aria-label="تعديلات أصناف مش متأكد إنها اتسجلت"
          className="flex flex-col gap-2 rounded border border-neutral-300 p-3"
        >
          {unknownDetailsPins.map((pin) => {
            const absent = verifiedAbsentDetails.has(detailsPinKey(pin));
            return (
              <div key={pin.subject} className="flex flex-col gap-2">
                <p role="status">
                  تعديل الصنف «{pin.payload.draft.name.trim()}» مش متأكد إنه
                  اتسجل
                </p>
                {absent ? (
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
