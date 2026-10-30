/** A paragraph-sized run of text. page is 1-based; 0 means the format has no pages (Word, Markdown). */
export interface Block {
  text: string;
  page: number;
}

/** One heading and the text under it, up to the next heading of any level. */
export interface Section {
  title: string;
  /** Heading level, 1 for the top; 0 for the text before the first heading. */
  level: number;
  blocks: Block[];
  /** Headings without a body of their own that were folded into this section, outermost first. */
  lead?: string[];
  /** Titles from the top heading down to this one, from the heading levels (withPaths in chunk.ts). */
  path?: string[];
}

/** Where the section boundaries came from. */
export type OutlineSource = 'bookmarks' | 'font-size' | 'headings' | 'pages' | 'sheets' | 'none';

export interface ParsedDocument {
  sections: Section[];
  outline: OutlineSource;
  /** Page count for PDF, sheet count for spreadsheets, 0 otherwise. */
  pages: number;
  /** A PDF without any text layer: the caller has to OCR it. sections is empty then. */
  needsOcr: boolean;
  /** Printed page label per PDF page (pdfjs getPageLabels), index 0 for page 1; absent when none. */
  pageLabels?: string[];
}

/** What gets embedded: a whole section, or one sub-chunk of a section longer than the maximum. */
export interface Chunk {
  sectionTitle: string;
  /** 1-based position of the section in its document. */
  sectionIndex: number;
  sectionLevel: number;
  /**
   * Titles from the top heading down to this section, this section's own title last. Always set
   * by chunkSections; optional so chunks built by hand (scripts/eval tests) need not carry it.
   */
  sectionPath?: string[];
  /** 1-based position of this sub-chunk inside its section, and how many there are. */
  subIndex: number;
  subCount: number;
  /** Page range of the text in this chunk; 0 when unknown. For spreadsheets, the sheet number. */
  pageStart: number;
  pageEnd: number;
  /** Printed labels of pageStart and pageEnd when the PDF defines page labels, else empty. */
  pageLabelStart?: string;
  pageLabelEnd?: string;
  /** Section title on the first line, then the body. Never longer than the chunk maximum. */
  text: string;
}
