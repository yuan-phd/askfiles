/**
 * Dates of a document for the overview (docs/graph.md, Dates): from its file name or title, from
 * Markdown front matter (date:, created:, updated:), else none. Families also fall back to the
 * file's modification time to order their members.
 */

export interface FoundDate {
  /** YYYY, YYYY-MM or YYYY-MM-DD. */
  value: string;
  source: 'title' | 'front matter' | 'file';
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');
const year = (y: number) => y >= 1900 && y <= 2099;
const month = (m: number) => m >= 1 && m <= 12;
const day = (d: number) => d >= 1 && d <= 31;

function ymd(y: number, m?: number, d?: number): string | null {
  if (!year(y)) return null;
  if (m === undefined) return String(y);
  if (!month(m)) return null;
  if (d === undefined) return `${y}-${pad(m)}`;
  return day(d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * The most precise date in a text: 2026-03-04, 2026.03.04, 20260304, 2026年3月4日, 2026年3月,
 * March 2026, 4 March 2026, or a bare year (1900 to 2099) standing apart from other digits.
 */
export function dateIn(text: string): string | null {
  const t = text.normalize('NFKC');
  let m = /(?<!\d)((?:19|20)\d{2})[-_./](\d{1,2})[-_./](\d{1,2})(?!\d)/.exec(t);
  if (m) {
    const v = ymd(+m[1]!, +m[2]!, +m[3]!);
    if (v) return v;
  }
  m = /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/.exec(t);
  if (m) {
    const v = ymd(+m[1]!, +m[2]!, +m[3]!);
    if (v) return v;
  }
  m = /((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/.exec(t);
  if (m) {
    const v = ymd(+m[1]!, +m[2]!, m[3] ? +m[3] : undefined);
    if (v) return v;
  }
  m =
    /\b(?:(\d{1,2})\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(?:(\d{1,2}),?\s+)?((?:19|20)\d{2})\b/i.exec(
      t,
    );
  if (m) {
    const d = m[1] ?? m[3];
    const v = ymd(+m[4]!, MONTHS[m[2]!.toLowerCase()]!, d ? +d : undefined);
    if (v) return v;
  }
  m = /(?<!\d|\d\.)((?:19|20)\d{2})(?:\s*年)?(?!\d|\.\d)/.exec(t);
  return m ? ymd(+m[1]!) : null;
}

/** date:, created: or updated: in a front matter block at the start of a text (--- lines). */
export function frontMatterDate(text: string): string | null {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\n|$)/.exec(text);
  if (!m) return null;
  for (const key of ['date', 'created', 'updated', 'modified']) {
    const line = new RegExp(`^${key}\\s*:\\s*["']?([^"'\\n]+)`, 'mi').exec(m[1]!);
    const v = line ? dateIn(line[1]!) : null;
    if (v) return v;
  }
  return null;
}

/** The date shown on a node: title first, then front matter of the first section. */
export function documentDate(doc: { title: string; sections: { text: string }[] }): FoundDate | null {
  const t = dateIn(doc.title.replace(/\.[a-z0-9]{1,5}$/i, ''));
  if (t) return { value: t, source: 'title' };
  const f = doc.sections[0] ? frontMatterDate(doc.sections[0].text) : null;
  return f ? { value: f, source: 'front matter' } : null;
}

/** For ordering a family: the found date, else the file's modification day. */
export function orderingDate(doc: { title: string; mtimeMs: number; sections: { text: string }[] }): FoundDate {
  const found = documentDate(doc);
  if (found) return found;
  const d = new Date(doc.mtimeMs || 0);
  return { value: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, source: 'file' };
}
