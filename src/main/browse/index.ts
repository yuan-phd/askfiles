import { readSectionDocument, type FileEvent, type FileRecord } from '../watcher/index.js';
import type { BrowseIndex } from './browse-index.js';
import type { StoredChunk } from './build.js';

export { BrowseIndex } from './browse-index.js';
export type { BrowseIndexOptions } from './browse-index.js';
export { buildDocument, buildOutline, documentId, splitHead } from './build.js';
export type { StoredChunk } from './build.js';
export { normalizeHeading } from './normalize.js';
export { fold, markRanges, queryTerms, snippetOf } from './search.js';
export * from './types.js';

/** The parts of FolderWatcher the browse index follows. */
export interface WatcherLike {
  on(event: 'file', listener: (e: FileEvent) => void): unknown;
  file(path: string): FileRecord | null;
}

/**
 * Keeps the browse index current from the watcher's file events. An indexed or unchanged file is
 * read from the watcher's record (unchanged covers a touched file and a browse entry that went
 * missing); a removed one is dropped. Call index.sync(watcher.files()) once the watcher has
 * started, because files that did not change while the app was closed send no event.
 */
export function followWatcher(index: BrowseIndex, watcher: WatcherLike, log: (msg: string) => void = () => {}): void {
  watcher.on('file', (e) => {
    try {
      if (e.outcome === 'removed') index.remove(e.path);
      else if (e.outcome === 'indexed' || e.outcome === 'unchanged') {
        const rec = watcher.file(e.path);
        if (rec) index.update(rec);
        else index.remove(e.path);
      }
    } catch (err) {
      // The browse view must never stop the watcher; the next sync repairs the entry.
      log(`update for ${e.path} failed: ${(err as Error).message}`);
    }
  });
}

/** readChunk for BrowseIndex: the section documents under STORAGE_DIR/documents. */
export function chunkReader(storageDir: string): (location: string) => StoredChunk | null {
  return (location) => {
    const doc = readSectionDocument(storageDir, location);
    if (!doc || typeof doc.pageContent !== 'string') return null;
    return {
      pageContent: doc.pageContent,
      sectionLevel: typeof doc.sectionLevel === 'number' ? doc.sectionLevel : undefined,
    };
  };
}
