const cairo = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const cairoDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const monthNames = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
] as const;

function part(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((entry) => entry.type === type)?.value ?? '';
}

/** `Africa/Cairo` date and time, `DD/MM/YYYY HH:mm`. */
export function formatCairo(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = cairo.formatToParts(date);
  return `${part(parts, 'day')}/${part(parts, 'month')}/${part(parts, 'year')} ${part(parts, 'hour')}:${part(parts, 'minute')}`;
}

/** Calendar date in `Africa/Cairo`, `YYYY-MM-DD`. A date-only string is not parsed. */
export function cairoDateIso(now = new Date()): string {
  const parts = cairoDate.formatToParts(now);
  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
}

/** `YYYY-MM` for `<input type="month">`, in `Africa/Cairo`. */
export function cairoMonthInput(now = new Date()): string {
  return cairoDateIso(now).slice(0, 7);
}

/** Last calendar day of a `YYYY-MM-01` month, as `YYYY-MM-DD`. */
export function monthEndIso(monthStart: string): string {
  if (!/^\d{4}-\d{2}-01$/.test(monthStart)) {
    throw new Error('month start is invalid');
  }
  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthStart.slice(0, 8)}${String(last).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` as `DD/MM/YYYY`, without passing the date through `Date`. */
export function formatIsoDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** `YYYY-MM-01` as an Arabic month and year, for example `أبريل 2030`. */
export function formatMonth(monthStart: string): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(monthStart);
  if (!match) return monthStart;
  const [, year, monthText] = match;
  const name = monthNames[Number(monthText) - 1];
  if (!year || !name) return monthStart;
  return `${name} ${year}`;
}
