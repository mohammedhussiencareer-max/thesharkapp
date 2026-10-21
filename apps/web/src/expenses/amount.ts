import { formatPiasters, toPiasters } from '@/lib/money';

const maxMoneyPiasters = 99999999999999n;
const maxHourHundredths = 999999n;

export type ParseFailure = 'empty' | 'format' | 'scale' | 'large' | 'zero';

export type ParsedDecimal =
  { ok: true; value: string } | { ok: false; reason: ParseFailure };

/** Western digits, Arabic decimal separator, and a single comma as the decimal mark. */
export function normalizeDecimalInput(value: string): string {
  const western = value
    .trim()
    .replace(/[\u0660-\u0669]/g, (digit) =>
      String(digit.charCodeAt(0) - 0x0660),
    )
    .replace(/[\u06f0-\u06f9]/g, (digit) =>
      String(digit.charCodeAt(0) - 0x06f0),
    )
    .replace(/\u066b/g, '.');
  const comma = western.indexOf(',');
  if (
    comma !== -1 &&
    !western.includes('.') &&
    western.indexOf(',', comma + 1) === -1
  ) {
    return western.replace(',', '.');
  }
  return western;
}

function parseScaled(
  value: string,
  maxWholeDigits: number,
  maxUnits: bigint,
): ParsedDecimal {
  const text = normalizeDecimalInput(value);
  if (text === '') return { ok: false, reason: 'empty' };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, reason: 'format' };
  const [whole, fraction = ''] = text.split('.');
  if (!whole) return { ok: false, reason: 'format' };
  if (fraction.length > 2) return { ok: false, reason: 'scale' };
  if (whole.length > maxWholeDigits) return { ok: false, reason: 'large' };
  const canonical = `${whole}.${fraction.padEnd(2, '0')}`;
  let units: bigint;
  try {
    units = toPiasters(canonical);
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (units <= 0n) return { ok: false, reason: 'zero' };
  if (units > maxUnits) return { ok: false, reason: 'large' };
  return { ok: true, value: formatPiasters(units) };
}

export function parseMoney(value: string): ParsedDecimal {
  return parseScaled(value, 12, maxMoneyPiasters);
}

export function parseHours(value: string): ParsedDecimal {
  return parseScaled(value, 4, maxHourHundredths);
}

/**
 * `round(hours * hourly_rate, 2)`, half away from zero, in integer piasters.
 * Matches `numeric` round in Postgres for these two-decimal inputs.
 */
export function driverPay(hours: string, hourlyRate: string): ParsedDecimal {
  const parsedHours = parseHours(hours);
  if (!parsedHours.ok) return parsedHours;
  const parsedRate = parseMoney(hourlyRate);
  if (!parsedRate.ok) return parsedRate;
  const product = toPiasters(parsedHours.value) * toPiasters(parsedRate.value);
  const remainder = product % 100n;
  const quotient = product / 100n;
  const rounded = remainder >= 50n ? quotient + 1n : quotient;
  if (rounded <= 0n) return { ok: false, reason: 'zero' };
  if (rounded > maxMoneyPiasters) return { ok: false, reason: 'large' };
  return { ok: true, value: formatPiasters(rounded) };
}

const phoneDigit = /[0-9\u0660-\u0669\u06f0-\u06f9]/;
const phoneSeparator = /[\s.\u066b\u2013\u2014\u2212-]/;

/**
 * A run of 8 or more digits. Spaces, dashes, and dots between digits do not
 * break the run. Counts Western, Arabic-Indic, and Extended Arabic-Indic digits.
 */
export function hasLongDigitRun(value: string): boolean {
  let run = 0;
  for (const char of value) {
    if (phoneDigit.test(char)) {
      run += 1;
      if (run >= 8) return true;
      continue;
    }
    if (phoneSeparator.test(char)) continue;
    run = 0;
  }
  return false;
}
