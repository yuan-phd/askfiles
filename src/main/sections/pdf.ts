import { cjkMarks, cleanCjkLines, isCjkText } from './cjk.js';
import { isAcceptableHeading } from './headings.js';
import { findPdfTables, itemsOutside } from './tables.js';
import { docTitleOf, joinWrapped } from './text.js';
import type { Block, OutlineSource, ParsedDocument, Section, SplitOptions, TableData } from './types.js';

/** One visual line of a page: text, baseline y (PDF units, grows upwards), font size. */
export interface Line {
  page: number;
  y: number;
  size: number;
  text: string;
  /** A table found on the page (structuredTables); text is empty and the line becomes one block. */
  table?: TableData;
  /** Left and right end of the line's text, in PDF units. */
  x0?: number;
  x1?: number;
}

/** A bookmark resolved to a page and, when the destination has one, a y position. */
export interface Mark {
  title: string;
  level: number;
  page: number;
  y: number | null;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

/** Groups pdf.js text items into lines by baseline, inserting spaces where Latin words have gaps. */
export function linesFromItems(items: TextItem[], page: number): Line[] {
  const lines: Line[] = [];
  let cur: (Line & { endX: number; startX: number }) | null = null;
  let breakNext = false;
  const close = (c: Line & { endX: number; startX: number }) =>
    lines.push({ page, y: c.y, size: c.size, text: c.text.trim(), x0: c.startX, x1: c.endX });
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4] ?? 0;
    const y = it.transform[5] ?? 0;
    const size = Math.hypot(it.transform[0] ?? 0, it.transform[1] ?? 0) || it.height || 0;
    const sameLine = cur !== null && !breakNext && Math.abs(cur.y - y) <= Math.max(2, size * 0.3);
    if (!sameLine) {
      if (cur && cur.text.trim()) close(cur);
      cur = { page, y, size, text: '', endX: x, startX: x };
    }
    const c = cur!;
    if (it.str) {
      const gap = x - c.endX;
      const needsSpace = c.text && !c.text.endsWith(' ') && !it.str.startsWith(' ') && gap > size * 0.15;
      if (!c.text.trim() && it.str.trim()) c.startX = x;
      c.text = needsSpace ? joinWrapped(c.text, it.str) : c.text + it.str;
      if (it.str.trim()) c.size = Math.max(c.size, size);
      c.endX = x + (it.width || 0);
    }
    breakNext = Boolean(it.hasEOL);
  }
  if (cur && cur.text.trim()) close(cur);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ') }));
}

/**
 * Paragraph blocks from lines: a new block starts on a new page or after a vertical gap wider than
 * 1.6 times the line's font size. Wrapped lines are joined without a space next to Chinese.
 */
export function blocksFromLines(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  let prev: Line | null = null;
  for (const l of lines) {
    if (l.table) {
      blocks.push({ text: '', page: l.page, table: l.table });
      prev = null;
      continue;
    }
    const gap = prev ? prev.y - l.y : 0;
    const newBlock = !prev || prev.page !== l.page || gap > Math.max(l.size, prev.size) * 1.6 || gap < 0;
    if (newBlock) blocks.push({ text: l.text, page: l.page });
    else blocks[blocks.length - 1]!.text = joinWrapped(blocks[blocks.length - 1]!.text, l.text);
    prev = l;
  }
  return blocks;
}

function sameText(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  return n(a) === n(b);
}

/** Splits lines at bookmark positions. Lines before the first bookmark form a level 0 section. */
export function sectionsFromMarks(lines: Line[], marks: Mark[], docTitle: string): Section[] {
  const sorted = [...marks].sort((a, b) => a.page - b.page || (b.y ?? Infinity) - (a.y ?? Infinity));
  const starts = (m: Mark, l: Line) => l.page > m.page || (l.page === m.page && (m.y === null || l.y <= m.y + 2));
  const groups: { title: string; level: number; lines: Line[] }[] = [{ title: docTitle, level: 0, lines: [] }];
  let next = 0;
  for (const l of lines) {
    while (next < sorted.length && starts(sorted[next]!, l)) {
      const m = sorted[next++]!;
      groups.push({ title: m.title, level: m.level, lines: [] });
    }
    groups[groups.length - 1]!.lines.push(l);
  }
  for (; next < sorted.length; next++)
    groups.push({ title: sorted[next]!.title, level: sorted[next]!.level, lines: [] });
  return groups
    .map((g) => {
      // The heading line itself is dropped: the chunker puts the title on the first line.
      const body = g.lines.length && sameText(g.lines[0]!.text, g.title) ? g.lines.slice(1) : g.lines;
      return { title: g.title, level: g.level, blocks: blocksFromLines(body) };
    })
    .filter((s) => s.level > 0 || s.blocks.length);
}

