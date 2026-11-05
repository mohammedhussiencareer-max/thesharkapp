import { collapseSpaces, normalizeName } from '@/recipes/import/normalize';
import {
  decimalText,
  readWorkbook,
  WorkbookReadError,
  type Cell,
  type Sheet,
} from '@/recipes/import/xlsx';

export type SourceUnit = 'g' | 'ml' | 'kg' | 'liter' | 'piece';

export type ParsedLine = {
  name: string;
  norm: string;
  /** Exact decimal text from the quantity column. */
  qty: string;
  /** Set only when the cell itself names a unit. */
  unit: SourceUnit | null;
};

export type ParsedBlock = {
  id: number;
  name: string;
  norm: string;
  lines: ParsedLine[];
  /** Only an explicit net row gives this. It is never summed. */
  batchQty: string | null;
  batchUnit: SourceUnit | null;
  paddingRows: number;
  emptyRows: number;
  skippedRows: number;
};

export type ParsedLoss = {
  name: string;
  norm: string;
  /** Loss as a fraction in [0, 1), at most five places. */
  fraction: string;
};

export type ParsedMenuLink = { menuName: string; blockId: number };

export type ParseWarningCode =
  | 'unknown_unit'
  | 'bad_quantity'
  | 'no_quantity'
  | 'no_ingredient_name'
  | 'bad_batch_qty'
  | 'conflicting_batch_qty'
  | 'no_header'
  | 'empty_block'
  | 'unnamed_block'
  | 'duplicate_block'
  | 'loss_out_of_range'
  | 'duplicate_loss'
  | 'no_loss_table';

export type ParseWarning = {
  code: ParseWarningCode;
  subject: string;
  detail?: string;
};

export type ParsedWorkbook = {
  blocks: ParsedBlock[];
  losses: ParsedLoss[];
  /** Names listed as batches in the loss sheet. A hint, never a yield. */
  batchNames: string[];
  /** Names in the packaging list. Suggestions only. */
  packagingNames: string[];
  /** Menu items whose cost cell points at a block. Suggestions only. */
  menuLinks: ParsedMenuLink[];
  warnings: ParseWarning[];
  sheets: { recipes: boolean; loss: boolean; menu: boolean };
};

const recipeSheetName = 'الرسبي';
const lossSheetName = 'جدول فاقد';
const menuSheetName = 'المنيو';
const blockWidth = 6;
const netLookahead = 6;
/** A block is read at most this far below its marker, whatever the sheet holds. */
const maxBlockRows = 1000;
const maxBlocks = 2000;

const unitWords: Record<string, SourceUnit> = {
  g: 'g',
  gm: 'g',
  gr: 'g',
  جم: 'g',
  جرام: 'g',
  جرم: 'g',
  غ: 'g',
  غرام: 'g',
  ml: 'ml',
  مل: 'ml',
  ملل: 'ml',
  مللي: 'ml',
  kg: 'kg',
  kgs: 'kg',
  كجم: 'kg',
  كيلو: 'kg',
  ك: 'kg',
  l: 'liter',
  lt: 'liter',
  ltr: 'liter',
  liter: 'liter',
  لتر: 'liter',
  ل: 'liter',
  piece: 'piece',
  pcs: 'piece',
  pc: 'piece',
  قطعة: 'piece',
  حبة: 'piece',
  حبه: 'piece',
};

const easternDigits = /[٠-٩]/g;

