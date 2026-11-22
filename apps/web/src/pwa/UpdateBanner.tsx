import { useContext, useSyncExternalStore } from 'react';
import { AuthContext } from '@/lib/auth-context';
import { getAuthSnapshot, subscribeAuth } from '@/lib/auth-store';
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
  const authContext = useContext(AuthContext);
  const authStore = useSyncExternalStore(
    subscribeAuth,
    getAuthSnapshot,
    getAuthSnapshot,
  );
  const authStatus = authContext?.status ?? authStore.status;
  const authResolved = authStatus !== 'loading' && authStatus !== 'checking';

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

  const disabled = !authResolved || pinned;

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
        disabled={disabled}
        onClick={() => {
          applyPwaUpdate(onReload, { authResolved });
        }}
      >
        تحديث التطبيق
      </button>
    </aside>
  );
}
