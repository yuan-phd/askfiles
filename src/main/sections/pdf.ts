import { isAcceptableHeading } from './headings.js';
import { docTitleOf, joinWrapped } from './text.js';
import type { Block, OutlineSource, ParsedDocument, Section } from './types.js';

/** One visual line of a page: text, baseline y (PDF units, grows upwards), font size. */
export interface Line {
  page: number;
  y: number;
  size: number;
  text: string;
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
  let cur: (Line & { endX: number }) | null = null;
  let breakNext = false;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const x = it.transform[4] ?? 0;
    const y = it.transform[5] ?? 0;
    const size = Math.hypot(it.transform[0] ?? 0, it.transform[1] ?? 0) || it.height || 0;
    const sameLine = cur !== null && !breakNext && Math.abs(cur.y - y) <= Math.max(2, size * 0.3);
    if (!sameLine) {
      if (cur && cur.text.trim()) lines.push({ page, y: cur.y, size: cur.size, text: cur.text.trim() });
      cur = { page, y, size, text: '', endX: x };
    }
    const c = cur!;
    if (it.str) {
      const gap = x - c.endX;
      const needsSpace = c.text && !c.text.endsWith(' ') && !it.str.startsWith(' ') && gap > size * 0.15;
      c.text = needsSpace ? joinWrapped(c.text, it.str) : c.text + it.str;
      if (it.str.trim()) c.size = Math.max(c.size, size);
      c.endX = x + (it.width || 0);
    }
    breakNext = Boolean(it.hasEOL);
  }
  if (cur && cur.text.trim()) lines.push({ page, y: cur.y, size: cur.size, text: cur.text.trim() });
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

interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
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

/**
 * Sections of a PDF with their pages: from bookmarks when the file has them, else from font size,
 * else one per page. A PDF with no text at all is reported as needsOcr.
 */
export async function parsePdf(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = (await task.promise) as unknown as PdfDoc;
    const lines: Line[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      lines.push(...linesFromItems(content.items as TextItem[], p));
    }
    if (!lines.some((l) => /\S/.test(l.text)))
      return { sections: [], outline: 'none', pages: doc.numPages, needsOcr: true, ...(await pageLabelsOf(doc)) };
    const docTitle = docTitleOf(fileName);
    const marks: Mark[] = [];
    await resolveMarks(doc, (await doc.getOutline()) ?? [], 1, marks);
    let outline: OutlineSource = 'bookmarks';
    let sections = marks.length ? sectionsFromMarks(lines, marks, docTitle) : [];
    if (!sections.length) {
      const guessed = marksFromFontSize(lines);
      outline = 'font-size';
      sections = guessed.length ? sectionsFromMarks(lines, guessed, docTitle) : [];
    }
    if (!sections.length) {
      outline = 'pages';
      sections = sectionsByPage(lines);
    }
    return { sections, outline, pages: doc.numPages, needsOcr: false, ...(await pageLabelsOf(doc)) };
  } finally {
    await task.destroy();
  }
}
