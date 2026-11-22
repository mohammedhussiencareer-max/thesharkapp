import {
  hasAnyHeldWrite,
  hasLiveHeldWriteClaims,
  subscribeHeldWritesStore,
} from '@/lib/held-writes';

export type PwaUpdateSnapshot = {
  waiting: boolean;
};

let snapshot: PwaUpdateSnapshot = { waiting: false };
let waitingWorker: ServiceWorker | null = null;
let started = false;
let reloadRequested = false;
let reloadDeferred = false;
let authResolvedState = false;
let lastHadLiveClaims = false;
const listeners = new Set<() => void>();

subscribeHeldWritesStore(() => {
  const hasLive = hasLiveHeldWriteClaims();
  const releasedLast = lastHadLiveClaims && !hasLive;
  lastHadLiveClaims = hasLive;
  if (releasedLast && snapshot.waiting) {
    // Notify update-guard subscribers when the last live claim releases;
    // never auto-reload (still requires an explicit owner click).
    emit();
  }
});

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
  const next = worker !== null || reloadDeferred;
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
 * memory. If a previous explicit approval activated the worker while a pin
 * appeared before `controllerchange`, the next explicit click reloads directly
 * once pins have cleared without waiting for a second `controllerchange`.
 */
export function applyPwaUpdate(
  reload: () => void = () => window.location.reload(),
  options?: { authResolved?: boolean },
): boolean {
  const resolved = options?.authResolved ?? authResolvedState;
  if (!resolved) return false;
  if (hasAnyHeldWrite() || hasLiveHeldWriteClaims()) return false;
  if (reloadDeferred) {
    reloadDeferred = false;
    reloadRequested = false;
    waitingWorker = null;
    if (snapshot.waiting) {
      snapshot = { waiting: false };
      emit();
    }
    reload();
    return true;
  }
  if (!waitingWorker) return false;
  reloadRequested = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !navigator.serviceWorker
  ) {
    reloadRequested = false;
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
    if (hasAnyHeldWrite() || hasLiveHeldWriteClaims()) {
      // Worker already activated after explicit approval, but a pin appeared
      // in the race window: keep the banner visible and defer reload until
      // the next explicit click after pins clear.
      reloadRequested = false;
      reloadDeferred = true;
      waitingWorker = null;
      if (!snapshot.waiting) {
        snapshot = { waiting: true };
        emit();
      }
      return;
    }
    reloadRequested = false;
    reloadDeferred = false;
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
  reloadDeferred = false;
  authResolvedState = false;
  lastHadLiveClaims = false;
  snapshot = { waiting: false };
  listeners.clear();
}
