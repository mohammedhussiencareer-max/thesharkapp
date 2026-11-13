import {
  ConfirmedRefusalError,
  isConfirmedConfigurationChange,
  StaleWriteError,
} from '@/items/errors';
import type { ItemDraft } from '@/items/types';
import { isPayloadRefusal } from '@/lib/write-outcome';

/** Shown while the last save for a subject might already be stored. */
export const unknownSaveMessage = 'آخر حفظ مش متأكد إنه اتسجل';

type Held = {
  requestId: string;
  payload: unknown;
  /**
   * Set once an outcome did not prove the action is absent. The section stays
   * locked and the only send is a retry of this payload.
   */
  unknown: boolean;
};

const held = new Map<string, Held>();

const heldListeners = new Set<() => void>();

function emitHeldWrites(): void {
  for (const listener of heldListeners) listener();
}

/** Re-render when a sibling section starts or settles a held action. */
export function subscribeHeldWrites(listener: () => void): () => void {
  heldListeners.add(listener);
  return () => {
    heldListeners.delete(listener);
  };
}

/** Test isolation. Production callers never clear another subject's action. */
export function resetHeldWrites(): void {
  if (held.size === 0) return;
  held.clear();
  emitHeldWrites();
}

export function lossSubject(itemId: string): string {
  return `loss:${itemId}`;
}

export function priceSubject(itemId: string): string {
  return `price:${itemId}`;
}

export function conversionSubject(itemId: string, unit: string): string {
  return `conversion:${JSON.stringify([itemId, unit])}`;
}

/** One create action per submitted draft. */
export function createSubject(draft: ItemDraft): string {
  return `create:${JSON.stringify({
    name: draft.name.trim(),
    kind: draft.kind,
    baseUnit: draft.baseUnit,
    countFrequency: draft.countFrequency,
    parentItemId: draft.parentItemId,
    lossPct: draft.lossPct,
    active: draft.active,
  })}`;
}

/**
 * One custom-unit action per trimmed code and label. The tuple is encoded so
 * a colon inside either field cannot collide with the other pair.
 */
export function unitSubject(code: string, label: string): string {
  return `unit:${JSON.stringify([code.trim(), label.trim()])}`;
}

export function hasAction(subject: string): boolean {
  return held.has(subject);
}

const conversionPrefix = 'conversion:';

/**
 * True while a loss, opening-price, or conversion save for this item is in
 * flight or still has an unknown outcome. Item creation does not count.
 */
export function hasItemConfigurationAction(itemId: string): boolean {
  if (held.has(lossSubject(itemId)) || held.has(priceSubject(itemId))) {
    return true;
  }
  for (const key of held.keys()) {
    if (!key.startsWith(conversionPrefix)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(key.slice(conversionPrefix.length));
    } catch {
      continue;
    }
    if (Array.isArray(parsed) && parsed[0] === itemId) return true;
  }
  return false;
}

/** The payload whose outcome is still unknown. Null while a send is in flight. */
export function unknownAction<T>(subject: string): T | null {
  const current = held.get(subject);
  if (!current?.unknown) return null;
  return current.payload as T;
}

/**
 * The payload of an in-flight or replaced action. Null when the outcome is
 * unknown, so a retry of an unknown write cannot pick up a newer payload.
 */
export function heldAction<T>(subject: string): T | null {
  const current = held.get(subject);
  if (!current || current.unknown) return null;
  return current.payload as T;
}

/**
 * Keeps the request id, replaces the payload, and clears unknown.
 * Used after `opening manifest changed`, which proved this id stored nothing.
 */
export function replaceActivationPayload<T extends { requestId: string }>(
  subject: string,
  requestId: string,
  next: T,
): void {
  const current = held.get(subject);
  if (!current || current.requestId !== requestId) return;
  if (next.requestId !== requestId) return;
  current.payload = next;
  current.unknown = false;
  emitHeldWrites();
}

/**
 * At most one outstanding action per subject. A second begin returns the
 * payload already held, including its request id.
 */
export function beginAction<T>(
  subject: string,
  create: (requestId: string) => T,
): T {
  const existing = held.get(subject);
  if (existing) return existing.payload as T;
  const requestId = crypto.randomUUID();
  const payload = create(requestId);
  held.set(subject, { requestId, payload, unknown: false });
  emitHeldWrites();
  return payload;
}

/**
 * Success, a payload refusal, a confirmed refusal, a known stale write, or a
 * confirmed `configuration changed` retires the action. 42501, a generic 40001, and a
 * lost response keep it and mark the outcome unknown.
 * The request id must be the one currently held. A late completion of an older
 * write does nothing, so it cannot retire the newer action.
 */
export function settleAction(
  subject: string,
  requestId: string,
  error?: unknown,
): void {
  const current = held.get(subject);
  if (!current || current.requestId !== requestId) return;
  if (error === undefined) {
    held.delete(subject);
    emitHeldWrites();
    return;
  }
  if (
    isConfirmedConfigurationChange(error) ||
    isPayloadRefusal(error) ||
    error instanceof ConfirmedRefusalError ||
    error instanceof StaleWriteError
  ) {
    held.delete(subject);
    emitHeldWrites();
    return;
  }
  if (!current.unknown) {
    current.unknown = true;
    emitHeldWrites();
  }
}
