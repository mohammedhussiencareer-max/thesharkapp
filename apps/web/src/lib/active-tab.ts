import { readSupabaseEnv } from '@/lib/supabase';

const ACTIVE_TAB_LOCK_PREFIX = 'theshark:app:active-tab:v1:';
const FALLBACK_PROJECT = 'default';

export type ActiveTabStatus = 'checking' | 'active' | 'inactive';

export type ActiveTabSnapshot = {
  status: ActiveTabStatus;
  takingOver: boolean;
};

export type ActiveTabLockManager = {
  request<T>(
    name: string,
    options: {
      mode?: 'exclusive' | 'shared';
      ifAvailable?: boolean;
      steal?: boolean;
    },
    callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
  ): Promise<T>;
};

export type ActiveTabLifecycleHooks = {
  onBecomeActive?: () => void;
  onBecomeInactive?: () => void;
};

type ActiveTabControllerDeps = {
  getLocks: () => ActiveTabLockManager | null;
  getProjectUrl: () => string | undefined;
};

function defaultProjectUrl(): string | undefined {
  try {
    return typeof readSupabaseEnv === 'function'
      ? readSupabaseEnv()?.url.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function defaultLocks(): ActiveTabLockManager | null {
  try {
    if (typeof navigator === 'undefined') return null;
    const candidate = (navigator as unknown as { locks?: unknown }).locks;
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { request?: unknown }).request === 'function'
    ) {
      return candidate as ActiveTabLockManager;
    }
    return null;
  } catch {
    return null;
  }
}

export function getActiveTabLockName(projectUrl?: string): string {
  const url = (projectUrl ?? defaultProjectUrl())?.trim();
  const project = url && url.length > 0 ? url : FALLBACK_PROJECT;
  return `${ACTIVE_TAB_LOCK_PREFIX}${encodeURIComponent(project)}`;
}

/**
 * Single-active-tab leadership controller backed by an exclusive Web Lock
 * (`theshark:app:active-tab:v1:<projectUrl>`).
 *
 * - On boot, acquires the lock with `{ mode: 'exclusive', ifAvailable: true }`.
 *   The holder is ACTIVE; any other tab is INACTIVE and renders only the
 *   takeover notice without starting Supabase, auth, held writes, or PWA.
 * - Explicit takeover requests the lock with `{ steal: true }`, which aborts
 *   the previous holder's lock promise so the previous holder immediately
 *   transitions to INACTIVE and stops all auth/data/storage activity (I6).
 * - Limitation: if `navigator.locks` is unavailable (or rejects before
 *   granting on boot), the tab runs as active. All target browsers (modern
 *   Chromium, Safari 15.4+, Firefox 96+) support Web Locks.
 */
