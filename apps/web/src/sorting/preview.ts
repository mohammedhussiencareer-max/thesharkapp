import {
  divRound,
  formatDec,
  integerDigits,
  isNegative,
  isZero,
  moneyWire,
  mulRound,
  type Dec,
} from '@/purchases/decimal';

export type PreviewLine = {
  itemId: string;
  quantity: string;
  value: string;
};

/**
 * What the screen shows before the save. Money follows app.post_sort:
 * the book value taken from the mixed item, loss first, then each size,
 * with the last size keeping the remaining piasters. apply_outflow_movement
 * stores those amounts through its cost override and does not price them again.
 * costPerKg is the mixed item's current average, which sort_out records.
 *
 * A batch post_sort refuses (sizes above the take, or no positive balance
 * to split) has no posted money. Those rows show quantity × the average.
 */
export type SortPreview = {
  sizesQty: string;
  lossQty: string | null;
  lossValue: string | null;
  costPerKg: string;
  lines: PreviewLine[];
  sizesExceed: boolean;
};

const zero = { neg: false, int: 0n, scale: 0 } as const;

function signed(value: Dec, scale: number): bigint {
  const magnitude = value.int * 10n ** BigInt(scale - value.scale);
  return value.neg ? -magnitude : magnitude;
}

function fromSigned(int: bigint, scale: number): Dec {
  const neg = int < 0n;
  return { neg, int: neg ? -int : int, scale };
}

function add(left: Dec, right: Dec): Dec {
  const scale = Math.max(left.scale, right.scale);
  return fromSigned(signed(left, scale) + signed(right, scale), scale);
}

function sub(left: Dec, right: Dec): Dec {
  const scale = Math.max(left.scale, right.scale);
  return fromSigned(signed(left, scale) - signed(right, scale), scale);
}

function cmp(left: Dec, right: Dec): number {
  const scale = Math.max(left.scale, right.scale);
  const diff = signed(left, scale) - signed(right, scale);
  if (diff === 0n) return 0;
  return diff > 0n ? 1 : -1;
}

function mul(left: Dec, right: Dec): Dec {
  const neg = left.neg !== right.neg && left.int !== 0n && right.int !== 0n;
  return { neg, int: left.int * right.int, scale: left.scale + right.scale };
}

function moneyText(value: Dec): string | null {
  if (isNegative(value) || value.scale > 2 || integerDigits(value) > 12) {
    return null;
  }
  return moneyWire(value);
}

function atAverage(quantity: Dec, avg: Dec): string | null {
  if (isNegative(quantity) || isNegative(avg)) return null;
  const share = mulRound(quantity, avg, 2);
  if (isNegative(share) || integerDigits(share) > 12) return null;
  return moneyWire(share);
}

/** round(remaining_value * share_qty / remaining_qty, 2), clamped to the remainder. */
function roundedShare(
  remainingValue: Dec,
  shareQty: Dec,
  remainingQty: Dec,
): Dec | null {
  const portion = divRound(mul(remainingValue, shareQty), remainingQty, 2);
  if (!portion) return null;
  if (isNegative(portion) || isZero(portion)) {
    return { neg: false, int: 0n, scale: 2 };
  }
  if (cmp(portion, remainingValue) > 0) return remainingValue;
  return portion;
}

function bookValue(input: {
  qtyTaken: Dec;
  onHandQty: Dec;
  onHandValue: Dec;
}): Dec | null {
  if (
    isNegative(input.onHandQty) ||
    isZero(input.onHandQty) ||
    isNegative(input.onHandValue) ||
    input.onHandValue.scale > 2 ||
    integerDigits(input.onHandValue) > 12 ||
    cmp(input.qtyTaken, input.onHandQty) > 0
  ) {
    return null;
  }
  if (cmp(input.qtyTaken, input.onHandQty) === 0) return input.onHandValue;
  return divRound(mul(input.onHandValue, input.qtyTaken), input.onHandQty, 2);
}

export function previewSort(input: {
  qtyTaken: Dec;
  avgCost: Dec;
  onHandQty: Dec;
  onHandValue: Dec;
  lines: readonly { itemId: string; quantity: Dec }[];
}): SortPreview | null {
  if (
    isNegative(input.qtyTaken) ||
    isNegative(input.avgCost) ||
    isNegative(input.onHandQty) ||
    isNegative(input.onHandValue)
  ) {
    return null;
  }
  let sizes: Dec = zero;
  for (const line of input.lines) {
    if (isNegative(line.quantity)) return null;
    sizes = add(sizes, line.quantity);
  }
  const sizesExceed = cmp(sizes, input.qtyTaken) > 0;
  const loss = sizesExceed ? null : sub(input.qtyTaken, sizes);
  const taken = sizesExceed || !loss ? null : bookValue(input);

  if (!taken || !loss) {
    const priced: PreviewLine[] = [];
    for (const line of input.lines) {
      const value = atAverage(line.quantity, input.avgCost);
      if (!value) return null;
      priced.push({
        itemId: line.itemId,
        quantity: formatDec(line.quantity),
        value,
      });
    }
    const lossValue = loss ? atAverage(loss, input.avgCost) : null;
    if (loss && !lossValue) return null;
    return {
      sizesQty: formatDec(sizes),
      lossQty: loss ? formatDec(loss) : null,
      lossValue,
      costPerKg: formatDec(input.avgCost),
      lines: priced,
      sizesExceed,
    };
  }

  let remainingValue = taken;
  let remainingQty = input.qtyTaken;
  let lossValue = moneyText({ neg: false, int: 0n, scale: 2 });
  if (cmp(loss, zero) > 0) {
    const share = roundedShare(remainingValue, loss, remainingQty);
    if (!share) return null;
    const text = moneyText(share);
    if (!text) return null;
    lossValue = text;
    remainingValue = sub(remainingValue, share);
    remainingQty = sub(remainingQty, loss);
  }
  if (!lossValue) return null;

  const priced: PreviewLine[] = [];
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index];
    if (!line) return null;
    const last = index === input.lines.length - 1;
    const share = last
      ? remainingValue
      : roundedShare(remainingValue, line.quantity, remainingQty);
    if (!share) return null;
    const value = moneyText(share);
    if (!value) return null;
    priced.push({
      itemId: line.itemId,
      quantity: formatDec(line.quantity),
      value,
    });
    remainingValue = sub(remainingValue, share);
    remainingQty = sub(remainingQty, line.quantity);
  }

  return {
    sizesQty: formatDec(sizes),
    lossQty: formatDec(loss),
    lossValue,
    costPerKg: formatDec(input.avgCost),
    lines: priced,
    sizesExceed: false,
  };
}
