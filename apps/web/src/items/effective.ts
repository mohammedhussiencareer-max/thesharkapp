import type { DatedWrite } from '@/items/types';

/** md5('') — the token of an empty loss or conversion schedule. */
export const emptyScheduleToken = 'd41d8cd98f00b204e9800998ecf8427e';

export type EffectiveMode = 'now' | 'shift' | 'custom';

export type SchedulePoint = {
  effectiveFrom: string;
  effectiveTo: string | null;
};

/**
 * Default the owner sees: the open shift's start when one exists, otherwise now.
 * "now" is sent as null. The server stamps the current minute and keeps the
 * replay marker "now". The current minute is not backdating.
 */
export function defaultEffectiveMode(shiftStart: string | null): EffectiveMode {
  return shiftStart ? 'shift' : 'now';
}

/** Null means the server's current minute. Any other choice is an absolute timestamp. */
export function effectiveFromPayload(
  mode: EffectiveMode,
  shiftStart: string | null,
  customIso: string | null,
): string | null {
  if (mode === 'now') return null;
  if (mode === 'shift') return shiftStart;
  return customIso;
}

export function chosenInstantMs(
  mode: EffectiveMode,
  shiftStart: string | null,
  customIso: string | null,
  nowMs: number,
): number | null {
  if (mode === 'now') return nowMs;
  const iso = mode === 'shift' ? shiftStart : customIso;
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

export function needsBackdatedReason(
  mode: EffectiveMode,
  shiftStart: string | null,
  customIso: string | null,
  nowMs: number,
): boolean {
  const chosen = chosenInstantMs(mode, shiftStart, customIso, nowMs);
  if (chosen === null) return false;
  return chosen < nowMs;
}

/**
 * Where an edit that starts at `fromIso` must stop.
 * Inside a version, that version's own end (null when the version is open).
 * Inside a gap, the next version's start, or null when nothing follows.
 * A null start is "now". Ranges are half-open: the end instant belongs to the gap.
 */
export function nextVersionStart(
  versions: readonly SchedulePoint[],
  fromIso: string | null,
  nowIso: string,
): string | null {
  const startMs = Date.parse(fromIso ?? nowIso);
  if (Number.isNaN(startMs)) return null;
  let coveringFrom = Number.NEGATIVE_INFINITY;
  let coveringTo: string | null | undefined;
  let next: number | null = null;
  for (const version of versions) {
    const from = Date.parse(version.effectiveFrom);
    if (Number.isNaN(from)) continue;
    const to =
      version.effectiveTo == null ? null : Date.parse(version.effectiveTo);
    const covers =
      from <= startMs &&
      (version.effectiveTo == null ||
        (to !== null && !Number.isNaN(to) && startMs < to));
    if (covers && from >= coveringFrom) {
      coveringFrom = from;
      coveringTo = version.effectiveTo;
    }
    if (from > startMs && (next === null || from < next)) next = from;
  }
  if (coveringTo !== undefined) {
    if (coveringTo == null) return null;
    const parsed = Date.parse(coveringTo);
    return Number.isNaN(parsed) ? coveringTo : new Date(parsed).toISOString();
  }
  return next === null ? null : new Date(next).toISOString();
}

export function impactLine(orders: number, shifts: number): string {
  return `ممكن يأثر على ${orders} طلب في ${shifts} وردية (تقدير)`;
}

/**
 * A dated loss or conversion write. "now" stores a null start. The end is the
 * covering version's own end, or the next version when the start is in a gap.
 */
export function buildDatedWrite(input: {
  mode: EffectiveMode;
  shiftStart: string | null;
  customIso: string | null;
  versions: readonly SchedulePoint[];
  nowIso: string;
  token: string;
  reason: string;
  requestId: string;
}): { ok: true; write: DatedWrite } | { ok: false; error: string } {
  if (input.mode === 'shift' && !input.shiftStart) {
    return { ok: false, error: 'مفيش وردية مفتوحة' };
  }
  if (input.mode === 'custom' && !input.customIso) {
    return { ok: false, error: 'الوقت مش مظبوط' };
  }
  const nowMs = Date.parse(input.nowIso);
  const backdated = needsBackdatedReason(
    input.mode,
    input.shiftStart,
    input.customIso,
    nowMs,
  );
  const reason = input.reason.trim();
  if (backdated && reason.length === 0) {
    return { ok: false, error: 'اكتب سبب التغيير بأثر رجعي' };
  }
  const effectiveFrom = effectiveFromPayload(
    input.mode,
    input.shiftStart,
    input.customIso,
  );
  return {
    ok: true,
    write: {
      effectiveFrom,
      effectiveTo: nextVersionStart(
        input.versions,
        effectiveFrom,
        input.nowIso,
      ),
      token: input.token,
      reason: backdated ? reason : null,
      requestId: input.requestId,
    },
  };
}
