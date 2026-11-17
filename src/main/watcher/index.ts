export { FolderWatcher } from './watcher.js';
export type { FolderWatcherOptions, WatchRoot } from './watcher.js';
export { createLibraryApi } from './api.js';
export { chokidarWatch, createChokidarWatch } from './fs-watch.js';
export { countFolders, processWatchBudget, WATCH_FOLDER_LIMIT, WatchBudget } from './folder-limit.js';
export { createSourceResolver } from './sources.js';
export type { SourceLike } from './sources.js';
export { SUPPORTED_EXTENSIONS, isIndexable, isOutsideRules, isSkippedFolderName } from './file-types.js';
export { DOCS_FOLDER, readSectionDocument } from './section-docs.js';
export { sectionSplitter, sectionsFromOcr, splitWithOcr, SPLIT_STRATEGY } from './splitter.js';
export type { OcrFn } from './splitter.js';
export { collectorOcr } from './ocr.js';
export type { OcrPage } from './ocr.js';
export type {
  DeadLetter,
  FileEvent,
  FileRecord,
  IndexData,
  LibraryApi,
  OcrApi,
  SectionRecord,
  Splitter,
  WatchFactory,
  WatcherStatus,
} from './types.js';
