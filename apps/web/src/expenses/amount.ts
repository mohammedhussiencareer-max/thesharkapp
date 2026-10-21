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

const decimalDigit = /\p{Nd}/u;
const letter = /\p{L}/u;

/**
 * Shared cases for `hasLongDigitRun` and the server helper. A full date such
 * as 2030-04-03 is eight digits and is refused. That is an accepted trade-off
 * for the phone and national-id rule.
 */
export const longDigitRunSamples = [
  '01000000000',
  '010 0000 0000',
  '010-0000-0000',
  '010.0000.0000',
  '٠١٠٠٠٠٠٠٠٠٠',
  '٠١٠ ٠٠٠٠ ٠٠٠٠',
  '۰۱۰۰۰۰۰۰۰۰۰',
  '0100000\uFF10000',
  '\uFF10\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17',
  '०१२३४५६७८९',
  '০১২৩৪৫৬৭৮৯',
  '\u{1D7CE}\u{1D7CF}\u{1D7D0}\u{1D7D1}\u{1D7D2}\u{1D7D3}\u{1D7D4}\u{1D7D5}',
  '0123०१২৩',
  '0100\u00A00000000',
  '0100\u200B0000000',
  '\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078',
  '(03) 000-0000',
  '+20 (100) 000/0000',
  '010_0000_0000',
  '010\u2022000\u20220000',
  '010\u{1F600}0000\u{1F600}0000',
  '2030-04-03',
] as const;

/** Seven digits, or eight digits split by a letter, stay allowed. */
export const shortDigitRunSamples = [
  'فاتورة 1234567',
  'رقم 1234x5678',
  '1234x\u200B5678',
  '\uFF10\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16',
  '0100 ب 0000',
  '5.5 ساعة × 30 جنيه',
] as const;

/**
 * A run of 8 or more Unicode decimal digits. NFKC is applied first. A letter
 * resets the count. Every other character is ignored.
 */
export function hasLongDigitRun(value: string): boolean {
  const text = value.normalize('NFKC');
  let run = 0;
  for (const char of text) {
    if (decimalDigit.test(char)) {
      run += 1;
      if (run >= 8) return true;
      continue;
    }
    if (letter.test(char)) run = 0;
  }
  return false;
}
