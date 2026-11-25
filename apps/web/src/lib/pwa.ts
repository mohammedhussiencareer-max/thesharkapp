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
let waitingStateTarget: ServiceWorker | null = null;
let waitingStateListener: (() => void) | null = null;
let started = false;
let reloadRequested = false;
let reloadDeferred = false;
let authResolvedState = false;
let logoutPending = false;
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

export function setPwaLogoutPending(pending: boolean): void {
  if (logoutPending === pending) return;
  logoutPending = pending;
  emit();
}

export function isPwaLogoutPending(): boolean {
  return logoutPending;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function detachWaitingListener(): void {
  if (
    waitingStateTarget &&
    waitingStateListener &&
    typeof waitingStateTarget.removeEventListener === 'function'
  ) {
    waitingStateTarget.removeEventListener('statechange', waitingStateListener);
  }
  waitingStateTarget = null;
  waitingStateListener = null;
}

function isActivatedWorker(worker: ServiceWorker | null): boolean {
  return (
    worker !== null &&
    (worker.state === 'activating' || worker.state === 'activated')
  );
}

function markWorkerActivated(): void {
  detachWaitingListener();
  waitingWorker = null;
  reloadRequested = false;
  reloadDeferred = true;
  if (!snapshot.waiting) {
    snapshot = { waiting: true };
    emit();
  }
}

function setWaiting(worker: ServiceWorker | null): void {
  detachWaitingListener();
  if (isActivatedWorker(worker)) {
    markWorkerActivated();
    return;
  }
  waitingWorker = worker;
  if (worker && typeof worker.addEventListener === 'function') {
    const onStateChange = () => {
      if (waitingWorker !== worker) return;
      if (isActivatedWorker(worker)) {
        if (!reloadRequested) {
          markWorkerActivated();
        }
      } else if (worker.state === 'redundant') {
        detachWaitingListener();
        waitingWorker = null;
        if (!reloadDeferred && snapshot.waiting) {
          snapshot = { waiting: false };
          emit();
        }
      }
    };
    waitingStateTarget = worker;
    waitingStateListener = onStateChange;
    worker.addEventListener('statechange', onStateChange);
  }
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
 * local logout is not pending, the owner explicitly asks, and NO held write pin
 * is active in storage or memory. If the worker already activated (either after
 * a prior explicit approval deferred by a pin, or because another tab sent
 * `SKIP_WAITING`), the next explicit click reloads directly once auth and pins
 * permit without waiting for a second `controllerchange`.
 */
export function applyPwaUpdate(
  reload: () => void = () => window.location.reload(),
  options?: { authResolved?: boolean },
): boolean {
  const resolved = options?.authResolved ?? authResolvedState;
  if (!resolved || logoutPending) return false;
  if (hasAnyHeldWrite() || hasLiveHeldWriteClaims()) return false;
  if (reloadDeferred || isActivatedWorker(waitingWorker)) {
    reloadDeferred = false;
    reloadRequested = false;
    detachWaitingListener();
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
  let hadController = Boolean(container.controller);
  container.addEventListener('controllerchange', () => {
    const activatedUpdate =
      reloadRequested || waitingWorker !== null || hadController;
    hadController = true;
    if (!activatedUpdate) return;
    if (!reloadRequested) {
      // Another tab activated the waiting worker: never auto-reload this tab,
      // but mark activation so the next explicit click reloads directly after
      // checking auth and held writes.
      markWorkerActivated();
      return;
    }
    if (logoutPending || hasAnyHeldWrite() || hasLiveHeldWriteClaims()) {
      // Worker already activated after explicit approval, but a pin or pending
      // logout appeared in the race window: keep the banner visible and defer
      // reload until the next explicit click after checks pass.
      markWorkerActivated();
      return;
    }
    reloadRequested = false;
    reloadDeferred = false;
    detachWaitingListener();
    waitingWorker = null;
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
  detachWaitingListener();
  waitingWorker = null;
  started = false;
  reloadRequested = false;
  reloadDeferred = false;
  authResolvedState = false;
  logoutPending = false;
  lastHadLiveClaims = false;
  snapshot = { waiting: false };
  listeners.clear();
}
