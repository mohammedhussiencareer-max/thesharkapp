import type { DatedWrite } from '@/items/types';
import { isUnknownOutcome } from '@/lib/write-outcome';

type Held = {
  requestId: string;
  write: DatedWrite;
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
  held.set(intent, { requestId, write });
  return write;
}

/**
 * Drop the id after a definite success or a definite refusal.
 * `untilSuccess` keeps it through a rolled-back failure so a two-step retry
 * sends the same conversion payload.
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
  if (untilSuccess) return;
  if (!isUnknownOutcome(error)) held.delete(intent);
}
