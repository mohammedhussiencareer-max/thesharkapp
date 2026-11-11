import { describe, expect, it } from 'vitest';
import {
  compareDecimal,
  decisionSubject,
  draftFromReturned,
  invalidReturnedMessage,
  keptQuantity,
  moneyText,
  outcomeMessage,
  returnedError,
  returnedFromDraft,
  returnedOverMessage,
  trimDecimal,
  unitText,
} from '@/order-decisions/format';
import type { BasisItem } from '@/order-decisions/types';

const items: BasisItem[] = [
  { stockItemId: 'a', name: 'أ', baseUnit: 'kg', quantity: '1.5' },
  { stockItemId: 'b', name: 'ب', baseUnit: 'kg', quantity: '0.25' },
];

describe('decimal text helpers', () => {
  it('compares exactly across different scales', () => {
    expect(compareDecimal('1.5', '1.500000')).toBe(0);
    expect(compareDecimal('0.000001', '0')).toBe(1);
    expect(compareDecimal('99999999999999', '99999999999998.999999')).toBe(1);
    expect(compareDecimal('0.1', '0.10001')).toBe(-1);
  });

  it('trims trailing zeros but never the integer part', () => {
    expect(trimDecimal('1.500000')).toBe('1.5');
    expect(trimDecimal('10.000')).toBe('10');
    expect(trimDecimal('0.000')).toBe('0');
    expect(trimDecimal('100')).toBe('100');
  });

  it('subtracts the returned quantity from the prepared one', () => {
    expect(keptQuantity('1.5', '0.5')).toBe('1');
    expect(keptQuantity('0.3', '0.1')).toBe('0.2');
    expect(keptQuantity('1', '1')).toBe('0');
    expect(keptQuantity('0.25', '0.000001')).toBe('0.249999');
    expect(keptQuantity('1', '2')).toBe('0');
  });
});

describe('returned quantities', () => {
  it('accepts an empty field, up to 6 decimals, and up to the prepared amount', () => {
    expect(returnedError('', '1.5')).toBeNull();
    expect(returnedError(' 1.5 ', '1.5')).toBeNull();
    expect(returnedError('0.000001', '1.5')).toBeNull();
  });

  it('refuses signs, exponents, commas, 7 decimals and more than prepared', () => {
    for (const text of [
      '-1',
      '+1',
      '1e2',
      '1,5',
      '.5',
      '1.',
      'abc',
      '0.0000001',
    ]) {
      expect(returnedError(text, '5')).toBe(invalidReturnedMessage);
    }
    expect(returnedError('1.500001', '1.5')).toBe(returnedOverMessage);
  });

  it('builds one line per item, an empty field being an explicit confirmed zero', () => {
    expect(returnedFromDraft(items, { a: '0.50', b: '' })).toEqual({
      ok: true,
      lines: [
        { stockItemId: 'a', returned: '0.5' },
        { stockItemId: 'b', returned: '0' },
      ],
    });
    expect(returnedFromDraft(items, { a: '0', b: '0.000' })).toEqual({
      ok: true,
      lines: [
        { stockItemId: 'a', returned: '0' },
        { stockItemId: 'b', returned: '0' },
      ],
    });
    expect(returnedFromDraft(items, {})).toEqual({
      ok: true,
      lines: [
        { stockItemId: 'a', returned: '0' },
        { stockItemId: 'b', returned: '0' },
      ],
    });
  });

  it('reports every invalid field and sends nothing', () => {
    expect(returnedFromDraft(items, { a: '2', b: 'x' })).toEqual({
      ok: false,
      errors: { a: returnedOverMessage, b: invalidReturnedMessage },
    });
  });

  it('starts the draft from the stored quantities', () => {
    expect(draftFromReturned([{ stockItemId: 'a', returned: '0.5' }])).toEqual({
      a: '0.5',
    });
  });
});

describe('labels and messages', () => {
  it('scopes one outstanding action to one order', () => {
    expect(decisionSubject('o1')).not.toBe(decisionSubject('o2'));
    expect(decisionSubject('o1')).toBe(decisionSubject('o1'));
  });

  it('shows unknown units and odd money as they are', () => {
    expect(unitText('kg')).toBe('كيلو');
    expect(unitText('constructor')).toBe('constructor');
    expect(moneyText('12.345')).toBe('12.345 ج.م');
  });

  it('explains the outcome of a saved decision', () => {
    expect(outcomeMessage('posted', 'not_made')).toContain('ماتعملش');
    expect(outcomeMessage('blocked', null)).toContain('موقوف');
    expect(outcomeMessage('disposition_pending', 'needs_review')).toContain(
      'مراجعة',
    );
    expect(outcomeMessage('posted', 'missing_preparation_basis')).toContain(
      'مفيش أساس',
    );
    expect(outcomeMessage('unchanged', null)).toContain('مفيش تغيير');
    expect(outcomeMessage('posted', null)).toBe('اتسجل القرار');
  });
});
