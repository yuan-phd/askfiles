import { tableSections } from './tables.js';
import type { Block, Chunk, Section } from './types.js';

/** Longest section title written into the chunk text; the full title stays in sectionTitle. */
const MAX_TITLE_IN_TEXT = 200;
export const MIN_CHUNK_CHARS = 400;

/**
 * Sets each section's path: the titles of the headings above it by level, then its own title.
 * Run before folding, so a heading-only chapter title still heads the paths of its subsections.
 * Level 0 text (before the first heading) has no path.
 */
export function withPaths(sections: Section[]): Section[] {
  const stack: { level: number; title: string }[] = [];
  return sections.map((s) => {
    if (s.path) return s;
    if (s.level <= 0) return { ...s, path: [] };
    while (stack.length && stack[stack.length - 1]!.level >= s.level) stack.pop();
    const title = s.title.replace(/\s+/g, ' ').trim();
    stack.push({ level: s.level, title });
    return { ...s, path: stack.map((e) => e.title) };
  });
}

/**
 * Removes heading-only sections. A heading with no body joins the next section as its lead (the
 * lines above its title, such as a chapter heading above its first subsection), or the previous
 * section's end when nothing follows, so no document is ever only a heading (Session F
 * requirement from Session D).
 */
export function foldEmptySections(sections: Section[]): Section[] {
  const out: Section[] = [];
  let pending: string[] = [];
  for (const s of sections) {
    if (!s.blocks.length) {
      if (s.title.trim()) pending.push(s.title.trim());
      continue;
    }
    out.push(pending.length ? { ...s, lead: [...(s.lead ?? []), ...pending] } : s);
    pending = [];
  }
  if (pending.length && out.length) {
    const last = out[out.length - 1]!;
    const page = last.blocks[last.blocks.length - 1]!.page;
    out[out.length - 1] = { ...last, blocks: [...last.blocks, { text: pending.join('\n'), page }] };
  }
  return out;
}

/** A section without sub-headings longer than this many chunk maximums is split by page. */
export const PAGE_SPLIT_FACTOR = 3;

/** The page sub-section title: parent title and page number. */
export function pageTitle(title: string, page: number): string {
  return `${title} (page ${page})`;
}

/**
 * Splits each section whose own text (up to the next heading of any level, so it holds no
 * sub-heading) is longer than PAGE_SPLIT_FACTOR chunk maximums and spans more than one page into
 * one sub-section per page, titled pageTitle. They sit one level below the parent, whose title
 * becomes the first one's lead, so the outline keeps the parent heading and a nine-page cover
 * section no longer exists. A section with sub-sections after it is split too: the owner's
 * nine-page cover was such a section. Run after folding, on sections that carry their paths.
 */
export function splitLongByPage(sections: Section[], maxChars: number): Section[] {
  return sections.flatMap((s) => {
    // A table is cut by rows in chunkSections, with its header in every chunk.
    if (s.table) return [s];
    const length = s.blocks.reduce((n, b) => n + b.text.length, 0);
    const pages = [...new Set(s.blocks.map((b) => b.page).filter((p) => p > 0))];
    if (length <= PAGE_SPLIT_FACTOR * maxChars || pages.length < 2) return [s];
    const title = s.title.replace(/\s+/g, ' ').trim();
    return pages.map((page, k) => {
      const sub = pageTitle(title, page);
      return {
        title: sub,
        level: s.level + 1,
        // Blocks of unknown page (0) stay with the page before them.
        blocks: s.blocks.filter((b, bi) => (b.page || pageBefore(s.blocks, bi)) === page),
        ...(k === 0 ? { lead: [...(s.lead ?? []), title] } : {}),
        path: [...(s.path ?? []), sub],
      };
    });
  });
}

function pageBefore(blocks: Block[], i: number): number {
  for (let j = i - 1; j >= 0; j--) if (blocks[j]!.page > 0) return blocks[j]!.page;
  return blocks.find((b) => b.page > 0)?.page ?? 0;
}