function westernDigits(text: string): string {
  return text
    .replace(easternDigits, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.')
    .replace(/٬/g, '');
}

function textOf(cell: Cell | undefined): string {
  if (!cell) return '';
  if (cell.text !== null) return collapseSpaces(cell.text);
  if (cell.number !== null) return decimalText(cell.number) ?? '';
  return '';
}

type Quantity =
  | { kind: 'empty' }
  | { kind: 'ok'; qty: string; unit: SourceUnit | null }
  | { kind: 'bad' }
  | { kind: 'unit'; text: string };

function readQuantity(cell: Cell | undefined): Quantity {
  if (!cell) return { kind: 'empty' };
  if (cell.number !== null) {
    const qty = decimalText(cell.number);
    return qty !== null && cell.number > 0
      ? { kind: 'ok', qty, unit: null }
      : { kind: 'bad' };
  }
  const raw =
    cell.text === null ? '' : westernDigits(collapseSpaces(cell.text));
  if (raw === '') return { kind: 'empty' };
  const match = /^(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(raw);
  if (!match) return { kind: 'bad' };
  const value = Number((match[1] ?? '').replace(',', '.'));
  const qty = decimalText(value);
  if (qty === null || !(value > 0)) return { kind: 'bad' };
  const word = match[2] ?? '';
  if (word === '') return { kind: 'ok', qty, unit: null };
  const unit = unitWords[normalizeName(word).toLowerCase()];
  return unit ? { kind: 'ok', qty, unit } : { kind: 'unit', text: word };
}

function cellAt(sheet: Sheet, row: number, col: number): Cell | undefined {
  return sheet.rows.get(row)?.get(col);
}

function lastRowOf(sheet: Sheet): number {
  let last = 0;
  for (const row of sheet.rows.keys()) if (row > last) last = row;
  return last;
}

function sortedRows(sheet: Sheet): number[] {
  return Array.from(sheet.rows.keys()).sort((left, right) => left - right);
}

function sortedCols(sheet: Sheet, row: number): number[] {
  return Array.from(sheet.rows.get(row)?.keys() ?? []).sort(
    (left, right) => left - right,
  );
}

type Marker = { row: number; col: number };

function findMarkers(sheet: Sheet): Marker[] {
  const markers: Marker[] = [];
  for (const row of sortedRows(sheet)) {
    for (const col of sortedCols(sheet, row)) {
      const label = normalizeName(textOf(cellAt(sheet, row, col))).replace(
        /\s*[:：]$/,
        '',
      );
      if (label === 'اسم الصنف') markers.push({ row, col });
    }
  }
  return markers;
}

type Region = { col: number; rowStart: number; rowEnd: number };

function isTotalLabel(label: string): boolean {
  return (
    label === 'الاجمالي' || label === 'اجمالي' || label.startsWith('الاجمالي ')
  );
}

function isNetLabel(label: string): boolean {
  return label === 'صافي' || label.startsWith('صافي ');
}

function parseBlock(
  sheet: Sheet,
  id: number,
  marker: Marker,
  rowEnd: number,
  warnings: ParseWarning[],
): ParsedBlock | null {
  const col = marker.col;
  const name =
    textOf(cellAt(sheet, marker.row, col + 1)) ||
    textOf(cellAt(sheet, marker.row, col + 2));
  if (name === '') {
    warnings.push({ code: 'unnamed_block', subject: '' });
    return null;
  }

  let headerRow: number | null = null;
  for (
    let row = marker.row + 1;
    row <= Math.min(marker.row + 2, rowEnd);
    row++
  ) {
    if (normalizeName(textOf(cellAt(sheet, row, col))) === 'المكونات') {
      headerRow = row;
      break;
    }
  }
  if (headerRow === null) warnings.push({ code: 'no_header', subject: name });

  const block: ParsedBlock = {
    id,
    name,
    norm: normalizeName(name),
    lines: [],
    batchQty: null,
    batchUnit: null,
    paddingRows: 0,
    emptyRows: 0,
    skippedRows: 0,
  };

  function takeNet(row: number): void {
    const quantity = readQuantity(cellAt(sheet, row, col + 1));
    if (quantity.kind !== 'ok') {
      warnings.push({ code: 'bad_batch_qty', subject: name });
      return;
    }
    if (block.batchQty === null) {
      block.batchQty = quantity.qty;
      block.batchUnit = quantity.unit;
    } else if (block.batchQty !== quantity.qty) {
      warnings.push({ code: 'conflicting_batch_qty', subject: name });
    }
  }

  let stoppedAt: number | null = null;
  for (let row = (headerRow ?? marker.row) + 1; row <= rowEnd; row++) {
    const first = textOf(cellAt(sheet, row, col));
    const label = normalizeName(first);
    if (isTotalLabel(label)) {
      stoppedAt = row;
      break;
    }
    if (isNetLabel(label)) {
      takeNet(row);
      stoppedAt = row;
      break;
    }
    const quantity = readQuantity(cellAt(sheet, row, col + 1));
    if (first === '') {
      if (quantity.kind === 'empty') block.emptyRows += 1;
      else if (
        quantity.kind === 'ok' &&
        quantity.qty === '1' &&
        quantity.unit === null
      ) {
        block.paddingRows += 1;
      } else {
        block.skippedRows += 1;
        warnings.push({ code: 'no_ingredient_name', subject: name });
      }
      continue;
    }
    if (quantity.kind === 'ok') {
      block.lines.push({
        name: first,
        norm: normalizeName(first),
        qty: quantity.qty,
        unit: quantity.unit,
      });
      continue;
    }
    block.skippedRows += 1;
    if (quantity.kind === 'empty') {
      warnings.push({ code: 'no_quantity', subject: name, detail: first });
    } else if (quantity.kind === 'unit') {
      warnings.push({
        code: 'unknown_unit',
        subject: name,
        detail: `${first}: ${quantity.text}`,
      });
    } else {
      warnings.push({ code: 'bad_quantity', subject: name, detail: first });
    }
  }

  const after = (stoppedAt ?? rowEnd) + 1;
  for (let row = after; row <= Math.min(rowEnd, after + netLookahead); row++) {
    if (isNetLabel(normalizeName(textOf(cellAt(sheet, row, col))))) {
      takeNet(row);
    }
  }

  if (block.lines.length === 0) {
    warnings.push({ code: 'empty_block', subject: name });
  }
  return block;
}

function parseRecipes(
  sheet: Sheet,
  warnings: ParseWarning[],
): { blocks: ParsedBlock[]; regions: Region[] } {
  const markers = findMarkers(sheet);
  if (markers.length > maxBlocks) throw new WorkbookReadError('too_large');
  const lastRow = lastRowOf(sheet);
  const blocks: ParsedBlock[] = [];
  const regions: Region[] = [];
  for (const marker of markers) {
    let rowEnd = Math.min(lastRow, marker.row + maxBlockRows);
    for (const other of markers) {
      if (other.col === marker.col && other.row > marker.row) {
        rowEnd = Math.min(rowEnd, other.row - 1);
      }
    }
    const block = parseBlock(sheet, blocks.length, marker, rowEnd, warnings);
    if (!block) continue;
    blocks.push(block);
    regions.push({ col: marker.col, rowStart: marker.row, rowEnd });
  }
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.norm)) {
      warnings.push({ code: 'duplicate_block', subject: block.name });
    }
    seen.add(block.norm);
  }
  return { blocks, regions };
}

