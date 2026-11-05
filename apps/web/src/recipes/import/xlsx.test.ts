import {
  deflateSync,
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type FlateStreamHandler,
} from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRecipeWorkbook } from '@/recipes/import/parse';
import { maxWorkbookBytes, readWorkbook } from '@/recipes/import/xlsx';
import { sampleWorkbook } from '@/test/sample-workbook';
import { buildWorkbook, type BuilderCell } from '@/test/workbook-builder';

const counter = vi.hoisted(() => ({ inflates: 0 }));

vi.mock('fflate', async () => {
  const actual = await vi.importActual<typeof import('fflate')>('fflate');
  class CountingInflate extends actual.Inflate {
    constructor(handler: FlateStreamHandler) {
      super(handler);
      counter.inflates += 1;
    }
  }
  return { ...actual, Inflate: CountingInflate };
});

const sheetPath = 'xl/worksheets/sheet1.xml';
const coreParts = [
  'xl/_rels/workbook.xml.rels',
  'xl/sharedStrings.xml',
  'xl/workbook.xml',
];
const mebibyte = 1024 * 1024;

beforeEach(() => {
  counter.inflates = 0;
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

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function rewrite(
  bytes: Uint8Array,
  change: (files: Record<string, Uint8Array>) => void,
): Uint8Array {
  const files = unzipSync(bytes);
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

type RawEntry = {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  size?: number;
  sharesDataOf?: string;
  localExtra?: number;
  descriptor?: boolean;
};

/** A zip written by hand, so sizes and offsets can disagree with the data. */
function rawZip(entries: RawEntry[]): Uint8Array {
  const body: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  const offsets = new Map<string, number>();
  let position = 0;
  const add = (part: Uint8Array): void => {
    body.push(part);
    position += part.length;
  };
  for (const entry of entries) {
    const name = strToU8(entry.name);
    const method = entry.method ?? 0;
    const size = entry.size ?? entry.data.length;
    const flags = entry.descriptor ? 8 : 0;
    if (!entry.sharesDataOf) {
      offsets.set(entry.name, position);
      const extra = entry.localExtra ?? 0;
      const header = new Uint8Array(30 + name.length + extra);
      const local = new DataView(header.buffer);
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, flags, true);
      local.setUint16(8, method, true);
      if (!entry.descriptor) {
        local.setUint32(18, entry.data.length, true);
        local.setUint32(22, size, true);
      }
      local.setUint16(26, name.length, true);
      local.setUint16(28, extra, true);
      header.set(name, 30);
      add(header);
      add(entry.data);
      if (entry.descriptor) {
        const tail = new Uint8Array(16);
        const after = new DataView(tail.buffer);
        after.setUint32(0, 0x08074b50, true);
        after.setUint32(8, entry.data.length, true);
        after.setUint32(12, size, true);
        add(tail);
      }
    }
    const record = new Uint8Array(46 + name.length);
    const central = new DataView(record.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, flags, true);
    central.setUint16(10, method, true);
    central.setUint32(20, entry.data.length, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(
      42,
      offsets.get(entry.sharesDataOf ?? entry.name) ?? 0,
      true,
    );
    record.set(name, 46);
    directory.push(record);
  }
  const listing = concat(directory);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, entries.length, true);
  tail.setUint16(10, entries.length, true);
  tail.setUint32(12, listing.length, true);
  tail.setUint32(16, position, true);
  return concat([...body, listing, end]);
}

function storedCore(files: Record<string, Uint8Array>): RawEntry[] {
  return coreParts.map((name) => ({ name, data: files[name]! }));
}

/** Stored sheets 2..n point at the data of sheet 1, which is padded to `padding` bytes. */
function sharedSheets(
  sheets: number,
  padding: number,
  declared?: number,
): Uint8Array {
  const files = unzipSync(
    buildWorkbook(
      Array.from({ length: sheets }, (_, index) => ({
        name: `شيت ${index + 1}`,
        rows: blockRows,
      })),
    ),
  );
  const first = concat([files[sheetPath]!, new Uint8Array(padding).fill(32)]);
  const entries = [...storedCore(files), { name: sheetPath, data: first }];
  for (let index = 2; index <= sheets; index += 1) {
    entries.push({
      name: `xl/worksheets/sheet${index}.xml`,
      data: first,
      sharesDataOf: sheetPath,
      size: declared,
    });
  }
  return rawZip(entries);
}

function refused(bytes: Uint8Array, code: string): void {
  counter.inflates = 0;
  expect(() => readWorkbook(bytes)).toThrowError(
    expect.objectContaining({ code }),
  );
}

describe('readWorkbook archive limits', () => {
  it('reads only the workbook parts and the sheets it lists', () => {
    const bytes = declareSize(
      rewrite(baseWorkbook(), (files) => {
        files['xl/worksheets/sheet9.xml'] = strToU8('<unlisted/>');
        files['xl/media/image1.png'] = new Uint8Array(2048);
      }),
      'xl/worksheets/sheet9.xml',
      80 * mebibyte,
    );
    expect(readWorkbook(bytes)).toHaveLength(1);
    expect(counter.inflates).toBeLessThanOrEqual(coreParts.length + 1);
  });

  it('refuses an archive with too many entries without inflating any', () => {
    const zeros = new Uint8Array(1024);
    const bytes = rewrite(baseWorkbook(), (files) => {
      for (let index = 0; index < 1200; index += 1) {
        files[`xl/worksheets/extra${index}.xml`] = zeros;
      }
    });
    refused(bytes, 'too_much_data');
    expect(counter.inflates).toBe(0);
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
    expect(counter.inflates).toBeLessThanOrEqual(coreParts.length);
  });

  it('refuses a declared size past the limit before inflating the sheet', () => {
    const bytes = declareSize(baseWorkbook(), sheetPath, 80 * mebibyte);
    refused(bytes, 'too_much_data');
    expect(counter.inflates).toBeLessThanOrEqual(coreParts.length);
  });

  it('refuses a file over the size cap', () => {
    refused(new Uint8Array(maxWorkbookBytes + 1), 'too_large');
    expect(counter.inflates).toBe(0);
  });
});

describe('sizes that disagree with the data', () => {
  const realSize = unzipSync(baseWorkbook())[sheetPath]!.length;

  it.each([
    [5, mebibyte],
    [40, 18 * mebibyte],
  ])(
    'refuses %i stored sheets that share data and under-declare their size',
    (sheets, padding) => {
      refused(sharedSheets(sheets, padding, 1), 'not_xlsx');
    },
  );

  it('refuses stored sheets that share data even when the sizes add up', () => {
    refused(sharedSheets(5, mebibyte), 'not_xlsx');
  });

  it.each([5, -1])(
    'refuses a stored sheet whose size is off by %i from its data',
    (change) => {
      const files = unzipSync(baseWorkbook());
      const data = files[sheetPath]!;
      const bytes = rawZip([
        ...storedCore(files),
        { name: sheetPath, data, size: data.length + change },
      ]);
      refused(bytes, 'not_xlsx');
    },
  );

  it.each([10, realSize - 1])(
    'refuses a deflated sheet that declares %i bytes instead of truncating it',
    (declared) => {
      refused(declareSize(baseWorkbook(), sheetPath, declared), 'not_xlsx');
    },
  );

  it('refuses a deflated sheet that declares more than it holds', () => {
    refused(declareSize(baseWorkbook(), sheetPath, realSize + 1), 'not_xlsx');
  });

  it('stops a small deflated bomb that declares a tiny size', () => {
    const bytes = declareSize(
      rewrite(baseWorkbook(), (files) => {
        files[sheetPath] = concat([
          files[sheetPath]!,
          new Uint8Array(8 * mebibyte).fill(32),
        ]);
      }),
      sheetPath,
      100,
    );
    expect(bytes.byteLength).toBeLessThan(mebibyte);
    refused(bytes, 'not_xlsx');
  });

  it('refuses two entries whose data overlap', () => {
    const files = unzipSync(baseWorkbook());
    const bytes = rawZip([
      ...storedCore(files),
      { name: sheetPath, data: files[sheetPath]! },
      {
        name: 'xl/worksheets/sheet2.xml',
        data: files[sheetPath]!,
        sharesDataOf: sheetPath,
      },
    ]);
    refused(bytes, 'not_xlsx');
  });

  it('refuses a truncated file and a repeated entry name', () => {
    refused(baseWorkbook().slice(0, 100), 'not_xlsx');
    const files = unzipSync(baseWorkbook());
    refused(
      rawZip([
        ...storedCore(files),
        { name: sheetPath, data: files[sheetPath]! },
        { name: sheetPath, data: files[sheetPath]! },
      ]),
      'not_xlsx',
    );
  });
});

describe('real-world workbooks', () => {
  it('reads the sample workbook', () => {
    const bytes = sampleWorkbook();
    expect(readWorkbook(bytes).length).toBeGreaterThan(0);
    expect(parseRecipeWorkbook(bytes).blocks.length).toBeGreaterThan(0);
  });

  it('reads deflated entries with data descriptors and local extra fields', () => {
    const files = unzipSync(baseWorkbook());
    const bytes = rawZip(
      [...coreParts, sheetPath].map((name) => ({
        name,
        data: deflateSync(files[name]!),
        method: 8 as const,
        size: files[name]!.length,
        descriptor: true,
        localExtra: 12,
      })),
    );
    expect(readWorkbook(bytes)).toEqual(readWorkbook(baseWorkbook()));
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
