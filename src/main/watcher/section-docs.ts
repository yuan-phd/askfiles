import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Section } from './types.js';

/** Folder under STORAGE_DIR/documents that holds every section document the shell writes. */
export const DOCS_FOLDER = 'askfiles';
export const DOC_SOURCE = 'askfiles section split';

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export async function hashFile(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Deterministic name per file and section content. An unchanged section keeps its name, so
 * upstream's vector cache (keyed by document path) hits and nothing is re-embedded; a changed
 * section gets a new name (docs/upstream-analysis.md Q13, option b2).
 */
export function sectionLocation(sourcePath: string, s: Section): string {
  const fileKey = sha(sourcePath).slice(0, 16);
  const sectionKey = sha(JSON.stringify([s.sectionIndex, s.sectionTitle, s.pageStart, s.pageEnd, s.text])).slice(0, 16);
  return `${DOCS_FOLDER}/${fileKey}-${sectionKey}.json`;
}

/**
 * The document JSON upstream reads for update-embeddings: the keys the collector writes plus the
 * section keys, which reach the chat sources unchanged (Q13, Q15). LanceDB fixes a table's columns
 * from its first rows, so every document carries the same flat keys with the same types; unknown
 * pages are written as 0, never null (Q13, condition 1).
 */
export function sectionDocument(sourcePath: string, s: Section, published: string): Record<string, unknown> {
  const words = s.text.split(/\s+/).filter(Boolean).length;
  return {
    id: crypto.randomUUID(),
    url: pathToFileURL(sourcePath).href,
    title: path.basename(sourcePath),
    docAuthor: '',
    description: '',
    docSource: DOC_SOURCE,
    chunkSource: '',
    published,
    wordCount: words,
    token_count_estimate: Math.ceil(s.text.length / 4),
    pageContent: s.text,
    sectionTitle: s.sectionTitle,
    sectionIndex: s.sectionIndex,
    pageStart: s.pageStart ?? 0,
    pageEnd: s.pageEnd ?? s.pageStart ?? 0,
    sourcePath,
  };
}

export function documentsDir(storageDir: string): string {
  return path.join(storageDir, 'documents');
}

export function writeSectionDocument(storageDir: string, location: string, doc: Record<string, unknown>): void {
  const file = path.join(documentsDir(storageDir), location);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc));
}

export function readSectionText(storageDir: string, location: string): string | null {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(documentsDir(storageDir), location), 'utf8')) as {
      pageContent?: unknown;
    };
    return typeof doc.pageContent === 'string' ? doc.pageContent : null;
  } catch {
    return null;
  }
}
