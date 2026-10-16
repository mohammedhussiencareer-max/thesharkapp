import { useState, type ReactNode } from 'react';
import { ConversionsPanel } from '@/items/ConversionsPanel';
import { formatEgp, formatLossPercent, formatQty } from '@/items/format';
import { groupCatalog } from '@/items/group';
import { frequencyLabels, kindLabels, unitLabels } from '@/items/labels';
import type { CatalogItem } from '@/items/types';

const secondaryButton =
  'rounded border border-neutral-300 px-3 py-2 disabled:opacity-60';

function ItemCard({
  item,
  conversionsOpen,
  editsDisabled,
  conversionsLocked,
  onEdit,
  onToggleConversions,
  onConversionsBusy,
  onItemStale,
}: {
  item: CatalogItem;
  conversionsOpen: boolean;
  editsDisabled: boolean;
  conversionsLocked: boolean;
  onEdit: (item: CatalogItem) => void;
  onToggleConversions: (itemId: string) => void;
  onConversionsBusy: (busy: boolean) => void;
  onItemStale?: (itemId: string) => void | Promise<void>;
}) {
  return (
    <article
      aria-label={item.name}
      className="flex min-w-0 flex-col gap-3 rounded border border-neutral-300 p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 text-base font-semibold break-words">
          {item.name}
        </h3>
        <p>{item.active ? 'شغال' : 'موقوف'}</p>
      </div>
      <ul className="flex flex-wrap gap-2 text-sm">
        <li>{unitLabels[item.baseUnit]}</li>
        <li>{frequencyLabels[item.countFrequency]}</li>
        {item.lossPct > 0 ? (
          <li>فاقد {formatLossPercent(item.lossPct)}</li>
        ) : null}
      </ul>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-neutral-600">الرصيد</dt>
          <dd>
            {formatQty(item.onHandQty)} {unitLabels[item.baseUnit]}
          </dd>
        </div>
        <div>
          <dt className="text-neutral-600">متوسط التكلفة</dt>
          <dd>{formatEgp(item.avgCost)}</dd>
        </div>
        <div>
          <dt className="text-neutral-600">القيمة</dt>
          <dd>{formatEgp(item.onHandValue)}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        <button
          className={secondaryButton}
          type="button"
          disabled={editsDisabled}
          onClick={() => onEdit(item)}
        >
          تعديل
        </button>
        <button
          className={secondaryButton}
          type="button"
          aria-expanded={conversionsOpen}
          disabled={conversionsLocked}
          onClick={() => {
            if (conversionsLocked) return;
            onToggleConversions(item.id);
          }}
        >
          التحويلات
        </button>
      </div>
      {conversionsOpen ? (
        <ConversionsPanel
          item={item}
          locked={editsDisabled}
          onBusyChange={onConversionsBusy}
          onItemStale={onItemStale}
        />
      ) : null}
    </article>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ItemList({
  items,
  showInactive,
  openConversionsId,
  editsDisabled,
  onEdit,
  onToggleConversions,
  onConversionsBusyChange,
  onItemStale,
}: {
  items: readonly CatalogItem[];
  showInactive: boolean;
  openConversionsId: string | null;
  editsDisabled: boolean;
  onEdit: (item: CatalogItem) => void;
  onToggleConversions: (itemId: string) => void;
  onConversionsBusyChange?: (busy: boolean) => void;
  onItemStale?: (itemId: string) => void | Promise<void>;
}) {
  const [conversionsBusy, setConversionsBusyState] = useState(false);
  // The page also locks controls that would unmount an open panel (the inactive filter).
  const setConversionsBusy = (busy: boolean) => {
    setConversionsBusyState(busy);
    onConversionsBusyChange?.(busy);
  };
  const groups = groupCatalog(items, showInactive);
  const card = (item: CatalogItem) => (
    <ItemCard
      key={item.id}
      item={item}
      conversionsOpen={openConversionsId === item.id}
      editsDisabled={editsDisabled}
      conversionsLocked={conversionsBusy || editsDisabled}
      onEdit={onEdit}
      onToggleConversions={onToggleConversions}
      onConversionsBusy={setConversionsBusy}
      onItemStale={onItemStale}
    />
  );

  const sizes = (children: readonly CatalogItem[]) =>
    children.length === 0 ? null : (
      <div className="flex flex-col gap-3 border-s border-neutral-200 ps-3">
        <h4 className="text-base font-semibold">{kindLabels.fish_size}</h4>
        {children.map(card)}
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      {groups.fish.length > 0 ? (
        <Group title={kindLabels.fish_mixed}>
          {groups.fish.map((block) => (
            <div key={block.parent.id} className="flex flex-col gap-3">
              {block.showParent ? (
                <ItemCard
                  item={block.parent}
                  conversionsOpen={openConversionsId === block.parent.id}
                  editsDisabled={editsDisabled}
                  conversionsLocked={conversionsBusy || editsDisabled}
                  onEdit={onEdit}
                  onToggleConversions={onToggleConversions}
                  onConversionsBusy={setConversionsBusy}
                  onItemStale={onItemStale}
                />
              ) : (
                <p>تحت {block.parent.name} (موقوف)</p>
              )}
              {sizes(block.children)}
            </div>
          ))}
        </Group>
      ) : null}
      {groups.orphans.length > 0 ? (
        <Group title={kindLabels.fish_size}>{groups.orphans.map(card)}</Group>
      ) : null}
      {groups.seafood.length > 0 ? (
        <Group title={kindLabels.seafood}>{groups.seafood.map(card)}</Group>
      ) : null}
      {groups.ingredients.length > 0 ? (
        <Group title={kindLabels.ingredient}>
          {groups.ingredients.map(card)}
        </Group>
      ) : null}
      {groups.packaging.length > 0 ? (
        <Group title={kindLabels.packaging}>{groups.packaging.map(card)}</Group>
      ) : null}
    </div>
  );
}
