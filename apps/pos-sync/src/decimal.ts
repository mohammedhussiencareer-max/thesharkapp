export type Decimal = {
  sign: 1 | -1;
  digits: string;
  scale: number;
};

export function parseDecimal(input: string): Decimal {
  const match = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(
    input.trim(),
  );
  if (!match) {
    throw new Error('invalid decimal');
  }
  const whole = match[2];
  if (whole === undefined) {
    throw new Error('invalid decimal');
  }
  const frac = match[3] ?? '';
  const expText = match[4];
  const exp = expText === undefined ? 0 : Number.parseInt(expText, 10);
  if (!Number.isInteger(exp)) {
    throw new Error('invalid decimal');
  }
  let digits = `${whole}${frac}`.replace(/^0+/, '') || '0';
  let scale = frac.length - exp;
  if (digits === '0') {
    return { sign: 1, digits: '0', scale: 0 };
  }
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  return { sign: match[1] === '-' ? -1 : 1, digits, scale };
}

export function decimalFromNumber(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('number must be finite');
  }
  return JSON.stringify(value);
}

function multiplyDigits(left: string, right: string): string {
  if (left === '0' || right === '0') {
    return '0';
  }
  const result = new Array<number>(left.length + right.length).fill(0);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    const leftDigit = left.charCodeAt(i) - 48;
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const pos = i + j + 1;
      const current = result[pos];
      if (current === undefined) {
        throw new Error('invalid decimal');
      }
      result[pos] = current + leftDigit * (right.charCodeAt(j) - 48);
    }
  }
  for (let k = result.length - 1; k > 0; k -= 1) {
    const current = result[k];
    const previous = result[k - 1];
    if (current === undefined || previous === undefined) {
      throw new Error('invalid decimal');
    }
    result[k] = current % 10;
    result[k - 1] = previous + Math.floor(current / 10);
  }
  return result.join('').replace(/^0+/, '') || '0';
}

export function multiplyDecimals(left: Decimal, right: Decimal): Decimal {
  if (left.digits === '0' || right.digits === '0') {
    return { sign: 1, digits: '0', scale: 0 };
  }
  return {
    sign: left.sign === right.sign ? 1 : -1,
    digits: multiplyDigits(left.digits, right.digits),
    scale: left.scale + right.scale,
  };
}

function incrementDigits(digits: string): string {
  const chars = digits.split('');
  let carry = 1;
  for (let i = chars.length - 1; i >= 0 && carry > 0; i -= 1) {
    const digit = chars[i];
    if (digit === undefined) {
      break;
    }
    const sum = digit.charCodeAt(0) - 48 + carry;
    chars[i] = String(sum % 10);
    carry = Math.floor(sum / 10);
  }
  return carry > 0 ? `1${chars.join('')}` : chars.join('');
}

function splitDecimal(value: Decimal): {
  intDigits: string;
  fracDigits: string;
} {
  if (value.scale <= 0) {
    return { intDigits: value.digits, fracDigits: '' };
  }
  if (value.digits.length <= value.scale) {
    return {
      intDigits: '0',
      fracDigits: value.digits.padStart(value.scale, '0'),
    };
  }
  return {
    intDigits: value.digits.slice(0, value.digits.length - value.scale),
    fracDigits: value.digits.slice(value.digits.length - value.scale),
  };
}

/** Half away from zero, matching PostgreSQL numeric round. */
export function roundDecimal(value: Decimal, places: number): Decimal {
  if (!Number.isInteger(places) || places < 0) {
    throw new Error('invalid decimal places');
  }
  if (value.digits === '0') {
    return { sign: 1, digits: '0', scale: 0 };
  }
  const { intDigits, fracDigits } = splitDecimal(value);
  if (fracDigits.length <= places) {
    return value;
  }
  const keptFrac = fracDigits.slice(0, places);
  const next = fracDigits[places] ?? '0';
  const combined = `${intDigits}${keptFrac}`.replace(/^0+/, '') || '0';
  if (next < '5') {
    if (combined === '0') {
      return { sign: 1, digits: '0', scale: 0 };
    }
    return { sign: value.sign, digits: combined, scale: places };
  }
  return { sign: value.sign, digits: incrementDigits(combined), scale: places };
}

export function formatDecimal(
  value: Decimal,
  places: number,
  trim: boolean,
): string {
  const rounded = roundDecimal(value, places);
  if (rounded.digits === '0') {
    return trim || places === 0 ? '0' : `0.${'0'.repeat(places)}`;
  }
  const parts = splitDecimal(rounded);
  const frac = trim
    ? parts.fracDigits.replace(/0+$/, '')
    : parts.fracDigits.padEnd(places, '0');
  const intPart = parts.intDigits.replace(/^0+/, '') || '0';
  const text = frac.length > 0 ? `${intPart}.${frac}` : intPart;
  return rounded.sign < 0 ? `-${text}` : text;
}

export function moneyText(raw: string): string {
  return formatDecimal(parseDecimal(raw), 2, false);
}

export function qtyText(raw: string): string {
  return formatDecimal(parseDecimal(raw), 6, true);
}

export function moneyFromNumber(value: number): string {
  return moneyText(decimalFromNumber(value));
}

export function quantityFromNumber(value: number): string {
  return qtyText(decimalFromNumber(value));
}

export function fixedLineTotal(rawPrice: string, rawQuantity: string): string {
  return formatDecimal(
    multiplyDecimals(parseDecimal(rawPrice), parseDecimal(rawQuantity)),
    2,
    false,
  );
}
