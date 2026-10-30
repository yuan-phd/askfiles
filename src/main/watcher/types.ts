import type { Chunk } from '../sections/index.js';

/** The section split the watcher embeds; sectionSplitter (splitter.ts) wraps src/main/sections. */
export interface Splitter {
  /** Key of the split settings (splitKeyOf); part of every document name, so a change re-embeds. */
  readonly splitKey: string;
  /** Chunks of the file at an absolute path, in document order, each within the chunk maximum. */
  split(filePath: string): Promise<Chunk[]>;
}

/** The library calls the watcher needs, so tests can run against a fake. */
export interface LibraryApi {
  /** POST /v1/workspace/{slug}/update-embeddings. */
  updateEmbeddings(slug: string, change: { adds: string[]; deletes: string[] }): Promise<void>;
  /** Unembeds from the workspace and purges the stored document JSON. */
  removeDocuments(slug: string, locations: string[]): Promise<void>;
  /** docpath to upstream docId for every document embedded in the workspace. */
  workspaceDocuments(slug: string): Promise<Map<string, string>>;
}

/** Collector calls for OCR: a scanned PDF is uploaded once without embedding, only for its text. */
export interface OcrApi {
  /** POST /v1/document/upload without addToWorkspaces. Returns the parsed text and stored copies. */
  uploadForText(filePath: string): Promise<{ text: string; locations: string[] }>;
  /** The same for one image (a scanned page as PNG); the collector OCRs it. No text gives empty text. */
  uploadImageForText(image: Buffer, fileName: string): Promise<{ text: string; locations: string[] }>;
  /** DELETE /v1/system/remove-documents for copies no workspace uses. */
  purgeDocuments(locations: string[]): Promise<void>;
}

export type WatchEventType = 'add' | 'change' | 'unlink';

export interface WatchHandle {
  /** Resolves once changes are being reported. */
  ready: Promise<void>;
  close(): Promise<void>;
}

/**
 * Starts a recursive watch on root. Initial files are not reported: the watcher reconciles them
 * against index.json itself, after ready.
 */
export type WatchFactory = (
  root: string,
  onEvent: (type: WatchEventType, absPath: string) => void,
  onError: (err: Error) => void,
) => WatchHandle;

export interface SectionRecord {
  /** Path relative to STORAGE_DIR/documents, as update-embeddings takes it. */
  location: string;
  /** Upstream workspace document id, or null when the workspace did not list it. */
  docId: string | null;
  sectionTitle: string;
  sectionIndex: number;
  /** Heading level, 1 for the top; 0 for the text before the first heading. */
  sectionLevel: number;
  /** Titles from the top heading down to this section, its own title last; empty for level 0. */
  sectionPath: string[];
  /** Position of this chunk inside a section longer than the chunk maximum, from 1. */
  subIndex: number;
  /** First and last page (PDF page index from 1, sheet number for spreadsheets), or null. */
  pageStart: number | null;
  pageEnd: number | null;
  /** Printed page labels of pageStart and pageEnd when the PDF defines them, else null. */
  pageLabelStart: string | null;
  pageLabelEnd: string | null;
}

export interface FileRecord {
  path: string;
  url: string;
  /** Path shown to the user: the folder's name and the path inside it, or the file name. */
  relPath: string;
  /** Id of the library source (WatchRoot) the file was found in. */
  sourceId: string;
  hash: string;
  /** Splitter.splitKey the file was indexed with; another key means it is split again. */
  splitKey: string;
  size: number;
  mtimeMs: number;
  /** ISO time of the last successful index. */
  indexedAt: string;
  sections: SectionRecord[];
}

export interface IndexData {
  version: 1;
  files: Record<string, FileRecord>;
}

export type JobKind = 'upsert' | 'remove';

export interface DeadLetter {
  path: string;
  kind: JobKind;
  error: string;
  attempts: number;
  at: string;
}

export interface WatcherStatus {
  state: 'starting' | 'idle' | 'working' | 'stopped';
  /** Files waiting for the debounce or for their turn in the queue, plus the active one. */
  pending: number;
  current: string | null;
  indexed: number;
  deadLetters: DeadLetter[];
  /** Folders of the library that could not be read at start; their files stay in the index. */
  unavailable: string[];
}

export interface FileEvent {
  path: string;
  kind: JobKind;
  outcome: 'indexed' | 'unchanged' | 'removed' | 'retrying' | 'dead-letter';
  sections?: number;
  attempt?: number;
  error?: string;
}
