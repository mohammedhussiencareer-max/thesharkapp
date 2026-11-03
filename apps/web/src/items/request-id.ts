import type { DatedWrite } from '@/items/types';
import { isPayloadRefusal, isUnknownOutcome } from '@/lib/write-outcome';

type Held = {
  requestId: string;
  write: DatedWrite;
  /**
   * True once a send's outcome was unknown. A later 42501 can fire before
   * the server replays the request id, so it does not prove the original
   * failed. The payload stays until success or a refusal of the payload itself.
   */
  unresolved: boolean;
};

const held = new Map<string, Held>();

/** Test isolation. Production callers never clear another action's id. */
export function resetHeldWrites(): void {
  held.clear();
}

/** The write stored for an unknown-outcome retry of this exact action. */
export function heldWrite(intent: string): DatedWrite | null {
  return held.get(intent)?.write ?? null;
}

/**
 * One id per action intent. A retry of the same intent reuses the write that
 * was first submitted, including its effective end.
 */
export function holdWrite(
  intent: string,
  create: (requestId: string) => DatedWrite,
): DatedWrite {
  const existing = held.get(intent);
  if (existing) return existing.write;
  const requestId = crypto.randomUUID();
  const write = create(requestId);
  held.set(intent, { requestId, write, unresolved: false });
  return write;
}

/**
 * Drop the id after success, or after a refusal that proves nothing was stored.
 * An unknown outcome stays unresolved. A later permission or contention error
 * keeps that payload; only `isPayloadRefusal` clears it. `untilSuccess` keeps
 * the id through a rolled-back failure so a two-step retry sends the same
 * conversion payload.
 */
export function settleRequest(
  intent: string,
  error?: unknown,
  untilSuccess = false,
): void {
  if (error === undefined) {
    held.delete(intent);
    return;
  }
  const current = held.get(intent);
  if (!current) return;
  if (isUnknownOutcome(error)) current.unresolved = true;
  if (untilSuccess) return;
  if (current.unresolved && !isPayloadRefusal(error)) return;
  held.delete(intent);
}
