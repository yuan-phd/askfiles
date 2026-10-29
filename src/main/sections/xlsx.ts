import readXlsxFile from 'read-excel-file/node';
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

/** One section per sheet, titled by the sheet name; the page fields carry the sheet number. */
export async function parseXlsx(buffer: Buffer): Promise<ParsedDocument> {
  const sheets = (await readXlsxFile(buffer)) as { sheet: string; data: Cell[][] }[];
  const sections: Section[] = [];
  sheets.forEach(({ sheet, data }, i) => {
    const text = sheetToText(data);
    if (text) sections.push({ title: sheet, level: 1, blocks: [{ text, page: i + 1 }] });
  });
  return { sections, outline: 'sheets', pages: sheets.length, needsOcr: false };
}
