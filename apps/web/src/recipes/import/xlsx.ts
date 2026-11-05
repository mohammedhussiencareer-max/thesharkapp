import { Inflate, strFromU8 } from 'fflate';

export type Cell = {
  text: string | null;
  number: number | null;
  formula: string | null;
};

export type Sheet = {
  name: string;
  /** Rows and columns are 1-based. */
  rows: Map<number, Map<number, Cell>>;
};

export type WorkbookReadErrorCode =
  | 'not_xlsx'
  | 'too_large'
  | 'too_much_data'
  | 'bad_cell'
  | 'unreadable'
  | 'no_recipes';

export const workbookReadMessages: Record<WorkbookReadErrorCode, string> = {
  not_xlsx: 'الملف مش ملف إكسل بصيغة .xlsx',
  too_large: 'الملف كبير أكتر من اللازم',
  too_much_data: 'الملف فيه ملفات كتير أو بيكبر أوي لما يتفتح، فمش هنفتحه',
  bad_cell: 'الملف فيه خلية عنوانها غلط أو برا حدود الإكسل',
  unreadable: 'مش قادرين نقرا الملف ده',
  no_recipes: 'مفيش شيت الوصفات (الرسبي) في الملف',
};

export class WorkbookReadError extends Error {
  readonly code: WorkbookReadErrorCode;

  constructor(code: WorkbookReadErrorCode) {
    super(workbookReadMessages[code]);
    this.name = 'WorkbookReadError';
    this.code = code;
  }
}

export const maxWorkbookBytes = 20 * 1024 * 1024;
/** Actual bytes of everything extracted: the workbook parts and each listed sheet. */
const maxInflatedBytes = 64 * 1024 * 1024;
const maxEntries = 1000;
/** Input fed to the inflater per step; deflate expands at most about 1000 to 1. */
const inflateStepBytes = 4096;
const maxSheets = 40;
/** Excel's own grid: 1048576 rows and columns A to XFD. */
const maxSheetRows = 1048576;
const maxSheetCols = 16384;
const coreParts = [
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/sharedStrings.xml',
];

const relationshipsNs =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new WorkbookReadError('unreadable');
  }
  return doc;
}

function elements(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function firstChild(parent: Element, name: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.localName === name) return child;
  }
  return null;
}

/** Text of an `si` or `is` node, rich-text runs joined and phonetic hints dropped. */
function richText(node: Element): string {
  return elements(node, 't')
    .filter((part) => part.parentElement?.localName !== 'rPh')
    .map((part) => part.textContent ?? '')
    .join('');
}

function sharedStrings(files: ReadonlyMap<string, Uint8Array>): string[] {
  const data = files.get('xl/sharedStrings.xml');
  if (!data) return [];
  return elements(parseXml(strFromU8(data)), 'si').map(richText);
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index;
}

/** A1-style reference inside Excel's grid, or null. */
function cellPosition(reference: string): { row: number; col: number } | null {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(reference);
  if (!match) return null;
  const col = columnIndex(match[1] ?? '');
  const row = Number(match[2]);
  return col <= maxSheetCols && row <= maxSheetRows ? { row, col } : null;
}

function parseSheet(
  name: string,
  data: Uint8Array,
  strings: readonly string[],
): Sheet {
  const rows = new Map<number, Map<number, Cell>>();
  for (const node of elements(parseXml(strFromU8(data)), 'c')) {
    const reference = node.getAttribute('r');
    if (reference === null) continue;
    const position = cellPosition(reference);
    if (!position) throw new WorkbookReadError('bad_cell');
    const { row, col } = position;
    const type = node.getAttribute('t');
    const value = firstChild(node, 'v')?.textContent ?? null;
    const formulaNode = firstChild(node, 'f');
    const formula = formulaNode?.textContent?.trim()
      ? formulaNode.textContent.trim()
      : null;
    const cell: Cell = { text: null, number: null, formula };
    if (type === 's') {
      cell.text = strings[Number(value)] ?? null;
    } else if (type === 'inlineStr') {
      const inline = firstChild(node, 'is');
      cell.text = inline ? richText(inline) : null;
    } else if (type === 'str') {
      cell.text = value;
    } else if (type === null || type === 'n') {
      const parsed = value === null || value === '' ? NaN : Number(value);
      cell.number = Number.isFinite(parsed) ? parsed : null;
    }
    if (cell.text === null && cell.number === null && cell.formula === null) {
      continue;
    }
    let line = rows.get(row);
    if (!line) {
      line = new Map();
      rows.set(row, line);
    }
    line.set(col, cell);
  }
  return { name, rows };
}

function sheetPaths(files: ReadonlyMap<string, Uint8Array>): {
  name: string;
  path: string;
}[] {
  const book = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (!book || !rels) throw new WorkbookReadError('not_xlsx');
  const targets = new Map<string, string>();
  for (const rel of elements(parseXml(strFromU8(rels)), 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) {
      targets.set(
        id,
        target.startsWith('/') ? target.slice(1) : `xl/${target}`,
      );
    }
  }
  const found: { name: string; path: string }[] = [];
  for (const sheet of elements(parseXml(strFromU8(book)), 'sheet')) {
    const id =
      sheet.getAttributeNS(relationshipsNs, 'id') ?? sheet.getAttribute('r:id');
    const path = id ? targets.get(id) : undefined;
    const name = sheet.getAttribute('name');
    if (path && name !== null) found.push({ name, path });
  }
  if (found.length > maxSheets) throw new WorkbookReadError('too_large');
  return found;
}

