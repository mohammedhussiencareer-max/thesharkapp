import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { createItem, listItems, updateItem } from '@/items/api';
import { expectationFromItem, type ItemExpectation } from '@/items/expectation';
import { sameEditor, type ItemEditor } from '@/items/editor';
import {
  genericCatalogError,
  messageFrom,
  StaleWriteError,
  staleWriteMessage,
} from '@/items/errors';
import { groupCatalog } from '@/items/group';
import { ItemForm } from '@/items/ItemForm';
import { ItemList } from '@/items/ItemList';
import type { CatalogItem, ItemDraft } from '@/items/types';
import { emptyItemForm, itemToFormValues } from '@/items/validation';

const shell =
  'mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-4 px-4 py-6 text-start';
const primaryButton =
  'w-fit rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-60';
const secondaryButton =
  'w-fit rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

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
  const [formMode, setFormMode] = useState<ItemEditor | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One page-wide lock: while an item save or a conversion operation (and the
  // reload after it) is in flight, nothing that edits data or remounts a panel
  // can start, so no editor or panel ever opens on stale data.
  const busy = saving || conversionsBusy;
  const [openConversionsId, setOpenConversionsId] = useState<string | null>(
    null,
  );
  const formModeRef = useRef<ItemEditor | null>(null);
  const expectedRef = useRef<ItemExpectation | null>(null);
  const openConversionsRef = useRef<string | null>(null);

  function setEditor(next: ItemEditor | null) {
    formModeRef.current = next;
    setFormMode(next);
  }

  async function reloadCatalog(staleItemId?: string) {
    const next = await listItems();
    setItems(next);
    setLoadError(null);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listItems();
        if (cancelled) return;
        setItems(next);
        setLoadError(null);
        setSaving(false);
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
    setLoading(true);
    setLoadError(null);
    setLoadId((value) => value + 1);
  }

  function openCreate() {
    if (busy) return;
    setFormError(null);
    setEditor({ type: 'create' });
  }

  function openEdit(item: CatalogItem) {
    if (busy) return;
    setFormError(null);
    // The form and the stale-write expectation always start from the same row.
    expectedRef.current = expectationFromItem(item);
    setFormEpoch((value) => value + 1);
    setEditor({ type: 'edit', id: item.id });
  }

  async function handleSubmit(draft: ItemDraft) {
    const started = formModeRef.current;
    if (!started || busy) return;
    setSaving(true);
    setFormError(null);
    let saved = false;
    let unlock = true;
    try {
      if (started.type === 'edit') {
        const expected = expectedRef.current;
        if (!expected) throw new StaleWriteError();
        await updateItem(started.id, draft, expected);
      } else {
        await createItem(draft);
      }
      saved = true;
      if (sameEditor(formModeRef.current, started)) setEditor(null);
      const next = await listItems();
      setItems(next);
      setLoadError(null);
    } catch (error) {
      if (
        !saved &&
        error instanceof StaleWriteError &&
        started.type === 'edit' &&
        sameEditor(formModeRef.current, started)
      ) {
        try {
          await reloadCatalog(started.id);
        } catch (reloadError) {
          setFormError(messageFrom(reloadError));
        }
      } else if (!saved) {
        if (sameEditor(formModeRef.current, started)) {
          setFormError(messageFrom(error));
        }
      } else {
        unlock = false;
        setLoadError(messageFrom(error));
      }
    } finally {
      if (unlock) setSaving(false);
    }
  }

  const editingItem =
    formMode?.type === 'edit'
      ? items?.find((item) => item.id === formMode.id)
      : undefined;
  const showForm =
    formMode?.type === 'create' || (formMode?.type === 'edit' && editingItem);

  return (
    <main className={shell}>
      <p>
        <Link className="underline" to="/">
          الرئيسية
        </Link>
      </p>
      <h1 className="text-2xl font-semibold">الأصناف</h1>
      {loading && items === null ? <p>جاري تحميل الأصناف…</p> : null}
      {items === null && !loading ? (
        <div className="flex flex-col gap-3">
          <p role="alert">{loadError ?? genericCatalogError}</p>
          <button className={secondaryButton} type="button" onClick={retry}>
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      {items !== null ? (
        <>
          {loadError ? (
            <div className="flex flex-col gap-2">
              <p role="alert">{loadError}</p>
              <button className={secondaryButton} type="button" onClick={retry}>
                إعادة المحاولة
              </button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              className={primaryButton}
              type="button"
              disabled={busy}
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
              key={
                formMode?.type === 'edit'
                  ? `${formMode.id}:${formEpoch}`
                  : 'create'
              }
              items={items}
              editingId={editingItem?.id}
              initial={
                editingItem ? itemToFormValues(editingItem) : emptyItemForm()
              }
              submitting={saving}
              locked={conversionsBusy}
              serverError={formError}
              onClearServerError={() => setFormError(null)}
              onSubmit={(draft) => void handleSubmit(draft)}
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
              editsDisabled={busy}
              onEdit={openEdit}
              onToggleConversions={(itemId) => {
                const next = openConversionsId === itemId ? null : itemId;
                openConversionsRef.current = next;
                setOpenConversionsId(next);
              }}
              onConversionsBusyChange={setConversionsBusy}
              onItemStale={() => {
                const id = openConversionsRef.current;
                if (!id) return;
                return reloadCatalog(id).catch((error: unknown) => {
                  setLoadError(messageFrom(error));
                });
              }}
            />
          )}
        </>
      ) : null}
    </main>
  );
}
