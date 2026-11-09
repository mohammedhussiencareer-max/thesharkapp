import { describe, expect, it } from 'vitest';
import {
  documentFrom,
  documentSubject,
  explanationRequiredMessage,
  factorSourceLabel,
  freshStart,
  itemTwiceMessage,
  maxLines,
  noLinesMessage,
  previewBaseQuantity,
  quantityPositiveMessage,
  quantityScaleMessage,
  quantityTinyMessage,
  reasonRequiredMessage,
  tooManyLinesMessage,
  unitCodeLabel,
  validateWaste,
  type FormValues,
} from '@/waste/format';
import { itemA, itemB, stockChoice } from '@/waste/test-fixtures';

const items = [
  stockChoice(),
  stockChoice({ id: itemB, name: 'سمك تجريبي ب', conversions: [] }),
];

function values(overrides: Partial<FormValues> = {}): FormValues {
  return {
    at: '2030-06-01T13:30',
    reason: 'spoilage',
    explanation: '',
    lines: [{ key: 'l0', itemId: itemA, quantity: '500', unit: 'g' }],
    ...overrides,
  };
}

function failed(result: ReturnType<typeof validateWaste>) {
  if (result.ok) throw new Error('expected a validation failure');
  return result.errors;
}

describe('validateWaste', () => {
  it('accepts a line and keeps the quantity and unit the owner typed', () => {
    const result = validateWaste(values(), items);
    if (!result.ok) throw new Error('expected ok');
    expect(result.lines).toEqual([
      { itemId: itemA, quantity: '500', unit: 'g' },
    ]);
    expect(result.occurredAt).toBe('2030-06-01T10:30:00.000Z');
  });

  it('requires a reason', () => {
    expect(failed(validateWaste(values({ reason: '' }), items)).reason).toBe(
      reasonRequiredMessage,
    );
  });

  it('requires an explanation for other and trims it', () => {
    expect(
      failed(validateWaste(values({ reason: 'other' }), items)).explanation,
    ).toBe(explanationRequiredMessage);
    expect(
      failed(
        validateWaste(values({ reason: 'other', explanation: '   ' }), items),
      ).explanation,
    ).toBe(explanationRequiredMessage);
    expect(
      validateWaste(values({ reason: 'other', explanation: ' اتكسر ' }), items)
        .ok,
    ).toBe(true);
  });

  it('refuses an explanation over 300 characters', () => {
    expect(
      failed(validateWaste(values({ explanation: 'ا'.repeat(301) }), items))
        .explanation,
    ).toBeDefined();
    expect(
      validateWaste(values({ explanation: 'ا'.repeat(300) }), items).ok,
    ).toBe(true);
  });

  it('refuses no lines and more than fifty', () => {
    expect(failed(validateWaste(values({ lines: [] }), items)).lines).toBe(
      noLinesMessage,
    );
    const many = Array.from({ length: maxLines + 1 }, (_, index) => ({
      key: `l${index}`,
      itemId: itemA,
      quantity: '1',
      unit: 'kg',
    }));
    expect(failed(validateWaste(values({ lines: many }), items)).lines).toBe(
      tooManyLinesMessage,
    );
  });

  it('flags an item listed twice on the second line', () => {
    const errors = failed(
      validateWaste(
        values({
          lines: [
            { key: 'a', itemId: itemA, quantity: '1', unit: 'kg' },
            { key: 'b', itemId: itemA, quantity: '2', unit: 'kg' },
          ],
        }),
        items,
      ),
    );
    expect(errors.line.a).toBeUndefined();
    expect(errors.line.b?.itemId).toBe(itemTwiceMessage);
  });

  it('flags a missing item, a bad quantity and an unavailable unit per line', () => {
    const errors = failed(
      validateWaste(
        values({
          lines: [
            { key: 'a', itemId: '', quantity: '1', unit: '' },
            { key: 'b', itemId: itemA, quantity: '0', unit: 'kg' },
            { key: 'c', itemId: itemA, quantity: 'abc', unit: 'kg' },
            { key: 'd', itemId: itemB, quantity: '1', unit: 'g' },
          ],
        }),
        items,
      ),
    );
    expect(errors.line.a?.itemId).toBeDefined();
    expect(errors.line.b?.quantity).toBe(quantityPositiveMessage);
    expect(errors.line.c?.quantity).toBeDefined();
    expect(errors.line.d?.unit).toBeDefined();
  });

  it('refuses more than six decimals and a quantity that rounds to zero in the base unit', () => {
    const errors = failed(
      validateWaste(
        values({
          lines: [
            { key: 'a', itemId: itemA, quantity: '0.0000001', unit: 'kg' },
            { key: 'b', itemId: itemA, quantity: '0.0004', unit: 'g' },
          ],
        }),
        items,
      ),
    );
    expect(errors.line.a?.quantity).toBe(quantityScaleMessage);
    expect(errors.line.b?.quantity).toBe(quantityTinyMessage);
  });

  it('keeps the stored instant while the time is untouched', () => {
    const original = {
      local: '2030-06-01T13:30',
      iso: '2030-06-01T10:30:15+00:00',
    };
    const untouched = validateWaste(values(), items, original);
    if (!untouched.ok) throw new Error('expected ok');
    expect(untouched.occurredAt).toBe(original.iso);

    const edited = validateWaste(
      values({ at: '2030-06-01T14:00' }),
      items,
      original,
    );
    if (!edited.ok) throw new Error('expected ok');
    expect(edited.occurredAt).toBe('2030-06-01T11:00:00.000Z');
  });

  it('requires a time', () => {
    expect(failed(validateWaste(values({ at: '' }), items)).at).toBeDefined();
  });
});

