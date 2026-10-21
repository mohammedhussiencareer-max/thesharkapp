import { describe, expect, it } from 'vitest';
import { orderTypeLabel, paymentLabel, statusLabel } from '@/sales/labels';

describe('sales labels', () => {
  it('maps POS order words and keeps Arabic text', () => {
    expect(orderTypeLabel('takeaway')).toBe('تيك أواي');
    expect(orderTypeLabel('delivery')).toBe('توصيل');
    expect(orderTypeLabel('dine-in')).toBe('صالة');
    expect(orderTypeLabel('hall')).toBe('صالة');
    expect(orderTypeLabel('صالة')).toBe('صالة');
    expect(orderTypeLabel(null)).toBe('—');
  });

  it('maps payment and status', () => {
    expect(paymentLabel('cash')).toBe('كاش');
    expect(paymentLabel('credit')).toBe('آجل');
    expect(paymentLabel('كاش')).toBe('كاش');
    expect(statusLabel('complete')).toBe('مكتمل');
    expect(statusLabel('canceled')).toBe('ملغي');
    expect(statusLabel('active')).toBe('مفتوح');
  });
});
