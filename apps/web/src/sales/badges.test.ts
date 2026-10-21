import { describe, expect, it } from 'vitest';
import { reconciliationBadge, unknownTxLabel } from '@/sales/badges';

describe('reconciliation badge', () => {
  it('matches a drawer within one piaster', () => {
    expect(
      reconciliationBadge({ isActive: false, drawerDifference: '0.00' }),
    ).toBe('مطابق للدرج');
    expect(
      reconciliationBadge({ isActive: false, drawerDifference: '-0.01' }),
    ).toBe('مطابق للدرج');
  });

  it('shows the signed difference past one piaster', () => {
    expect(
      reconciliationBadge({ isActive: false, drawerDifference: '0.02' }),
    ).toBe('فرق مع الدرج: 0.02 ج.م');
    expect(
      reconciliationBadge({ isActive: false, drawerDifference: '-1.50' }),
    ).toBe('فرق مع الدرج: -1.50 ج.م');
  });

  it('prefers an open shift, then a missing drawer', () => {
    expect(
      reconciliationBadge({ isActive: true, drawerDifference: '0.00' }),
    ).toBe('الوردية مفتوحة');
    expect(
      reconciliationBadge({ isActive: false, drawerDifference: null }),
    ).toBe('مفيش أرقام درج');
  });

  it('flags unknown drawer movements separately', () => {
    expect(unknownTxLabel(2)).toBe('حركات درج غير معروفة');
    expect(unknownTxLabel(0)).toBeNull();
  });
});
