import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Chunk } from './types.js';

/**
 * The document JSON upstream reads from STORAGE_DIR/documents for update-embeddings (route b2 of
 * docs/upstream-analysis.md Q13). The first block of keys is the shape the collector writes; the
 * rest reach the chat sources unchanged (Q15). LanceDB fixes a table's columns from its first
 * rows, so every document carries every key with the same type and none is ever null.
 */
export interface SectionDocument {
  id: string;
  url: string;
  title: string;
  docAuthor: string;
  description: string;
  docSource: string;
  chunkSource: string;
  published: string;
  wordCount: number;
  token_count_estimate: number;
  pageContent: string;
  sectionTitle: string;
  sectionIndex: number;
  sectionLevel: number;
  subIndex: number;
  subCount: number;
  /** 0 when the format has no pages; the sheet number for spreadsheets. */
  pageStart: number;
  pageEnd: number;
  sourcePath: string;
  fileHash: string;
  splitKey: string;
}

export const DOC_SOURCE = 'askfiles section split';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Words for Latin text, characters for Chinese, the way a reader would count them. */
export function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const words = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ').match(/\S+/g)?.length ?? 0;
  return cjk + words;
}

/** Rough tokens: about one per Chinese character and one per four other characters (plan, phase 2). */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** File name safe for the documents folder: ASCII letters, digits, dot, dash; at most 60 characters. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return slug || 'file';
}

export interface FileRef {
  /** Absolute path of the original file. */
  path: string;
  /** Path relative to the library root; part of the name so two files with equal bytes stay apart. */
  relPath: string;
  /** sha256 of the file bytes. */
  hash: string;
}

/**
 * Document JSON and its file name for each chunk of one file. The name depends only on the file's
 * path and bytes, the split settings (splitKey) and the chunk position, so an unchanged file maps
 * to the same names and upstream's vector cache, keyed by document path, is reused; any change
 * gives new names and a fresh embedding.
 */
export function sectionDocuments(
  chunks: Chunk[],
  file: FileRef,
  { splitKey, published, author = '' }: { splitKey: string; published: string; author?: string },
): { name: string; doc: SectionDocument }[] {
  const base = file.relPath.split(/[\\/]/).pop() ?? file.relPath;
  const stem = sha256(`${file.relPath}\u0000${file.hash}\u0000${splitKey}`).slice(0, 12);
  const url = pathToFileURL(file.path).href;
  return chunks.map((c) => {
    const name = `${slugify(base)}-${stem}-${c.sectionIndex}-${c.subIndex}.json`;
    const id = sha256(`${stem}\u0000${c.sectionIndex}\u0000${c.subIndex}`).slice(0, 32);
    return {
      name,
      doc: {
        id: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`,
        url,
        title: base,
        docAuthor: author,
        description: c.sectionTitle,
        docSource: DOC_SOURCE,
        chunkSource: '',
        published,
        wordCount: countWords(c.text),
        token_count_estimate: estimateTokens(c.text),
        pageContent: c.text,
        sectionTitle: c.sectionTitle,
        sectionIndex: c.sectionIndex,
        sectionLevel: c.sectionLevel,
        subIndex: c.subIndex,
        subCount: c.subCount,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        sourcePath: file.path,
        fileHash: file.hash,
        splitKey,
      },
    };
  });
}

/** Key of the split settings: changing any of them changes every document name. */
export function splitKeyOf(settings: {
  splitterVersion: number;
  strategy: string;
  maxChars: number;
  embeddingModel: string;
}): string {
  return sha256(
    JSON.stringify([settings.splitterVersion, settings.strategy, settings.maxChars, settings.embeddingModel]),
  ).slice(0, 12);
}
