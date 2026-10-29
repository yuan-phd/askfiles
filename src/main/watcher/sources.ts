import path from 'node:path';
import type { FileRecord, SectionRecord } from './types.js';

/** A source as src/renderer/api/client.js normalizeSource returns it; only these keys are read. */
export interface SourceLike {
  title?: string | null;
  url?: string | null;
  text?: string | null;
  sectionTitle?: string | null;
  sectionIndex?: number | null;
  page?: number | null;
  pageEnd?: number | null;
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Fills sectionTitle, sectionIndex, page and pageEnd into vector-search results, which drop the
 * custom keys of the section documents (docs/upstream-analysis.md Q15). The document is found by
 * the url the shell wrote, else by a file name that only one indexed file has. The section is the
 * one whose stored text contains the chunk: upstream sub-splits a long section into chunks that
 * are substrings of it apart from whitespace at the joins. Sources already carrying a section,
 * and sources that match nothing, come back unchanged.
 */
export function createSourceResolver(deps: {
  files: () => FileRecord[];
  readText: (location: string) => string | null;
}): <T extends SourceLike>(sources: T[]) => T[] {
  // Locations are content-addressed, so a cached text never goes stale.
  const texts = new Map<string, string | null>();
  const textOf = (location: string): string | null => {
    if (!texts.has(location)) {
      const t = deps.readText(location);
      texts.set(location, t === null ? null : squash(t));
    }
    return texts.get(location) ?? null;
  };

  const findFile = (files: FileRecord[], s: SourceLike): FileRecord | null => {
    if (s.url) {
      const byUrl = files.find((f) => f.url === s.url);
      if (byUrl) return byUrl;
    }
    if (s.title) {
      const byName = files.filter((f) => path.basename(f.path) === s.title);
      if (byName.length === 1) return byName[0]!;
    }
    return null;
  };

  const findSection = (file: FileRecord, s: SourceLike): SectionRecord | null => {
    if (file.sections.length === 1) return file.sections[0]!;
    const chunk = squash(s.text ?? '');
    if (!chunk) return null;
    return file.sections.find((sec) => textOf(sec.location)?.includes(chunk)) ?? null;
  };

  return (sources) => {
    const files = deps.files();
    return sources.map((s) => {
      if (s.sectionTitle != null && s.sectionIndex != null) return s;
      const file = findFile(files, s);
      const sec = file && findSection(file, s);
      if (!sec) return s;
      return {
        ...s,
        sectionTitle: sec.sectionTitle,
        sectionIndex: sec.sectionIndex,
        page: s.page ?? sec.pageStart,
        pageEnd: s.pageEnd ?? sec.pageEnd,
      };
    });
  };
}
