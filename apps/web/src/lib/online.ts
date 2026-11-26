import { useEffect, useRef, useSyncExternalStore } from 'react';

export const offlineWriteMessage = 'مفيش نت — الحفظ متوقف لحد ما النت يرجع';

export const offlineMoneyMessage =
  'مفيش اتصال بالإنترنت — الأرقام المالية مش متاحة بدون اتصال وهتتحدث لما النت يرجع';

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

/**
 * Tracks browser connectivity and invokes `onReconnect` once whenever the
 * device transitions from offline back to online.
 */
export function useReconnectReload(onReconnect: () => void): boolean {
  const online = useOnline();
  const wasOfflineRef = useRef(!online);
  const callbackRef = useRef(onReconnect);

  useEffect(() => {
    callbackRef.current = onReconnect;
  }, [onReconnect]);

  useEffect(() => {
    if (!online) {
      wasOfflineRef.current = true;
      return;
    }
    if (wasOfflineRef.current) {
      wasOfflineRef.current = false;
      callbackRef.current();
    }
  }, [online]);

  return online;
}
