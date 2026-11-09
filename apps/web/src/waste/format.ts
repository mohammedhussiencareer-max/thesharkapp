import {
  formatDec,
  integerDigits,
  isNegative,
  isZero,
  mulRound,
  parseUserDecimal,
} from '@/purchases/decimal';
import {
  missingCairoTimeMessage,
  nowCairoDateTimeLocal,
  parseCairoDateTimeLocal,
} from '@/purchases/time';
import type { StockChoice } from '@/purchases/types';
import { unitChoices, unitUnavailableMessage } from '@/purchases/validation';
import type {
  StoredReason,
  WasteDocumentInput,
  WasteKind,
  WasteLineInput,
  WasteReason,
} from '@/waste/types';

export { moneyText } from '@/order-decisions/format';

export const explanationLimit = 300;

export const maxLines = 50;

export const reasonLabels: Record<StoredReason, string> = {
  staff_meal: 'وجبة موظفين',
  spoilage: 'تالف',
  other: 'سبب تاني',
  cancel_after_preparation: 'إلغاء بعد التحضير',
};

export const documentKindLabels: Record<WasteKind, string> = {
  record: 'تسجيل',
  correction: 'تصحيح',
  void: 'إلغاء',
};

export const factorSourceLabels: Record<string, string> = {
  base: 'الوحدة الأساسية',
  explicit: 'تحويل محفوظ للصنف',
  metric: 'تحويل قياسي',
};

export function factorSourceLabel(source: string): string {
  return Object.prototype.hasOwnProperty.call(factorSourceLabels, source)
    ? (factorSourceLabels[source] ?? source)
    : source;
}

/** One outstanding record action at a time. */
export const newWasteSubject = 'waste:new';

/** One outstanding correction or void per corrected document. */
export function documentSubject(documentId: string): string {
  return `waste:document:${JSON.stringify(documentId)}`;
}

export const timeRequiredMessage = 'اكتب وقت الهالك';
export const reasonRequiredMessage = 'اختار السبب';
export const explanationRequiredMessage =
  'اكتب شرح — السبب "سبب تاني" محتاج شرح';
export const explanationTooLongMessage = 'الشرح أطول من 300 حرف';
export const noLinesMessage = 'ضيف صنف واحد على الأقل';
export const tooManyLinesMessage = 'الحد الأقصى 50 صنف في السجل';
export const itemRequiredMessage = 'اختار الصنف';
export const itemTwiceMessage = 'الصنف اتكرر';
export const quantityInvalidMessage = 'اكتب كمية صحيحة';
export const quantityPositiveMessage = 'الكمية لازم تكون أكبر من صفر';
export const quantityScaleMessage = 'الكمية مينفعش تبقى أدق من 6 خانات';
export const quantityRangeMessage = 'الكمية أكبر من اللازم';
export const quantityTinyMessage = 'الكمية أصغر من وحدة القياس';
export const unitRequiredMessage = 'اختار الوحدة';

export type FormLine = {
  key: string;
  itemId: string;
  quantity: string;
  unit: string;
};

export type FormValues = {
  at: string;
  reason: WasteReason | '';
  explanation: string;
  lines: FormLine[];
};

export type FormStart = {
  values: FormValues;
  /** The stored instant behind `values.at`, kept while the time is untouched. */
  original?: { local: string; iso: string };
};

export function emptyLine(key: string, item?: StockChoice): FormLine {
  return {
    key,
    itemId: item?.id ?? '',
    quantity: '',
    unit: item?.baseUnit ?? '',
  };
}

export function freshStart(): FormStart {
  return {
    values: {
      at: nowCairoDateTimeLocal(),
      reason: '',
      explanation: '',
      lines: [emptyLine('l0')],
    },
  };
}

export type LineErrors = Partial<
  Record<'itemId' | 'quantity' | 'unit', string>
>;

export type FormErrors = {
  at?: string;
  reason?: string;
  explanation?: string;
  lines?: string;
  line: Record<string, LineErrors>;
};

export type Validated =
  | { ok: true; lines: WasteLineInput[]; occurredAt: string }
  | { ok: false; errors: FormErrors };

function factorOf(item: StockChoice, unit: string): string | null {
  return (
    unitChoices(item).find((choice) => choice.unit === unit)?.factorToBase ??
    null
  );
}