type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  /** Bytes stored in the file, from the zip directory. */
  compressed: number;
  /** Bytes the entry must expand to, from the zip directory. */
  size: number;
  /** Where the local header starts. */
  offset: number;
  /** Where the entry data starts, after the local header. */
  start: number;
};

const zip64Marker = 0xffffffff;

/** Zip directory with every entry's data range checked to sit inside the file and not overlap another. */
function readDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const length = bytes.byteLength;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  let end = -1;
  for (let at = length - 22; at >= Math.max(0, length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new WorkbookReadError('not_xlsx');
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  if (count > maxEntries) throw new WorkbookReadError('too_much_data');
  if (directory === zip64Marker) throw new WorkbookReadError('unreadable');
  const entries = new Map<string, ZipEntry>();
  let at = directory;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > length || view.getUint32(at, true) !== 0x02014b50) {
      throw new WorkbookReadError('not_xlsx');
    }
    const nameLength = view.getUint16(at + 28, true);
    const next =
      at +
      46 +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
    if (next > length) throw new WorkbookReadError('not_xlsx');
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const offset = view.getUint32(at + 42, true);
    if (
      compressed === zip64Marker ||
      size === zip64Marker ||
      offset === zip64Marker
    ) {
      throw new WorkbookReadError('unreadable');
    }
    const name = strFromU8(bytes.subarray(at + 46, at + 46 + nameLength));
    if (entries.has(name)) throw new WorkbookReadError('not_xlsx');
    if (offset + 30 > length || view.getUint32(offset, true) !== 0x04034b50) {
      throw new WorkbookReadError('not_xlsx');
    }
    const start =
      offset +
      30 +
      view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true);
    if (start + compressed > length) throw new WorkbookReadError('not_xlsx');
    entries.set(name, {
      name,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      compressed,
      size,
      offset,
      start,
    });
    at = next;
  }
  const byOffset = [...entries.values()].sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < byOffset.length; index += 1) {
    const before = byOffset[index - 1];
    const entry = byOffset[index];
    if (!before || !entry) continue;
    if (entry.offset < before.start + before.compressed) {
      throw new WorkbookReadError('not_xlsx');
    }
  }
  return entries;
}

/** The entry's bytes, which must match its declared size exactly. */
function extract(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.flags & 1) throw new WorkbookReadError('not_xlsx');
  const data = bytes.subarray(entry.start, entry.start + entry.compressed);
  if (entry.method === 0) {
    if (entry.compressed !== entry.size) {
      throw new WorkbookReadError('not_xlsx');
    }
    return data;
  }
  if (entry.method !== 8) throw new WorkbookReadError('not_xlsx');
  const out = new Uint8Array(entry.size);
  let written = 0;
  const stream = new Inflate((chunk) => {
    if (written + chunk.length > out.length) {
      throw new WorkbookReadError('not_xlsx');
    }
    out.set(chunk, written);
    written += chunk.length;
  });
  for (let at = 0; at < data.length; at += inflateStepBytes) {
    const next = Math.min(at + inflateStepBytes, data.length);
    stream.push(data.subarray(at, next), next === data.length);
  }
  if (written !== out.length) throw new WorkbookReadError('not_xlsx');
  return out;
}

function damaged<T>(read: () => T): T {
  try {
    return read();
  } catch (failure) {
    if (failure instanceof WorkbookReadError) throw failure;
    throw new WorkbookReadError('not_xlsx');
  }
}

/** Reads every sheet of an .xlsx file. Nothing leaves the browser. */
export function readWorkbook(bytes: Uint8Array): Sheet[] {
  if (bytes.byteLength > maxWorkbookBytes) {
    throw new WorkbookReadError('too_large');
  }
  const entries = damaged(() => readDirectory(bytes));
  let used = 0;
  const take = (names: readonly string[]): Map<string, Uint8Array> => {
    const wanted = [...new Set(names)].flatMap((name) => {
      const entry = entries.get(name);
      return entry ? [entry] : [];
    });
    const declared = wanted.reduce((sum, entry) => sum + entry.size, 0);
    if (used + declared > maxInflatedBytes) {
      throw new WorkbookReadError('too_much_data');
    }
    const files = new Map<string, Uint8Array>();
    for (const entry of wanted) {
      const data = damaged(() => extract(bytes, entry));
      used += data.length;
      if (used > maxInflatedBytes) throw new WorkbookReadError('too_much_data');
      files.set(entry.name, data);
    }
    return files;
  };
  const core = take(coreParts);
  const strings = sharedStrings(core);
  const sheets = sheetPaths(core);
  const files = take(sheets.map((sheet) => sheet.path));
  const parsed = new Map<string, Sheet>();
  return sheets.map(({ name, path }) => {
    const data = files.get(path);
    if (!data) throw new WorkbookReadError('not_xlsx');
    let sheet = parsed.get(path);
    if (!sheet) {
      sheet = parseSheet(name, data, strings);
      parsed.set(path, sheet);
    }
    return { name, rows: sheet.rows };
  });
}

/** Shortest exact decimal text of a worksheet number, without float noise. */
export function decimalText(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const cleaned = Number(value.toPrecision(15));
  const text = String(cleaned);
  if (!/e/i.test(text)) return text;
  return cleaned.toFixed(12).replace(/\.?0+$/, '');
}
