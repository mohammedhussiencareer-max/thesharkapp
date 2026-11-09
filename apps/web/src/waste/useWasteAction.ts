import { useEffect, useRef, useState } from 'react';
import { messageFrom } from '@/items/errors';
import {
  beginAction,
  hasAction,
  settleAction,
  subscribeHeldWrites,
  unknownAction,
} from '@/items/request-id';
import { recordWaste } from '@/waste/api';
import { MissingCostBasisError } from '@/waste/errors';
import type { WasteNotice, WasteResult, WasteWrite } from '@/waste/types';

export const reloadFailedMessage =
  'تحديث السجل فشل — اضغط تحديث قبل ما تسجل تاني';

/**
 * One outstanding waste action per subject. A save whose outcome is unknown
 * stays held and can only be sent again as the same payload. A failed reload
 * only warns: it never settles or releases the action.
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

  async function finish(action: WasteWrite): Promise<void> {
    if (flight.current) return;
    flight.current = true;
    setSaving(true);
    setNotice(null);
    try {
      let saved: WasteResult;
      try {
        saved = await recordWaste(action);
        settleAction(subject, action.requestId);
      } catch (failure) {
        settleAction(subject, action.requestId, failure);
        const message = messageFrom(failure);
        const itemIds =
          failure instanceof MissingCostBasisError
            ? failure.itemIds
            : undefined;
        if (hasAction(subject)) {
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
      }
      const warning = await reload();
      options.onSaved?.(saved);
      setNotice({ kind: 'saved', result: saved, warning });
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  /** Starts a new action, or does nothing while one is outstanding. */
  function send(create: (requestId: string) => WasteWrite): void {
    if (flight.current || saving || hasAction(subject)) return;
    void finish(beginAction<WasteWrite>(subject, create));
  }

  function retry(): void {
    if (held) void finish(held);
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
