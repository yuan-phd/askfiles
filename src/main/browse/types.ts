/** One entry of a document outline; children are the headings of a deeper level below it. */
export interface OutlineEntry {
  title: string;
  level: number;
  /** The section the entry opens; a folded heading (lead) points at the section it heads. */
  sectionIndex: number;
  page: number | null;
  /** Printed page label of page, when the PDF defines labels. */
  pageLabel: string | null;
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
}

/** One file of <libraryDir>/browse, also what the document page receives. */
export interface BrowseDocument {
  /** 2 since Session K added paths and page labels; other versions are rebuilt. */
  version: 2;
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

export interface HeadingEntry {
  documentId: string;
  documentTitle: string;
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
