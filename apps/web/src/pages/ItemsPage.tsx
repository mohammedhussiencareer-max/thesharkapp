import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createItem, listItems, updateItem } from '@/items/api';
import { genericCatalogError, messageFrom } from '@/items/errors';
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

type FormMode = { type: 'create' } | { type: 'edit'; id: string };

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
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openConversionsId, setOpenConversionsId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listItems();
        if (cancelled) return;
        setItems(next);
        setLoadError(null);
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

  function refresh() {
    setLoadId((value) => value + 1);
  }

  function openCreate() {
    setFormError(null);
    setFormMode({ type: 'create' });
  }

  async function handleSubmit(draft: ItemDraft) {
    if (!formMode) return;
    setSaving(true);
    setFormError(null);
    try {
      if (formMode.type === 'edit') {
        await updateItem(formMode.id, draft);
      } else {
        await createItem(draft);
      }
      setFormMode(null);
      refresh();
    } catch (error) {
      setFormError(messageFrom(error));
    } finally {
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
              onClick={openCreate}
            >
              ضيف صنف
            </button>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showInactive}
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
              serverError={formError}
              onClearServerError={() => setFormError(null)}
              onSubmit={(draft) => void handleSubmit(draft)}
              onCancel={() => {
                setFormMode(null);
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
              onEdit={(item) => {
                setFormError(null);
                setFormMode({ type: 'edit', id: item.id });
              }}
              onToggleConversions={(itemId) =>
                setOpenConversionsId((current) =>
                  current === itemId ? null : itemId,
                )
              }
            />
          )}
        </>
      ) : null}
    </main>
  );
}
