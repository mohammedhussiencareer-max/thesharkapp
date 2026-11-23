import { useEffect, useRef, useState } from 'react';
import { activateInventory, loadOpeningReview } from '@/accounting/api';
import {
  isOpeningManifestChange,
  manifestChangedMessage,
} from '@/accounting/errors';
import type {
  ActivationResult,
  ActivationWrite,
  OpeningReview,
} from '@/accounting/types';
import { messageFrom } from '@/items/errors';
import {
  canDispatchAction,
  claimFreshAction,
  claimReplayAction,
  clearActionPostedReloadSnapshot,
  snapshotActionPostedReloads,
  hasAction,
  hasDurableAction,
  activationReviewReloadPending,
  heldAction,
  heldRequestId,
  markActionPostedReload,
  pinActivationReviewReload,
  replaceActivationPayload,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
  unknownSaveMessage,
} from '@/items/request-id';
import {
  abortClaimBeforeDispatch,
  acquireHeldWriteLock,
  captureWriteSession,
  clearHeldWrite,
  hasPostedReload,
  readLockedHeldWrite,
  setHeldWritePhase,
  type HeldWriteRecord,
  HeldWriteStorageError,
  storageWriteFailedMessage,
} from '@/lib/held-writes';
import { isOnline, offlineWriteMessage, useOnline } from '@/lib/online';
import { reloadFailedMessage } from '@/waste/useWasteAction';

export const ACTIVATION_SUBJECT = 'activation';

export function showActivationButton(review: OpeningReview): boolean {
  if (review.activated || review.roster.length === 0) return false;
  const outflows = review.checklist.find(
    (item) => item.code === 'unreceipted_outflows',
  );
  return outflows?.ready === true;
}

function zerosOf(checked: ReadonlySet<string>): string[] {
  return [...checked].sort();
}