// After a line break; after Chinese end punctuation and closing quotes; after Latin end
// punctuation followed by whitespace (so 3.5 and e.g. inside words do not split).
const BREAK = /\n|[。！？；…]+[」』”’）)]*|[.!?;]+["')\]]*\s+/g;

function cutAt(text: string, re: RegExp): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const m of text.matchAll(re)) {
    const end = m.index! + m[0].length;
    if (end > from && end < text.length) {
      parts.push(text.slice(from, end));
      from = end;
    }
  }
  parts.push(text.slice(from));
  return parts.filter((p) => p.length);
}

/** Cuts text into pieces no longer than max whose concatenation is the original text. */
export function splitToFit(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (const part of cutAt(text, BREAK)) {
    let rest = part;
    while (rest.length > max) {
      // Hard cut, at the last space in the second half of the window when there is one.
      const space = rest.lastIndexOf(' ', max);
      const at = space > max / 2 ? space + 1 : max;
      out.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    if (rest) out.push(rest);
  }
  return out;
}

interface Piece {
  text: string;
  page: number;
  sep: string;
}

function pagesOf(pieces: Piece[]): [number, number] {
  const known = pieces.map((p) => p.page).filter((p) => p > 0);
  return known.length ? [Math.min(...known), Math.max(...known)] : [0, 0];
}

/**
 * Turns sections into chunks of at most maxChars characters. A section that fits is one chunk;
 * a longer one is cut at paragraph, line and sentence boundaries, in that order of preference,
 * into sub-chunks that each start with the section title, so every sub-chunk is embedded with
 * the context of its section. Table blocks (structuredTables) become sections of their own first
 * (tableSections); a table section is cut only between rows, a row longer than the room left
 * being the one exception, and every sub-chunk carries the caption and header line after the title.
 */
export function chunkSections(
  sections: Section[],
  { maxChars, pageLabels }: { maxChars: number; pageLabels?: string[] },
): Chunk[] {
  if (!Number.isInteger(maxChars) || maxChars < MIN_CHUNK_CHARS) {
    throw new Error(`chunk maximum must be an integer of at least ${MIN_CHUNK_CHARS} characters, got ${maxChars}`);
  }
  const chunks: Chunk[] = [];
  const label = (page: number) => (page > 0 ? (pageLabels?.[page - 1] ?? '') : '');
  splitLongByPage(foldEmptySections(withPaths(tableSections(sections))), maxChars).forEach((section, i) => {
    const headOf = (titles: string[]) =>
      titles
        .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_IN_TEXT))
        .filter(Boolean)
        .map((t) => `${t}\n`)
        .join('');
    const tableHead = section.table ? [section.table.caption ?? '', section.table.header] : [];
    let head = headOf([...(section.lead ?? []), section.title, ...tableHead]);
    // A long run of folded headings must not eat the room for the text; the title alone fits.
    if (head.length > maxChars / 2) head = headOf([section.title, ...tableHead]);
    if (head.length > maxChars / 2) head = headOf([section.title]);
    const budget = maxChars - head.length;
    const rowSep = section.table ? '\n' : '\n\n';
    const pieces: Piece[] = section.blocks.flatMap((b: Block, bi: number) =>
      splitToFit(b.text, budget).map((text, pi) => ({ text, page: b.page, sep: bi > 0 && pi === 0 ? rowSep : '' })),
    );
    const groups: Piece[][] = [];
    let len = 0;
    for (const p of pieces) {
      const cur = groups[groups.length - 1];
      if (cur && len + p.sep.length + p.text.length <= budget) {
        cur.push(p);
        len += p.sep.length + p.text.length;
      } else {
        groups.push([p]);
        len = p.text.length;
      }
    }
    const bodies = groups
      .map((g) => ({
        body: g
          .map((p, k) => (k ? p.sep : '') + p.text)
          .join('')
          .trim(),
        pages: pagesOf(g),
      }))
      .filter((g) => g.body);
    bodies.forEach((g, k) => {
      chunks.push({
        sectionTitle: section.title,
        sectionIndex: i + 1,
        sectionLevel: section.level,
        sectionPath: section.path ?? [],
        subIndex: k + 1,
        subCount: bodies.length,
        pageStart: g.pages[0],
        pageEnd: g.pages[1],
        pageLabelStart: label(g.pages[0]),
        pageLabelEnd: label(g.pages[1]),
        text: head + g.body,
      });
    });
  });
  return chunks;
}
