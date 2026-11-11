import { unitLabels } from '@/items/labels';
import type { BaseUnit } from '@/items/types';
import { formatEgpText } from '@/lib/money';
import type {
  BasisItem,
  BasisStatus,
  Decision,
  DecisionClass,
  DecisionSource,
  ReturnedLine,
  ReviewReason,
} from '@/order-decisions/types';

export const classLabels: Record<DecisionClass, string> = {
  canceled: 'ملغي',
  missing: 'ناقص من الكاشير',
  full_refund: 'مرتجع كامل',
  partial_refund: 'مرتجع جزئي',
  unresolved_refund: 'مرتجع بمبلغ سالب',
  none: 'مفيش إلغاء ولا مرتجع',
};

export const decisionLabels: Record<Decision, string> = {
  made: 'اتعمل',
  not_made: 'ماتعملش',
};

export const sourceLabels: Record<DecisionSource, string> = {
  system_default: 'افتراضي من النظام',
  owner: 'قرارك',
};

export const reviewReasonLabels: Record<ReviewReason, string> = {
  refund_changed: 'المرتجعات اتغيّرت',
  class_changed: 'حالة الطلب اتغيّرت',
  items_changed: 'أصناف الطلب اتغيّرت',
  quantities_changed: 'كميات التحضير اتغيّرت',
  unresolved_refund: 'فيه مرتجع بمبلغ سالب',
};

export const basisStatusLabels: Record<BasisStatus, string> = {
  ready: 'جاهز',
  incomplete: 'ناقص',
  none: 'مفيش أساس تحضير',
};

/** One outstanding decision action per order. */
export function decisionSubject(orderId: string): string {
  return `order-decision:${JSON.stringify(orderId)}`;
}

export function unitText(baseUnit: string): string {
  return Object.prototype.hasOwnProperty.call(unitLabels, baseUnit)
    ? unitLabels[baseUnit as BaseUnit]
    : baseUnit;
}

/** Money text as EGP; a value that is not whole piasters is shown as it is. */
export function moneyText(value: string): string {
  try {
    return formatEgpText(value);
  } catch {
    return `${value} ج.م`;
  }
}

const decimalPattern = /^\d{1,14}(\.\d{1,6})?$/;

export const invalidReturnedMessage =
  'الكمية لازم تكون رقم من غير علامة، لحد 6 أرقام بعد العلامة';

export const returnedOverMessage = 'الكمية المرتجعة أكبر من المحضّر';

function scaled(value: string): { digits: bigint; scale: number } {
  const [whole = '0', fraction = ''] = value.split('.');
  return { digits: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** Exact comparison of two non-negative decimal texts: -1, 0 or 1. */
export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const a = scaled(left);
  const b = scaled(right);
  const scale = Math.max(a.scale, b.scale);
  const x = a.digits * 10n ** BigInt(scale - a.scale);
  const y = b.digits * 10n ** BigInt(scale - b.scale);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/** Decimal text without trailing zeros, for comparing and sending. */
export function trimDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

/** Null when the text is a valid returned quantity for the item. */
export function returnedError(text: string, prepared: string): string | null {
  const value = text.trim();
  if (value === '') return null;
  if (!decimalPattern.test(value)) return invalidReturnedMessage;
  if (compareDecimal(value, prepared) > 0) return returnedOverMessage;
  return null;
}

export type ReturnedDraft = Readonly<Record<string, string>>;

export function draftFromReturned(
  returned: readonly ReturnedLine[],
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const line of returned) draft[line.stockItemId] = line.returned;
  return draft;
}

/**
 * The cumulative returned quantities the form would send: one line for every
 * basis item, in item order, or the first problem. An empty field is a
 * confirmed zero and goes out as an explicit "0", so it is never mistaken for
 * the empty list that clears the confirmed quantities.
 */
export function returnedFromDraft(
  items: readonly BasisItem[],
  draft: ReturnedDraft,
):
  | { ok: true; lines: ReturnedLine[] }
  | { ok: false; errors: Record<string, string> } {
  const lines: ReturnedLine[] = [];
  const errors: Record<string, string> = {};
  for (const item of items) {
    const text = (draft[item.stockItemId] ?? '').trim();
    const problem = returnedError(text, item.quantity);
    if (problem) {
      errors[item.stockItemId] = problem;
      continue;
    }
    lines.push({
      stockItemId: item.stockItemId,
      returned: text === '' ? '0' : trimDecimal(text),
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, lines };
}

/** Prepared quantity less the returned one, as exact decimal text. */
export function keptQuantity(prepared: string, returned: string): string {
  const a = scaled(prepared);
  const b = scaled(returned);
  const scale = Math.max(a.scale, b.scale);
  const x = a.digits * 10n ** BigInt(scale - a.scale);
  const y = b.digits * 10n ** BigInt(scale - b.scale);
  const diff = x - y;
  if (diff < 0n) return '0';
  const digits = diff.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return trimDecimal(scale === 0 ? whole : `${whole}.${fraction}`);
}

/** Result of a saved decision, in plain Arabic. */
export function outcomeMessage(outcome: string, reason: string | null): string {
  if (outcome === 'blocked') {
    return 'اتسجل القرار، لكن الخصم موقوف لحد ما تكلفة الأصناف الناقصة تتسجل';
  }
  if (outcome === 'disposition_pending') {
    return 'اتسجل القرار، لكن الطلب لسه محتاج مراجعة تانية';
  }
  if (reason === 'missing_preparation_basis') {
    return 'اتسجل القرار، لكن مفيش أساس تحضير للطلب ده فمفيش خصم';
  }
  if (reason === 'not_made') {
    return 'اتسجل القرار: الطلب ماتعملش';
  }
  if (outcome === 'unchanged') {
    return 'اتسجل القرار، ومفيش تغيير في المخزون';
  }
  return 'اتسجل القرار';
}