/**
 * Headings guessed from font size when there are no bookmarks: a line set at least 15 percent
 * larger than the body size (the size carrying most characters) that passes the heading filter
 * (isAcceptableHeading) is a heading; distinct heading sizes, largest first, give levels 1, 2, 3.
 * A rejected line stays in the body of the section above it.
 */
export function marksFromFontSize(lines: Line[]): Mark[] {
  const weight = new Map<number, number>();
  for (const l of lines) {
    const s = Math.round(l.size * 2) / 2;
    weight.set(s, (weight.get(s) ?? 0) + l.text.length);
  }
  let body = 0;
  let best = -1;
  for (const [s, w] of weight) if (w > best) [body, best] = [s, w];
  const isHeading = (l: Line) => l.size >= body * 1.15 && isAcceptableHeading(l.text);
  const sizes = [...new Set(lines.filter(isHeading).map((l) => Math.round(l.size * 2) / 2))].sort((a, b) => b - a);
  return lines
    .filter(isHeading)
    .map((l) => ({ title: l.text, level: sizes.indexOf(Math.round(l.size * 2) / 2) + 1, page: l.page, y: l.y + 1 }));
}

/**
 * The page's lines with every table found by its text positions (findPdfTables) taken out and put
 * back as one table line at the table's top, among the lines in reading order.
 */
export function withTables(items: TextItem[], page: number): Line[] {
  const tables = findPdfTables(items, page);
  if (!tables.length) return linesFromItems(items, page);
  let keep = items.map(() => true);
  for (const t of tables) {
    const outside = itemsOutside(items, t);
    keep = keep.map((k, i) => k && outside[i]!);
  }
  const lines = linesFromItems(
    items.filter((_, i) => keep[i]),
    page,
  );
  for (const t of tables) {
    const line: Line = { page, y: t.top, size: t.size, text: '', table: t.table };
    const at = lines.findIndex((l) => !l.table && l.y < t.top);
    if (at < 0) lines.push(line);
    else lines.splice(at, 0, line);
  }
  return lines;
}

/**
 * A table that goes on over a page break is one table: a table at the top of a page continues the
 * table that ended the page before when at most three lines (page number, running header) stand
 * between them, the column count is the same and it has no header of its own or repeats the
 * same one.
 */
export function joinPageTables(lines: Line[]): Line[] {
  const out: Line[] = [];
  let last: Line | null = null;
  // Page of the last part joined to last, so a table over three pages joins twice.
  let lastPage = 0;
  let between = 0;
  for (const l of lines) {
    if (!l.table) {
      between++;
      out.push(l);
      continue;
    }
    const a = last?.table;
    const b = l.table;
    const width = (t: TableData) => t.header.length || t.rows[0]?.cells.length || 0;
    if (
      a &&
      lastPage === l.page - 1 &&
      between <= 3 &&
      width(a) === width(b) &&
      (!b.header.length || b.header.join('|') === a.header.join('|')) &&
      !b.title
    ) {
      a.rows.push(...b.rows);
      lastPage = l.page;
      between = 0;
      continue;
    }
    out.push(l);
    last = l;
    lastPage = l.page;
    between = 0;
  }
  return out;
}