function lineProblem(
  line: FormLine,
  item: StockChoice | undefined,
): { errors: LineErrors; input: WasteLineInput | null } {
  const errors: LineErrors = {};
  if (!line.itemId || !item) errors.itemId = itemRequiredMessage;

  const quantity = parseUserDecimal(line.quantity);
  if (!quantity) errors.quantity = quantityInvalidMessage;
  else if (isNegative(quantity) || isZero(quantity)) {
    errors.quantity = quantityPositiveMessage;
  } else if (quantity.scale > 6) errors.quantity = quantityScaleMessage;
  else if (integerDigits(quantity) > 14) errors.quantity = quantityRangeMessage;

  if (!line.unit) errors.unit = unitRequiredMessage;
  const factorText = item && line.unit ? factorOf(item, line.unit) : null;
  if (item && line.unit && factorText === null) {
    errors.unit = unitUnavailableMessage;
  }

  if (quantity && !errors.quantity && factorText !== null) {
    const factor = parseUserDecimal(factorText);
    if (!factor || isZero(factor) || isNegative(factor)) {
      errors.unit = unitUnavailableMessage;
    } else {
      const base = mulRound(quantity, factor, 6);
      if (isZero(base)) errors.quantity = quantityTinyMessage;
      else if (integerDigits(base) > 14) errors.quantity = quantityRangeMessage;
    }
  }

  if (Object.keys(errors).length > 0 || !quantity) {
    return { errors, input: null };
  }
  return {
    errors,
    input: {
      itemId: line.itemId,
      quantity: formatDec(quantity),
      unit: line.unit,
    },
  };
}

/** The document the form would send, or every problem found. */
export function validateWaste(
  values: FormValues,
  items: readonly StockChoice[],
  original?: { local: string; iso: string },
): Validated {
  const errors: FormErrors = { line: {} };

  const parsed = parseCairoDateTimeLocal(values.at);
  if (!parsed.ok) {
    errors.at =
      parsed.reason === 'missing'
        ? missingCairoTimeMessage
        : timeRequiredMessage;
  }

  if (values.reason === '') errors.reason = reasonRequiredMessage;
  const explanation = values.explanation.trim();
  if (explanation.length > explanationLimit) {
    errors.explanation = explanationTooLongMessage;
  } else if (values.reason === 'other' && explanation.length === 0) {
    errors.explanation = explanationRequiredMessage;
  }

  if (values.lines.length === 0) errors.lines = noLinesMessage;
  else if (values.lines.length > maxLines) errors.lines = tooManyLinesMessage;

  const inputs: WasteLineInput[] = [];
  const seen = new Set<string>();
  for (const line of values.lines) {
    const item = items.find((candidate) => candidate.id === line.itemId);
    const result = lineProblem(line, item);
    if (line.itemId && seen.has(line.itemId)) {
      result.errors.itemId = itemTwiceMessage;
    }
    seen.add(line.itemId);
    if (Object.keys(result.errors).length > 0) {
      errors.line[line.key] = result.errors;
    } else if (result.input) {
      inputs.push(result.input);
    }
  }

  const failed =
    errors.at !== undefined ||
    errors.reason !== undefined ||
    errors.explanation !== undefined ||
    errors.lines !== undefined ||
    Object.keys(errors.line).length > 0;
  if (failed || !parsed.ok) return { ok: false, errors };
  // An untouched time keeps the stored instant, which has seconds the input hides.
  const occurredAt =
    original && values.at === original.local ? original.iso : parsed.iso;
  return { ok: true, lines: inputs, occurredAt };
}

/** The document for a new record, or a correction when a predecessor is set. */
export function documentFrom(
  values: FormValues,
  validated: Extract<Validated, { ok: true }>,
  predecessorId: string | null,
): WasteDocumentInput {
  if (values.reason === '') throw new Error('reason is required');
  const explanation = values.explanation.trim();
  const body = {
    occurredAt: validated.occurredAt,
    reason: values.reason,
    explanation: explanation.length > 0 ? explanation : null,
    lines: validated.lines,
  };
  return predecessorId === null
    ? { kind: 'record', ...body }
    : { kind: 'correction', predecessorId, ...body };
}

/** Base quantity the server will save for a typed line, or null while unclear. */
export function previewBaseQuantity(
  line: Pick<FormLine, 'quantity' | 'unit'>,
  item: StockChoice | undefined,
): string | null {
  if (!item || !line.unit) return null;
  const quantity = parseUserDecimal(line.quantity);
  const factorText = factorOf(item, line.unit);
  if (!quantity || factorText === null) return null;
  if (isNegative(quantity) || isZero(quantity) || quantity.scale > 6) {
    return null;
  }
  const factor = parseUserDecimal(factorText);
  if (!factor || isZero(factor)) return null;
  const base = mulRound(quantity, factor, 6);
  if (isZero(base) || integerDigits(base) > 14) return null;
  return formatDec(base);
}

const unitCodeLabels: Record<string, string> = {
  kg: 'كيلو',
  g: 'جرام',
  liter: 'لتر',
  ml: 'ملل',
  piece: 'قطعة',
};

/** Arabic label for a stored unit code; a custom code is shown as it is. */
export function unitCodeLabel(code: string): string {
  return Object.prototype.hasOwnProperty.call(unitCodeLabels, code)
    ? (unitCodeLabels[code] ?? code)
    : code;
}
