import { buildWorkbook, type BuilderCell } from './workbook-builder';

/** Every price-like number in the sample, so a test can look for them. */
export const samplePriceValues = [
  987.65, 123.45, 555.55, 777.77, 321.12, 2.55, 99.99, 111.11, 66.66, 44.44,
];

type BlockSpec = {
  name: string;
  lines: [string, number][];
  padding?: number;
  net?: number;
};

function place(
  grid: BuilderCell[][],
  row: number,
  col: number,
  spec: BlockSpec,
): { next: number; totalRow: number } {
  function put(r: number, cells: BuilderCell[]): void {
    const line = (grid[r - 1] ??= []);
    while (line.length < col - 1) line.push(null);
    cells.forEach((cell, index) => {
      line[col - 1 + index] = cell;
    });
  }
  let r = row;
  put(r++, ['اسم الصنف', spec.name]);
  put(r++, [
    'المكونات',
    'المعيار بالجرام/المللى',
    'سعر المعيار',
    'الوزن الاجمالى',
    'سعر الوزن الاجمالى',
    'وزن الجرام',
  ]);
  for (const [name, qty] of spec.lines) {
    put(r++, [name, qty, 987.65, qty, 123.45, qty]);
  }
  for (let index = 0; index < (spec.padding ?? 0); index += 1) {
    put(r++, ['', 1, 111.11, 1, 66.66, 1]);
  }
  const totalRow = r;
  put(r++, [
    'الاجمالى',
    '',
    '',
    { formula: `SUM(D${row + 2}:D${totalRow - 1})`, value: 555.55 },
    'سعر البيع',
    777.77,
  ]);
  if (spec.net !== undefined) put(r++, ['صافى', spec.net, 321.12]);
  return { next: r + 2, totalRow };
}

export type SampleOptions = {
  suffix?: string;
  inlineStrings?: boolean;
  /** Also lists a loss row for the fish and the salt, so every item has one. */
  fullLosses?: boolean;
};

export function sampleNames(suffix = '') {
  return {
    dish: `سمك مشوي${suffix}`,
    sauce: `صلصة${suffix}`,
    rice: `رز${suffix}`,
    fish: `سمك بوري${suffix}`,
    salt: `ملح${suffix}`,
    oil: `زيت ذرة${suffix}`,
    tomato: `طماطم${suffix}`,
    garlic: `ثوم${suffix}`,
    riceRaw: `أرز خام${suffix}`,
    box: `علبة${suffix}`,
  };
}

/** A synthetic workbook shaped like the owner's file. No real data. */
export function sampleWorkbook(options: SampleOptions = {}): Uint8Array {
  const suffix = options.suffix ?? '';
  const n = sampleNames(suffix);
  const recipes: BuilderCell[][] = [];
  const left = place(recipes, 1, 1, {
    name: `${n.dish} `,
    lines: [
      [`${n.fish} `, 300],
      [n.salt, 5],
      [n.sauce, 100],
      [n.oil, 20],
    ],
    padding: 2,
  });
  place(recipes, 1, 8, {
    name: n.rice,
    lines: [
      [n.riceRaw, 200],
      [`${n.salt}  `, 4],
    ],
  });
  const sauce = place(recipes, left.next, 1, {
    name: `${n.sauce}  `,
    lines: [
      [n.tomato, 1500],
      [n.garlic, 100],
      [`${n.oil.replace(' ', '  ')}`, 50],
    ],
    net: 2400,
  });

  const loss: BuilderCell[][] = [
    ['جدول فاقد'],
    [
      'الصنف',
      'الوزن قبل',
      'سعر الكيلو',
      'نسبة الفاقد',
      'الصافي جرام',
      'سعر الصافي',
      null,
      'تحضيرات',
      null,
      null,
      null,
      'تغليف',
    ],
    [
      n.tomato,
      1000,
      123.45,
      0.2,
      800,
      154.31,
      null,
      n.sauce,
      2400,
      321.12,
      '7ك',
      n.box,
      2.55,
    ],
    [n.garlic, 1000, 99.99, 0.1, 900, 111.11],
    [n.oil, 1000, 44.44, 0, 1000, 44.44],
  ];
  if (options.fullLosses) {
    loss.push(
      [n.fish, 1000, 99.99, 0.05, 950, 111.11],
      [n.salt, 1000, 44.44, 0, 1000, 44.44],
    );
  }

  const menu: BuilderCell[][] = [
    ['الصنف', 'سعر المنافس', 'سعر البيع', 'نسبة التكلفة', 'تغليف', 'التكلفة'],
    [
      n.dish,
      99.99,
      120,
      0.3,
      2.55,
      { formula: `'الرسبي '!E${left.totalRow}`, value: 555.55 },
    ],
    [
      n.sauce,
      66.66,
      80,
      0.3,
      2.55,
      { formula: `'الرسبي '!$E$${sauce.totalRow}`, value: 555.55 },
    ],
  ];

  return buildWorkbook(
    [
      { name: 'الرسبي ', rows: recipes },
      { name: 'جدول فاقد', rows: loss },
      { name: ' المنيو', rows: menu },
    ],
    { inlineStrings: options.inlineStrings },
  );
}
