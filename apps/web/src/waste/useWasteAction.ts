import { useEffect, useRef, useState } from 'react';
import { messageFrom } from '@/items/errors';
import {
  claimFreshAction,
  claimReplayAction,
  clearActionPostedReload,
  hasAction,
  markActionPostedReload,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import {
  canDispatchWriteFor,
  captureWriteSession,
  setHeldWritePhase,
  storageWriteFailedMessage,
  type WriteSession,
} from '@/lib/held-writes';
import { isOnline, offlineWriteMessage } from '@/lib/online';
import { recordWaste } from '@/waste/api';
import { MissingCostBasisError } from '@/waste/errors';
import type { WasteNotice, WasteResult, WasteWrite } from '@/waste/types';

export const reloadFailedMessage =
  'تحديث السجل فشل — اضغط تحديث قبل ما تسجل تاني';

/**
 * One outstanding waste action per subject. A save whose outcome is unknown
 * stays held and can only be sent again as the same payload after re-verifying
 * the durable pin in localStorage. On RPC success, moves to `posted_reload`
 * and clears only after the post-write reload succeeds.
 */
export function useWasteAction(
  subject: string,
  options: {
    reload: () => Promise<void>;
    onSaved?: (result: WasteResult) => void;
  },
) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<WasteNotice | null>(null);
  const [heldEpoch, setHeldEpoch] = useState(0);
  const flight = useRef(false);
  const held = heldEpoch < 0 ? null : unknownAction<WasteWrite>(subject);

  useEffect(
    () => subscribeHeldWrites(() => setHeldEpoch((value) => value + 1)),
    [],
  );

  async function reload(): Promise<string | null> {
    try {
      await options.reload();
      return null;
    } catch {
      return reloadFailedMessage;
    }
  }

  async function finish(
    action: WasteWrite,
    session: WriteSession | null,
    isReplay: boolean,
    releaseLock: () => void,
  ): Promise<void> {
    if (flight.current || !canDispatchWriteFor(session)) {
      if (isReplay) {
        setHeldWritePhase(subject, action.requestId, 'unknown');
      } else {
        settleAction(subject, action.requestId);
      }
      releaseLock();
      if (!isOnline()) {
        setNotice({ kind: 'failed', message: offlineWriteMessage });
      }
      return;
    }
    flight.current = true;
    setSaving(true);
    setNotice(null);
    try {
      let saved: WasteResult;
      let persisted = false;
      try {
        saved = await recordWaste(action);
        persisted = true;
        markActionPostedReload(subject, action.requestId, subject);
      } catch (failure) {
        if (!persisted) {
          settleAction(subject, action.requestId, failure);
        }
        const message = messageFrom(failure);
        const itemIds =
          !persisted && failure instanceof MissingCostBasisError
            ? failure.itemIds
            : undefined;
        if (persisted || hasAction(subject)) {
          setNotice({ kind: 'failed', message, itemIds });
          return;
        }
        const warning = await reload();
        setNotice({
          kind: 'failed',
          message: warning ? `${message} — ${warning}` : message,
          itemIds,
        });
        return;
      } finally {
        releaseLock();
      }
      const warning = await reload();
      if (warning === null) {
        clearActionPostedReload(subject, subject, action.requestId);
      }
      options.onSaved?.(saved);
      setNotice({ kind: 'saved', result: saved, warning });
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  /** Starts a new action, or does nothing while one is outstanding. */
  function send(create: (requestId: string) => WasteWrite): void {
    if (flight.current || saving || !isOnline() || hasAction(subject)) return;
    const session = captureWriteSession();
    void (async () => {
      const claim = await claimFreshAction<WasteWrite>(subject, create, {
        session,
      });
      if (!claim.ok) {
        if (claim.reason === 'storage') {
          setNotice({ kind: 'failed', message: storageWriteFailedMessage });
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setNotice({ kind: 'failed', message: offlineWriteMessage });
        }
        return;
      }
      await finish(claim.record.payload, session, false, claim.release);
    })();
  }

  function retry(): void {
    if (!held || flight.current || saving || !isOnline()) return;
    const targetId = held.requestId;
    const session = captureWriteSession();
    void (async () => {
      const claim = await claimReplayAction<WasteWrite>(subject, targetId, {
        session,
      });
      if (!claim.ok) {
        if (claim.reason === 'missing' || claim.reason === 'storage') {
          setNotice({ kind: 'failed', message: storageWriteFailedMessage });
        } else if (claim.reason === 'session_invalid' && !isOnline()) {
          setNotice({ kind: 'failed', message: offlineWriteMessage });
        }
        return;
      }
      await finish(claim.record.payload, session, true, claim.release);
    })();
  }

  return {
    saving,
    notice,
    held,
    send,
    retry,
    clearNotice: () => setNotice(null),
  };
}
