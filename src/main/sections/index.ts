import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkSections } from './chunk.js';
import { parseDocx } from './docx.js';
import { parseMarkdown } from './markdown.js';
import { parsePdf } from './pdf.js';
import { parsePlainText } from './text.js';
import type { Chunk, ParsedDocument } from './types.js';
import { parseCsv, parseXls, parseXlsx } from './xlsx.js';

export * from './types.js';
export { chunkSections, foldEmptySections, splitToFit, withPaths } from './chunk.js';
export { isAcceptableHeading, stripNumbering, MAX_HEADING_CHARS } from './headings.js';
export { docTitleOf, paragraphs, parsePlainText } from './text.js';

/**
 * Bumped whenever a change to the splitter changes its output, so stored chunks get rebuilt.
 * 2 (Session K): heading filter, heading paths and page labels in the section records, Word
 * headings from styles and outline levels, OCR page by page. The bump makes every library
 * reindex once on the first launch after the update.
 */
export const SPLITTER_VERSION = 2;

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
export async function parseFile(file: string): Promise<ParsedDocument> {
  const name = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  const buffer = await fs.readFile(file);
  switch (ext) {
    case '.pdf':
      return parsePdf(buffer, name);
    case '.docx':
      return parseDocx(buffer, name);
    case '.xlsx':
    case '.xlsm':
      return parseXlsx(buffer);
    case '.xls':
      return parseXls(buffer);
    case '.csv':
      return parseCsv(buffer, name);
    case '.md':
    case '.markdown':
      return parseMarkdown(buffer.toString('utf8'), name);
    case '.txt':
      return parsePlainText(buffer.toString('utf8'), name);
    default:
      throw new Error(`unsupported file type ${ext || '(none)'}: ${name}`);
  }
}

export async function splitFile(
  file: string,
  { maxChars }: { maxChars: number },
): Promise<{ parsed: ParsedDocument; chunks: Chunk[] }> {
  const parsed = await parseFile(file);
  return { parsed, chunks: chunkSections(parsed.sections, { maxChars, pageLabels: parsed.pageLabels }) };
}
export * from './documents.js';
