/** A paragraph-sized run of text. page is 1-based; 0 means the format has no pages (Word, Markdown). */
export interface Block {
  text: string;
  page: number;
  /** A table found by the parser (structuredTables); text is then empty. tableSections in tables.ts makes it a section. */
  table?: TableData;
}

/** A table as the parsers find it, before it becomes a section of row lines. */
export interface TableData {
  /** Caption above the table (Table 3, 表 1, a short line set apart), or empty: the section title is used. */
  title: string;
  /** Column labels, or empty when the first row does not look like a header. */
  header: string[];
  rows: { cells: string[]; page: number }[];
}

/**
 * Indexing switches (docs/plan.md, Measurement rounds and switches): each one changes the section records, so each
 * is part of the split key (splitKeyOf). All off gives the split of SPLITTER_VERSION 3.
 */
export interface SplitOptions {
  /** Tables kept as rows, one line per row with the header cells as labels (I1). */
  structuredTables?: boolean;
  /** Chinese heading patterns, running headers and contents pages in PDFs (I2). */
  cjkHeadings?: boolean;
}

/** The indexing block of a preset: the split switches and the OCR one. */
export interface IndexingOptions extends SplitOptions {
  /** Page images scaled to about 300 dpi, at least 2400 px wide, before OCR (I3). */
  ocrUpscale?: boolean;
}

export const INDEXING_SWITCHES = ['structuredTables', 'cjkHeadings', 'ocrUpscale'] as const;

/**
 * Revision of each switch's output, part of the split key next to its name: bumped whenever a
 * change to that switch's code changes the chunks, like SPLITTER_VERSION for the splitter as a
 * whole, so documents and cached vectors of an earlier revision are never reused.
 */
export const INDEXING_REVISION: Record<(typeof INDEXING_SWITCHES)[number], number> = {
  structuredTables: 2,
  cjkHeadings: 2,
  ocrUpscale: 1,
};

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
  /**
   * A table section: every block is one row line, cut only between rows, and every chunk repeats
   * the header line (structuredTables).
   */
  table?: { header: string; caption?: string };
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
  /**
   * PDF pages whose text layer is garbled or nearly empty on a scanned page (sections/pdf.ts,
   * isGarbled): the splitter OCRs them and parses again with their OCR text. Absent when none.
   */
  ocrPages?: number[];
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
