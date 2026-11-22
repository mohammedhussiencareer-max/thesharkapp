import { hasAnyHeldWrite } from '@/lib/held-writes';

export type PwaUpdateSnapshot = {
  waiting: boolean;
};

let snapshot: PwaUpdateSnapshot = { waiting: false };
let waitingWorker: ServiceWorker | null = null;
let started = false;
let reloadRequested = false;
let authResolvedState = false;
const listeners = new Set<() => void>();

export function setPwaAuthResolved(resolved: boolean): void {
  authResolvedState = resolved;
}

export function isPwaAuthResolved(): boolean {
  return authResolvedState;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setWaiting(worker: ServiceWorker | null): void {
  waitingWorker = worker;
  const next = worker !== null;
  if (snapshot.waiting === next) return;
  snapshot = { waiting: next };
  emit();
}

export function isPwaRuntimeEnabled(): boolean {
  return import.meta.env.VITE_PWA !== '0';
}

export function getPwaUpdateSnapshot(): PwaUpdateSnapshot {
  return snapshot;
}

export function subscribePwaUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Activate a waiting service worker and reload, ONLY when auth has resolved,
 * the owner explicitly asks, and NO held write pin is active in storage or
 * memory. Returns false if blocked or no update.
 */
export function applyPwaUpdate(
  reload: () => void = () => window.location.reload(),
  options?: { authResolved?: boolean },
): boolean {
  if (!waitingWorker) return false;
  const resolved = options?.authResolved ?? authResolvedState;
  if (!resolved) return false;
  if (hasAnyHeldWrite()) return false;
  reloadRequested = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !navigator.serviceWorker
  ) {
    reload();
  }
  return true;
}

export function initPwa(
  reload: () => void = () => window.location.reload(),
): void {
  if (started) return;
  if (!isPwaRuntimeEnabled()) return;
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  started = true;

  const container = navigator.serviceWorker;
  container.addEventListener('controllerchange', () => {
    if (!reloadRequested) return;
    if (hasAnyHeldWrite()) {
      reloadRequested = false;
      return;
    }
    reloadRequested = false;
    reload();
  });

  void container
    .register('/sw.js', { scope: '/' })
    .then((registration) => {
      if (registration.waiting) {
        setWaiting(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && container.controller) {
            setWaiting(registration.waiting ?? installing);
          }
        });
      });
    })
    .catch(() => {
      // Registration failure must never break the web app.
    });
}

/** Test helpers for verifying update gating without a live service worker. */
export function setTestWaitingWorker(worker: ServiceWorker | null): void {
  setWaiting(worker);
}

export function resetPwaState(): void {
  waitingWorker = null;
  started = false;
  reloadRequested = false;
  authResolvedState = false;
  snapshot = { waiting: false };
  listeners.clear();
}
