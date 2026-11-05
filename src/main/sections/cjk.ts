import { isAcceptableHeading } from './headings.js';
import type { Line, Mark } from './pdf.js';
import { joinWrapped } from './text.js';
import type { Block, Section } from './types.js';

/**
 * Chinese heading detection (cjkHeadings, docs/plan.md round I2). Chinese documents number their
 * headings (第一章, 第三条, 一、, （一）, 1.1) more often than they set them in a larger font, put a
 * running header and a page number on every page, open with a contents page and letter-space
 * their cover titles. All of it applies only to a document that is mainly Chinese (isCjkText), so
 * an English document splits exactly as before.
 */

const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿]/u;
const CN_NUM = '一二三四五六七八九十百千零〇两';

/** Mainly Chinese: at least 30 percent of the visible characters are CJK ideographs. */
export function isCjkText(text: string): boolean {
  const chars = [...text.replace(/\s+/g, '')];
  if (!chars.length) return false;
  return chars.filter((c) => CJK_CHAR.test(c)).length / chars.length >= 0.3;
}

/** Numbering kinds from the outermost in; their order breaks ties between headings of one size. */
interface Pattern {
  rank: number;
  re: RegExp;
  /** 第X条 heads the article's first sentence on the same line: only the number is the title. */
  article?: boolean;
}

// After the number: whitespace, the end, or a character that does not continue a sentence (第三条的规定
// is a reference, not a heading).
const AFTER = `(?=\\s|$|[^的之中和或及与、，。；：:）)“”"])`;
export const CJK_PATTERNS: Pattern[] = [
  { rank: 1, re: new RegExp(`^第[${CN_NUM}\\d]+[编卷]${AFTER}`, 'u') },
  { rank: 2, re: new RegExp(`^第[${CN_NUM}\\d]+[章部]分?${AFTER}`, 'u') },
  { rank: 3, re: new RegExp(`^第[${CN_NUM}\\d]+节${AFTER}`, 'u') },
  { rank: 4, re: new RegExp(`^第[${CN_NUM}\\d]+条${AFTER}`, 'u'), article: true },
  { rank: 5, re: new RegExp(`^[${CN_NUM}]+、`, 'u') },
  { rank: 6, re: new RegExp(`^[（(][${CN_NUM}]+[）)]`, 'u') },
  { rank: 7, re: /^\d{1,2}[.．、](?!\d)/u },
  { rank: 8, re: /^\d{1,2}\.\d{1,2}(?![.\d])/u },
  { rank: 9, re: /^\d{1,2}\.\d{1,2}\.\d{1,2}(?![.\d])/u },
];

/** Longest heading text after its number; longer lines are numbered paragraphs. */
const MAX_TITLE_CHARS = 30;
const CLAUSE = /[，。；：:！？!?]/u;

export interface CjkHeading {
  /** The heading text. For an article (第三条 ...) only the number; the rest of the line is body. */
  title: string;
  /** Text after the heading on the same line, for articles. */
  rest: string;
  rank: number;
}

/**
 * The numbered heading a line starts with, or null. 第X条 is always a heading, with the rest of
 * the line as body text. Every other kind needs a title after the number: at most 30 characters,
 * no clause punctuation (，。；：), and a plausible heading (isAcceptableHeading), so 3.2 本次招标
 * 接受联合体投标。 stays a paragraph.
 */
export function cjkHeading(text: string): CjkHeading | null {
  const t = text.replace(/\s+/g, ' ').trim();
  for (const p of CJK_PATTERNS) {
    const m = p.re.exec(t);
    if (!m) continue;
    if (p.article) {
      return { title: m[0], rest: t.slice(m[0].length).trim(), rank: p.rank };
    }
    const after = t.slice(m[0].length).trim();
    if (!after && p.rank <= 3) return { title: t, rest: '', rank: p.rank };
    if (!after || after.length > MAX_TITLE_CHARS || CLAUSE.test(after) || !isAcceptableHeading(t)) return null;
    return { title: t, rest: '', rank: p.rank };
  }
  return null;
}

/** 中 华 人 民 共 和 国 to 中华人民共和国: single Chinese characters set apart by spaces. */
export function despace(text: string): string {
  return /^(?:[㐀-鿿]\s+){2,}[㐀-鿿]$/u.test(text.trim()) ? text.replace(/\s+/g, '') : text;
}

export const PAGE_NUMBER =
  /^(?:[-—–_\s]*\d{1,4}[-—–_\s]*|第\s*\d{1,4}\s*页(?:\s*[,，/]?\s*共\s*\d{1,4}\s*页)?|\d{1,4}\s*\/\s*\d{1,4}|-\s*[ivxlc]{1,6}\s*-)$/iu;
