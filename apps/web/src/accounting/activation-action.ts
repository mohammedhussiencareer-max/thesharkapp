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
  beginAction,
  hasAction,
  heldAction,
  replaceActivationPayload,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
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
    reloadBlocked ||
    (review !== null && showActivationButton(review));
  const activateLabel = reloadBlocked
    ? 'إعادة تحميل المراجعة'
    : unknown
      ? 'إعادة المحاولة'
      : 'تفعيل الخصم';
  const activateDisabled =
    saving || (!reloadBlocked && unknown === null && !allChecked);

  async function reloadReview(): Promise<OpeningReview | null> {
    try {
      return await loadOpeningReview();
    } catch {
      setReloadBlocked(true);
      setNotice(reloadFailedMessage);
      return null;
    }
  }

  function acceptReloaded(requestId: string, next: OpeningReview): void {
    if (next.activated) {
      settleAction(ACTIVATION_SUBJECT, requestId);
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
    replaceActivationPayload(ACTIVATION_SUBJECT, requestId, {
      requestId,
      manifestHash: next.openingManifestHash,
      explicitZeroItemIds: [],
    });
    setChecks({ hash: next.openingManifestHash, ids: new Set() });
    setReloadBlocked(false);
    onReview(next);
    setNotice(manifestChangedMessage);
  }

  async function activate(): Promise<void> {
    if (!review || flight.current) return;
    const current = heldAction<ActivationWrite>(ACTIVATION_SUBJECT);
    const unknownHeld = unknownAction<ActivationWrite>(ACTIVATION_SUBJECT);
    if (reloadBlocked) {
      const requestId = (unknownHeld ?? current)?.requestId;
      if (!requestId) return;
      flight.current = true;
      setSaving(true);
      try {
        const next = await reloadReview();
        if (next) acceptReloaded(requestId, next);
      } finally {
        flight.current = false;
        setSaving(false);
      }
      return;
    }

    let action: ActivationWrite;
    if (unknownHeld) {
      action = unknownHeld;
    } else if (current) {
      action = { ...current, explicitZeroItemIds: zerosOf(checked) };
      replaceActivationPayload(ACTIVATION_SUBJECT, action.requestId, action);
    } else {
      if (hasAction(ACTIVATION_SUBJECT) || !review.openingManifestHash) return;
      const manifestHash = review.openingManifestHash;
      action = beginAction(ACTIVATION_SUBJECT, (requestId) => ({
        requestId,
        manifestHash,
        explicitZeroItemIds: zerosOf(checked),
      }));
    }

    flight.current = true;
    setSaving(true);
    setNotice(null);
    try {
      let saved: ActivationResult;
      try {
        saved = await activateInventory(action);
        settleAction(ACTIVATION_SUBJECT, action.requestId);
        onReview({
          ...review,
          activated: true,
          stockStartedAt: saved.stockStartedAt,
          openingManifestHash:
            saved.openingManifestHash ?? review.openingManifestHash,
          canActivate: false,
        });
      } catch (failure) {
        if (isOpeningManifestChange(failure)) {
          const next = await reloadReview();
          if (next) acceptReloaded(action.requestId, next);
          return;
        }
        settleAction(ACTIVATION_SUBJECT, action.requestId, failure);
        setNotice(messageFrom(failure));
        return;
      }
      try {
        onReview(await loadOpeningReview());
        setNotice(null);
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
