import { unitLabels } from '@/items/labels';
import { isBaseUnit, type BaseUnit } from '@/items/types';
import {
  divRound,
  formatDec,
  integerDigits,
  isNegative,
  isZero,
  moneyWire,
  mulRound,
  parseUserDecimal,
  type Dec,
} from '@/purchases/decimal';
import type {
  OpeningDraft,
  PurchaseDraft,
  PurchaseLineDraft,
  StockChoice,
  UnitOption,
} from '@/purchases/types';
import { cairoDateTimeLocalToIso } from '@/purchases/time';

const quantityScaleMessage = 'الكمية مينفعش تبقى أدق من 6 خانات';
const quantityRangeMessage = 'الكمية أكبر من اللازم';
const tinyQuantityMessage = 'الكمية أصغر من وحدة القياس';

export type OpeningField = 'quantity' | 'unitCost';

export type OpeningFieldErrors = Partial<
  Record<string, Partial<Record<OpeningField, string>>>
>;

export type OpeningValues = Record<
  string,
  { quantity: string; unit: string; unitCost: string }
>;

export type PurchaseLineValues = {
  key: string;
  itemId: string;
  quantity: string;
  unit: string;
  amount: string;
};

export type PurchaseValues = {
  purchasedAt: string;
  supplier: string;
  invoiceNo: string;
  note: string;
  lines: PurchaseLineValues[];
};

export type PurchaseErrors = {
  form?: string;
  purchasedAt?: string;
  supplier?: string;
  invoiceNo?: string;
  note?: string;
  lines: Record<
    string,
    Partial<Record<'itemId' | 'quantity' | 'unit' | 'amount', string>>
  >;
};

function factorFor(item: StockChoice, unit: string): string | null {
  if (unit === item.baseUnit) return '1';
  return (
    item.conversions.find((conversion) => conversion.unit === unit)
      ?.factorToBase ?? null
  );
}

function positiveQuantity(
  raw: string,
): { ok: true; value: Dec } | { ok: false; error: string } {
  const parsed = parseUserDecimal(raw);
  if (!parsed) return { ok: false, error: 'اكتب كمية صحيحة' };
  if (isNegative(parsed))
    return { ok: false, error: 'الكمية لازم تكون أكبر من صفر' };
  if (isZero(parsed))
    return { ok: false, error: 'الكمية لازم تكون أكبر من صفر' };
  if (parsed.scale > 6) return { ok: false, error: quantityScaleMessage };
  if (integerDigits(parsed) > 14)
    return { ok: false, error: quantityRangeMessage };
  return { ok: true, value: parsed };
}

function baseQuantityOf(
  quantity: Dec,
  factorText: string,
): { ok: true; text: string; value: Dec } | { ok: false; error: string } {
  const factor = parseUserDecimal(factorText);
  if (!factor || isNegative(factor) || isZero(factor)) {
    return { ok: false, error: 'الوحدة مش معرّفة للصنف' };
  }
  const base = mulRound(quantity, factor, 6);
  if (isZero(base)) return { ok: false, error: tinyQuantityMessage };
  if (integerDigits(base) > 14)
    return { ok: false, error: quantityRangeMessage };
  return { ok: true, text: formatDec(base), value: base };
}

export function unitChoices(item: StockChoice): UnitOption[] {
  return [
    { unit: item.baseUnit, factorToBase: '1' },
    ...item.conversions.filter(
      (conversion) => conversion.unit !== item.baseUnit,
    ),
  ];
}

export function previewPurchaseLine(
  line: Pick<PurchaseLineValues, 'itemId' | 'quantity' | 'unit' | 'amount'>,
  items: readonly StockChoice[],
): { baseQuantity: string; unitCost: string; baseUnit: BaseUnit } | null {
  const item = items.find((candidate) => candidate.id === line.itemId);
  if (!item) return null;
  const factor = factorFor(item, line.unit);
  if (!factor) return null;
  const quantity = positiveQuantity(line.quantity);
  if (!quantity.ok) return null;
  const base = baseQuantityOf(quantity.value, factor);
  if (!base.ok) return null;
  const amount = parseUserDecimal(line.amount);
  if (!amount || isNegative(amount) || amount.scale > 2) return null;
  if (isZero(amount))
    return { baseQuantity: base.text, unitCost: '0', baseUnit: item.baseUnit };
  const cost = divRound(amount, base.value, 6);
  if (!cost || isZero(cost)) return null;
  return {
    baseQuantity: base.text,
    unitCost: formatDec(cost),
    baseUnit: item.baseUnit,
  };
}

