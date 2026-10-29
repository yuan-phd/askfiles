import mammoth from 'mammoth';
import { docTitleOf, tidy } from './text.js';
import type { ParsedDocument, Section } from './types.js';

// Word stores built-in heading styles under English names, but documents written by WPS and some
// localized templates carry the Chinese names, which mammoth's default map does not know.
const STYLE_MAP = [1, 2, 3, 4, 5, 6].flatMap((n) => [
  `p[style-name='标题 ${n}'] => h${n}:fresh`,
  `p[style-name='标题${n}'] => h${n}:fresh`,
  `p[style-name='heading ${n}'] => h${n}:fresh`,
]);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Sections from the HTML mammoth produces: h1 to h6 start sections; p and li are paragraphs; a
 * table becomes one block with one line per row and cells separated by a vertical bar.
 * mammoth's output is well formed and flat enough that a tag scanner is sufficient.
 */
export function sectionsFromHtml(html: string, fileName: string): ParsedDocument {
  const sections: Section[] = [];
  let current: Section = { title: docTitleOf(fileName), level: 0, blocks: [] };
  let text = '';
  let headingLevel = 0;
  let row: string[] | null = null;
  let rows: string[] | null = null;
  const push = (t: string) => {
    const clean = tidy(t);
    if (clean) current.blocks.push({ text: clean, page: 0 });
  };
  const tags = /<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/gi;
  for (const m of html.matchAll(tags)) {
    if (m[3] !== undefined) {
      text += decode(m[3]);
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (!closing) {
        push(text);
        text = '';
        headingLevel = Number(tag[1]);
      } else {
        if (current.level > 0 || current.blocks.length) sections.push(current);
        current = { title: tidy(text).replace(/\n/g, ' '), level: headingLevel, blocks: [] };
        text = '';
        headingLevel = 0;
      }
    } else if (tag === 'table') {
      if (!closing) {
        push(text);
        text = '';
        rows = [];
      } else if (rows) {
        push(rows.join('\n'));
        rows = null;
      }
    } else if (tag === 'tr') {
      if (!closing) row = [];
      else if (row && rows) {
        if (row.some(Boolean)) rows.push(row.join(' | '));
        row = null;
      }
    } else if (tag === 'td' || tag === 'th') {
      if (closing && row) row.push(tidy(text).replace(/\n/g, ' '));
      text = '';
    } else if (tag === 'br') {
      text += '\n';
    } else if ((tag === 'p' || tag === 'li') && !row) {
      // Pushing on the opening tag too keeps a parent list item apart from its nested items.
      push(text);
      text = '';
    } else if (tag === 'p' && closing && row) {
      text += '\n';
    }
  }
  push(text);
  if (current.level > 0 || current.blocks.length) sections.push(current);
  return { sections, outline: sections.some((s) => s.level > 0) ? 'headings' : 'none', pages: 0, needsOcr: false };
}

/** Word files have no page numbers without a layout engine, so every block gets page 0. */
export async function parseDocx(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  const { value } = await mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP, ignoreEmptyParagraphs: true });
  return sectionsFromHtml(value, fileName);
}
