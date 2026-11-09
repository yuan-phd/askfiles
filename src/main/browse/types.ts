import type { DocumentKind, KindScores } from '../graph/kinds.js';

/** One entry of a document outline; children are the headings of a deeper level below it. */
export interface OutlineEntry {
  title: string;
  level: number;
  /** The section the entry opens; a folded heading (lead) points at the section it heads. */
  sectionIndex: number;
  page: number | null;
  /** Printed page label of page, when the PDF defines labels. */
  pageLabel: string | null;
  /**
   * Set when the entry stands for several parts the splitter cut (titles ending in (page N) or
   * (continued)): the last page they reach and the section index of every part, in order. The
   * Document page still renders each part; the outline shows one entry with the page range.
   */
  pageEnd?: number | null;
  pageLabelEnd?: string | null;
  parts?: number[];
  children: OutlineEntry[];
}

/** One section as the browse pages show it: the whole section, sub-chunks joined again. */
export interface BrowseSection {
  /** 1-based, the same sectionIndex as the section documents, search sources and index.json. */
  index: number;
  title: string;
  /** Heading level from the splitter, 1 for the top; 0 for text before the first heading. */
  level: number;
  /** Headings without a body of their own that the splitter folded into this section. */
  lead: string[];
  /** normalizeHeading(title); empty when the section takes no part in the heading index. */
  heading: string;
  /**
   * Titles from the top heading down to this section, its own title last (the section records');
   * empty when the record carries none (src/main/answer/sections.ts then uses the outline).
   */
  path: string[];
  /** PDF page index from 1 (sheet number for spreadsheets), and the printed labels when defined. */
  pageStart: number | null;
  pageEnd: number | null;
  pageLabelStart: string | null;
  pageLabelEnd: string | null;
  text: string;
  /**
   * The sub-chunk bodies in order, heading lines taken off; text is them joined with a blank line.
   * The answer pipeline assembles a long section's passage from them (src/main/answer/sections.ts).
   */
  parts: string[];
}

/** The structural kind of a document, found at index time (src/main/graph/kinds.ts). */
export interface DocumentKindRecord {
  kind: DocumentKind;
  scores: KindScores;
  words: number;
}

/** One file of <libraryDir>/browse, also what the document page receives. */
export interface BrowseDocument {
  /** 3 since sections carry their sub-chunks (parts); other versions are rebuilt. */
  version: 3;
  /** First 16 hex digits of sha256 of the path; stable while the file keeps its path. */
  id: string;
  path: string;
  url: string;
  /** Path shown to the user: the linked folder's name and the path inside it, or the file name. */
  relPath: string;
  /** File name with its extension, as the source cards show it. */
  title: string;
  size: number;
  mtimeMs: number;
  hash: string;
  splitKey: string;
  indexedAt: string;
  outline: OutlineEntry[];
  sections: BrowseSection[];
  /**
   * Kind and scores (docs/graph.md). Set when the document is built; a file stored before Session N
   * lacks it and gets it when the index loads.
   */
  kind?: DocumentKindRecord;
}

/** A document in the library list: everything but the section text. */
export type DocumentSummary = Omit<BrowseDocument, 'version' | 'sections' | 'hash' | 'splitKey'> & {
  sectionCount: number;
};

/** How a page names a document: its id, or a source's url and file name. */
export interface DocumentRef {
  id?: string | null;
  url?: string | null;
  title?: string | null;
}

/** One part of a section as Compare shows it: its own page range and text. */
export interface HeadingPart {
  pageStart: number | null;
  pageEnd: number | null;
  pageLabelStart: string | null;
  pageLabelEnd: string | null;
  text: string;
}

export interface HeadingEntry {
  documentId: string;
  documentTitle: string;
  /** The name the Ask cards show for the file (identifiers.ts displayName). */
  display: string;
  relPath: string;
  url: string;
  sectionIndex: number;
  /** The heading as written in this document. */
  title: string;
  pageStart: number | null;
  pageEnd: number | null;
  pageLabelStart: string | null;
  pageLabelEnd: string | null;
  /** The section text; only when one group is asked for by its key. */
  text?: string;
  /**
   * The parts in document order, each with its own pages; only with the text. Neighbouring parts
   * on the same pages are one part, so a page label never repeats back to back.
   */
  parts?: HeadingPart[];
}

export interface HeadingGroup {
  key: string;
  /** The most common spelling among the entries. */
  label: string;
  /** Number of distinct documents with this heading. */
  documents: number;
  entries: HeadingEntry[];
}

export interface SearchHit {
  sectionIndex: number;
  title: string;
  /** [start, end) of each term occurrence inside title. */
  titleMarks: [number, number][];
  pageStart: number | null;
  pageEnd: number | null;
  pageLabelStart: string | null;
  pageLabelEnd: string | null;
  /** Occurrences of all terms in this section. */
  count: number;
  /**
   * 0: the query's terms next to each other in its order; 1: all within one paragraph; 2: the
   * rest. Results are ranked by it (search.ts matchTier).
   */
  tier: 0 | 1 | 2;
  snippet: string;
  /** [start, end) of each term occurrence inside snippet, for highlighting. */
  marks: [number, number][];
}

export interface SearchGroup {
  document: DocumentSummary;
  count: number;
  hits: SearchHit[];
}

export interface SearchResult {
  query: string;
  terms: string[];
  /** Matching sections over all documents, before the limit. */
  total: number;
  groups: SearchGroup[];
  truncated: boolean;
}
