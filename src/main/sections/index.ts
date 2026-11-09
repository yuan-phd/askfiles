import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkSections } from './chunk.js';
import { parseDocx } from './docx.js';
import { parseMarkdown } from './markdown.js';
import { parsePdf } from './pdf.js';
import { parsePlainText } from './text.js';
import type { Chunk, ParsedDocument, SplitOptions } from './types.js';
import { parseCsv, parseXls, parseXlsx } from './xlsx.js';

export * from './types.js';
export { chunkSections, foldEmptySections, pageTitle, splitLongByPage, splitToFit, withPaths } from './chunk.js';
export { findPdfTables, formatRow, headerLine, looksLikeHeader, tableSections } from './tables.js';
export { cjkHeading, cjkMarks, cjkSectionsFromBlocks, cleanCjkLines, despace, isCjkText } from './cjk.js';
export { isGarbled, pageQuality, readableLength, GARBLED_CHAR_SHARE, GARBLED_WORD_SHARE, SPARSE_CHARS } from './pdf.js';
export { isAcceptableHeading, stripNumbering, MAX_HEADING_CHARS } from './headings.js';
export { docTitleOf, paragraphs, parsePlainText } from './text.js';

/**
 * Bumped whenever a change to the splitter changes its output, so stored chunks get rebuilt.
 * 2 (Session K): heading filter, heading paths and page labels in the section records, Word
 * headings from styles and outline levels, OCR page by page. The bump makes every library
 * reindex once on the first launch after the update.
 * 3: long sections without sub-headings split by page (splitLongByPage); garbled PDF pages OCRed.
 * 4: garbled pages judged with figures and Chinese punctuation neutral and figure words plausible,
 *    thresholds recalibrated; OCR text replaces a layer only past the replacement guard.
 */
export const SPLITTER_VERSION = 4;

export const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.xlsx',
  '.xlsm',
  '.xls',
  '.csv',
  '.md',
  '.markdown',
  '.txt',
] as const;

export function isSupported(file: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase());
}

/** Reads and parses one file into sections by its extension. */
export async function parseFile(
  file: string,
  o: { pageText?: Map<number, string> } & SplitOptions = {},
): Promise<ParsedDocument> {
  const name = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  const buffer = await fs.readFile(file);
  switch (ext) {
    case '.pdf':
      return parsePdf(buffer, name, o);
    case '.docx':
      return parseDocx(buffer, name, o);
    case '.xlsx':
    case '.xlsm':
      return parseXlsx(buffer, o);
    case '.xls':
      return parseXls(buffer, o);
    case '.csv':
      return parseCsv(buffer, name, o);
    case '.md':
    case '.markdown':
      return parseMarkdown(buffer.toString('utf8'), name);
    case '.txt':
      return parsePlainText(buffer.toString('utf8'), name, o);
    default:
      throw new Error(`unsupported file type ${ext || '(none)'}: ${name}`);
  }
}

export async function splitFile(
  file: string,
  { maxChars, ...o }: { maxChars: number } & SplitOptions,
): Promise<{ parsed: ParsedDocument; chunks: Chunk[] }> {
  const parsed = await parseFile(file, o);
  return { parsed, chunks: chunkSections(parsed.sections, { maxChars, pageLabels: parsed.pageLabels }) };
}
export * from './documents.js';
