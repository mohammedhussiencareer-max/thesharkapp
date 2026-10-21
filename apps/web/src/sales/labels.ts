const orderTypes: Record<string, string> = {
  takeaway: 'تيك أواي',
  delivery: 'توصيل',
  'dine-in': 'صالة',
  dine_in: 'صالة',
  hall: 'صالة',
  'تيك أواي': 'تيك أواي',
  توصيل: 'توصيل',
  صالة: 'صالة',
};

const payments: Record<string, string> = {
  cash: 'كاش',
  credit: 'آجل',
  كاش: 'كاش',
  آجل: 'آجل',
};

const statuses: Record<string, string> = {
  complete: 'مكتمل',
  canceled: 'ملغي',
  active: 'مفتوح',
};

export function orderTypeLabel(value: string | null): string {
  if (value === null || value.trim() === '') return '—';
  return orderTypes[value] ?? value;
}

export function paymentLabel(value: string | null): string {
  if (value === null || value.trim() === '') return '—';
  return payments[value] ?? value;
}

export function statusLabel(value: string): string {
  return statuses[value] ?? value;
}