function readRatio(cell: Cell | undefined): number | null {
  if (!cell) return null;
  if (cell.number !== null) return cell.number;
  if (cell.text === null) return null;
  const raw = westernDigits(collapseSpaces(cell.text));
  const match = /^(\d+(?:[.,]\d+)?)\s*(%?)$/.exec(raw);
  if (!match) return null;
  const value = Number((match[1] ?? '').replace(',', '.'));
  return match[2] === '%' ? value / 100 : value;
}

const batchWords = ['تحضير'];
const packagingWords = ['تغليف', 'عبوة', 'عبوات', 'عبوه'];

function sectionNames(
  sheet: Sheet,
  words: readonly string[],
  inLossTable: (row: number, col: number) => boolean,
): string[] {
  const names: string[] = [];
  const lastRow = lastRowOf(sheet);
  for (const row of sortedRows(sheet)) {
    for (const col of sortedCols(sheet, row)) {
      const title = textOf(cellAt(sheet, row, col));
      const norm = normalizeName(title);
      if (
        title.length === 0 ||
        title.length > 30 ||
        inLossTable(row, col) ||
        !words.some((word) => norm.includes(word))
      ) {
        continue;
      }
      let blanks = 0;
      for (let below = row + 1; below <= lastRow && blanks < 2; below++) {
        const cell = cellAt(sheet, below, col);
        const name = cell?.text != null ? textOf(cell) : '';
        if (name === '') {
          blanks += 1;
          continue;
        }
        blanks = 0;
        names.push(name);
      }
    }
  }
  return names;
}

function parseLossSheet(
  sheet: Sheet,
  warnings: ParseWarning[],
): { losses: ParsedLoss[]; batchNames: string[]; packagingNames: string[] } {
  const lastRow = lastRowOf(sheet);
  let headerRow: number | null = null;
  let itemCol = 0;
  let ratioCol = 0;
  for (const row of sortedRows(sheet)) {
    const texts = sortedCols(sheet, row)
      .map((col) => ({
        col,
        norm: normalizeName(
          cellAt(sheet, row, col)?.text != null
            ? textOf(cellAt(sheet, row, col))
            : '',
        ),
      }))
      .filter((entry) => entry.norm !== '');
    if (texts.length < 3) continue;
    const ratio =
      texts.find(
        (entry) => entry.norm.includes('نسبة') && entry.norm.includes('فاقد'),
      ) ??
      texts.find((entry) =>
        ['فاقد', 'الفاقد', '% الفاقد', 'الفاقد %'].includes(entry.norm),
      ) ??
      texts.find((entry) => entry.norm.includes('فاقد'));
    if (!ratio) continue;
    headerRow = row;
    ratioCol = ratio.col;
    itemCol = texts[0]?.col ?? ratio.col;
    break;
  }

  const losses: ParsedLoss[] = [];
  let tableStart = 0;
  let tableEnd = -1;
  if (headerRow === null || itemCol === ratioCol) {
    warnings.push({ code: 'no_loss_table', subject: '' });
  } else {
    const seen = new Set<string>();
    let blanks = 0;
    tableStart = headerRow;
    tableEnd = headerRow;
    for (let row = headerRow + 1; row <= lastRow && blanks < 2; row++) {
      const cell = cellAt(sheet, row, itemCol);
      const name = cell?.text != null ? textOf(cell) : '';
      if (name === '') {
        blanks += 1;
        continue;
      }
      blanks = 0;
      const norm = normalizeName(name);
      if (
        batchWords.some((word) => norm.includes(word)) ||
        packagingWords.some((word) => norm.includes(word))
      ) {
        break;
      }
      tableEnd = row;
      const ratio = readRatio(cellAt(sheet, row, ratioCol));
      if (ratio === null) continue;
      if (!(ratio >= 0 && ratio < 1)) {
        warnings.push({ code: 'loss_out_of_range', subject: name });
        continue;
      }
      if (seen.has(norm)) {
        warnings.push({ code: 'duplicate_loss', subject: name });
        continue;
      }
      const fraction = decimalText(Math.round(ratio * 100000) / 100000);
      if (fraction === null) continue;
      seen.add(norm);
      losses.push({ name, norm, fraction });
    }
  }

  const inLossTable = (row: number, col: number): boolean =>
    col === itemCol && row > tableStart && row <= tableEnd;
  return {
    losses,
    batchNames: sectionNames(sheet, batchWords, inLossTable),
    packagingNames: sectionNames(sheet, packagingWords, inLossTable),
  };
}

