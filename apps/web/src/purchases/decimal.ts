export type Dec = {
  neg: boolean;
  int: bigint;
  scale: number;
};

export function isZero(value: Dec): boolean {
  return value.int === 0n;
}

export function isNegative(value: Dec): boolean {
  return value.neg && value.int !== 0n;
}

/** Arabic-Indic and Eastern Arabic-Indic digits, and the Arabic decimal separator. */
export function toWesternDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
}

/**
 * Trim, accept a leading sign, one comma or one dot, and Arabic-Indic digits.
 * No exponent. The result keeps the typed scale, including trailing zeros.
 */
export function parseUserDecimal(raw: string): Dec | null {
  let text = toWesternDigits(raw).trim();
  if (text.startsWith('+')) text = text.slice(1).trim();
  let neg = false;
  if (text.startsWith('-')) {
    neg = true;
    text = text.slice(1).trim();
  }
  if (text.includes(',') && text.includes('.')) return null;
  text = text.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const parts = text.split('.');
  const whole = (parts[0] ?? '0').replace(/^0+(?=\d)/, '') || '0';
  const fraction = parts[1] ?? '';
  return {
    neg,
    int: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

export function formatDec(value: Dec): string {
  let int = value.int;
  let scale = value.scale;
  while (scale > 0 && int % 10n === 0n) {
    int /= 10n;
    scale -= 1;
  }
  const digits = int.toString();
  let body: string;
  if (scale <= 0) {
    body = digits;
  } else if (digits.length <= scale) {
    body = `0.${digits.padStart(scale, '0')}`;
  } else {
    const split = digits.length - scale;
    body = `${digits.slice(0, split)}.${digits.slice(split)}`;
  }
  return isNegative({ ...value, int }) ? `-${body}` : body;
}

export function integerDigits(value: Dec): number {
  if (value.int === 0n) return 1;
  const digits = value.int.toString();
  if (value.scale >= digits.length) return 1;
  const whole = digits.slice(0, digits.length - value.scale).replace(/^0+/, '');
  return Math.max(whole.length, 1);
}

function roundHalfAway(int: bigint, fromScale: number, toScale: number): Dec {
  if (toScale >= fromScale) {
    return {
      neg: false,
      int: int * 10n ** BigInt(toScale - fromScale),
      scale: toScale,
    };
  }
  const factor = 10n ** BigInt(fromScale - toScale);
  const q = int / factor;
  const r = int % factor;
  const rounded = r * 2n >= factor ? q + 1n : q;
  return { neg: false, int: rounded, scale: toScale };
}

export function roundTo(value: Dec, places: number): Dec {
  const rounded = roundHalfAway(value.int, value.scale, places);
  return { ...rounded, neg: value.neg && rounded.int !== 0n };
}

export function mulRound(left: Dec, right: Dec, places: number): Dec {
  const product = roundHalfAway(
    left.int * right.int,
    left.scale + right.scale,
    places,
  );
  const neg =
    left.neg !== right.neg &&
    left.int !== 0n &&
    right.int !== 0n &&
    product.int !== 0n;
  return { ...product, neg };
}

/** PostgreSQL numeric round-half-away-from-zero division. */
export function divRound(left: Dec, right: Dec, places: number): Dec | null {
  if (right.int === 0n || places < 0) return null;
  const num = left.int * 10n ** BigInt(right.scale + places);
  const den = right.int * 10n ** BigInt(left.scale);
  const q = num / den;
  const r = num % den;
  const rounded = r * 2n >= den ? q + 1n : q;
  const neg = left.neg !== right.neg && rounded !== 0n;
  return { neg, int: rounded, scale: places };
}

/** Exact `numeric(14,2)` text. Null when the value is negative, too fine, or too large. */
export function moneyWire(value: Dec): string | null {
  if (isNegative(value) || value.scale > 2) return null;
  const expanded = value.int * 10n ** BigInt(2 - value.scale);
  const text = expanded.toString().padStart(3, '0');
  const whole = text.slice(0, -2).replace(/^0+(?=\d)/, '') || '0';
  if (whole.length > 12) return null;
  return `${whole}.${text.slice(-2)}`;
}

export function formatMoneyText(value: string): string {
  if (!/^\d+(\.\d+)?$/.test(value)) return `${value} ج.م`;
  const parts = value.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  if (fraction.length <= 2) {
    return `${whole}.${fraction.padEnd(2, '0')} ج.م`;
  }
  return `${whole}.${fraction} ج.م`;
}
