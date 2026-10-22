import {
  formatDec,
  integerDigits,
  isNegative,
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
 * What the screen shows before the save.
 * Each share is quantity × the current average, rounded to the piaster on its
 * own. The posted batch can differ by a piaster: app.post_sort splits the book
 * value and gives the last size whatever is left. The history row shows the
 * posted figures, not this preview.
 */
export type SortPreview = {
  sizesQty: string;
  lossQty: string | null;
  lossValue: string | null;
  costPerKg: string;
  lines: PreviewLine[];
  sizesExceed: boolean;
};

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

function moneyOf(quantity: Dec, avg: Dec): string | null {
  if (isNegative(quantity) || isNegative(avg)) return null;
  const share = mulRound(quantity, avg, 2);
  if (isNegative(share) || integerDigits(share) > 12) return null;
  return moneyWire(share);
}

export function previewSort(input: {
  qtyTaken: Dec;
  avgCost: Dec;
  lines: readonly { itemId: string; quantity: Dec }[];
}): SortPreview | null {
  if (isNegative(input.qtyTaken) || isNegative(input.avgCost)) return null;
  let sizes = fromSigned(0n, 0);
  const priced: PreviewLine[] = [];
  for (const line of input.lines) {
    sizes = add(sizes, line.quantity);
    const value = moneyOf(line.quantity, input.avgCost);
    if (!value) return null;
    priced.push({
      itemId: line.itemId,
      quantity: formatDec(line.quantity),
      value,
    });
  }
  const sizesExceed = cmp(sizes, input.qtyTaken) > 0;
  if (sizesExceed) {
    return {
      sizesQty: formatDec(sizes),
      lossQty: null,
      lossValue: null,
      costPerKg: formatDec(input.avgCost),
      lines: priced,
      sizesExceed: true,
    };
  }
  const loss = sub(input.qtyTaken, sizes);
  const lossValue = moneyOf(loss, input.avgCost);
  if (!lossValue) return null;
  return {
    sizesQty: formatDec(sizes),
    lossQty: formatDec(loss),
    lossValue,
    costPerKg: formatDec(input.avgCost),
    lines: priced,
    sizesExceed: false,
  };
}
