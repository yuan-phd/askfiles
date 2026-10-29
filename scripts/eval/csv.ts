// RFC 4180 CSV with a UTF-8 byte order mark on output, so spreadsheet apps open Chinese text
// correctly. Node has no CSV parser and the format is small enough to own.

const BOM = '\ufeff';

/** Rows of fields. Accepts LF or CRLF, quoted fields with commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (c === '\r' && src[i + 1] === '\n') i++;
    } else {
      field += c;
    }
    i++;
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines (a single empty field) carry no record.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Records keyed by header name; header names are trimmed and lower-cased. */
export function parseRecords(text: string): { header: string[]; records: Record<string, string>[] } {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) rec[h] = r[i] ?? '';
    });
    return rec;
  });
  return { header, records };
}

function quote(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: unknown[]): string {
  return `${values.map(quote).join(',')}\r\n`;
}

/** Full CSV text, with the byte order mark. */
export function toCsv(header: string[], records: Record<string, unknown>[]): string {
  return BOM + csvLine(header) + records.map((r) => csvLine(header.map((h) => r[h]))).join('');
}

export function csvHeader(header: string[]): string {
  return BOM + csvLine(header);
}
