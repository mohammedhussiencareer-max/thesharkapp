import { defaultsForKind } from '@/items/labels';
import {
  isBaseUnit,
  isCountFrequency,
  isStockKind,
  type BaseUnit,
  type CatalogItem,
  type CountFrequency,
  type ItemDraft,
  type StockKind,
} from '@/items/types';

export type ItemFormValues = {
  name: string;
  kind: StockKind;
  baseUnit: BaseUnit;
  countFrequency: CountFrequency;
  lossPercent: string;
  parentItemId: string;
  active: boolean;
};

export type ItemField =
  | 'name'
  | 'kind'
  | 'baseUnit'
  | 'countFrequency'
  | 'lossPercent'
  | 'parentItemId';

export type ItemFormErrors = Partial<Record<ItemField, string>>;

const lossRangeMessage = 'نسبة الفاقد من 0 لحد 99.999';
const lossPrecisionMessage = 'نسبة الفاقد مينفعش تتخزن أدق من خمس خانات عشرية';
const factorPositiveMessage = 'معامل التحويل لازم يكون رقم أكبر من صفر';
const factorIntegerDigitsMessage =
  'معامل التحويل مينفعش يبقى فيه أكتر من 9 أرقام قبل العلامة';
const factorDecimalDigitsMessage =
  'معامل التحويل مينفعش يبقى فيه أكتر من 9 أرقام بعد العلامة';

export function emptyItemForm(): ItemFormValues {
  const defaults = defaultsForKind('fish_mixed');
  return {
    name: '',
    kind: 'fish_mixed',
    baseUnit: defaults.baseUnit,
    countFrequency: defaults.countFrequency,
    lossPercent: '0',
    parentItemId: '',
    active: true,
  };
}

export function fractionToLossPercentInput(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0';
  const percent = Math.round(fraction * 100000) / 1000;
  return String(percent);
}

export function itemToFormValues(item: CatalogItem): ItemFormValues {
  return {
    name: item.name,
    kind: item.kind,
    baseUnit: item.baseUnit,
    countFrequency: item.countFrequency,
    lossPercent: fractionToLossPercentInput(item.lossPct),
    parentItemId: item.parentItemId ?? '',
    active: item.active,
  };
}

/**
 * Trim, drop a leading `+`, and turn a comma into a dot.
 * Western digits only — the form does not accept Arabic-Indic digits.
 * No exponent notation. Leading integer zeros and trailing fraction zeros
 * are removed so the text is the exact value we can write.
 */
