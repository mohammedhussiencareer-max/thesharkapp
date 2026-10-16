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

function decimalText(raw: string): string | null {
  const trimmed = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  return trimmed;
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
  const trimmed = decimalText(raw);
  if (trimmed === null || fractionScale(trimmed) > 5) return null;
  const percent = Number(trimmed);
  if (!Number.isFinite(percent) || percent < 0 || percent > 99.999) return null;
  return percent;
}

function lossPercentMessage(raw: string): string | null {
  const trimmed = decimalText(raw);
  if (trimmed === null) return lossRangeMessage;
  const percent = Number(trimmed);
  if (!Number.isFinite(percent) || percent < 0 || percent > 99.999) {
    return lossRangeMessage;
  }
  if (fractionScale(trimmed) > 5) return lossPrecisionMessage;
  return null;
}

export function lossPercentToFraction(percent: number): number {
  return Math.round(percent * 1000) / 100000;
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
  const percent =
    lossMessage === null ? parseLossPercent(values.lossPercent) : null;
  const lossPct = percent === null ? null : lossPercentToFraction(percent);
  if (lossMessage !== null || lossPct === null || lossPct >= 1) {
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
): { ok: true; unit: string; factor: number } | { ok: false; error: string } {
  const unit = unitRaw.trim();
  if (unit.length === 0) return { ok: false, error: 'اكتب اسم الوحدة' };
  if (unit === baseUnit) {
    return { ok: false, error: 'مينفعش التحويل يبقى بنفس الوحدة الأساسية' };
  }

  const factorText = decimalText(factorRaw);
  if (factorText === null) {
    return { ok: false, error: factorPositiveMessage };
  }
  const parts = factorText.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  const integerDigits = whole.replace(/^0+/, '');
  if (integerDigits.length > 9) {
    return { ok: false, error: factorIntegerDigitsMessage };
  }
  if (fraction.replace(/0+$/, '').length > 9) {
    return { ok: false, error: factorDecimalDigitsMessage };
  }
  const factor = Number(factorText);
  if (!Number.isFinite(factor) || factor <= 0) {
    return { ok: false, error: factorPositiveMessage };
  }
  return { ok: true, unit, factor };
}
