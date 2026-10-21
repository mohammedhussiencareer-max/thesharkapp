import { describe, expect, it } from 'vitest';
import type { StockChoice } from '@/purchases/types';
import {
  previewPurchaseLine,
  validateOpening,
  validatePurchase,
  type PurchaseValues,
} from '@/purchases/validation';

const oil: StockChoice = {
  id: 'oil',
  name: 'زيت',
  kind: 'ingredient',
  baseUnit: 'kg',
  parentItemId: null,
  active: true,
  hasMovements: false,
  conversions: [{ unit: 'لتر', factorToBase: '0.92' }],
};

const mixed: StockChoice = {
  id: 'mixed',
  name: 'بوري',
  kind: 'fish_mixed',
  baseUnit: 'kg',
  parentItemId: null,
  active: true,
  hasMovements: false,
  conversions: [],
};

const purchaseValues = (
  patch: Partial<PurchaseValues['lines'][number]> = {},
): PurchaseValues => ({
  purchasedAt: '2026-07-15T12:00',
  supplier: '  مورد  ',
  invoiceNo: '',
  note: '',
  lines: [
    {
      key: '1',
      itemId: 'oil',
      quantity: '٢',
      unit: 'لتر',
      amount: '٥٠',
      ...patch,
    },
  ],
});

describe('purchase validation', () => {
  it('derives the base quantity and unit cost for a converted unit', () => {
    expect(
      previewPurchaseLine(
        { itemId: 'oil', quantity: '٢', unit: 'لتر', amount: '٥٠' },
        [oil],
      ),
    ).toEqual({ baseQuantity: '1.84', unitCost: '27.173913', baseUnit: 'kg' });

    const result = validatePurchase(purchaseValues(), [oil]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.purchasedAt).toBe('2026-07-15T09:00:00.000Z');
    expect(result.draft.supplier).toBe('مورد');
    expect(result.draft.invoiceNo).toBeNull();
    expect(result.draft.lines[0]).toMatchObject({
      quantity: '2',
      unit: 'لتر',
      amountPaid: '50.00',
      baseQuantity: '1.84',
      unitCost: '27.173913',
    });
  });

  it('rejects a negative amount, a missing line, and an unknown unit', () => {
    const negative = validatePurchase(purchaseValues({ amount: '-1' }), [oil]);
    expect(negative.ok).toBe(false);
    if (negative.ok) return;
    expect(negative.errors.lines['1']?.amount).toBe(
      'المبلغ لازم يكون من صفر أو أكتر',
    );

    const missing = validatePurchase(purchaseValues({ itemId: '' }), [oil]);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.errors.lines['1']?.itemId).toBe('اختار الصنف');

    const unit = validatePurchase(purchaseValues({ unit: 'دلو' }), [oil]);
    expect(unit.ok).toBe(false);
    if (unit.ok) return;
    expect(unit.errors.lines['1']?.unit).toBe('اختار الوحدة');
  });

  it('skips a zero opening quantity and posts the filled row', () => {
    const skipped = validateOpening(
      {
        oil: { quantity: '0', unit: 'kg', unitCost: '' },
        mixed: { quantity: '٤', unit: 'kg', unitCost: '١٢٫٥' },
      },
      [oil, mixed],
      '2026-01-15T12:00',
    );
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(skipped.draft.occurredAt).toBe('2026-01-15T10:00:00.000Z');
    expect(skipped.draft.lines).toEqual([
      { itemId: 'mixed', quantity: '4', unit: 'kg', unitCost: '12.5' },
    ]);
  });

  it('rejects a negative opening cost and an empty grid', () => {
    const negative = validateOpening(
      { oil: { quantity: '1', unit: 'kg', unitCost: '-1' } },
      [oil],
      '2026-01-15T12:00',
    );
    expect(negative.ok).toBe(false);
    if (negative.ok) return;
    expect(negative.fields.oil?.unitCost).toBe(
      'التكلفة لازم تكون رقم من صفر أو أكتر',
    );

    const empty = validateOpening({}, [oil], '2026-01-15T12:00');
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.formError).toBe('اكتب كمية لصنف واحد على الأقل');
  });
});
