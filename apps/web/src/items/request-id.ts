import {
  ConfirmedRefusalError,
  isConfirmedConfigurationChange,
  StaleWriteError,
} from '@/items/errors';
import type { ItemDraft } from '@/items/types';
import {
  beginHeldWrite,
  clearHeldWrite,
  getHeldWrite,
  listHeldWritesByPrefix,
  resetHeldWritesStore,
  setHeldWritePhase,
  subscribeHeldWritesStore,
  updateHeldWritePayload,
} from '@/lib/held-writes';
import { isPayloadRefusal } from '@/lib/write-outcome';

/** Shown while the last save for a subject might already be stored. */
export const unknownSaveMessage = 'آخر حفظ مش متأكد إنه اتسجل';

/** Re-render when a sibling section starts or settles a held action. */
export function subscribeHeldWrites(listener: () => void): () => void {
  return subscribeHeldWritesStore(listener);
}

/** Test isolation. Production callers never clear another subject's action. */
export function resetHeldWrites(): void {
  resetHeldWritesStore({ clearStorage: true });
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
  const current = getHeldWrite(subject);
  return current !== null && current.phase !== 'posted_reload';
}

const conversionPrefix = 'conversion:';

/**
 * True while a loss, opening-price, or conversion save for this item is in
 * flight or still has an unknown outcome. Item creation does not count.
 */
export function hasItemConfigurationAction(itemId: string): boolean {
  if (hasAction(lossSubject(itemId)) || hasAction(priceSubject(itemId))) {
    return true;
  }
  for (const record of listHeldWritesByPrefix(conversionPrefix)) {
    if (record.phase === 'posted_reload') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.subject.slice(conversionPrefix.length));
    } catch {
      continue;
    }
    if (Array.isArray(parsed) && parsed[0] === itemId) return true;
  }
  return false;
}

/** The payload whose outcome is still unknown. Null while a send is in flight. */
export function unknownAction<T>(subject: string): T | null {
  const current = getHeldWrite<T>(subject);
  if (!current || current.phase !== 'unknown' || current.awaitingReviewReload) {
    return null;
  }
  return current.payload;
}

/**
 * The payload of an in-flight or replaced action. Null when the outcome is
 * unknown, so a retry of an unknown write cannot pick up a newer payload.
 */
export function heldAction<T>(subject: string): T | null {
  const current = getHeldWrite<T>(subject);
  if (
    !current ||
    current.phase === 'unknown' ||
    current.phase === 'posted_reload'
  ) {
    return null;
  }
  return current.payload;
}

/** True while this request must reload the review before it can send again. */
export function activationReviewReloadPending(subject: string): boolean {
  return getHeldWrite(subject)?.awaitingReviewReload === true;
}

/**
 * A confirmed `opening manifest changed` stored nothing. Keep the request id,
 * clear the unknown outcome, and refuse to send the rejected token again.
 */
export function pinActivationReviewReload(
  subject: string,
  requestId: string,
): void {
  const current = getHeldWrite(subject);
  if (!current || current.requestId !== requestId) return;
  updateHeldWritePayload(subject, requestId, current.payload, {
    phase: 'inflight',
    awaitingReviewReload: true,
  });
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
  const current = getHeldWrite(subject);
  if (!current || current.requestId !== requestId) return;
  if (next.requestId !== requestId) return;
  updateHeldWritePayload(subject, requestId, next, {
    phase: 'inflight',
    awaitingReviewReload: false,
  });
}

/** Persist an updated payload for an active held action (same requestId). */
export function updateActionPayload<T>(
  subject: string,
  requestId: string,
  payload: T,
): void {
  updateHeldWritePayload(subject, requestId, payload);
}

/**
 * At most one outstanding action per subject. A second begin returns the
 * payload already held, including its request id. Persisted to localStorage
 * with phase `inflight` BEFORE the caller sends the request.
 */
export function beginAction<T>(
  subject: string,
  create: (requestId: string) => T,
): T {
  const existing = getHeldWrite<T>(subject);
  if (existing && existing.phase !== 'posted_reload') {
    return existing.payload;
  }
  if (existing && existing.phase === 'posted_reload') {
    clearHeldWrite(subject, existing.requestId);
  }
  return beginHeldWrite<T>(subject, create, { kind: 'action' }).payload;
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
  const current = getHeldWrite(subject);
  if (!current || current.requestId !== requestId) return;
  if (error === undefined) {
    clearHeldWrite(subject, requestId);
    return;
  }
  if (
    isConfirmedConfigurationChange(error) ||
    isPayloadRefusal(error) ||
    error instanceof ConfirmedRefusalError ||
    error instanceof StaleWriteError
  ) {
    clearHeldWrite(subject, requestId);
    return;
  }
  if (current.phase !== 'unknown') {
    setHeldWritePhase(subject, requestId, 'unknown');
  }
}
