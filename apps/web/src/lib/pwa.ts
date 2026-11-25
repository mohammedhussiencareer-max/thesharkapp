import {
  hasAnyHeldWrite,
  hasLiveHeldWriteClaims,
  subscribeHeldWritesStore,
} from '@/lib/held-writes';

export type PwaUpdateSnapshot = {
  waiting: boolean;
};

let snapshot: PwaUpdateSnapshot = { waiting: false };
let activeRegistration: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;
let approvedWorker: ServiceWorker | null = null;
let waitingStateTarget: ServiceWorker | null = null;
let waitingStateListener: (() => void) | null = null;
let started = false;
let reloadRequested = false;
let reloadDeferred = false;
let authResolvedState = false;
let approvedAuthResolved: boolean | null = null;
let logoutPending = false;
let lastHadLiveClaims = false;
let initReload: (() => void) | null = null;
let pendingReload: (() => void) | null = null;
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
  if (approvedAuthResolved !== null) {
    approvedAuthResolved = resolved;
  }
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

function canCompleteApprovedReload(): boolean {
  const resolved = approvedAuthResolved ?? authResolvedState;
  return (
    resolved &&
    !logoutPending &&
    !hasAnyHeldWrite() &&
    !hasLiveHeldWriteClaims()
  );
}

function completeApprovedReload(fallbackReload?: () => void): void {
  const runReload =
    pendingReload ??
    fallbackReload ??
    initReload ??
    (() => window.location.reload());
  reloadRequested = false;
  reloadDeferred = false;
  approvedWorker = null;
  pendingReload = null;
  approvedAuthResolved = null;
  detachWaitingListener();
  waitingWorker = null;
  if (snapshot.waiting) {
    snapshot = { waiting: false };
    emit();
  }
  runReload();
}

function markWorkerActivated(): void {
  detachWaitingListener();
  waitingWorker = null;
  approvedWorker = null;
  reloadRequested = false;
  reloadDeferred = true;
  pendingReload = null;
  approvedAuthResolved = null;
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
  if (worker !== null && worker !== approvedWorker) {
    // A newer waiting worker arrived; never carry an earlier worker's approval
    // forward to it.
    reloadRequested = false;
    approvedWorker = null;
    pendingReload = null;
    approvedAuthResolved = null;
  }
  waitingWorker = worker;
  if (worker && typeof worker.addEventListener === 'function') {
    const onStateChange = () => {
      if (waitingWorker !== worker) return;
      if (isActivatedWorker(worker)) {
        if (!reloadRequested || approvedWorker !== worker) {
          markWorkerActivated();
          return;
        }
        // Complete the approved reload once the approved waiting worker
        // activates after rechecking auth and held writes (including tabs
        // without a controller or mock workers that emit statechange).
        if (worker.state === 'activated') {
          if (!canCompleteApprovedReload()) {
            markWorkerActivated();
            return;
          }
          completeApprovedReload();
        }
      } else if (worker.state === 'redundant') {
        detachWaitingListener();
        waitingWorker = null;
        if (approvedWorker === worker) {
          reloadRequested = false;
          approvedWorker = null;
          pendingReload = null;
          approvedAuthResolved = null;
        }
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
 * is active in storage or memory. If a newer waiting worker is queued, bind
 * approval to that specific worker and send `SKIP_WAITING` rather than
 * reloading prematurely for an older deferred activation. If no non-activated
 * waiting worker remains and an earlier worker already activated, reload
 * directly once auth and pins permit.
 */
export function applyPwaUpdate(
  reload?: () => void,
  options?: { authResolved?: boolean },
): boolean {
  const resolved = options?.authResolved ?? authResolvedState;
  if (!resolved || logoutPending) return false;
  if (hasAnyHeldWrite() || hasLiveHeldWriteClaims()) return false;
  const effectiveReload =
    reload ?? initReload ?? (() => window.location.reload());
  if (waitingWorker !== null && !isActivatedWorker(waitingWorker)) {
    reloadDeferred = false;
    reloadRequested = true;
    approvedWorker = waitingWorker;
    pendingReload = effectiveReload;
    approvedAuthResolved = resolved;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    if (
      typeof navigator === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !navigator.serviceWorker
    ) {
      completeApprovedReload(effectiveReload);
    }
    return true;
  }
  if (reloadDeferred || isActivatedWorker(waitingWorker)) {
    pendingReload = effectiveReload;
    completeApprovedReload(effectiveReload);
    return true;
  }
  return false;
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
  initReload = reload;

  const container = navigator.serviceWorker;
  let hadController = Boolean(container.controller);
  container.addEventListener('controllerchange', () => {
    const activatedUpdate =
      reloadRequested || waitingWorker !== null || hadController;
    hadController = true;
    if (!activatedUpdate) return;
    const matchesApproved =
      reloadRequested &&
      (approvedWorker === null ||
        container.controller === approvedWorker ||
        waitingWorker === null ||
        waitingWorker === approvedWorker);
    if (!matchesApproved) {
      // Another tab activated a waiting worker (or an older worker activated
      // while a newer worker is waiting): never auto-reload this tab.
      const queuedWaiting = activeRegistration?.waiting ?? null;
      if (
        queuedWaiting !== null &&
        queuedWaiting !== container.controller &&
        !isActivatedWorker(queuedWaiting)
      ) {
        reloadDeferred = true;
        setWaiting(queuedWaiting);
        return;
      }
      markWorkerActivated();
      return;
    }
    if (!canCompleteApprovedReload()) {
      // Worker already activated after explicit approval, but a pin, unresolved
      // auth, or pending logout appeared in the race window: keep the banner
      // visible and defer reload until the next explicit click after checks pass.
      markWorkerActivated();
      return;
    }
    completeApprovedReload(reload);
  });

  void container
    .register('/sw.js', { scope: '/' })
    .then((registration) => {
      activeRegistration = registration;
      const hasPriorWorkerFor = (candidate: ServiceWorker) =>
        (registration.active !== null && registration.active !== candidate) ||
        (container.controller !== null && container.controller !== candidate);

      const watchInstalling = (installing: ServiceWorker) => {
        const checkInstalled = () => {
          if (
            installing.state === 'installed' &&
            hasPriorWorkerFor(installing)
          ) {
            setWaiting(registration.waiting ?? installing);
          }
        };
        if (installing.state === 'installed') {
          checkInstalled();
        } else if (typeof installing.addEventListener === 'function') {
          installing.addEventListener('statechange', checkInstalled);
        }
      };

      if (registration.waiting && hasPriorWorkerFor(registration.waiting)) {
        setWaiting(registration.waiting);
      } else if (registration.installing) {
        watchInstalling(registration.installing);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        watchInstalling(installing);
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
  activeRegistration = null;
  waitingWorker = null;
  approvedWorker = null;
  started = false;
  reloadRequested = false;
  reloadDeferred = false;
  authResolvedState = false;
  approvedAuthResolved = null;
  logoutPending = false;
  lastHadLiveClaims = false;
  initReload = null;
  pendingReload = null;
  snapshot = { waiting: false };
  listeners.clear();
}