const LEADER = /(?:\.{4,}|…{2,}|·{4,}|-{5,}|_{5,})\s*\d*\s*$/u;
const ENDS_IN_PAGE = /\S\s{2,}\d{1,4}$/u;

/**
 * Lines of a mainly Chinese PDF made ready for headings: in reading order (page, then top to
 * bottom; pdf.js gives them in the order the file draws them, which often puts the footer first),
 * page numbers and running headers or footers removed (one of the two top or two bottom lines of
 * a page; a header or footer is the same text, digits set aside, on at least 40 percent of the
 * pages and on three or more), contents pages dropped (a page where at least five lines, and 40
 * percent of its lines, end in a dot leader or a page number: their entries are the outline
 * again), letter-spaced lines closed up.
 */
export function cleanCjkLines(input: Line[]): Line[] {
  const lines = [...input].sort((a, b) => a.page - b.page || b.y - a.y);
  const pages = new Map<number, Line[]>();
  for (const l of lines) {
    if (!pages.has(l.page)) pages.set(l.page, []);
    pages.get(l.page)!.push(l);
  }
  const key = (s: string) => s.replace(/\d+/g, '#').replace(/\s+/g, '');
  const edges = new Map<Line, string>();
  const seen = new Map<string, Set<number>>();
  for (const [p, ls] of pages) {
    const text = ls.filter((l) => !l.table && l.text.trim());
    if (!text.length) continue;
    const byY = [...text].sort((a, b) => b.y - a.y);
    for (const l of new Set([...byY.slice(0, 2), ...byY.slice(-2)])) {
      const k = key(l.text);
      edges.set(l, k);
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k)!.add(p);
    }
  }
  const repeated = (k: string) => (seen.get(k)?.size ?? 0) >= Math.max(3, 0.4 * pages.size);
  const contents = new Set<number>();
  for (const [p, ls] of pages) {
    const entries = ls.filter((l) => !l.table && (LEADER.test(l.text) || ENDS_IN_PAGE.test(l.text))).length;
    if (entries >= 5 && entries >= 0.4 * ls.length) contents.add(p);
  }
  return lines
    .filter((l) => {
      if (contents.has(l.page)) return false;
      if (l.table) return true;
      const k = edges.get(l);
      if (k !== undefined && (PAGE_NUMBER.test(l.text.trim()) || (k.length > 1 && repeated(k)))) return false;
      return true;
    })
    .map((l) => (l.table ? l : { ...l, text: despace(l.text) }));
}

/**
 * A form line set large on a cover, not a title: a label whose colon is followed by nothing or by
 * a bracketed placeholder (招标人： （盖单位章）, （招标编号： ）), or a date to fill in (年 月 日).
 */
export function isFormLine(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  if (/^[年月日]+$/u.test(t)) return true;
  const at = Math.max(t.lastIndexOf('：'), t.lastIndexOf(':'));
  if (at < 0) return false;
  return /^(?:[（(][^）)]*[）)])?[）)]?$/u.test(t.slice(at + 1));
}

interface Candidate {
  line: Line;
  size: number;
  rank: number;
  title: string;
}

/** a sits above b in the outline: a larger font, or the same font and an outer numbering kind. */
function outer(a: Candidate, b: Candidate): boolean {
  if (a.size > b.size + 0.6) return true;
  if (Math.abs(a.size - b.size) <= 0.6) return a.rank < b.rank;
  return false;
}

/**
 * Heading marks of a mainly Chinese PDF: lines set larger than the body that pass the heading
 * filter (as marksFromFontSize) and lines that start with a heading number (cjkHeading). A heading
 * wrapped over two lines is one heading when the second line is short (no longer than the first
 * for a large title, at most half of it for a numbered heading in the body size), set in the same
 * size right below it, carries no number of its own and closes the title. A numbered line as wide
 * as a full line with the paragraph going on below it is not a heading. An
 * article line (第三条 为了...) is split into the heading 第三条 and a body line with the rest.
 * Levels come from nesting: a heading is one level below the nearest heading before it that is
 * outer to it (larger font, or same font and an outer numbering kind). Returns the marks and the
 * lines, changed where headings were joined or split.
 */
