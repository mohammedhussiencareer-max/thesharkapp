import { exactDecimal } from '@/lib/decimal';

const invalidMoney = 'مبلغ غير صالح';

/** Piasters as an integer. Two decimal places only; no binary float. */
export function toPiasters(value: string): bigint {
  const text = exactDecimal(value, invalidMoney);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > 2) throw new Error(invalidMoney);
  const piasters =
    BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -piasters : piasters;
}

export function formatPiasters(piasters: bigint): string {
  const negative = piasters < 0n;
  const abs = negative ? -piasters : piasters;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const text = `${whole.toString()}.${fraction}`;
  return negative ? `-${text}` : text;
}

export function addMoney(left: string, right: string): string {
  return formatPiasters(toPiasters(left) + toPiasters(right));
}

export function formatEgpText(value: string): string {
  return `${formatPiasters(toPiasters(value))} ج.م`;
}

/** True when the absolute amount is at most `limitPiasters`. */
export function moneyAbsAtMost(value: string, limitPiasters: bigint): boolean {
  const piasters = toPiasters(value);
  const abs = piasters < 0n ? -piasters : piasters;
  return abs <= limitPiasters;
}