describe('documentFrom', () => {
  it('builds a record, then a correction when a predecessor is set', () => {
    const form = values({ explanation: '  اتكسر ' });
    const validated = validateWaste(form, items);
    if (!validated.ok) throw new Error('expected ok');
    expect(documentFrom(form, validated, null)).toEqual({
      kind: 'record',
      occurredAt: '2030-06-01T10:30:00.000Z',
      reason: 'spoilage',
      explanation: 'اتكسر',
      lines: [{ itemId: itemA, quantity: '500', unit: 'g' }],
    });
    expect(documentFrom(form, validated, '7')).toMatchObject({
      kind: 'correction',
      predecessorId: '7',
    });
  });

  it('sends a blank explanation as null', () => {
    const form = values();
    const validated = validateWaste(form, items);
    if (!validated.ok) throw new Error('expected ok');
    expect(documentFrom(form, validated, null)).toMatchObject({
      explanation: null,
    });
  });
});

describe('previewBaseQuantity', () => {
  it('shows the base quantity the server will save', () => {
    const item = stockChoice();
    expect(previewBaseQuantity({ quantity: '500', unit: 'g' }, item)).toBe(
      '0.5',
    );
    expect(previewBaseQuantity({ quantity: '2', unit: 'kg' }, item)).toBe('2');
  });

  it('shows nothing while the line is unclear', () => {
    const item = stockChoice();
    expect(previewBaseQuantity({ quantity: '', unit: 'g' }, item)).toBeNull();
    expect(previewBaseQuantity({ quantity: '5', unit: 'x' }, item)).toBeNull();
    expect(
      previewBaseQuantity({ quantity: '5', unit: 'g' }, undefined),
    ).toBeNull();
    expect(previewBaseQuantity({ quantity: '-1', unit: 'g' }, item)).toBeNull();
  });
});

describe('labels and subjects', () => {
  it('labels known unit codes and shows a custom one as it is', () => {
    expect(unitCodeLabel('kg')).toBe('كيلو');
    expect(unitCodeLabel('crate')).toBe('crate');
    expect(unitCodeLabel('constructor')).toBe('constructor');
  });

  it('labels known conversion sources and shows an unknown one as it is', () => {
    expect(factorSourceLabel('metric')).toBe('تحويل قياسي');
    expect(factorSourceLabel('toString')).toBe('toString');
  });

  it('keeps one subject per corrected document', () => {
    expect(documentSubject('7')).toBe(documentSubject('7'));
    expect(documentSubject('7')).not.toBe(documentSubject('8'));
  });

  it('starts a fresh form with one empty line and no reason', () => {
    const start = freshStart();
    expect(start.values.reason).toBe('');
    expect(start.values.lines).toHaveLength(1);
    expect(start.original).toBeUndefined();
  });
});
