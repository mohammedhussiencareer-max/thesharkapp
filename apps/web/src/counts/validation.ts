import { hasLongDigitRun } from '@/expenses/amount';
import {
  formatDec,
  integerDigits,
  isNegative,
  parseUserDecimal,
  type Dec,
} from '@/purchases/decimal';
import {
  missingCairoTimeMessage,
  parseCairoDateTimeLocal,
} from '@/purchases/time';
import {
  atLeastOneMessage,
  badBalanceMessage,
  duplicateItemMessage,
  noteLengthMessage,
  phoneMessage,
  quantityInvalidMessage,
  quantityNegativeMessage,
  quantityRangeMessage,
  quantityScaleMessage,
  timeInvalidMessage,
  timeRequiredMessage,
  tooManyMessage,
} from '@/counts/errors';
import { previewCount, type CountPreview } from '@/counts/preview';
import type { CountDraft, CountItem, CountValues } from '@/counts/types';

export type CountErrors = {
  form?: string;
  countedAt?: string;
  note?: string;
  quantities: Record<string, string>;
};

export type CountAssessment = {
  preview: CountPreview | null;
  errors: CountErrors;
  draft: Omit<CountDraft, 'requestId'> | null;
};

type PricedLine = {
  itemId: string;
  counted: Dec;
  onHand: Dec;
  onHandValue: Dec;
  avg: Dec;
};

function emptyErrors(): CountErrors {
  return { quantities: {} };
}

function storedDecimal(raw: string): Dec | null {
  const parsed = parseUserDecimal(raw);
  if (!parsed || isNegative(parsed)) return null;
  if (parsed.scale > 6 || integerDigits(parsed) > 14) return null;
  return parsed;
}

function parseCounted(
  raw: string,
):
  | { ok: true; blank: true }
  | { ok: true; blank: false; value: Dec }
  | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, blank: true };
  const parsed = parseUserDecimal(raw);
  if (!parsed) return { ok: false, error: quantityInvalidMessage };
  if (isNegative(parsed)) return { ok: false, error: quantityNegativeMessage };
  if (parsed.scale > 6) return { ok: false, error: quantityScaleMessage };
  if (integerDigits(parsed) > 14) {
    return { ok: false, error: quantityRangeMessage };
  }
  return { ok: true, blank: false, value: parsed };
}

function balanceOf(
  item: CountItem,
): { onHand: Dec; onHandValue: Dec; avg: Dec } | null {
  const onHand = storedDecimal(item.onHandQty);
  const onHandValue = storedDecimal(item.onHandValue);
  const avg = storedDecimal(item.avgCost);
  if (!onHand || !onHandValue || !avg) return null;
  if (onHandValue.scale > 2 || integerDigits(onHandValue) > 12) return null;
  return { onHand, onHandValue, avg };
}

export function assessCount(
  values: CountValues,
  catalog: readonly CountItem[],
): CountAssessment {
  const errors = emptyErrors();
  let occurredAt: string | null = null;
  if (values.countedAt.trim() === '') {
    errors.countedAt = timeRequiredMessage;
  } else {
    const parsed = parseCairoDateTimeLocal(values.countedAt);
    if (!parsed.ok) {
      errors.countedAt =
        parsed.reason === 'missing'
          ? missingCairoTimeMessage
          : timeInvalidMessage;
    } else {
      occurredAt = parsed.iso;
    }
  }

  const note = values.note.trim();
  if (note.length > 500) errors.note = noteLengthMessage;
  else if (hasLongDigitRun(note)) errors.note = phoneMessage;

  const priced: PricedLine[] = [];
  const seen = new Set<string>();
  let qtyFailed = false;
  let balanceFailed = false;
  for (const item of catalog) {
    const raw = values.quantities[item.id] ?? '';
    const parsed = parseCounted(raw);
    if (!parsed.ok) {
      errors.quantities[item.id] = parsed.error;
      qtyFailed = true;
      continue;
    }
    if (parsed.blank) continue;
    if (seen.has(item.id)) {
      errors.quantities[item.id] = duplicateItemMessage;
      qtyFailed = true;
      continue;
    }
    seen.add(item.id);
    const balance = balanceOf(item);
    if (!balance) {
      errors.form = badBalanceMessage;
      balanceFailed = true;
      continue;
    }
    priced.push({
      itemId: item.id,
      counted: parsed.value,
      onHand: balance.onHand,
      onHandValue: balance.onHandValue,
      avg: balance.avg,
    });
  }

  if (!qtyFailed && !balanceFailed && priced.length === 0) {
    errors.form = atLeastOneMessage;
  } else if (!qtyFailed && !balanceFailed && priced.length > 200) {
    errors.form = tooManyMessage;
  }

  const preview =
    !qtyFailed && !balanceFailed && priced.length > 0
      ? previewCount(priced)
      : null;
  if (
    !qtyFailed &&
    !balanceFailed &&
    priced.length > 0 &&
    !preview &&
    !errors.form
  ) {
    errors.form = quantityRangeMessage;
  }

  const failed =
    errors.form !== undefined ||
    errors.countedAt !== undefined ||
    errors.note !== undefined ||
    qtyFailed ||
    balanceFailed;

  if (failed || !occurredAt || priced.length === 0 || priced.length > 200) {
    return { preview, errors, draft: null };
  }

  return {
    preview,
    errors,
    draft: {
      countedAt: occurredAt,
      note: note.length > 0 ? note : null,
      lines: priced.map((line) => ({
        itemId: line.itemId,
        countedQty: formatDec(line.counted),
      })),
    },
  };
}
