/**
 * Legacy order and shift timestamps. The text must match the UTC pattern and
 * `Date.parse` must accept it. Calendar overflow and `24:00:00` stay as stored.
 * Catalog timestamps use `normalizeCatalogTimestamp`.
 */
export function normalizeTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d{1,9}))?Z$/.exec(
    value,
  );
  if (!match) {
    throw new Error('invalid timestamp');
  }
  const base = match[1];
  if (base === undefined) {
    throw new Error('invalid timestamp');
  }
  const micros = `${match[3] ?? ''}000000`.slice(0, 6);
  const iso = `${base}.${micros}Z`;
  if (!Number.isFinite(Date.parse(iso))) {
    throw new Error('invalid timestamp');
  }
  return iso;
}

/** Catalog timestamps: a real calendar date, year >= 0001, and hour <= 23. */
export function normalizeCatalogTimestamp(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
      value,
    );
  if (!match) {
    throw new Error('invalid timestamp');
  }
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  const hourText = match[4];
  const minuteText = match[5];
  const secondText = match[6];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    throw new Error('invalid timestamp');
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error('invalid timestamp');
  }
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day ||
    utc.getUTCHours() !== hour ||
    utc.getUTCMinutes() !== minute ||
    utc.getUTCSeconds() !== second
  ) {
    throw new Error('invalid timestamp');
  }
  const micros = `${match[7] ?? ''}000000`.slice(0, 6);
  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${micros}Z`;
}
