import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FileRecord } from '../watcher/index.js';
import { normalizeHeading } from './normalize.js';
import type { BrowseDocument, BrowseSection, OutlineEntry } from './types.js';

/** The keys of a section document (src/main/sections/documents.ts) the browse index reads. */
export interface StoredChunk {
  pageContent: string;
  sectionLevel?: number;
}

/** Longest title the chunker writes into the chunk text (MAX_TITLE_IN_TEXT in sections/chunk.ts). */
const MAX_TITLE_IN_TEXT = 200;
/** More folded headings than this above one section are not looked for. */
const MAX_LEAD = 32;
/** The splitter's titles for a PDF without bookmarks or heading fonts (sections/pdf.ts). */
const PAGE_TITLE = /^Page \d+$/;

export function documentId(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

/**
 * Splits a chunk's text into the heading lines the chunker put in front of it and the body. The
 * chunker writes the folded headings (lead) and then the section title, one per line, whitespace
 * collapsed and cut at 200 characters, and drops the lead when it would crowd out the text.
 */
export function splitHead(text: string, title: string): { lead: string[]; body: string } {
  const want = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_IN_TEXT);
  if (!want) return { lead: [], body: text };
  const lines = text.split('\n');
  const at = lines.slice(0, MAX_LEAD + 1).indexOf(want);
  if (at < 0) return { lead: [], body: text };
  return { lead: lines.slice(0, at), body: lines.slice(at + 1).join('\n') };
}

/** Level 0 sections are the text before the first heading, titled by the file name; page sections are not headings. */
function headingKey(title: string, level: number): string {
  if (level === 0 || PAGE_TITLE.test(title.trim())) return '';
  return normalizeHeading(title);
}

/**
 * Nests sections by heading level. A folded heading (a chapter heading right above its first
 * subsection) gets its own entry pointing at that section, one level above the next heading.
 * Level 0 text is the top of the page and gets no entry.
 */
export function buildOutline(sections: BrowseSection[]): OutlineEntry[] {
  const root: OutlineEntry[] = [];
  const stack: OutlineEntry[] = [];
  const add = (title: string, level: number, s: BrowseSection) => {
    const entry: OutlineEntry = { title, level, sectionIndex: s.index, page: s.pageStart, children: [] };
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    (stack.length ? stack[stack.length - 1]!.children : root).push(entry);
    stack.push(entry);
  };
  for (const s of sections) {
    if (s.level === 0) continue;
    s.lead.forEach((t, k) => add(t, Math.max(1, s.level - (s.lead.length - k)), s));
    add(s.title, s.level, s);
  }
  return root;
}

/**
 * The browse entry of one indexed file, from its index.json record and the section documents the
 * watcher wrote. Sub-chunks of a long section are joined again with a paragraph break; a missing
 * section document leaves that part empty rather than failing the whole file.
 */
export function buildDocument(
  rec: FileRecord,
  o: { root: string; readChunk: (location: string) => StoredChunk | null },
): BrowseDocument {
  const bySection = new Map<number, FileRecord['sections']>();
  for (const s of rec.sections) bySection.set(s.sectionIndex, [...(bySection.get(s.sectionIndex) ?? []), s]);
  const sections: BrowseSection[] = [...bySection.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, parts]) => {
      parts.sort((a, b) => a.subIndex - b.subIndex);
      const title = parts[0]!.sectionTitle;
      let level = 1;
      let lead: string[] = [];
      const bodies: string[] = [];
      parts.forEach((p, k) => {
        const chunk = o.readChunk(p.location);
        if (!chunk) return;
        if (k === 0 && typeof chunk.sectionLevel === 'number') level = chunk.sectionLevel;
        const head = splitHead(chunk.pageContent, title);
        if (k === 0) lead = head.lead;
        if (head.body.trim()) bodies.push(head.body.trim());
      });
      const pages = parts.flatMap((p) => [p.pageStart, p.pageEnd]).filter((n): n is number => typeof n === 'number');
      return {
        index,
        title,
        level,
        lead,
        heading: headingKey(title, level),
        pageStart: pages.length ? Math.min(...pages) : null,
        pageEnd: pages.length ? Math.max(...pages) : null,
        text: bodies.join('\n\n'),
      };
    });
  return {
    version: 1,
    id: documentId(rec.path),
    path: rec.path,
    url: rec.url,
    relPath: path.relative(o.root, rec.path) || path.basename(rec.path),
    title: path.basename(rec.path),
    size: rec.size,
    mtimeMs: rec.mtimeMs,
    hash: rec.hash,
    splitKey: rec.splitKey,
    indexedAt: rec.indexedAt,
    outline: buildOutline(sections),
    sections,
  };
}
