import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRecipeWorkbook } from '@/recipes/import/parse';
import { readWorkbook } from '@/recipes/import/xlsx';
import { buildWorkbook, type BuilderCell } from '@/test/workbook-builder';

vi.mock('fflate', async () => {
  const actual = await vi.importActual<typeof import('fflate')>('fflate');
  return { ...actual, unzipSync: vi.fn(actual.unzipSync) };
});

const sheetPath = 'xl/worksheets/sheet1.xml';
const coreParts = [
  'xl/_rels/workbook.xml.rels',
  'xl/sharedStrings.xml',
  'xl/workbook.xml',
];
const mebibyte = 1024 * 1024;

let inflated: string[] = [];
let actualUnzip: typeof unzipSync;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('fflate')>('fflate');
  actualUnzip = actual.unzipSync;
  vi.mocked(unzipSync).mockImplementation((data, options) =>
    actual.unzipSync(data, {
      ...options,
      filter: (file) => {
        const keep = options?.filter ? options.filter(file) : true;
        if (keep) inflated.push(file.name);
        return keep;
      },
    }),
  );
});

const blockRows: BuilderCell[][] = [
  ['اسم الصنف', 'طبق'],
  ['المكونات', 'المعيار'],
  ['ملح', 5],
  ['فلفل', 3],
];

function baseWorkbook(): Uint8Array {
  return buildWorkbook([{ name: 'الرسبي', rows: blockRows }]);
}

function rewrite(
  bytes: Uint8Array,
  change: (files: Record<string, Uint8Array>) => void,
): Uint8Array {
  const files = actualUnzip(bytes);
  change(files);
  return zipSync(files, { level: 1 });
}

function withCells(rows: string): Uint8Array {
  return rewrite(baseWorkbook(), (files) => {
    files[sheetPath] = strToU8(
      strFromU8(files[sheetPath]!).replace(
        '</sheetData>',
        `${rows}</sheetData>`,
      ),
    );
  });
}

function declareSize(
  bytes: Uint8Array,
  entry: string,
  size: number,
): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  for (let at = 0; at + 46 <= copy.length; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(at + 28, true);
    const name = strFromU8(copy.subarray(at + 46, at + 46 + nameLength));
    if (name === entry) view.setUint32(at + 24, size, true);
  }
  return copy;
}

function refused(bytes: Uint8Array, code: string): void {
  inflated = [];
  expect(() => readWorkbook(bytes)).toThrowError(
    expect.objectContaining({ code }),
  );
}

describe('readWorkbook archive limits', () => {
  it('inflates only the workbook parts and the sheets it lists', () => {
    const bytes = rewrite(baseWorkbook(), (files) => {
      files['xl/worksheets/sheet9.xml'] = strToU8('<unlisted/>');
      files['xl/media/image1.png'] = new Uint8Array(2048);
    });
    inflated = [];
    expect(readWorkbook(bytes)).toHaveLength(1);
    expect([...inflated].sort()).toEqual([...coreParts, sheetPath].sort());
  });

  it('refuses an archive with too many entries without inflating any', () => {
    const zeros = new Uint8Array(1024);
    const bytes = rewrite(baseWorkbook(), (files) => {
      for (let index = 0; index < 1200; index += 1) {
        files[`xl/worksheets/extra${index}.xml`] = zeros;
      }
    });
    refused(bytes, 'too_much_data');
    expect(inflated).toEqual([]);
  });

  it('refuses sheets that together inflate past the limit before inflating one', () => {
    const big = new Uint8Array(10 * mebibyte).fill(32);
    const names = Array.from({ length: 8 }, (_, index) => ({
      name: `شيت ${index}`,
      rows: [['x']],
    }));
    const bytes = rewrite(buildWorkbook(names), (files) => {
      for (let index = 1; index <= 8; index += 1) {
        files[`xl/worksheets/sheet${index}.xml`] = big;
      }
    });
    expect(bytes.byteLength).toBeLessThan(mebibyte);
    refused(bytes, 'too_much_data');
    expect(inflated.filter((name) => name.includes('worksheets'))).toEqual([]);
  });

  it('goes by the sizes in the zip directory, not by the data', () => {
    const bytes = declareSize(baseWorkbook(), sheetPath, 80 * mebibyte);
    refused(bytes, 'too_much_data');
    expect(inflated.filter((name) => name.includes('worksheets'))).toEqual([]);
  });
});

describe('cell coordinates', () => {
  const stray =
    '<row r="5000"><c r="A5000" t="inlineStr"><is><t>غريب</t></is></c><c r="B5000"><v>7</v></c></row>';

  it.each([
    'A1000000000000',
    `A${'9'.repeat(400)}`,
    'A0',
    'A01',
    'A1048577',
    'XFE1',
    'AAAA1',
    'a1',
    '1A',
    'A1.5',
    '',
  ])('refuses the cell address %j', (reference) => {
    const bytes = withCells(
      `<row r="9"><c r="${reference}"><v>1</v></c></row>`,
    );
    refused(bytes, 'bad_cell');
  });

  it('refuses a far cell fast instead of scanning to it', () => {
    const bytes = withCells(
      '<row r="9"><c r="A1000000000000"><v>1</v></c></row>',
    );
    const started = performance.now();
    expect(() => parseRecipeWorkbook(bytes)).toThrowError(
      expect.objectContaining({ code: 'bad_cell' }),
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('accepts the last cell of the grid and still reads the block', () => {
    const bytes = withCells(
      '<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>',
    );
    const started = performance.now();
    const parsed = parseRecipeWorkbook(bytes);
    expect(parsed.blocks[0]?.lines.map((line) => line.name)).toEqual([
      'ملح',
      'فلفل',
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('does not read a block far below its marker when it has no total row', () => {
    const parsed = parseRecipeWorkbook(withCells(stray));
    expect(parsed.blocks[0]?.lines.map((line) => line.name)).toEqual([
      'ملح',
      'فلفل',
    ]);
  });

  it('refuses a sheet with thousands of blocks', () => {
    const rows: BuilderCell[][] = Array.from({ length: 2001 }, (_, index) => [
      'اسم الصنف',
      `طبق ${index}`,
    ]);
    const bytes = buildWorkbook([{ name: 'الرسبي', rows }]);
    expect(() => parseRecipeWorkbook(bytes)).toThrowError(
      expect.objectContaining({ code: 'too_large' }),
    );
  });
});
