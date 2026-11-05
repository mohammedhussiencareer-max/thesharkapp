import { useEffect, useState } from 'react';
import { costingImpact } from '@/items/api';
import { EffectiveTimeFields } from '@/items/EffectiveTimeFields';
import {
  buildDatedWrite,
  chosenInstantMs,
  defaultEffectiveMode,
  effectiveFromPayload,
  impactErrorMessage,
  impactLine,
  impactPendingMessage,
  needsBackdatedReason,
  nextVersionStart,
  type EffectiveMode,
  type SchedulePoint,
} from '@/items/effective';
import type { DatedWrite } from '@/items/types';
import { cairoDateTimeLocalToIso } from '@/purchases/time';

function readClock(): number {
  return Date.now();
}

type ImpactView =
  | { status: 'ready'; key: string; text: string }
  | { status: 'error'; key: string };

/** A backdated start needs a reason and a ready impact for the exact interval. */
export function useDatedTiming(
  itemId: string | undefined,
  shiftStart: string | null,
  versions: readonly SchedulePoint[],
  token: string,
  disabled: boolean,
  defaultMode?: EffectiveMode,
) {
  const [mountNow] = useState(() => Date.now());
  const [evaluatedNow, setEvaluatedNow] = useState<number | null>(null);
  const clockMs = evaluatedNow ?? mountNow;
  const [chosenMode, setChosenMode] = useState<EffectiveMode | null>(null);
  const mode = chosenMode ?? defaultMode ?? defaultEffectiveMode(shiftStart);
  const [customLocal, setCustomLocal] = useState('');
  const [reason, setReason] = useState('');
  const [impactAttempt, setImpactAttempt] = useState(0);
  const customIso =
    mode === 'custom' ? cairoDateTimeLocalToIso(customLocal) : null;
  const backdated = needsBackdatedReason(mode, shiftStart, customIso, clockMs);
  const from = backdated
    ? effectiveFromPayload(mode, shiftStart, customIso)
    : null;
  const to = from
    ? nextVersionStart(versions, from, new Date(clockMs).toISOString())
    : null;
  const impactKey = from ? `${from}|${to ?? ''}` : '';
  const [impact, setImpact] = useState<ImpactView | null>(null);
  const shown = impact?.key === impactKey ? impact : null;

  useEffect(() => {
    if (!from || impactKey.length === 0) return;
    let cancelled = false;
    void costingImpact(from, to, itemId)
      .then((next) => {
        if (cancelled) return;
        setImpact({
          key: impactKey,
          status: 'ready',
          text: impactLine(next.orders, next.shifts),
        });
      })
      .catch(() => {
        if (!cancelled) setImpact({ key: impactKey, status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [from, impactAttempt, impactKey, itemId, to]);

  function build():
    | { ok: true; write: DatedWrite; instantMs: number | null }
    | { ok: false; error: string } {
    const now = readClock();
    setEvaluatedNow(now);
    const nowIso = new Date(now).toISOString();
    const backdatedNow = needsBackdatedReason(mode, shiftStart, customIso, now);
    if (backdatedNow && reason.trim().length === 0) {
      return { ok: false, error: 'اكتب سبب التغيير بأثر رجعي' };
    }
    if (backdatedNow) {
      const fromNow = effectiveFromPayload(mode, shiftStart, customIso);
      const toNow = nextVersionStart(versions, fromNow, nowIso);
      const key = `${fromNow ?? ''}|${toNow ?? ''}`;
      if (shown?.status !== 'ready' || shown.key !== key) {
        return {
          ok: false,
          error:
            shown?.status === 'error' && shown.key === key
              ? impactErrorMessage
              : impactPendingMessage,
        };
      }
    }
    const built = buildDatedWrite({
      mode,
      shiftStart,
      customIso,
      versions,
      nowIso,
      token,
      reason,
      requestId: '00000000-0000-4000-8000-000000000000',
    });
    if (!built.ok) return built;
    return {
      ...built,
      instantMs: chosenInstantMs(mode, shiftStart, customIso, now),
    };
  }

  const fields = (
    <EffectiveTimeFields
      mode={mode}
      shiftStart={shiftStart}
      customLocal={customLocal}
      reason={reason}
      backdated={backdated}
      impact={shown?.status === 'ready' ? shown.text : null}
      impactStatus={
        !backdated ? 'idle' : shown === null ? 'loading' : shown.status
      }
      disabled={disabled}
      onMode={setChosenMode}
      onCustomLocal={setCustomLocal}
      onReason={setReason}
      onRetryImpact={() => setImpactAttempt((value) => value + 1)}
    />
  );

  return {
    fields,
    build,
    refreshClock: () => setEvaluatedNow(readClock()),
    instantMs: chosenInstantMs(mode, shiftStart, customIso, clockMs),
  };
}