export function validateOpening(
  values: OpeningValues,
  items: readonly StockChoice[],
  occurredAtLocal: string,
):
  | { ok: true; draft: OpeningDraft }
  | { ok: false; formError: string | null; fields: OpeningFieldErrors } {
  const fields: OpeningFieldErrors = {};
  const lines: OpeningDraft['lines'] = [];
  let formError: string | null = null;
  const occurredAt = cairoDateTimeLocalToIso(occurredAtLocal);
  if (!occurredAt) formError = 'اكتب وقت رصيد صحيح بتوقيت القاهرة';

  for (const item of items) {
    const row = values[item.id] ?? {
      quantity: '',
      unit: item.baseUnit,
      unitCost: '',
    };
    const quantityRaw = row.quantity.trim();
    const costRaw = row.unitCost.trim();
    if (quantityRaw === '' && costRaw === '') continue;

    const rowErrors: Partial<Record<OpeningField, string>> = {};
    if (quantityRaw === '') rowErrors.quantity = 'اكتب الكمية';
    if (costRaw === '') rowErrors.unitCost = 'اكتب تكلفة الوحدة';

    const quantity = quantityRaw === '' ? null : parseUserDecimal(quantityRaw);
    const cost = costRaw === '' ? null : parseUserDecimal(costRaw);
    if (quantityRaw !== '' && !quantity) rowErrors.quantity = 'اكتب كمية صحيحة';
    if (costRaw !== '' && !cost) rowErrors.unitCost = 'اكتب تكلفة صحيحة';
    if (quantity && isNegative(quantity)) {
      rowErrors.quantity = 'الكمية لازم تكون رقم من صفر أو أكتر';
    }
    if (cost && isNegative(cost)) {
      rowErrors.unitCost = 'التكلفة لازم تكون رقم من صفر أو أكتر';
    }
    if (quantity && !isNegative(quantity) && quantity.scale > 6) {
      rowErrors.quantity = quantityScaleMessage;
    }
    if (cost && !isNegative(cost) && cost.scale > 6) {
      rowErrors.unitCost = 'التكلفة مينفعش تبقى أدق من 6 خانات';
    }

    // Quantity 0 is not an opening movement. A negative cost on that row is still rejected.
    if (quantity && !isNegative(quantity) && isZero(quantity)) {
      if (rowErrors.unitCost && costRaw !== '') {
        fields[item.id] = { unitCost: rowErrors.unitCost };
      }
      continue;
    }

    if (Object.keys(rowErrors).length > 0) {
      fields[item.id] = rowErrors;
      continue;
    }
    if (!quantity || !cost || isNegative(quantity) || isNegative(cost))
      continue;

    const factor = factorFor(item, row.unit || item.baseUnit);
    if (!factor) {
      rowErrors.quantity = 'الوحدة مش معرّفة للصنف';
      fields[item.id] = rowErrors;
      continue;
    }
    const base = baseQuantityOf(quantity, factor);
    if (!base.ok) {
      rowErrors.quantity = base.error;
      fields[item.id] = rowErrors;
      continue;
    }
    const total = mulRound(quantity, cost, 2);
    if (integerDigits(total) > 12) {
      rowErrors.unitCost = 'التكلفة أكبر من اللازم';
      fields[item.id] = rowErrors;
      continue;
    }
    lines.push({
      itemId: item.id,
      quantity: formatDec(quantity),
      unit: row.unit || item.baseUnit,
      unitCost: formatDec(cost),
    });
  }

  if (Object.keys(fields).length === 0 && lines.length === 0 && !formError) {
    formError = 'اكتب كمية لصنف واحد على الأقل';
  }
  if (formError || Object.keys(fields).length > 0 || !occurredAt) {
    return { ok: false, formError, fields };
  }
  return { ok: true, draft: { occurredAt, lines } };
}

function optionalText(
  raw: string,
  max: number,
  tooLong: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = raw.trim();
  if (value.length === 0) return { ok: true, value: null };
  if (value.length > max) return { ok: false, error: tooLong };
  return { ok: true, value };
}

