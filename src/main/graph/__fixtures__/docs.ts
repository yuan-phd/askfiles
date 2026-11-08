import { documentId } from '../../browse/build.js';
import { normalizeHeading } from '../../browse/normalize.js';
import type { BrowseDocument, BrowseSection } from '../../browse/types.js';

/** A browse document for the graph tests: sections as [title, text] pairs, level 1. */
export function doc(
  title: string,
  sections: [string, string][],
  o: { mtimeMs?: number; folder?: string; levels?: number[] } = {},
): BrowseDocument {
  const p = `/lib/${o.folder ?? 'Docs'}/${title}`;
  const secs: BrowseSection[] = sections.map(([t, text], i) => {
    const level = o.levels?.[i] ?? 1;
    return {
      index: i + 1,
      title: t,
      level,
      lead: [],
      heading: level === 0 ? '' : normalizeHeading(t),
      path: [t],
      pageStart: null,
      pageEnd: null,
      pageLabelStart: null,
      pageLabelEnd: null,
      text,
      parts: [text],
    };
  });
  return {
    version: 3,
    id: documentId(p),
    path: p,
    url: `file://${p}`,
    relPath: `${o.folder ?? 'Docs'}/${title}`,
    title,
    size: 100,
    mtimeMs: o.mtimeMs ?? Date.parse('2026-01-01T00:00:00Z'),
    hash: `h-${title}`,
    splitKey: 'k',
    indexedAt: '2026-01-01T00:00:00Z',
    outline: secs
      .filter((s) => s.level > 0)
      .map((s) => ({
        title: s.title,
        level: s.level,
        sectionIndex: s.index,
        page: null,
        pageLabel: null,
        children: [],
      })),
    sections: secs,
  };
}

/** A paragraph of regulation text: numbered articles and obligation words. */
export const REGULATION_TEXT = [
  'Article 1 The Employer shall carry out maintenance in accordance with these Regulations.',
  'Article 2 Members must submit their logs before the deadline and shall not alter them afterwards.',
  'Article 3 The Employer shall publish the annual leave notice. Members must not collude.',
  '1.1 The procuring entity shall keep records. 1.2 It must make them available on request.',
].join('\n');

export const PROSE_TEXT =
  'This guidance explains how teams can think about value when they buy goods and services. It walks through ' +
  'the reasons behind each step, gives examples from past projects and shows how the pieces fit together, so ' +
  'that readers understand why the approach matters rather than only what to do. Long paragraphs of explanation ' +
  'like this one carry most of the text, with few numbered clauses and almost no obligations.';
