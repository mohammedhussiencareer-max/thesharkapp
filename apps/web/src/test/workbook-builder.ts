import { strToU8, zipSync } from 'fflate';

export type BuilderCell =
  string | number | null | { formula: string; value?: number | string };

export type BuilderSheet = { name: string; rows: BuilderCell[][] };

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnLetters(index: number): string {
  let rest = index;
  let letters = '';
  while (rest > 0) {
    const part = (rest - 1) % 26;
    letters = String.fromCharCode(65 + part) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}

/** A minimal .xlsx built in code, so no workbook file is ever stored. */
export function buildWorkbook(
  sheets: readonly BuilderSheet[],
  options: { inlineStrings?: boolean } = {},
): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  function stringCell(address: string, text: string): string {
    if (options.inlineStrings) {
      return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }
    let index = sharedIndex.get(text);
    if (index === undefined) {
      index = shared.length;
      shared.push(text);
      sharedIndex.set(text, index);
    }
    return `<c r="${address}" t="s"><v>${index}</v></c>`;
  }

  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, sheetIndex) => {
    const rows = sheet.rows
      .map((cells, rowIndex) => {
        const row = rowIndex + 1;
        const body = cells
          .map((cell, colIndex) => {
            if (cell === null) return '';
            const address = `${columnLetters(colIndex + 1)}${row}`;
            if (typeof cell === 'string') return stringCell(address, cell);
            if (typeof cell === 'number') {
              return `<c r="${address}"><v>${cell}</v></c>`;
            }
            const formula = `<f>${escapeXml(cell.formula)}</f>`;
            if (typeof cell.value === 'string') {
              return `<c r="${address}" t="str">${formula}<v>${escapeXml(cell.value)}</v></c>`;
            }
            const value =
              cell.value === undefined ? '' : `<v>${cell.value}</v>`;
            return `<c r="${address}">${formula}${value}</c>`;
          })
          .join('');
        return `<row r="${row}">${body}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${sheetIndex + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    );
  });

  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_sheet, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  if (!options.inlineStrings) {
    files['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
        .map(
          (text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`,
        )
        .join('')}</sst>`,
    );
  }
  return zipSync(files);
}
