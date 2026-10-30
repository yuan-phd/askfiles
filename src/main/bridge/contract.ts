import type { DeveloperOverrides, EvalCase, ServiceEvent, Trace } from '../answer/index.js';
import type { BrowseDocument, DocumentRef, DocumentSummary, HeadingGroup, SearchResult } from '../browse/index.js';
import type { SourceRef } from '../open-original.js';
import type { ModelEntry } from '../models/index.js';
import type { PullProgress } from '../ollama/client.js';
import type { SetupEvent, SetupSnapshot } from '../first-run.js';
import type { SourceLike, WatcherStatus } from '../watcher/index.js';

/**
 * IPC channel names between the preload script and the main process. The preload runs sandboxed
 * and can load no module but electron, so it repeats these strings; bridge.test.ts checks that
 * both sides use the same set.
 */
export const CHANNELS = {
  shellConfig: 'askfiles:shell-config',
  setupEvent: 'askfiles:setup:event',
  setupReplay: 'askfiles:setup:replay',
  setupStart: 'askfiles:setup:start',
  setupRetry: 'askfiles:setup:retry',
  setupChooseFolder: 'askfiles:setup:choose-folder',
  modelsList: 'askfiles:models:list',
  modelsPull: 'askfiles:models:pull',
  modelsProgress: 'askfiles:models:progress',
  modelsRemove: 'askfiles:models:remove',
  modelsSwitchChat: 'askfiles:models:switch-chat',
  watcherStatus: 'askfiles:watcher:status',
  watcherStatusEvent: 'askfiles:watcher:status-event',
  libraryResolveSources: 'askfiles:library:resolve-sources',
  libraryOpenOriginal: 'askfiles:library:open-original',
  browseDocuments: 'askfiles:browse:documents',
  browseDocument: 'askfiles:browse:document',
  browseHeadings: 'askfiles:browse:headings',
  browseSearch: 'askfiles:browse:search',
  answerAsk: 'askfiles:answer:ask',
  answerCancel: 'askfiles:answer:cancel',
  answerEvent: 'askfiles:answer:event',
  answerDeveloper: 'askfiles:answer:developer',
  answerSetOverrides: 'askfiles:answer:set-overrides',
  answerSaveCase: 'askfiles:answer:save-case',
  appInfo: 'askfiles:app:info',
  appPageReady: 'askfiles:app:page-ready',
} as const;

/** Channels the main process pushes events on; every other channel is a request from a page. */
export const EVENT_CHANNELS: readonly string[] = [
  CHANNELS.setupEvent,
  CHANNELS.modelsProgress,
  CHANNELS.watcherStatusEvent,
  CHANNELS.answerEvent,
];

/** Read once per page load: the search page needs it before its first request. */
export interface ShellConfigValues {
  baseUrl: string | null;
  apiKey: string | null;
  workspace: string | null;
  folder: string | null;
}

/** Watcher status as the status bar shows it; error when the folder could not be watched. */
export type WatcherView = WatcherStatus & { folder: string | null; error?: string };

export interface PageReadyInfo {
  page: string;
  connected?: boolean;
  documents?: number | null;
}

/** What the main process answers on each request channel. */
export interface BridgeHandlers {
  shellConfig(): ShellConfigValues;
  setupReplay(): SetupEvent[];
  setupStart(): Promise<SetupSnapshot>;
  setupRetry(): Promise<SetupSnapshot>;
  /** Native folder dialog; null when the user cancels. */
  setupChooseFolder(): Promise<{ folder: string } | null>;
  modelsList(): Promise<ModelEntry[]>;
  modelsPull(tag: string): Promise<void>;
  modelsRemove(tag: string): Promise<void>;
  modelsSwitchChat(tag: string): Promise<void>;
  watcherStatus(): WatcherView | null;
  libraryResolveSources(sources: SourceLike[]): SourceLike[];
  /** Reveals the original file in Finder; false when no indexed file matches. */
  libraryOpenOriginal(source: SourceRef): Promise<boolean>;
  /** Every indexed document with its outline, without section text. */
  browseDocuments(): DocumentSummary[];
  /** One document with its sections, by id or by a source's url and file name; null when unknown. */
  browseDocument(ref: DocumentRef): BrowseDocument | null;
  /** Headings grouped across documents; with a key, that group only, with the section text. */
  browseHeadings(key: string | null): HeadingGroup[];
  /** Keyword search over section text, grouped by document and section. */
  browseSearch(query: string): SearchResult;
  /**
   * Starts answering a question (src/main/answer); events for the run follow on answerEvent to
   * the asking page only, through emit. A new question cancels the one before.
   */
  answerAsk(question: string, emit: (e: ServiceEvent) => void): { id: string };
  answerCancel(id: string): void;
  /** Developer panel state; enabled only with ASKFILES_DEVELOPER=1. */
  answerDeveloper(): { enabled: boolean; overrides: DeveloperOverrides; trace: Trace | null };
  answerSetOverrides(o: DeveloperOverrides): DeveloperOverrides;
  answerSaveCase(c: EvalCase): { id: string; file: string };
  appInfo(): { name: string; version: string };
  appPageReady(info: PageReadyInfo): void;
}

/** Payloads of the event channels. */
export interface BridgeEvents {
  [CHANNELS.setupEvent]: SetupEvent;
  [CHANNELS.modelsProgress]: PullProgress;
  [CHANNELS.watcherStatusEvent]: WatcherView;
  [CHANNELS.answerEvent]: ServiceEvent;
}

/**
 * window.askfiles as the pages see it. Every function crosses the context bridge, so arguments
 * and results are copied, and each on* function returns an unsubscribe function.
 */
export interface AskfilesBridge {
  setup: {
    onEvent(callback: (e: SetupEvent) => void): () => void;
    start(): Promise<SetupSnapshot>;
    retry(): Promise<SetupSnapshot>;
    chooseFolder(): Promise<{ folder: string } | null>;
  };
  models: {
    list(): Promise<ModelEntry[]>;
    pull(tag: string): Promise<void>;
    onProgress(callback: (p: PullProgress) => void): () => void;
    remove(tag: string): Promise<void>;
    switchChat(tag: string): Promise<void>;
  };
  watcher: {
    status(): Promise<WatcherView | null>;
    onStatus(callback: (s: WatcherView) => void): () => void;
  };
  library: {
    resolveSources(sources: SourceLike[]): Promise<SourceLike[]>;
    openOriginal(source: SourceRef): Promise<boolean>;
  };
  browse: {
    documents(): Promise<DocumentSummary[]>;
    document(ref: DocumentRef): Promise<BrowseDocument | null>;
    headings(key?: string | null): Promise<HeadingGroup[]>;
    search(query: string): Promise<SearchResult>;
  };
  answer: {
    ask(question: string): Promise<{ id: string }>;
    onEvent(callback: (e: ServiceEvent) => void): () => void;
    cancel(id: string): Promise<void>;
    developer(): Promise<{ enabled: boolean; overrides: DeveloperOverrides; trace: Trace | null }>;
    setOverrides(o: DeveloperOverrides): Promise<DeveloperOverrides>;
    saveCase(c: EvalCase): Promise<{ id: string; file: string }>;
  };
  app: {
    info(): Promise<{ name: string; version: string }>;
    pageReady(info: PageReadyInfo): void;
  };
}

/** window.shellConfig: the values plus the two hooks search.js calls. */
export type ShellConfig = ShellConfigValues & {
  resolveSources(sources: SourceLike[]): Promise<SourceLike[]>;
  openSource(source: SourceRef): Promise<boolean>;
};