/** Text quality of one page's text layer, both shares from 0 to 1. */
export interface PageQuality {
  /** Letters, digits and CJK over all non-space characters, runs of three or more of one punctuation mark left out. */
  charShare: number;
  /** Plausible words over all words that are not pure numbers or punctuation. */
  wordShare: number;
  /** Non-space characters on the page. */
  chars: number;
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * A word is plausible when it holds any CJK, or when, with punctuation trimmed from both ends, it
 * is two or more letters with at most an apostrophe, hyphen or period between them (don't,
 * e-mail, U.S.). Numbers and punctuation-only tokens count for neither side: tables of figures
 * and dotted contents lines are not garbage.
 */
export function pageQuality(text: string): PageQuality {
  // Dot leaders and rules in contents pages and forms (....., . . . ., ____) are layout, not text.
  const chars = [...text.replace(/([^\p{L}\p{N}\s])(?:\s*\1){2,}/gu, '').replace(/\s+/g, '')];
  const good = chars.filter((c) => WORD_CHAR.test(c) || CJK.test(c)).length;
  let words = 0;
  let plausible = 0;
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!w || /^[\p{N}.,:/%-]+$/u.test(w)) continue;
    words++;
    if (CJK.test(w) || /^\p{L}+(?:['’.-]\p{L}+)*\.?$/u.test(w)) plausible++;
  }
  return {
    charShare: chars.length ? good / chars.length : 1,
    wordShare: words ? plausible / words : 1,
    chars: chars.length,
  };
}

/**
 * Thresholds for a garbled text layer, measured on the owner's first corpus (docs/eval.md, Garbled
 * text layers): on its eight digital PDFs (599 pages) no page went below 0.92 for characters or
 * 0.88 for words; the scanned one has pages down to 0.52 and 0.55. A page is garbled when either
 * share is below 0.85. Pages with fewer than GARBLED_MIN_CHARS characters are too short to judge
 * by share; see SPARSE_CHARS.
 */
export const GARBLED_CHAR_SHARE = 0.85;
export const GARBLED_WORD_SHARE = 0.85;
export const GARBLED_MIN_CHARS = 40;
/**
 * In a PDF that has at least one garbled page, a page with fewer characters than this that draws
 * an image is a scan whose text layer lost most of the text (the owner's page 7: 56 characters on
 * a full memorandum), and is OCRed too. Not applied to clean PDFs, so a cover with a logo keeps
 * its own text.
 */
export const SPARSE_CHARS = 200;

export function isGarbled(q: PageQuality): boolean {
  return q.chars >= GARBLED_MIN_CHARS && (q.charShare < GARBLED_CHAR_SHARE || q.wordShare < GARBLED_WORD_SHARE);
}

/** Sections when nothing marks headings: one per page, titled Page N. */
export function sectionsByPage(lines: Line[]): Section[] {
  const pages = [...new Set(lines.map((l) => l.page))];
  return pages.map((p) => ({
    title: `Page ${p}`,
    level: 1,
    blocks: blocksFromLines(lines.filter((l) => l.page === p)),
  }));
}

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
}

interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getOutline(): Promise<OutlineNode[] | null>;
  getPageLabels(): Promise<string[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

async function resolveMarks(doc: PdfDoc, nodes: OutlineNode[], level: number, out: Mark[]): Promise<void> {
  for (const n of nodes) {
    try {
      const dest = typeof n.dest === 'string' ? await doc.getDestination(n.dest) : n.dest;
      if (Array.isArray(dest) && dest.length) {
        const ref = dest[0];
        const page = typeof ref === 'number' ? ref + 1 : (await doc.getPageIndex(ref)) + 1;
        const kind = (dest[1] as { name?: string } | undefined)?.name;
        const y = kind === 'XYZ' || kind === 'FitH' || kind === 'FitBH' ? dest[kind === 'XYZ' ? 3 : 2] : null;
        out.push({ title: n.title.trim(), level, page, y: typeof y === 'number' ? y : null });
      }
    } catch {
      // A bookmark pointing nowhere is skipped; its children may still resolve.
    }
    if (n.items?.length) await resolveMarks(doc, n.items, level + 1, out);
  }
}

/**
 * Printed page labels (iv, 12, A-3) when the PDF defines any that differ from the page numbers;
 * a document whose labels are just 1, 2, 3 gets none, so nothing shows the same number twice.
 */
async function pageLabelsOf(doc: PdfDoc): Promise<{ pageLabels?: string[] }> {
  let labels: string[] | null = null;
  try {
    labels = await doc.getPageLabels();
  } catch {
    // A broken page label tree is not worth failing the file over.
  }
  if (!labels || labels.length !== doc.numPages) return {};
  const clean = labels.map((l) => (typeof l === 'string' ? l.trim() : ''));
  return clean.some((l, i) => l !== '' && l !== String(i + 1)) ? { pageLabels: clean } : {};
}

/** True when the page paints an image; the image itself is not decoded. */
async function drawsImage(page: PdfPage, ops: Record<string, number>): Promise<boolean> {
  try {
    const { fnArray } = await page.getOperatorList();
    return fnArray.some((f) => f === ops.paintImageXObject || f === ops.paintInlineImageXObject);
  } catch {
    return false;
  }
}

/** The most common font size by characters, the body size of marksFromFontSize. */
function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(l.size, (weight.get(l.size) ?? 0) + l.text.length);
  let body = 10;
  let best = -1;
  for (const [s, w] of weight) if (w > best) [body, best] = [s, w];
  return body;
}

/**
 * Lines for a page whose text came from OCR: one per paragraph at the body size, far enough apart
 * to start a new block each, so they never pass for headings.
 */
function ocrLines(text: string, page: number, size: number): Line[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((t, i) => ({ page, y: 10_000 - i * size * 3, size, text: t }));
}

/**
 * Sections of a PDF with their pages: from bookmarks when the file has them, else from font size,
 * else one per page. A PDF with no text at all is reported as needsOcr. Pages whose text layer
 * is garbled (isGarbled, SPARSE_CHARS) are listed in ocrPages; a caller that has OCR text for them
 * passes it back as pageText, which then replaces those pages' text layer.
 */
export async function parsePdf(
  buffer: Buffer,
  fileName: string,
  o: { pageText?: Map<number, string> } & SplitOptions = {},
): Promise<ParsedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = (await task.promise) as unknown as PdfDoc;
    let lines: Line[] = [];
    const garbled: number[] = [];
    const sparse: number[] = [];
    const layer: NonNullable<ParsedDocument['ocrLayer']> = {};
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const items = (await page.getTextContent()).items as TextItem[];
      const pageLines = linesFromItems(items, p);
      lines.push(...(o.structuredTables ? withTables(items, p) : pageLines));
      const text = pageLines.map((l) => l.text).join('\n');
      const q = pageQuality(text);
      if (isGarbled(q)) {
        garbled.push(p);
        layer[p] = { text, reason: 'garbled' };
      } else if (q.chars < SPARSE_CHARS && (await drawsImage(page, pdfjs.OPS))) {
        sparse.push(p);
        layer[p] = { text, reason: 'sparse' };
      }
    }
    if (!lines.some((l) => /\S/.test(l.text)))
      return { sections: [], outline: 'none', pages: doc.numPages, needsOcr: true, ...(await pageLabelsOf(doc)) };
    if (o.structuredTables) lines = joinPageTables(lines);
    const ocrPages = garbled.length ? [...garbled, ...sparse].sort((a, b) => a - b) : [];
    if (o.pageText?.size) {
      const size = bodySize(lines.filter((l) => !o.pageText!.has(l.page)));
      const replaced = [...o.pageText.entries()].flatMap(([p, text]) => ocrLines(text, p, size));
      lines = [...lines.filter((l) => !o.pageText!.has(l.page)), ...replaced].sort(
        (a, b) => a.page - b.page || b.y - a.y,
      );
    }
    const docTitle = docTitleOf(fileName);
    const cjk = Boolean(o.cjkHeadings) && isCjkText(lines.map((l) => l.text).join(''));
    if (cjk) lines = cleanCjkLines(lines);
    const marks: Mark[] = [];
    await resolveMarks(doc, (await doc.getOutline()) ?? [], 1, marks);
    let outline: OutlineSource = 'bookmarks';
    let sections = marks.length ? sectionsFromMarks(lines, marks, docTitle) : [];
    if (!sections.length && cjk) {
      // Numbered Chinese headings and larger fonts together (cjk.ts), in place of font size alone.
      const found = cjkMarks(lines);
      outline = 'headings';
      sections = found.marks.length ? sectionsFromMarks(found.lines, found.marks, docTitle) : [];
    }
    if (!sections.length) {
      const guessed = marksFromFontSize(lines);
      outline = 'font-size';
      sections = guessed.length ? sectionsFromMarks(lines, guessed, docTitle) : [];
    }
    if (!sections.length) {
      outline = 'pages';
      sections = sectionsByPage(lines);
    }
    return {
      sections,
      outline,
      pages: doc.numPages,
      needsOcr: false,
      ...(ocrPages.length ? { ocrPages, ocrLayer: Object.fromEntries(ocrPages.map((p) => [p, layer[p]!])) } : {}),
      ...(await pageLabelsOf(doc)),
    };
  } finally {
    await task.destroy();
  }
}
