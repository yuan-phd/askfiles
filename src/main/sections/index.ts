import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkSections } from './chunk.js';
import { parseDocx } from './docx.js';
import { parseMarkdown } from './markdown.js';
import { parsePdf } from './pdf.js';
import { parsePlainText } from './text.js';
import type { Chunk, ParsedDocument } from './types.js';
import { parseXlsx } from './xlsx.js';

export * from './types.js';
export { chunkSections, foldEmptySections, splitToFit } from './chunk.js';
export { parsePlainText } from './text.js';

/** Bumped whenever a change to the splitter changes its output, so stored chunks get rebuilt. */
export const SPLITTER_VERSION = 1;

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.md', '.markdown', '.txt'] as const;

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
      return parseXlsx(buffer);
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
  return { parsed, chunks: chunkSections(parsed.sections, { maxChars }) };
}
export * from './documents.js';
