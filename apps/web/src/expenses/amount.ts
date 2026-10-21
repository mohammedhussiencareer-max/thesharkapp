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

/**
 * Ignored between decimal digits. Same set as `app.text_has_long_digit_run`.
 * U+002D is listed here and placed last in the class so it stays literal.
 */
export const digitRunIgnoredCodePoints = [
  0x002d, 0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0x2010, 0x2011,
  0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d, 0x002e,
  0x066b, 0xff0e, 0x3002, 0x00b7, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x2060, 0xfeff, 0x061c,
] as const;

const digitSeparator = new RegExp(
  `[${digitRunIgnoredCodePoints
    .filter((codePoint) => codePoint !== 0x002d)
    .map((codePoint) => `\\u{${codePoint.toString(16)}}`)
    .join('')}-]`,
  'u',
);

/** Shared digit-run cases: fullwidth, Devanagari, Bengali, mathematical bold, mixed scripts, NBSP, zero-width, and NFKC superscripts. */
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
] as const;

/** Seven digits, and eight digits split by a letter, stay allowed. */
export const shortDigitRunSamples = [
  'فاتورة 1234567',
  'رقم 1234x5678',
  '1234x\u200B5678',
  '\uFF10\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16',
] as const;

/**
 * A run of 8 or more Unicode decimal digits. NFKC is applied first. The
 * separators in {@link digitRunIgnoredCodePoints}, plus hyphen-minus, do not
 * break the run.
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
    if (digitSeparator.test(char)) continue;
    run = 0;
  }
  return false;
}