export function cjkMarks(input: Line[]): { marks: Mark[]; lines: Line[] } {
  const weight = new Map<number, number>();
  for (const l of input) {
    if (l.table) continue;
    const s = Math.round(l.size * 2) / 2;
    weight.set(s, (weight.get(s) ?? 0) + l.text.length);
  }
  let body = 0;
  let best = -1;
  for (const [s, w] of weight) if (w > best) [body, best] = [s, w];
  const large = (l: Line) => !l.table && l.size >= body * 1.15;
  // A full line per font size: the 90th percentile of line widths (of lengths when a line has no
  // position). A numbered line that wide, followed by more text in its size, is the first line of
  // a paragraph, not a heading.
  const extent = (l: Line) => (l.x0 !== undefined && l.x1 !== undefined ? l.x1 - l.x0 : l.text.length);
  const widths = new Map<number, number[]>();
  for (const l of input) {
    if (l.table) continue;
    const s = Math.round(l.size * 2) / 2;
    if (!widths.has(s)) widths.set(s, []);
    widths.get(s)!.push(extent(l));
  }
  for (const ws of widths.values()) ws.sort((a, b) => a - b);
  const full = (l: Line) => {
    const ws = widths.get(Math.round(l.size * 2) / 2) ?? [];
    return ws.length ? ws[Math.floor(0.9 * (ws.length - 1))]! : Infinity;
  };
  const wraps = (l: Line, next: Line | undefined) =>
    next !== undefined &&
    !next.table &&
    // The paragraph goes on below, or at the top of the next page.
    (next.page === l.page + 1 || (next.page === l.page && l.y > next.y && l.y - next.y <= 2.5 * l.size)) &&
    Math.abs(next.size - l.size) <= 0.5 &&
    extent(l) >= 0.85 * full(l) &&
    !cjkHeading(next.text);

  const lines: Line[] = [];
  const candidates: Candidate[] = [];
  for (let i = 0; i < input.length; i++) {
    let l = input[i]!;
    if (l.table) {
      lines.push(l);
      continue;
    }
    const numbered = cjkHeading(l.text);
    const next = input[i + 1];
    // A wrapped heading: the short second line closes the title.
    if (
      next &&
      !next.table &&
      (large(l) || (numbered && !numbered.rest)) &&
      next.page === l.page &&
      Math.abs(next.size - l.size) <= 0.5 &&
      l.y - next.y > 0 &&
      l.y - next.y <= 1.8 * l.size &&
      // A large title's second line is at most as long as its first; a numbered heading's is short.
      next.text.length <= (large(l) ? l.text.length : l.text.length / 2) &&
      !cjkHeading(next.text) &&
      !/[，；：:]$/u.test(l.text) &&
      isAcceptableHeading(joinWrapped(l.text, next.text))
    ) {
      l = { ...l, text: joinWrapped(l.text, next.text) };
      i++;
    }
    let h = cjkHeading(l.text);
    if (h && !h.rest && !large(l) && wraps(l, input[i + 1])) h = null;
    if (h?.rest) {
      // 第三条 为了... : the number heads a section, the sentence is its first body line.
      const head = { ...l, text: h.title };
      lines.push(head, { ...l, text: h.rest });
      candidates.push({ line: head, size: Math.round(l.size * 2) / 2, rank: h.rank, title: h.title });
      continue;
    }
    lines.push(l);
    if (h || (large(l) && isAcceptableHeading(l.text) && !isFormLine(l.text))) {
      candidates.push({ line: l, size: Math.round(l.size * 2) / 2, rank: h?.rank ?? 99, title: l.text });
    }
  }
  const stack: Candidate[] = [];
  const marks: Mark[] = candidates.map((c) => {
    while (stack.length && !outer(stack[stack.length - 1]!, c)) stack.pop();
    stack.push(c);
    return { title: c.title, level: stack.length, page: c.line.page, y: c.line.y + 1 };
  });
  return { marks, lines };
}

/**
 * Word and plain text without heading styles in a mainly Chinese document: paragraphs that start
 * with a heading number become sections, nested as in cjkMarks by numbering kind. Text before the
 * first one stays in the section it was in.
 */
export function cjkSectionsFromBlocks(sections: Section[]): Section[] {
  if (sections.some((s) => s.level > 0)) return sections;
  const text = sections.flatMap((s) => s.blocks.map((b) => b.text)).join('\n');
  if (!isCjkText(text)) return sections;
  const out: Section[] = [];
  const stack: number[] = [];
  for (const s of sections) {
    let current: Section = { ...s, blocks: [] as Block[] };
    out.push(current);
    for (const b of s.blocks) {
      if (b.table) {
        current.blocks.push(b);
        continue;
      }
      const lines = b.text.split('\n');
      let pending: string[] = [];
      const flush = () => {
        if (pending.length) current.blocks.push({ text: pending.join('\n'), page: b.page });
        pending = [];
      };
      for (const line of lines) {
        const h = cjkHeading(despace(line));
        if (!h) {
          pending.push(line);
          continue;
        }
        flush();
        while (stack.length && stack[stack.length - 1]! >= h.rank) stack.pop();
        stack.push(h.rank);
        current = { title: h.title, level: stack.length, blocks: [] };
        out.push(current);
        if (h.rest) pending.push(h.rest);
      }
      flush();
    }
  }
  return out.filter((s) => s.level > 0 || s.blocks.length);
}
