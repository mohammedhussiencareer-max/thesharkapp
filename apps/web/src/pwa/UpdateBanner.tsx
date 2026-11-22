import { useSyncExternalStore } from 'react';
import { hasAnyHeldWrite, subscribeHeldWritesStore } from '@/lib/held-writes';
import { primaryButton } from '@/lib/page-style';
import {
  applyPwaUpdate,
  getPwaUpdateSnapshot,
  subscribePwaUpdate,
} from '@/lib/pwa';

export function UpdateBanner({
  onReload,
}: {
  onReload?: () => void;
} = {}) {
  const update = useSyncExternalStore(
    subscribePwaUpdate,
    getPwaUpdateSnapshot,
    getPwaUpdateSnapshot,
  );
  const pinned = useSyncExternalStore(
    subscribeHeldWritesStore,
    hasAnyHeldWrite,
    () => false,
  );

  if (!update.waiting) return null;

  return (
    <aside
      role="status"
      aria-label="تحديث التطبيق"
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-100 px-4 py-2 text-sm"
    >
      <p>
        {pinned
          ? 'في نسخة جديدة للتطبيق — استنى لحد ما الحفظ المعلّق يخلص قبل التحديث'
          : 'في نسخة جديدة للتطبيق'}
      </p>
      <button
        className={primaryButton}
        type="button"
        disabled={pinned}
        onClick={() => {
          applyPwaUpdate(onReload);
        }}
      >
        تحديث التطبيق
      </button>
    </aside>
  );
}
