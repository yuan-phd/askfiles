import readXlsxFile from 'read-excel-file/node';
import { docTitleOf } from './text.js';
import type { ParsedDocument, Section } from './types.js';

type Cell = string | number | boolean | Date | null | undefined;

function cellText(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // Dates without a time of day are written as dates only; read-excel-file gives UTC midnight.
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

/**
 * One sheet as text. When the first non-empty row is all text it is taken as the header, and every
 * later row is written as header: value pairs, so a sub-chunk cut from the middle of a long table
 * still says what each number is. Otherwise rows are cells joined by a vertical bar.
 */
export function sheetToText(rows: Cell[][]): string {
  const data = rows.map((r) => r.map(cellText)).filter((r) => r.some(Boolean));
  if (!data.length) return '';
  const first = rows.find((r) => r.some((c) => cellText(c)));
  const isHeader =
    data.length > 1 &&
    first !== undefined &&
    first.every((c) => c === null || c === undefined || typeof c === 'string') &&
    data[0]!.filter(Boolean).length >= 2;
  if (!isHeader) return data.map((r) => r.join(' | ')).join('\n');
  const header = data[0]!;
  const lines = [header.filter(Boolean).join(' | ')];
  for (const r of data.slice(1)) {
    const pairs = r
      .map((v, i) => (v ? (header[i] ? `${header[i]}: ${v}` : v) : ''))
      .filter(Boolean)
      .join('; ');
    lines.push(pairs);
  }
  return lines.join('\n');
}

type Sheet = { sheet: string; data: Cell[][] };

/** One section per sheet, titled by the sheet name; the page fields carry the sheet number. */
function sheetsToDocument(sheets: Sheet[]): ParsedDocument {
  const sections: Section[] = [];
  sheets.forEach(({ sheet, data }, i) => {
    const text = sheetToText(data);
    if (text) sections.push({ title: sheet, level: 1, blocks: [{ text, page: i + 1 }] });
  });
  return { sections, outline: 'sheets', pages: sheets.length, needsOcr: false };
}

/** .xlsx and .xlsm: the same Office Open XML workbook; the macros of an .xlsm are never run. */
export async function parseXlsx(buffer: Buffer): Promise<ParsedDocument> {
  return sheetsToDocument((await readXlsxFile(buffer)) as Sheet[]);
}

/**
 * Legacy binary .xls (BIFF), which read-excel-file does not read, through SheetJS. Loaded on first
 * use only, as it is a large module. Dates come as Date objects in UTC like read-excel-file's.
 */
export async function parseXls(buffer: Buffer): Promise<ParsedDocument> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, UTC: true });
  return sheetsToDocument(
    wb.SheetNames.map((name) => ({
      sheet: name,
      data: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name]!, { header: 1, raw: true, defval: null, UTC: true }),
    })),
  );
}

/** UTF-8 (a BOM is dropped); text that is not valid UTF-8 is read as GB 18030, as Chinese Excel saves CSV. */
export function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('gb18030').decode(buffer);
  }
}

/**
 * RFC 4180 rows: quoted fields may hold the delimiter, quotes ("") and line breaks. The delimiter
 * is the one of comma, semicolon and tab found most often in the first line.
 */
export function parseCsvRows(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].reduce(
    (best, d) => (first.split(d).length > first.split(best).length ? d : best),
    ',',
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A CSV file as one sheet named after the file. A cell that reads back as the same number is a
 * number, so a header row of text is recognized; 0123 or a long ID stays text, keeping every digit.
 */
export function parseCsv(buffer: Buffer, fileName: string): ParsedDocument {
  const asCell = (v: string): Cell => (v !== '' && String(Number(v)) === v ? Number(v) : v || null);
  const data = parseCsvRows(decodeText(buffer)).map((r) => r.map(asCell));
  return sheetsToDocument([{ sheet: docTitleOf(fileName), data }]);
}