export function validatePurchase(
  values: PurchaseValues,
  items: readonly StockChoice[],
): { ok: true; draft: PurchaseDraft } | { ok: false; errors: PurchaseErrors } {
  const errors: PurchaseErrors = { lines: {} };
  const purchasedAt = cairoDateTimeLocalToIso(values.purchasedAt);
  if (!purchasedAt) errors.purchasedAt = 'اكتب وقت شراء صحيح بتوقيت القاهرة';

  const supplier = optionalText(
    values.supplier,
    120,
    'اسم المورد أطول من 120 حرف',
  );
  const invoiceNo = optionalText(
    values.invoiceNo,
    60,
    'رقم الفاتورة أطول من 60 حرف',
  );
  const note = optionalText(values.note, 500, 'الملاحظة أطول من 500 حرف');
  if (!supplier.ok) errors.supplier = supplier.error;
  if (!invoiceNo.ok) errors.invoiceNo = invoiceNo.error;
  if (!note.ok) errors.note = note.error;
  if (values.lines.length < 1 || values.lines.length > 100) {
    errors.form = 'المشتريات لازم يكون فيها من سطر لـ 100 سطر';
  }

  const lines: PurchaseLineDraft[] = [];
  for (const line of values.lines) {
    const lineErrors: PurchaseErrors['lines'][string] = {};
    const item = items.find((candidate) => candidate.id === line.itemId);
    if (!item) lineErrors.itemId = 'اختار الصنف';
    const quantity = positiveQuantity(line.quantity);
    if (!quantity.ok) lineErrors.quantity = quantity.error;
    const amountParsed = parseUserDecimal(line.amount);
    if (!amountParsed) lineErrors.amount = 'اكتب مبلغ صحيح';
    else if (isNegative(amountParsed))
      lineErrors.amount = 'المبلغ لازم يكون من صفر أو أكتر';
    else if (amountParsed.scale > 2) lineErrors.amount = 'المبلغ لأقرب قرش';
    else if (moneyWire(amountParsed) === null)
      lineErrors.amount = 'المبلغ أكبر من اللازم';

    let draftLine: PurchaseLineDraft | null = null;
    if (item && quantity.ok && amountParsed && !lineErrors.amount) {
      const factor = factorFor(item, line.unit);
      if (!factor) {
        lineErrors.unit = 'اختار الوحدة';
      } else {
        const base = baseQuantityOf(quantity.value, factor);
        if (!base.ok) {
          lineErrors.quantity = base.error;
        } else if (isZero(amountParsed)) {
          draftLine = {
            itemId: item.id,
            itemName: item.name,
            quantity: formatDec(quantity.value),
            unit: line.unit,
            amountPaid: '0.00',
            baseUnit: item.baseUnit,
            baseQuantity: base.text,
            unitCost: '0',
          };
        } else {
          const cost = divRound(amountParsed, base.value, 6);
          if (!cost || isZero(cost)) {
            lineErrors.amount = 'المبلغ أصغر من إن التكلفة تتحسب';
          } else {
            draftLine = {
              itemId: item.id,
              itemName: item.name,
              quantity: formatDec(quantity.value),
              unit: line.unit,
              amountPaid: moneyWire(amountParsed) ?? '0.00',
              baseUnit: item.baseUnit,
              baseQuantity: base.text,
              unitCost: formatDec(cost),
            };
          }
        }
      }
    }
    if (Object.keys(lineErrors).length > 0) errors.lines[line.key] = lineErrors;
    else if (draftLine) lines.push(draftLine);
  }

  if (
    errors.form ||
    errors.purchasedAt ||
    errors.supplier ||
    errors.invoiceNo ||
    errors.note ||
    Object.keys(errors.lines).length > 0 ||
    !purchasedAt ||
    !supplier.ok ||
    !invoiceNo.ok ||
    !note.ok
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    draft: {
      purchasedAt,
      supplier: supplier.value,
      invoiceNo: invoiceNo.value,
      note: note.value,
      lines,
    },
  };
}

export function unitLabel(unit: string, baseUnit: BaseUnit): string {
  if (isBaseUnit(unit)) return unitLabels[unit];
  return unit === baseUnit ? unitLabels[baseUnit] : unit;
}
