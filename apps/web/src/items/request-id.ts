import {
  ConfirmedRefusalError,
  isConfirmedConfigurationChange,
  StaleWriteError,
} from '@/items/errors';
import type { ItemDraft } from '@/items/types';
import {
  abortClaimBeforeDispatch,
  canDispatchHeldWrite,
  claimFreshHeldWrite,
  claimReplayHeldWrite,
  clearHeldWrite,
  clearPostedReload,
  clearPostedReloadSnapshot,
  getHeldWrite,
  hasDurableHeldWrite,
  listHeldWritesByPrefix,
  listPostedReloadRecords,
  resetHeldWritesStore,
  setHeldWritePhase,
  snapshotPostedReloads,
  subscribeHeldWritesStore,
  updateHeldWritePayload,
  type ClaimHeldWriteResult,
  type HeldWriteRecord,
  type PostedReloadSnapshot,
  type WriteSession,
} from '@/lib/held-writes';
import { isPayloadRefusal } from '@/lib/write-outcome';

/** Shared readTarget for catalog-level post-write refreshes on ItemsPage. */
export const ITEMS_RELOAD_SUBJECT = 'items:reload';

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

const createPrefix = 'create:';

/** One create action per submitted draft. */
export function createSubject(draft: ItemDraft): string {
  return `${createPrefix}${JSON.stringify({
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
 * Restore any persisted unknown item-create draft from localStorage after a
 * reload without relying on in-memory form state.
 */
export function firstUnknownItemCreate(): ItemDraft | null {
  for (const record of listHeldWritesByPrefix(createPrefix)) {
    if (record.phase !== 'unknown') continue;
    try {
      const parsed = JSON.parse(
        record.subject.slice(createPrefix.length),
      ) as Partial<ItemDraft> | null;
      if (
        parsed &&
        typeof parsed.name === 'string' &&
        typeof parsed.kind === 'string' &&
        typeof parsed.baseUnit === 'string' &&
        typeof parsed.countFrequency === 'string' &&
        (parsed.parentItemId === null ||
          typeof parsed.parentItemId === 'string') &&
        (parsed.lossPct === null || typeof parsed.lossPct === 'string') &&
        typeof parsed.active === 'boolean'
      ) {
        return parsed as ItemDraft;
      }
    } catch {
      continue;
    }
  }
  return null;
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

/** List all unknown conversion actions belonging to a specific item. */
export function listUnknownConversionsForItem<T>(itemId: string): T[] {
  const found: T[] = [];
  for (const record of listHeldWritesByPrefix<T>(conversionPrefix)) {
    if (record.phase !== 'unknown') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.subject.slice(conversionPrefix.length));
    } catch {
      continue;
    }
    if (Array.isArray(parsed) && parsed[0] === itemId) {
      found.push(record.payload);
    }
  }
  return found;
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

/** Returns the persisted request id for any non-posted_reload record, including reload-restored activation pins. */
export function heldRequestId(subject: string): string | null {
  const current = getHeldWrite(subject);
  if (!current || current.phase === 'posted_reload') return null;
  return current.requestId;
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
  updateHeldWritePayload(subject, requestId, undefined, {
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
  expected: HeldWriteRecord,
): boolean {
  if (next.requestId !== requestId || !expected.awaitingReviewReload)
    return false;
  return updateHeldWritePayload(subject, requestId, next, {
    expected,
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
 * Atomically claim a fresh action on `subject` under a Web Lock (when
 * supported), rechecking session generation + user + online under the lock
 * and refusing if another tab holds the lock or an unresolved pin already
 * exists in storage. Never discards an existing `posted_reload` pin.
 */
export function claimFreshAction<T>(
  subject: string,
  create: (requestId: string) => T,
  opts?: { session?: WriteSession | null },
): Promise<ClaimHeldWriteResult<T>> {
  return claimFreshHeldWrite<T>(subject, create, {
    kind: 'action',
    ...(opts?.session !== undefined ? { session: opts.session } : {}),
  });
}

/**
 * Atomically claim an explicit replay of an existing durable action pin,
 * verifying storage still holds the matching `subject` and `requestId` and
 * rechecking session generation + user + online under the lock.
 */
export function claimReplayAction<T>(
  subject: string,
  requestId: string,
  opts?: {
    payload?: T;
    awaitingReviewReload?: boolean;
    session?: WriteSession | null;
  },
): Promise<ClaimHeldWriteResult<T>> {
  return claimReplayHeldWrite<T>(subject, requestId, opts);
}

/** True iff localStorage currently holds an unresolved pin for `(subject, requestId)`. */
export function hasDurableAction(subject: string, requestId: string): boolean {
  return hasDurableHeldWrite(subject, requestId);
}

/** Combined pre-dispatch guard: session + user + online AND durable pin present. */
export function canDispatchAction(
  subject: string,
  requestId: string,
  session: WriteSession | null,
): boolean {
  return canDispatchHeldWrite(subject, requestId, session);
}

/** Roll back an undispatched fresh claim (or restore a replay to `unknown`) and release its Web Lock. */
export function abortActionBeforeDispatch(
  subject: string,
  requestId: string,
  isReplay: boolean,
  release: () => void,
): void {
  abortClaimBeforeDispatch(
    subject,
    requestId,
    isReplay ? 'unknown' : null,
    release,
  );
}

export type PostedCostingPin = {
  subject: string;
  requestId: string;
  itemId: string;
  kind: 'loss' | 'conversion';
  readTarget?: string;
};

const lossPrefix = 'loss:';

/** Derive the costing kind and item id directly from a loss or conversion subject. */
export function costingItemIdFromSubject(
  subject: string,
): { kind: 'loss' | 'conversion'; itemId: string } | null {
  if (subject.startsWith(lossPrefix)) {
    const itemId = subject.slice(lossPrefix.length);
    return itemId.length > 0 ? { kind: 'loss', itemId } : null;
  }
  if (subject.startsWith(conversionPrefix)) {
    try {
      const parsed: unknown = JSON.parse(
        subject.slice(conversionPrefix.length),
      );
      if (
        Array.isArray(parsed) &&
        typeof parsed[0] === 'string' &&
        parsed[0].length > 0
      ) {
        return { kind: 'conversion', itemId: parsed[0] };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * List all outstanding `posted_reload` and acknowledged-inflight pins for loss
 * and conversion saves. Always derives `itemId` from the action subject so
 * legacy Round-8 pins with `readTarget: 'items:reload'` or `'loss:<id>'` still
 * recover cleanly.
 */
export function listPostedCostingPins(): PostedCostingPin[] {
  const pins: PostedCostingPin[] = [];
  for (const record of [
    ...listPostedReloadRecords(lossPrefix),
    ...listPostedReloadRecords(conversionPrefix),
  ]) {
    const parsed = costingItemIdFromSubject(record.subject);
    if (!parsed) continue;
    pins.push({
      subject: record.subject,
      requestId: record.requestId,
      itemId: parsed.itemId,
      kind: parsed.kind,
      ...(record.readTarget !== undefined
        ? { readTarget: record.readTarget }
        : {}),
    });
  }
  return pins;
}

/**
 * Clear captured loss/conversion pins for `itemId` after a combined read
 * applies, including legacy Round-8 catalog and subject targets.
 */
export async function clearCostingPinsForItem(
  snapshot: PostedReloadSnapshot,
  itemId: string,
  shouldClear?: () => boolean,
): Promise<void> {
  const legacyLossTarget = lossSubject(itemId);
  for (const entry of snapshot) {
    if (costingItemIdFromSubject(entry.subject)?.itemId !== itemId) continue;
    const target = entry.readTarget;
    if (
      target === undefined ||
      target === itemId ||
      target === ITEMS_RELOAD_SUBJECT ||
      target === entry.subject ||
      target === legacyLossTarget
    ) {
      await clearPostedReloadSnapshot([entry], target ?? itemId, shouldClear);
    }
  }
}

/**
 * Move a confirmed RPC write to `posted_reload` until its post-write read
 * covering `readTarget` succeeds. Throws `HeldWriteStorageError` (keeping the
 * old durable record intact) if storage cannot persist the replacement.
 */
export function markActionPostedReload(
  subject: string,
  requestId: string,
  readTarget: string,
): void {
  setHeldWritePhase(subject, requestId, 'posted_reload', { readTarget });
}

/** Clear a `posted_reload` pin only after a read covering `readTarget` (and matching `requestId` when supplied) succeeds. */
export function clearActionPostedReload(
  subject: string,
  readTarget?: string,
  requestId?: string,
): void | Promise<void> {
  return clearPostedReload(subject, readTarget, requestId);
}

/** Capture existing `posted_reload` pins before starting a read so only those pins can clear when it completes. */
export function snapshotActionPostedReloads(filter: {
  subject?: string;
  prefix?: string;
}): PostedReloadSnapshot {
  return snapshotPostedReloads(filter);
}

/** Clear only `posted_reload` pins that existed when the read started and match `loadedTarget`. */
export function clearActionPostedReloadSnapshot(
  snapshot: PostedReloadSnapshot,
  loadedTarget?: string,
): Promise<void> {
  return clearPostedReloadSnapshot(snapshot, loadedTarget);
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
