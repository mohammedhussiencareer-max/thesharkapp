import { describe, expect, it } from 'vitest';
import { parseRecipeWorkbook } from '@/recipes/import/parse';
import { WorkbookReadError } from '@/recipes/import/xlsx';
import {
  sampleNames,
  samplePriceValues,
  sampleWorkbook,
} from '@/test/sample-workbook';
import { buildWorkbook, type BuilderCell } from '@/test/workbook-builder';

const names = sampleNames();

function blockRows(
  name: string,
  rows: BuilderCell[][],
  tail: BuilderCell[][] = [],
): BuilderCell[][] {
  return [
    ['اسم الصنف', name],
    ['المكونات', 'المعيار', 'سعر المعيار'],
    ...rows,
    ['الاجمالى', '', '', { formula: 'SUM(D3:D4)', value: 5 }, 'سعر البيع', 9],
    ...tail,
  ];
}

describe('parseRecipeWorkbook', () => {
  it('finds side-by-side blocks, ignoring padding and keeping trailing-space names', () => {
    const parsed = parseRecipeWorkbook(sampleWorkbook());
    expect(parsed.blocks.map((block) => block.name)).toEqual([
      names.dish,
      names.rice,
      names.sauce,
    ]);
    const dish = parsed.blocks[0]!;
    expect(dish.lines.map((line) => [line.name, line.qty])).toEqual([
      [names.fish, '300'],
      [names.salt, '5'],
      [names.sauce, '100'],
      [names.oil, '20'],
    ]);
    expect(dish.paddingRows).toBe(2);
    expect(dish.batchQty).toBeNull();
    const rice = parsed.blocks[1]!;
    expect(rice.lines.map((line) => line.qty)).toEqual(['200', '4']);
    expect(rice.lines[1]?.name).toBe(names.salt);
  });

  it('reads the net row as the only batch quantity and never sums', () => {
    const parsed = parseRecipeWorkbook(sampleWorkbook());
    const sauce = parsed.blocks.find((block) => block.name === names.sauce)!;
    expect(sauce.batchQty).toBe('2400');
    expect(sauce.lines.reduce((sum, line) => sum + Number(line.qty), 0)).toBe(
      1650,
    );
    expect(parsed.blocks[0]?.batchQty).toBeNull();
    expect(parsed.blocks[1]?.batchQty).toBeNull();
  });

  it('reads the same blocks from inline strings and from shared strings', () => {
    const shared = parseRecipeWorkbook(sampleWorkbook());
    const inline = parseRecipeWorkbook(sampleWorkbook({ inlineStrings: true }));
    expect(inline).toEqual(shared);
  });

  it('reads loss ratios and lists batch and packaging names only as hints', () => {
    const parsed = parseRecipeWorkbook(sampleWorkbook());
    expect(parsed.losses.map((loss) => [loss.name, loss.fraction])).toEqual([
      [names.tomato, '0.2'],
      [names.garlic, '0.1'],
      [names.oil, '0'],
    ]);
    expect(parsed.batchNames).toEqual([names.sauce]);
    expect(parsed.packagingNames).toEqual([names.box]);
    for (const block of parsed.blocks) {
      expect(block.batchQty === '7' || block.batchQty === '7000').toBe(false);
    }
  });

  it('maps menu formulas to blocks as suggestions', () => {
    const parsed = parseRecipeWorkbook(sampleWorkbook());
    expect(parsed.menuLinks).toEqual([
      { menuName: names.dish, blockId: 0 },
      { menuName: names.sauce, blockId: 2 },
    ]);
  });

  it('keeps no price, position or formula in the parsed model', () => {
    const text = JSON.stringify(parseRecipeWorkbook(sampleWorkbook()));
    for (const price of samplePriceValues) {
      expect(text).not.toContain(String(price));
    }
    expect(text).not.toMatch(/SUM|formula|price|cost|[A-Z]\d{1,3}!/i);
  });

  it('counts empty rows and skips rows without a usable quantity, with warnings', () => {
    const sheet = blockRows(
      'طبق',
      [
        ['ملح', 5],
        ['', null, 12],
        ['فلفل', null],
        ['كمون', 'حسب الطلب'],
        ['شطة', '3 رطل'],
        ['ليمون', '٢٫٥ جم'],
        ['', 7],
        ['زعتر', 0],
        ['', 1],
      ],
      [['صافى', '1.5 كيلو']],
    );
    const parsed = parseRecipeWorkbook(
      buildWorkbook([{ name: 'الرسبي ', rows: sheet }]),
    );
    const block = parsed.blocks[0]!;
    expect(block.lines.map((line) => [line.name, line.qty, line.unit])).toEqual(
      [
        ['ملح', '5', null],
        ['ليمون', '2.5', 'g'],
      ],
    );
    expect(block.paddingRows).toBe(1);
    expect(block.emptyRows).toBe(1);
    expect(block.skippedRows).toBe(5);
    expect(block.batchQty).toBe('1.5');
    expect(block.batchUnit).toBe('kg');
    expect(parsed.warnings.map((warning) => warning.code).sort()).toEqual([
      'bad_quantity',
      'bad_quantity',
      'no_ingredient_name',
      'no_quantity',
      'unknown_unit',
    ]);
    expect(
      parsed.warnings.find((warning) => warning.code === 'unknown_unit')
        ?.detail,
    ).toBe('شطة: رطل');
  });

  it('warns about a bad net row, a conflicting net row and a missing header', () => {
    const sheet: BuilderCell[][] = [
      ['اسم الصنف', 'أ'],
      ['ملح', 5],
      ['صافى', 'كثير'],
      [],
      ['اسم الصنف', 'ب'],
      ['المكونات', 'المعيار'],
      ['ملح', 5],
      ['صافى', 100],
      ['صافى', 200],
    ];
    const parsed = parseRecipeWorkbook(
      buildWorkbook([{ name: 'الرسبي', rows: sheet }]),
    );
    expect(parsed.blocks.map((block) => block.batchQty)).toEqual([null, '100']);
    expect(parsed.warnings.map((warning) => warning.code).sort()).toEqual([
      'bad_batch_qty',
      'conflicting_batch_qty',
      'no_header',
    ]);
  });

  it('flags duplicate and empty blocks', () => {
    const sheet: BuilderCell[][] = [
      ...blockRows('طبق', [['ملح', 5]]),
      [],
      ...blockRows('طبق ', [['فلفل', 2]]),
      [],
      ...blockRows('فاضي', []),
    ];
    const parsed = parseRecipeWorkbook(
      buildWorkbook([{ name: 'الرسبي ', rows: sheet }]),
    );
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.warnings.map((warning) => warning.code).sort()).toEqual([
      'duplicate_block',
      'empty_block',
    ]);
  });

  it('warns about unreadable loss ratios without importing them', () => {
    const loss: BuilderCell[][] = [
      ['الصنف', 'قبل', 'سعر', 'نسبة الفاقد', 'بعد'],
      ['ملح', 100, 5, 1.5, 0],
      ['فلفل', 100, 5, '5%', 95],
      ['فلفل', 100, 5, 0.1, 90],
      ['كمون', 100, 5, null, 90],
    ];
    const parsed = parseRecipeWorkbook(
      buildWorkbook([
        { name: 'الرسبي ', rows: blockRows('طبق', [['ملح', 5]]) },
        { name: 'جدول فاقد', rows: loss },
      ]),
    );
    expect(parsed.losses).toEqual([
      { name: 'فلفل', norm: 'فلفل', fraction: '0.05' },
    ]);
    expect(parsed.warnings.map((warning) => warning.code).sort()).toEqual([
      'duplicate_loss',
      'loss_out_of_range',
    ]);
  });

  it('works with only the recipe sheet and finds the sheet by its content', () => {
    const parsed = parseRecipeWorkbook(
      buildWorkbook([
        { name: 'شيت', rows: blockRows('طبق', [['ملح', 5]]) },
        { name: 'تاني', rows: [['x']] },
      ]),
    );
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.sheets).toEqual({ recipes: true, loss: false, menu: false });
    expect(parsed.losses).toEqual([]);
  });

  it('refuses a workbook without recipes and a file that is not a workbook', () => {
    expect(() =>
      parseRecipeWorkbook(buildWorkbook([{ name: 'شيت', rows: [['x']] }])),
    ).toThrowError(WorkbookReadError);
    expect(() =>
      parseRecipeWorkbook(new Uint8Array([1, 2, 3, 4])),
    ).toThrowError(expect.objectContaining({ code: 'not_xlsx' }));
  });
});
