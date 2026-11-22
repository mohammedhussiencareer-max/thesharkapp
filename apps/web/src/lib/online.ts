import { useSyncExternalStore } from 'react';

export const offlineWriteMessage = 'مفيش نت — الحفظ متوقف لحد ما النت يرجع';

function subscribeOnline(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}
