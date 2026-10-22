import { hasLongDigitRun } from '@/expenses/amount';
import {
  formatDec,
  integerDigits,
  isNegative,
  isZero,
  parseUserDecimal,
  type Dec,
} from '@/purchases/decimal';
import {
  missingCairoTimeMessage,
  parseCairoDateTimeLocal,
} from '@/purchases/time';
import {
  atLeastOneSizeMessage,
  badCostMessage,
  mixedRequiredMessage,
  notEnoughStockMessage,
  noteLengthMessage,
  phoneMessage,
  quantityInvalidMessage,
  quantityPositiveMessage,
  quantityRangeMessage,
  quantityScaleMessage,
  sizesExceedMessage,
  takenRequiredMessage,
  timeInvalidMessage,
  timeRequiredMessage,
  tooManySizesMessage,
} from '@/sorting/errors';
import { previewSort, type SortPreview } from '@/sorting/preview';
import type { MixedFish, SortDraft, SortValues } from '@/sorting/types';

export type SortErrors = {
  form?: string;
  occurredAt?: string;
  mixedItemId?: string;
  qtyTaken?: string;
  note?: string;
  quantities: Record<string, string>;
};

export type SortBlockers = {
  qtyTaken?: string;
  form?: string;
};

export type SortAssessment = {
  preview: SortPreview | null;
  blockers: SortBlockers;
  errors: SortErrors;
  draft: Omit<SortDraft, 'requestId'> | null;
};

type ParsedSize = { itemId: string; quantity: Dec };

function emptyErrors(): SortErrors {
  return { quantities: {} };
}

function storedDecimal(raw: string): Dec | null {
  const parsed = parseUserDecimal(raw);
  if (!parsed || parsed.scale > 6 || integerDigits(parsed) > 14) return null;
  return parsed;
}

function parseTaken(
  raw: string,
): { ok: true; value: Dec } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: false, error: takenRequiredMessage };
  const parsed = parseUserDecimal(raw);
  if (!parsed) return { ok: false, error: quantityInvalidMessage };
  if (isNegative(parsed) || isZero(parsed)) {
    return { ok: false, error: quantityPositiveMessage };
  }
  if (parsed.scale > 6) return { ok: false, error: quantityScaleMessage };
  if (integerDigits(parsed) > 14) {
    return { ok: false, error: quantityRangeMessage };
  }
  return { ok: true, value: parsed };
}

function parseSize(
  raw: string,
):
  | { ok: true; blank: true }
  | { ok: true; blank: false; value: Dec }
  | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, blank: true };
  const parsed = parseTaken(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, blank: false, value: parsed.value };
}

export function assessSort(
  values: SortValues,
  catalog: readonly MixedFish[],
): SortAssessment {
  const errors = emptyErrors();
  const item = catalog.find((candidate) => candidate.id === values.mixedItemId);
  if (!item) errors.mixedItemId = mixedRequiredMessage;

  let occurredAt: string | null = null;
  if (values.occurredAt.trim() === '') {
    errors.occurredAt = timeRequiredMessage;
  } else {
    const parsed = parseCairoDateTimeLocal(values.occurredAt);
    if (!parsed.ok) {
      errors.occurredAt =
        parsed.reason === 'missing'
          ? missingCairoTimeMessage
          : timeInvalidMessage;
    } else {
      occurredAt = parsed.iso;
    }
  }

  const taken = parseTaken(values.qtyTaken);
  if (!taken.ok) errors.qtyTaken = taken.error;

  const note = values.note.trim();
  if (note.length > 500) errors.note = noteLengthMessage;
  else if (hasLongDigitRun(note)) errors.note = phoneMessage;

  const sizes = item?.sizes ?? [];
  const parsedSizes: ParsedSize[] = [];
  let sizeFailed = false;
  for (const size of sizes) {
    const raw = values.quantities[size.id] ?? '';
    const parsed = parseSize(raw);
    if (!parsed.ok) {
      errors.quantities[size.id] = parsed.error;
      sizeFailed = true;
      continue;
    }
    if (!parsed.blank) {
      parsedSizes.push({ itemId: size.id, quantity: parsed.value });
    }
  }

  let avg: Dec | null = null;
  let onHand: Dec | null = null;
  if (item) {
    avg = storedDecimal(item.avgCost);
    onHand = storedDecimal(item.onHandQty);
    if (!avg || isNegative(avg) || !onHand) errors.form = badCostMessage;
  }

  const preview =
    taken.ok && !sizeFailed && avg && !isNegative(avg)
      ? previewSort({
          qtyTaken: taken.value,
          avgCost: avg,
          lines: parsedSizes,
        })
      : null;
  if (taken.ok && !sizeFailed && avg && !preview && !errors.form) {
    errors.form = quantityRangeMessage;
  }

  const blockers: SortBlockers = {};
  if (
    item &&
    taken.ok &&
    onHand &&
    (item.hasUncoveredDeficit ||
      isNegative(onHand) ||
      isZero(onHand) ||
      compareTaken(taken.value, onHand) > 0)
  ) {
    blockers.qtyTaken = notEnoughStockMessage;
    errors.qtyTaken = notEnoughStockMessage;
  }
  if (preview?.sizesExceed) {
    blockers.form = sizesExceedMessage;
    errors.form = sizesExceedMessage;
  } else if (item && taken.ok && !sizeFailed && parsedSizes.length === 0) {
    errors.form = atLeastOneSizeMessage;
  }
  if (parsedSizes.length > 20) errors.form = tooManySizesMessage;

  const failed =
    errors.form !== undefined ||
    errors.occurredAt !== undefined ||
    errors.mixedItemId !== undefined ||
    errors.qtyTaken !== undefined ||
    errors.note !== undefined ||
    sizeFailed;

  if (failed || !item || !occurredAt || !taken.ok) {
    return { preview, blockers, errors, draft: null };
  }

  return {
    preview,
    blockers,
    errors,
    draft: {
      mixedItemId: item.id,
      occurredAt,
      qtyTaken: formatDec(taken.value),
      note: note.length > 0 ? note : null,
      lines: parsedSizes.map((line) => ({
        itemId: line.itemId,
        quantity: formatDec(line.quantity),
      })),
    },
  };
}

function compareTaken(taken: Dec, onHand: Dec): number {
  const scale = Math.max(taken.scale, onHand.scale);
  const left = taken.int * 10n ** BigInt(scale - taken.scale);
  const right =
    (onHand.neg ? -onHand.int : onHand.int) *
    10n ** BigInt(scale - onHand.scale);
  if (left === right) return 0;
  return left > right ? 1 : -1;
}