const referencePattern =
  /(?:'([^']+)'|([^\s'!,+\-*/()=]+))!\$?([A-Z]{1,3})\$?(\d+)/g;

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index;
}

function parseMenu(
  sheet: Sheet,
  recipeSheet: Sheet,
  blocks: readonly ParsedBlock[],
  regions: readonly Region[],
): ParsedMenuLink[] {
  const recipeKey = normalizeName(recipeSheet.name);
  const links: ParsedMenuLink[] = [];
  const seen = new Set<string>();
  for (const row of sortedRows(sheet)) {
    let menuName = '';
    for (const col of sortedCols(sheet, row)) {
      const cell = cellAt(sheet, row, col);
      const text = cell?.text != null && !cell.formula ? textOf(cell) : '';
      if (text !== '' && !/^[\d.,\s]+$/.test(text)) {
        menuName = text;
        break;
      }
    }
    if (menuName === '') continue;
    for (const col of sortedCols(sheet, row)) {
      const formula = cellAt(sheet, row, col)?.formula;
      if (!formula) continue;
      for (const match of formula.matchAll(referencePattern)) {
        const target = normalizeName(match[1] ?? match[2] ?? '');
        if (target !== recipeKey) continue;
        const refCol = columnIndex(match[3] ?? '');
        const refRow = Number(match[4]);
        const index = regions.findIndex(
          (region) =>
            refCol >= region.col &&
            refCol < region.col + blockWidth &&
            refRow >= region.rowStart &&
            refRow <= region.rowEnd,
        );
        const block = index < 0 ? undefined : blocks[index];
        if (!block) continue;
        const key = `${normalizeName(menuName)}|${block.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ menuName, blockId: block.id });
      }
    }
  }
  return links;
}

function sheetNamed(sheets: readonly Sheet[], name: string): Sheet | undefined {
  return sheets.find((sheet) => normalizeName(sheet.name) === name);
}

export function parseSheets(sheets: readonly Sheet[]): ParsedWorkbook {
  const recipeSheet =
    sheetNamed(sheets, recipeSheetName) ??
    sheets.find((sheet) => findMarkers(sheet).length > 0);
  if (!recipeSheet) throw new WorkbookReadError('no_recipes');
  const warnings: ParseWarning[] = [];
  const { blocks, regions } = parseRecipes(recipeSheet, warnings);
  const lossSheet = sheetNamed(sheets, lossSheetName);
  const menuSheet = sheetNamed(sheets, menuSheetName);
  const loss = lossSheet
    ? parseLossSheet(lossSheet, warnings)
    : { losses: [], batchNames: [], packagingNames: [] };
  return {
    blocks,
    losses: loss.losses,
    batchNames: loss.batchNames,
    packagingNames: loss.packagingNames,
    menuLinks: menuSheet
      ? parseMenu(menuSheet, recipeSheet, blocks, regions)
      : [],
    warnings,
    sheets: {
      recipes: true,
      loss: lossSheet !== undefined,
      menu: menuSheet !== undefined,
    },
  };
}

/** Parses an .xlsx in memory. Prices, positions and formulas are never kept. */
export function parseRecipeWorkbook(bytes: Uint8Array): ParsedWorkbook {
  return parseSheets(readWorkbook(bytes));
}
