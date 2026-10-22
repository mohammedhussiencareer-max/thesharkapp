import {
  divRound,
  formatDec,
  moneyWire,
  mulRound,
  type Dec,
} from '@/purchases/decimal';

export type CountPreviewLine = {
  itemId: string;
  deltaQty: string;
  /** Signed piaster text, or 0.00 when the delta is zero. */
  deltaValue: string;
  surplus: boolean;
};

/**
 * What the screen shows before the save. Money follows the ledger:
 * a surplus is round(delta × average, 2); a partial shortage is
 * −round(book value × out qty / on hand, 2); clearing the on-hand
 * takes the whole book value. Cost-adjustment rows are not included.
 */
export type CountPreview = {
  lines: CountPreviewLine[];
  shortageValue: string;
  surplusValue: string;
  hasSurplus: boolean;
};

const zero: Dec = { neg: false, int: 0n, scale: 2 };

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

function positive(value: Dec): Dec {
  return { neg: false, int: value.int, scale: value.scale };
}

function moneyText(value: Dec): string | null {
  const wire = moneyWire(positive(value));
  if (!wire) return null;
  return value.neg ? `-${wire}` : wire;
}

function atScale2(value: Dec, negate: boolean): Dec | null {
  if (value.scale > 2) return null;
  const int = value.int * 10n ** BigInt(2 - value.scale);
  return { neg: negate && int !== 0n, int, scale: 2 };
}

function adjustmentValue(
  counted: Dec,
  onHand: Dec,
  onHandValue: Dec,
  avg: Dec,
): Dec | null {
  const delta = sub(counted, onHand);
  if (delta.int === 0n) return { neg: false, int: 0n, scale: 2 };
  if (!delta.neg) return mulRound(positive(delta), avg, 2);
  const out = positive(delta);
  if (onHand.int === 0n || cmp(out, onHand) > 0) return null;
  if (cmp(out, onHand) === 0) return atScale2(onHandValue, true);
  const share = divRound(mul(positive(onHandValue), out), onHand, 2);
  if (!share || share.neg) return null;
  return { neg: share.int !== 0n, int: share.int, scale: 2 };
}

export function previewCount(
  lines: readonly {
    itemId: string;
    counted: Dec;
    onHand: Dec;
    onHandValue: Dec;
    avg: Dec;
  }[],
): CountPreview | null {
  const priced: {
    itemId: string;
    delta: Dec;
    value: Dec;
    surplus: boolean;
  }[] = [];
  let shortage = { ...zero };
  let surplusValue = { ...zero };
  let hasSurplus = false;

  for (const line of lines) {
    const delta = sub(line.counted, line.onHand);
    const value = adjustmentValue(
      line.counted,
      line.onHand,
      line.onHandValue,
      line.avg,
    );
    if (!value) return null;
    const surplus = !delta.neg && delta.int !== 0n;
    if (surplus) {
      hasSurplus = true;
      surplusValue = add(surplusValue, positive(value));
    } else if (value.neg) {
      shortage = add(shortage, positive(value));
    }
    priced.push({ itemId: line.itemId, delta, value, surplus });
  }

  const shortageText = moneyText(shortage);
  const surplusText = moneyText(surplusValue);
  if (!shortageText || !surplusText) return null;

  const previewLines: CountPreviewLine[] = [];
  for (const line of priced) {
    const deltaValue = moneyText(line.value);
    if (!deltaValue) return null;
    previewLines.push({
      itemId: line.itemId,
      deltaQty: formatDec(line.delta),
      deltaValue,
      surplus: line.surplus,
    });
  }

  return {
    lines: previewLines,
    shortageValue: shortageText,
    surplusValue: surplusText,
    hasSurplus,
  };
}
