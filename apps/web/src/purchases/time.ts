const cairo = 'Africa/Cairo';

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function wallParts(date: Date): Wall | null {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: cairo,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of formatted) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  let hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return null;
  }
  // Some engines report midnight as hour 24 on the previous calendar day.
  if (hour === 24) hour = 0;
  return { year, month, day, hour, minute, second };
}

function zoneOffset(instant: Date): number | null {
  const wall = wallParts(instant);
  if (!wall) return null;
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - instant.getTime();
}

function isRealDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** `datetime-local` value for the current Cairo wall time, minute precision. */
export function nowCairoDateTimeLocal(now = new Date()): string {
  const wall = wallParts(now);
  if (!wall) return '';
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

export const missingCairoTimeMessage = 'الوقت ده مش موجود في توقيت القاهرة';

export type CairoDateTimeParse =
  { ok: true; iso: string } | { ok: false; reason: 'invalid' | 'missing' };

/**
 * Interpret a `datetime-local` value as Africa/Cairo.
 * A skipped clock time (Egypt starts DST at 00:00, so that hour does not
 * exist) is `missing`. A repeated clock time (the autumn fall-back) uses the
 * earlier instant: the first time that wall clock occurs, while daylight
 * saving is still in effect.
 */
export function parseCairoDateTimeLocal(value: string): CairoDateTimeParse {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return { ok: false, reason: 'invalid' };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!isRealDate(year, month, day) || hour > 23 || minute > 59) {
    return { ok: false, reason: 'invalid' };
  }

  const matches = matchingInstants(year, month, day, hour, minute);
  const earliest = matches[0];
  if (earliest === undefined) return { ok: false, reason: 'missing' };
  return { ok: true, iso: new Date(earliest).toISOString() };
}

export function cairoDateTimeLocalToIso(value: string): string | null {
  const parsed = parseCairoDateTimeLocal(value);
  return parsed.ok ? parsed.iso : null;
}

/** Sample offsets around the labeled instant so both sides of a transition are seen. */
function matchingInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number[] {
  const label = Date.UTC(year, month - 1, day, hour, minute, 0);
  const windowMs = 14 * 60 * 60 * 1000;
  const stepMs = 30 * 60 * 1000;
  const found = new Set<number>();
  for (let delta = -windowMs; delta <= windowMs; delta += stepMs) {
    const offset = zoneOffset(new Date(label + delta));
    if (offset === null) continue;
    const instant = label - offset;
    const wall = wallParts(new Date(instant));
    if (
      wall &&
      wall.year === year &&
      wall.month === month &&
      wall.day === day &&
      wall.hour === hour &&
      wall.minute === minute &&
      wall.second === 0
    ) {
      found.add(instant);
    }
  }
  return [...found].sort((left, right) => left - right);
}

export function formatCairoDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const wall = wallParts(date);
  if (!wall) return iso;
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

function parseDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isRealDate(year, month, day)) return null;
  return { year, month, day };
}

/**
 * First instant that exists on a Cairo calendar day.
 * On the DST start day, 00:00 is skipped and the day begins at 01:00.
 */
function firstInstantOfDay(
  year: number,
  month: number,
  day: number,
): number | null {
  const target = year * 10000 + month * 100 + day;
  const anchor = Date.UTC(year, month - 1, day);
  const windowMs = 18 * 60 * 60 * 1000;
  let lo = anchor - windowMs;
  let hi = anchor + windowMs;
  const keyOf = (ms: number) => {
    const wall = wallParts(new Date(ms));
    if (!wall) return null;
    return wall.year * 10000 + wall.month * 100 + wall.day;
  };
  const loKey = keyOf(lo);
  const hiKey = keyOf(hi);
  if (loKey === null || hiKey === null || loKey >= target || hiKey < target) {
    return null;
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const key = keyOf(mid);
    if (key === null || key < target) lo = mid + 1;
    else hi = mid;
  }
  const wall = wallParts(new Date(lo));
  if (!wall || wall.year !== year || wall.month !== month || wall.day !== day) {
    return null;
  }
  return lo;
}

/** Inclusive start of a Cairo calendar date, as a UTC ISO string. */
export function cairoDateStartIso(date: string): string | null {
  const parsed = parseDate(date);
  if (!parsed) return null;
  const instant = firstInstantOfDay(parsed.year, parsed.month, parsed.day);
  return instant === null ? null : new Date(instant).toISOString();
}

/**
 * Exclusive end of a Cairo calendar date: the first instant of the next day.
 * Compared with `purchased_at <` this value, the selected day runs through the
 * instant just before the next day's start, including a repeated fall-back hour.
 * The next day is not assumed to start at 00:00.
 */
export function cairoNextDateStartIso(date: string): string | null {
  const parsed = parseDate(date);
  if (!parsed) return null;
  const next = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1),
  );
  const instant = firstInstantOfDay(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
  );
  return instant === null ? null : new Date(instant).toISOString();
}

export function dateRangeError(from: string, to: string): string | null {
  if (from && !parseDate(from)) return 'تاريخ البداية مش مظبوط';
  if (to && !parseDate(to)) return 'تاريخ النهاية مش مظبوط';
  if (from && to && from > to)
    return 'تاريخ البداية لازم يكون قبل تاريخ النهاية';
  return null;
}
