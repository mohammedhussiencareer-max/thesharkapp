export const genericPurchaseError = 'حصل خطأ. حاول تاني.';

export const permissionMessage = 'مفيش صلاحية للعملية دي';

/** A lost reply can be saved again; the same request id will not post twice. */
export const retrySafeMessage =
  'حصل خطأ. اضغط حفظ تاني — لو الطلب اتسجل مش هيتسجل مرتين.';

/** The unit or factor changed after the owner reviewed the line. */
export const conversionChangedMessage =
  'الوحدة أو معامل التحويل اتغيّر. راجع السطور واحفظ تاني.';

export class ConversionChangedError extends Error {
  constructor() {
    super(conversionChangedMessage);
    this.name = 'ConversionChangedError';
  }
}

const backDatedMarker = 'back-dated movement not supported yet';

export function backDatedMessage(itemName: string): string {
  return `مينفعش تسجّل حركة لـ ${itemName} بتاريخ أقدم من آخر حركة ليه — التعديل بأثر رجعي جاي في مرحلة لاحقة`;
}

const namedReasons: ReadonlyArray<readonly [string, (name: string) => string]> =
  [
    [
      'item already has movements: ',
      (name) =>
        `مينفعش تسجّل رصيد افتتاحي لـ ${name} — الصنف عليه حركات قبل كده`,
    ],
    [
      'duplicate opening item: ',
      (name) => `الصنف ${name} متكرر في الرصيد الافتتاحي`,
    ],
    [
      'unknown unit "',
      (rest) => {
        const match = /^(.*)" for item (.*)$/.exec(rest);
        if (!match) return 'الوحدة مش معرّفة للصنف';
        return `الوحدة ${match[1]} مش معرّفة للصنف ${match[2]}`;
      },
    ],
  ];

const exactReasons: ReadonlyArray<readonly [string, string]> = [
  [
    'request_id already used for a different purchase',
    'الحفظ اللي فات ممكن يكون اتسجل قبل التعديل. راجع قايمة المشتريات قبل ما تسجّل تاني',
  ],
  [
    'request_id already used for a different opening',
    'الحفظ اللي فات ممكن يكون اتسجل قبل التعديل. راجع الأرصدة قبل ما تسجّل تاني',
  ],
  ['purchased_at is required', 'اكتب وقت الشراء'],
  ['purchased_at must be a finite timestamp', 'وقت الشراء مش مظبوط'],
  ['occurred_at is required', 'اكتب وقت الرصيد'],
  ['occurred_at must be a finite timestamp', 'وقت الرصيد مش مظبوط'],
  ['supplier must be at most 120 characters', 'اسم المورد أطول من 120 حرف'],
  ['invoice_no must be at most 60 characters', 'رقم الفاتورة أطول من 60 حرف'],
  ['note must be at most 500 characters', 'الملاحظة أطول من 500 حرف'],
  [
    'lines must be a jsonb array of 1 to 100 purchase lines',
    'المشتريات لازم يكون فيها من سطر لـ 100 سطر',
  ],
  ['quantity must be a finite number > 0', 'الكمية لازم تكون أكبر من صفر'],
  [
    'quantity must be a finite number >= 0',
    'الكمية لازم تكون رقم من صفر أو أكتر',
  ],
  [
    'quantity must have at most 6 decimal places',
    'الكمية مينفعش تبقى أدق من 6 خانات',
  ],
  [
    'amount_paid must be a finite number >= 0',
    'المبلغ لازم يكون من صفر أو أكتر',
  ],
  ['amount_paid must be in piasters', 'المبلغ لأقرب قرش'],
  ['opening unit_cost must be >= 0', 'التكلفة لازم تكون رقم من صفر أو أكتر'],
  [
    'unit_cost must have at most 6 decimal places',
    'تكلفة الوحدة مينفعش تبقى أدق من 6 خانات',
  ],
  ['unit_cost is required', 'اكتب تكلفة الوحدة'],
  ['unit is required', 'اختار الوحدة'],
  ['at least one opening line is required', 'اكتب كمية لصنف واحد على الأقل'],
  ['purchase base quantity must be > 0', 'الكمية أصغر من وحدة القياس'],
  ['opening base quantity must be > 0', 'الكمية أصغر من وحدة القياس'],
  ['opening total_cost is out of range', 'التكلفة أكبر من اللازم'],
  ['purchase total_paid is out of range', 'المبلغ أكبر من اللازم'],
  ['purchase unit_cost is out of range', 'التكلفة أكبر من اللازم'],
  [
    'converted purchase unit_cost must be > 0',
    'المبلغ أصغر من إن التكلفة تتحسب',
  ],
];

function errorParts(error: object): {
  code: string;
  message: string;
  details: string;
  text: string;
} {
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const details = typeof record.details === 'string' ? record.details : '';
  const hint = typeof record.hint === 'string' ? record.hint : '';
  return {
    code,
    message,
    details,
    text: [message, details, hint].filter((part) => part.length > 0).join('\n'),
  };
}

function nameAfter(message: string, prefix: string): string | null {
  const index = message.indexOf(prefix);
  if (index < 0) return null;
  const name = message.slice(index + prefix.length).trim();
  return name.length > 0 ? name : null;
}

export function mapPurchaseError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return genericPurchaseError;
  const { code, message, details, text } = errorParts(error);

  if (
    code === '42501' ||
    text.includes('insufficient_privilege') ||
    text.includes('permission denied')
  ) {
    return permissionMessage;
  }

  if (text.includes(backDatedMarker)) {
    const name =
      details.trim() && !details.includes('occurred_at')
        ? details.trim()
        : 'الصنف';
    return backDatedMessage(name);
  }

  for (const [prefix, toArabic] of namedReasons) {
    const name = nameAfter(message, prefix);
    if (name) return toArabic(name);
  }

  for (const [needle, arabic] of exactReasons) {
    if (text.includes(needle)) return arabic;
  }

  if (code === '22023') return 'البيانات مش مظبوطة';
  return genericPurchaseError;
}
