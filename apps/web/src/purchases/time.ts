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

/**
 * Interpret a `datetime-local` value as Africa/Cairo and return a UTC ISO string.
 * Returns null when the value is not a real Cairo wall time (including a DST gap).
 * An overlapping hour uses the first matching offset.
 */
export function cairoDateTimeLocalToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!isRealDate(year, month, day) || hour > 23 || minute > 59) return null;

  const utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = zoneOffset(new Date(utc));
  if (offset1 === null) return null;
  let guess = utc - offset1;
  const offset2 = zoneOffset(new Date(guess));
  if (offset2 === null) return null;
  if (offset2 !== offset1) guess = utc - offset2;
  const check = wallParts(new Date(guess));
  if (
    !check ||
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute
  ) {
    return null;
  }
  return new Date(guess).toISOString();
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

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Inclusive start of a Cairo calendar date, as a UTC ISO string. */
export function cairoDateStartIso(date: string): string | null {
  const parsed = parseDate(date);
  if (!parsed) return null;
  return cairoDateTimeLocalToIso(
    `${formatDate(parsed.year, parsed.month, parsed.day)}T00:00`,
  );
}

/** Exclusive end: start of the next Cairo calendar date. */
export function cairoNextDateStartIso(date: string): string | null {
  const parsed = parseDate(date);
  if (!parsed) return null;
  const next = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day + 1),
  );
  return cairoDateTimeLocalToIso(
    `${formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())}T00:00`,
  );
}

export function dateRangeError(from: string, to: string): string | null {
  if (from && !parseDate(from)) return 'تاريخ البداية مش مظبوط';
  if (to && !parseDate(to)) return 'تاريخ النهاية مش مظبوط';
  if (from && to && from > to)
    return 'تاريخ البداية لازم يكون قبل تاريخ النهاية';
  return null;
}