export function useActivationAction(
  review: OpeningReview | null,
  onReview: (review: OpeningReview) => void,
) {
  const online = useOnline();
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadBlocked, setReloadBlocked] = useState(false);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const flight = useRef(false);
  const hash = review?.openingManifestHash ?? null;
  const [checks, setChecks] = useState<{
    hash: string | null;
    ids: ReadonlySet<string>;
  }>({ hash, ids: new Set() });
  const checked = checks.hash === hash ? checks.ids : new Set<string>();

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  const unknown =
    heldEpoch < 0 ? null : unknownAction<ActivationWrite>(ACTIVATION_SUBJECT);
  const posted =
    heldEpoch >= 0 && hasPostedReload(ACTIVATION_SUBJECT, ACTIVATION_SUBJECT);
  const reloadPending =
    posted ||
    reloadBlocked ||
    (heldEpoch >= 0 && activationReviewReloadPending(ACTIVATION_SUBJECT));

  function toggleZero(itemId: string) {
    if (unknownAction<ActivationWrite>(ACTIVATION_SUBJECT)) return;
    setChecks((current) => {
      const next = new Set(current.hash === hash ? current.ids : []);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return { hash, ids: next };
    });
  }

  const missing =
    review?.roster.filter((item) => item.missing).map((item) => item.itemId) ??
    [];
  const allChecked = missing.every((id) => checked.has(id));
  const showActivate =
    unknown !== null ||
    reloadPending ||
    (review !== null && showActivationButton(review));
  const activateLabel = reloadPending
    ? 'إعادة تحميل المراجعة'
    : unknown
      ? 'إعادة المحاولة'
      : 'تفعيل الخصم';
  const activateDisabled =
    !online || saving || (!reloadPending && unknown === null && !allChecked);

  async function reloadReview(): Promise<OpeningReview | null> {
    try {
      return await loadOpeningReview();
    } catch {
      setReloadBlocked(true);
      setNotice(reloadFailedMessage);
      return null;
    }
  }

  function acceptReloaded(
    expected: HeldWriteRecord<ActivationWrite>,
    next: OpeningReview,
  ): void {
    const { requestId } = expected;
    if (next.activated) {
      clearHeldWrite(ACTIVATION_SUBJECT, requestId, expected);
      onReview(next);
      setReloadBlocked(false);
      setNotice(null);
      return;
    }
    if (!next.openingManifestHash) {
      setReloadBlocked(true);
      setNotice(reloadFailedMessage);
      onReview(next);
      return;
    }
    const replaced = replaceActivationPayload(
      ACTIVATION_SUBJECT,
      requestId,
      {
        requestId,
        manifestHash: next.openingManifestHash,
        explicitZeroItemIds: [],
      },
      expected,
    );
    if (!replaced) {
      setReloadBlocked(true);
      setNotice(reloadFailedMessage);
      onReview(next);
      return;
    }
    setChecks({ hash: next.openingManifestHash, ids: new Set() });
    setReloadBlocked(false);
    onReview(next);
    setNotice(manifestChangedMessage);
  }

  async function verifyPostedActivation(): Promise<void> {
    const pins = snapshotActionPostedReloads({ subject: ACTIVATION_SUBJECT });
    const next = await reloadReview();
    if (!next) return;
    if (!next.activated) {
      setReloadBlocked(true);
      setNotice(reloadFailedMessage);
      return;
    }
    onReview(next);
    await clearActionPostedReloadSnapshot(pins, ACTIVATION_SUBJECT);
    setReloadBlocked(false);
    setNotice(null);
  }

  async function activate(): Promise<void> {
    if (!review || flight.current || !isOnline()) return;
    const current = heldAction<ActivationWrite>(ACTIVATION_SUBJECT);
    const unknownHeld = unknownAction<ActivationWrite>(ACTIVATION_SUBJECT);
    const isPosted =
      posted || hasPostedReload(ACTIVATION_SUBJECT, ACTIVATION_SUBJECT);
    if (reloadPending || isPosted) {
      const reviewWasPending =
        activationReviewReloadPending(ACTIVATION_SUBJECT);
      const requestId =
        heldRequestId(ACTIVATION_SUBJECT) ??
        (unknownHeld ?? current)?.requestId;
      flight.current = true;
      setSaving(true);
      let releaseReloadLock = () => {};
      try {
        if (isPosted) {
          await verifyPostedActivation();
          return;
        }
        const lock = await acquireHeldWriteLock(ACTIVATION_SUBJECT);
        if (!lock.acquired) return;
        releaseReloadLock = lock.release;
        const durable = readLockedHeldWrite<ActivationWrite>(
          ACTIVATION_SUBJECT,
          { refresh: true },
        );
        if (
          durable &&
          durable.requestId === requestId &&
          durable.awaitingReviewReload
        ) {
          const next = await reloadReview();
          if (next) acceptReloaded(durable, next);
          return;
        }
        if (reviewWasPending) {
          // The durable request changed after this button was rendered.
          setReloadBlocked(true);
          setNotice(unknownSaveMessage);
          return;
        }
        const next = await reloadReview();
        if (!next) return;
        if (durable && durable.phase !== 'posted_reload') {
          if (next.activated) {
            clearHeldWrite(ACTIVATION_SUBJECT, durable.requestId, durable);
          } else if (durable.phase === 'inflight') {
            setHeldWritePhase(
              ACTIVATION_SUBJECT,
              durable.requestId,
              'unknown',
              { expected: durable },
            );
          }
        }
        onReview(next);
        setReloadBlocked(false);
        setNotice(durable && !next.activated ? unknownSaveMessage : null);
      } catch (error) {
        setReloadBlocked(true);
        setNotice(messageFrom(error));
      } finally {
        releaseReloadLock();
        flight.current = false;
        setSaving(false);
      }
      return;
    }

    const session = captureWriteSession();
    let action: ActivationWrite;
    let releaseLock: () => void;
    let priorPhase: 'unknown' | 'inflight' | null = null;
    if (unknownHeld) {
      priorPhase = 'unknown';
      const claim = await claimReplayAction<ActivationWrite>(
        ACTIVATION_SUBJECT,
        unknownHeld.requestId,
        { session },
      );
      if (!claim.ok) {
        if (claim.reason === 'conflict') {
          setReloadBlocked(true);
          setNotice(
            claim.existing?.phase === 'posted_reload'
              ? reloadFailedMessage
              : unknownSaveMessage,
          );
        } else if (claim.reason === 'missing' || claim.reason === 'storage') {
          setNotice(storageWriteFailedMessage);
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setNotice(offlineWriteMessage);
        }
        return;
      }
      action = claim.record.payload;
      releaseLock = claim.release;
    } else if (current && !activationReviewReloadPending(ACTIVATION_SUBJECT)) {
      priorPhase = 'inflight';
      const nextPayload: ActivationWrite = {
        ...current,
        explicitZeroItemIds: zerosOf(checked),
      };
      const claim = await claimReplayAction<ActivationWrite>(
        ACTIVATION_SUBJECT,
        current.requestId,
        { payload: nextPayload, awaitingReviewReload: false, session },
      );
      if (!claim.ok) {
        if (claim.reason === 'conflict') {
          setReloadBlocked(true);
          setNotice(
            claim.existing?.phase === 'posted_reload'
              ? reloadFailedMessage
              : unknownSaveMessage,
          );
        } else if (claim.reason === 'missing' || claim.reason === 'storage') {
          setNotice(storageWriteFailedMessage);
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setNotice(offlineWriteMessage);
        }
        return;
      }
      action = claim.record.payload;
      releaseLock = claim.release;
    } else {
      if (hasAction(ACTIVATION_SUBJECT) || !review.openingManifestHash) return;
      const manifestHash = review.openingManifestHash;
      const claim = await claimFreshAction<ActivationWrite>(
        ACTIVATION_SUBJECT,
        (requestId) => ({
          requestId,
          manifestHash,
          explicitZeroItemIds: zerosOf(checked),
        }),
        { session },
      );
      if (!claim.ok) {
        if (
          claim.reason === 'conflict' &&
          claim.existing?.phase === 'posted_reload'
        ) {
          setReloadBlocked(true);
          setNotice(reloadFailedMessage);
        } else if (claim.reason === 'storage') {
          setNotice(storageWriteFailedMessage);
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setNotice(offlineWriteMessage);
        }
        return;
      }
      action = claim.record.payload;
      releaseLock = claim.release;
    }

    if (!canDispatchAction(ACTIVATION_SUBJECT, action.requestId, session)) {
      const durable = hasDurableAction(ACTIVATION_SUBJECT, action.requestId);
      abortClaimBeforeDispatch(
        ACTIVATION_SUBJECT,
        action.requestId,
        priorPhase,
        releaseLock,
      );
      if (!durable) setNotice(storageWriteFailedMessage);
      else if (!isOnline()) setNotice(offlineWriteMessage);
      return;
    }

    flight.current = true;
    setSaving(true);
    setNotice(null);
    try {
      let saved: ActivationResult;
      let persisted = false;
      try {
        saved = await activateInventory(action);
        persisted = true;
        markActionPostedReload(
          ACTIVATION_SUBJECT,
          action.requestId,
          ACTIVATION_SUBJECT,
        );
        onReview({
          ...review,
          activated: true,
          stockStartedAt: saved.stockStartedAt,
          openingManifestHash:
            saved.openingManifestHash ?? review.openingManifestHash,
          canActivate: false,
        });
      } catch (failure) {
        if (!persisted && isOpeningManifestChange(failure)) {
          try {
            pinActivationReviewReload(ACTIVATION_SUBJECT, action.requestId);
            const durable =
              readLockedHeldWrite<ActivationWrite>(ACTIVATION_SUBJECT);
            setReloadBlocked(true);
            const next = await reloadReview();
            if (
              next &&
              durable?.requestId === action.requestId &&
              durable.awaitingReviewReload
            ) {
              acceptReloaded(durable, next);
            }
          } catch (storageError) {
            setReloadBlocked(true);
            setNotice(
              storageError instanceof HeldWriteStorageError
                ? storageWriteFailedMessage
                : messageFrom(storageError),
            );
            return;
          }
          return;
        }
        if (!persisted) {
          settleAction(ACTIVATION_SUBJECT, action.requestId, failure);
        } else {
          setReloadBlocked(true);
        }
        setNotice(messageFrom(failure));
        return;
      } finally {
        releaseLock();
      }
      try {
        await verifyPostedActivation();
      } catch {
        setNotice(reloadFailedMessage);
      }
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  return {
    checkedZeroIds: checked,
    checksLocked: unknown !== null,
    toggleZero,
    notice,
    saving,
    showActivate,
    activateLabel,
    activateDisabled,
    activate,
  };
}
