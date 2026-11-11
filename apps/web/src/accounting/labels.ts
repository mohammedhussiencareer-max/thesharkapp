import type {
  ChecklistCode,
  CostDisposition,
  FailureReason,
  ReceiptKind,
  ScopeKind,
} from '@/accounting/types';

export const reasonLabels: Record<FailureReason, string> = {
  error: 'خطأ في الحساب',
  recompute_limit: 'الحساب عدّى الحد',
  critical: 'خطأ جوهري في الدفتر، الحساب واقف',
  escaped: 'المكالمة اتقطعت',
};

export const dispositionLabels: Record<CostDisposition, string> = {
  sale: 'بيع',
  prepared_waste: 'فاقد تحضير',
  none: 'من غير خصم',
  incomplete: 'ناقص',
};

export const receiptLabels: Record<ReceiptKind, string> = {
  posting: 'ترحيل',
  evaluation: 'تقييم',
};

export const scopeLabels: Record<ScopeKind, string> = {
  shift_ids: 'ورديات محددة',
  from: 'من تاريخ',
  all: 'كل التاريخ',
};

export const checklistLabels: Record<ChecklistCode, string> = {
  not_activated: 'التفعيل لسه ما اتسجلش',
  missing_observations: 'أصناف من غير رصد افتتاحي',
  unreceipted_outflows: 'خصم من غير إيصال',
  empty_roster: 'قائمة الأصناف',
};

export const causeLabels: Record<string, string> = {
  shift_open: 'الوردية لسه مفتوحة',
  open_orders: 'فيه طلبات مفتوحة',
  sync_scope_not_covered: 'المزامنة ما غطّتش الوردية',
  sync_stale: 'المزامنة قديمة',
  pending_applications: 'فيه خصم لسه مستني',
  blocked_applications: 'فيه خصم واقف',
  stale_applications: 'الخصم أقدم من المدخلات',
  unreviewed_decisions: 'فيه قرار لسه ما اتراجعش',
  unresolved_preparation: 'أساس التحضير ناقص',
  unresolved_refund_attribution: 'مرتجع من غير طلب',
  provisional_deficits: 'رصيد سالب من غير تغطية',
  missing_cost_basis: 'سعر التكلفة ناقص',
  order_coverage_incomplete: 'تغطية الطلبات ناقصة',
  count_sync_scope_not_covered: 'مزامنة الجرد ما غطّتش الورديات',
};

export const movementLabels: Record<string, string> = {
  sale: 'بيع',
  sale_reversal: 'عكس بيع',
  waste: 'هالك',
  waste_reversal: 'عكس هالك',
  cost_adjustment: 'تعديل قيمة',
  count_adjustment: 'تسوية جرد',
  count_compensation: 'تعويض جرد',
};

const sqlstateLabels: Record<string, string> = {
  '57014': 'الوقت خلص',
  '40001': 'تعارض',
  '40P01': 'تعارض',
  '55P03': 'المزامنة شغالة',
  '42501': 'مفيش صلاحية',
};

export function sqlstateLabel(code: string): string {
  return sqlstateLabels[code] ?? `الرمز ${code}`;
}

export function causeLabel(code: string): string {
  return causeLabels[code] ?? code;
}

export function movementLabel(type: string): string {
  return movementLabels[type] ?? type;
}
