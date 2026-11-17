import path from 'node:path';
import type { Block, ParsedDocument, Section } from './types.js';
import { readZipEntry } from './zip.js';

/**
 * PowerPoint (.pptx): one section per slide, in the order of the deck (presentation.xml, not the
 * file names, which keep their numbers when slides are moved). The title is the text of the
 * slide's title placeholder, else Slide N; the body is every other text frame in document order,
 * tables one line per row with cells separated by a vertical bar, then the speaker notes. The page
 * fields carry the slide number, as they carry the sheet number for spreadsheets. The collector
 * reads a pptx as one run of text without slide boundaries, which is why the shell parses it.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (tag: string, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Relationship id to target path (resolved against the part's folder) of a .rels part. */
function relsOf(zip: Buffer, part: string): Map<string, { type: string; target: string }> {
  const dir = path.posix.dirname(part);
  const rels = readZipEntry(zip, path.posix.join(dir, '_rels', `${path.posix.basename(part)}.rels`));
  const out = new Map<string, { type: string; target: string }>();
  if (!rels) return out;
  for (const m of rels.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (!id || !target || attr(m[0], 'TargetMode') === 'External') continue;
    out.set(id, { type: attr(m[0], 'Type') ?? '', target: path.posix.normalize(path.posix.join(dir, target)) });
  }
  return out;
}

/** Text of one a:p paragraph: runs, fields and line breaks. */
function paragraphText(p: string): string {
  let text = '';
  for (const m of p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:t\/>|<a:br\b[^>]*\/>/g))
    text += m[1] !== undefined ? decode(m[1]) : m[0].startsWith('<a:br') ? '\n' : '';
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/** Paragraph texts of a text body, empty ones dropped. */
function bodyLines(body: string): string[] {
  return [...body.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>|<a:p\/>/g)]
    .map((m) => paragraphText(m[1] ?? ''))
    .filter(Boolean);
}

/** One line per table row, cells joined by a vertical bar. */
function tableLines(tbl: string): string[] {
  return [...tbl.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)]
    .map((tr) =>
      [...tr[1]!.matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>|<a:tc\b[^>]*\/>/g)]
        .map((tc) => bodyLines(tc[1] ?? '').join(' '))
        .join(' | '),
    )
    .filter((line) => line.replace(/[|\s]/g, ''));
}

/** Placeholder types that only repeat what the slide master prints: slide number, date, footer. */
const CHROME = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);

/**
 * Title and body lines of a slide or notes part. Shapes (p:sp) and tables (in p:graphicFrame) are
 * read in document order; group shapes are flattened by the scan itself.
 */
export function slideText(xml0: string): { title: string; lines: string[] } {
  // Newer shapes come twice, as the new form and a fallback for older readers: read one.
  const xml = xml0.replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, '');
  let title = '';
  const lines: string[] = [];
  for (const m of xml.matchAll(
    /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>|<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/g,
  )) {
    if (m[2] !== undefined) {
      const tbl = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/.exec(m[2]);
      if (tbl) lines.push(...tableLines(tbl[1]!));
      continue;
    }
    const sp = m[1]!;
    const ph = /<p:ph\b[^>]*\/?>/.exec(sp)?.[0];
    const type = ph ? (attr(ph, 'type') ?? 'body') : null;
    if (type && CHROME.has(type)) continue;
    const body = /<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/.exec(sp)?.[1];
    if (!body) continue;
    const text = bodyLines(body);
    if (!text.length) continue;
    if ((type === 'title' || type === 'ctrTitle') && !title) title = text.join(' ');
    else lines.push(...text);
  }
  return { title, lines };
}

/** Slide parts in deck order, from presentation.xml's slide list and its relationships. */
function slideParts(zip: Buffer): string[] {
  const pres = readZipEntry(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('not a PowerPoint file: ppt/presentation.xml is missing');
  const rels = relsOf(zip, 'ppt/presentation.xml');
  const list = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(pres.toString('utf8'))?.[1] ?? '';
  return [...list.matchAll(/<p:sldId\b[^>]*\/?>/g)]
    .map((m) => rels.get(attr(m[0], 'r:id') ?? '')?.target)
    .filter((t): t is string => !!t);
}

export function parsePptx(buffer: Buffer): ParsedDocument {
  const parts = slideParts(buffer);
  const sections: Section[] = [];
  parts.forEach((part, i) => {
    const xml = readZipEntry(buffer, part);
    if (!xml) return;
    const page = i + 1;
    const { title, lines } = slideText(xml.toString('utf8'));
    const notesPart = [...relsOf(buffer, part).values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notesXml = notesPart ? readZipEntry(buffer, notesPart) : null;
    const notes = notesXml ? slideText(notesXml.toString('utf8')).lines : [];
    const blocks: Block[] = lines.map((text) => ({ text, page }));
    if (notes.length) blocks.push({ text: `Notes: ${notes.join('\n')}`, page });
    // A slide with no text at all (a picture only) has nothing to find; its number is skipped.
    if (!title && !blocks.length) return;
    sections.push({ title: title || `Slide ${page}`, level: 1, blocks });
  });
  return { sections, outline: 'slides', pages: parts.length, needsOcr: false };
}
