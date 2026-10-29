/**
 * One section of a document as the section splitter returns it. The splitter itself is Session G's
 * src/main/sections; the watcher only depends on this shape.
 */
export interface Section {
  sectionTitle: string;
  /** 1-based position of the section in its file. */
  sectionIndex: number;
  /** First and last page, or null for formats without pages. */
  pageStart: number | null;
  pageEnd: number | null;
  /** Body of the section, heading folded in; never heading-only (docs/sessions/F-ci-and-watcher.md). */
  text: string;
}

export interface Splitter {
  /** Returns the sections of the file at an absolute path, in document order. */
  split(filePath: string): Promise<Section[]>;
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
  pageStart: number | null;
  pageEnd: number | null;
}

export interface FileRecord {
  path: string;
  url: string;
  hash: string;
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
}

export interface FileEvent {
  path: string;
  kind: JobKind;
  outcome: 'indexed' | 'unchanged' | 'removed' | 'retrying' | 'dead-letter';
  sections?: number;
  attempt?: number;
  error?: string;
}
