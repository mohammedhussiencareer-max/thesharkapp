import type { HeldWriteLockManager } from '@/lib/held-writes';

/** A fake Web Locks manager with one client per independently driven writer. */
export function makeAuditedLocks() {
  const held = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();
  const nested: Array<{
    context: string;
    holding: string[];
    requested: string;
  }> = [];
  function client(context: string): HeldWriteLockManager {
    const owned = new Set<string>();
    return {
      async request(name, options, callback) {
        if (
          owned.size > 0 &&
          ([...owned].some((key) => key !== name) || !options.ifAvailable)
        ) {
          nested.push({ context, holding: [...owned], requested: name });
        }
        while (held.has(name)) {
          if (options.ifAvailable) return await callback(null);
          await new Promise<void>((resolve) => {
            const pending = waiters.get(name) ?? [];
            pending.push(resolve);
            waiters.set(name, pending);
          });
        }
        held.add(name);
        owned.add(name);
        try {
          const result = callback({ name, mode: options.mode ?? 'exclusive' });
          if (
            result &&
            typeof (result as PromiseLike<unknown>).then === 'function'
          ) {
            return await result;
          }
          return result;
        } finally {
          owned.delete(name);
          held.delete(name);
          const pending = waiters.get(name);
          waiters.delete(name);
          for (const resume of pending ?? []) resume();
        }
      },
      query: () =>
        Promise.resolve({ held: [...held].map((name) => ({ name })) }),
    };
  }
  return { locks: client('page'), client, nested };
}
