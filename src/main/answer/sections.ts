/**
 * Section records for the answer pipeline, read from the browse index (src/main/browse), which
 * holds every section's full text with its sub-chunks joined in document order. File name, section
 * path and pages on a source card come from here only, never from the model's text.
 */
import type { BrowseDocument, BrowseSection, OutlineEntry } from '../browse/index.js';
import { sectionKey, type SectionKey } from './fusion.js';

export interface AnswerSection {
  key: SectionKey;
  documentId: string;
  /** File name with extension. */
  file: string;
  relPath: string;
  url: string;
  sectionIndex: number;
  title: string;
  /** Parent headings, outermost first, then the title. */
  path: string[];
  /** PDF page range (1-based), null for formats without pages. */
  pageStart: number | null;
  pageEnd: number | null;
  /** Printed page label from the PDF when the section records carry one. */
  pageLabel: string | null;
  /** The section text given to the reranker and the model, cut to the section cap. */
  text: string;
  /** Length of the whole section text before the cut. */
  fullLength: number;
}

/** The title chain from the outline root down to the entry of this section, or null. */
function outlineChain(entries: OutlineEntry[], s: BrowseSection, above: string[] = []): string[] | null {
  for (const e of entries) {
    const chain = [...above, e.title];
    if (e.sectionIndex === s.index && e.title === s.title) return chain;
    const deeper = outlineChain(e.children, s, chain);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Section path: the record's own path when the splitter provides one (Session K adds it), else
 * the chain of outline headings down to the section, else the title alone.
 */
export function sectionPath(doc: BrowseDocument, s: BrowseSection): string[] {
  const own = (s as BrowseSection & { path?: unknown }).path;
  if (Array.isArray(own) && own.length && own.every((t) => typeof t === 'string')) {
    const p = own as string[];
    return p[p.length - 1] === s.title ? p : [...p, s.title];
  }
  return outlineChain(doc.outline, s) ?? [s.title];
}

/** Printed page label, when the section record carries one (Session K, PDF page labels). */
export function pageLabelOf(s: BrowseSection): string | null {
  const r = s as BrowseSection & { pageLabel?: unknown; pageLabelStart?: unknown };
  const v = r.pageLabel ?? r.pageLabelStart;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A line of the hit text long enough to find again in the section text. */
function probeOf(hit: string): string | null {
  const lines = hit
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);
  if (!lines.length) return null;
  // The last long line: the chunk text starts with the heading lines, which the section text lacks.
  return lines[lines.length - 1]!.slice(0, 40);
}

/**
 * Cuts a section longer than cap to cap characters. The window starts a quarter of the cap before
 * the first vector hit found in the text, so the part that matched is inside; without a hit it is
 * the start of the section. A cut end is marked with ...
 */
export function cutSection(text: string, cap: number, hitTexts: string[] = []): string {
  if (text.length <= cap) return text;
  let at = -1;
  for (const hit of hitTexts) {
    const probe = probeOf(hit);
    const i = probe ? text.indexOf(probe) : -1;
    if (i >= 0) {
      at = i;
      break;
    }
  }
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(cap / 4), text.length - cap));
  const end = start + cap;
  return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
}

export function toAnswerSection(
  doc: BrowseDocument,
  s: BrowseSection,
  cap: number,
  hitTexts: string[] = [],
): AnswerSection {
  return {
    key: sectionKey(doc.id, s.index),
    documentId: doc.id,
    file: doc.title,
    relPath: doc.relPath,
    url: doc.url,
    sectionIndex: s.index,
    title: s.title,
    path: sectionPath(doc, s),
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    pageLabel: pageLabelOf(s),
    text: cutSection(s.text || s.title, cap, hitTexts),
    fullLength: s.text.length,
  };
}
