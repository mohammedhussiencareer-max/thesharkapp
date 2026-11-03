import {
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

/** Test isolation. Production callers never clear another subject's action. */
export function resetHeldWrites(): void {
  held.clear();
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

/** The payload whose outcome is still unknown. Null while a send is in flight. */
export function unknownAction<T>(subject: string): T | null {
  const current = held.get(subject);
  if (!current?.unknown) return null;
  return current.payload as T;
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
  return payload;
}

/**
 * Success, a payload refusal, a known stale write, or a confirmed
 * `configuration changed` retires the action. 42501, a generic 40001, and a
 * lost response keep it and mark the outcome unknown.
 */
export function settleAction(subject: string, error?: unknown): void {
  if (error === undefined) {
    held.delete(subject);
    return;
  }
  const current = held.get(subject);
  if (!current) return;
  if (
    isConfirmedConfigurationChange(error) ||
    isPayloadRefusal(error) ||
    error instanceof StaleWriteError
  ) {
    held.delete(subject);
    return;
  }
  current.unknown = true;
}
