import type { Block, Chunk, Section } from './types.js';

/** Longest section title written into the chunk text; the full title stays in sectionTitle. */
const MAX_TITLE_IN_TEXT = 200;
export const MIN_CHUNK_CHARS = 400;

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
 * the context of its section.
 */
export function chunkSections(sections: Section[], { maxChars }: { maxChars: number }): Chunk[] {
  if (!Number.isInteger(maxChars) || maxChars < MIN_CHUNK_CHARS) {
    throw new Error(`chunk maximum must be an integer of at least ${MIN_CHUNK_CHARS} characters, got ${maxChars}`);
  }
  const chunks: Chunk[] = [];
  foldEmptySections(sections).forEach((section, i) => {
    const headOf = (titles: string[]) =>
      titles
        .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_IN_TEXT))
        .filter(Boolean)
        .map((t) => `${t}\n`)
        .join('');
    let head = headOf([...(section.lead ?? []), section.title]);
    // A long run of folded headings must not eat the room for the text; the title alone fits.
    if (head.length > maxChars / 2) head = headOf([section.title]);
    const budget = maxChars - head.length;
    const pieces: Piece[] = section.blocks.flatMap((b: Block, bi: number) =>
      splitToFit(b.text, budget).map((text, pi) => ({ text, page: b.page, sep: bi > 0 && pi === 0 ? '\n\n' : '' })),
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
        subIndex: k + 1,
        subCount: bodies.length,
        pageStart: g.pages[0],
        pageEnd: g.pages[1],
        text: head + g.body,
      });
    });
  });
  return chunks;
}
