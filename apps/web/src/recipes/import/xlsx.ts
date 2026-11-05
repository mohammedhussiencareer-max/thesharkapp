import { strFromU8, unzipSync } from 'fflate';

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
  'not_xlsx' | 'too_large' | 'unreadable' | 'no_recipes';

export const workbookReadMessages: Record<WorkbookReadErrorCode, string> = {
  not_xlsx: 'الملف مش ملف إكسل بصيغة .xlsx',
  too_large: 'الملف كبير أكتر من اللازم',
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
const maxEntryBytes = 64 * 1024 * 1024;
const maxSheets = 40;

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

function sharedStrings(files: Record<string, Uint8Array>): string[] {
  const data = files['xl/sharedStrings.xml'];
  if (!data) return [];
  return elements(parseXml(strFromU8(data)), 'si').map(richText);
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index;
}

function parseSheet(
  name: string,
  data: Uint8Array,
  strings: readonly string[],
): Sheet {
  const rows = new Map<number, Map<number, Cell>>();
  for (const node of elements(parseXml(strFromU8(data)), 'c')) {
    const address = /^([A-Z]+)(\d+)$/.exec(node.getAttribute('r') ?? '');
    if (!address) continue;
    const col = columnIndex(address[1] ?? '');
    const row = Number(address[2]);
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

function sheetPaths(files: Record<string, Uint8Array>): {
  name: string;
  path: string;
}[] {
  const book = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
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

/** Reads every sheet of an .xlsx file. Nothing leaves the browser. */
export function readWorkbook(bytes: Uint8Array): Sheet[] {
  if (bytes.byteLength > maxWorkbookBytes) {
    throw new WorkbookReadError('too_large');
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        const wanted =
          file.name === 'xl/workbook.xml' ||
          file.name === 'xl/_rels/workbook.xml.rels' ||
          file.name === 'xl/sharedStrings.xml' ||
          /^xl\/worksheets\/[^/]+\.xml$/.test(file.name);
        if (wanted && file.originalSize > maxEntryBytes) {
          throw new WorkbookReadError('too_large');
        }
        return wanted;
      },
    });
  } catch (failure) {
    if (failure instanceof WorkbookReadError) throw failure;
    throw new WorkbookReadError('not_xlsx');
  }
  const strings = sharedStrings(files);
  return sheetPaths(files).map(({ name, path }) => {
    const data = files[path];
    if (!data) throw new WorkbookReadError('not_xlsx');
    return parseSheet(name, data, strings);
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
