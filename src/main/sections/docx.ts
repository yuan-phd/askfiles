import mammoth from 'mammoth';
import { isAcceptableHeading } from './headings.js';
import { docTitleOf, tidy } from './text.js';
import type { ParsedDocument, Section } from './types.js';
import { readZipEntry } from './zip.js';

// Word stores built-in heading styles under English names, but documents written by WPS and some
// localized templates carry the Chinese names, which mammoth's default map does not know.
const STYLE_MAP = [1, 2, 3, 4, 5, 6].flatMap((n) => [
  `p[style-name='标题 ${n}'] => h${n}:fresh`,
  `p[style-name='标题${n}'] => h${n}:fresh`,
  `p[style-name='heading ${n}'] => h${n}:fresh`,
]);

/** Style id the transform gives every paragraph found to be a heading of level n. */
const headingId = (n: number) => `AskfilesHeading${n}`;
const HEADING_MAP = [1, 2, 3, 4, 5, 6].map((n) => `p.${headingId(n)} => h${n}:fresh`);

const attr = (xml: string, name: string): string | null =>
  new RegExp(`<w:${name}\\b[^>]*\\bw:val="([^"]*)"`).exec(xml)?.[1] ?? null;

/** Heading level a style name implies: Heading 1 to 6 (any case), 标题 1 to 6, Title, Subtitle. */
export function levelFromStyleName(name: string): number | null {
  const n = name.trim().toLowerCase();
  const m = /^(?:heading|标题)\s*([1-6])$/.exec(n);
  if (m) return Number(m[1]);
  if (n === 'title' || n === '标题') return 1;
  if (n === 'subtitle' || n === '副标题') return 2;
  return null;
}

/** Outline level element value 0 to 8 as a heading level 1 to 6; 9 means body text. */
function levelFromOutline(v: string | null): number | null {
  if (v === null || !/^\d$/.test(v) || v === '9') return null;
  return Math.min(6, Number(v) + 1);
}

/**
 * Heading level per paragraph style id from word/styles.xml: from the style's outline level, else
 * its name (Heading 1 to 6, Title, Subtitle, their Chinese names), else the style it is based on,
 * so a custom style built on Heading 1 or one that only sets an outline level is a heading too.
 */
export function headingStyles(stylesXml: string): Map<string, number> {
  const own = new Map<string, { level: number | null; basedOn: string | null }>();
  for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const head = m[1]!;
    if (!/w:type="paragraph"/.test(head)) continue;
    const id = /w:styleId="([^"]*)"/.exec(head)?.[1];
    if (!id) continue;
    const body = m[2]!;
    const level = levelFromOutline(attr(body, 'outlineLvl')) ?? levelFromStyleName(attr(body, 'name') ?? '');
    own.set(id, { level, basedOn: attr(body, 'basedOn') });
  }
  const out = new Map<string, number>();
  for (const id of own.keys()) {
    let at: string | null = id;
    for (let depth = 0; at && depth < 16; depth++) {
      const s = own.get(at);
      if (!s) break;
      if (s.level !== null) {
        out.set(id, s.level);
        break;
      }
      at = s.basedOn;
    }
  }
  return out;
}

/**
 * Outline level set on each paragraph itself (w:pPr/w:outlineLvl), in the order mammoth's
 * transform visits paragraphs: children before parents, so a paragraph inside a text box comes
 * before the paragraph that holds it. mc:Choice branches are skipped like mammoth skips them.
 */
export function directOutlineLevels(documentXml: string): (number | null)[] {
  const xml = documentXml.replace(/<mc:Choice\b[\s\S]*?<\/mc:Choice>/g, '');
  const out: (number | null)[] = [];
  const stack: number[] = [];
  for (const m of xml.matchAll(/<(\/?)w:p(\/?)(?=[\s>/])[^>]*?(\/?)>/g)) {
    if (m[1] === '/') {
      const start = stack.pop();
      if (start === undefined) continue;
      const ppr = /^<w:p\b[^>]*>\s*<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(xml.slice(start, m.index! + m[0].length));
      out.push(ppr ? levelFromOutline(attr(ppr[1]!, 'outlineLvl')) : null);
    } else if (m[3] === '/' || m[2] === '/') {
      out.push(null);
    } else {
      stack.push(m.index!);
    }
  }
  return out;
}

interface MammothElement {
  type: string;
  styleId?: string | null;
  styleName?: string | null;
  children?: MammothElement[];
}

/** Paragraphs children first, the order directOutlineLevels lists them in. */
function paragraphsOf(e: MammothElement, out: MammothElement[] = []): MammothElement[] {
  for (const c of e.children ?? []) {
    paragraphsOf(c, out);
    if (c.type === 'paragraph') out.push(c);
  }
  return out;
}

/**
 * mammoth's transformDocument hook that marks heading paragraphs, by style (headingStyles) and by
 * a direct outline level. The direct levels are matched to paragraphs by position, so they are
 * used only when the counts agree; otherwise the style headings alone apply.
 */
function markHeadings(styles: Map<string, number>, direct: (number | null)[]) {
  return (doc: MammothElement): MammothElement => {
    const paragraphs = paragraphsOf(doc);
    const useDirect = direct.length === paragraphs.length;
    paragraphs.forEach((p, i) => {
      const level = (useDirect ? direct[i] : null) ?? (p.styleId ? styles.get(p.styleId) : undefined);
      if (level) {
        p.styleId = headingId(level);
        p.styleName = null;
      }
    });
    return doc;
  };
}

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
        const title = tidy(text).replace(/\n/g, ' ');
        if (isAcceptableHeading(title)) {
          if (current.level > 0 || current.blocks.length) sections.push(current);
          current = { title, level: headingLevel, blocks: [] };
        } else {
          // A sentence or a line of noise set in a heading style is body text.
          push(text);
        }
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

/**
 * Word files have no page numbers without a layout engine, so every block gets page 0. Headings
 * come from paragraph styles and outline levels read from the file itself (headingStyles,
 * directOutlineLevels), since mammoth's own map knows only the English built-in style names.
 */
export async function parseDocx(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  let styles = new Map<string, number>();
  let direct: (number | null)[] = [];
  try {
    styles = headingStyles(readZipEntry(buffer, 'word/styles.xml')?.toString('utf8') ?? '');
    direct = directOutlineLevels(readZipEntry(buffer, 'word/document.xml')?.toString('utf8') ?? '');
  } catch {
    // An archive mammoth can read but this reader cannot: mammoth's own heading map still applies.
  }
  const { value } = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: [...HEADING_MAP, ...STYLE_MAP],
      ignoreEmptyParagraphs: true,
      transformDocument: markHeadings(styles, direct),
    },
  );
  return sectionsFromHtml(value, fileName);
}