export function createActiveTabController(
  customDeps?: Partial<ActiveTabControllerDeps>,
) {
  const deps: ActiveTabControllerDeps = {
    getLocks: customDeps?.getLocks ?? defaultLocks,
    getProjectUrl: customDeps?.getProjectUrl ?? defaultProjectUrl,
  };

  let snapshot: ActiveTabSnapshot = { status: 'checking', takingOver: false };
  let started = false;
  let disposed = false;
  let lockGeneration = 0;
  let releaseHold: (() => void) | null = null;
  let takeOverPromise: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  const lifecycleHooks = new Set<ActiveTabLifecycleHooks>();

  function emit(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function runBecomeActiveHooks(): void {
    for (const hook of [...lifecycleHooks]) {
      try {
        hook.onBecomeActive?.();
      } catch {
        // Never allow one lifecycle hook to block leadership transition.
      }
    }
  }

  function runBecomeInactiveHooks(): void {
    for (const hook of [...lifecycleHooks]) {
      try {
        hook.onBecomeInactive?.();
      } catch {
        // Never allow one lifecycle hook to block demotion cleanup.
      }
    }
  }

  function releaseCurrentHold(): void {
    const release = releaseHold;
    releaseHold = null;
    if (release) {
      release();
    }
  }

  function setSnapshot(next: ActiveTabSnapshot): void {
    if (
      snapshot.status === next.status &&
      snapshot.takingOver === next.takingOver
    ) {
      return;
    }
    snapshot = next;
    emit();
  }

  function becomeActive(): void {
    const wasActive = snapshot.status === 'active';
    const changed =
      snapshot.status !== 'active' || snapshot.takingOver !== false;
    snapshot = { status: 'active', takingOver: false };
    if (!wasActive) {
      runBecomeActiveHooks();
    }
    if (changed) {
      emit();
    }
  }

  function becomeInactive(): void {
    const wasInactive = snapshot.status === 'inactive';
    const changed =
      snapshot.status !== 'inactive' || snapshot.takingOver !== false;
    snapshot = { status: 'inactive', takingOver: false };
    if (!wasInactive) {
      runBecomeInactiveHooks();
    }
    if (changed) {
      emit();
    }
  }

  function lockName(): string {
    return getActiveTabLockName(deps.getProjectUrl());
  }

  function start(): void {
    if (started || disposed) return;
    started = true;
    const locks = deps.getLocks();
    if (!locks) {
      // Documented limitation: navigator.locks unavailable -> run as active.
      becomeActive();
      return;
    }

    const gen = ++lockGeneration;
    let granted = false;

    try {
      void Promise.resolve(
        locks.request(
          lockName(),
          { mode: 'exclusive', ifAvailable: true },
          (lock) => {
            if (gen !== lockGeneration || disposed) {
              return;
            }
            if (!lock) {
              becomeInactive();
              return;
            }
            granted = true;
            becomeActive();
            return new Promise<void>((resolve) => {
              let done = false;
              const release = () => {
                if (done) return;
                done = true;
                if (releaseHold === release) {
                  releaseHold = null;
                }
                resolve();
              };
              releaseHold = release;
              if (gen !== lockGeneration || disposed) {
                release();
              }
            });
          },
        ),
      ).catch(() => {
        if (gen !== lockGeneration || disposed) {
          return;
        }
        if (granted) {
          // Lock was broken/stolen by another tab's `{ steal: true }` request.
          granted = false;
          releaseCurrentHold();
          becomeInactive();
        } else {
          // Web Locks rejected before granting (e.g., SecurityError in sandboxed
          // context): fall back to active per the unavailable-locks rule.
          becomeActive();
        }
      });
    } catch {
      if (gen === lockGeneration && !disposed && !granted) {
        becomeActive();
      }
    }
  }

  function takeOver(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (snapshot.status === 'active') return Promise.resolve(true);
    if (takeOverPromise !== null) return takeOverPromise;

    started = true;
    const locks = deps.getLocks();
    if (!locks) {
      becomeActive();
      return Promise.resolve(true);
    }

    setSnapshot({ status: 'inactive', takingOver: true });
    releaseCurrentHold();
    const gen = ++lockGeneration;
    let granted = false;

    let resolveGrant!: (ok: boolean) => void;
    const grantPromise = new Promise<boolean>((resolve) => {
      resolveGrant = resolve;
    });
    let settled = false;
    const finishGrant = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveGrant(ok);
    };

    try {
      void Promise.resolve(
        locks.request(lockName(), { steal: true }, (lock) => {
          if (gen !== lockGeneration || disposed || !lock) {
            finishGrant(false);
            return;
          }
          granted = true;
          becomeActive();
          finishGrant(true);
          return new Promise<void>((resolve) => {
            let done = false;
            const release = () => {
              if (done) return;
              done = true;
              if (releaseHold === release) {
                releaseHold = null;
              }
              resolve();
            };
            releaseHold = release;
            if (gen !== lockGeneration || disposed) {
              release();
            }
          });
        }),
      ).catch(() => {
        if (gen !== lockGeneration || disposed) {
          finishGrant(false);
          return;
        }
        if (granted) {
          // Our stolen lock was later stolen by another tab.
          granted = false;
          releaseCurrentHold();
          becomeInactive();
        } else {
          setSnapshot({ status: 'inactive', takingOver: false });
          finishGrant(false);
        }
      });
    } catch {
      if (gen === lockGeneration && !disposed) {
        setSnapshot({ status: 'inactive', takingOver: false });
      }
      finishGrant(false);
    }

    const tracked = grantPromise.finally(() => {
      if (takeOverPromise === tracked) {
        takeOverPromise = null;
      }
    });
    takeOverPromise = tracked;
    return tracked;
  }

  function registerLifecycle(hooks: ActiveTabLifecycleHooks): () => void {
    lifecycleHooks.add(hooks);
    return () => {
      lifecycleHooks.delete(hooks);
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    start();
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): ActiveTabSnapshot {
    return snapshot;
  }

  function isActive(): boolean {
    return snapshot.status === 'active';
  }

  function dispose(): void {
    disposed = true;
    lockGeneration += 1;
    releaseCurrentHold();
    takeOverPromise = null;
    listeners.clear();
    lifecycleHooks.clear();
  }

  function reset(): void {
    lockGeneration += 1;
    releaseCurrentHold();
    disposed = false;
    started = false;
    takeOverPromise = null;
    snapshot = { status: 'checking', takingOver: false };
    listeners.clear();
    lifecycleHooks.clear();
  }

  return {
    start,
    takeOver,
    subscribe,
    getSnapshot,
    isActive,
    registerLifecycle,
    dispose,
    reset,
  };
}

export type ActiveTabController = ReturnType<typeof createActiveTabController>;

const defaultActiveTabController = createActiveTabController();

export function startActiveTab(): void {
  defaultActiveTabController.start();
}

export function takeOverActiveTab(): Promise<boolean> {
  return defaultActiveTabController.takeOver();
}

export function subscribeActiveTab(listener: () => void): () => void {
  return defaultActiveTabController.subscribe(listener);
}

export function getActiveTabSnapshot(): ActiveTabSnapshot {
  return defaultActiveTabController.getSnapshot();
}

export function isActiveTab(): boolean {
  return defaultActiveTabController.isActive();
}

export function registerActiveTabLifecycle(
  hooks: ActiveTabLifecycleHooks,
): () => void {
  return defaultActiveTabController.registerLifecycle(hooks);
}

export function resetActiveTab(): void {
  defaultActiveTabController.reset();
}
