export { FolderWatcher } from './watcher.js';
export type { FolderWatcherOptions } from './watcher.js';
export { createLibraryApi } from './api.js';
export { chokidarWatch } from './fs-watch.js';
export { createSourceResolver } from './sources.js';
export type { SourceLike } from './sources.js';
export { SUPPORTED_EXTENSIONS, isIndexable } from './file-types.js';
export { DOCS_FOLDER, sectionDocument, sectionLocation } from './section-docs.js';
export type {
  DeadLetter,
  FileEvent,
  FileRecord,
  IndexData,
  LibraryApi,
  Section,
  SectionRecord,
  Splitter,
  WatchFactory,
  WatcherStatus,
} from './types.js';
