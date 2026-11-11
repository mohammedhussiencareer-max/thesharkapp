import { describe, expect, it } from 'vitest';
import {
  causeLabel,
  checklistLabels,
  dispositionLabels,
  movementLabel,
  sqlstateLabel,
} from '@/accounting/labels';

describe('accounting labels', () => {
  it('maps dispositions, causes, movements, and SQLSTATE', () => {
    expect(dispositionLabels.prepared_waste).toBe('فاقد تحضير');
    expect(causeLabel('missing_cost_basis')).toBe('سعر التكلفة ناقص');
    expect(causeLabel('custom_cause')).toBe('custom_cause');
    expect(movementLabel('count_compensation')).toBe('تعويض جرد');
    expect(movementLabel('other')).toBe('other');
    expect(sqlstateLabel('40001')).toBe('تعارض');
    expect(sqlstateLabel('55P03')).toBe('المزامنة شغالة');
    expect(sqlstateLabel('XX000')).toBe('الرمز XX000');
    expect(checklistLabels.missing_observations).toBe(
      'أصناف من غير رصد افتتاحي',
    );
  });
});