function normalizeDecimal(raw: string): string | null {
  let text = raw.trim().replace(',', '.');
  if (text.startsWith('+')) text = text.slice(1).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const parts = text.split('.');
  const whole = (parts[0] ?? '0').replace(/^0+/, '') || '0';
  const fraction = (parts[1] ?? '').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

function compareDecimal(left: string, right: string): number {
  const [leftWhole = '0', leftFraction = ''] = left.split('.');
  const [rightWhole = '0', rightFraction = ''] = right.split('.');
  if (leftWhole.length !== rightWhole.length) {
    return leftWhole.length - rightWhole.length;
  }
  if (leftWhole !== rightWhole) return leftWhole < rightWhole ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftPadded = leftFraction.padEnd(width, '0');
  const rightPadded = rightFraction.padEnd(width, '0');
  if (leftPadded === rightPadded) return 0;
  return leftPadded < rightPadded ? -1 : 1;
}

/** Move the decimal point left by shifting digits, not by dividing a float. */
function shiftDecimalLeft(text: string, places: number): string {
  const parts = text.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  const digits = whole === '0' ? fraction : `${whole}${fraction}`;
  const scale = fraction.length + places;
  if (digits.length <= scale) {
    const padded = digits.padStart(scale, '0').replace(/0+$/, '');
    return padded.length > 0 ? `0.${padded}` : '0';
  }
  const splitAt = digits.length - scale;
  const integer = digits.slice(0, splitAt).replace(/^0+/, '') || '0';
  const rest = digits.slice(splitAt).replace(/0+$/, '');
  return rest.length > 0 ? `${integer}.${rest}` : integer;
}

/** Decimal places of `percent / 100` after trailing zeros are removed. */
function fractionScale(percentText: string): number {
  const parts = percentText.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  let digits = `${whole}${fraction}`;
  let scale = fraction.length + 2;
  while (scale > 0 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    scale -= 1;
  }
  return scale;
}

export function parseLossPercent(raw: string): number | null {
  const trimmed = normalizeDecimal(raw);
  if (
    trimmed === null ||
    fractionScale(trimmed) > 5 ||
    compareDecimal(trimmed, '99.999') > 0
  ) {
    return null;
  }
  return Number(trimmed);
}

function lossPercentMessage(raw: string): string | null {
  const trimmed = normalizeDecimal(raw);
  if (trimmed === null || compareDecimal(trimmed, '99.999') > 0) {
    return lossRangeMessage;
  }
  if (fractionScale(trimmed) > 5) return lossPrecisionMessage;
  return null;
}

/** Percent text to `loss_pct` text. "12.5" → "0.125", "0.001" → "0.00001". */
export function lossPercentToFraction(percentText: string): string {
  const trimmed = normalizeDecimal(percentText);
  if (trimmed === null) return '0';
  return shiftDecimalLeft(trimmed, 2);
}

export function validateItemForm(
  values: ItemFormValues,
  context: {
    items: readonly Pick<CatalogItem, 'id' | 'kind' | 'parentItemId'>[];
    editingId?: string;
  },
): { ok: true; draft: ItemDraft } | { ok: false; errors: ItemFormErrors } {
  const errors: ItemFormErrors = {};
  const name = values.name.trim();
  if (name.length === 0) errors.name = 'اكتب اسم الصنف';

  if (!isStockKind(values.kind)) errors.kind = 'نوع الصنف مش مظبوط';
  if (!isBaseUnit(values.baseUnit)) {
    errors.baseUnit = 'الوحدة الأساسية مش مظبوطة';
  }
  if (!isCountFrequency(values.countFrequency)) {
    errors.countFrequency = 'دورية الجرد مش مظبوطة';
  }

  const lossMessage = lossPercentMessage(values.lossPercent);
  const lossPct =
    lossMessage === null ? lossPercentToFraction(values.lossPercent) : null;
  const lossWhole = lossPct?.split('.')[0] ?? '1';
  if (lossMessage !== null || lossPct === null || lossWhole !== '0') {
    errors.lossPercent = lossMessage ?? lossRangeMessage;
  }

  const fishMixedIds = new Set(
    context.items
      .filter((item) => item.kind === 'fish_mixed')
      .map((item) => item.id),
  );

  let parentItemId: string | null = null;
  if (values.kind === 'fish_size') {
    parentItemId = values.parentItemId;
    if (parentItemId === '') {
      errors.parentItemId = 'اختار السمك المخلوط';
    } else if (
      parentItemId === context.editingId ||
      !fishMixedIds.has(parentItemId)
    ) {
      errors.parentItemId = 'حجم السمك لازم يتسجل تحت سمك مخلوط';
    }
  }

  const current = context.items.find((item) => item.id === context.editingId);
  const hasSizes =
    context.editingId !== undefined &&
    context.items.some((item) => item.parentItemId === context.editingId);
  if (
    current?.kind === 'fish_mixed' &&
    values.kind !== 'fish_mixed' &&
    hasSizes
  ) {
    errors.kind = 'مينفعش تغيّر نوع السمك المخلوط وعنده أحجام';
  }

  if (Object.keys(errors).length > 0 || lossPct === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    draft: {
      name,
      kind: values.kind,
      baseUnit: values.baseUnit,
      countFrequency: values.countFrequency,
      lossPct,
      parentItemId,
      active: values.active,
    },
  };
}

export function validateConversion(
  unitRaw: string,
  factorRaw: string,
  baseUnit: BaseUnit,
): { ok: true; unit: string; factor: string } | { ok: false; error: string } {
  const unit = unitRaw.trim();
  if (unit.length === 0) return { ok: false, error: 'اكتب اسم الوحدة' };
  if (unit === baseUnit) {
    return { ok: false, error: 'مينفعش التحويل يبقى بنفس الوحدة الأساسية' };
  }

  const factorText = normalizeDecimal(factorRaw);
  if (factorText === null) {
    return { ok: false, error: factorPositiveMessage };
  }
  const parts = factorText.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  if (whole.length > 9) {
    return { ok: false, error: factorIntegerDigitsMessage };
  }
  if (fraction.length > 9) {
    return { ok: false, error: factorDecimalDigitsMessage };
  }
  if (factorText === '0') {
    return { ok: false, error: factorPositiveMessage };
  }
  return { ok: true, unit, factor: factorText };
}
